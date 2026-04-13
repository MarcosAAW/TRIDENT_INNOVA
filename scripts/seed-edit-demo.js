#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const IDS = {
  usuarioAdmin: '11111111-1111-4111-8111-111111111111',
  sucursalCentral: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  notaPedidoEditable: 'dddd1111-2222-4333-8444-555555555555',
  detalleNotaPedidoEditable: 'dddd1111-2222-4333-8444-666666666666',
  presupuestoDemo: 'eeee1111-2222-4333-8444-555555555555',
  detallePresupuestoDemo: 'eeee1111-2222-4333-8444-666666666666'
};

async function getBaseRefs() {
  const usuario = await prisma.usuario.findUnique({ where: { id: IDS.usuarioAdmin } });
  const sucursal = await prisma.sucursal.findUnique({ where: { id: IDS.sucursalCentral } });
  const proveedor = await prisma.proveedor.findFirst({
    where: { deleted_at: null },
    orderBy: { created_at: 'asc' }
  });
  const cliente = await prisma.cliente.findFirst({
    where: { deleted_at: null },
    orderBy: { created_at: 'asc' }
  });
  const producto = await prisma.producto.findFirst({
    where: { deleted_at: null },
    orderBy: { created_at: 'asc' }
  });

  if (!usuario || !sucursal || !proveedor || !cliente || !producto) {
    throw new Error('Faltan datos base. Ejecuta primero los seeds principales antes del seed de edición.');
  }

  return { usuario, sucursal, proveedor, cliente, producto };
}

async function seedNotaPedidoEditable(refs) {
  await prisma.notaPedido.upsert({
    where: { id: IDS.notaPedidoEditable },
    update: {
      numero: 'NP-EDIT-DEMO',
      proveedorId: refs.proveedor.id,
      usuarioId: refs.usuario.id,
      sucursalId: refs.sucursal.id,
      fecha: new Date('2026-03-30T10:00:00.000Z'),
      estado: 'BORRADOR',
      tipo: 'GENERAL',
      equipo_destino: 'Dron demo editable',
      observaciones: 'Caso editable para validar scroll y edición móvil.',
      deleted_at: null
    },
    create: {
      id: IDS.notaPedidoEditable,
      numero: 'NP-EDIT-DEMO',
      proveedorId: refs.proveedor.id,
      usuarioId: refs.usuario.id,
      sucursalId: refs.sucursal.id,
      fecha: new Date('2026-03-30T10:00:00.000Z'),
      estado: 'BORRADOR',
      tipo: 'GENERAL',
      equipo_destino: 'Dron demo editable',
      observaciones: 'Caso editable para validar scroll y edición móvil.'
    }
  });

  await prisma.detalleNotaPedido.upsert({
    where: { id: IDS.detalleNotaPedidoEditable },
    update: {
      notaPedidoId: IDS.notaPedidoEditable,
      productoId: refs.producto.id,
      codigo_articulo: refs.producto.codigo_dji || refs.producto.sku || 'COD-DEMO',
      codigo_dji: refs.producto.codigo_dji || null,
      sku: refs.producto.sku || null,
      descripcion: refs.producto.nombre,
      cantidad: 2,
      equipo_destino: 'Dron demo editable',
      observacion: 'Item editable de prueba'
    },
    create: {
      id: IDS.detalleNotaPedidoEditable,
      notaPedidoId: IDS.notaPedidoEditable,
      productoId: refs.producto.id,
      codigo_articulo: refs.producto.codigo_dji || refs.producto.sku || 'COD-DEMO',
      codigo_dji: refs.producto.codigo_dji || null,
      sku: refs.producto.sku || null,
      descripcion: refs.producto.nombre,
      cantidad: 2,
      equipo_destino: 'Dron demo editable',
      observacion: 'Item editable de prueba'
    }
  });
}

async function seedPresupuestoDemo(refs) {
  await prisma.presupuesto.upsert({
    where: { id: IDS.presupuestoDemo },
    update: {
      numero: 'PRE-EDIT-DEMO',
      clienteId: refs.cliente.id,
      usuarioId: refs.usuario.id,
      sucursalId: refs.sucursal.id,
      fecha: new Date('2026-03-30T09:00:00.000Z'),
      validez_hasta: new Date('2026-04-15T00:00:00.000Z'),
      moneda: 'PYG',
      subtotal: 95000,
      descuento_total: 0,
      impuesto_total: 8636.36,
      total: 95000,
      total_moneda: null,
      estado: 'BORRADOR',
      notas: 'Presupuesto demo visible para pruebas del módulo.',
      deleted_at: null
    },
    create: {
      id: IDS.presupuestoDemo,
      numero: 'PRE-EDIT-DEMO',
      clienteId: refs.cliente.id,
      usuarioId: refs.usuario.id,
      sucursalId: refs.sucursal.id,
      fecha: new Date('2026-03-30T09:00:00.000Z'),
      validez_hasta: new Date('2026-04-15T00:00:00.000Z'),
      moneda: 'PYG',
      subtotal: 95000,
      descuento_total: 0,
      impuesto_total: 8636.36,
      total: 95000,
      estado: 'BORRADOR',
      notas: 'Presupuesto demo visible para pruebas del módulo.'
    }
  });

  await prisma.detallePresupuesto.upsert({
    where: { id: IDS.detallePresupuestoDemo },
    update: {
      presupuestoId: IDS.presupuestoDemo,
      productoId: refs.producto.id,
      cantidad: 1,
      precio_unitario: 95000,
      subtotal: 95000,
      iva_porcentaje: 10
    },
    create: {
      id: IDS.detallePresupuestoDemo,
      presupuestoId: IDS.presupuestoDemo,
      productoId: refs.producto.id,
      cantidad: 1,
      precio_unitario: 95000,
      subtotal: 95000,
      iva_porcentaje: 10
    }
  });
}

async function main() {
  console.log('Sembrando casos demo para edición...');
  const refs = await getBaseRefs();
  await seedNotaPedidoEditable(refs);
  await seedPresupuestoDemo(refs);
  console.log('Casos demo listos: nota de pedido editable y presupuesto demo visible.');
}

main()
  .catch((error) => {
    console.error('Error sembrando casos demo de edición:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });