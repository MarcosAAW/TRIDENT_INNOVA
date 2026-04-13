#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SUCURSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CATEGORIA_DRONES_ID = '22222222-2222-4222-8222-222222222222';
const CATEGORIA_REPUESTOS_ID = '33333333-3333-4333-8333-333333333333';

function buildRuc(prefix, index) {
  const padded = String(index).padStart(4, '0');
  return `${prefix}${padded}-0`;
}

async function ensureBaseData() {
  await prisma.sucursal.upsert({
    where: { id: SUCURSAL_ID },
    update: { nombre: 'Casa Central', ciudad: 'Asuncion', deleted_at: null },
    create: { id: SUCURSAL_ID, nombre: 'Casa Central', ciudad: 'Asuncion' }
  });

  await prisma.categoria.upsert({
    where: { id: CATEGORIA_DRONES_ID },
    update: { deleted_at: null },
    create: { id: CATEGORIA_DRONES_ID, nombre: 'Drones', descripcion: 'Equipo principal de vuelo' }
  });

  await prisma.categoria.upsert({
    where: { id: CATEGORIA_REPUESTOS_ID },
    update: { deleted_at: null },
    create: { id: CATEGORIA_REPUESTOS_ID, nombre: 'Repuestos', descripcion: 'Componentes y repuestos' }
  });
}

async function seedProductos() {
  const jobs = [];
  for (let index = 1; index <= 24; index += 1) {
    const sku = `PAG-DEMO-${String(index).padStart(3, '0')}`;
    const isDrone = index % 2 === 1;
    jobs.push(
      prisma.producto.upsert({
        where: { sku },
        update: {
          nombre: `Producto demo paginación ${index}`,
          tipo: isDrone ? 'DRON' : 'REPUESTO',
          precio_venta: 45000 + index * 2750,
          precio_compra: 22000 + index * 1500,
          stock_actual: 4 + (index % 9),
          minimo_stock: 2,
          activo: true,
          deleted_at: null,
          sucursalId: SUCURSAL_ID,
          categoriaId: isDrone ? CATEGORIA_DRONES_ID : CATEGORIA_REPUESTOS_ID
        },
        create: {
          sku,
          nombre: `Producto demo paginación ${index}`,
          descripcion: `Registro demo ${index} para probar navegación y paginación móvil.`,
          tipo: isDrone ? 'DRON' : 'REPUESTO',
          precio_venta: 45000 + index * 2750,
          precio_compra: 22000 + index * 1500,
          stock_actual: 4 + (index % 9),
          minimo_stock: 2,
          activo: true,
          sucursalId: SUCURSAL_ID,
          categoriaId: isDrone ? CATEGORIA_DRONES_ID : CATEGORIA_REPUESTOS_ID
        }
      })
    );
  }
  await Promise.all(jobs);
}

async function seedClientes() {
  const jobs = [];
  for (let index = 1; index <= 18; index += 1) {
    const ruc = buildRuc('80991', index);
    jobs.push(
      prisma.cliente.upsert({
        where: { ruc },
        update: {
          nombre_razon_social: `Cliente demo paginación ${index}`,
          direccion: `Av. Demo ${index * 10}`,
          telefono: `0981${String(100000 + index).slice(-6)}`,
          correo: `cliente${index}@demo.local`,
          sucursalId: SUCURSAL_ID,
          deleted_at: null
        },
        create: {
          nombre_razon_social: `Cliente demo paginación ${index}`,
          ruc,
          direccion: `Av. Demo ${index * 10}`,
          telefono: `0981${String(100000 + index).slice(-6)}`,
          correo: `cliente${index}@demo.local`,
          sucursalId: SUCURSAL_ID
        }
      })
    );
  }
  await Promise.all(jobs);
}

async function seedProveedores() {
  const jobs = [];
  for (let index = 1; index <= 12; index += 1) {
    const ruc = buildRuc('80981', index);
    jobs.push(
      prisma.proveedor.upsert({
        where: { ruc },
        update: {
          nombre_razon_social: `Proveedor demo paginación ${index}`,
          contacto: `Contacto ${index}`,
          telefono: `0972${String(200000 + index).slice(-6)}`,
          correo: `proveedor${index}@demo.local`,
          deleted_at: null
        },
        create: {
          nombre_razon_social: `Proveedor demo paginación ${index}`,
          ruc,
          contacto: `Contacto ${index}`,
          direccion: `Ruta demo km ${index}`,
          telefono: `0972${String(200000 + index).slice(-6)}`,
          correo: `proveedor${index}@demo.local`
        }
      })
    );
  }
  await Promise.all(jobs);
}

async function main() {
  console.log('Sembrando datos demo para paginación...');
  await ensureBaseData();
  await seedProductos();
  await seedClientes();
  await seedProveedores();
  console.log('Datos demo de paginación listos: 24 productos, 18 clientes y 12 proveedores.');
}

main()
  .catch((error) => {
    console.error('Error sembrando datos demo de paginación:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });