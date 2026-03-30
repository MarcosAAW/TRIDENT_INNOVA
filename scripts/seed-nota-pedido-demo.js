#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SUCURSAL_CENTRAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function ensureSucursal() {
  return prisma.sucursal.upsert({
    where: { id: SUCURSAL_CENTRAL_ID },
    update: {
      nombre: 'Casa Central',
      ciudad: 'Asuncion',
      deleted_at: null
    },
    create: {
      id: SUCURSAL_CENTRAL_ID,
      nombre: 'Casa Central',
      ciudad: 'Asuncion'
    }
  });
}

async function ensureCategoria(nombre, descripcion) {
  const existente = await prisma.categoria.findFirst({
    where: { nombre },
    orderBy: { created_at: 'asc' }
  });

  if (existente) {
    return prisma.categoria.update({
      where: { id: existente.id },
      data: {
        descripcion,
        deleted_at: null
      }
    });
  }

  return prisma.categoria.create({
    data: {
      nombre,
      descripcion
    }
  });
}

async function ensureProveedor(sucursal) {
  const data = {
    nombre_razon_social: 'Proveedor AeroPartes Demo SRL',
    ruc: '80123456-7',
    contacto: 'Mario Benitez',
    direccion: 'Ruta Transchaco km 12, Asuncion',
    telefono: '0981 555 100',
    correo: 'compras@aeropartes-demo.com',
    deleted_at: null
  };

  const existente = await prisma.proveedor.findUnique({
    where: { ruc: data.ruc }
  });

  if (existente) {
    return prisma.proveedor.update({
      where: { id: existente.id },
      data
    });
  }

  return prisma.proveedor.create({ data });
}

async function ensureCliente(sucursal) {
  const data = {
    nombre_razon_social: 'Cliente Demo Agro SRL',
    ruc: '80987654-3',
    direccion: 'Av. Aviadores del Chaco 2450, Asuncion',
    telefono: '0982 444 200',
    correo: 'logistica@cliente-demo.com',
    tipo_cliente: 'EMPRESA',
    sucursalId: sucursal.id,
    deleted_at: null
  };

  const existente = await prisma.cliente.findUnique({
    where: { ruc: data.ruc }
  });

  if (existente) {
    return prisma.cliente.update({
      where: { id: existente.id },
      data
    });
  }

  return prisma.cliente.create({ data });
}

async function ensureProducto(data) {
  return prisma.producto.upsert({
    where: { sku: data.sku },
    update: {
      ...data,
      deleted_at: null,
      activo: true
    },
    create: {
      ...data,
      activo: true
    }
  });
}

async function main() {
  const sucursal = await ensureSucursal();
  const categoriaDrones = await ensureCategoria('Drones', 'Equipos principales de vuelo');
  const categoriaRepuestos = await ensureCategoria('Repuestos', 'Partes y accesorios para drones');

  const proveedor = await ensureProveedor(sucursal);
  const cliente = await ensureCliente(sucursal);

  const productos = await Promise.all([
    ensureProducto({
      sku: 'DRON-M3E-001',
      nombre: 'Dron DJI Mavic 3 Enterprise',
      descripcion: 'Dron demo para relevamiento y operaciones tecnicas.',
      tipo: 'DRON',
      precio_venta: '28500000.00',
      precio_compra: '24800000.00',
      stock_actual: 2,
      codigo_dji: 'DJI-M3E-001',
      codigo_barra: '7801000000011',
      categoriaId: categoriaDrones.id,
      sucursalId: sucursal.id,
      unidad: 'unidad',
      minimo_stock: 1
    }),
    ensureProducto({
      sku: 'DRON-M4P-001',
      nombre: 'Dron DJI Mini 4 Pro',
      descripcion: 'Dron demo liviano para inspeccion y video.',
      tipo: 'DRON',
      precio_venta: '9800000.00',
      precio_compra: '8400000.00',
      stock_actual: 3,
      codigo_dji: 'DJI-M4P-001',
      codigo_barra: '7801000000012',
      categoriaId: categoriaDrones.id,
      sucursalId: sucursal.id,
      unidad: 'unidad',
      minimo_stock: 1
    }),
    ensureProducto({
      sku: 'REP-M3E-HELICE',
      nombre: 'Helice DJI Mavic 3 Enterprise',
      descripcion: 'Juego de helices de reemplazo para Mavic 3 Enterprise.',
      tipo: 'REPUESTO',
      precio_venta: '350000.00',
      precio_compra: '240000.00',
      stock_actual: 12,
      codigo_dji: 'DJI-PROP-M3E',
      codigo_barra: '7801000000013',
      categoriaId: categoriaRepuestos.id,
      sucursalId: sucursal.id,
      unidad: 'juego',
      minimo_stock: 4
    }),
    ensureProducto({
      sku: 'REP-M4P-BAT',
      nombre: 'Bateria DJI Mini 4 Pro',
      descripcion: 'Bateria inteligente para DJI Mini 4 Pro.',
      tipo: 'REPUESTO',
      precio_venta: '920000.00',
      precio_compra: '760000.00',
      stock_actual: 8,
      codigo_dji: 'DJI-BAT-M4P',
      codigo_barra: '7801000000014',
      categoriaId: categoriaRepuestos.id,
      sucursalId: sucursal.id,
      unidad: 'unidad',
      minimo_stock: 2
    })
  ]);

  console.log('Datos demo de nota de pedido listos:');
  console.log(`- Proveedor: ${proveedor.nombre_razon_social} (${proveedor.ruc || 'sin RUC'})`);
  console.log(`- Cliente: ${cliente.nombre_razon_social} (${cliente.ruc || 'sin RUC'})`);
  for (const producto of productos) {
    console.log(`- Producto [${producto.tipo}]: ${producto.sku} - ${producto.nombre}`);
  }
}

main()
  .catch((error) => {
    console.error('Error sembrando datos demo de nota de pedido:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });