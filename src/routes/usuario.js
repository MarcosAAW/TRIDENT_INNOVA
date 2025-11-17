const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { RolUsuario } = require('@prisma/client');
const prisma = require('../prismaClient');
const validate = require('../middleware/validate');

const router = express.Router();

const baseUsuarioSchema = {
  nombre: z.string().min(1, 'El nombre es obligatorio'),
  usuario: z.string().min(3, 'El usuario debe tener al menos 3 caracteres'),
  rol: z.nativeEnum(RolUsuario).default('VENDEDOR'),
  activo: z.coerce.boolean().optional()
};

const createUsuarioSchema = z.object({
  ...baseUsuarioSchema,
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres')
});

const updateUsuarioSchema = z.object({
  ...baseUsuarioSchema,
  password: z.string().min(6).optional()
}).partial({
  nombre: true,
  usuario: true,
  rol: true
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  rol: z.nativeEnum(RolUsuario).optional(),
  activo: z.coerce.boolean().optional(),
  include_deleted: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).optional()
}).partial();

function sanitizeUsuario(usuario) {
  if (!usuario) return null;
  const { password_hash, ...rest } = usuario;
  return rest;
}

function buildWhere(filters) {
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.rol) {
    where.rol = filters.rol;
  }

  if (typeof filters.activo === 'boolean') {
    where.activo = filters.activo;
  }

  if (filters.search) {
    const value = filters.search;
    where.OR = [
      { nombre: { contains: value, mode: 'insensitive' } },
      { usuario: { contains: value, mode: 'insensitive' } }
    ];
  }

  return where;
}

function handlePrismaError(err, res, fallbackMessage) {
  if (err?.code === 'P2002') {
    const field = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
    return res.status(409).json({ error: `Ya existe un registro con ese ${field || 'valor único'}` });
  }

  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Usuario no encontrado' });
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
    const [usuarios, total] = await Promise.all([
      prisma.usuario.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'desc' }
      }),
      prisma.usuario.count({ where })
    ]);

    res.json({
      data: usuarios.map(sanitizeUsuario),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar usuarios' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.params.id } });
    if (!usuario || usuario.deleted_at) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json(sanitizeUsuario(usuario));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

router.post('/', validate(createUsuarioSchema), async (req, res) => {
  try {
    const data = req.validatedBody;
    const hashed = await bcrypt.hash(data.password, 10);
    const created = await prisma.usuario.create({
      data: {
        nombre: data.nombre,
        usuario: data.usuario,
        password_hash: hashed,
        rol: data.rol,
        activo: data.activo ?? true
      }
    });
    res.status(201).json(sanitizeUsuario(created));
  } catch (err) {
    handlePrismaError(err, res, 'Error al crear usuario');
  }
});

router.put('/:id', validate(updateUsuarioSchema), async (req, res) => {
  const { id } = req.params;
  const data = req.validatedBody;

  try {
    const updateData = { ...data };
    delete updateData.password;

    if (data.password) {
      updateData.password_hash = await bcrypt.hash(data.password, 10);
    }

    const updated = await prisma.usuario.update({ where: { id }, data: updateData });
    res.json(sanitizeUsuario(updated));
  } catch (err) {
    handlePrismaError(err, res, 'Error al actualizar usuario');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await prisma.usuario.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date(), activo: false }
    });
    res.json({ ok: true, usuario: sanitizeUsuario(deleted) });
  } catch (err) {
    handlePrismaError(err, res, 'Error al eliminar usuario');
  }
});

module.exports = router;
