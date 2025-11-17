const express = require('express');
const { z } = require('zod');
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const validate = require('../middleware/validate');

const router = express.Router();

const MAX_DECIMAL_VALUE = 10_000_000_000;

const decimalRequired = (min = 0) =>
  z
    .preprocess((value) => {
      if (value === null || value === undefined || value === '') return undefined;
      return value;
    }, z.coerce.number({ invalid_type_error: 'Debe ser un número válido', required_error: 'El campo es obligatorio.' }))
    .refine((value) => Number.isFinite(value), { message: 'Debe ser un número válido.' })
    .refine((value) => value >= min, { message: `Debe ser mayor o igual a ${min}.` });

const decimalOptional = (min = 0) =>
  z
    .preprocess((value) => {
      if (value === null || value === undefined || value === '') return undefined;
      return value;
    }, z.coerce.number({ invalid_type_error: 'Debe ser un número válido' }))
    .refine((value) => Number.isFinite(value), { message: 'Debe ser un número válido.' })
    .refine((value) => value >= min, { message: `Debe ser mayor o igual a ${min}.` })
    .optional();

const optionalDate = z
  .preprocess((value) => {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }, z.date({ invalid_type_error: 'Fecha inválida' }))
  .optional();

const salidaInputSchema = z.object({
  descripcion: z.string().trim().min(3, 'Describí la salida de dinero.'),
  monto: decimalRequired(0),
  fecha: optionalDate,
  observacion: z.string().trim().max(300).optional()
});

const salidaSchema = salidaInputSchema.extend({
  usuarioId: z.string().uuid({ message: 'Usuario no identificado.' }),
  cierreId: z.string().uuid().optional()
});

const cierreQuerySchema = z.object({
  usuarioId: z.string().uuid().optional(),
  fecha_desde: optionalDate,
  fecha_hasta: optionalDate,
  search: z.string().trim().min(1).optional(),
  include_deleted: z.coerce.boolean().optional()
});

const salidaQuerySchema = z.object({
  usuarioId: z.string().uuid().optional(),
  cierreId: z.string().uuid().optional(),
  sin_cierre: z.coerce.boolean().optional(),
  fecha_desde: optionalDate,
  fecha_hasta: optionalDate,
  include_deleted: z.coerce.boolean().optional()
});

const createCierreSchema = z.object({
  usuarioId: z.string().uuid({ message: 'Usuario no identificado.' }),
  fecha_apertura: optionalDate,
  fecha_cierre: optionalDate,
  total_ventas: decimalRequired(0),
  total_efectivo: decimalRequired(0),
  total_tarjeta: decimalOptional(0),
  total_transferencia: decimalOptional(0),
  total_salidas: decimalOptional(0),
  efectivo_declarado: decimalOptional(0),
  observaciones: z.string().trim().max(500).optional(),
  salidas: z.array(salidaInputSchema).optional()
});

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor + Number.EPSILON) / factor;
}

function ensureWithinLimit(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} debe ser un número válido.`);
  }
  if (Math.abs(value) > MAX_DECIMAL_VALUE) {
    throw new Error(`${label} supera el máximo permitido.`);
  }
}

router.get('/cierres', async (req, res) => {
  const parsed = cierreQuerySchema.safeParse(req.query);
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

  if (filters.search) {
    where.OR = [
      { observaciones: { contains: filters.search, mode: 'insensitive' } },
      { usuario: { nombre: { contains: filters.search, mode: 'insensitive' } } },
      { usuario: { usuario: { contains: filters.search, mode: 'insensitive' } } }
    ];
  }

  if (filters.fecha_desde || filters.fecha_hasta) {
    const fechaRange = {};
    if (filters.fecha_desde) {
      const start = new Date(filters.fecha_desde);
      start.setHours(0, 0, 0, 0);
      fechaRange.gte = start;
    }
    if (filters.fecha_hasta) {
      const end = new Date(filters.fecha_hasta);
      end.setHours(23, 59, 59, 999);
      fechaRange.lte = end;
    }
    where.fecha_cierre = fechaRange;
  }

  try {
    const cierres = await prisma.cierreCaja.findMany({
      where,
      include: {
        usuario: true,
        salidas: true
      },
      orderBy: { fecha_cierre: 'desc' }
    });

    const serialized = serialize(cierres);
    const total = serialized.length;
    const totales = serialized.reduce(
      (acc, item) => {
        acc.total_ventas += Number(item.total_ventas || 0);
        acc.total_salidas += Number(item.total_salidas || 0);
        acc.diferencia += Number(item.diferencia || 0);
        return acc;
      },
      { total_ventas: 0, total_salidas: 0, diferencia: 0 }
    );

    return res.json({
      data: serialized,
      meta: {
        total,
        page: 1,
        pageSize: total,
        totalPages: 1,
        totales
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No se pudieron listar los cierres de caja.' });
  }
});

router.get('/cierres/:id', async (req, res) => {
  const idSchema = z.object({ id: z.string().uuid({ message: 'Identificador inválido' }) });
  const parsed = idSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Identificador inválido.' });
  }

  try {
    const cierre = await prisma.cierreCaja.findUnique({
      where: { id: parsed.data.id },
      include: {
        usuario: true,
        salidas: { include: { usuario: true } }
      }
    });

    if (!cierre) {
      return res.status(404).json({ error: 'Cierre no encontrado.' });
    }

    return res.json(serialize(cierre));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No se pudo obtener el detalle del cierre.' });
  }
});

router.post('/cierres', validate(createCierreSchema), async (req, res) => {
  const payload = req.validatedBody;
  const fechaApertura = payload.fecha_apertura ? new Date(payload.fecha_apertura) : null;
  const fechaCierre = payload.fecha_cierre ? new Date(payload.fecha_cierre) : new Date();

  const totalVentas = round(payload.total_ventas, 2);
  const totalEfectivo = round(payload.total_efectivo, 2);
  const totalTarjeta = payload.total_tarjeta !== undefined ? round(payload.total_tarjeta, 2) : null;
  const totalTransferencia = payload.total_transferencia !== undefined ? round(payload.total_transferencia, 2) : null;

  ensureWithinLimit(totalVentas, 'Total de ventas');
  ensureWithinLimit(totalEfectivo, 'Total en efectivo');
  if (totalTarjeta !== null) ensureWithinLimit(totalTarjeta, 'Total tarjeta');
  if (totalTransferencia !== null) ensureWithinLimit(totalTransferencia, 'Total transferencia');

  const salidasInput = Array.isArray(payload.salidas) ? payload.salidas : [];
  const totalSalidasManual = payload.total_salidas !== undefined ? round(payload.total_salidas, 2) : null;
  const totalSalidasCalculado = salidasInput.reduce((acc, salida) => acc + round(salida.monto, 2), 0);
  const totalSalidas = totalSalidasManual !== null ? totalSalidasManual : round(totalSalidasCalculado, 2);
  ensureWithinLimit(totalSalidas, 'Total de salidas');

  const efectivoDeclarado = payload.efectivo_declarado !== undefined ? round(payload.efectivo_declarado, 2) : null;
  if (efectivoDeclarado !== null) ensureWithinLimit(efectivoDeclarado, 'Efectivo declarado');

  const diferencia =
    efectivoDeclarado !== null
      ? round(efectivoDeclarado - (totalEfectivo - totalSalidas), 2)
      : null;
  if (diferencia !== null) ensureWithinLimit(diferencia, 'Diferencia');

  try {
    const cierre = await prisma.$transaction(async (tx) => {
      const created = await tx.cierreCaja.create({
        data: {
          usuarioId: payload.usuarioId,
          fecha_apertura: fechaApertura,
          fecha_cierre: fechaCierre,
          total_ventas: totalVentas,
          total_efectivo: totalEfectivo,
          total_tarjeta: totalTarjeta,
          total_transferencia: totalTransferencia,
          total_salidas: totalSalidas,
          efectivo_declarado: efectivoDeclarado,
          diferencia,
          observaciones: payload.observaciones || null
        }
      });

      if (salidasInput.length) {
        for (const salida of salidasInput) {
          const fechaSalida = salida.fecha ? new Date(salida.fecha) : fechaCierre;
          ensureWithinLimit(salida.monto, 'Monto de salida');
          await tx.salidaCaja.create({
            data: {
              cierreId: created.id,
              usuarioId: payload.usuarioId,
              descripcion: salida.descripcion,
              monto: round(salida.monto, 2),
              fecha: fechaSalida,
              observacion: salida.observacion || null
            }
          });
        }
      }

      return tx.cierreCaja.findUnique({
        where: { id: created.id },
        include: {
          usuario: true,
          salidas: { include: { usuario: true } }
        }
      });
    });

    return res.status(201).json(serialize(cierre));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No se pudo registrar el cierre de caja.' });
  }
});

router.get('/salidas', async (req, res) => {
  const parsed = salidaQuerySchema.safeParse(req.query);
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

  if (filters.cierreId) {
    where.cierreId = filters.cierreId;
  }

  if (filters.sin_cierre) {
    where.cierreId = null;
  }

  if (filters.fecha_desde || filters.fecha_hasta) {
    const rango = {};
    if (filters.fecha_desde) {
      const start = new Date(filters.fecha_desde);
      start.setHours(0, 0, 0, 0);
      rango.gte = start;
    }
    if (filters.fecha_hasta) {
      const end = new Date(filters.fecha_hasta);
      end.setHours(23, 59, 59, 999);
      rango.lte = end;
    }
    where.fecha = rango;
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

    const serialized = serialize(salidas);
    const total = serialized.length;
    const montoTotal = serialized.reduce((acc, item) => acc + Number(item.monto || 0), 0);

    return res.json({
      data: serialized,
      meta: {
        total,
        page: 1,
        pageSize: total,
        totalPages: 1,
        monto_total: montoTotal
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No se pudieron listar las salidas de caja.' });
  }
});

router.post('/salidas', validate(salidaSchema), async (req, res) => {
  const payload = req.validatedBody;
  const fechaSalida = payload.fecha ? new Date(payload.fecha) : new Date();
  const monto = round(payload.monto, 2);
  ensureWithinLimit(monto, 'Monto');

  try {
    const salida = await prisma.salidaCaja.create({
      data: {
        usuarioId: payload.usuarioId,
        cierreId: payload.cierreId || null,
        descripcion: payload.descripcion,
        monto,
        fecha: fechaSalida,
        observacion: payload.observacion || null
      },
      include: {
        usuario: true,
        cierre: true
      }
    });

    return res.status(201).json(serialize(salida));
  } catch (error) {
    console.error(error);
    if (error?.code === 'P2003') {
      return res.status(400).json({ error: 'No se pudo asociar la salida con el cierre indicado.' });
    }
    return res.status(500).json({ error: 'No se pudo registrar la salida de caja.' });
  }
});

module.exports = router;
