const { PrismaClient } = require('@prisma/client');

// Instancia única del cliente Prisma; Prisma 7 requiere definir datasources en runtime
const prisma = new PrismaClient({
	datasources: {
		db: {
			url: process.env.DATABASE_URL,
		},
	},
});

module.exports = prisma;
