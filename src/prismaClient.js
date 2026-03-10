const { PrismaClient } = require('@prisma/client');

// Prisma 7: inyectamos la URL al constructor
const prisma = new PrismaClient({
	datasourceUrl: process.env.DATABASE_URL,
});

module.exports = prisma;
