require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const SEED_IDS = {
  admin: '11111111-1111-4111-8111-111111111111',
  sucursalCentral: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
};

(async () => {
  const prisma = new PrismaClient();
  try {
    const hash = await bcrypt.hash('admin123', 10);

    const admin = await prisma.usuario.upsert({
      where: { id: SEED_IDS.admin },
      update: {
        nombre: 'Administrador',
        usuario: 'admin',
        password_hash: hash,
        rol: 'ADMIN',
        activo: true,
        deleted_at: null
      },
      create: {
        id: SEED_IDS.admin,
        nombre: 'Administrador',
        usuario: 'admin',
        password_hash: hash,
        rol: 'ADMIN'
      }
    });

    const sucursal = await prisma.sucursal.upsert({
      where: { id: SEED_IDS.sucursalCentral },
      update: {
        nombre: 'Casa Central',
        ciudad: 'Asuncion',
        deleted_at: null
      },
      create: {
        id: SEED_IDS.sucursalCentral,
        nombre: 'Casa Central',
        ciudad: 'Asuncion'
      }
    });

    await prisma.usuarioSucursal.upsert({
      where: {
        usuarioId_sucursalId: {
          usuarioId: admin.id,
          sucursalId: sucursal.id
        }
      },
      update: {
        rol: 'ADMIN'
      },
      create: {
        usuarioId: admin.id,
        sucursalId: sucursal.id,
        rol: 'ADMIN'
      }
    });

    console.log('Usuario admin listo (admin/admin123) con sucursal Casa Central');
  } catch (err) {
    console.error('Error sembrando usuario admin:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
