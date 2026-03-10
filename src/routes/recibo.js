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

const ventaAplicacionSchema = z.object({
  ventaId: z.string().uuid({ message: 'ventaId inválido' }),
  monto: z.coerce.number().positive('El monto debe ser mayor a cero')
});

const createReciboSchema = z.object({
  clienteId: z.string().uuid().optional(),
  numero: z.string().trim().optional(),
  metodo: z.string().trim().min(1, 'El método es requerido'),
  referencia: z.string().trim().optional(),
  observacion: z.string().trim().optional(),
  fecha: z.coerce.date().optional(),
  moneda: z.enum(['PYG', 'USD']).default('PYG'),
  tipo_cambio: z.coerce.number().positive('El tipo de cambio debe ser mayor a cero').optional(),
  ventas: z.array(ventaAplicacionSchema).min(1, 'Debes indicar al menos una venta')
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
  const moneda = (data.moneda || 'PYG').toUpperCase();
  const tipoCambio = Number(data.tipo_cambio);

  if (moneda === 'USD' && (!Number.isFinite(tipoCambio) || tipoCambio <= 0)) {
    return res.status(400).json({ error: 'Indicá un tipo de cambio válido para cobros en USD.' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const ventaIds = data.ventas.map((v) => v.ventaId);
      const ventas = await tx.venta.findMany({
        where: {
          id: { in: ventaIds },
          sucursalId: req.sucursalId,
          deleted_at: null
        }
      });

      if (ventas.length !== ventaIds.length) {
        throw new Error('VENTA_NO_EN_SUCURSAL');
      }

      const pagosCalculados = data.ventas.map((item) => {
        const montoMoneda = Number(item.monto || 0);
        const montoGs = moneda === 'USD' ? montoMoneda * tipoCambio : montoMoneda;
        return { ...item, montoGs, montoMoneda };
      });

      const total = pagosCalculados.reduce((acc, item) => acc + Number(item.montoGs || 0), 0);
      const totalMoneda = pagosCalculados.reduce((acc, item) => acc + Number(item.montoMoneda || 0), 0);
      const clienteId = data.clienteId || ventas[0]?.clienteId || null;
      const numero = data.numero || (await buildReciboNumero(tx, req.sucursalId));

      const recibo = await tx.recibo.create({
        data: {
          numero,
          clienteId,
          usuarioId: req.usuarioActual.id,
          sucursalId: req.sucursalId,
          fecha: data.fecha || undefined,
          total,
          total_moneda: totalMoneda,
          moneda,
          tipo_cambio: moneda === 'USD' ? tipoCambio : null,
          metodo: data.metodo,
          referencia: data.referencia || null,
          observacion: data.observacion || null
        }
      });

      for (const aplicacion of pagosCalculados) {
        const venta = ventas.find((v) => v.id === aplicacion.ventaId);
        const saldoPrevio = Number(venta?.saldo_pendiente ?? venta?.total ?? 0);
        const nuevoSaldo = Math.max(saldoPrevio - Number(aplicacion.montoGs || 0), 0);

        await tx.reciboDetalle.create({
          data: {
            reciboId: recibo.id,
            ventaId: aplicacion.ventaId,
            monto: aplicacion.montoGs,
            monto_moneda: aplicacion.montoMoneda,
            saldo_previo: saldoPrevio,
            saldo_posterior: nuevoSaldo
          }
        });

        await tx.venta.update({
          where: { id: aplicacion.ventaId },
          data: {
            saldo_pendiente: nuevoSaldo,
            es_credito: nuevoSaldo > 0 ? true : venta?.es_credito,
            estado: nuevoSaldo <= 0 ? 'PAGADA' : venta?.estado
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

      return reciboCompleto;
    });

    return res.status(201).json(serialize(result));
  } catch (err) {
    if (err?.message === 'VENTA_NO_EN_SUCURSAL') {
      return res.status(404).json({ error: 'Alguna venta no pertenece a esta sucursal o no existe.' });
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
    return {
      factura: factura?.nro_factura || '—',
      venta: venta.id || ap.ventaId || '—',
      pago: pagoLabel,
      saldo: `Gs. ${formatCurrency(saldoNuevo, 'PYG')} (previo: Gs. ${formatCurrency(saldoPrevio, 'PYG')})`
    };
  }));

  cursorY = doc.y + 12;
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0f172a')
    .text(`Total cobrado: ${formatAmount(totalPrincipal, moneda)}`, startX, cursorY, { width: usableWidth });
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
    where: { sucursalId },
    orderBy: { created_at: 'desc' },
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

module.exports = router;
