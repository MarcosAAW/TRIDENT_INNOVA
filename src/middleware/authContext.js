const prisma = require('../prismaClient');

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

async function attachUser(req, _res, next) {
  const userId = req.header('x-user-id');
  if (!userId) {
    return next();
  }

  try {
    const user = await prisma.usuario.findUnique({ where: { id: userId } });
    if (user && !user.deleted_at && user.activo !== false) {
      req.usuarioActual = sanitizeUser(user);
    }
  } catch (error) {
    console.error('[authContext] No se pudo cargar el usuario de la sesión.', error);
  }

  return next();
}

function requireAuth(req, res, next) {
  if (!req.usuarioActual) {
    return res.status(401).json({ error: 'Sesión inválida o expirada. Volvé a iniciar sesión.' });
  }
  return next();
}

function authorizeRoles(...roles) {
  const allowed = roles.map((role) => String(role || '').toUpperCase());
  return (req, res, next) => {
    if (!req.usuarioActual) {
      return res.status(401).json({ error: 'Sesión inválida o expirada. Volvé a iniciar sesión.' });
    }
    if (!allowed.length) {
      return next();
    }
    const currentRole = String(req.usuarioActual.rol || '').toUpperCase();
    if (!allowed.includes(currentRole)) {
      return res.status(403).json({ error: 'No tenés permisos para esta acción.' });
    }
    return next();
  };
}

module.exports = {
  attachUser,
  requireAuth,
  authorizeRoles
};
