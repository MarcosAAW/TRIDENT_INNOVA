const express = require('express');
const { z } = require('zod');
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { requireAuth } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');

const router = express.Router();

function isEffectiveCreditNote(nota) {
  return Boolean(nota) && String(nota.estado || '').toUpperCase() !== 'RECHAZADO';
}

function hasEffectiveTotalCreditNote(venta) {
  const notas = Array.isArray(venta?.notas_credito) ? venta.notas_credito : [];
  return notas.some(
    (nota) => isEffectiveCreditNote(nota) && String(nota.tipo_ajuste || 'TOTAL').toUpperCase() === 'TOTAL'
  );
}

const createPagoSchema = z.object({
  ventaId: z.string().uuid({ message: 'ventaId inválido' }),
  monto: z.coerce.number().positive('El monto debe ser mayor a cero'),
  metodo: z.string().trim().min(1, 'El método es requerido'),
  referencia: z.string().trim().optional(),
  fecha_pago: z.coerce.date().optional()
});

const listQuerySchema = z.object({
  ventaId: z.string().uuid().optional()
});

router.use(requireAuth, requireSucursal);

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  const { ventaId } = parsed.data;

  try {
    const pagos = await prisma.pago.findMany({
      where: {
        sucursalId: req.sucursalId,
        ...(ventaId ? { ventaId } : {})
      },
      orderBy: { fecha_pago: 'desc' }
    });

    return res.json(serialize(pagos));
  } catch (err) {
    console.error('[Pagos] No se pudo listar los pagos.', err);
    return res.status(500).json({ error: 'No se pudieron obtener los pagos.' });
  }
});

router.post('/', async (req, res) => {
  const parsed = createPagoSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  const data = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const venta = await tx.venta.findFirst({
        where: { id: data.ventaId, sucursalId: req.sucursalId, deleted_at: null },
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

      if (!venta) {
        throw new Error('VENTA_NO_ENCONTRADA');
      }

      if (hasEffectiveTotalCreditNote(venta)) {
        throw new Error('VENTA_REGULARIZADA_CON_NC');
      }

      const pago = await tx.pago.create({
        data: {
          ventaId: venta.id,
          sucursalId: req.sucursalId,
          monto: data.monto,
          metodo: data.metodo,
          referencia: data.referencia || null,
          fecha_pago: data.fecha_pago || undefined
        }
      });

      const saldoPrevio = Number(venta.saldo_pendiente ?? venta.total ?? 0);
      const nuevoSaldo = Math.max(saldoPrevio - data.monto, 0);

      const ventaActualizada = await tx.venta.update({
        where: { id: venta.id },
        data: {
          saldo_pendiente: nuevoSaldo,
          es_credito: nuevoSaldo > 0 ? true : venta.es_credito,
          estado: nuevoSaldo <= 0 ? 'PAGADA' : venta.estado
        }
      });

      return { pago, venta: ventaActualizada };
    });

    return res.status(201).json({ pago: serialize(result.pago), venta: serialize(result.venta) });
  } catch (err) {
    if (err?.message === 'VENTA_NO_ENCONTRADA') {
      return res.status(404).json({ error: 'Venta no encontrada en esta sucursal.' });
    }
    if (err?.message === 'VENTA_REGULARIZADA_CON_NC') {
      return res.status(409).json({ error: 'La venta ya fue regularizada con una nota de crédito total.' });
    }
    console.error('[Pagos] No se pudo registrar el pago.', err);
    return res.status(500).json({ error: 'No se pudo registrar el pago.' });
  }
});

module.exports = router;
