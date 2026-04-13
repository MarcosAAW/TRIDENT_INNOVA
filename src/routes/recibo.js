const express = require('express');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { requireAuth } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');

const router = express.Router();
const MAX_RECIBO_REINTENTOS = 3;

function isEffectiveCreditNote(nota) {
  return Boolean(nota) && String(nota.estado || '').toUpperCase() !== 'RECHAZADO';
}

function hasEffectiveTotalCreditNote(venta) {
  const notas = Array.isArray(venta?.notas_credito) ? venta.notas_credito : [];
  return notas.some(
    (nota) => isEffectiveCreditNote(nota) && String(nota.tipo_ajuste || 'TOTAL').toUpperCase() === 'TOTAL'
  );
}

const ventaAplicacionSchema = z.object({
  ventaId: z.string().uuid({ message: 'ventaId inválido' }),
  monto: z.coerce.number().positive('El monto debe ser mayor a cero'),
  cuotas: z.array(z.coerce.number().int().positive('La cuota debe ser un entero positivo')).optional()
});

const pagoReciboSchema = z.object({
  metodo: z.string().trim().min(1, 'El método es requerido'),
  referencia: z.string().trim().optional(),
  observacion: z.string().trim().optional(),
  fecha: z.coerce.date().optional(),
  moneda: z.enum(['PYG', 'USD']).default('PYG'),
  tipo_cambio: z.coerce.number().positive('El tipo de cambio debe ser mayor a cero').optional(),
  ventas: z.array(ventaAplicacionSchema).min(1, 'Debes indicar al menos una venta')
});

const createReciboSchema = z
  .object({
    clienteId: z.string().uuid().optional(),
    numero: z.string().trim().optional(),
    metodo: z.string().trim().optional(),
    referencia: z.string().trim().optional(),
    observacion: z.string().trim().optional(),
    fecha: z.coerce.date().optional(),
    moneda: z.enum(['PYG', 'USD']).default('PYG').optional(),
    tipo_cambio: z.coerce.number().positive('El tipo de cambio debe ser mayor a cero').optional(),
    ventas: z.array(ventaAplicacionSchema).min(1, 'Debes indicar al menos una venta').optional(),
    pagos: z.array(pagoReciboSchema).min(1, 'Debes agregar al menos un pago').optional()
  })
  .refine((value) => Array.isArray(value.pagos) ? value.pagos.length > 0 : Boolean(value.metodo && value.ventas && value.ventas.length), {
    message: 'Debes indicar al menos un pago',
    path: ['pagos']
  });

const listQuerySchema = z.object({
  clienteId: z.string().uuid().optional(),
  ventaId: z.string().uuid().optional(),
  fecha_desde: z.coerce.date().optional(),
  fecha_hasta: z.coerce.date().optional()
});

router.use(requireAuth, requireSucursal);

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  const { clienteId, ventaId, fecha_desde, fecha_hasta } = parsed.data;
  const fechaFilter = {};
  if (fecha_desde) fechaFilter.gte = startOfDay(fecha_desde);
  if (fecha_hasta) fechaFilter.lte = endOfDay(fecha_hasta);

  try {
    const recibos = await prisma.recibo.findMany({
      where: {
        sucursalId: req.sucursalId,
        ...(clienteId ? { clienteId } : {}),
        ...(Object.keys(fechaFilter).length ? { fecha: fechaFilter } : {}),
        ...(ventaId ? { aplicaciones: { some: { ventaId } } } : {})
      },
      orderBy: { fecha: 'desc' },
      include: {
        aplicaciones: true
      }
    });

    return res.json(serialize(recibos));
  } catch (err) {
    console.error('[Recibos] No se pudo listar.', err);
    return res.status(500).json({ error: 'No se pudieron obtener los recibos.' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Identificador inválido' });

  try {
    const recibo = await prisma.recibo.findFirst({
      where: { id, sucursalId: req.sucursalId },
      include: {
        aplicaciones: true
      }
    });

    if (!recibo) {
      return res.status(404).json({ error: 'Recibo no encontrado en esta sucursal.' });
    }

    return res.json(serialize(recibo));
  } catch (err) {
    console.error('[Recibos] No se pudo obtener el detalle.', err);
    return res.status(500).json({ error: 'No se pudo obtener el recibo.' });
  }
});

router.get('/:id/pdf', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Identificador inválido' });

  try {
    const recibo = await prisma.recibo.findFirst({
      where: { id, sucursalId: req.sucursalId },
      include: {
        cliente: true,
        usuario: true,
        aplicaciones: {
          include: {
            venta: {
              include: {
                factura_electronica: true
              }
            }
          }
        }
      }
    });

    if (!recibo) {
      return res.status(404).json({ error: 'Recibo no encontrado en esta sucursal.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${recibo.numero || recibo.id}.pdf"`);

    const doc = new PDFDocument({ margin: 28 });
    doc.pipe(res);

    renderReciboPdf(doc, recibo);
    doc.end();
  } catch (err) {
    console.error('[Recibos] No se pudo generar el PDF.', err);
    return res.status(500).json({ error: 'No se pudo generar el PDF del recibo.' });
  }
});

router.post('/', async (req, res) => {
  const parsed = createReciboSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const data = parsed.data;
  const pagos = Array.isArray(data.pagos) && data.pagos.length
    ? data.pagos
    : [
        {
          metodo: data.metodo || '',
          referencia: data.referencia,
          observacion: data.observacion,
          fecha: data.fecha,
          moneda: data.moneda || 'PYG',
          tipo_cambio: data.tipo_cambio,
          ventas: Array.isArray(data.ventas) ? data.ventas : []
        }
      ];

  for (const pago of pagos) {
    const monedaPago = (pago.moneda || 'PYG').toUpperCase();
    const tipoCambioPago = Number(pago.tipo_cambio);
    if (monedaPago === 'USD' && (!Number.isFinite(tipoCambioPago) || tipoCambioPago <= 0)) {
      return res.status(400).json({ error: 'Indicá un tipo de cambio válido para cobros en USD.' });
    }
  }

  try {
    let result = null;
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RECIBO_REINTENTOS && !result; attempt += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const ventaIds = pagos.flatMap((pago) => pago.ventas.map((v) => v.ventaId));
          const uniqueVentaIds = [...new Set(ventaIds)];
          const ventas = await tx.venta.findMany({
            where: {
              id: { in: uniqueVentaIds },
              sucursalId: req.sucursalId,
              deleted_at: null
            },
            include: {
              notas_credito: {
                where: { deleted_at: null },
                select: {
                  id: true,
                  estado: true,
                  tipo_ajuste: true
                }
              }
            }
          });

          if (ventas.length !== uniqueVentaIds.length) {
            throw new Error('VENTA_NO_EN_SUCURSAL');
          }

          const ventaMap = new Map(ventas.map((v) => [v.id, v]));
          const saldos = new Map(ventas.map((v) => [v.id, hasEffectiveTotalCreditNote(v) ? 0 : Number(v.saldo_pendiente ?? v.total ?? 0)]));
          const clienteId = data.clienteId || ventas[0]?.clienteId || null;
          let numeroPersonalizado = data.numero || null;
          const recibosCreados = [];

          for (const pago of pagos) {
            const monedaPago = (pago.moneda || 'PYG').toUpperCase();
            const tipoCambioPago = monedaPago === 'USD' ? Number(pago.tipo_cambio) : null;
            const aplicacionesCalculadas = pago.ventas.map((item) => {
              const venta = ventaMap.get(item.ventaId);
              if (hasEffectiveTotalCreditNote(venta)) {
                throw new Error(`VENTA_REGULARIZADA_CON_NC:${item.ventaId}`);
              }
              const saldoPrevio = saldos.get(item.ventaId) ?? Number(venta?.saldo_pendiente ?? venta?.total ?? 0);
              const ventaMoneda = normalizeCurrency(venta?.moneda || venta?.moneda_venta);
              const ventaEsUsd = ventaMoneda === 'USD';
              const montoMoneda = Number(item.monto || 0);
              const cuotasSeleccionadas = Array.isArray(item.cuotas) ? item.cuotas : [];
              const montoCuotasSeleccionadas = getSelectedCuotasPendingAmount(venta, cuotasSeleccionadas);
              let montoGs = monedaPago === 'USD' && tipoCambioPago ? montoMoneda * tipoCambioPago : montoMoneda;
              let saldoPrevioMonedaVenta = null;

              if (ventaEsUsd && monedaPago === 'USD') {
                saldoPrevioMonedaVenta = getVentaSaldoPendienteMoneda(venta, saldoPrevio);
                if (montoCuotasSeleccionadas > 0 && montoMoneda > montoCuotasSeleccionadas + 0.01) {
                  throw new Error(`MONTO_EXCEDE_SALDO:${item.ventaId}`);
                }
                if (saldoPrevioMonedaVenta > 0 && montoMoneda > saldoPrevioMonedaVenta + 0.01) {
                  throw new Error(`MONTO_EXCEDE_SALDO:${item.ventaId}`);
                }
                if (saldoPrevioMonedaVenta > 0) {
                  montoGs = roundAmount((saldoPrevio * montoMoneda) / saldoPrevioMonedaVenta, 2);
                }
              } else {
                const montoMaximoGs = montoCuotasSeleccionadas > 0
                  ? Math.min(montoCuotasSeleccionadas, saldoPrevio)
                  : saldoPrevio;

                if (monedaPago === 'USD' && tipoCambioPago) {
                  const montoMaximoUsd = ceilAmount(montoMaximoGs / tipoCambioPago, 2);
                  if (montoMoneda > montoMaximoUsd + 0.01) {
                    throw new Error(`MONTO_EXCEDE_SALDO:${item.ventaId}`);
                  }
                  montoGs = roundAmount(montoMoneda * tipoCambioPago, 2);
                  const toleranciaResidualGs = getUsdMinorUnitInGs(tipoCambioPago);
                  const saldoResidualGs = roundAmount(montoMaximoGs - montoGs, 2);
                  if (saldoResidualGs >= 0 && saldoResidualGs <= toleranciaResidualGs) {
                    montoGs = montoMaximoGs;
                  }
                  if (montoGs > montoMaximoGs + 0.01) {
                    montoGs = montoMaximoGs;
                  }
                } else if (montoGs > montoMaximoGs + 0.01) {
                  throw new Error(`MONTO_EXCEDE_SALDO:${item.ventaId}`);
                }
              }

              if (montoGs > saldoPrevio + 0.01) {
                if (!(ventaEsUsd && monedaPago === 'USD' && saldoPrevioMonedaVenta > 0 && montoMoneda <= saldoPrevioMonedaVenta + 0.01)) {
                  throw new Error(`MONTO_EXCEDE_SALDO:${item.ventaId}`);
                }
                montoGs = saldoPrevio;
              }
              let saldoPosterior = Math.max(saldoPrevio - montoGs, 0);
              if (monedaPago === 'USD' && tipoCambioPago) {
                const toleranciaResidualGs = getUsdMinorUnitInGs(tipoCambioPago);
                if (saldoPosterior > 0 && saldoPosterior <= toleranciaResidualGs) {
                  montoGs = saldoPrevio;
                  saldoPosterior = 0;
                }
              }
              saldos.set(item.ventaId, saldoPosterior);
              return {
                ...item,
                montoGs,
                montoMoneda,
                saldoPrevio,
                saldoPrevioMonedaVenta,
                saldoPosterior,
                cuotas: cuotasSeleccionadas
              };
            });

            const total = aplicacionesCalculadas.reduce((acc, item) => acc + Number(item.montoGs || 0), 0);
            const totalMoneda = aplicacionesCalculadas.reduce((acc, item) => acc + Number(item.montoMoneda || 0), 0);
            const numero = numeroPersonalizado || (await buildReciboNumero(tx, req.sucursalId));
            numeroPersonalizado = null;

            const recibo = await tx.recibo.create({
              data: {
                numero,
                clienteId,
                usuarioId: req.usuarioActual.id,
                sucursalId: req.sucursalId,
                fecha: pago.fecha || undefined,
                total,
                total_moneda: totalMoneda,
                moneda: monedaPago,
                tipo_cambio: monedaPago === 'USD' ? tipoCambioPago : null,
                metodo: pago.metodo,
                referencia: pago.referencia || null,
                observacion: pago.observacion || null
              }
            });

            for (const aplicacion of aplicacionesCalculadas) {
              const venta = ventaMap.get(aplicacion.ventaId);
              await tx.reciboDetalle.create({
                data: {
                  reciboId: recibo.id,
                  ventaId: aplicacion.ventaId,
                  monto: aplicacion.montoGs,
                  monto_moneda: aplicacion.montoMoneda,
                  saldo_previo: aplicacion.saldoPrevio,
                  saldo_posterior: aplicacion.saldoPosterior
                }
              });

              let updatedCreditoConfig = venta.credito_config;
              if (
                updatedCreditoConfig &&
                typeof updatedCreditoConfig === 'object' &&
                updatedCreditoConfig.tipo === 'CUOTAS' &&
                Array.isArray(updatedCreditoConfig.cuotas)
              ) {
                const cuotas = [...updatedCreditoConfig.cuotas];
                const now = new Date();
                if (Array.isArray(aplicacion.cuotas) && aplicacion.cuotas.length > 0) {
                  const esUsd = normalizeCurrency(venta.moneda || venta.moneda_venta) === 'USD';
                  let ultimaCuotaPagada = null;
                  for (const cuota of cuotas) {
                    if (cuota.pagada) continue;
                    if (aplicacion.cuotas.includes(cuota.numero)) {
                      cuota.pagada = true;
                      cuota.fecha_pago = now;
                      cuota.monto_pagado = Number(cuota.monto);
                      ultimaCuotaPagada = cuota;
                    }
                  }
                  const saldoPendiente = Number(aplicacion.saldoPosterior || 0);
                  if (!esUsd && saldoPendiente > 0 && saldoPendiente < 100 && ultimaCuotaPagada) {
                    ultimaCuotaPagada.monto_pagado = Number(ultimaCuotaPagada.monto_pagado || 0) + saldoPendiente;
                    aplicacion.saldoPosterior = 0;
                  }
                } else {
                  const esUsd = normalizeCurrency(venta.moneda || venta.moneda_venta) === 'USD';
                  let montoRestante = esUsd ? aplicacion.montoMoneda : aplicacion.montoGs;
                  for (const cuota of cuotas) {
                    if (cuota.pagada) continue;
                    const montoCuota = Number(cuota.monto || 0);
                    if (montoRestante >= montoCuota - 0.01) {
                      cuota.pagada = true;
                      cuota.fecha_pago = now;
                      montoRestante -= montoCuota;
                    } else if (montoRestante > 0.01) {
                      cuota.pagada = false;
                      cuota.monto_pagado = (cuota.monto_pagado || 0) + montoRestante;
                      montoRestante = 0;
                    }
                    if (montoRestante <= 0.01) break;
                  }
                }
                updatedCreditoConfig.cuotas = cuotas;
              }

              await tx.venta.update({
                where: { id: aplicacion.ventaId },
                data: {
                  saldo_pendiente: aplicacion.saldoPosterior,
                  es_credito: aplicacion.saldoPosterior > 0 ? true : venta?.es_credito,
                  estado: aplicacion.saldoPosterior <= 0 ? 'PAGADA' : venta?.estado,
                  credito_config: updatedCreditoConfig ? updatedCreditoConfig : undefined
                }
              });
            }

            const reciboCompleto = await tx.recibo.findUnique({
              where: { id: recibo.id },
              include: {
                cliente: true,
                usuario: true,
                aplicaciones: {
                  include: {
                    venta: {
                      include: {
                        factura_electronica: true
                      }
                    }
                  }
                }
              }
            });

            recibosCreados.push(reciboCompleto);
          }

          return recibosCreados;
        });
        lastError = null;
      } catch (transactionError) {
        lastError = transactionError;
        if (isUniqueReciboNumeroError(transactionError) && attempt < MAX_RECIBO_REINTENTOS - 1) {
          result = null;
          continue;
        }
        throw transactionError;
      }
    }

    if (!result) {
      throw lastError || new Error('NO_SE_PUDO_CREAR_RECIBO');
    }

    if (Array.isArray(result) && result.length === 1) {
      return res.status(201).json(serialize(result[0]));
    }

    return res.status(201).json({ recibos: serialize(result) });
  } catch (err) {
    if (err?.message === 'VENTA_NO_EN_SUCURSAL') {
      return res.status(404).json({ error: 'Alguna venta no pertenece a esta sucursal o no existe.' });
    }
    if (err?.message?.startsWith('MONTO_EXCEDE_SALDO:')) {
      const ventaId = err.message.split(':')[1];
      return res.status(400).json({ error: `El monto supera el saldo pendiente de la venta ${ventaId}.` });
    }
    if (err?.message?.startsWith('VENTA_REGULARIZADA_CON_NC:')) {
      const ventaId = err.message.split(':')[1];
      return res.status(409).json({ error: `La venta ${ventaId} ya fue regularizada con una nota de crédito total.` });
    }
    console.error('[Recibos] No se pudo crear el recibo.', err);
    return res.status(500).json({ error: 'No se pudo crear el recibo.' });
  }
});

function startOfDay(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function endOfDay(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function normalizeCurrency(value) {
  return String(value || 'PYG').trim().toUpperCase();
}

function roundAmount(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function ceilAmount(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.ceil(((Number(value) || 0) * factor) - Number.EPSILON) / factor;
}

function getUsdMinorUnitInGs(tipoCambio) {
  return roundAmount(Number(tipoCambio || 0) * 0.01, 2);
}

function getVentaCreditoCuotas(venta) {
  if (
    !venta?.credito_config ||
    typeof venta.credito_config !== 'object' ||
    venta.credito_config.tipo !== 'CUOTAS' ||
    !Array.isArray(venta.credito_config.cuotas)
  ) {
    return [];
  }
  return venta.credito_config.cuotas;
}

function getCuotaSaldoPendiente(cuota) {
  const monto = Number(cuota?.monto || 0);
  const montoPagado = Number(cuota?.monto_pagado || 0);
  return Math.max(roundAmount(monto - montoPagado, 4), 0);
}

function getVentaSaldoPendienteMoneda(venta, saldoPrevioGs) {
  const cuotas = getVentaCreditoCuotas(venta);
  if (cuotas.length) {
    return roundAmount(
      cuotas.reduce((acc, cuota) => {
        if (cuota?.pagada) return acc;
        return acc + getCuotaSaldoPendiente(cuota);
      }, 0),
      4
    );
  }

  const totalMoneda = Number(venta?.total_moneda || 0);
  const totalGs = Number(venta?.total || 0);
  if (totalMoneda > 0 && totalGs > 0 && saldoPrevioGs > 0) {
    return roundAmount((saldoPrevioGs * totalMoneda) / totalGs, 4);
  }

  const tipoCambioVenta = Number(venta?.tipo_cambio || 0);
  if (tipoCambioVenta > 0 && saldoPrevioGs > 0) {
    return roundAmount(saldoPrevioGs / tipoCambioVenta, 4);
  }

  return 0;
}

function getSelectedCuotasPendingAmount(venta, selectedCuotas) {
  if (!Array.isArray(selectedCuotas) || !selectedCuotas.length) {
    return 0;
  }
  const selectedSet = new Set(selectedCuotas.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0));
  return roundAmount(
    getVentaCreditoCuotas(venta).reduce((acc, cuota) => {
      if (!selectedSet.has(Number(cuota?.numero))) return acc;
      return acc + getCuotaSaldoPendiente(cuota);
    }, 0),
    4
  );
}

function formatNumber(value, fractionDigits = 0) {
  const numeric = Number(value) || 0;
  return numeric.toLocaleString('es-PY', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

function formatCurrency(value, currency = 'PYG') {
  const numeric = Number(value) || 0;
  const isUsd = (currency || '').toUpperCase() === 'USD';
  return numeric.toLocaleString('es-PY', {
    minimumFractionDigits: isUsd ? 2 : 0,
    maximumFractionDigits: isUsd ? 2 : 0
  });
}

function formatAmount(value, currency = 'PYG') {
  const prefix = (currency || '').toUpperCase() === 'USD' ? 'USD' : 'Gs.';
  return `${prefix} ${formatCurrency(value, currency)}`;
}

function capitalize(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function numberToWordsEs(num) {
  const units = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
  const teens = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve'];
  const tens = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const hundreds = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  const toWordsBelowThousand = (n) => {
    if (n === 0) return '';
    if (n < 10) return units[n];
    if (n < 20) return teens[n - 10];
    if (n < 100) {
      const ten = Math.trunc(n / 10);
      const unit = n % 10;
      if (n === 20) return 'veinte';
      const suffix = unit ? ` y ${units[unit]}` : '';
      return `${tens[ten]}${suffix}`;
    }
    if (n === 100) return 'cien';
    const hundred = Math.trunc(n / 100);
    const remainder = n % 100;
    const rest = remainder ? ` ${toWordsBelowThousand(remainder)}` : '';
    return `${hundreds[hundred]}${rest}`;
  };

  const toWords = (n) => {
    if (n === 0) return 'cero';
    let result = '';
    const billions = Math.trunc(n / 1_000_000_000);
    const millions = Math.trunc((n % 1_000_000_000) / 1_000_000);
    const thousands = Math.trunc((n % 1_000_000) / 1000);
    const remainder = n % 1000;

    if (billions) {
      result += `${toWords(billions)} mil millones`;
    }
    if (millions) {
      result += `${result ? ' ' : ''}${millions === 1 ? 'un millon' : `${toWords(millions)} millones`}`;
    }
    if (thousands) {
      result += `${result ? ' ' : ''}${thousands === 1 ? 'mil' : `${toWordsBelowThousand(thousands)} mil`}`;
    }
    if (remainder) {
      result += `${result ? ' ' : ''}${toWordsBelowThousand(remainder)}`;
    }
    return result.trim();
  };

  return toWords(Math.trunc(Math.abs(num)));
}

function formatAmountInWords(total, currency = 'PYG') {
  const safeMonto = Number.isFinite(Number(total)) ? Math.abs(Number(total)) : 0;
  let entero = Math.trunc(safeMonto);
  let centavos = Math.round((safeMonto - entero) * 100);

  // Ajuste por redondeo: 0.995 -> 1.00
  if (centavos === 100) {
    entero += 1;
    centavos = 0;
  }

  const monedaNombre = String(currency || 'PYG').toUpperCase() === 'USD' ? 'dolares' : 'guaranies';
  const textoNumero = numberToWordsEs(entero);
  const textoCentavos = centavos === 0 ? 'cero centavos' : `${numberToWordsEs(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`;
  return `${textoNumero} ${monedaNombre} con ${textoCentavos}`;
}

function formatCambio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '-';
  return numeric.toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function renderReciboPdf(doc, recibo) {
  const logoPath = path.join(__dirname, '..', 'public', 'img', 'logotridentgrande.png');
  const hasLogo = fs.existsSync(logoPath);
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let cursorY = doc.page.margins.top;
  const moneda = (recibo.moneda || 'PYG').toUpperCase();
  const tipoCambio = Number(recibo.tipo_cambio) || 0;
  const totalGs = Number(recibo.total || 0);
  const totalMoneda = Number(recibo.total_moneda ?? (moneda === 'USD' ? 0 : recibo.total));
  const totalPrincipal = moneda === 'USD' ? (totalMoneda || (tipoCambio > 0 ? totalGs / tipoCambio : totalGs)) : totalGs;
  const totalEnLetras = formatAmountInWords(totalPrincipal, moneda);

  // Encabezado con logo y datos principales
  const headerHeight = 90;
  doc.save().rect(startX, cursorY, usableWidth, headerHeight).stroke('#cbd5e1').restore();

  if (hasLogo) {
    try {
      doc.image(logoPath, startX + 10, cursorY + 10, { fit: [120, 60] });
    } catch (err) {
      console.warn('[Recibo] No se pudo incrustar el logo.', err);
    }
  }

  const headerTextX = hasLogo ? startX + 150 : startX + 10;
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor('#0f172a')
    .text('RECIBO DE DINERO', headerTextX, cursorY + 12, { width: usableWidth / 2, align: 'left' });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#334155')
    .text(`Fecha: ${formatDate(recibo.fecha || recibo.created_at)}`, headerTextX, doc.y + 4);
  doc.text(`Registrado por: ${recibo.usuario?.nombre || recibo.usuarioId || '-'}`);

  const rightBoxX = startX + usableWidth - 200;
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0f172a')
    .text('Nro.', rightBoxX, cursorY + 12, { width: 200, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(16)
    .fillColor('#111827')
    .text(recibo.numero || '-', rightBoxX, doc.y + 2, { width: 200, align: 'right' });
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0f172a')
    .text('TOTAL', rightBoxX, doc.y + 6, { width: 200, align: 'right' });
  const totalLabel = formatAmount(totalPrincipal, moneda);
  const totalEquivalente = moneda === 'USD' ? `Equivalente: ${formatAmount(totalGs, 'PYG')}` : null;
  doc
    .font('Helvetica')
    .fontSize(16)
    .fillColor('#16a34a')
    .text(totalLabel, rightBoxX, doc.y + 2, { width: 200, align: 'right' });
  if (totalEquivalente) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#334155')
      .text(totalEquivalente, rightBoxX, doc.y + 2, { width: 200, align: 'right' });
  }

  cursorY += headerHeight + 12;

  // Datos de cliente y forma de pago
  const blockHeight = 88;
  doc.save().rect(startX, cursorY, usableWidth, blockHeight).stroke('#e2e8f0').restore();
  const midX = startX + usableWidth / 2 + 6;

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Cliente', startX + 10, cursorY + 10);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#334155')
    .text(recibo.cliente?.nombre_razon_social || 'Cliente eventual', startX + 10, doc.y + 2, {
      width: usableWidth / 2 - 20
    });
  doc.text(`RUC/CI: ${recibo.cliente?.ruc || 'S/D'}`, startX + 10, doc.y + 2, { width: usableWidth / 2 - 20 });

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Forma de pago', midX, cursorY + 10);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#334155')
    .text(`Método: ${recibo.metodo || '-'}`, midX, doc.y + 2, { width: usableWidth / 2 - 20 });
  doc.text(`Moneda: ${moneda === 'USD' ? 'Dólares (USD)' : 'Guaraníes (PYG)'}`, midX, doc.y + 2, {
    width: usableWidth / 2 - 20
  });
  if (moneda === 'USD') {
    doc.text(`Tipo de cambio: ${formatCambio(tipoCambio)}`, midX, doc.y + 2, { width: usableWidth / 2 - 20 });
  }
  if (recibo.referencia) {
    doc.text(`Referencia: ${recibo.referencia}`, midX, doc.y + 2, { width: usableWidth / 2 - 20 });
  }
  if (recibo.observacion) {
    doc.text(`Observación: ${recibo.observacion}`, midX, doc.y + 2, { width: usableWidth / 2 - 20 });
  }

  cursorY += blockHeight + 14;

  // Monto en letras ubicado antes del detalle
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#475569')
    .text(`Monto en letras: ${capitalize(totalEnLetras)}`, startX, cursorY, {
      width: usableWidth,
      align: 'left'
    });

  cursorY = doc.y + 10;

  // Tabla de aplicaciones / facturas
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Detalle de facturas', startX, cursorY);
  cursorY = doc.y + 6;

  const columns = [
    { key: 'factura', label: 'Factura', width: usableWidth * 0.32 },
    { key: 'venta', label: 'Venta', width: usableWidth * 0.18 },
    { key: 'pago', label: 'Monto pagado', width: usableWidth * 0.22, align: 'right' },
    { key: 'saldo', label: 'Saldo pendiente', width: usableWidth * 0.22, align: 'right' }
  ];

  drawTable(doc, startX, cursorY, columns, recibo.aplicaciones.map((ap) => {
    const venta = ap.venta || {};
    const factura = venta.factura_electronica;
    const saldoPrevio = Number(ap.saldo_previo ?? (Number(venta.saldo_pendiente ?? 0) + Number(ap.monto || 0)));
    const saldoNuevo = Number(ap.saldo_posterior ?? venta.saldo_pendiente ?? 0);
    const montoMoneda = Number(ap.monto_moneda ?? (ap.monto ?? 0));
    const montoGs = Number(ap.monto || 0);
    const pagoLabel = moneda === 'USD'
      ? `${formatAmount(montoMoneda, moneda)} (Gs. ${formatCurrency(montoGs, 'PYG')})`
      : formatAmount(montoGs, 'PYG');

    const ventaMoneda = (venta.moneda || 'PYG').toUpperCase();
    const ventaTc = Number(venta.tipo_cambio) || Number(recibo.tipo_cambio) || 0;
    const saldoNuevoUsd = ventaMoneda === 'USD' && ventaTc > 0 ? saldoNuevo / ventaTc : null;
    const saldoPrevioUsd = ventaMoneda === 'USD' && ventaTc > 0 ? saldoPrevio / ventaTc : null;
    const saldoLabel = ventaMoneda === 'USD'
      ? `USD ${formatCurrency(saldoNuevoUsd, 'USD')} (previo: USD ${formatCurrency(saldoPrevioUsd, 'USD')}) · Gs. ${formatCurrency(saldoNuevo, 'PYG')} (previo: Gs. ${formatCurrency(saldoPrevio, 'PYG')})`
      : `Gs. ${formatCurrency(saldoNuevo, 'PYG')} (previo: Gs. ${formatCurrency(saldoPrevio, 'PYG')})`;

    return {
      factura: factura?.nro_factura || '—',
      venta: venta.id || ap.ventaId || '—',
      pago: pagoLabel,
      saldo: saldoLabel
    };
  }));

  cursorY = doc.y + 12;
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0f172a')
    .text(`Total cobrado: ${formatAmount(totalPrincipal, moneda)}`, startX, cursorY, { width: usableWidth });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#475569')
    .text(`Monto en letras: ${capitalize(totalEnLetras)}`, startX, doc.y + 2, { width: usableWidth });
  if (moneda === 'USD') {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#334155')
      .text(`Equivalente: ${formatAmount(totalGs, 'PYG')}`, startX, doc.y + 2, { width: usableWidth });
  }
}

function drawTable(doc, startX, startY, columns, rows) {
  const headerHeight = 20;
  const rowHeight = 18;
  const usableWidth = columns.reduce((sum, col) => sum + col.width, 0);

  // Header
  let x = startX;
  doc.save();
  doc.rect(startX, startY, usableWidth, headerHeight).fill('#0f172a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  columns.forEach((col) => {
    doc.text(col.label, x + 6, startY + 5, { width: col.width - 12, align: col.align || 'left' });
    x += col.width;
  });
  doc.restore();

  let y = startY + headerHeight;
  doc.font('Helvetica').fontSize(9).fillColor('#111827');

  rows.forEach((row, idx) => {
    let rowX = startX;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    doc.save().rect(startX, y, usableWidth, rowHeight).fill(fill).restore();
    columns.forEach((col) => {
      const value = row[col.key] ?? '—';
      doc.text(String(value), rowX + 6, y + 5, { width: col.width - 12, align: col.align || 'left' });
      rowX += col.width;
    });
    y += rowHeight;
  });

  doc.moveTo(startX, y).stroke('#e2e8f0');
  doc.y = y;
}

async function buildReciboNumero(tx, sucursalId) {
  const ultimo = await tx.recibo.findFirst({
    where: {
      sucursalId,
      numero: { not: null }
    },
    orderBy: { numero: 'desc' },
    select: { numero: true }
  });
  const lastSeq = parseReciboSeq(ultimo?.numero);
  const next = (lastSeq || 0) + 1;
  return String(next).padStart(10, '0');
}

function parseReciboSeq(numero) {
  if (!numero) return null;
  const digits = String(numero).replace(/\D/g, '');
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUniqueReciboNumeroError(error) {
  return (
    error?.code === 'P2002' &&
    Array.isArray(error?.meta?.target) &&
    error.meta.target.some((target) => typeof target === 'string' && target.includes('numero'))
  );
}

module.exports = router;
