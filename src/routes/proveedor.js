const express = require('express');
const { z } = require('zod');

const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const validate = require('../middleware/validate');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');

const router = express.Router();

const rucSchema = z.string().trim().toUpperCase().optional().or(z.literal(''));

const baseProveedorSchema = {
  nombre_razon_social: z.string({ required_error: 'El nombre o razón social es obligatorio' })
    .trim()
    .min(3, 'El nombre o razón social es obligatorio')
    .max(120, 'El nombre o razón social es demasiado largo'),
  ruc: rucSchema,
  contacto: z.string().trim().optional(),
  direccion: z.string().trim().optional(),
  telefono: z.string().trim().optional(),
  correo: z.string().email('Correo inválido').optional().or(z.literal(''))
};

const createProveedorSchema = z.object(baseProveedorSchema);
const updateProveedorSchema = createProveedorSchema.partial();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  search: z.string().trim().min(1).optional(),
  include_deleted: z.coerce.boolean().optional()
}).partial();

router.use(requireAuth, requireSucursal);

function buildWhere(filters) {
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.search) {
    const search = filters.search;
    where.OR = [
      { nombre_razon_social: { contains: search, mode: 'insensitive' } },
      { ruc: { contains: search, mode: 'insensitive' } },
      { contacto: { contains: search, mode: 'insensitive' } },
      { correo: { contains: search, mode: 'insensitive' } }
    ];
  }

  return where;
}

function handlePrismaError(err, res, fallbackMessage) {
  if (err?.code === 'P2002') {
    const field = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
    return res.status(409).json({ error: `Ya existe un proveedor con ese ${field || 'valor único'}` });
  }

  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Proveedor no encontrado' });
  }

  console.error(err);
  return res.status(500).json({ error: fallbackMessage });
}

function normalizeProveedorPayload(payload) {
  return {
    nombre_razon_social: payload.nombre_razon_social?.trim(),
    ruc: payload.ruc ? payload.ruc.trim().toUpperCase() : null,
    contacto: payload.contacto ? payload.contacto.trim() : null,
    direccion: payload.direccion ? payload.direccion.trim() : null,
    telefono: payload.telefono ? payload.telefono.trim() : null,
    correo: payload.correo ? payload.correo.trim().toLowerCase() : null
  };
}

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const { page = 1, pageSize = 20, ...filters } = parsed.data;
  const where = buildWhere(filters);

  try {
    const [proveedores, total] = await Promise.all([
      prisma.proveedor.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { nombre_razon_social: 'asc' }
      }),
      prisma.proveedor.count({ where })
    ]);

    return res.json({
      data: serialize(proveedores),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al listar proveedores' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const proveedor = await prisma.proveedor.findUnique({ where: { id: req.params.id } });
    if (!proveedor || proveedor.deleted_at) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    return res.json(serialize(proveedor));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al obtener proveedor' });
  }
});

router.post('/', authorizeRoles('ADMIN', 'VENDEDOR'), validate(createProveedorSchema), async (req, res) => {
  try {
    const proveedor = await prisma.proveedor.create({ data: normalizeProveedorPayload(req.validatedBody) });
    return res.status(201).json(serialize(proveedor));
  } catch (err) {
    return handlePrismaError(err, res, 'Error al crear proveedor');
  }
});

router.put('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), validate(updateProveedorSchema), async (req, res) => {
  try {
    const existing = await prisma.proveedor.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    const proveedor = await prisma.proveedor.update({
      where: { id: req.params.id },
      data: normalizeProveedorPayload({ ...existing, ...req.validatedBody })
    });

    return res.json(serialize(proveedor));
  } catch (err) {
    return handlePrismaError(err, res, 'Error al actualizar proveedor');
  }
});

router.delete('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  try {
    const existing = await prisma.proveedor.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Proveedor no encontrado' });
    }

    const [comprasActivas, notasActivas] = await Promise.all([
      prisma.compra.count({ where: { proveedorId: req.params.id, deleted_at: null } }),
      prisma.notaPedido.count({ where: { proveedorId: req.params.id, deleted_at: null } })
    ]);

    if (comprasActivas > 0 || notasActivas > 0) {
      return res.status(400).json({ error: 'No se puede eliminar un proveedor con compras o notas de pedido activas.' });
    }

    const deleted = await prisma.proveedor.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date() }
    });

    return res.json({ ok: true, proveedor: serialize(deleted) });
  } catch (err) {
    return handlePrismaError(err, res, 'Error al eliminar proveedor');
  }
});

module.exports = router;