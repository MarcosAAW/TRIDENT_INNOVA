const { PrismaClient } = require('@prisma/client');

// Instancia única del cliente Prisma
const prisma = new PrismaClient();

module.exports = prisma;
