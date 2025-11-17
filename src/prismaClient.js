const { PrismaClient } = require('@prisma/client');

// Crear una única instancia de PrismaClient para compartir en la app
const prisma = new PrismaClient();

module.exports = prisma;
