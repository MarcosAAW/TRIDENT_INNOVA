#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { runSeed } = require('./seed');

const prisma = new PrismaClient();

async function clearTables() {
  console.log('Limpiando tablas principales...');

  // Orden: primero dependencias, luego entidades para evitar FK
  const tables = [
    () => prisma.auditLog.deleteMany(),
    () => prisma.reciboDetalle.deleteMany(),
    () => prisma.recibo.deleteMany(),
    () => prisma.pago.deleteMany(),
    () => prisma.detalleVenta.deleteMany(),
    () => prisma.detalleCompra.deleteMany(),
    () => prisma.movimientoStock.deleteMany(),
    () => prisma.salidaCaja.deleteMany(),
    () => prisma.facturaDigital.deleteMany(),
    () => prisma.facturaElectronica.deleteMany(),
    () => prisma.venta.deleteMany(),
    () => prisma.cierreCaja.deleteMany(),
    () => prisma.aperturaCaja.deleteMany(),
    () => prisma.compra.deleteMany(),
    () => prisma.producto.deleteMany(),
    () => prisma.usuarioSucursal.deleteMany(),
    () => prisma.usuario.deleteMany(),
    () => prisma.cliente.deleteMany(),
    () => prisma.proveedor.deleteMany(),
    () => prisma.categoria.deleteMany(),
    () => prisma.sucursal.deleteMany()
  ];

  for (const deleteFn of tables) {
    await deleteFn();
  }

  console.log('Tablas limpias.');
}

async function main() {
  await clearTables();
  console.log('Ejecutando seed...');
  await runSeed(prisma);
  console.log('Reset + seed finalizado.');
}

main()
  .catch((err) => {
    console.error('Error durante el reset:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
