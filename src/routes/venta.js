const express = require('express');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { procesarFacturaElectronica } = require('../services/sifen/facturaProcessor');
const empresaConfig = require('../config/empresa');
const { generarFacturaDigital, FacturaDigitalError, validateTimbradoConfig } = require('../services/facturaDigital');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  DestinatarioInvalidoError,
  isEmailEnabled
} = require('../services/email/facturaDigitalMailer');

const MONEDAS_PERMITIDAS = new Set(['PYG', 'USD']);

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

const createVentaSchema = z.object({
  usuarioId: z.string().uuid(),
  clienteId: z.string().uuid().optional(),
  detalles: z.array(detalleSchema).min(1),
  descuento_total: z.coerce.number().min(0).optional(),
  estado: z.string().optional(),
  motivo: z.string().optional(),
  almacenId: z.string().uuid().optional(),
  iva_porcentaje: ivaSchema,
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
    .optional()
});

class VentaValidationError extends Error {}

const MAX_DECIMAL_VALUE = 10_000_000_000;
const IVA_DIVISOR = {
  5: 21,
  10: 11
};

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

function buildVentaWhere(filters) {
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

router.use(requireAuth);

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const filters = parsed.data || {};
  const where = buildVentaWhere(filters);

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
      const productos = await tx.producto.findMany({ where: { id: { in: productoIds } } });
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

      let descuentoTotal = Number(payload.descuento_total ?? 0);
      if (!Number.isFinite(descuentoTotal) || descuentoTotal < 0) {
        descuentoTotal = 0;
      }
      descuentoTotal = round(descuentoTotal, 2);
      ensureWithinLimit(descuentoTotal, 'Descuento total');

      if (descuentoTotal > subtotalAcumulado) {
        throw new VentaValidationError('El descuento no puede superar el subtotal.');
      }

      const baseGravada = round(subtotalAcumulado - descuentoTotal, 2);
      ensureWithinLimit(baseGravada, 'Total');

      const divisor = IVA_DIVISOR[ivaPorcentaje] || IVA_DIVISOR[10];
      const impuestoTotal = baseGravada > 0 ? round(baseGravada / divisor, 2) : 0;
      ensureWithinLimit(impuestoTotal, 'Impuesto total');

      const total = baseGravada;
      const monedaSeleccionada = normalizeCurrency(payload.moneda);
      let tipoCambioSeleccionado = null;
      if (monedaSeleccionada === 'USD') {
        const parsedTipoCambio = Number(payload.tipo_cambio);
        if (!Number.isFinite(parsedTipoCambio) || parsedTipoCambio <= 0) {
          throw new VentaValidationError('Ingresá un tipo de cambio válido para ventas en USD.');
        }
        tipoCambioSeleccionado = round(parsedTipoCambio, 4);
      }

      let totalEnMonedaSeleccionada = null;
      if (tipoCambioSeleccionado) {
        if (total === 0) {
          totalEnMonedaSeleccionada = 0;
        } else {
          totalEnMonedaSeleccionada = round(total / tipoCambioSeleccionado, 2);
        }
        ensureWithinLimit(totalEnMonedaSeleccionada, 'Total en moneda seleccionada');
      }

      const venta = await tx.venta.create({
        data: {
          usuarioId: payload.usuarioId,
          clienteId: payload.clienteId || null,
          subtotal: subtotalAcumulado,
          descuento_total: descuentoTotal,
          impuesto_total: impuestoTotal,
          total,
          estado: payload.estado || 'PENDIENTE',
          moneda: monedaSeleccionada,
          tipo_cambio: tipoCambioSeleccionado,
          total_moneda: totalEnMonedaSeleccionada,
          iva_porcentaje: ivaPorcentaje
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

      const full = await tx.venta.findUnique({
        where: { id: venta.id },
        include: {
          detalles: {
            include: {
              producto: true
            }
          },
          cliente: true,
          usuario: true
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
    const { venta, factura } = await prisma.$transaction(async (tx) => {
      const ventaActual = await tx.venta.findUnique({
        where: { id },
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

      if (ventaActual.deleted_at || (ventaActual.estado && ventaActual.estado.toUpperCase() === 'ANULADA')) {
        throw new VentaValidationError('No es posible generar una factura para una venta anulada.');
      }

      if (!Array.isArray(ventaActual.detalles) || !ventaActual.detalles.length) {
        throw new VentaValidationError('La venta no tiene detalles para facturar.');
      }

      const now = new Date();
      let facturaActual = ventaActual.factura_electronica;

      if (!facturaActual) {
        const numeroFactura = generarNumeroFactura(ventaActual.id);
        facturaActual = await tx.facturaElectronica.create({
          data: {
            id: randomUUID(),
            ventaId: ventaActual.id,
            nro_factura: numeroFactura,
            timbrado: '12545678-01',
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

      const ventaRefrescada = await tx.venta.findUnique({
        where: { id },
        include: {
          cliente: true,
          usuario: true,
          detalles: { include: { producto: true } },
          factura_electronica: true,
          factura_digital: true
        }
      });

      return { venta: ventaRefrescada, factura: facturaActual };
    });

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

    try {
      const resultadoSifen = await procesarFacturaElectronica(venta);
      if (resultadoSifen?.factura) {
        facturaActualizada = resultadoSifen.factura;
        venta.factura_electronica = facturaActualizada;
      }
    } catch (sifenError) {
      console.error('[SIFEN] Error al procesar el documento electrónico.', sifenError);
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
      const venta = await tx.venta.findUnique({
        where: { id },
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
    const where = buildVentaWhere(filters);
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

router.get('/reporte/margen', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters);
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
  renderReportHeader(doc, 'Reporte diario de ventas', range, startX, usableWidth);
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
  if (totals.totalUsd > 0) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#475569')
      .text(`Equivalente en USD: ${formatCurrencyUsd(totals.totalUsd)}`, startX, doc.y + 4);
    doc.moveDown(0.4);
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
  renderReportHeader(doc, 'Reporte de margen de ventas', range, startX, usableWidth);
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

function renderReportHeader(doc, title, range, startX, usableWidth) {
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
    { key: 'cliente', label: 'Cliente', ratio: 0.21 },
    { key: 'usuario', label: 'Usuario', ratio: 0.09 },
    { key: 'estado', label: 'Estado', ratio: 0.065 },
    { key: 'subtotal', label: 'Subtotal', ratio: 0.14, align: 'right' },
    { key: 'descuento', label: 'Descuento', ratio: 0.085, align: 'right' },
    { key: 'iva', label: 'IVA', ratio: 0.095, align: 'right' },
    { key: 'total', label: 'Total', ratio: 0.11, align: 'right' },
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
    return {
      fecha: formatDateForDisplay(venta.fecha || venta.created_at),
      factura: resolveInvoiceNumberForReport(venta),
      cliente: venta.cliente?.nombre_razon_social || 'Cliente eventual',
      usuario: venta.usuario?.nombre || venta.usuario?.usuario || '—',
      estado: anulada ? 'Anulada' : venta.estado || '—',
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
  return ventas.reduce(
    (acc, venta) => {
      acc.subtotal += Number(venta.subtotal) || 0;
      acc.descuento += Number(venta.descuento_total) || 0;
      acc.impuesto += Number(venta.impuesto_total) || 0;
      acc.total += Number(venta.total ?? venta.subtotal) || 0;
      acc.items += countVentaItems(venta);
      const currency = (venta.moneda || 'PYG').toUpperCase();
      if (currency === 'USD') {
        const usdAmount = Number(venta.total_moneda) || 0;
        if (usdAmount > 0) {
          acc.totalUsd += usdAmount;
        }
      }
      return acc;
    },
    { subtotal: 0, descuento: 0, impuesto: 0, total: 0, items: 0, totalUsd: 0 }
  );
}

function buildMarginReportColumns(usableWidth) {
  const definitions = [
    { key: 'fecha', label: 'Fecha', ratio: 0.12 },
    { key: 'factura', label: 'N° factura', ratio: 0.18 },
    { key: 'cliente', label: 'Cliente', ratio: 0.24 },
    { key: 'total', label: 'Total venta', ratio: 0.15, align: 'right' },
    { key: 'costo', label: 'Costo estimado', ratio: 0.15, align: 'right' },
    { key: 'margen', label: 'Margen', ratio: 0.1, align: 'right' },
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
    return {
      fecha: formatDateForDisplay(venta.fecha || venta.created_at),
      factura: resolveInvoiceNumberForReport(venta),
      cliente: venta.cliente?.nombre_razon_social || 'Cliente eventual',
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

function generarNumeroFactura(ventaId) {
  const cleaned = (ventaId || '').replace(/-/g, '').toUpperCase();
  const correlativo = cleaned.slice(0, 7).padEnd(7, '0');
  return `001-001-${correlativo}`;
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
  const nroFactura = factura?.nro_factura || generarNumeroFactura(venta?.id);
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
  const nroFactura = factura?.nro_factura || generarNumeroFactura(venta?.id);
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
