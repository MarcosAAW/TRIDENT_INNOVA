const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const validate = require('../middleware/validate');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');
const empresaConfig = require('../config/empresa');
const { applyProductoStockDelta } = require('../utils/productStock');

const router = express.Router();

const REPORT_LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logotridentgrande.png');
const EMPRESA_INFO = {
  nombre: empresaConfig?.nombre || 'TRIDENT INNOVA E.A.S',
  ruc: empresaConfig?.ruc || '0000000-0',
  direccion: empresaConfig?.direccion || '',
  telefono: empresaConfig?.telefono || '',
  email: empresaConfig?.email || '',
  firmante: empresaConfig?.firmante || 'Responsable',
  cargoFirmante: empresaConfig?.cargo_firmante || 'Responsable',
  firmaPath: empresaConfig?.firma_path || ''
};

const ALLOWED_ESTADOS = new Set(['BORRADOR', 'EMITIDA', 'RECIBIDA', 'COMPRADA', 'ANULADA']);
const ALLOWED_TIPOS = new Set(['GENERAL', 'REPUESTOS']);
const COMPRA_ESTADO_GENERADA = 'GENERADA_DESDE_NOTA';
const COMPRA_ESTADO_STOCK_INGRESADO = 'STOCK_INGRESADO';

const detalleSchema = z.object({
  productoId: z.string().uuid().optional(),
  codigo_articulo: z.string().trim().min(1).max(120).optional(),
  descripcion: z.string().trim().min(1).max(300).optional(),
  cantidad: z.coerce.number().int().min(1),
  equipo_destino: z.string().trim().max(120).optional(),
  observacion: z.string().trim().max(300).optional()
}).superRefine((value, ctx) => {
  if (!value.productoId && !value.codigo_articulo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['codigo_articulo'], message: 'Indica el código del artículo.' });
  }
  if (!value.productoId && !value.descripcion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['descripcion'], message: 'Indica la descripción del artículo.' });
  }
});

const createNotaPedidoSchema = z.object({
  proveedorId: z.string().uuid('Proveedor inválido'),
  fecha: z.coerce.date().optional(),
  estado: z.string().trim().default('BORRADOR')
    .transform((value) => value.toUpperCase())
    .refine((value) => ALLOWED_ESTADOS.has(value), { message: 'Estado inválido.' }),
  tipo: z.string().trim().default('GENERAL')
    .transform((value) => value.toUpperCase())
    .refine((value) => ALLOWED_TIPOS.has(value), { message: 'Tipo inválido.' }),
  equipo_destino: z.string().trim().max(120).optional(),
  observaciones: z.string().trim().max(1000).optional(),
  detalles: z.array(detalleSchema).min(1, 'Agrega al menos un ítem')
});

const updateNotaPedidoSchema = createNotaPedidoSchema.partial().extend({
  proveedorId: z.string().uuid('Proveedor inválido').optional(),
  detalles: z.array(detalleSchema).min(1, 'Agrega al menos un ítem').optional()
});

const updateEstadoSchema = z.object({
  estado: z.string().trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => ALLOWED_ESTADOS.has(value), { message: 'Estado inválido.' })
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  search: z.string().trim().min(1).optional(),
  estado: z.string().trim().optional(),
  tipo: z.string().trim().optional(),
  include_deleted: z.coerce.boolean().optional()
}).partial();

router.use(requireAuth, requireSucursal);

function buildWhere(filters, sucursalId) {
  const where = { sucursalId };

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.estado) {
    where.estado = String(filters.estado).trim().toUpperCase();
  }

  if (filters.tipo) {
    where.tipo = String(filters.tipo).trim().toUpperCase();
  }

  if (filters.search) {
    const search = filters.search;
    where.OR = [
      { numero: { contains: search, mode: 'insensitive' } },
      { proveedor: { is: { nombre_razon_social: { contains: search, mode: 'insensitive' } } } },
      { equipo_destino: { contains: search, mode: 'insensitive' } },
      { detalles: { some: {
        OR: [
          { codigo_articulo: { contains: search, mode: 'insensitive' } },
          { codigo_dji: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
          { descripcion: { contains: search, mode: 'insensitive' } },
          { equipo_destino: { contains: search, mode: 'insensitive' } }
        ]
      } } }
    ];
  }

  return where;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('es-PY');
}

function drawTextRow(doc, label, value, x, y, labelWidth, valueWidth, options = {}) {
  const resolvedValue = value || '-';
  doc.font('Helvetica-Bold').fontSize(options.labelSize || 10).fillColor('#0f172a').text(label, x, y, { width: labelWidth });
  doc.font('Helvetica').fontSize(options.valueSize || 10).fillColor('#0f172a').text(resolvedValue, x + labelWidth, y, { width: valueWidth });
}

function drawNotaPedidoPdf(doc, notaPedido) {
  const data = serialize(notaPedido);
  const detalles = Array.isArray(data.detalles) ? data.detalles : [];
  const provider = data.proveedor || {};
  const usuario = data.usuario || {};
  const sucursal = data.sucursal || {};
  const hasDestinoColumn = data.tipo === 'REPUESTOS' || detalles.some((item) => item.equipo_destino);
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rightColumnX = startX + 330;
  const title = data.tipo === 'REPUESTOS' ? 'PEDIDO DE REPUESTOS' : 'NOTA DE PEDIDO';
  const companyAddress = sucursal.direccion || EMPRESA_INFO.direccion || '-';
  const companyPhone = sucursal.telefono || EMPRESA_INFO.telefono || '-';
  const destinationLabel = data.equipo_destino || (data.tipo === 'REPUESTOS' ? 'Definir por ítem' : '-');
  const signaturePath = EMPRESA_INFO.firmaPath;
  const hasSignatureImage = signaturePath && fs.existsSync(signaturePath);

  doc.font('Helvetica');

  if (fs.existsSync(REPORT_LOGO_PATH)) {
    try {
      doc.image(REPORT_LOGO_PATH, startX, 34, { fit: [78, 78] });
    } catch (err) {
      console.warn('[NotaPedido] No se pudo incrustar el logo', err);
    }
  }

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text(title, startX + 250, 58, { width: usableWidth - 250, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Fecha: ${formatDate(data.fecha)}`, startX + 250, 88, { width: usableWidth - 250, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Número: ${data.numero || '-'}`, startX + 250, 104, { width: usableWidth - 250, align: 'right' });

  doc.moveTo(startX, 122).lineTo(startX + usableWidth, 122).strokeColor('#d1d5db').stroke();

  const infoY = 142;
  drawTextRow(doc, 'Comprador: ', EMPRESA_INFO.nombre, startX, infoY, 80, 235);
  drawTextRow(doc, 'Departamento: ', sucursal.ciudad || sucursal.nombre || '-', startX, infoY + 20, 80, 235);
  drawTextRow(doc, 'Sucursal: ', sucursal.nombre || '-', startX, infoY + 40, 80, 235);
  drawTextRow(doc, 'Dirección: ', companyAddress, startX, infoY + 60, 80, 235);
  drawTextRow(doc, 'Teléfono: ', companyPhone, startX, infoY + 80, 80, 235);

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Proveedor', rightColumnX, infoY, { width: 190 });
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(provider.nombre_razon_social || '-', rightColumnX, infoY + 16, { width: 190 });
  drawTextRow(doc, 'RUC: ', provider.ruc || '-', rightColumnX, infoY + 36, 52, 138);
  drawTextRow(doc, 'Contacto: ', provider.contacto || provider.telefono || '-', rightColumnX, infoY + 54, 52, 138);
  drawTextRow(doc, 'Solicita: ', usuario.nombre || '-', rightColumnX, infoY + 72, 52, 138);
  drawTextRow(doc, 'Destino: ', destinationLabel, rightColumnX, infoY + 90, 52, 138);

  doc.roundedRect(startX, infoY + 120, usableWidth, 28, 4).fill('#f3f4f6');
  drawTextRow(doc, 'Tipo: ', data.tipo || '-', startX + 10, infoY + 128, 42, 100, { labelSize: 9, valueSize: 9 });
  drawTextRow(doc, 'Estado: ', data.estado || '-', startX + 150, infoY + 128, 52, 90, { labelSize: 9, valueSize: 9 });
  drawTextRow(doc, 'Proveedor RUC: ', provider.ruc || '-', startX + 280, infoY + 128, 82, 170, { labelSize: 9, valueSize: 9 });

  let tableY = infoY + 166;
  const tableWidth = usableWidth;
  const columns = hasDestinoColumn
    ? [0.22, 0.42, 0.12, 0.24]
    : [0.26, 0.56, 0.18];
  const headers = hasDestinoColumn
    ? ['Código', 'Artículo', 'Cantidad', 'Equipo destino']
    : ['Código', 'Artículo', 'Cantidad'];
  const widths = columns.map((ratio) => Math.floor(tableWidth * ratio));
  widths[widths.length - 1] = tableWidth - widths.slice(0, -1).reduce((acc, value) => acc + value, 0);

  drawTableRow(doc, headers, widths, startX, tableY, true);
  tableY += 26;

  detalles.forEach((detalle, index) => {
    const values = hasDestinoColumn
      ? [detalle.codigo_articulo || '-', detalle.descripcion || '-', String(detalle.cantidad || 0), detalle.equipo_destino || data.equipo_destino || '-']
      : [detalle.codigo_articulo || '-', detalle.descripcion || '-', String(detalle.cantidad || 0)];
    drawTableRow(doc, values, widths, startX, tableY, false, index);
    tableY += 24;
    if (detalle.observacion) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#4b5563').text(`Obs.: ${detalle.observacion}`, startX + 6, tableY, { width: usableWidth - 12 });
      tableY += 14;
    }
  });

  tableY += 14;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Observaciones', startX, tableY, { width: usableWidth });
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(data.observaciones || '-', startX, tableY + 16, { width: usableWidth });

  const footerY = doc.page.height - 155;
  if (hasSignatureImage) {
    try {
      doc.image(signaturePath, startX + usableWidth - 180, footerY - 44, { fit: [150, 36], align: 'center' });
    } catch (err) {
      console.warn('[NotaPedido] No se pudo incrustar la firma', err);
    }
  }
  doc.moveTo(startX + usableWidth - 210, footerY).lineTo(startX + usableWidth, footerY).strokeColor('#111827').stroke();
  doc.font('Helvetica').fontSize(9).fillColor('#111827').text(EMPRESA_INFO.firmante, startX + usableWidth - 220, footerY + 8, { width: 220, align: 'center', lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#111827').text(EMPRESA_INFO.cargoFirmante, startX + usableWidth - 220, footerY + 24, { width: 220, align: 'center', lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text(EMPRESA_INFO.nombre, startX + usableWidth - 220, footerY + 40, { width: 220, align: 'center', lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor('#4b5563').text('Documento interno generado por el sistema.', startX, footerY + 70, { width: usableWidth, align: 'center', lineBreak: false });
}

function drawTableRow(doc, values, widths, x, y, header = false, index = 0) {
  const bg = header ? '#e5e7eb' : index % 2 === 0 ? '#ffffff' : '#f9fafb';
  const rowHeight = 22;
  const totalWidth = widths.reduce((acc, value) => acc + value, 0);
  doc.save();
  doc.rect(x, y, totalWidth, rowHeight).fill(bg);
  doc.restore();
  doc.rect(x, y, totalWidth, rowHeight).strokeColor('#9ca3af').lineWidth(0.5).stroke();

  let cursorX = x;
  values.forEach((value, idx) => {
    if (idx > 0) {
      doc.moveTo(cursorX, y).lineTo(cursorX, y + rowHeight).strokeColor('#9ca3af').lineWidth(0.5).stroke();
    }
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#111827').text(String(value || ''), cursorX + 6, y + 6, {
      width: widths[idx] - 12,
      align: idx === 2 ? 'right' : 'left'
    });
    cursorX += widths[idx];
  });
}

function parseNotaNumero(value) {
  const match = String(value || '').match(/^NP-([0-9]+)$/i);
  if (!match) return null;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function generateNumero(tx, sucursalId) {
  const prefix = 'NP-';
  const last = await tx.notaPedido.findFirst({
    where: { sucursalId },
    select: { numero: true },
    orderBy: { created_at: 'desc' }
  });

  const lastNumber = parseNotaNumero(last?.numero);
  const nextNumber = String((lastNumber || 0) + 1).padStart(6, '0');
  return `${prefix}${nextNumber}`;
}

async function buildDetalles(detalles = []) {
  const productIds = [...new Set(detalles.map((item) => item.productoId).filter(Boolean))];
  const productos = productIds.length
    ? await prisma.producto.findMany({ where: { id: { in: productIds }, deleted_at: null } })
    : [];
  const productosMap = new Map(productos.map((producto) => [producto.id, producto]));

  return detalles.map((item) => {
    const producto = item.productoId ? productosMap.get(item.productoId) : null;
    if (item.productoId && !producto) {
      throw new Error('Uno de los productos seleccionados ya no existe o está eliminado.');
    }

    if (producto) {
      const codigoArticulo = producto.codigo_dji || producto.sku;
      return {
        productoId: producto.id,
        codigo_articulo: codigoArticulo,
        codigo_dji: producto.codigo_dji || null,
        sku: producto.sku || null,
        descripcion: producto.nombre,
        cantidad: item.cantidad,
        equipo_destino: item.equipo_destino ? item.equipo_destino.trim() : null,
        observacion: item.observacion ? item.observacion.trim() : null
      };
    }

    return {
      productoId: null,
      codigo_articulo: item.codigo_articulo.trim(),
      codigo_dji: null,
      sku: null,
      descripcion: item.descripcion.trim(),
      cantidad: item.cantidad,
      equipo_destino: item.equipo_destino ? item.equipo_destino.trim() : null,
      observacion: item.observacion ? item.observacion.trim() : null
    };
  });
}

async function buildNotaPedidoData(payload, req, { keepNumero } = {}) {
  const proveedor = await prisma.proveedor.findUnique({ where: { id: payload.proveedorId } });
  if (!proveedor || proveedor.deleted_at) {
    throw new Error('El proveedor indicado no existe o está eliminado.');
  }

  const data = {
    proveedorId: payload.proveedorId,
    usuarioId: req.usuarioActual.id,
    sucursalId: req.sucursalId,
    fecha: payload.fecha || undefined,
    estado: payload.estado,
    tipo: payload.tipo,
    equipo_destino: payload.equipo_destino ? payload.equipo_destino.trim() : null,
    observaciones: payload.observaciones ? payload.observaciones.trim() : null
  };

  if (keepNumero) {
    data.numero = keepNumero;
  }

  return data;
}

function validateWorkflowEstado(estado, { hasCompra = false, allowAnulada = true } = {}) {
  const normalized = String(estado || '').toUpperCase();
  if (normalized === 'COMPRADA' && !hasCompra) {
    throw new Error('La nota no puede quedar en estado comprada sin una compra generada.');
  }
  if (!allowAnulada && normalized === 'ANULADA') {
    throw new Error('La anulación debe realizarse desde la acción de eliminar.');
  }
}

function resolvePrecioCompra(producto) {
  const precioCompra = Number(producto?.precio_compra);
  if (Number.isFinite(precioCompra) && precioCompra > 0) {
    return Number(precioCompra.toFixed(2));
  }

  const original = Number(producto?.precio_compra_original);
  const tipoCambio = Number(producto?.tipo_cambio_precio_compra);
  if (Number.isFinite(original) && original > 0) {
    if ((producto?.moneda_precio_compra || '').toUpperCase() === 'USD' && Number.isFinite(tipoCambio) && tipoCambio > 0) {
      return Number((original * tipoCambio).toFixed(2));
    }
    return Number(original.toFixed(2));
  }

  const fallback = Number(producto?.precio_venta);
  if (Number.isFinite(fallback) && fallback > 0) {
    return Number(fallback.toFixed(2));
  }

  return 0;
}

function hasStockIngresado(compra) {
  return String(compra?.estado || '').toUpperCase() === COMPRA_ESTADO_STOCK_INGRESADO;
}

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const { page = 1, pageSize = 20, ...filters } = parsed.data;
  const where = buildWhere(filters, req.sucursalId);

  try {
    const [notas, total] = await Promise.all([
      prisma.notaPedido.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'desc' },
        include: {
          proveedor: { select: { id: true, nombre_razon_social: true, ruc: true } },
          usuario: { select: { id: true, nombre: true } },
          compra: { select: { id: true, estado: true, total: true, fecha: true } },
          detalles: {
            select: {
              id: true,
              productoId: true,
              cantidad: true,
              codigo_articulo: true,
              descripcion: true,
              equipo_destino: true,
              observacion: true
            }
          }
        }
      }),
      prisma.notaPedido.count({ where })
    ]);

    return res.json({
      data: serialize(notas),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al listar notas de pedido' });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const notaPedido = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId, deleted_at: null },
      include: {
        proveedor: true,
        usuario: { select: { id: true, nombre: true } },
        sucursal: { select: { id: true, nombre: true, direccion: true, telefono: true } },
        compra: { select: { id: true, estado: true, total: true, fecha: true } },
        detalles: { orderBy: { created_at: 'asc' } }
      }
    });

    if (!notaPedido) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    const fileName = `nota-pedido-${String(notaPedido.numero || req.params.id).toLowerCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);

    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    doc.pipe(res);
    drawNotaPedidoPdf(doc, notaPedido);
    doc.end();
  } catch (err) {
    console.error('[NotaPedido] No se pudo generar el PDF', err);
    return res.status(500).json({ error: 'No se pudo generar el PDF de la nota de pedido.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const notaPedido = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId },
      include: {
        proveedor: true,
        usuario: { select: { id: true, nombre: true } },
        sucursal: { select: { id: true, nombre: true } },
        compra: { select: { id: true, estado: true, total: true, fecha: true } },
        detalles: { orderBy: { created_at: 'asc' } }
      }
    });

    if (!notaPedido || notaPedido.deleted_at) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    return res.json(serialize(notaPedido));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al obtener nota de pedido' });
  }
});

router.post('/', authorizeRoles('ADMIN', 'VENDEDOR'), validate(createNotaPedidoSchema), async (req, res) => {
  try {
    validateWorkflowEstado(req.validatedBody.estado, { hasCompra: false, allowAnulada: false });
    const detalles = await buildDetalles(req.validatedBody.detalles);
    const notaPedido = await prisma.$transaction(async (tx) => {
      const numero = await generateNumero(tx, req.sucursalId);
      const data = await buildNotaPedidoData(req.validatedBody, req, {});

      return tx.notaPedido.create({
        data: {
          ...data,
          numero,
          detalles: {
            create: detalles
          }
        },
        include: {
          proveedor: true,
          usuario: { select: { id: true, nombre: true } },
          sucursal: { select: { id: true, nombre: true } },
          compra: { select: { id: true, estado: true, total: true, fecha: true } },
          detalles: { orderBy: { created_at: 'asc' } }
        }
      });
    });

    return res.status(201).json(serialize(notaPedido));
  } catch (err) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe una nota de pedido con ese número.' });
    }
    console.error(err);
    return res.status(400).json({ error: err.message || 'Error al crear la nota de pedido' });
  }
});

router.put('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), validate(updateNotaPedidoSchema), async (req, res) => {
  try {
    const existing = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId, deleted_at: null },
      include: { detalles: true, compra: true }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    if (hasStockIngresado(existing.compra)) {
      return res.status(400).json({ error: 'No se puede editar una nota cuyo stock ya fue ingresado.' });
    }

    const incoming = {
      proveedorId: req.validatedBody.proveedorId || existing.proveedorId,
      fecha: req.validatedBody.fecha || existing.fecha,
      estado: req.validatedBody.estado || existing.estado,
      tipo: req.validatedBody.tipo || existing.tipo,
      equipo_destino: req.validatedBody.equipo_destino !== undefined ? req.validatedBody.equipo_destino : existing.equipo_destino,
      observaciones: req.validatedBody.observaciones !== undefined ? req.validatedBody.observaciones : existing.observaciones,
      detalles: req.validatedBody.detalles || existing.detalles
    };

    validateWorkflowEstado(incoming.estado, { hasCompra: Boolean(existing.compra), allowAnulada: false });
    if (existing.compra && String(incoming.estado || '').toUpperCase() !== 'COMPRADA') {
      throw new Error('Una nota con compra generada debe permanecer en estado comprada.');
    }

    const detalles = await buildDetalles(incoming.detalles);
    const notaPedido = await prisma.$transaction(async (tx) => {
      const data = await buildNotaPedidoData(incoming, req, { keepNumero: existing.numero });
      await tx.detalleNotaPedido.deleteMany({ where: { notaPedidoId: existing.id } });

      return tx.notaPedido.update({
        where: { id: existing.id },
        data: {
          ...data,
          detalles: { create: detalles }
        },
        include: {
          proveedor: true,
          usuario: { select: { id: true, nombre: true } },
          sucursal: { select: { id: true, nombre: true } },
          compra: { select: { id: true, estado: true, total: true, fecha: true } },
          detalles: { orderBy: { created_at: 'asc' } }
        }
      });
    });

    return res.json(serialize(notaPedido));
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'Error al actualizar la nota de pedido' });
  }
});

router.put('/:id/estado', authorizeRoles('ADMIN', 'VENDEDOR'), validate(updateEstadoSchema), async (req, res) => {
  try {
    const existing = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId, deleted_at: null },
      include: { compra: true }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    const nextEstado = req.validatedBody.estado;
    if (nextEstado === 'COMPRADA' && !existing.compra) {
      return res.status(400).json({ error: 'La nota solo puede pasar a comprada cuando ya tenga una compra generada.' });
    }

    if (nextEstado === 'ANULADA') {
      return res.status(400).json({ error: 'Usa la acción de anular para eliminar la nota.' });
    }

    if (existing.compra && nextEstado !== 'COMPRADA') {
      return res.status(400).json({ error: 'Una nota con compra generada no puede volver a un estado anterior.' });
    }

    const updated = await prisma.notaPedido.update({
      where: { id: existing.id },
      data: { estado: nextEstado }
    });

    return res.json(serialize(updated));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al actualizar el estado de la nota de pedido' });
  }
});

router.post('/:id/convertir-compra', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  try {
    const notaPedido = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId, deleted_at: null },
      include: {
        compra: true,
        detalles: { orderBy: { created_at: 'asc' } },
        proveedor: true
      }
    });

    if (!notaPedido) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    if (notaPedido.compra) {
      return res.status(409).json({ error: 'Esta nota de pedido ya fue convertida en compra.' });
    }

    if (String(notaPedido.estado || '').toUpperCase() === 'ANULADA') {
      return res.status(400).json({ error: 'No se puede convertir a compra una nota anulada.' });
    }

    if (String(notaPedido.estado || '').toUpperCase() !== 'RECIBIDA') {
      return res.status(400).json({ error: 'La nota debe estar en estado recibida antes de generar la compra.' });
    }

    if (!notaPedido.detalles.length) {
      return res.status(400).json({ error: 'La nota de pedido no tiene ítems para convertir.' });
    }

    const invalidLines = notaPedido.detalles.filter((item) => !item.productoId);
    if (invalidLines.length) {
      return res.status(400).json({ error: 'No se puede convertir a compra una nota con ítems manuales sin producto vinculado.' });
    }

    const productos = await prisma.producto.findMany({
      where: {
        id: { in: notaPedido.detalles.map((item) => item.productoId).filter(Boolean) },
        deleted_at: null
      }
    });
    const productosMap = new Map(productos.map((producto) => [producto.id, producto]));

    let subtotal = 0;
    const detalleCompraData = notaPedido.detalles.map((item) => {
      const producto = productosMap.get(item.productoId);
      if (!producto) {
        throw new Error('Uno de los productos de la nota ya no existe o fue eliminado.');
      }
      const precioUnitario = resolvePrecioCompra(producto);
      subtotal += precioUnitario * Number(item.cantidad || 0);
      return {
        productoId: producto.id,
        cantidad: Number(item.cantidad || 0),
        precio_unitario: Number(precioUnitario.toFixed(2))
      };
    });

    const compra = await prisma.$transaction(async (tx) => {
      const created = await tx.compra.create({
        data: {
          proveedorId: notaPedido.proveedorId,
          notaPedidoId: notaPedido.id,
          fecha: new Date(),
          subtotal: Number(subtotal.toFixed(2)),
          total: Number(subtotal.toFixed(2)),
          estado: COMPRA_ESTADO_GENERADA,
          detalles: {
            create: detalleCompraData
          }
        },
        include: {
          proveedor: { select: { id: true, nombre_razon_social: true } },
          detalles: true,
          notaPedido: { select: { id: true, numero: true } }
        }
      });

      await tx.notaPedido.update({
        where: { id: notaPedido.id },
        data: { estado: 'COMPRADA' }
      });

      return created;
    });

    return res.status(201).json(serialize(compra));
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'No se pudo convertir la nota de pedido en compra.' });
  }
});

router.post('/:id/agregar-stock', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  try {
    const notaPedido = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId, deleted_at: null },
      include: {
        compra: {
          include: {
            detalles: true
          }
        }
      }
    });

    if (!notaPedido) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    if (!notaPedido.compra) {
      return res.status(400).json({ error: 'Primero debes generar la compra antes de ingresar stock.' });
    }

    if (String(notaPedido.estado || '').toUpperCase() !== 'COMPRADA') {
      return res.status(400).json({ error: 'Solo se puede ingresar stock para notas en estado comprada.' });
    }

    if (hasStockIngresado(notaPedido.compra)) {
      return res.status(409).json({ error: 'El stock de esta compra ya fue ingresado.' });
    }

    const detalles = Array.isArray(notaPedido.compra.detalles) ? notaPedido.compra.detalles : [];
    if (!detalles.length) {
      return res.status(400).json({ error: 'La compra no tiene ítems para ingresar al stock.' });
    }

    const compraActualizada = await prisma.$transaction(async (tx) => {
      for (const detalle of detalles) {
        const cantidad = Number(detalle.cantidad || 0);
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          continue;
        }

        const producto = await tx.producto.findUnique({ where: { id: detalle.productoId } });
        if (!producto) {
          throw new Error('Uno de los productos de la compra ya no existe o fue eliminado.');
        }

        await applyProductoStockDelta(tx, producto, req.sucursalId, cantidad);

        await tx.movimientoStock.create({
          data: {
            productoId: detalle.productoId,
            tipo: 'ENTRADA',
            cantidad,
            motivo: `Ingreso por compra ${notaPedido.numero || notaPedido.id}`,
            referencia_id: notaPedido.compra.id,
            referencia_tipo: 'Compra',
            usuario_id: req.usuarioActual.id
          }
        });
      }

      return tx.compra.update({
        where: { id: notaPedido.compra.id },
        data: { estado: COMPRA_ESTADO_STOCK_INGRESADO },
        include: {
          proveedor: { select: { id: true, nombre_razon_social: true } },
          detalles: true,
          notaPedido: { select: { id: true, numero: true } }
        }
      });
    });

    return res.json(serialize(compraActualizada));
  } catch (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'No se pudo ingresar el stock de la compra.' });
  }
});

router.delete('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  try {
    const existing = await prisma.notaPedido.findFirst({
      where: { id: req.params.id, sucursalId: req.sucursalId },
      include: { compra: true }
    });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Nota de pedido no encontrada en esta sucursal' });
    }

    if (existing.compra) {
      return res.status(400).json({ error: 'No se puede anular una nota que ya tiene una compra generada.' });
    }

    const deleted = await prisma.notaPedido.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date(), estado: 'ANULADA' }
    });

    return res.json({ ok: true, notaPedido: serialize(deleted) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al eliminar la nota de pedido' });
  }
});

module.exports = router;