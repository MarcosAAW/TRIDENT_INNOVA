const { PrismaClient } = require('@prisma/client');

// Usa configuración por defecto; DATABASE_URL se toma del entorno
const prisma = new PrismaClient();

module.exports = prisma;
