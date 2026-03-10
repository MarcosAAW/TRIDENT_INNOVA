#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

async function main() {
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.usuario.findUnique({ where: { usuario: 'admin' } });
    console.log('admin user:', admin);
    if (admin) {
      const memberships = await prisma.usuarioSucursal.findMany({ where: { usuarioId: admin.id } });
      console.log('sucursales:', memberships);
      console.log('matches admin123?', await bcrypt.compare('admin123', admin.password_hash || ''));
      console.log('matches admin?', await bcrypt.compare('admin', admin.password_hash || ''));
    }
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();