const express = require('express');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const XLSX = require('xlsx');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { procesarFacturaElectronica } = require('../services/sifen/facturaProcessor');
const empresaConfig = require('../config/empresa');
const factpyConfig = require('../config/factpy');
const { emitirFactura } = require('../services/factpy/client');
const { generarFacturaDigital, FacturaDigitalError, validateTimbradoConfig, buildNumeroFactura } = require('../services/facturaDigital');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');
const {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  DestinatarioInvalidoError,
  isEmailEnabled
} = require('../services/email/facturaDigitalMailer');

const MONEDAS_PERMITIDAS = new Set(['PYG', 'USD']);
const SIFEN_ENABLED = !['false', '0', 'off'].includes(String(process.env.SIFEN_ENABLE || 'true').toLowerCase());

function hasSifenCert() {
  const certPath = process.env.SIFEN_CERT_PATH;
  if (!certPath) return false;
  try {
    return fs.existsSync(certPath);
  } catch (_err) {
    return false;
  }
}

const VENTAS_REPORT_INCLUDE = {
  cliente: true,
  usuario: true,
  factura_electronica: {
    select: {
      id: true,
      nro_factura: true
    }
  },
  factura_digital: {
    select: {
      id: true,
      nro_factura: true,
      pdf_path: true
    }
  },
  detalles: {
    include: {
      producto: true
    }
  }
};

const detalleSchema = z.object({
  productoId: z.string().uuid(),
  cantidad: z.coerce.number().int().min(1),
  precio_unitario: z.coerce.number().optional(),
  subtotal: z.coerce.number().optional()
});

const ivaSchema = z
  .union([z.literal(5), z.literal(10), z.literal('5'), z.literal('10')])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null) return undefined;
    return Number(value);
  });

const monedaFilterSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toUpperCase())
  .refine((value) => MONEDAS_PERMITIDAS.has(value), { message: 'Moneda no soportada (usa PYG o USD).' })
  .optional();

const creditoCuotaSchema = z.object({
  numero: z.coerce.number().int().min(1),
  monto: z.coerce.number().positive(),
  fecha_vencimiento: z.union([z.coerce.date(), z.string().trim().min(1)])
});

const creditoConfigSchema = z.object({
  tipo: z.enum(['PLAZO', 'CUOTAS']).default('PLAZO'),
  descripcion: z.string().trim().min(1).max(10).optional(),
  cantidad_cuotas: z.coerce.number().int().min(1).optional(),
  cuotas: z.array(creditoCuotaSchema).min(1).optional(),
  fecha_vencimiento: z.coerce.date().optional()
});

const facturarRequestSchema = z
  .object({
    condicion_pago: z.string().trim().optional(),
    fecha_vencimiento: z.coerce.date().optional(),
    credito: creditoConfigSchema.optional()
  })
  .optional()
  .transform((value) => value || {});

const createVentaSchema = z.object({
  usuarioId: z.string().uuid(),
  clienteId: z.string().uuid().optional(),
  detalles: z.array(detalleSchema).min(1),
  descuento_total: z.coerce.number().min(0).optional(),
  estado: z.string().optional(),
  motivo: z.string().optional(),
  almacenId: z.string().uuid().optional(),
  iva_porcentaje: ivaSchema,
  condicion_venta: z.string().trim().optional(),
  moneda: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => MONEDAS_PERMITIDAS.has(value), {
      message: 'Moneda no soportada (usa PYG o USD).'
    })
    .optional(),
  tipo_cambio: z
    .coerce.number({ invalid_type_error: 'El tipo de cambio debe ser numérico.' })
    .positive('El tipo de cambio debe ser mayor a cero.')
    .max(20000, 'El tipo de cambio es demasiado alto.')
    .optional(),
  fecha_vencimiento: z.coerce.date().optional(),
  credito: creditoConfigSchema.optional()
});

class VentaValidationError extends Error {}

const MAX_DECIMAL_VALUE = 10_000_000_000;
const IVA_DIVISOR = {
  5: 21,
  10: 11
};

const MAX_FACTURA_REINTENTOS = 5;

function isUniqueNroFacturaError(error) {
  return (
    error?.code === 'P2002' &&
    Array.isArray(error?.meta?.target) &&
    error.meta.target.some((target) => typeof target === 'string' && target.includes('nro_factura'))
  );
}

const dateParam = z.coerce.date({ invalid_type_error: 'Fecha inválida' });
const monthParam = z
  .string()
  .trim()
  .regex(/^[0-9]{4}-[0-9]{2}$/u, 'Formato de mes inválido (YYYY-MM)');

const listQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  estado: z.string().trim().optional(),
  iva_porcentaje: ivaSchema.optional(),
  fecha_desde: dateParam.optional(),
  fecha_hasta: dateParam.optional(),
  mes: monthParam.optional(),
  moneda: monedaFilterSchema,
  include_deleted: z.coerce.boolean().optional()
});

const ventaIdParams = z.object({
  id: z.string().uuid({ message: 'Identificador inválido' })
});

const cancelVentaSchema = z.object({
  motivo: z.string().trim().min(3).max(200).optional()
});

const EMPRESA_INFO = {
  nombre: empresaConfig?.nombre || 'TRIDENT INNOVA E.A.S',
  ruc: empresaConfig?.ruc || '0000000-0',
  direccion: empresaConfig?.direccion || 'San Ignacio - Misiones',
  telefono: empresaConfig?.telefono || '',
  email: empresaConfig?.email || ''
};

const REPORT_LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logotridentgrande.png');

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

function getMonthRange(month) {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const start = new Date(year, monthIndex, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 1);
  end.setHours(0, 0, 0, 0);
  return { start, end };
}

function buildVentaWhere(filters, sucursalId) {
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.estado) {
    where.estado = { contains: filters.estado, mode: 'insensitive' };
  }

  if (filters.moneda) {
    where.moneda = filters.moneda;
  }

  if (filters.iva_porcentaje !== undefined && filters.iva_porcentaje !== null) {
    where.iva_porcentaje = Number(filters.iva_porcentaje);
  }

  const fechaCriteria = {};
  if (filters.mes) {
    const { start, end } = getMonthRange(filters.mes);
    fechaCriteria.gte = start;
    fechaCriteria.lt = end;
  } else {
    if (filters.fecha_desde) {
      fechaCriteria.gte = startOfDay(filters.fecha_desde);
    }
    if (filters.fecha_hasta) {
      fechaCriteria.lte = endOfDay(filters.fecha_hasta);
    }
  }
  if (Object.keys(fechaCriteria).length) {
    where.fecha = fechaCriteria;
  }

  if (filters.search) {
    const term = filters.search;
    where.OR = [
      { id: { contains: term, mode: 'insensitive' } },
      { estado: { contains: term, mode: 'insensitive' } },
      { cliente: { nombre_razon_social: { contains: term, mode: 'insensitive' } } },
      { cliente: { ruc: { contains: term, mode: 'insensitive' } } },
      { usuario: { nombre: { contains: term, mode: 'insensitive' } } },
      { usuario: { usuario: { contains: term, mode: 'insensitive' } } },
      { factura_electronica: { nro_factura: { contains: term, mode: 'insensitive' } } }
    ];
  }

  if (sucursalId) {
    where.sucursalId = sucursalId;
  }

  return where;
}

function normalizeIvaPorcentaje(value) {
  if (value === undefined || value === null) {
    return 10;
  }
  const parsed = Number(value);
  return parsed === 5 ? 5 : 10;
}

function normalizeCurrency(value) {
  if (!value) return 'PYG';
  const upper = String(value).trim().toUpperCase();
  if (MONEDAS_PERMITIDAS.has(upper)) {
    return upper;
  }
  return 'PYG';
}

function normalizeCondicionVenta(value, creditoConfig) {
  const normalized = (value || '').toString().toUpperCase();
  if (normalized.includes('CREDITO') || normalized.includes('CRÉDITO')) return 'CREDITO';
  if (creditoConfig) return 'CREDITO';
  return 'CONTADO';
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor + Number.EPSILON) / factor;
}

function ensureWithinLimit(value, label) {
  if (!Number.isFinite(value)) {
    throw new VentaValidationError(`${label} debe ser un número válido.`);
  }
  if (Math.abs(value) > MAX_DECIMAL_VALUE) {
    throw new VentaValidationError(`${label} supera el máximo permitido.`);
  }
}

router.use(requireAuth, requireSucursal);

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const filters = parsed.data || {};
  const where = buildVentaWhere(filters, req.sucursalId);

  try {
    const ventas = await prisma.venta.findMany({
      where,
      include: {
        cliente: true,
        usuario: true,
        factura_electronica: {
          select: {
            id: true,
            nro_factura: true
          }
        },
        factura_digital: {
          select: {
            id: true,
            nro_factura: true,
            pdf_path: true,
            estado_envio: true
          }
        },
        detalles: {
          include: {
            producto: true
          }
        }
      },
      orderBy: { fecha: 'desc' }
    });

    const data = serialize(ventas);
    const resumen = data.reduce(
      (acc, venta) => {
        const estado = (venta.estado || '').toUpperCase();
        const anulada = estado === 'ANULADA' || Boolean(venta.deleted_at);
        if (!anulada) {
          acc.total_pyg += Number(venta.total || 0);
          const currency = (venta.moneda || 'PYG').toUpperCase();
          if (currency === 'USD') {
            const usdAmount = Number(venta.total_moneda || 0);
            if (Number.isFinite(usdAmount)) {
              acc.total_usd += usdAmount;
            }
          }
        }
        return acc;
      },
      { total_pyg: 0, total_usd: 0 }
    );

    res.json({
      data,
      meta: {
        page: 1,
        pageSize: data.length,
        total: data.length,
        totalPages: 1,
        resumen
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar ventas' });
  }
});
router.post('/', validate(createVentaSchema), async (req, res) => {
  const payload = req.validatedBody;
  const ivaPorcentaje = normalizeIvaPorcentaje(payload.iva_porcentaje);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const detallesNormalizados = (Array.isArray(payload.detalles) ? payload.detalles : [])
        .map((detalle) => ({
          productoId: detalle.productoId,
          cantidad: Number(detalle.cantidad)
        }))
        .filter((detalle) => Boolean(detalle.productoId));

      if (!detallesNormalizados.length) {
        throw new VentaValidationError('Debes seleccionar al menos un producto.');
      }

      const productoIds = [...new Set(detallesNormalizados.map((detalle) => detalle.productoId))];
      const productos = await tx.producto.findMany({ where: { id: { in: productoIds }, sucursalId: req.sucursalId } });
      const productosMap = new Map(productos.map((producto) => [producto.id, producto]));
      const stockReservado = new Map();

      let subtotalAcumulado = 0;
      const detallePayloads = [];

      for (const detalle of detallesNormalizados) {
        const producto = productosMap.get(detalle.productoId);
        if (!producto || producto.deleted_at) {
          throw new Error('PRODUCTO_NO_ENCONTRADO:' + detalle.productoId);
        }
        if (producto.activo === false) {
          throw new Error('PRODUCTO_INACTIVO:' + detalle.productoId);
        }

        const cantidad = Number(detalle.cantidad);
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw new VentaValidationError('La cantidad debe ser mayor a cero.');
        }

        const reservado = stockReservado.get(detalle.productoId) || 0;
        if (typeof producto.stock_actual === 'number' && producto.stock_actual < cantidad + reservado) {
          throw new Error('STOCK_INSUFICIENTE:' + detalle.productoId);
        }
        stockReservado.set(detalle.productoId, reservado + cantidad);

        const precioUnitario = Number(producto.precio_venta);
        if (!Number.isFinite(precioUnitario) || precioUnitario < 0) {
          throw new VentaValidationError('El producto no tiene un precio de venta válido.');
        }

        const precioUnitarioRedondeado = round(precioUnitario, 2);
        ensureWithinLimit(precioUnitarioRedondeado, 'Precio unitario');

        const subtotalDetalle = round(precioUnitarioRedondeado * cantidad, 2);
        ensureWithinLimit(subtotalDetalle, 'Subtotal de detalle');

        subtotalAcumulado = round(subtotalAcumulado + subtotalDetalle, 2);

        detallePayloads.push({
          productoId: detalle.productoId,
          cantidad,
          precio_unitario: precioUnitarioRedondeado,
          subtotal: subtotalDetalle
        });
      }

      ensureWithinLimit(subtotalAcumulado, 'Subtotal');

      const monedaSeleccionada = normalizeCurrency(payload.moneda);
      let tipoCambioSeleccionado = null;
      if (monedaSeleccionada === 'USD') {
        const parsedTipoCambio = Number(payload.tipo_cambio);
        if (!Number.isFinite(parsedTipoCambio) || parsedTipoCambio <= 0) {
          throw new VentaValidationError('Ingresá un tipo de cambio válido para ventas en USD.');
        }
        tipoCambioSeleccionado = round(parsedTipoCambio, 4);
      }

      let descuentoEntrada = Number(payload.descuento_total ?? 0);
      if (!Number.isFinite(descuentoEntrada) || descuentoEntrada < 0) {
        descuentoEntrada = 0;
      }
      descuentoEntrada = round(descuentoEntrada, 2);
      ensureWithinLimit(descuentoEntrada, 'Descuento total');

      const descuentoTotal = monedaSeleccionada === 'USD' && tipoCambioSeleccionado
        ? round(descuentoEntrada * tipoCambioSeleccionado, 2)
        : descuentoEntrada;

      if (descuentoTotal > subtotalAcumulado) {
        throw new VentaValidationError('El descuento no puede superar el subtotal.');
      }

      const baseGravada = round(subtotalAcumulado - descuentoTotal, 2);
      ensureWithinLimit(baseGravada, 'Total');

      const divisor = IVA_DIVISOR[ivaPorcentaje] || IVA_DIVISOR[10];
      const impuestoTotal = baseGravada > 0 ? round(baseGravada / divisor, 2) : 0;
      ensureWithinLimit(impuestoTotal, 'Impuesto total');

      const total = baseGravada;

      let totalEnMonedaSeleccionada = null;
      if (tipoCambioSeleccionado) {
        if (total === 0) {
          totalEnMonedaSeleccionada = 0;
        } else {
          totalEnMonedaSeleccionada = round(total / tipoCambioSeleccionado, 2);
        }
        ensureWithinLimit(totalEnMonedaSeleccionada, 'Total en moneda seleccionada');
      }

      const condicionVenta = normalizeCondicionVenta(payload.condicion_venta, payload.credito);
      const esCredito = condicionVenta === 'CREDITO';
      const fechaVencimiento = payload.fecha_vencimiento || payload.credito?.fecha_vencimiento || null;
      const saldoPendiente = esCredito ? total : null;

      let clienteId = payload.clienteId || null;
      if (clienteId) {
        const cliente = await tx.cliente.findFirst({ where: { id: clienteId, sucursalId: req.sucursalId } });
        if (!cliente || cliente.deleted_at) {
          throw new VentaValidationError('El cliente no pertenece a la sucursal activa.');
        }
      }

      const venta = await tx.venta.create({
        data: {
          usuarioId: payload.usuarioId,
          clienteId,
          sucursalId: req.sucursalId,
          subtotal: subtotalAcumulado,
          descuento_total: descuentoTotal,
          impuesto_total: impuestoTotal,
          total,
          estado: payload.estado || 'PENDIENTE',
          moneda: monedaSeleccionada,
          tipo_cambio: tipoCambioSeleccionado,
          total_moneda: totalEnMonedaSeleccionada,
          iva_porcentaje: ivaPorcentaje,
          condicion_venta: condicionVenta,
          es_credito: esCredito,
          fecha_vencimiento: fechaVencimiento || undefined,
          saldo_pendiente: saldoPendiente
        }
      });

      for (const detalle of detallePayloads) {
        await tx.detalleVenta.create({
          data: {
            ventaId: venta.id,
            productoId: detalle.productoId,
            cantidad: detalle.cantidad,
            precio_unitario: detalle.precio_unitario,
            subtotal: detalle.subtotal
          }
        });

        const producto = productosMap.get(detalle.productoId);
        if (producto && typeof producto.stock_actual === 'number') {
          await tx.producto.update({
            where: { id: detalle.productoId },
            data: { stock_actual: { decrement: detalle.cantidad } }
          });
          producto.stock_actual -= detalle.cantidad;
        }

        await tx.movimientoStock.create({
          data: {
            productoId: detalle.productoId,
            tipo: 'SALIDA',
            cantidad: detalle.cantidad,
            motivo: payload.motivo || 'Venta',
            referencia_id: venta.id,
            referencia_tipo: 'Venta',
            almacen_id: payload.almacenId || null,
            usuario_id: payload.usuarioId
          }
        });
      }

      const full = await tx.venta.findFirst({
        where: { id: venta.id, sucursalId: req.sucursalId },
        include: {
          detalles: {
            include: {
              producto: true
            }
          },
          cliente: true,
          usuario: true,
          sucursal: true
        }
      });

      return full;
    });

    res.status(201).json(serialize(result));
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err && err.message && err.message.startsWith('STOCK_INSUFICIENTE')) {
      const pid = err.message.split(':')[1];
      return res.status(400).json({ error: `Stock insuficiente para producto ${pid}` });
    }
    if (err && err.message && err.message.startsWith('PRODUCTO_NO_ENCONTRADO')) {
      const pid = err.message.split(':')[1];
      return res.status(400).json({ error: `Producto no encontrado: ${pid}` });
    }
    if (err && err.message && err.message.startsWith('PRODUCTO_INACTIVO')) {
      const pid = err.message.split(':')[1];
      return res.status(400).json({ error: `Producto inactivo: ${pid}` });
    }

    console.error(err);
    res.status(500).json({ error: 'Error al crear venta' });
  }
});

// Nota: no implementamos update/delete complejos por ahora

router.post('/:id/facturar', authorizeRoles('ADMIN'), async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador de venta inválido.' });
  }

  const facturarParsed = facturarRequestSchema.safeParse(req.body || {});
  if (!facturarParsed.success) {
    return res.status(400).json({ error: 'Datos inválidos para facturar.', detalles: facturarParsed.error.flatten() });
  }

  const facturarInput = facturarParsed.data;

  const { id } = parsedParams.data;

  try {
    validateTimbradoConfig(empresaConfig.timbrado || {});
  } catch (timbradoError) {
    if (timbradoError instanceof FacturaDigitalError) {
      return res.status(412).json({ error: timbradoError.message, code: timbradoError.code });
    }
    console.error('[FacturaDigital] Error al validar el timbrado.', timbradoError);
    return res.status(500).json({ error: 'No se pudo validar la configuración del timbrado.' });
  }

  try {
    let venta = null;
    let factura = null;
    let lastError = null;

    for (let attempt = 0; attempt < MAX_FACTURA_REINTENTOS && !venta; attempt += 1) {
      try {
        const txResult = await prisma.$transaction(async (tx) => {
          const ventaActual = await tx.venta.findFirst({
            where: { id, sucursalId: req.sucursalId },
            include: {
              cliente: true,
              usuario: true,
              detalles: { include: { producto: true } },
              factura_electronica: true,
              factura_digital: true
            }
          });

          if (!ventaActual) {
            throw new VentaValidationError('No se encontró la venta solicitada.');
          }

          const condicionVentaFacturacion = normalizeCondicionVenta(
            facturarInput.condicion_pago || ventaActual.condicion_venta,
            facturarInput.credito
          );
          const esCreditoFacturacion = condicionVentaFacturacion === 'CREDITO';
          const fechaVencimientoFacturacion =
            facturarInput.fecha_vencimiento || facturarInput.credito?.fecha_vencimiento || ventaActual.fecha_vencimiento || null;
          const saldoPendienteFacturacion = esCreditoFacturacion
            ? Number(ventaActual.saldo_pendiente ?? ventaActual.total ?? 0)
            : null;

          if (
            condicionVentaFacturacion !== ventaActual.condicion_venta ||
            esCreditoFacturacion !== ventaActual.es_credito ||
            fechaVencimientoFacturacion ||
            (!esCreditoFacturacion && ventaActual.saldo_pendiente)
          ) {
            await tx.venta.update({
              where: { id: ventaActual.id },
              data: {
                condicion_venta: condicionVentaFacturacion,
                es_credito: esCreditoFacturacion,
                fecha_vencimiento: fechaVencimientoFacturacion || undefined,
                saldo_pendiente: esCreditoFacturacion ? saldoPendienteFacturacion : null
              }
            });

            ventaActual.condicion_venta = condicionVentaFacturacion;
            ventaActual.es_credito = esCreditoFacturacion;
            ventaActual.fecha_vencimiento = fechaVencimientoFacturacion;
            ventaActual.saldo_pendiente = esCreditoFacturacion ? saldoPendienteFacturacion : null;
          }

          if (ventaActual.deleted_at || (ventaActual.estado && ventaActual.estado.toUpperCase() === 'ANULADA')) {
            throw new VentaValidationError('No es posible generar una factura para una venta anulada.');
          }

          if (!Array.isArray(ventaActual.detalles) || !ventaActual.detalles.length) {
            throw new VentaValidationError('La venta no tiene detalles para facturar.');
          }

          const now = new Date();
          let facturaActual = ventaActual.factura_electronica;

          if (!facturaActual) {
            const timbradoSeleccionado = selectTimbradoParaVenta(ventaActual, empresaConfig);
            const secuenciaFactura = await resolveSecuenciaFactura(tx, timbradoSeleccionado, req.sucursalId);
            const numeroFactura = buildNumeroFactura(timbradoSeleccionado, secuenciaFactura);

            facturaActual = await tx.facturaElectronica.create({
              data: {
                id: randomUUID(),
                ventaId: ventaActual.id,
                sucursalId: req.sucursalId,
                nro_factura: numeroFactura,
                timbrado: timbradoSeleccionado.numero || 'NO_TIMBRADO',
                fecha_emision: now,
                estado: 'PAGADA',
                respuesta_set: {
                  mensaje: 'Factura generada y marcada como pagada en entorno local de prueba.',
                  timestamp: now.toISOString()
                },
                intentos: 1,
                ambiente: 'PRUEBA',
                qr_data: construirQrPlaceholder(ventaActual, numeroFactura)
              }
            });

            await tx.venta.update({
              where: { id: ventaActual.id },
              data: {
                factura_electronicaId: facturaActual.id,
                estado: ventaActual.estado === 'PENDIENTE' ? 'FACTURADO' : ventaActual.estado
              }
            });
          } else {
            const intentosPrevios = Number(facturaActual.intentos) || 0;
            facturaActual = await tx.facturaElectronica.update({
              where: { id: facturaActual.id },
              data: {
                intentos: { set: intentosPrevios + 1 },
                respuesta_set: {
                  mensaje: 'Factura reintentada (estado pagada) en entorno local de prueba.',
                  intento: intentosPrevios + 1,
                  timestamp: now.toISOString()
                },
                estado: 'PAGADA',
                updated_at: now
              }
            });
          }

          const ventaRefrescada = await tx.venta.findFirst({
            where: { id, sucursalId: req.sucursalId },
            include: {
              cliente: true,
              usuario: true,
              sucursal: true,
              detalles: { include: { producto: true } },
              factura_electronica: true,
              factura_digital: true
            }
          });

          return { venta: ventaRefrescada, factura: facturaActual };
        });

        venta = txResult.venta;
        factura = txResult.factura;
        lastError = null;
      } catch (err) {
        lastError = err;
        if (isUniqueNroFacturaError(err) && attempt < MAX_FACTURA_REINTENTOS - 1) {
          continue;
        }
        throw err;
      }
    }

    if (!venta || !factura) {
      throw lastError || new Error('No se pudo generar la factura electrónica.');
    }

    let facturaActualizada = factura;
    try {
      const files = await generarArchivosFactura(venta, factura);
      if (files?.pdfWebPath && files.pdfWebPath !== factura.pdf_path) {
        facturaActualizada = await prisma.facturaElectronica.update({
          where: { id: factura.id },
          data: {
            pdf_path: files.pdfWebPath,
            xml_path: files.xmlWebPath || factura.xml_path
          }
        });
        venta.factura_electronica = facturaActualizada;
      }
    } catch (assetError) {
      console.error('[Factura] No se pudo generar el PDF.', assetError);
    }

    if (factpyConfig?.recordId) {
      try {
        const factpyOptions = {
          condicion_pago: facturarInput.condicion_pago || venta?.condicion_venta,
          fecha_vencimiento:
            facturarInput.fecha_vencimiento || facturarInput.credito?.fecha_vencimiento || venta?.fecha_vencimiento,
          credito: facturarInput.credito || facturaActualizada?.respuesta_set?.credito || factura?.respuesta_set?.credito
        };

        const payload = buildFactPyPayload(venta, facturaActualizada, factpyOptions);
        const respuestaFactpy = await emitirFactura({
          dataJson: payload,
          recordID: factpyConfig.recordId,
          baseUrl: factpyConfig.baseUrl,
          timeoutMs: factpyConfig.timeoutMs
        });

        const estadoFactpy = respuestaFactpy?.status === false ? 'RECHAZADO' : 'ENVIADO';
        const mergedRespuesta = {
          receiptid: payload?.receiptid,
          factpy: respuestaFactpy,
          credito: payload?.credito || null,
          condicionPago: payload?.condicionPago,
          timestamp: new Date().toISOString()
        };

        facturaActualizada = await prisma.facturaElectronica.update({
          where: { id: facturaActualizada.id },
          data: {
            respuesta_set: mergedRespuesta,
            qr_data: respuestaFactpy?.cdc || facturaActualizada.qr_data,
            xml_path: respuestaFactpy?.xmlLink || facturaActualizada.xml_path,
            pdf_path: respuestaFactpy?.kude || facturaActualizada.pdf_path,
            estado: estadoFactpy
          }
        });

        venta.factura_electronica = facturaActualizada;
      } catch (factpyError) {
        console.error('[FactPy] Error al emitir', factpyError);
      }
    }

    const shouldSendSifen = process.env.NODE_ENV === 'test' || (SIFEN_ENABLED && hasSifenCert());
    if (shouldSendSifen) {
      try {
        const resultadoSifen = await procesarFacturaElectronica(venta);
        if (resultadoSifen?.factura) {
          facturaActualizada = resultadoSifen.factura;
          venta.factura_electronica = facturaActualizada;
        }
      } catch (sifenError) {
        console.error('[SIFEN] Error al procesar el documento electrónico.', sifenError);
      }
    }

    try {
      const facturaDigital = await generarFacturaDigital(venta);
      if (facturaDigital) {
        venta.factura_digital = facturaDigital;
      }
    } catch (digitalError) {
      console.error('[FacturaDigital] No se pudo generar la factura digital.', digitalError);
    }

    if (isEmailEnabled() && venta?.cliente?.correo && venta?.factura_digital?.pdf_path) {
      try {
        const updatedDigital = await enviarFacturaDigitalPorCorreo(venta.factura_digital, venta);
        venta.factura_digital = updatedDigital;
      } catch (mailError) {
        if (mailError instanceof EmailNotConfiguredError || mailError instanceof DestinatarioInvalidoError) {
          console.warn('[FacturaDigital] Aviso al enviar correo:', mailError.message);
        } else {
          console.error('[FacturaDigital] Error al enviar el correo con la factura.', mailError);
        }
      }
    }

    res.json({ venta: serialize(venta), factura: serialize(facturaActualizada) });
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar la factura electrónica.' });
  }
});

router.post('/:id/anular', authorizeRoles('ADMIN'), async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador de venta inválido.' });
  }

  const parsedBody = cancelVentaSchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Datos inválidos para anular la venta.' });
  }

  const { id } = parsedParams.data;
  const { motivo } = parsedBody.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const venta = await tx.venta.findFirst({
        where: { id, sucursalId: req.sucursalId },
        include: {
          detalles: true
        }
      });

      if (!venta) {
        throw new VentaValidationError('No se encontró la venta solicitada.');
      }

      if (venta.deleted_at || (venta.estado && venta.estado.toUpperCase() === 'ANULADA')) {
        throw new VentaValidationError('La venta ya se encuentra anulada.');
      }

      const detalles = Array.isArray(venta.detalles) ? venta.detalles : [];
      for (const detalle of detalles) {
        await tx.producto.update({
          where: { id: detalle.productoId },
          data: { stock_actual: { increment: Number(detalle.cantidad) } }
        });

        await tx.movimientoStock.create({
          data: {
            productoId: detalle.productoId,
            tipo: 'ENTRADA',
            cantidad: Number(detalle.cantidad),
            motivo: motivo || 'Anulación de venta',
            referencia_id: venta.id,
            referencia_tipo: 'Venta',
            usuario_id: venta.usuarioId
          }
        });
      }

      const updated = await tx.venta.update({
        where: { id: venta.id },
        data: {
          estado: 'ANULADA',
          deleted_at: new Date()
        },
        include: {
          cliente: true,
          usuario: true,
          detalles: {
            include: {
              producto: true
            }
          },
          factura_digital: true
        }
      });

      return updated;
    });

    if (result?.factura_digital) {
      try {
        const facturaActualizada = await generarFacturaDigital(result);
        if (facturaActualizada) {
          result.factura_digital = facturaActualizada;
        }
      } catch (regenError) {
        console.error('[FacturaDigital] No se pudo regenerar la factura anulada.', regenError);
      }
    }

    res.json(serialize(result));
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo anular la venta.' });
  }
});

router.get('/reporte/diario', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reporte-ventas-diario-${range.fileLabel}.pdf"`);

    const doc = new PDFDocument({ size: 'LEGAL', margin: 32, bufferPages: true, layout: 'landscape' });
    doc.pipe(res);
    renderDailySalesReport(doc, data, { range, filterChips });
    doc.end();
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte diario', error);
    res.status(500).json({ error: 'No se pudo generar el reporte diario.' });
  }
});

router.get('/reporte/diario/csv', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    const csvContent = buildDailyCsv(data);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-ventas-diario-${range.fileLabel}.csv"`);
    res.send(`\ufeff${csvContent}`);
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte diario csv', error);
    res.status(500).json({ error: 'No se pudo exportar el CSV diario.' });
  }
});

router.get('/reporte/diario/xlsx', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    const buffer = buildDailyXlsx(data, range, filterChips);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-ventas-diario-${range.fileLabel}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte diario xlsx', error);
    res.status(500).json({ error: 'No se pudo exportar el XLSX diario.' });
  }
});

router.get('/reporte/margen', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reporte-ventas-margen-${range.fileLabel}.pdf"`);

    const doc = new PDFDocument({ size: 'LEGAL', margin: 32, bufferPages: true, layout: 'landscape' });
    doc.pipe(res);
    renderMarginSalesReport(doc, data, { range, filterChips });
    doc.end();
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte margen', error);
    res.status(500).json({ error: 'No se pudo generar el reporte de margen.' });
  }
});

module.exports = router;

function prepareReportFilters(filtersInput = {}) {
  const filters = { ...filtersInput };
  const range = resolveReportRange(filters);
  filters.fecha_desde = range.startDate;
  filters.fecha_hasta = range.endDate;
  delete filters.mes;
  return {
    filters,
    range,
    filterChips: describeReportFilters(filtersInput)
  };
}

function resolveReportRange(filters) {
  let startDate = filters?.fecha_desde ? startOfDay(filters.fecha_desde) : null;
  let endDate = filters?.fecha_hasta ? endOfDay(filters.fecha_hasta) : null;

  if (!startDate && !endDate) {
    const today = new Date();
    startDate = startOfDay(today);
    endDate = endOfDay(today);
  } else if (startDate && !endDate) {
    endDate = endOfDay(startDate);
  } else if (!startDate && endDate) {
    startDate = startOfDay(endDate);
  }

  if (startDate > endDate) {
    throw new VentaValidationError('La fecha inicial no puede ser posterior a la fecha final.');
  }

  const sameDay = startDate.getTime() === endDate.getTime();
  return {
    startDate,
    endDate,
    startLabel: formatIsoDateOnly(startDate),
    endLabel: formatIsoDateOnly(endDate),
    fileLabel: sameDay
      ? formatIsoDateOnly(startDate)
      : `${formatIsoDateOnly(startDate)}_${formatIsoDateOnly(endDate)}`
  };
}

function describeReportFilters(filters = {}) {
  const chips = [];
  if (filters.search) chips.push(`Búsqueda: ${filters.search}`);
  if (filters.estado) chips.push(`Estado contiene: ${filters.estado}`);
  if (filters.iva_porcentaje) chips.push(`IVA: ${filters.iva_porcentaje}%`);
  if (filters.moneda) chips.push(`Moneda: ${(filters.moneda || '').toUpperCase()}`);
  if (filters.include_deleted) chips.push('Incluye registros eliminados');
  return chips;
}

function renderDailySalesReport(doc, ventas, { range, filterChips }) {
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totals = calculateDailyTotals(ventas);
  const rows = buildDailyReportRows(ventas, totals);
  renderReportHeader(doc, 'Reporte diario de ventas', range, startX, usableWidth, filterChips);
  drawReportFilterTags(doc, filterChips, startX, usableWidth);
  drawReportSummaryChips(
    doc,
    [
      { label: 'Ventas registradas', value: formatIntegerValue(ventas.length) },
      { label: 'Subtotal', value: formatCurrencyPyG(totals.subtotal) },
      { label: 'IVA calculado', value: formatCurrencyPyG(totals.impuesto) },
      { label: 'Total periodo', value: formatCurrencyPyG(totals.total) }
    ],
    startX,
    usableWidth
  );
  const extraLines = [];
  if (totals.totalUsd > 0 || totals.impuestoUsd > 0) {
    const parts = [];
    if (totals.totalUsd > 0) parts.push(`Equivalente en USD: ${formatCurrencyUsd(totals.totalUsd)}`);
    if (totals.impuestoUsd > 0) parts.push(`IVA en USD: ${formatCurrencyUsd(totals.impuestoUsd)}`);
    extraLines.push(parts.join('   ·   '));
  }
  if (totals.iva5 > 0 || totals.iva10 > 0) {
    const ivaParts = [];
    ivaParts.push(`IVA 5%: ${formatCurrencyPyG(totals.iva5)}`);
    ivaParts.push(`IVA 10%: ${formatCurrencyPyG(totals.iva10)}`);
    if (totals.iva5Usd > 0 || totals.iva10Usd > 0) {
      const ivaUsdParts = [];
      if (totals.iva5Usd > 0) ivaUsdParts.push(`5% USD ${formatCurrencyUsd(totals.iva5Usd)}`);
      if (totals.iva10Usd > 0) ivaUsdParts.push(`10% USD ${formatCurrencyUsd(totals.iva10Usd)}`);
      ivaParts.push(`(${ivaUsdParts.join(' · ')})`);
    }
    extraLines.push(ivaParts.join('   ·   '));
  }
  if (totals.costo > 0 || totals.margen !== 0) {
    const margenParts = [];
    if (totals.costo > 0) margenParts.push(`Costo estimado: ${formatCurrencyPyG(totals.costo)}`);
    const margenTexto = `Margen: ${formatCurrencyPyG(totals.margen)} (${formatPercentValue(totals.margenPercent)})`;
    margenParts.push(margenTexto);
    extraLines.push(margenParts.join('   ·   '));
  }
  if (extraLines.length) {
    extraLines.forEach((line) => {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#475569')
        .text(line, startX, doc.y + 4);
      doc.moveDown(0.2);
    });
    doc.moveDown(0.2);
  }
  ensureMinimumSpacing(doc, 10);
  drawReportTable(
    doc,
    rows,
    buildDailyReportColumns(usableWidth),
    startX,
    usableWidth,
    {
      resolveRowFill: (row, index) => {
        if (row.isSummary) return '#0f172a';
        if (row.isCancelled) return '#fee2e2';
        return index % 2 === 0 ? '#ffffff' : '#f8fafc';
      },
      resolveFontColor: (row) => (row.isSummary ? '#ffffff' : '#0f172a')
    }
  );

  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#94a3b8')
    .text('Documento generado automáticamente por Trident Innova.', startX, doc.y, {
      width: usableWidth,
      align: 'center'
    });
}

function renderMarginSalesReport(doc, ventas, { range, filterChips }) {
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totals = calculateMarginTotals(ventas);
  const rows = buildMarginReportRows(ventas, totals);
  renderReportHeader(doc, 'Reporte de margen de ventas', range, startX, usableWidth, filterChips);
  drawReportFilterTags(doc, filterChips, startX, usableWidth);
  drawReportSummaryChips(
    doc,
    [
      { label: 'Ventas analizadas', value: formatIntegerValue(ventas.length) },
      { label: 'Total ventas', value: formatCurrencyPyG(totals.totalVenta) },
      { label: 'Costo estimado', value: formatCurrencyPyG(totals.costo) },
      { label: 'Margen promedio', value: formatPercentValue(totals.margenPercent) }
    ],
    startX,
    usableWidth
  );
  ensureMinimumSpacing(doc, 10);
  drawReportTable(
    doc,
    rows,
    buildMarginReportColumns(usableWidth),
    startX,
    usableWidth,
    {
      resolveRowFill: (row, index) => (row.isSummary ? '#0f172a' : index % 2 === 0 ? '#ffffff' : '#f8fafc'),
      resolveFontColor: (row) => (row.isSummary ? '#ffffff' : '#0f172a')
    }
  );

  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#94a3b8')
    .text('Documento generado automáticamente por Trident Innova.', startX, doc.y, {
      width: usableWidth,
      align: 'center'
    });
}

function renderReportHeader(doc, title, range, startX, usableWidth, filterChips = []) {
  const startLabel = formatRangeDateLabel(range.startDate);
  const endLabel = formatRangeDateLabel(range.endDate);
  const subtitle = startLabel === endLabel ? `Fecha: ${startLabel}` : `Rango: ${startLabel} – ${endLabel}`;

  const hasLogo = fs.existsSync(REPORT_LOGO_PATH);
  const logoHeight = 84;
  let cursorY = doc.page.margins.top;

  if (hasLogo) {
    try {
      doc.image(REPORT_LOGO_PATH, startX, cursorY - 6, { fit: [180, logoHeight], align: 'left' });
    } catch (logoError) {
      console.warn('[Reportes] No se pudo incrustar el logo.', logoError);
    }
  }

  const textBlockOffset = hasLogo ? 190 : 0;
  const textStartX = startX + textBlockOffset;
  const textWidth = usableWidth - textBlockOffset * 2;

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#0f172a')
    .text(title, textStartX, cursorY, { width: textWidth, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#475569')
    .text(`${EMPRESA_INFO.nombre} · RUC ${EMPRESA_INFO.ruc}`, textStartX, doc.y + 6, {
      width: textWidth,
      align: 'center'
    });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#475569')
    .text(subtitle, textStartX, doc.y + 4, { width: textWidth, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#94a3b8')
    .text(`Generado: ${formatDateTimeLabel(new Date())}`, textStartX, doc.y + 6, {
      width: textWidth,
      align: 'center'
    });

  const filtersText = Array.isArray(filterChips) && filterChips.length ? filterChips.join(' | ') : 'Sin filtros';
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#64748b')
    .text(`Filtros: ${filtersText}`, textStartX, doc.y + 6, { width: textWidth, align: 'center' });

  doc.moveDown(2);
}

function drawReportFilterTags(doc, filterChips, startX, usableWidth) {
  if (!Array.isArray(filterChips) || !filterChips.length) {
    return;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#0f172a')
    .text('Filtros aplicados', startX, doc.y, { width: usableWidth });
  doc.moveDown(0.2);
  filterChips.forEach((chip) => {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#475569')
      .text(`• ${chip}`, startX, doc.y, { width: usableWidth });
  });
  doc.moveDown(0.5);
}

function drawReportSummaryChips(doc, items, startX, usableWidth) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#0f172a')
    .text('Resumen del periodo', startX, doc.y, { width: usableWidth });
  doc.moveDown(0.3);

  const visibleItems = items.slice(0, 4);
  const gap = 12;
  const chipWidth = (usableWidth - gap * (visibleItems.length - 1)) / visibleItems.length;
  const chipHeight = 56;
  const baseY = doc.y;

  visibleItems.forEach((item, index) => {
    const x = startX + index * (chipWidth + gap);
    doc.save();
    doc.roundedRect(x, baseY, chipWidth, chipHeight, 8).fill('#f8fafc');
    doc.restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#475569')
      .text(item.label, x + 10, baseY + 10, { width: chipWidth - 20 });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#0f172a')
      .text(String(item.value ?? '—'), x + 10, baseY + 26, { width: chipWidth - 20 });
  });

  doc.y = baseY + chipHeight + 8;

  if (items.length > visibleItems.length) {
    const remaining = items.slice(visibleItems.length);
    remaining.forEach((item) => {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#475569')
        .text(`${item.label}: ${item.value}`, startX, doc.y, { width: usableWidth });
    });
    doc.moveDown(0.4);
  }
}

function ensureMinimumSpacing(doc, amount) {
  const desired = Math.max(0, amount);
  if (doc.y - doc.page.margins.top < desired) {
    doc.moveDown(0.1);
  }
  doc.y = Math.max(doc.y, doc.page.margins.top + desired);
}

function drawReportTable(doc, rows, columns, startX, usableWidth, options = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#475569')
      .text('No se encontraron registros para el rango indicado.', startX, doc.y, { width: usableWidth });
    return;
  }

  const headerHeight = 24;
  const maxY = () => doc.page.height - doc.page.margins.bottom;

  const drawHeader = () => {
    const headerY = doc.y;
    doc.save();
    doc.rect(startX, headerY, usableWidth, headerHeight).fill('#f97316');
    doc.restore();
    let cursorX = startX;
    columns.forEach((col, columnIndex) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#ffffff')
        .text(col.label, cursorX + 6, headerY + 6, { width: col.width - 12, align: col.align || 'left' });
      cursorX += col.width;
      if (columnIndex < columns.length - 1) {
        doc
          .moveTo(cursorX, headerY)
          .lineTo(cursorX, headerY + headerHeight)
          .stroke('#1e293b');
      }
    });
    doc.y += headerHeight - 2;
  };

  drawHeader();

  rows.forEach((row, index) => {
    const rowHeight = measureReportRowHeight(doc, row, columns);
    if (doc.y + rowHeight > maxY()) {
      doc.addPage();
      drawHeader();
    }

    const fillColor = options.resolveRowFill ? options.resolveRowFill(row, index) : index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const fontColor = options.resolveFontColor ? options.resolveFontColor(row, index) : '#0f172a';
    const fontName = row.isSummary ? 'Helvetica-Bold' : 'Helvetica';
    const rowY = doc.y;

    doc.save();
    doc.rect(startX, rowY, usableWidth, rowHeight).fill(fillColor);
    doc.restore();
    doc.rect(startX, rowY, usableWidth, rowHeight).stroke('#e2e8f0');

    let cursorX = startX;
    columns.forEach((col, columnIndex) => {
      const value = row[col.key] ?? '—';
      doc
        .font(fontName)
        .fontSize(col.key === 'estado' ? 8 : 9)
        .fillColor(fontColor)
        .text(value, cursorX + 6, rowY + 6, { width: col.width - 12, align: col.align || 'left' });
      cursorX += col.width;
      if (columnIndex < columns.length - 1) {
        doc
          .moveTo(cursorX, rowY)
          .lineTo(cursorX, rowY + rowHeight)
          .stroke('#e2e8f0');
      }
    });

    doc.y = rowY + rowHeight;
  });
}

function measureReportRowHeight(doc, row, columns) {
  let height = 20;
  doc.font('Helvetica').fontSize(9);
  columns.forEach((col) => {
    const value = row[col.key] ?? '—';
    const textHeight = doc.heightOfString(String(value), {
      width: Math.max(col.width - 12, 18),
      align: col.align || 'left'
    });
    height = Math.max(height, textHeight + 10);
  });
  return height;
}

function buildDailyReportColumns(usableWidth) {
  const definitions = [
    { key: 'fecha', label: 'Fecha', ratio: 0.075 },
    { key: 'factura', label: 'N° factura', ratio: 0.11 },
    { key: 'cliente', label: 'Cliente', ratio: 0.19 },
    { key: 'usuario', label: 'Usuario', ratio: 0.09 },
    { key: 'estado', label: 'Estado', ratio: 0.065 },
    { key: 'condicion', label: 'Condición', ratio: 0.05 },
    { key: 'subtotal', label: 'Subtotal', ratio: 0.13, align: 'right' },
    { key: 'descuento', label: 'Descuento', ratio: 0.08, align: 'right' },
    { key: 'iva', label: 'IVA', ratio: 0.09, align: 'right' },
    { key: 'total', label: 'Total', ratio: 0.1, align: 'right' },
    { key: 'items', label: 'Items', ratio: 0.02, align: 'center' }
  ];

  return definitions.map((column) => ({
    ...column,
    width: usableWidth * column.ratio
  }));
}

function buildDailyReportRows(ventas, totals) {
  const rows = ventas.map((venta) => {
    const estadoBase = (venta.estado || '').toUpperCase();
    const anulada = estadoBase === 'ANULADA' || Boolean(venta.deleted_at);
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    const condicion = condicionRaw.includes('CREDITO') ? 'Crédito' : 'Contado';
    return {
      fecha: formatDateForDisplay(venta.fecha || venta.created_at),
      factura: resolveInvoiceNumberForReport(venta),
      cliente: venta.cliente?.nombre_razon_social || 'Cliente eventual',
      usuario: venta.usuario?.nombre || venta.usuario?.usuario || '—',
      estado: anulada ? 'Anulada' : venta.estado || '—',
      condicion,
      subtotal: formatCurrencyPyG(venta.subtotal),
      descuento: formatCurrencyPyG(venta.descuento_total),
      iva: formatCurrencyPyG(venta.impuesto_total),
      total: formatCurrencyPyG(venta.total ?? venta.subtotal),
      items: formatIntegerValue(countVentaItems(venta)),
      isCancelled: anulada
    };
  });

  rows.push({
    fecha: 'Totales',
    factura: `(${ventas.length} ventas)`,
    cliente: '',
    usuario: '',
    estado: '',
    condicion: '',
    subtotal: formatCurrencyPyG(totals.subtotal),
    descuento: formatCurrencyPyG(totals.descuento),
    iva: formatCurrencyPyG(totals.impuesto),
    total: formatCurrencyPyG(totals.total),
    items: formatIntegerValue(totals.items),
    isSummary: true
  });

  return rows;
}

function calculateDailyTotals(ventas) {
  const result = ventas.reduce(
    (acc, venta) => {
      const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
      const costo = computeCostoVenta(venta);
      acc.subtotal += Number(venta.subtotal) || 0;
      acc.descuento += Number(venta.descuento_total) || 0;
      acc.impuesto += Number(venta.impuesto_total) || 0;
      acc.total += totalVenta;
      acc.items += countVentaItems(venta);
      acc.costo += costo;
      acc.margen += totalVenta - costo;
      const currency = (venta.moneda || 'PYG').toUpperCase();
      const ivaTotal = Number(venta.impuesto_total) || 0;
      const ivaRate = Number(venta.iva_porcentaje) || 10;
      if (ivaRate === 5) acc.iva5 += ivaTotal; else acc.iva10 += ivaTotal;
      if (currency === 'USD') {
        const usdAmount = Number(venta.total_moneda) || 0;
        if (usdAmount > 0) {
          acc.totalUsd += usdAmount;
        }
        const tipoCambio = Number(venta.tipo_cambio) || 0;
        if (ivaTotal > 0 && tipoCambio > 0) {
          const ivaUsd = ivaTotal / tipoCambio;
          acc.impuestoUsd += ivaUsd;
          if (ivaRate === 5) acc.iva5Usd += ivaUsd; else acc.iva10Usd += ivaUsd;
        }
      }
      return acc;
    },
    {
      subtotal: 0,
      descuento: 0,
      impuesto: 0,
      total: 0,
      items: 0,
      totalUsd: 0,
      impuestoUsd: 0,
      iva5: 0,
      iva10: 0,
      iva5Usd: 0,
      iva10Usd: 0,
      costo: 0,
      margen: 0
    }
  );

  result.margenPercent = result.total > 0 ? (result.margen / result.total) * 100 : 0;
  return result;
}

function buildDailyCsv(ventas) {
  const header = [
    'Fecha',
    'Nro factura',
    'Cliente',
    'Estado',
    'Condición',
    'Moneda',
    'Subtotal_PYG',
    'Descuento_PYG',
    'IVA_PYG',
    'Total_PYG',
    'Total_Moneda',
    'Tipo_cambio',
    'Costo_estimado_PYG',
    'Margen_PYG',
    'Margen_%',
    'Items'
  ];

  const totals = calculateDailyTotals(ventas);
  const rows = ventas.map((venta) => {
    const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
    const costo = computeCostoVenta(venta);
    const margen = totalVenta - costo;
    const margenPercent = totalVenta > 0 ? (margen / totalVenta) * 100 : 0;
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    return [
      formatIsoDateOnly(venta.fecha || venta.created_at),
      resolveInvoiceNumberForReport(venta),
      venta.cliente?.nombre_razon_social || 'Cliente eventual',
      venta.estado || '',
      condicionRaw,
      (venta.moneda || 'PYG').toUpperCase(),
      plainNumber(venta.subtotal),
      plainNumber(venta.descuento_total),
      plainNumber(venta.impuesto_total),
      plainNumber(totalVenta),
      plainNumber(venta.total_moneda),
      plainNumber(venta.tipo_cambio),
      plainNumber(costo),
      plainNumber(margen),
      plainPercent(margenPercent),
      plainNumber(countVentaItems(venta))
    ];
  });

  rows.push([
    'Totales',
    `${ventas.length} ventas`,
    '',
    '',
    '',
    '',
    plainNumber(totals.subtotal),
    plainNumber(totals.descuento),
    plainNumber(totals.impuesto),
    plainNumber(totals.total),
    plainNumber(totals.totalUsd),
    '',
    plainNumber(totals.costo),
    plainNumber(totals.margen),
    plainPercent(totals.margenPercent),
    plainNumber(totals.items)
  ]);

  const lines = [header, ...rows].map((line) => stringifyCsvRow(line));
  return lines.join('\n');
}

function buildDailyXlsx(ventas, range, filterChips = []) {
  const header = [
    'Fecha',
    'Nro factura',
    'Cliente',
    'Estado',
    'Condición',
    'Moneda',
    'Subtotal PYG',
    'Descuento PYG',
    'IVA PYG',
    'Total PYG',
    'Total Moneda',
    'Tipo cambio',
    'Costo estimado PYG',
    'Margen PYG',
    'Margen %',
    'Items'
  ];

  const totals = calculateDailyTotals(ventas);
  const rows = ventas.map((venta) => {
    const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
    const costo = computeCostoVenta(venta);
    const margen = totalVenta - costo;
    const margenPercent = totalVenta > 0 ? (margen / totalVenta) * 100 : 0;
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    return [
      formatIsoDateOnly(venta.fecha || venta.created_at),
      resolveInvoiceNumberForReport(venta),
      venta.cliente?.nombre_razon_social || 'Cliente eventual',
      venta.estado || '',
      condicionRaw,
      (venta.moneda || 'PYG').toUpperCase(),
      asNumberOrNull(venta.subtotal),
      asNumberOrNull(venta.descuento_total),
      asNumberOrNull(venta.impuesto_total),
      asNumberOrNull(totalVenta),
      asNumberOrNull(venta.total_moneda),
      asNumberOrNull(venta.tipo_cambio),
      asNumberOrNull(costo),
      asNumberOrNull(margen),
      asPercentNumber(margenPercent),
      asNumberOrNull(countVentaItems(venta))
    ];
  });

  rows.push([
    'Totales',
    `${ventas.length} ventas`,
    '',
    '',
    '',
    '',
    asNumberOrNull(totals.subtotal),
    asNumberOrNull(totals.descuento),
    asNumberOrNull(totals.impuesto),
    asNumberOrNull(totals.total),
    asNumberOrNull(totals.totalUsd),
    '',
    asNumberOrNull(totals.costo),
    asNumberOrNull(totals.margen),
    asPercentNumber(totals.margenPercent),
    asNumberOrNull(totals.items)
  ]);

  const metaRows = [
    ['Reporte diario de ventas'],
    [`Rango: ${formatRangeDateLabel(range.startDate)} – ${formatRangeDateLabel(range.endDate)}`],
    [`Generado: ${formatDateTimeLabel(new Date())}`],
    [`Filtros: ${Array.isArray(filterChips) && filterChips.length ? filterChips.join(' | ') : 'Sin filtros'}`],
    []
  ];

  const aoa = [...metaRows, header, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = header.map(() => ({ wch: 18 }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Diario');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function buildMarginReportColumns(usableWidth) {
  const definitions = [
    { key: 'fecha', label: 'Fecha', ratio: 0.1 },
    { key: 'factura', label: 'N° factura', ratio: 0.16 },
    { key: 'cliente', label: 'Cliente', ratio: 0.22 },
    { key: 'condicion', label: 'Condición', ratio: 0.08 },
    { key: 'total', label: 'Total venta', ratio: 0.14, align: 'right' },
    { key: 'costo', label: 'Costo estimado', ratio: 0.13, align: 'right' },
    { key: 'margen', label: 'Margen', ratio: 0.11, align: 'right' },
    { key: 'margenPorcentaje', label: 'Margen %', ratio: 0.06, align: 'right' }
  ];

  return definitions.map((column) => ({
    ...column,
    width: usableWidth * column.ratio
  }));
}

function buildMarginReportRows(ventas, totals) {
  const rows = ventas.map((venta) => {
    const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
    const costo = computeCostoVenta(venta);
    const margen = totalVenta - costo;
    const porcentaje = totalVenta > 0 ? (margen / totalVenta) * 100 : 0;
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    const condicion = condicionRaw.includes('CREDITO') ? 'Crédito' : 'Contado';
    return {
      fecha: formatDateForDisplay(venta.fecha || venta.created_at),
      factura: resolveInvoiceNumberForReport(venta),
      cliente: venta.cliente?.nombre_razon_social || 'Cliente eventual',
      condicion,
      total: formatCurrencyPyG(totalVenta),
      costo: formatCurrencyPyG(costo),
      margen: formatCurrencyPyG(margen),
      margenPorcentaje: formatPercentValue(porcentaje)
    };
  });

  rows.push({
    fecha: 'Totales',
    factura: `(${ventas.length} ventas)`,
    cliente: '',
    condicion: '',
    total: formatCurrencyPyG(totals.totalVenta),
    costo: formatCurrencyPyG(totals.costo),
    margen: formatCurrencyPyG(totals.margen),
    margenPorcentaje: formatPercentValue(totals.margenPercent),
    isSummary: true
  });

  return rows;
}

function calculateMarginTotals(ventas) {
  const result = ventas.reduce(
    (acc, venta) => {
      const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
      const costo = computeCostoVenta(venta);
      const margen = totalVenta - costo;
      acc.totalVenta += totalVenta;
      acc.costo += costo;
      acc.margen += margen;
      return acc;
    },
    { totalVenta: 0, costo: 0, margen: 0 }
  );

  result.margenPercent = result.totalVenta > 0 ? (result.margen / result.totalVenta) * 100 : 0;
  return result;
}

function computeCostoVenta(venta) {
  if (!Array.isArray(venta?.detalles)) return 0;
  return venta.detalles.reduce((acc, detalle) => acc + computeCostoDetalle(detalle), 0);
}

function computeCostoDetalle(detalle) {
  const cantidad = Number(detalle?.cantidad) || 0;
  if (!cantidad) return 0;
  const producto = detalle?.producto || {};
  let costoUnitario = Number(producto.precio_compra) || 0;
  if (!costoUnitario && producto.precio_compra_original && producto.tipo_cambio_precio_compra) {
    const original = Number(producto.precio_compra_original) || 0;
    const tipoCambio = Number(producto.tipo_cambio_precio_compra) || 0;
    if (original && tipoCambio) {
      costoUnitario = original * tipoCambio;
    }
  }
  return cantidad * costoUnitario;
}

function resolveInvoiceNumberForReport(venta) {
  if (venta?.factura_digital?.nro_factura) return venta.factura_digital.nro_factura;
  if (venta?.factura_electronica?.nro_factura) return venta.factura_electronica.nro_factura;
  if (venta?.numero_factura) return venta.numero_factura;
  return venta?.id ? venta.id.slice(0, 8).toUpperCase() : '-';
}

function countVentaItems(venta) {
  if (!Array.isArray(venta?.detalles)) return 0;
  return venta.detalles.length;
}

function formatCurrencyPyG(value) {
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: 'PYG',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function formatCurrencyUsd(value) {
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function formatPercentValue(value) {
  const numeric = Number(value) || 0;
  return `${numeric.toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function plainNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return '';
  return numeric.toString();
}

function asNumberOrNull(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return numeric;
}

function asPercentNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return Number(numeric.toFixed(2));
}

function plainPercent(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return '';
  return numeric.toFixed(2);
}

function stringifyCsvRow(values) {
  return values
    .map((value) => {
      const text = value === null || value === undefined ? '' : String(value);
      const escaped = text.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(',');
}

function formatIntegerValue(value) {
  return new Intl.NumberFormat('es-PY').format(Number(value) || 0);
}

function formatIsoDateOnly(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return value.toISOString().slice(0, 10);
}

function formatDateForDisplay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function formatRangeDateLabel(value) {
  const adjusted = adjustDateForRangeLabel(value);
  if (!adjusted) return '-';
  return formatDateForDisplay(adjusted);
}

function adjustDateForRangeLabel(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

function formatDateTimeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function generarNumeroFactura(venta, timbradoInput) {
  const timbrado = timbradoInput || selectTimbradoParaVenta(venta, empresaConfig);
  const establecimiento = (timbrado.establecimiento || '001').padStart(3, '0');
  const punto = (timbrado.punto_expedicion || timbrado.punto || '001').padStart(3, '0');
  const base = (venta?.id || venta || '').toString().replace(/-/g, '').toUpperCase();
  const correlativo = base.slice(0, 7).padEnd(7, '0');
  return `${establecimiento}-${punto}-${correlativo}`;
}

function parseSecuenciaFromNumero(nroFactura) {
  if (!nroFactura || typeof nroFactura !== 'string') return null;
  const parts = nroFactura.split('-');
  if (parts.length !== 3) return null;
  const correlativo = parts[2].replace(/[^0-9]/g, '');
  if (!correlativo) return null;
  const parsed = Number(correlativo);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveOverride(value) {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function getMinSecuenciaOverride(timbrado) {
  const est = (timbrado.establecimiento || '001').padStart(3, '0');
  const punto = (timbrado.punto_expedicion || timbrado.punto || '001').padStart(3, '0');
  const scopedKey = `FACTURA_MIN_SECUENCIA_${est}_${punto}`;
  const globalKey = 'FACTURA_MIN_SECUENCIA';
  const scoped = parsePositiveOverride(process.env[scopedKey]);
  const global = parsePositiveOverride(process.env[globalKey]);
  return Math.max(scoped, global);
}

async function resolveSecuenciaFactura(tx, timbrado, sucursalId) {
  const whereDigital = {
    timbrado: timbrado.numero,
    establecimiento: timbrado.establecimiento || '001',
    punto_expedicion: timbrado.punto_expedicion || timbrado.punto || '001'
  };

  // Importante: nro_factura es único global, por eso no filtramos por sucursal al buscar el máximo electrónico.
  const whereElectronica = { timbrado: timbrado.numero };

  const fetchMaxes = async (whereDigitalFilter, whereElectronicaFilter) => {
    const [ultimoDigital, ultimasElectronicas] = await Promise.all([
      tx.facturaDigital.findFirst({
        where: whereDigitalFilter,
        orderBy: { secuencia: 'desc' },
        select: { secuencia: true }
      }),
      tx.facturaElectronica.findMany({
        where: whereElectronicaFilter,
        select: { nro_factura: true },
        orderBy: { created_at: 'desc' },
        take: 10
      })
    ]);

    const maxSecuenciaElectronica = (ultimasElectronicas || []).reduce((max, item) => {
      const parsed = parseSecuenciaFromNumero(item.nro_factura);
      return Math.max(max, parsed || 0);
    }, 0);

    const maxSecuencia = Math.max(ultimoDigital?.secuencia || 0, maxSecuenciaElectronica);
    return maxSecuencia + 1;
  };

  // Primero intentamos scoped a la sucursal; si no hay registros, ampliamos a todo el timbrado.
  const overrideMin = getMinSecuenciaOverride(timbrado);

  const scoped = await fetchMaxes(whereDigital, whereElectronica);
  return Math.max(scoped, overrideMin);
}

function toDateOnlyString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function deriveCreditoDescripcion(descripcion, fechaEmision, fechaVencimiento) {
  if (descripcion && descripcion.trim()) return descripcion.trim().slice(0, 10);
  if (fechaEmision && fechaVencimiento) {
    const diffMs = new Date(fechaVencimiento).getTime() - new Date(fechaEmision).getTime();
    const dias = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
    return `${dias} dias`.slice(0, 10);
  }
  return '30 dias';
}

function normalizeCuotas(cuotas) {
  if (!Array.isArray(cuotas)) return [];
  return cuotas
    .map((cuota, idx) => {
      const monto = round(Number(cuota?.monto) || 0, 2);
      const numero = Number(cuota?.numero) || idx + 1;
      const fechaVencimiento = toDateOnlyString(cuota?.fecha_vencimiento || cuota?.fechaVencimiento);
      if (!monto || !fechaVencimiento) return null;
      return { numero, monto, fechaVencimiento };
    })
    .filter(Boolean)
    .sort((a, b) => a.numero - b.numero);
}

function buildCreditoSection(venta, opciones, totalPago, fechaEmision) {
  const condicionVenta = normalizeCondicionVenta(opciones?.condicion_pago || venta?.condicion_venta, opciones?.credito);
  const esCredito = condicionVenta === 'CREDITO';

  if (!esCredito) {
    return {
      condicionVenta,
      condicionPago: 1,
      pagos: [
        {
          tipoPago: '1',
          monto: totalPago
        }
      ],
      credito: null
    };
  }

  const creditoConfig = opciones?.credito || venta?.credito_config || venta?.factura_electronica?.respuesta_set?.credito;
  const fechaVencimiento = opciones?.fecha_vencimiento || creditoConfig?.fecha_vencimiento || venta?.fecha_vencimiento;

  const cuotasNormalizadas = normalizeCuotas(creditoConfig?.cuotas);
  if (creditoConfig && (creditoConfig?.tipo === 'CUOTAS' || cuotasNormalizadas.length)) {
    const cantidadCuota = creditoConfig.cantidad_cuotas || cuotasNormalizadas.length || 1;
    const cuotasPayload = cuotasNormalizadas.length
      ? cuotasNormalizadas
      : [
          {
            numero: 1,
            monto: totalPago,
            fechaVencimiento: toDateOnlyString(fechaVencimiento) || toDateOnlyString(fechaEmision)
          }
        ];

    return {
      condicionVenta,
      condicionPago: 2,
      pagos: [{}],
      credito: {
        condicionCredito: 2,
        cantidadCuota: cantidadCuota,
        cuotas: cuotasPayload
      }
    };
  }

  const descripcion = deriveCreditoDescripcion(creditoConfig?.descripcion, fechaEmision, fechaVencimiento);

  return {
    condicionVenta,
    condicionPago: 2,
    pagos: [{}],
    credito: {
      condicionCredito: 1,
      descripcion
    }
  };
}

function buildFactPyPayload(venta, factura, opciones = {}) {
  if (!venta) {
    throw new Error('Venta requerida para FactPy');
  }
  const parseMonto = (value) => {
    if (typeof value === 'string') {
      const normalized = value.replace(/\./g, '').replace(/,/g, '.');
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : Number(value);
    }
    return Number(value);
  };

  const timbradoSeleccionado = selectTimbradoParaVenta(venta, empresaConfig);
  const numeroFactura = factura?.nro_factura || generarNumeroFactura(venta, timbradoSeleccionado);
  const secuencia = (numeroFactura.split('-').pop() || '0000001').replace(/[^0-9]/g, '').padStart(7, '0');
  const fecha = venta?.created_at ? new Date(venta.created_at) : new Date();
  const cliente = venta?.cliente || {};
  const nombreCliente = cliente.nombre_razon_social || cliente.nombre || 'CLIENTE';
  const rucCliente = cliente.ruc || '';
  const direccionCliente = cliente.direccion || cliente.direccion_facturacion || 'S/D';
  const correoCliente = cliente.correo || cliente.email || '';
  const moneda = (venta?.moneda || 'PYG').toUpperCase();
  const cambio = parseMonto(venta?.tipo_cambio) || 0;
  const establecimiento = process.env.FACTPY_ESTABLECIMIENTO || timbradoSeleccionado.establecimiento || '001';
  const punto = process.env.FACTPY_PUNTO || timbradoSeleccionado.punto_expedicion || timbradoSeleccionado.punto || '001';
  const descuentoTotalGs = parseMonto(venta?.descuento_total) || 0;
  const descuentoTotal = (() => {
    if (moneda === 'USD') {
      if (cambio && cambio > 0) {
        return round(descuentoTotalGs / cambio, 4);
      }
      return 0;
    }
    return descuentoTotalGs;
  })();

  const random9 = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');

  const convertirMonto = (monto) => {
    const valor = parseMonto(monto) || 0;
    if (moneda === 'USD') {
      if (!cambio || cambio <= 0) return 0;
      return round(valor / cambio, 4);
    }
    return round(valor, 2);
  };

  const items = Array.isArray(venta?.detalles)
    ? venta.detalles.map((detalle, idx) => {
        const cantidad = Number(detalle?.cantidad) || 1;
        const precioUnitarioGs = Number(detalle?.precio_unitario || detalle?.subtotal / (cantidad || 1) || detalle?.producto?.precio_venta) || 0;
        const precioUnitarioConvertido = convertirMonto(precioUnitarioGs);
        const precioUnitario = precioUnitarioConvertido > 0 ? precioUnitarioConvertido : round(precioUnitarioGs, 4);
        const precioTotal = round(precioUnitario * cantidad, 4);
        const ivaTasa = Number(detalle?.iva_porcentaje || detalle?.producto?.iva_porcentaje || venta?.iva_porcentaje || 10);
        const divisor = ivaTasa === 5 ? 1.05 : 1.1;
        const baseGravItem = Number((precioTotal / divisor).toFixed(8));
        const liqIvaItem = Number((precioTotal - baseGravItem).toFixed(8));
        const descripcion = detalle?.producto?.nombre || 'Item de venta';
        const codigo = detalle?.producto?.sku || detalle?.productoId || `ITEM-${idx + 1}`;
        return {
          descripcion,
          codigo,
          unidadMedida: 77,
          ivaTasa,
          ivaAfecta: 1,
          cantidad,
          precioUnitario,
          precioTotal,
          baseGravItem,
          liqIvaItem
        };
      })
    : [];

  const totalPagoBruto = round(items.reduce((sum, item) => sum + (Number(item.precioTotal) || 0), 0), 4);
  const descuentoAplicable = totalPagoBruto > 0 ? Math.min(descuentoTotal, totalPagoBruto) : 0;
  const itemsConDescuento = totalPagoBruto > 0 && descuentoAplicable > 0
    ? items.map((item) => {
        const proporcion = Number(item.precioTotal) / totalPagoBruto;
        const descuentoItem = round(proporcion * descuentoAplicable, 4);
        const precioTotalAjustado = Math.max(round(item.precioTotal - descuentoItem, 4), 0);
        const precioUnitarioAjustado = item.cantidad ? round(precioTotalAjustado / item.cantidad, 4) : precioTotalAjustado;
        const divisor = item.ivaTasa === 5 ? 1.05 : 1.1;
        const baseGravItem = Number((precioTotalAjustado / divisor).toFixed(8));
        const liqIvaItem = Number((precioTotalAjustado - baseGravItem).toFixed(8));
        return {
          ...item,
          precioUnitario: precioUnitarioAjustado,
          precioTotal: precioTotalAjustado,
          baseGravItem,
          liqIvaItem
        };
      })
    : items;

  const totalPago = round(itemsConDescuento.reduce((sum, item) => sum + (Number(item.precioTotal) || 0), 0), 4);
  const totalGs = round(Number(venta?.total) || totalPago, 2);
  const totalMoneda =
    moneda === 'USD'
      ? Number(venta?.total_moneda) || (cambio > 0 ? round(totalGs / cambio, 4) : totalPago)
      : totalGs;

  const credito = buildCreditoSection(venta, opciones, totalPago, fecha);

  return {
    fecha: fecha.toISOString().replace('T', ' ').slice(0, 19),
    establecimiento,
    punto,
    numero: secuencia,
    descripcion: factura?.id || venta?.id,
    tipoDocumento: 1,
    tipoEmision: 1,
    tipoTransaccion: 1,
    receiptid: venta.id,
    condicionPago: credito.condicionPago,
    moneda,
    cambio,
    cliente: {
      ruc: rucCliente,
      nombre: nombreCliente,
      direccion: direccionCliente,
      cpais: 'PRY',
      correo: correoCliente,
      numCasa: 0,
      diplomatico: false,
      dncp: 0
    },
    codigoSeguridadAleatorio: random9,
    items: itemsConDescuento,
    pagos: credito.pagos,
    ...(credito.credito ? { credito: credito.credito } : {}),
    totalPago,
    totalPagoGs: totalGs,
    totalPagoMoneda: totalMoneda,
    totalRedondeo: 0
  };
}

function selectTimbradoParaVenta(venta, config) {
  const baseTimbrado = config?.timbrado || {};
  const overrides = Array.isArray(config?.timbradosPorSucursal) ? config.timbradosPorSucursal : [];
  if (!venta) return baseTimbrado;
  const sucursalId = venta.sucursalId || venta.sucursal?.id;
  const sucursalNombre = (venta.sucursal?.nombre || '').trim().toLowerCase();
  const match = overrides.find((item) => {
    if (item.sucursalId && sucursalId && item.sucursalId === sucursalId) return true;
    if (item.nombre && sucursalNombre && sucursalNombre === String(item.nombre).trim().toLowerCase()) return true;
    return false;
  });
  if (match) {
    return { ...baseTimbrado, ...match };
  }
  return baseTimbrado;
}

function construirQrPlaceholder(venta, nroFactura) {
  const total = Number(venta?.total) || 0;
  const fecha = new Date(venta?.created_at || Date.now()).toISOString();
  return JSON.stringify({
    factura: nroFactura,
    total,
    fecha,
    cliente: venta?.cliente?.ruc || 'S/D'
  });
}

async function buildFacturaQrImage(factura, venta) {
  const nroFactura = factura?.nro_factura || generarNumeroFactura(venta);
  const rawPayload = factura?.qr_data || construirQrPlaceholder(venta, nroFactura);
  const payloadString = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

  try {
    return await QRCode.toBuffer(payloadString || nroFactura, {
      width: 180,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
  } catch (qrError) {
    console.error('[Factura] No se pudo generar el código QR.', qrError);
    return null;
  }
}

async function generarArchivosFactura(venta, factura) {
  if (!venta || !factura) return null;

  const storageDir = path.join(__dirname, '..', '..', 'storage');
  const facturaDir = path.join(storageDir, 'facturas');
  await fsPromises.mkdir(facturaDir, { recursive: true });

  const filenameSafe = (factura.nro_factura || factura.id || randomUUID()).replace(/[^a-zA-Z0-9-_]/gu, '_');
  const pdfFilename = `${filenameSafe}.pdf`;
  const xmlFilename = `${filenameSafe}.xml`;
  const pdfAbsolutePath = path.join(facturaDir, pdfFilename);
  const xmlAbsolutePath = path.join(facturaDir, xmlFilename);
  const pdfWebPath = `/storage/facturas/${pdfFilename}`;
  const xmlWebPath = `/storage/facturas/${xmlFilename}`;

  const qrBuffer = await buildFacturaQrImage(factura, venta);
  const doc = new PDFDocument({ size: 'A4', margin: 28 });
  const writeStream = fs.createWriteStream(pdfAbsolutePath);
  doc.pipe(writeStream);

  renderFacturaPdf(doc, venta, factura, qrBuffer);
  doc.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  try {
    const xmlPayload = buildFacturaXml(venta, factura);
    await fsPromises.writeFile(xmlAbsolutePath, xmlPayload, 'utf8');
  } catch (xmlError) {
    console.error('[Factura] No se pudo generar el XML de referencia.', xmlError);
  }

  return { pdfWebPath, xmlWebPath };
}

function renderFacturaPdf(doc, venta, factura, qrBuffer) {
  const logoPath = path.join(__dirname, '..', 'public', 'img', 'logo.png');
  const hasLogo = fs.existsSync(logoPath);
  const nroFactura = factura?.nro_factura || generarNumeroFactura(venta);
  const fechaEmision = factura?.fecha_emision || venta?.fecha || venta?.created_at || new Date();
  const margins = doc.page.margins;
  const contentWidth = doc.page.width - margins.left - margins.right;
  const startX = margins.left;
  let cursorY = margins.top;

  try {
    if (hasLogo) {
      doc.image(logoPath, startX + 16, cursorY + 12, { fit: [110, 60] });
    }
  } catch (logoError) {
    console.warn('[Factura] No se pudo incrustar el logo.', logoError);
  }

  doc.save();
  doc.roundedRect(startX, cursorY, contentWidth, 92, 8).stroke('#cbd5f5');
  doc.restore();

  const headerLeftX = hasLogo ? startX + 140 : startX + 18;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text(EMPRESA_INFO.nombre, headerLeftX, cursorY + 12, {
    width: contentWidth / 2 - 20
  });
  doc.font('Helvetica').fontSize(9).fillColor('#1f2937');
  doc.text(`RUC: ${EMPRESA_INFO.ruc}`, headerLeftX);
  doc.text(EMPRESA_INFO.direccion, headerLeftX);
  if (EMPRESA_INFO.telefono) doc.text(`Tel: ${EMPRESA_INFO.telefono}`, headerLeftX);
  if (EMPRESA_INFO.email) doc.text(`Email: ${EMPRESA_INFO.email}`, headerLeftX);

  const headerRightX = startX + contentWidth / 2;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a');
  doc.text('KuDE - Factura electrónica', headerRightX, cursorY + 14, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  doc.text(`Factura N° ${nroFactura}`, headerRightX, doc.y + 2, { width: contentWidth / 2 - 20, align: 'right' });
  doc.text(`Fecha: ${formatDatePrintable(fechaEmision)}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Timbrado: ${factura?.timbrado || 'No informado'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Estado: ${factura?.estado || '-'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Ambiente: ${factura?.ambiente || 'PRUEBA'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Condición: ${venta?.condicion_venta || 'CONTADO'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });

  cursorY += 108;

  const blockWidth = contentWidth / 2 - 8;
  const emisorRows = [
    { label: 'Contribuyente', value: EMPRESA_INFO.nombre },
    { label: 'RUC', value: EMPRESA_INFO.ruc },
    { label: 'Dirección', value: EMPRESA_INFO.direccion },
    { label: 'Teléfono', value: EMPRESA_INFO.telefono || '-' }
  ];
  const cliente = venta?.cliente || {};
  const clienteRows = [
    { label: 'Cliente', value: cliente.nombre_razon_social || 'Cliente eventual' },
    { label: 'RUC/CI', value: cliente.ruc || 'S/D' },
    { label: 'Teléfono', value: cliente.telefono || '-' },
    { label: 'Correo', value: cliente.correo || '-' }
  ];

  const emisorBottom = renderInfoBlock(doc, 'Datos del emisor', emisorRows, startX, cursorY, blockWidth);
  const clienteBottom = renderInfoBlock(doc, 'Datos del receptor', clienteRows, startX + blockWidth + 16, cursorY, blockWidth);
  cursorY = Math.max(emisorBottom, clienteBottom) + 16;

  cursorY = renderDetalleItems(doc, venta, startX, cursorY, contentWidth) + 16;

  const totals = computeInvoiceTotals(venta);
  const breakdown = computeIvaBreakdown(venta);
  const totalsWidth = contentWidth * 0.55;
  const qrWidth = contentWidth - totalsWidth - 16;
  const totalsBottom = renderTotalsBlock(doc, totals, breakdown, startX, cursorY, totalsWidth);
  const qrBottom = renderQrPanel(doc, factura, qrBuffer, startX + totalsWidth + 16, cursorY, qrWidth);

  cursorY = Math.max(totalsBottom, qrBottom) + 18;
  doc.font('Helvetica').fontSize(8).fillColor('#4b5563');
  doc.text(
    'Documento generado electrónicamente por TRIDENT INNOVA E.A.S. Consulte la validez en https://ekuatia.set.gov.py/consultas',
    startX,
    cursorY,
    { width: contentWidth, align: 'center' }
  );
}

function renderInfoBlock(doc, title, rows, x, y, width) {
  const minHeight = 60;
  const estimatedHeight = Math.max(rows.length * 14 + 26, minHeight);
  doc.save();
  doc.roundedRect(x, y, width, estimatedHeight, 6).stroke('#e5e7eb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(title, x + 10, y + 8);
  let cursor = y + 24;
  rows.forEach((row) => {
    const value = row.value || '-';
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1f2937').text(`${row.label}:`, x + 10, cursor, { continued: true });
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(` ${value}`, { width: width - 20 });
    cursor += 14;
  });
  doc.restore();
  return y + estimatedHeight;
}

function renderDetalleItems(doc, venta, x, y, width) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const columns = buildDetalleColumns(width);
  const headerHeight = 22;

  doc.save();
  doc.rect(x, y, width, headerHeight).fill('#0f172a');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  let columnX = x;
  columns.forEach((col) => {
    doc.text(col.label, columnX + 4, y + 5, { width: col.width - 8, align: col.align });
    columnX += col.width;
  });
  doc.restore();

  let cursor = y + headerHeight;
  if (!detalles.length) {
    doc.rect(x, cursor, width, 26).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text('Sin detalles registrados', x + 10, cursor + 7);
    return cursor + 26;
  }

  detalles.forEach((detalle) => {
    const rowHeight = 20;
    doc.rect(x, cursor, width, rowHeight).stroke('#e5e7eb');
    const cantidad = Number(detalle.cantidad) || 0;
    const precio = Number(detalle.precio_unitario) || 0;
    const subtotal = Number(detalle.subtotal) || cantidad * precio;
    const ivaDetalle = getDetalleIvaPorcentaje(detalle, venta);
    const impuestoColumns = splitTaxColumns(subtotal, ivaDetalle);
    const row = {
      codigo: getDetalleCodigo(detalle),
      descripcion: detalle.producto?.nombre || 'Producto',
      cantidad: formatNumberPrintable(cantidad),
      precio: formatCurrencyPrintable(precio),
      exentas: formatCurrencyPrintable(impuestoColumns.exentas),
      grav5: formatCurrencyPrintable(impuestoColumns.gravado5),
      grav10: formatCurrencyPrintable(impuestoColumns.gravado10)
    };

    let cellX = x;
    columns.forEach((col) => {
      const value = row[col.key] || '-';
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(value, cellX + 4, cursor + 5, {
        width: col.width - 8,
        align: col.align
      });
      cellX += col.width;
    });

    cursor += rowHeight;
  });

  return cursor;
}

function buildDetalleColumns(availableWidth) {
  const baseColumns = [
    { key: 'codigo', label: 'Código', width: 70, align: 'left' },
    { key: 'descripcion', label: 'Descripción', width: 0, align: 'left' },
    { key: 'cantidad', label: 'Cant.', width: 45, align: 'right' },
    { key: 'precio', label: 'Precio Unit.', width: 70, align: 'right' },
    { key: 'exentas', label: 'Exentas', width: 60, align: 'right' },
    { key: 'grav5', label: 'Grav. 5%', width: 60, align: 'right' },
    { key: 'grav10', label: 'Grav. 10%', width: 60, align: 'right' }
  ];
  const usedWidth = baseColumns.filter((col) => col.width).reduce((acc, col) => acc + col.width, 0);
  baseColumns[1].width = Math.max(120, availableWidth - usedWidth);
  return baseColumns;
}

function renderTotalsBlock(doc, totals, breakdown, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Liquidación del IVA', x, y);
  let cursor = y + 16;

  const columnWidths = [width * 0.45, width * 0.25, width * 0.3];
  const headerHeight = 18;
  doc.save();
  doc.rect(x, cursor, width, headerHeight).fill('#0f172a');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  doc.text('Concepto', x + 8, cursor + 4, { width: columnWidths[0] - 10 });
  doc.text('Gravado', x + columnWidths[0], cursor + 4, { width: columnWidths[1] - 8, align: 'right' });
  doc.text('IVA', x + columnWidths[0] + columnWidths[1], cursor + 4, { width: columnWidths[2] - 8, align: 'right' });
  doc.restore();

  cursor += headerHeight;
  const rows = [
    { label: 'Exentas', gravado: breakdown.exentas, iva: 0 },
    { label: 'Gravadas 5%', gravado: breakdown.gravado5, iva: breakdown.iva5 },
    { label: 'Gravadas 10%', gravado: breakdown.gravado10, iva: breakdown.iva10 }
  ];

  rows.forEach((row) => {
    doc.rect(x, cursor, width, 18).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(9).fillColor('#111827');
    doc.text(row.label, x + 8, cursor + 4, { width: columnWidths[0] - 10 });
    doc.text(formatCurrencyPrintable(row.gravado), x + columnWidths[0], cursor + 4, {
      width: columnWidths[1] - 8,
      align: 'right'
    });
    doc.text(formatCurrencyPrintable(row.iva), x + columnWidths[0] + columnWidths[1], cursor + 4, {
      width: columnWidths[2] - 8,
      align: 'right'
    });
    cursor += 18;
  });

  cursor += 16;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Totales del comprobante', x, cursor);
  cursor += 12;
  cursor = renderKeyValueRow(doc, 'Subtotal', formatCurrencyPrintable(totals.subtotal), x, cursor, width);
  cursor = renderKeyValueRow(doc, 'Descuento', formatCurrencyPrintable(totals.descuento), x, cursor, width);
  cursor = renderKeyValueRow(doc, 'IVA', formatCurrencyPrintable(totals.iva), x, cursor, width);
  cursor = renderKeyValueRow(doc, 'Total', formatCurrencyPrintable(totals.total), x, cursor, width, { boldValue: true });
  return cursor;
}

function renderKeyValueRow(doc, label, value, x, y, width, options = {}) {
  const leftWidth = width * 0.55;
  doc.font('Helvetica').fontSize(9).fillColor('#4b5563').text(label, x, y, { width: leftWidth });
  doc
    .font(options.boldValue ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(10)
    .fillColor('#111827')
    .text(value, x, y, { width, align: 'right' });
  return y + 14;
}

function computeInvoiceTotals(venta) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const subtotal = detalles.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);
  const descuento = Number(venta?.descuento_total) || 0;
  const total = Number(venta?.total) || Math.max(subtotal - descuento, 0);
  const divisor = IVA_DIVISOR[Number(venta?.iva_porcentaje) || 10] || IVA_DIVISOR[10];
  const iva = total > 0 ? total / divisor : 0;
  return { subtotal, descuento, total, iva };
}

function computeIvaBreakdown(venta) {
  const totals = computeInvoiceTotals(venta);
  const ivaPorcentaje = Number(venta?.iva_porcentaje) || 10;
  const breakdown = {
    exentas: 0,
    gravado5: 0,
    iva5: 0,
    gravado10: 0,
    iva10: 0
  };

  if (ivaPorcentaje === 5) {
    const iva = totals.total / (IVA_DIVISOR[5] || 21);
    breakdown.gravado5 = totals.total - iva;
    breakdown.iva5 = iva;
  } else if (ivaPorcentaje === 10) {
    const iva = totals.total / (IVA_DIVISOR[10] || 11);
    breakdown.gravado10 = totals.total - iva;
    breakdown.iva10 = iva;
  } else {
    breakdown.exentas = totals.total;
  }

  return breakdown;
}

function getDetalleIvaPorcentaje(detalle, venta) {
  if (typeof detalle?.iva_porcentaje === 'number') return detalle.iva_porcentaje;
  if (typeof detalle?.producto?.iva_porcentaje === 'number') return detalle.producto.iva_porcentaje;
  return Number(venta?.iva_porcentaje) || 10;
}

function splitTaxColumns(amount, ivaPorcentaje) {
  if (ivaPorcentaje === 5) {
    return { exentas: 0, gravado5: amount, gravado10: 0 };
  }
  if (ivaPorcentaje === 10) {
    return { exentas: 0, gravado5: 0, gravado10: amount };
  }
  return { exentas: amount, gravado5: 0, gravado10: 0 };
}

function getDetalleCodigo(detalle) {
  if (detalle.producto?.sku) return detalle.producto.sku;
  if (detalle.producto?.codigo_barra) return detalle.producto.codigo_barra;
  if (detalle.producto?.id) return detalle.producto.id.slice(0, 8).toUpperCase();
  return detalle.id ? detalle.id.slice(0, 8).toUpperCase() : '-';
}

function renderQrPanel(doc, factura, qrBuffer, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Código QR - SET', x, y);
  let cursor = y + 10;
  const qrSize = Math.min(width - 24, 160);
  const qrX = x + (width - qrSize) / 2;
  if (qrBuffer) {
    doc.image(qrBuffer, qrX, cursor, { fit: [qrSize, qrSize] });
  } else {
    doc.save();
    doc.rect(qrX, cursor, qrSize, qrSize).dash(3, { space: 3 }).stroke('#9ca3af');
    doc.undash();
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text('QR no disponible', qrX, cursor + qrSize / 2 - 6, {
      width: qrSize,
      align: 'center'
    });
    doc.restore();
  }

  cursor += qrSize + 10;
  doc.font('Helvetica').fontSize(8).fillColor('#111827');
  doc.text(`Número: ${factura?.nro_factura || '-'}`, x, cursor, { width });
  cursor += 12;
  doc.text(`Timbrado: ${factura?.timbrado || 'No informado'}`, x, cursor, { width });
  cursor += 12;
  doc.text(`Código seguridad: ${factura?.id || '-'}`, x, cursor, { width });
  cursor += 12;
  doc.text('Consulta: https://ekuatia.set.gov.py/consultas', x, cursor, { width });
  return cursor + 14;
}

function formatCurrencyPrintable(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: 'PYG',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(number);
}

function formatNumberPrintable(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-PY', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(number);
}

function formatDatePrintable(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function buildFacturaXml(venta, factura) {
  const totals = computeInvoiceTotals(venta);
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];

  const lines = detalles
    .map((detalle, index) => {
      const producto = detalle.producto || {};
      const cantidad = Number(detalle.cantidad) || 0;
      const precio = Number(detalle.precio_unitario) || 0;
      const subtotal = Number(detalle.subtotal) || cantidad * precio;
      return `    <detalle numero="${index + 1}">
      <producto>${escapeXml(producto.nombre || 'Producto')}</producto>
      <sku>${escapeXml(producto.sku || '')}</sku>
      <cantidad>${cantidad}</cantidad>
      <precio_unitario>${precio.toFixed(2)}</precio_unitario>
      <subtotal>${subtotal.toFixed(2)}</subtotal>
    </detalle>`;
    })
    .join('\n');

  const cliente = venta?.cliente || {};
  const fechaIso = new Date(factura.fecha_emision || venta.created_at || new Date()).toISOString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<factura>
  <cabecera>
    <numero>${escapeXml(factura.nro_factura || '')}</numero>
    <fecha_emision>${fechaIso}</fecha_emision>
    <estado>${escapeXml(factura.estado || '')}</estado>
    <ruc_emisor>${escapeXml(EMPRESA_INFO.ruc)}</ruc_emisor>
    <nombre_emisor>${escapeXml(EMPRESA_INFO.nombre)}</nombre_emisor>
    <cliente>
      <nombre>${escapeXml(cliente.nombre_razon_social || 'Cliente eventual')}</nombre>
      <ruc>${escapeXml(cliente.ruc || 'S/D')}</ruc>
      <telefono>${escapeXml(cliente.telefono || '')}</telefono>
      <correo>${escapeXml(cliente.correo || '')}</correo>
    </cliente>
  </cabecera>
  <detalles>
${lines}
  </detalles>
  <totales>
    <subtotal>${totals.subtotal.toFixed(2)}</subtotal>
    <descuento>${totals.descuento.toFixed(2)}</descuento>
    <iva porcentaje="${venta?.iva_porcentaje || 10}">${totals.iva.toFixed(2)}</iva>
    <total>${totals.total.toFixed(2)}</total>
  </totales>
</factura>
`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
