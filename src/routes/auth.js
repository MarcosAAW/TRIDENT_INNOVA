const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../prismaClient');

const router = express.Router();

const loginSchema = z.object({
  usuario: z.string().min(1, 'El usuario es obligatorio'),
  password: z.string().min(1, 'La contraseña es obligatoria')
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Credenciales inválidas', detalles: parsed.error.flatten() });
  }

  const { usuario, password } = parsed.data;

  try {
    const record = await prisma.usuario.findUnique({ where: { usuario } });
    if (!record || record.deleted_at) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const valid = await bcrypt.compare(password, record.password_hash || '');
    if (!valid) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const memberships = await prisma.usuarioSucursal.findMany({
      where: { usuarioId: record.id },
      include: { sucursal: true }
    });

    const defaultMembership = memberships.find((item) => !item.sucursal?.deleted_at) || memberships[0] || null;

    const { password_hash, ...safeUser } = record;
    const usuarioRespuesta = {
      ...safeUser,
      sucursalId: defaultMembership?.sucursalId || null,
      sucursales:
        memberships.map((item) => ({
          sucursalId: item.sucursalId,
          nombre: item.sucursal?.nombre || null,
          rol: item.rol || null
        })) || []
    };

    res.json({
      message: 'Inicio de sesión exitoso',
      usuario: usuarioRespuesta
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al procesar la autenticación' });
  }
});

module.exports = router;
