const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const validate = require('../middleware/validate');

const router = express.Router();

function decimal(minValue = null, message) {
  const base = z.coerce.number({ invalid_type_error: 'Debe ser un número.' }).refine(
    (val) => Number.isFinite(val),
    { message: 'Debe ser un número válido.' }
  );

  if (typeof minValue === 'number') {
    return base.refine((val) => val >= minValue, {
      message: message || `El valor debe ser mayor o igual a ${minValue}.`
    });
  }

  return base;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor + Number.EPSILON) / factor;
}

function ensureDate(input, fallback = new Date()) {
  if (!input) return fallback;
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(date.getTime())) return fallback;
  return date;
}

const currencyFormatter = new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' });
const currencyFormatterUsd = new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'USD' });

function formatCurrency(value) {
  return currencyFormatter.format(Number(value || 0));
}

function formatCurrencyUsd(value) {
  return currencyFormatterUsd.format(Number(value || 0));
}

const listQuerySchema = z.object({
  fecha_desde: z.coerce.date().optional(),
  fecha_hasta: z.coerce.date().optional(),
  usuarioId: z.string().uuid().optional(),
  include_deleted: z.coerce.boolean().optional()
});

const aperturaSchema = z.object({
  usuarioId: z.string().uuid(),
  saldo_inicial: decimal(0, 'El saldo inicial debe ser mayor o igual a cero.'),
  fecha_apertura: z.coerce.date().optional(),
  observaciones: z.string().trim().max(400).optional()
});

const createSalidaSchema = z.object({
  usuarioId: z.string().uuid(),
  descripcion: z.string().trim().min(3).max(200),
  monto: decimal(0.01, 'El monto debe ser mayor a cero.'),
  fecha: z.coerce.date().optional(),
  observacion: z.string().trim().max(400).optional()
});

const standaloneSalidaSchema = createSalidaSchema.extend({
  cierreId: z.string().uuid().optional()
});

const createCierreSchema = z.object({
  usuarioId: z.string().uuid(),
  fecha_cierre: z.coerce.date().optional(),
  efectivo_declarado: decimal(0).optional(),
  total_tarjeta: decimal(0).optional(),
  total_transferencia: decimal(0).optional(),
  observaciones: z.string().trim().max(1000).optional()
});

const estadoQuerySchema = z.object({
  usuarioId: z.string().uuid(),
  fecha_hasta: z.coerce.date().optional()
});

async function findAperturaActiva(client, usuarioId) {
  return client.aperturaCaja.findFirst({
    where: {
      usuarioId,
      deleted_at: null,
      fecha_cierre: null
    },
    orderBy: { fecha_apertura: 'desc' }
  });
}

async function calcularResumen(client, { usuarioId, fechaHasta }) {
  const apertura = await findAperturaActiva(client, usuarioId);
  if (!apertura) return null;

  const fechaInicio = ensureDate(apertura.fecha_apertura);
  const fechaFin = ensureDate(fechaHasta);
  const now = new Date();
  const upperBound = fechaFin > now ? fechaFin : now;

  const ventas = await client.venta.findMany({
    where: {
      usuarioId,
      deleted_at: null,
      fecha: {
        gte: fechaInicio,
        lte: upperBound
      }
    },
    select: {
      total: true,
      total_moneda: true,
      moneda: true,
      estado: true
    }
  });

  const totalesVentas = ventas
    .filter((venta) => {
      if (!venta.estado) return true;
      return venta.estado.toUpperCase() !== 'ANULADA';
    })
    .reduce(
      (acc, venta) => {
        acc.gs += Number(venta.total || 0);
        if ((venta.moneda || 'PYG').toUpperCase() === 'USD') {
          const usdAmount = Number(venta.total_moneda || 0);
          if (Number.isFinite(usdAmount)) {
            acc.usd += usdAmount;
          }
        }
        return acc;
      },
      { gs: 0, usd: 0 }
    );

  const totalVentasGs = totalesVentas.gs;
  const totalVentasUsd = totalesVentas.usd;
  const totalEfectivoUsd = totalVentasUsd; // por ahora todas las ventas USD se consideran efectivo

  const salidasPendientes = await client.salidaCaja.findMany({
    where: {
      usuarioId,
      deleted_at: null,
      cierreId: null,
      fecha: {
        gte: fechaInicio,
        lte: upperBound
      }
    },
    orderBy: { fecha: 'asc' }
  });

  const totalSalidas = salidasPendientes.reduce((acc, salida) => acc + Number(salida.monto || 0), 0);
  const saldoInicial = Number(apertura.saldo_inicial || 0);

  const efectivoEsperadoGs = round(saldoInicial + totalVentasGs - totalSalidas);
  const efectivoEsperadoUsd = round(totalEfectivoUsd);

  return {
    apertura,
    periodo: { desde: fechaInicio, hasta: fechaFin },
    totales: {
      ventas: round(totalVentasGs),
      ventasUsd: round(totalVentasUsd),
      efectivoUsd: round(totalEfectivoUsd),
      efectivo: round(totalVentasGs),
      tarjeta: 0,
      transferencia: 0,
      saldoInicial: round(saldoInicial),
      salidas: round(totalSalidas),
      efectivoEsperado: efectivoEsperadoGs,
      efectivoEsperadoUsd
    },
    salidasPendientes
  };
}

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const filters = parsed.data;
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }
  if (filters.usuarioId) {
    where.usuarioId = filters.usuarioId;
  }
  if (filters.fecha_desde || filters.fecha_hasta) {
    where.fecha_cierre = {};
    if (filters.fecha_desde) {
      const from = ensureDate(filters.fecha_desde);
      from.setHours(0, 0, 0, 0);
      where.fecha_cierre.gte = from;
    }
    if (filters.fecha_hasta) {
      const to = ensureDate(filters.fecha_hasta);
      to.setHours(23, 59, 59, 999);
      where.fecha_cierre.lte = to;
    }
  }

  try {
    const cierres = await prisma.cierreCaja.findMany({
      where,
      include: {
        usuario: true,
        apertura: true,
        salidas: {
          where: filters.include_deleted ? {} : { deleted_at: null },
          orderBy: { fecha: 'desc' }
        }
      },
      orderBy: { fecha_cierre: 'desc' }
    });

    const totalVentas = cierres.reduce((acc, cierre) => acc + Number(cierre.total_ventas || 0), 0);
    const totalVentasUsd = cierres.reduce((acc, cierre) => acc + Number(cierre.total_ventas_usd || 0), 0);
    const totalEfectivo = cierres.reduce((acc, cierre) => acc + Number(cierre.total_efectivo || 0), 0);
    const totalEfectivoUsd = cierres.reduce((acc, cierre) => acc + Number(cierre.efectivo_usd || 0), 0);
    const totalSalidas = cierres.reduce((acc, cierre) => acc + Number(cierre.total_salidas || 0), 0);

    res.json({
      data: serialize(cierres),
      meta: {
        total: cierres.length,
        totalVentas: round(totalVentas),
        totalVentasUsd: round(totalVentasUsd),
        totalEfectivo: round(totalEfectivo),
        totalEfectivoUsd: round(totalEfectivoUsd),
        totalSalidas: round(totalSalidas)
      }
    });
  } catch (error) {
    console.error('[cierreCaja] list', error);
    res.status(500).json({ error: 'No se pudieron listar los cierres.' });
  }
});

router.get('/estado', async (req, res) => {
  const parsed = estadoQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const resumen = await calcularResumen(prisma, parsed.data);
    if (!resumen) {
      return res.status(404).json({ error: 'No existe una apertura activa para el usuario.' });
    }

    res.json({
      apertura: serialize(resumen.apertura),
      periodo: resumen.periodo,
      totales: resumen.totales,
      salidasPendientes: serialize(resumen.salidasPendientes)
    });
  } catch (error) {
    console.error('[cierreCaja] estado', error);
    res.status(500).json({ error: 'No se pudo obtener el estado de caja.' });
  }
});

router.post('/aperturas', validate(aperturaSchema), async (req, res) => {
  const payload = req.validatedBody;
  const fechaApertura = payload.fecha_apertura ? ensureDate(payload.fecha_apertura) : new Date();

  try {
    const existente = await findAperturaActiva(prisma, payload.usuarioId);
    if (existente) {
      return res.status(409).json({ error: 'Ya existe una apertura activa para este usuario.' });
    }

    const apertura = await prisma.aperturaCaja.create({
      data: {
        usuarioId: payload.usuarioId,
        fecha_apertura: fechaApertura,
        saldo_inicial: Number(payload.saldo_inicial),
        observaciones: payload.observaciones || null
      },
      include: {
        usuario: true
      }
    });

    res.status(201).json(serialize(apertura));
  } catch (error) {
    console.error('[cierreCaja] apertura', error);
    res.status(500).json({ error: 'No se pudo registrar la apertura.' });
  }
});

router.post('/', validate(createCierreSchema), async (req, res) => {
  const payload = req.validatedBody;
  const fechaCierre = payload.fecha_cierre ? ensureDate(payload.fecha_cierre) : new Date();

  try {
    const resumen = await calcularResumen(prisma, { usuarioId: payload.usuarioId, fechaHasta: fechaCierre });
    if (!resumen) {
      return res.status(409).json({ error: 'Para cerrar la caja primero registrá una apertura.' });
    }

    const totalTarjeta =
      payload.total_tarjeta !== undefined && payload.total_tarjeta !== null
        ? round(payload.total_tarjeta)
        : resumen.totales.tarjeta;
    const totalTransferencia =
      payload.total_transferencia !== undefined && payload.total_transferencia !== null
        ? round(payload.total_transferencia)
        : resumen.totales.transferencia;

    const totalVentasUsd = resumen.totales.ventasUsd || 0;
    const totalEfectivoUsd = resumen.totales.efectivoUsd || 0;

    const totalEfectivoVentas = round(Math.max(resumen.totales.ventas - totalTarjeta - totalTransferencia, 0));
    const efectivoEsperado = round(
      resumen.totales.saldoInicial + totalEfectivoVentas - resumen.totales.salidas
    );

    const efectivoDeclarado = payload.efectivo_declarado != null ? Number(payload.efectivo_declarado) : null;
    const diferencia = efectivoDeclarado != null ? round(efectivoDeclarado - efectivoEsperado) : null;

    const salidasIds = resumen.salidasPendientes.map((salida) => salida.id);

    const cierre = await prisma.$transaction(async (tx) => {
      const created = await tx.cierreCaja.create({
        data: {
          usuarioId: payload.usuarioId,
          aperturaId: resumen.apertura.id,
          saldo_inicial: resumen.totales.saldoInicial,
          fecha_apertura: resumen.periodo.desde,
          fecha_cierre: resumen.periodo.hasta,
          total_ventas: resumen.totales.ventas,
          total_ventas_usd: resumen.totales.ventasUsd,
          total_efectivo: totalEfectivoVentas,
          efectivo_usd: totalEfectivoUsd,
          total_tarjeta: totalTarjeta,
          total_transferencia: totalTransferencia,
          total_salidas: resumen.totales.salidas,
          efectivo_declarado: efectivoDeclarado,
          diferencia,
          observaciones: payload.observaciones || null
        }
      });

      if (salidasIds.length) {
        await tx.salidaCaja.updateMany({
          where: { id: { in: salidasIds } },
          data: { cierreId: created.id }
        });
      }

      await tx.aperturaCaja.update({
        where: { id: resumen.apertura.id },
        data: { fecha_cierre: resumen.periodo.hasta }
      });

      return tx.cierreCaja.findUnique({
        where: { id: created.id },
        include: {
          usuario: true,
          apertura: true,
          salidas: {
            where: { deleted_at: null },
            orderBy: { fecha: 'desc' }
          }
        }
      });
    });

    res.status(201).json(serialize(cierre));
  } catch (error) {
    console.error('[cierreCaja] create', error);
    res.status(500).json({ error: 'No se pudo registrar el cierre de caja.' });
  }
});

router.post('/salidas', validate(standaloneSalidaSchema), async (req, res) => {
  const payload = req.validatedBody;

  try {
    if (payload.cierreId) {
      const cierre = await prisma.cierreCaja.findUnique({ where: { id: payload.cierreId } });
      if (!cierre) {
        return res.status(404).json({ error: 'Cierre de caja asociado no encontrado.' });
      }
    }

    const salida = await prisma.salidaCaja.create({
      data: {
        usuarioId: payload.usuarioId,
        cierreId: payload.cierreId || null,
        descripcion: payload.descripcion,
        monto: Number(payload.monto),
        fecha: payload.fecha ? ensureDate(payload.fecha) : undefined,
        observacion: payload.observacion || null
      },
      include: {
        usuario: true,
        cierre: true
      }
    });

    if (payload.cierreId) {
      const [totalSalidas, cierreActual] = await Promise.all([
        prisma.salidaCaja.aggregate({
          where: { cierreId: payload.cierreId, deleted_at: null },
          _sum: { monto: true }
        }),
        prisma.cierreCaja.findUnique({ where: { id: payload.cierreId } })
      ]);

      if (cierreActual) {
        const sumaSalidas = round(Number(totalSalidas._sum.monto || 0));
        const nuevoDiff =
          cierreActual.efectivo_declarado != null
            ? round(
                Number(cierreActual.efectivo_declarado) -
                  (Number(cierreActual.saldo_inicial || 0) + Number(cierreActual.total_efectivo || 0) - sumaSalidas)
              )
            : cierreActual.diferencia;

        await prisma.cierreCaja.update({
          where: { id: payload.cierreId },
          data: {
            total_salidas: sumaSalidas,
            diferencia: nuevoDiff
          }
        });
      }
    }

    res.status(201).json(serialize(salida));
  } catch (error) {
    console.error('[cierreCaja] create standalone salida', error);
    res.status(500).json({ error: 'No se pudo registrar la salida de caja.' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || !z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Identificador inválido.' });
  }

  try {
    const cierre = await prisma.cierreCaja.findUnique({
      where: { id },
      include: {
        usuario: true,
        apertura: true,
        salidas: {
          where: { deleted_at: null },
          orderBy: { fecha: 'desc' }
        }
      }
    });

    if (!cierre) {
      return res.status(404).json({ error: 'Cierre de caja no encontrado.' });
    }

    res.json(serialize(cierre));
  } catch (error) {
    console.error('[cierreCaja] detail', error);
    res.status(500).json({ error: 'No se pudo obtener el cierre solicitado.' });
  }
});

router.post('/:id/salidas', validate(createSalidaSchema), async (req, res) => {
  const { id } = req.params;
  if (!id || !z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Identificador inválido.' });
  }
  const payload = req.validatedBody;

  try {
    const cierre = await prisma.cierreCaja.findUnique({ where: { id } });
    if (!cierre) {
      return res.status(404).json({ error: 'Cierre de caja no encontrado.' });
    }

    const salida = await prisma.salidaCaja.create({
      data: {
        cierreId: id,
        usuarioId: payload.usuarioId,
        descripcion: payload.descripcion,
        monto: Number(payload.monto),
        fecha: payload.fecha ? ensureDate(payload.fecha) : undefined,
        observacion: payload.observacion || null
      },
      include: {
        usuario: true,
        cierre: true
      }
    });

    const totalSalidas = await prisma.salidaCaja.aggregate({
      where: { cierreId: id, deleted_at: null },
      _sum: { monto: true }
    });

    const sumaSalidas = round(Number(totalSalidas._sum.monto || 0));
    const nuevoDiff =
      cierre.efectivo_declarado != null
        ? round(
            Number(cierre.efectivo_declarado) -
              (Number(cierre.saldo_inicial || 0) + Number(cierre.total_efectivo || 0) - sumaSalidas)
          )
        : cierre.diferencia;

    await prisma.cierreCaja.update({
      where: { id },
      data: {
        total_salidas: sumaSalidas,
        diferencia: nuevoDiff
      }
    });

    res.status(201).json(serialize(salida));
  } catch (error) {
    console.error('[cierreCaja] add salida', error);
    res.status(500).json({ error: 'No se pudo registrar la salida de caja.' });
  }
});

router.get('/:id/reporte', async (req, res) => {
  const { id } = req.params;
  if (!id || !z.string().uuid().safeParse(id).success) {
    return res.status(400).json({ error: 'Identificador inválido.' });
  }

  try {
    const cierre = await prisma.cierreCaja.findUnique({
      where: { id },
      include: {
        usuario: true,
        apertura: true,
        salidas: {
          where: { deleted_at: null },
          orderBy: { fecha: 'asc' }
        }
      }
    });

    if (!cierre) {
      return res.status(404).json({ error: 'Cierre de caja no encontrado.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cierre-${id}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 32 });
    doc.pipe(res);

    renderCierrePdf(doc, cierre);

    doc.end();
  } catch (error) {
    console.error('[cierreCaja] reporte', error);
    res.status(500).json({ error: 'No se pudo generar el reporte del cierre.' });
  }
});

function renderCierrePdf(doc, cierre) {
  const metrics = buildCierreMetrics(cierre);
  const startX = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.y = doc.page.margins.top;

  renderCierreHeader(doc, cierre, metrics, startX, width);
  doc.moveDown(1.2);
  renderMetricGrid(doc, metrics, startX, width);
  doc.moveDown(1);
  renderIncomeAndBalance(doc, metrics, startX, width);
  doc.moveDown(1);
  renderSalidasSection(doc, Array.isArray(cierre.salidas) ? cierre.salidas : [], startX, width);

  if (cierre.observaciones) {
    doc.moveDown(0.8);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#475569')
      .text(`Observaciones: ${cierre.observaciones}`, startX, doc.y, { width });
  }

  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#94a3b8')
    .text('Documento generado automáticamente por TRIDENT INNOVA E.A.S.', startX, doc.y, {
      width,
      align: 'center'
    });
}

function renderCierreHeader(doc, cierre, metrics, startX, width) {
  const logoPath = path.join(__dirname, '..', 'public', 'img', 'logo.png');
  const hasLogo = fs.existsSync(logoPath);
  const topY = doc.y;

  if (hasLogo) {
    try {
      doc.image(logoPath, startX, topY, { fit: [110, 60] });
    } catch (error) {
      console.warn('[cierreCaja] logo', error.message);
    }
  }

  const textX = hasLogo ? startX + 130 : startX;
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor('#0f172a')
    .text('Reporte de Cierre de Caja', textX, topY, { width: width - (textX - startX) });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#475569')
    .text(`Generado: ${formatDateTime(new Date())}`, textX, doc.y + 2, { width: width - (textX - startX) });

  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
  doc.text(`Código de cierre: ${cierre.id}`);
  doc.text(`Responsable: ${cierre.usuario?.nombre || cierre.usuario?.usuario || cierre.usuarioId}`);
  doc.text(`Apertura: ${formatDateTime(cierre.fecha_apertura)}`);
  doc.text(`Cierre: ${formatDateTime(cierre.fecha_cierre)}`);
  doc.text(`Saldo inicial declarado: ${formatCurrency(metrics.saldoInicial)}`);
}

function renderMetricGrid(doc, metrics, startX, width) {
  const cards = [
    { label: 'Saldo inicial', value: formatCurrency(metrics.saldoInicial) },
    { label: 'Ventas registradas', value: formatCurrency(metrics.totalVentas) },
    { label: 'Ventas USD', value: formatCurrencyUsd(metrics.totalVentasUsd) },
    { label: 'Ingresos en efectivo', value: formatCurrency(metrics.totalEfectivo) },
    { label: 'Efectivo USD', value: formatCurrencyUsd(metrics.efectivoUsd) },
    { label: 'Salidas', value: formatCurrency(metrics.totalSalidas) },
    { label: 'Efectivo esperado', value: formatCurrency(metrics.efectivoEsperado) },
    {
      label: 'Diferencia',
      value: metrics.diferencia != null ? formatCurrency(metrics.diferencia) : '—',
      highlight: true
    }
  ];

  const columns = 3;
  const spacing = 12;
  const cardWidth = (width - spacing * (columns - 1)) / columns;
  const cardHeight = 58;
  const baseY = doc.y;

  cards.forEach((card, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = startX + col * (cardWidth + spacing);
    const y = baseY + row * (cardHeight + 10);

    doc.save();
    doc.roundedRect(x, y, cardWidth, cardHeight, 10).fill('#f8fafc');
    doc.restore();
    doc.roundedRect(x, y, cardWidth, cardHeight, 10).stroke('#e2e8f0');

    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(card.label, x + 10, y + 10, {
      width: cardWidth - 20
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(card.highlight ? '#b91c1c' : '#0f172a')
      .text(card.value, x + 10, y + 28, { width: cardWidth - 20 });
  });

  const rows = Math.ceil(cards.length / columns);
  doc.y = baseY + rows * (cardHeight + 10);
}

function renderIncomeAndBalance(doc, metrics, startX, width) {
  const gap = 16;
  const tableWidth = (width - gap) / 2;
  const topY = doc.y;

  const ingresosRows = [
    { label: 'Efectivo', value: formatCurrency(metrics.totalEfectivo) },
    { label: 'Tarjeta', value: formatCurrency(metrics.totalTarjeta) },
    { label: 'Transferencia', value: formatCurrency(metrics.totalTransferencia) },
    {
      label: 'Total ingresos',
      value: formatCurrency(metrics.totalIngresos),
      bold: true
    }
  ];

  if (metrics.efectivoUsd > 0) {
    ingresosRows.splice(1, 0, {
      label: 'Efectivo USD',
      value: formatCurrencyUsd(metrics.efectivoUsd)
    });
  }

  const balanceRows = [
    { label: 'Saldo inicial', value: formatCurrency(metrics.saldoInicial) },
    { label: '+ Ventas', value: formatCurrency(metrics.totalVentas) }
  ];

  if (metrics.totalVentasUsd > 0) {
    balanceRows.push({ label: '+ Ventas USD', value: formatCurrencyUsd(metrics.totalVentasUsd) });
  }

  balanceRows.push({ label: '- Salidas', value: formatCurrency(metrics.totalSalidas) });
  balanceRows.push({ label: 'Efectivo esperado', value: formatCurrency(metrics.efectivoEsperado), bold: true });

  if (metrics.efectivoEsperadoUsd > 0) {
    balanceRows.push({ label: 'Efectivo esperado USD', value: formatCurrencyUsd(metrics.efectivoEsperadoUsd) });
  }

  balanceRows.push({
    label: 'Efectivo contado',
    value: metrics.efectivoDeclarado != null ? formatCurrency(metrics.efectivoDeclarado) : '—'
  });

  balanceRows.push({
    label: 'Diferencia',
    value: metrics.diferencia != null ? formatCurrency(metrics.diferencia) : '—',
    highlight: true
  });

  const leftEnd = drawKeyValueTable(doc, 'Ingresos por medio', ingresosRows, startX, topY, tableWidth);
  const rightEnd = drawKeyValueTable(
    doc,
    'Balance del cierre',
    balanceRows,
    startX + tableWidth + gap,
    topY,
    tableWidth
  );

  doc.y = Math.max(leftEnd, rightEnd);
}

function drawKeyValueTable(doc, title, rows, x, y, width) {
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#0f172a')
    .text(title, x, y, { width });
  let cursor = y + 18;

  rows.forEach((row) => {
    doc.save();
    doc.roundedRect(x, cursor - 6, width, 24, 6).stroke('#e2e8f0');
    doc.restore();
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text(row.label, x + 10, cursor, {
      width: width * 0.55 - 12
    });
    doc
      .font(row.bold || row.highlight ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(10)
      .fillColor(row.highlight ? '#b91c1c' : '#0f172a')
      .text(row.value, x + width * 0.55, cursor, { width: width * 0.45 - 12, align: 'right' });
    cursor += 24;
  });

  return cursor;
}

function renderSalidasSection(doc, salidas, startX, width) {
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Salidas registradas', startX, doc.y);
  doc.moveDown(0.4);

  if (!salidas.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text('No se registraron salidas en este cierre.', startX);
    return;
  }

  const columnWidths = [30, 130, width - 30 - 130 - 110, 110];
  const headerY = doc.y;

  doc.save();
  doc.rect(startX, headerY, width, 22).fill('#0f172a');
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  let headerX = startX;
  ['#', 'Fecha', 'Descripción', 'Monto'].forEach((label, idx) => {
    doc.text(label, headerX + 6, headerY + 6, { width: columnWidths[idx] - 12 });
    headerX += columnWidths[idx];
  });

  doc.y = headerY + 22;

  salidas.forEach((salida, index) => {
    const rowHeight = 24;
    const rowY = doc.y;
    doc.rect(startX, rowY, width, rowHeight).stroke('#e2e8f0');
    let cellX = startX;

    doc.font('Helvetica').fontSize(9).fillColor('#0f172a').text(String(index + 1), cellX + 6, rowY + 6, {
      width: columnWidths[0] - 12
    });
    cellX += columnWidths[0];

    doc.text(formatDateTime(salida.fecha), cellX + 6, rowY + 6, { width: columnWidths[1] - 12 });
    cellX += columnWidths[1];

    doc.text(salida.descripcion || '-', cellX + 6, rowY + 6, { width: columnWidths[2] - 12 });
    cellX += columnWidths[2];

    doc.text(formatCurrency(salida.monto), cellX + 6, rowY + 6, {
      width: columnWidths[3] - 12,
      align: 'right'
    });

    doc.y = rowY + rowHeight;

    if (salida.observacion) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#475569')
        .text(`Nota: ${salida.observacion}`, startX + columnWidths[0] + columnWidths[1], doc.y + 2, {
          width: columnWidths[2] + columnWidths[3] - 12
        });
      doc.y += 14;
    }
  });
}

function buildCierreMetrics(cierre) {
  const saldoInicial = Number(
    cierre.saldo_inicial != null ? cierre.saldo_inicial : cierre.apertura?.saldo_inicial || 0
  );
  const totalVentas = Number(cierre.total_ventas || 0);
  const totalVentasUsd = Number(cierre.total_ventas_usd || 0);
  const totalEfectivo = Number(cierre.total_efectivo || 0);
  const efectivoUsd = Number(cierre.efectivo_usd || 0);
  const totalTarjeta = Number(cierre.total_tarjeta || 0);
  const totalTransferencia = Number(cierre.total_transferencia || 0);
  const totalSalidas = Number(cierre.total_salidas || 0);
  const totalIngresos = totalEfectivo + totalTarjeta + totalTransferencia;
  const efectivoEsperado = saldoInicial + totalEfectivo - totalSalidas;
  const efectivoEsperadoUsd = efectivoUsd;
  const efectivoDeclarado = cierre.efectivo_declarado != null ? Number(cierre.efectivo_declarado) : null;
  const diferencia =
    cierre.diferencia != null
      ? Number(cierre.diferencia)
      : efectivoDeclarado != null
        ? round(efectivoDeclarado - efectivoEsperado)
        : null;

  return {
    saldoInicial,
    totalVentas,
    totalVentasUsd,
    totalEfectivo,
    efectivoUsd,
    totalTarjeta,
    totalTransferencia,
    totalSalidas,
    totalIngresos,
    efectivoEsperado,
    efectivoEsperadoUsd,
    efectivoDeclarado,
    diferencia
  };
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = ensureDate(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

module.exports = router;


