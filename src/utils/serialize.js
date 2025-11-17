// Helpers para serializar objetos devueltos por Prisma (Decimal, Date, etc.)
function serialize(obj) {
  return JSON.parse(JSON.stringify(obj, (_k, v) => {
    // Prisma Decimal y otros objetos con toJSON deben serializar bien.
    // Esta función asegura que (por si acaso) convertimos objetos con toNumber/toString.
    if (v && typeof v === 'object') {
      if (typeof v.toString === 'function' && typeof v.toNumber !== 'function') {
        // Dejar que toString se use en casos simples
        return v;
      }
    }
    return v;
  }));
}

module.exports = { serialize };
