const express = require('express');
const { z } = require('zod');
const { emitirFactura, consultarEstados } = require('../services/factpy/client');
const prisma = require('../prismaClient');
const { requireAuth } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');

const router = express.Router();

router.use(requireAuth, requireSucursal);

const emitSchema = z.object({
  dataJson: z.any(),
  recordID: z.string().trim().optional(),
  baseUrl: z.string().trim().url().optional()
});

const estadoSchema = z.object({
  receiptid: z.array(z.string().trim().min(1)).min(1),
  recordID: z.string().trim().optional(),
  baseUrl: z.string().trim().url().optional()
});

const pollSchema = z.object({
  receiptid: z.array(z.string().trim().min(1)).optional(),
  limit: z.number().int().positive().max(50).optional(),
  recordID: z.string().trim().optional(),
  baseUrl: z.string().trim().url().optional()
});

router.post('/emitir', async (req, res) => {
  const parsed = emitSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body invalido', detalles: parsed.error.flatten() });
  }

  try {
    const result = await emitirFactura({
      dataJson: parsed.data.dataJson,
      recordID: parsed.data.recordID,
      baseUrl: parsed.data.baseUrl
    });
    return res.json(result);
  } catch (err) {
    console.error('[FactPy] Error al emitir', err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message, detalle: err.body || null });
  }
});

router.post('/estado', async (req, res) => {
  const parsed = estadoSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body invalido', detalles: parsed.error.flatten() });
  }

  try {
    const result = await consultarEstados({
      receiptIds: parsed.data.receiptid,
      recordID: parsed.data.recordID,
      baseUrl: parsed.data.baseUrl
    });
    return res.json(result);
  } catch (err) {
    console.error('[FactPy] Error al consultar estado', err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message, detalle: err.body || null });
  }
});

router.post('/poll', async (req, res) => {
  const parsed = pollSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Body invalido', detalles: parsed.error.flatten() });
  }

  try {
    const pendientes = await prisma.facturaElectronica.findMany({
      where: {
        estado: { in: ['ENVIADO', 'PENDIENTE'] },
        sucursalId: req.sucursalId
      },
      orderBy: { updated_at: 'desc' },
      take: parsed.data.limit || 50
    });

    if (!pendientes.length) {
      return res.json({ status: 'ok', message: 'Sin facturas pendientes' });
    }

    const receiptIds = pendientes
      .map((f) => {
        const rid = f?.respuesta_set?.receiptid || f?.ventaId;
        return typeof rid === 'string' && rid.trim().length ? rid.trim() : null;
      })
      .filter(Boolean);

    const targets = parsed.data.receiptid && parsed.data.receiptid.length ? parsed.data.receiptid : receiptIds;

    const receiptIdsToQuery = targets.filter((rid) => typeof rid === 'string' && rid.trim().length);

    if (!receiptIdsToQuery.length) {
      return res.status(400).json({ error: 'No se encontraron receiptid para consultar.' });
    }

    const estados = await consultarEstados({
      receiptIds: receiptIdsToQuery,
      recordID: parsed.data.recordID,
      baseUrl: parsed.data.baseUrl
    });

    const updates = [];
    for (const doc of Array.isArray(estados) ? estados : []) {
      const rid = doc?.receiptid;
      if (!rid) continue;
      const match = pendientes.find(
        (f) => {
          const localRid = (f?.respuesta_set?.receiptid || f?.ventaId || '').trim();
          return localRid && localRid === String(rid).trim();
        }
      );
      if (!match) continue;

      const estadoLower = String(doc?.estado || '').toLowerCase();
      let estadoApp = 'ENVIADO';
      if (estadoLower.includes('aprob')) estadoApp = 'ACEPTADO';
      else if (estadoLower.includes('rechaz')) estadoApp = 'RECHAZADO';

      const mergedRespuesta = {
        ...(match.respuesta_set || {}),
        last_estado: doc,
        receiptid: match?.respuesta_set?.receiptid || match?.ventaId
      };

      const data = {
        estado: estadoApp,
        intentos: { increment: 1 },
        respuesta_set: mergedRespuesta
      };

      if (doc?.cdc && typeof doc.cdc === 'string' && doc.cdc.trim()) {
        data.qr_data = doc.cdc;
      }
      if (doc?.documento && typeof doc.documento === 'string' && doc.documento.trim() !== 'N/A') {
        data.nro_factura = doc.documento.trim();
      }

      updates.push(
        prisma.facturaElectronica.update({
          where: { id: match.id },
          data
        })
      );
    }

    const results = updates.length ? await prisma.$transaction(updates) : [];
    return res.json({
      status: 'ok',
      consultados: receiptIdsToQuery.length,
      actualizados: results.length,
      estados
    });
  } catch (err) {
    console.error('[FactPy] Error en poll', err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message, detalle: err.body || null });
  }
});

module.exports = router;
