#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const EDIT_DEMO_IDS = {
  notaPedido: 'dddd1111-2222-4333-8444-555555555555',
  detalleNotaPedido: 'dddd1111-2222-4333-8444-666666666666',
  presupuesto: 'eeee1111-2222-4333-8444-555555555555',
  detallePresupuesto: 'eeee1111-2222-4333-8444-666666666666'
};

function hasExecuteFlag() {
  return process.argv.includes('--execute');
}

async function collectTargets() {
  const [productos, clientes, proveedores, notaPedido, presupuesto] = await Promise.all([
    prisma.producto.findMany({
      where: {
        OR: [
          { sku: { startsWith: 'PAG-DEMO-' } },
          { nombre: { startsWith: 'Producto demo paginación ' } }
        ]
      },
      select: { id: true, sku: true }
    }),
    prisma.cliente.findMany({
      where: {
        OR: [
          { ruc: { startsWith: '80991' } },
          { correo: { endsWith: '@demo.local' } },
          { nombre_razon_social: { startsWith: 'Cliente demo paginación ' } }
        ]
      },
      select: { id: true, ruc: true }
    }),
    prisma.proveedor.findMany({
      where: {
        OR: [
          { ruc: { startsWith: '80981' } },
          { correo: { endsWith: '@demo.local' } },
          { nombre_razon_social: { startsWith: 'Proveedor demo paginación ' } }
        ]
      },
      select: { id: true, ruc: true }
    }),
    prisma.notaPedido.findUnique({
      where: { id: EDIT_DEMO_IDS.notaPedido },
      select: { id: true, numero: true }
    }),
    prisma.presupuesto.findUnique({
      where: { id: EDIT_DEMO_IDS.presupuesto },
      select: { id: true, numero: true }
    })
  ]);

  return {
    productos,
    clientes,
    proveedores,
    notaPedido,
    presupuesto
  };
}

function printSummary(targets) {
  console.log('Resumen de datos demo detectados:');
  console.log(`- Productos demo paginación: ${targets.productos.length}`);
  console.log(`- Clientes demo paginación: ${targets.clientes.length}`);
  console.log(`- Proveedores demo paginación: ${targets.proveedores.length}`);
  console.log(`- Nota de pedido demo edición: ${targets.notaPedido ? 1 : 0}`);
  console.log(`- Presupuesto demo edición: ${targets.presupuesto ? 1 : 0}`);
}

async function cleanupTargets(targets) {
  const productoIds = targets.productos.map((item) => item.id);
  const clienteIds = targets.clientes.map((item) => item.id);
  const proveedorIds = targets.proveedores.map((item) => item.id);

  await prisma.$transaction(async (tx) => {
    if (targets.presupuesto) {
      await tx.detallePresupuesto.deleteMany({
        where: {
          OR: [
            { presupuestoId: targets.presupuesto.id },
            { id: EDIT_DEMO_IDS.detallePresupuesto }
          ]
        }
      });
      await tx.presupuesto.deleteMany({
        where: {
          OR: [
            { id: targets.presupuesto.id },
            { numero: 'PRE-EDIT-DEMO' }
          ]
        }
      });
    }

    if (targets.notaPedido) {
      await tx.detalleNotaPedido.deleteMany({
        where: {
          OR: [
            { notaPedidoId: targets.notaPedido.id },
            { id: EDIT_DEMO_IDS.detalleNotaPedido }
          ]
        }
      });
      await tx.notaPedido.deleteMany({
        where: {
          OR: [
            { id: targets.notaPedido.id },
            { numero: 'NP-EDIT-DEMO' }
          ]
        }
      });
    }

    if (productoIds.length) {
      await tx.producto.deleteMany({
        where: { id: { in: productoIds } }
      });
    }

    if (clienteIds.length) {
      await tx.cliente.deleteMany({
        where: { id: { in: clienteIds } }
      });
    }

    if (proveedorIds.length) {
      await tx.proveedor.deleteMany({
        where: { id: { in: proveedorIds } }
      });
    }
  });
}

async function main() {
  const execute = hasExecuteFlag();
  const targets = await collectTargets();

  printSummary(targets);

  if (!execute) {
    console.log('Modo simulación: no se eliminó ningún registro. Usa --execute para aplicar la limpieza.');
    return;
  }

  await cleanupTargets(targets);
  console.log('Limpieza completada.');
}

main()
  .catch((error) => {
    console.error('Error limpiando datos demo:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });