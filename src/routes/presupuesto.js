
const express = require('express');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const empresaConfig = require('../config/empresa');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');
const { resolveProductSalePricing } = require('../utils/productPricing');
const { getProductoStockMap, resolveProductoStock } = require('../utils/productStock');


router.use(requireAuth, requireSucursal);

// GET /presupuestos/:id - obtener presupuesto por ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Identificador inválido' });

  try {
    const presupuesto = await prisma.presupuesto.findUnique({
      where: { id },
      include: {
        cliente: { select: { id: true, nombre_razon_social: true } },
        usuario: { select: { id: true, nombre: true } },
        sucursal: { select: { id: true, nombre: true } },
        detalles: { include: { producto: true } }
      }
    });

    if (!presupuesto || presupuesto.deleted_at || presupuesto.sucursalId !== req.sucursalId) {
      return res.status(404).json({ error: 'Presupuesto no encontrado en esta sucursal' });
    }

    return res.status(200).json(serialize(presupuesto));
  } catch (err) {
    console.error('[Presupuestos] No se pudo obtener presupuesto', err);
    res.status(500).json({ error: 'Error al obtener presupuesto' });
  }
});

const ALLOWED_CURRENCIES = new Set(['PYG', 'USD']);
const ALLOWED_ESTADOS = ['GENERADO', 'VENCIDO'];
const REPORT_LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logotridentgrande.png');
const EMPRESA_INFO = {
  nombre: empresaConfig?.nombre || 'TRIDENT INNOVA E.A.S',
  ruc: empresaConfig?.ruc || '0000000-0',
  direccion: empresaConfig?.direccion || '',
  telefono: empresaConfig?.telefono || '',
  email: empresaConfig?.email || ''
};

const listQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
    search: z.string().trim().min(1).optional(),
    estado: z.string().trim().optional(),
    include_deleted: z.coerce.boolean().optional()
  })
  .partial();

const detalleSchema = z.object({
  productoId: z.string().uuid().optional(),
  cantidad: z.coerce.number().int().min(1),
  precio_unitario: z.coerce.number().positive().optional(),
  iva_porcentaje: z
    .union([z.literal(0), z.literal(5), z.literal(10), z.literal('0'), z.literal('5'), z.literal('10')])
    .optional()
});

const createPresupuestoSchema = z.object({
  clienteId: z.string().uuid().optional(),
  validez_hasta: z.coerce.date().optional(),
  moneda: z
    .string()
    .trim()
    .default('PYG')
    .transform((value) => value.toUpperCase())
    .refine((value) => ALLOWED_CURRENCIES.has(value), { message: 'Moneda no soportada (usa PYG o USD).' }),
  tipo_cambio: z.coerce.number().positive().optional(),
  descuento_total: z.coerce.number().min(0).optional(),
  notas: z.string().optional(),
  detalles: z.array(detalleSchema).min(1, 'Agrega al menos un ítem')
});

const updateEstadoSchema = z.object({
  estado: z.enum(['GENERADO', 'VENCIDO'])
});

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeIva(raw) {
  const parsed = Number(raw);
  if (parsed === 0 || parsed === 5 || parsed === 10) return parsed;
  return 10;
}

function formatCurrency(value, currency = 'PYG') {
  const num = Number(value || 0);
  const isUsd = currency && currency.toUpperCase() === 'USD';
  return num.toLocaleString('es-PY', {
    style: 'currency',
    currency: isUsd ? 'USD' : 'PYG',
    minimumFractionDigits: isUsd ? 2 : 0,
    maximumFractionDigits: isUsd ? 2 : 0
  });
}

function buildCurrencyView(data) {
  const moneda = String(data.moneda || 'PYG').toUpperCase();
  const tipoCambio = Number(data.tipo_cambio);
  const isUsd = moneda === 'USD' && Number.isFinite(tipoCambio) && tipoCambio > 0;

  if (!isUsd) {
    return {
      moneda: 'PYG',
      tipoCambio: null,
      format: (val) => formatCurrency(val, 'PYG'),
      itemAmounts: (detalle) => ({
        precio: formatCurrency(detalle.precio_unitario, 'PYG'),
        subtotal: formatCurrency(detalle.subtotal, 'PYG')
      }),
      totals: {
        subtotal: formatCurrency(data.subtotal, 'PYG'),
        descuento: data.descuento_total ? formatCurrency(data.descuento_total, 'PYG') : null,
        iva: formatCurrency(data.impuesto_total || 0, 'PYG'),
        total: formatCurrency(data.total, 'PYG'),
        totalMoneda: null,
        totalGs: null
      }
    };
  }

  const toUsd = (val) => (Number.isFinite(Number(val)) ? Number(val) / tipoCambio : 0);

  const subtotalUsd = toUsd(data.subtotal);
  const descuentoUsd = data.descuento_total ? toUsd(data.descuento_total) : null;
  const ivaUsd = toUsd(data.impuesto_total || 0);
  const totalUsd = Number.isFinite(Number(data.total_moneda)) ? Number(data.total_moneda) : toUsd(data.total);

  return {
    moneda: 'USD',
    tipoCambio,
    format: (val) => formatCurrency(val, 'USD'),
    itemAmounts: (detalle) => ({
      precio: formatCurrency(toUsd(detalle.precio_unitario), 'USD'),
      subtotal: formatCurrency(toUsd(detalle.subtotal), 'USD')
    }),
    totals: {
      subtotal: formatCurrency(subtotalUsd, 'USD'),
      descuento: descuentoUsd ? formatCurrency(descuentoUsd, 'USD') : null,
      iva: formatCurrency(ivaUsd, 'USD'),
      total: formatCurrency(totalUsd, 'USD'),
      totalMoneda: null,
      totalGs: formatCurrency(data.total, 'PYG')
    }
  };
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('es-PY');
}

function renderPresupuestoPdf(doc, presupuesto) {
  const data = serialize(presupuesto);
  const cliente = data.cliente || {};
  const sucursal = data.sucursal || {};
  const usuario = data.usuario || {};
  const detalles = Array.isArray(data.detalles) ? data.detalles : [];

  const palette = {
    bg: '#0f172a',
    accent: '#f97316',
    muted: '#cbd5e1',
    text: '#0f172a',
    subtle: '#64748b'
  };

  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const currencyView = buildCurrencyView(data);

  drawHeader(doc, data, palette, startX, usableWidth);
  drawMetaChips(doc, data, palette, startX, usableWidth);
  drawClienteSection(doc, data, cliente, sucursal, usuario, palette, startX, usableWidth);
  drawItemsTable(doc, detalles, palette, startX, usableWidth, currencyView);
  drawTotales(doc, data, palette, startX, usableWidth, currencyView);

  if (data.notas) {
    doc.moveDown(0.8);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(palette.text)
      .text('Notas', startX, doc.y, { width: usableWidth });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(palette.text)
      .text(data.notas, startX, doc.y + 4, { width: usableWidth });
  }

  doc.moveDown(1);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(palette.subtle)
    .text('Documento generado automáticamente por Trident Innova.', startX, doc.y, {
      width: usableWidth,
      align: 'center'
    });
}

function drawHeader(doc, data, palette, startX, usableWidth) {
  const headerHeight = 96;
  const padding = 16;
  const bgY = doc.page.margins.top;

  doc.save();
  doc.roundedRect(startX, bgY, usableWidth, headerHeight, 14).fill(palette.bg);
  doc.restore();

  const hasLogo = fs.existsSync(REPORT_LOGO_PATH);
  const logoSize = 64;
  let cursorX = startX + padding;
  let textWidth = usableWidth - padding * 2;

  if (hasLogo) {
    try {
      doc.image(REPORT_LOGO_PATH, cursorX, bgY + 12, { fit: [logoSize, logoSize], align: 'left' });
      cursorX += logoSize + 12;
      textWidth -= logoSize + 12;
    } catch (logoError) {
      console.warn('[Presupuesto] No se pudo incrustar el logo.', logoError);
    }
  }

  const title = 'Presupuesto';
  const numero = data.numero ? `N.º ${data.numero}` : `ID: ${data.id}`;
  const baseY = bgY + 12;

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(palette.accent)
    .text(title, cursorX, baseY, { width: textWidth * 0.7, align: 'left' });

  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#e2e8f0')
    .text(numero, cursorX + textWidth * 0.35, baseY, { width: textWidth * 0.65, align: 'right' });

  const companyLineY = baseY + 24;
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#e2e8f0')
    .text(`${EMPRESA_INFO.nombre} · RUC ${EMPRESA_INFO.ruc}`, cursorX, companyLineY, {
      width: textWidth,
      align: 'left'
    });

  // Mostrar dirección y teléfono de la sucursal activa si existen, si no EMPRESA_INFO
  const sucursalDireccion = (data.sucursal && data.sucursal.direccion) ? data.sucursal.direccion : null;
  const sucursalTelefono = (data.sucursal && data.sucursal.telefono) ? data.sucursal.telefono : null;
  const direccion = sucursalDireccion || EMPRESA_INFO.direccion;
  const telefono = sucursalTelefono || EMPRESA_INFO.telefono;
  if (direccion || telefono) {
    const lines = [direccion, telefono].filter(Boolean).join(' · ');
    const addressY = companyLineY + 14;
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#e2e8f0')
      .text(lines, cursorX, addressY, { width: textWidth, align: 'left' });
  }

  doc.y = bgY + headerHeight + 12;
}

function drawChip(doc, label, value, palette, x, y) {
  const chipPaddingX = 10;
  const chipPaddingY = 6;
  const text = `${label}: ${value}`;
  const width = doc.widthOfString(text) + chipPaddingX * 2;
  const height = doc.currentLineHeight() + chipPaddingY * 2;

  doc.save();
  doc.roundedRect(x, y, width, height, 8).fill('#e2e8f0');
  doc.restore();

  doc
    .fillColor(palette.text)
    .text(text, x + chipPaddingX, y + chipPaddingY - 2, { width: width - chipPaddingX * 2, align: 'left' });

  return { width, height };
}

function drawMetaChips(doc, data, palette, startX, usableWidth) {
  doc.font('Helvetica').fontSize(9);
  const chips = [
    { label: 'Fecha', value: formatDate(data.fecha) },
    { label: 'Válido hasta', value: formatDate(data.validez_hasta) },
    { label: 'Estado', value: data.estado || 'BORRADOR' },
    { label: 'Moneda', value: data.moneda || 'PYG' },
    data.moneda === 'USD' && data.tipo_cambio ? { label: 'TC', value: data.tipo_cambio } : null
  ].filter(Boolean);

  let x = startX;
  let y = doc.y;
  const gap = 8;

  chips.forEach((chip) => {
    const { width } = drawChip(doc, chip.label, chip.value, palette, x, y);
    x += width + gap;
  });

  doc.moveDown(1.2);
}

function drawCard(doc, title, rows, palette, startX, width) {
  const padding = 12;
  const cardHeightStart = doc.y;
  doc.save();
  doc.roundedRect(startX, doc.y - 4, width, 1, 10).fill('#ffffff');
  doc.restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(palette.text)
    .text(title, startX, doc.y, { width });

  doc.moveDown(0.2);
  rows.forEach((row) => {
    const label = row.label || '';
    const value = row.value || '-';
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(palette.subtle)
      .text(label, startX, doc.y, { width: width * 0.4 });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(palette.text)
      .text(value, startX + width * 0.4 + 8, doc.y - doc.currentLineHeight(), { width: width * 0.6 - 8 });
  });

  const cardBottom = doc.y;
  doc.y = Math.max(cardBottom, cardHeightStart + padding);
}

function drawClienteSection(doc, presupuesto, cliente, sucursal, usuario, palette, startX, usableWidth) {
  const columnWidth = (usableWidth - 12) / 2;
  const leftX = startX;
  const rightX = startX + columnWidth + 12;

  drawCard(
    doc,
    'Cliente',
    [
      { label: 'Nombre / Razón social', value: cliente.nombre_razon_social || '-' },
      { label: 'RUC/CI', value: cliente.ruc || '-' },
      { label: 'Teléfono', value: cliente.telefono || '-' },
      { label: 'Correo', value: cliente.correo || '-' },
      { label: 'Dirección', value: cliente.direccion || '-' }
    ],
    palette,
    leftX,
    columnWidth
  );

  drawCard(
    doc,
    'Datos del presupuesto',
    [
      { label: 'Sucursal', value: sucursal.nombre || '-' },
      { label: 'Vendedor', value: usuario.nombre || '-' },
      { label: 'Estado', value: presupuesto.estado || 'BORRADOR' },
      { label: 'Moneda', value: presupuesto.moneda || 'PYG' },
      presupuesto.moneda === 'USD' && presupuesto.tipo_cambio
        ? { label: 'Tipo de cambio', value: String(presupuesto.tipo_cambio) }
        : null
    ].filter(Boolean),
    palette,
    rightX,
    columnWidth
  );

  doc.moveDown(0.8);
}

function drawItemsTable(doc, detalles, palette, startX, usableWidth, currencyView) {
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(palette.text)
    .text('Ítems', startX, doc.y, { width: usableWidth });
  doc.moveDown(0.3);

  if (!detalles.length) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(palette.text)
      .text('Sin ítems cargados.', startX, doc.y, { width: usableWidth });
    doc.moveDown(0.6);
    return;
  }

  const colWidths = [usableWidth * 0.4, usableWidth * 0.12, usableWidth * 0.16, usableWidth * 0.12, usableWidth * 0.2];
  const priceLabel = currencyView.moneda === 'USD' ? 'Precio (USD)' : 'Precio';
  const subtotalLabel = currencyView.moneda === 'USD' ? 'Subtotal (USD)' : 'Subtotal';
  const headers = ['Producto', 'Cant.', priceLabel, 'IVA', subtotalLabel];
  const yStart = doc.y;

  drawRow(doc, headers, colWidths, startX, yStart, palette, true);

  let rowIndex = 0;
  detalles.forEach((detalle) => {
    const nombreProd = detalle.producto?.nombre || detalle.producto?.sku || detalle.nombre || 'Ítem';
    const amounts = currencyView.itemAmounts(detalle);
    const row = [
      nombreProd,
      String(detalle.cantidad ?? '-'),
      amounts.precio,
      `${detalle.iva_porcentaje || 10}%`,
      amounts.subtotal
    ];
    drawRow(doc, row, colWidths, startX, doc.y + 2, palette, false, rowIndex);
    rowIndex += 1;
  });

  doc.moveDown(0.6);
}

function drawRow(doc, values, colWidths, startX, y, palette, isHeader = false, index = 0) {
  const rowHeight = 18;
  const bg = isHeader ? '#e2e8f0' : index % 2 === 0 ? '#ffffff' : '#f8fafc';

  doc.save();
  doc.rect(startX, y, colWidths.reduce((acc, w) => acc + w, 0), rowHeight).fill(bg);
  doc.restore();

  let cursorX = startX + 8;
  values.forEach((val, idx) => {
    const width = colWidths[idx] - 12;
    doc
      .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(10)
      .fillColor(isHeader ? palette.text : '#0f172a')
      .text(String(val || ''), cursorX, y + 5, { width, align: idx >= 1 ? 'right' : 'left' });
    cursorX += colWidths[idx];
  });

  doc.y = y + rowHeight;
}

function drawTotales(doc, data, palette, startX, usableWidth, currencyView) {
  const boxWidth = usableWidth * 0.42;
  const boxX = startX + usableWidth - boxWidth;
  const padding = 12;
  const boxY = doc.y;
  const lines = [];

  const totals = currencyView.totals;
  lines.push({ label: currencyView.moneda === 'USD' ? 'Subtotal (USD)' : 'Subtotal', value: totals.subtotal });
  if (totals.descuento) {
    lines.push({ label: currencyView.moneda === 'USD' ? 'Descuento (USD)' : 'Descuento', value: totals.descuento });
  }
  lines.push({ label: currencyView.moneda === 'USD' ? 'IVA (USD)' : 'IVA', value: totals.iva });
  lines.push({ label: currencyView.moneda === 'USD' ? 'Total (USD)' : 'Total', value: totals.total });
  if (currencyView.moneda === 'USD' && totals.totalGs) {
    lines.push({ label: 'Total Gs. (convertido)', value: totals.totalGs });
  }

  const labelFontSize = 10;
  const lineHeight = 20;
  const boxHeight = padding * 2 + lineHeight * lines.length;

  doc.save();
  doc.roundedRect(boxX, boxY, boxWidth, boxHeight, 10).fill('#0f172a');
  doc.restore();

  let cursorY = boxY + padding - 2;
  lines.forEach((line) => {
    doc
      .font('Helvetica')
      .fontSize(labelFontSize)
      .fillColor('#e2e8f0')
      .text(line.label, boxX + padding, cursorY, { width: boxWidth * 0.5 });
    doc
      .font('Helvetica-Bold')
      .fontSize(labelFontSize)
      .fillColor('#e2e8f0')
      .text(line.value, boxX + boxWidth * 0.5, cursorY, { width: boxWidth * 0.5 - padding, align: 'right' });
    cursorY += lineHeight;
  });

  doc.y = boxY + boxHeight + 10;
}

async function generateNumero(tx, sucursalId) {
  const prefix = 'PRE-';
  const last = await tx.presupuesto.findFirst({
    where: { sucursalId },
    select: { numero: true },
    orderBy: { created_at: 'desc' }
  });

  const current = last?.numero || null;
  const match = current && typeof current === 'string' ? current.match(/^PRE-(\d{1,6})$/u) : null;
  const lastNumber = match ? Number(match[1]) : 0;
  const next = String(lastNumber + 1).padStart(6, '0');
  return `${prefix}${next}`;
}

function buildWhere(filters, sucursalId) {
  const where = { sucursalId };

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.estado) {
    where.estado = filters.estado;
  }

  if (filters.search) {
    const term = filters.search;
    where.OR = [
      { numero: { contains: term, mode: 'insensitive' } },
      { cliente: { nombre_razon_social: { contains: term, mode: 'insensitive' } } }
    ];
  }

  return where;
}

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const { page = 1, pageSize = 20, ...filters } = parsed.data;
  const where = buildWhere(filters, req.sucursalId);

  try {
    const [presupuestos, total] = await Promise.all([
      prisma.presupuesto.findMany({
        where,
        include: {
          cliente: { select: { id: true, nombre_razon_social: true } },
          usuario: { select: { id: true, nombre: true } }
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'desc' }
      }),
      prisma.presupuesto.count({ where })
    ]);

    const data = presupuestos.map((item) => ({
      ...serialize(item),
      cliente_nombre: item.cliente?.nombre_razon_social || null,
      usuario_nombre: item.usuario?.nombre || null
    }));

    res.json({
      data,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar presupuestos' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.presupuesto.findFirst({ where: { id: req.params.id, sucursalId: req.sucursalId } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Presupuesto no encontrado en esta sucursal' });
    }
    const deleted = await prisma.presupuesto.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    return res.status(200).json({ ok: true, presupuesto: serialize(deleted) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar presupuesto' });
  }
});


router.get('/:id/pdf', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Identificador inválido' });

  try {
    const presupuesto = await prisma.presupuesto.findFirst({
      where: { id, sucursalId: req.sucursalId },
      include: {
        cliente: true,
        usuario: { select: { id: true, nombre: true } },
        sucursal: { select: { id: true, nombre: true, direccion: true, telefono: true } },
        detalles: {
          include: { producto: true }
        }
      }
    });

    if (!presupuesto || presupuesto.deleted_at) {
      return res.status(404).json({ error: 'Presupuesto no encontrado' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="presupuesto-${presupuesto.numero || presupuesto.id}.pdf"`);

    const doc = new PDFDocument({ margin: 28 });
    doc.pipe(res);
    renderPresupuestoPdf(doc, presupuesto);
    doc.end();
  } catch (err) {
    console.error('[Presupuestos] No se pudo generar el PDF.', err);
    res.status(500).json({ error: 'No se pudo generar el PDF del presupuesto.' });
  }
});

router.put('/:id/estado', validate(updateEstadoSchema), async (req, res) => {
  const { id } = req.params;
  const { estado } = req.validatedBody;

  try {
    const existing = await prisma.presupuesto.findFirst({
      where: { id, sucursalId: req.sucursalId, deleted_at: null },
      include: {
        cliente: { select: { nombre_razon_social: true } },
        usuario: { select: { nombre: true } }
      }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Presupuesto no encontrado en esta sucursal.' });
    }

    if (!ALLOWED_ESTADOS.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido.' });
    }

    if (existing.estado === estado) {
      return res.json(serialize(existing));
    }

    const updated = await prisma.presupuesto.update({
      where: { id },
      data: { estado }
    });

    const enriched = {
      ...updated,
      cliente_nombre: existing.cliente?.nombre_razon_social || null,
      usuario_nombre: existing.usuario?.nombre || null
    };

    res.json(serialize(enriched));
  } catch (err) {
    console.error('[Presupuestos] No se pudo actualizar estado', err);
    res.status(500).json({ error: 'No se pudo actualizar el estado del presupuesto.' });
  }
});

const { authorizeRoles } = require('../middleware/authContext');

router.post('/', authorizeRoles('ADMIN', 'VENDEDOR'), validate(createPresupuestoSchema), async (req, res) => {
  const usuarioId = req.usuarioActual?.id;
  if (!usuarioId) {
    return res.status(401).json({ error: 'Sesión inválida' });
  }

  const payload = req.validatedBody;
  const moneda = payload.moneda || 'PYG';
  const tipoCambio = moneda === 'USD' ? payload.tipo_cambio : null;

  if (moneda === 'USD' && !tipoCambio) {
    return res.status(400).json({ error: 'El tipo de cambio es obligatorio para presupuestos en USD.' });
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const numero = await generateNumero(tx, req.sucursalId);

      if (payload.clienteId) {
        const cliente = await tx.cliente.findUnique({ where: { id: payload.clienteId } });
        if (!cliente || cliente.deleted_at) {
          throw new Error('El cliente no existe o fue eliminado.');
        }
      }

      const productoIds = Array.from(
        new Set((payload.detalles || []).map((d) => d.productoId).filter(Boolean))
      );

      const productos = productoIds.length
        ? await tx.producto.findMany({
            where: {
              id: { in: productoIds },
              deleted_at: null
            },
            select: {
              id: true,
              nombre: true,
              sku: true,
              precio_venta: true,
              precio_venta_original: true,
              moneda_precio_venta: true,
              stock_actual: true,
              sucursalId: true,
              tipo: true
            }
          })
        : [];

      const productoById = new Map(productos.map((p) => [p.id, p]));
      const stockMap = await getProductoStockMap(tx, productoIds, req.sucursalId);
      const consumoStock = new Map();

      let subtotal = 0;
      let subtotalMoneda = 0;
      let impuestoTotal = 0;
      const basePorIva = new Map();
      const detallesData = [];

      for (const item of payload.detalles) {
        const iva = normalizeIva(item.iva_porcentaje);
        let precioUnitario = item.precio_unitario;
        let producto = null;
        let subtotalDetalleMoneda = null;

        if (item.productoId) {
          producto = productoById.get(item.productoId) || null;
          if (!producto) {
            throw new Error('Producto no encontrado para el detalle.');
          }

          if (producto.tipo !== 'SERVICIO') {
            const stockDisponible = resolveProductoStock(producto, req.sucursalId, stockMap);
            const consumoPrevio = consumoStock.get(producto.id) || 0;
            const totalSolicitado = consumoPrevio + Number(item.cantidad || 0);

            if (stockDisponible <= 0) {
              throw new Error(
                `El producto ${producto.nombre || producto.sku || ''} no tiene stock disponible.`
              );
            }

            if (totalSolicitado > stockDisponible) {
              throw new Error(
                `Stock insuficiente para ${producto.nombre || producto.sku || 'el producto'}: ` +
                `disponible ${stockDisponible}, solicitado ${totalSolicitado}.`
              );
            }

            consumoStock.set(producto.id, totalSolicitado);
          }
          if (precioUnitario === undefined || precioUnitario === null) {
            const pricing = resolveProductSalePricing(producto, {
              targetCurrency: moneda,
              exchangeRate: tipoCambio
            });
            precioUnitario = pricing.unitGs;
            if (moneda === 'USD') {
              subtotalDetalleMoneda = round(pricing.unitCurrency * item.cantidad, 2);
            }
          }
        }

        if (precioUnitario === undefined || precioUnitario === null) {
          throw new Error('Cada ítem necesita un precio unitario.');
        }

        const safePrecio = round(precioUnitario, 2);
        const lineSubtotal = round(safePrecio * item.cantidad, 2);
        if (moneda === 'USD') {
          if (subtotalDetalleMoneda === null) {
            subtotalDetalleMoneda = round(lineSubtotal / tipoCambio, 2);
          }
          subtotalMoneda = round(subtotalMoneda + subtotalDetalleMoneda, 2);
        }

        subtotal += lineSubtotal;
        if (iva > 0) {
          const acumulado = basePorIva.get(iva) || 0;
          basePorIva.set(iva, round(acumulado + lineSubtotal, 2));
        }

        detallesData.push({
          productoId: item.productoId || null,
          cantidad: item.cantidad,
          precio_unitario: safePrecio,
          subtotal: lineSubtotal,
          iva_porcentaje: iva
        });
      }

      const descuentoEntrada = Number(payload.descuento_total ?? 0);
      const descuentoMoneda = Number.isFinite(descuentoEntrada) && descuentoEntrada > 0
        ? round(descuentoEntrada, 2)
        : 0;
      const descuento = moneda === 'USD' && tipoCambio
        ? round(descuentoMoneda * tipoCambio, 2)
        : descuentoMoneda;

      if (descuento > subtotal) {
        throw new Error('El descuento no puede superar el subtotal.');
      }

      // Nuevo cálculo: IVA solo se muestra, no se suma al total. IVA 10% = base_neta/11, IVA 5% = base_neta/21
      let iva10 = 0;
      let iva5 = 0;
      if (subtotal > 0) {
        const factorBase = (subtotal - descuento) / subtotal;
        for (const [ivaKey, base] of basePorIva.entries()) {
          const baseNeta = base * factorBase;
          if (ivaKey === 10) iva10 += baseNeta / 11;
          if (ivaKey === 5) iva5 += baseNeta / 21;
        }
      }
      // Usar solo la variable ya declarada impuestoTotal
      // IVA con dos decimales después de la coma, sin redondear a entero
      impuestoTotal = Number((iva10 + iva5).toFixed(2));
      const baseNeta = round(subtotal - descuento, 2);
      const total = baseNeta; // El total es solo la base neta, NO se suma el IVA
      const safeTotal = total < 0 ? 0 : total;
      const totalMoneda = moneda === 'USD' && tipoCambio
        ? round(Math.max(subtotalMoneda - descuentoMoneda, 0), 2)
        : null;

      const presupuesto = await tx.presupuesto.create({
        data: {
          numero,
          clienteId: payload.clienteId || null,
          usuarioId,
          sucursalId: req.sucursalId,
          fecha: new Date(),
          validez_hasta: payload.validez_hasta || null,
          moneda,
          tipo_cambio: tipoCambio,
          subtotal: round(subtotal, 2),
          descuento_total: descuento,
          impuesto_total: round(impuestoTotal, 2),
          total: safeTotal,
          total_moneda: totalMoneda,
          estado: 'GENERADO',
          notas: payload.notas,
          detalles: {
            create: detallesData
          }
        }
      });

      return presupuesto;
    });

    const withRelations = await prisma.presupuesto.findFirst({
      where: { id: created.id },
      include: {
        cliente: { select: { nombre_razon_social: true } },
        usuario: { select: { nombre: true } }
      }
    });

    res.status(201).json(
      serialize({
        ...withRelations,
        cliente_nombre: withRelations?.cliente?.nombre_razon_social || null,
        usuario_nombre: withRelations?.usuario?.nombre || null
      })
    );
  } catch (err) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Ya existe un presupuesto con ese número en esta sucursal.' });
    }

    console.error(err);
    const message = err?.message || 'No se pudo crear el presupuesto.';
    res.status(400).json({ error: message });
  }
});

module.exports = router;
