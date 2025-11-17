// Middleware de manejo de errores centralizado
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('Unhandled error:', err && err.stack ? err.stack : err);

  // Errores de validación ya se manejan en middleware validate. Aquí formateamos otros errores.
  const status = err && err.statusCode ? err.statusCode : 500;
  const message = err && err.message ? err.message : 'Internal Server Error';

  // Si el error tiene detalles (por ejemplo, de Zod) incluirlos
  const details = err && err.details ? err.details : undefined;

  res.status(status).json({ ok: false, error: message, details });
}

module.exports = errorHandler;
