#!/usr/bin/env node
require('dotenv').config();
const request = require('supertest');
const { app, prisma } = require('../src/app');

async function main() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://trident:tridentpass@localhost:5432/trident_db?schema=public';
  }

  await prisma.$connect();

  await prisma.detalleVenta.deleteMany();
  await prisma.movimientoStock.deleteMany();
  await prisma.venta.deleteMany();
  await prisma.producto.deleteMany();
  await prisma.categoria.deleteMany();

  const categoria = await prisma.categoria.create({
    data: { nombre: 'Test cat', descripcion: 'tmp' }
  });

  const createPayload = {
    sku: 'TEST-USD',
    nombre: 'Producto USD',
    tipo: 'DRON',
    precio_venta: 1000000,
    stock_actual: 10,
    categoriaId: categoria.id
  };

  const createRes = await request(app).post('/productos').send(createPayload);
  console.log('create status', createRes.status, createRes.body);

  const updatePayload = {
    nombre: 'Producto USD editado',
    precio_venta: 150,
    moneda_precio_venta: 'USD',
    tipo_cambio_precio_venta: 7300,
    stock_actual: 12
  };

  const updateRes = await request(app)
    .put(`/productos/${createRes.body.id}`)
    .send(updatePayload);
  console.log('update status', updateRes.status, updateRes.body);

  const stored = await prisma.producto.findUnique({ where: { id: createRes.body.id } });
  console.log('stored product', stored);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
