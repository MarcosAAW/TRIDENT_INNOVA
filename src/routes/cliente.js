const express = require('express');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');

// Permite RUC con guion (0000000-0) o solo números si tipo_cliente es CONSUMIDOR_FINAL
const rucSchema = z.string().trim().toUpperCase().optional().or(z.literal(''));


const baseClienteSchema = {
  nombre_razon_social: z.string({ required_error: 'El nombre o razón social es obligatorio' })
    .trim()
    .min(3, 'El nombre o razón social es obligatorio')
    .max(120, 'El nombre o razón social es demasiado largo'),
  ruc: rucSchema,
  direccion: z.string({ required_error: 'La dirección es obligatoria' })
    .trim()
    .min(3, 'La dirección es obligatoria'),
  telefono: z.string().trim().optional(),
  correo: z.string().email('Correo inválido').optional(),
  tipo_cliente: z.string().trim().optional()
};

const createClienteSchema = z.object(baseClienteSchema);
const updateClienteSchema = createClienteSchema.partial();

router.use(requireAuth, requireSucursal);

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

const { authorizeRoles } = require('../middleware/authContext');

// Crear cliente
router.post('/', authorizeRoles('ADMIN', 'VENDEDOR'), validate(createClienteSchema), async (req, res) => {
  try {
    let { ruc, tipo_cliente } = req.validatedBody;
    ruc = ruc ? ruc.trim().toUpperCase() : '';
    tipo_cliente = tipo_cliente ? tipo_cliente.trim().toLowerCase().replace(/[_\s]+/g, ' ') : '';

    // Validar RUC según tipo_cliente
    if (ruc) {
      if (["consumidor final", "cliente ocasional"].includes(tipo_cliente)) {
        if (!/^\d{5,9}$/.test(ruc) && !/^\d{5,}-[0-9A-Z]$/.test(ruc)) {
          return res.status(400).json({ error: 'Para CONSUMIDOR FINAL o CLIENTE OCASIONAL, el CI debe ser solo números (5 a 9 dígitos) o RUC válido (0000000-0)' });
        }
      } else {
        if (!/^\d{5,}-[0-9A-Z]$/.test(ruc)) {
          return res.status(400).json({ error: 'Formato de RUC inválido (usa 0000000-0)' });
        }
      }
    }

    const data = {
      ...req.validatedBody,
      nombre_razon_social: req.validatedBody.nombre_razon_social.trim(),
      ruc: ruc || null,
      direccion: req.validatedBody.direccion.trim(),
      sucursalId: null
    };
    const created = await prisma.cliente.create({ data });
    res.status(201).json(serialize(created));
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.errors.map(e => e.message).join('; ');
      return res.status(400).json({ error: msg });
    }
    handlePrismaError(err, res, 'Error al crear cliente');
  }
});

// Actualizar cliente
router.put('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), validate(updateClienteSchema), async (req, res) => {
  try {
    let { ruc, tipo_cliente } = req.validatedBody;
    ruc = ruc ? ruc.trim().toUpperCase() : '';
    tipo_cliente = tipo_cliente ? tipo_cliente.trim().toLowerCase().replace(/[_\s]+/g, ' ') : '';

    // Validar RUC según tipo_cliente
    if (ruc) {
      if (["consumidor final", "cliente ocasional"].includes(tipo_cliente)) {
        if (!/^\d{5,9}$/.test(ruc) && !/^\d{5,}-[0-9A-Z]$/.test(ruc)) {
          return res.status(400).json({ error: 'Para CONSUMIDOR FINAL o CLIENTE OCASIONAL, el CI debe ser solo números (5 a 9 dígitos) o RUC válido (0000000-0)' });
        }
      } else {
        if (!/^\d{5,}-[0-9A-Z]$/.test(ruc)) {
          return res.status(400).json({ error: 'Formato de RUC inválido (usa 0000000-0)' });
        }
      }
    }

    const data = { ...req.validatedBody };
    delete data.id;
    if (data.nombre_razon_social) data.nombre_razon_social = data.nombre_razon_social.trim();
    data.ruc = ruc || null;
    if (data.direccion) data.direccion = data.direccion.trim();
    const existing = await prisma.cliente.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    const updated = await prisma.cliente.update({ where: { id: req.params.id }, data });
    res.json(serialize(updated));
  } catch (err) {
    handlePrismaError(err, res, 'Error al actualizar cliente');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await prisma.cliente.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    // Verificar ventas activas
    const ventas = await prisma.venta.count({ where: { clienteId: req.params.id, deleted_at: null } });
    if (ventas > 0) {
      return res.status(400).json({ error: 'No se puede eliminar un cliente con ventas activas.' });
    }
    const deleted = await prisma.cliente.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    res.json({ ok: true, cliente: serialize(deleted) });
  } catch (err) {
    handlePrismaError(err, res, 'Error al eliminar cliente');
  }
});

module.exports = router;
