const { PrismaClient } = require('@prisma/client');

// Prisma 7 requiere la URL de datasource fuera del schema; la tomamos del entorno
const prisma = new PrismaClient({
	datasourceUrl: process.env.DATABASE_URL,
});

module.exports = prisma;
