const { ZodError } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    try {
      // Parse request body (Zod will coerce/validate as configured)
      req.validatedBody = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.errors.map(e => ({ path: e.path.join('.'), message: e.message }));
        return res.status(400).json({ error: 'Validation error', details: issues });
      }
      next(err);
    }
  };
}

module.exports = validate;
