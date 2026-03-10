const { z } = require('zod');
const prisma = require('../prismaClient');

const sucursalIdSchema = z.string().uuid({ message: 'sucursalId inválido' });

async function requireSucursal(req, res, next) {
  if (!req.usuarioActual) {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }

  const raw =
    req.header('x-sucursal-id') ||
    req.query.sucursalId ||
    (req.body && req.body.sucursalId) ||
    req.query['sucursalId'];

  const parsed = sucursalIdSchema.safeParse(raw);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Debes indicar sucursalId (x-sucursal-id o query/body).' });
  }

  const sucursalId = parsed.data;

  try {
    const membership = await prisma.usuarioSucursal.findUnique({
      where: {
        usuarioId_sucursalId: {
          usuarioId: req.usuarioActual.id,
          sucursalId
        }
      }
    });

    if (!membership) {
      return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
    }

    req.sucursalId = sucursalId;
    return next();
  } catch (err) {
    console.error('[sucursalContext] Error verificando sucursal', err);
    return res.status(500).json({ error: 'No se pudo validar la sucursal.' });
  }
}

module.exports = {
  requireSucursal
};