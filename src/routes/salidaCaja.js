const express = require('express');
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
    return base.refine(
      (val) => val >= minValue,
      { message: message || `El valor debe ser mayor o igual a ${minValue}.` }
    );
  }

  return base;
}

const createSalidaSchema = z.object({
  usuarioId: z.string().uuid(),
  descripcion: z.string().trim().min(3).max(200),
  monto: decimal(0.01, 'El monto debe ser mayor a cero.'),
  fecha: z.coerce.date().optional(),
  observacion: z.string().trim().max(400).optional(),
  cierreId: z.string().uuid().optional()
});

const listQuerySchema = z.object({
  cierreId: z.string().uuid().optional(),
  usuarioId: z.string().uuid().optional(),
  sin_cierre: z.coerce.boolean().optional(),
  fecha_desde: z.coerce.date().optional(),
  fecha_hasta: z.coerce.date().optional(),
  include_deleted: z.coerce.boolean().optional()
});

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor + Number.EPSILON) / factor;
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
  if (filters.cierreId) {
    where.cierreId = filters.cierreId;
  } else if (filters.sin_cierre) {
    where.cierreId = null;
  }
  if (filters.usuarioId) {
    where.usuarioId = filters.usuarioId;
  }
  if (filters.fecha_desde || filters.fecha_hasta) {
    where.fecha = {};
    if (filters.fecha_desde) {
      const from = new Date(filters.fecha_desde);
      from.setHours(0, 0, 0, 0);
      where.fecha.gte = from;
    }
    if (filters.fecha_hasta) {
      const to = new Date(filters.fecha_hasta);
      to.setHours(23, 59, 59, 999);
      where.fecha.lte = to;
    }
  }

  try {
    const salidas = await prisma.salidaCaja.findMany({
      where,
      include: {
        usuario: true,
        cierre: true
      },
      orderBy: { fecha: 'desc' }
    });

    const total = salidas.reduce((acc, salida) => acc + Number(salida.monto || 0), 0);

    res.json({
      data: serialize(salidas),
      meta: {
        total: salidas.length,
        montoTotal: round(total)
      }
    });
  } catch (error) {
    console.error('[salidaCaja] list', error);
    res.status(500).json({ error: 'No se pudieron listar las salidas.' });
  }
});

router.post('/', validate(createSalidaSchema), async (req, res) => {
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
        fecha: payload.fecha ? new Date(payload.fecha) : undefined,
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

      const sumaSalidas = round(Number(totalSalidas._sum.monto || 0));
      if (cierreActual) {
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
    console.error('[salidaCaja] create', error);
    res.status(500).json({ error: 'No se pudo registrar la salida de caja.' });
  }
});

module.exports = router;
