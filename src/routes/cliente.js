const express = require('express');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { z } = require('zod');
const validate = require('../middleware/validate');

const baseClienteSchema = {
  nombre_razon_social: z.string().min(1, 'El nombre o razón social es obligatorio'),
  ruc: z.string().trim().min(3).optional(),
  direccion: z.string().trim().optional(),
  telefono: z.string().trim().optional(),
  correo: z.string().email().optional(),
  tipo_cliente: z.string().trim().optional()
};

const createClienteSchema = z.object(baseClienteSchema);
const updateClienteSchema = createClienteSchema.partial();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  search: z.string().trim().min(1).optional(),
  tipo_cliente: z.string().trim().optional(),
  include_deleted: z.coerce.boolean().optional()
}).partial();

function buildWhere(filters) {
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.tipo_cliente) {
    where.tipo_cliente = filters.tipo_cliente;
  }

  if (filters.search) {
    const search = filters.search;
    where.OR = [
      { nombre_razon_social: { contains: search, mode: 'insensitive' } },
      { ruc: { contains: search, mode: 'insensitive' } },
      { correo: { contains: search, mode: 'insensitive' } }
    ];
  }

  return where;
}

function handlePrismaError(err, res, fallbackMessage) {
  if (err?.code === 'P2002') {
    const field = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
    return res.status(409).json({ error: `Ya existe un cliente con ese ${field || 'valor único'}` });
  }

  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Cliente no encontrado' });
  }

  console.error(err);
  return res.status(500).json({ error: fallbackMessage });
}

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  const { page = 1, pageSize = 20, ...filters } = parsed.data;
  const where = buildWhere(filters);

  try {
    const [clientes, total] = await Promise.all([
      prisma.cliente.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'desc' }
      }),
      prisma.cliente.count({ where })
    ]);

    res.json({
      data: serialize(clientes),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar clientes' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const cliente = await prisma.cliente.findUnique({ where: { id: req.params.id } });
    if (!cliente || cliente.deleted_at) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json(serialize(cliente));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener cliente' });
  }
});

router.post('/', validate(createClienteSchema), async (req, res) => {
  try {
    const created = await prisma.cliente.create({ data: req.validatedBody });
    res.status(201).json(serialize(created));
  } catch (err) {
    handlePrismaError(err, res, 'Error al crear cliente');
  }
});

router.put('/:id', validate(updateClienteSchema), async (req, res) => {
  try {
    const data = { ...req.validatedBody };
    delete data.id;
    const updated = await prisma.cliente.update({ where: { id: req.params.id }, data });
    res.json(serialize(updated));
  } catch (err) {
    handlePrismaError(err, res, 'Error al actualizar cliente');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await prisma.cliente.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    res.json({ ok: true, cliente: serialize(deleted) });
  } catch (err) {
    handlePrismaError(err, res, 'Error al eliminar cliente');
  }
});

module.exports = router;
