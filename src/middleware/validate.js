const { ZodError } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    try {
      // Parse request body (Zod will coerce/validate as configured)
      req.validatedBody = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        // Unir todos los mensajes de error en uno solo, separados por punto y coma
        const msg = err.errors.map(e => e.message).join('; ');
        const issues = err.errors.map(e => ({ path: e.path.join('.'), message: e.message }));
        return res.status(400).json({ error: msg, details: issues });
      }
      next(err);
    }
  };
}

module.exports = validate;
