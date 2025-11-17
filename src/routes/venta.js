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

const createVentaSchema = z.object({
  usuarioId: z.string().uuid(),
  clienteId: z.string().uuid().optional(),
  detalles: z.array(detalleSchema).min(1),
  descuento_total: z.coerce.number().min(0).optional(),
  estado: z.string().optional(),
  motivo: z.string().optional(),
  almacenId: z.string().uuid().optional(),
  iva_porcentaje: ivaSchema
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
  include_deleted: z.coerce.boolean().optional()
});

const ventaIdParams = z.object({
  id: z.string().uuid({ message: 'Identificador inválido' })
});

const cancelVentaSchema = z.object({
  motivo: z.string().trim().min(3).max(200).optional()
});

const EMPRESA_INFO = {
  nombre: 'TRIDENT INNOVA E.A.S',
  ruc: '80132959-0',
  direccion: 'Ruta 01, Casi Mcal. López. San Ignacio-Misiones',
  telefono: '+595 983 784444',
  email: 'info@tridentinnova.com'
};

function startOfDay(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  date.setHours(23, 59, 59, 999);
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
        detalles: {
          include: {
            producto: true
          }
        }
      },
      orderBy: { fecha: 'desc' }
    });

    const data = serialize(ventas);
    res.json({
      data,
      meta: {
        page: 1,
        pageSize: data.length,
        total: data.length,
        totalPages: 1
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

      const venta = await tx.venta.create({
        data: {
          usuarioId: payload.usuarioId,
          clienteId: payload.clienteId || null,
          subtotal: subtotalAcumulado,
          descuento_total: descuentoTotal,
          impuesto_total: impuestoTotal,
          total,
          estado: payload.estado || 'PENDIENTE',
          moneda: 'PYG',
          tipo_cambio: null,
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

router.post('/:id/facturar', async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador de venta inválido.' });
  }

  const { id } = parsedParams.data;

  try {
    const { venta, factura } = await prisma.$transaction(async (tx) => {
      const ventaActual = await tx.venta.findUnique({
        where: { id },
        include: {
          cliente: true,
          usuario: true,
          detalles: { include: { producto: true } },
          factura_electronica: true
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
          factura_electronica: true
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

    res.json({ venta: serialize(venta), factura: serialize(facturaActualizada) });
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar la factura electrónica.' });
  }
});

router.post('/:id/anular', async (req, res) => {
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
          }
        }
      });

      return updated;
    });

    res.json(serialize(result));
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo anular la venta.' });
  }
});

module.exports = router;

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
