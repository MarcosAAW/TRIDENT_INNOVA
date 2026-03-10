const express = require('express');
const prisma = require('../prismaClient');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const { z } = require('zod');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireAuth, authorizeRoles('ADMIN'));

const baseSchema = {
  nombre: z.string().trim().min(1, 'El nombre es obligatorio'),
  ciudad: z.string().trim().optional(),
  direccion: z.string().trim().optional(),
  telefono: z.string().trim().optional()
};

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
  include_deleted: z.coerce.boolean().optional()
}).partial();

const createSchema = z.object(baseSchema);
const updateSchema = z.object(baseSchema).partial();

function sanitizeSucursalPayload(data = {}) {
  const payload = { ...data };
  if (typeof payload.nombre === 'string') payload.nombre = payload.nombre.trim();
  if (typeof payload.ciudad === 'string') payload.ciudad = payload.ciudad.trim();
  if (typeof payload.direccion === 'string') payload.direccion = payload.direccion.trim();
  if (typeof payload.telefono === 'string') payload.telefono = payload.telefono.trim();
  return payload;
}

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const { page = 1, pageSize = 20, include_deleted, search } = parsed.data;
  const where = {};

  if (!include_deleted) {
    where.deleted_at = null;
  }

  if (search) {
    where.OR = [
      { nombre: { contains: search, mode: 'insensitive' } },
      { ciudad: { contains: search, mode: 'insensitive' } },
      { direccion: { contains: search, mode: 'insensitive' } }
    ];
  }

  try {
    const [sucursales, total] = await Promise.all([
      prisma.sucursal.findMany({
        where,
        orderBy: { nombre: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.sucursal.count({ where })
    ]);

    res.json({
      data: sucursales,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (error) {
    console.error('[sucursal] list', error);
    res.status(500).json({ error: 'No se pudieron listar las sucursales.' });
  }
});

router.post('/', validate(createSchema), async (req, res) => {
  try {
    const data = sanitizeSucursalPayload(req.validatedBody);
    const created = await prisma.sucursal.create({ data });
    res.status(201).json(created);
  } catch (error) {
    console.error('[sucursal] create', error);
    res.status(500).json({ error: 'No se pudo crear la sucursal.' });
  }
});

router.put('/:id', validate(updateSchema), async (req, res) => {
  const { id } = req.params;
  try {
    if (!req.validatedBody || Object.keys(req.validatedBody).length === 0) {
      return res.status(400).json({ error: 'No se enviaron datos para actualizar.' });
    }
    const existing = await prisma.sucursal.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    const data = sanitizeSucursalPayload(req.validatedBody);
    const updated = await prisma.sucursal.update({ where: { id }, data });
    res.json(updated);
  } catch (error) {
    console.error('[sucursal] update', error);
    res.status(500).json({ error: 'No se pudo actualizar la sucursal.' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.sucursal.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    const deleted = await prisma.sucursal.update({ where: { id }, data: { deleted_at: new Date() } });
    res.json({ ok: true, sucursal: deleted });
  } catch (error) {
    console.error('[sucursal] delete', error);
    res.status(500).json({ error: 'No se pudo eliminar la sucursal.' });
  }
});

module.exports = router;
