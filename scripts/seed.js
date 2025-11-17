#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const SEED_IDS = {
  admin: '11111111-1111-4111-8111-111111111111',
  categoriaDrones: '22222222-2222-4222-8222-222222222222',
  categoriaRepuestos: '33333333-3333-4333-8333-333333333333',
  clienteDemo: '44444444-4444-4444-8444-444444444444',
  clienteFinal: '55555555-5555-4555-8555-555555555555',
  ventaDemo: '66666666-6666-4666-8666-666666666666',
  movEntradaDron: '77777777-7777-4777-8777-777777777777',
  movSalidaDron: '88888888-8888-4888-8888-888888888888',
  movEntradaRepuesto: '99999999-9999-4999-8999-999999999999',
  aperturaCajaDemo: 'aaaa0000-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  cierreCajaDemo: 'aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  salidaCajaProveedor: 'bbbb2222-cccc-4ddd-8eee-ffffffffffff',
  salidaCajaViaticos: 'cccc3333-dddd-4eee-8fff-aaaaaaaaaaaa'
};

async function runSeed(prisma) {
  console.log('Iniciando seed de datos básicos...');

  const adminPassword = await bcrypt.hash('changeme', 10);

  const admin = await prisma.usuario.upsert({
    where: { id: SEED_IDS.admin },
    update: {
      nombre: 'Administrador',
      usuario: 'admin',
      password_hash: adminPassword,
      rol: 'ADMIN',
      activo: true,
      deleted_at: null
    },
    create: {
      id: SEED_IDS.admin,
      nombre: 'Administrador',
      usuario: 'admin',
      password_hash: adminPassword,
      rol: 'ADMIN'
    }
  });

  const categorias = await Promise.all([
    prisma.categoria.upsert({
      where: { id: SEED_IDS.categoriaDrones },
      update: {},
      create: {
        id: SEED_IDS.categoriaDrones,
        nombre: 'Drones',
        descripcion: 'Equipo principal de vuelo'
      }
    }),
    prisma.categoria.upsert({
      where: { id: SEED_IDS.categoriaRepuestos },
      update: {},
      create: {
        id: SEED_IDS.categoriaRepuestos,
        nombre: 'Repuestos',
        descripcion: 'Componentes y repuestos'
      }
    })
  ]);

  const clientes = await Promise.all([
    prisma.cliente.upsert({
      where: { id: SEED_IDS.clienteDemo },
      update: {},
      create: {
        id: SEED_IDS.clienteDemo,
        nombre_razon_social: 'Cliente Demo S.A.',
        ruc: '80000001-0',
        direccion: 'Av. Siempre Viva 123',
        telefono: '021-555-000',
        correo: 'facturacion@demo.com'
      }
    }),
    prisma.cliente.upsert({
      where: { id: SEED_IDS.clienteFinal },
      update: {},
      create: {
        id: SEED_IDS.clienteFinal,
        nombre_razon_social: 'Consumidor Final',
        direccion: 'Sin dirección'
      }
    })
  ]);

  const productos = await Promise.all([
    prisma.producto.upsert({
      where: { sku: 'DRON-001' },
      update: {},
      create: {
        sku: 'DRON-001',
        nombre: 'Dron Profesional',
        tipo: 'DRON',
        precio_venta: 2500000,
        stock_actual: 9,
        categoria: { connect: { id: categorias[0].id } }
      }
    }),
    prisma.producto.upsert({
      where: { sku: 'REP-001' },
      update: {},
      create: {
        sku: 'REP-001',
        nombre: 'Juego de hélices',
        tipo: 'REPUESTO',
        precio_venta: 120000,
        stock_actual: 25,
        categoria: { connect: { id: categorias[1].id } }
      }
    })
  ]);

  const venta = await prisma.venta.upsert({
    where: { id: SEED_IDS.ventaDemo },
    update: {},
    create: {
      id: SEED_IDS.ventaDemo,
      usuario: { connect: { id: admin.id } },
      cliente: { connect: { id: clientes[0].id } },
      subtotal: 2500000,
      total: 2500000,
      estado: 'COMPLETADA',
      detalles: {
        create: [{
          productoId: productos[0].id,
          cantidad: 1,
          precio_unitario: 2500000,
          subtotal: 2500000
        }]
      }
    }
  });

  await prisma.movimientoStock.createMany({
    data: [
      {
        id: SEED_IDS.movEntradaDron,
        productoId: productos[0].id,
        tipo: 'ENTRADA',
        cantidad: 10,
        motivo: 'Stock inicial',
        referencia_id: 'seed-inicial',
        referencia_tipo: 'Seed'
      },
      {
        id: SEED_IDS.movSalidaDron,
        productoId: productos[0].id,
        tipo: 'SALIDA',
        cantidad: 1,
        motivo: 'Venta seed',
        referencia_id: venta.id,
        referencia_tipo: 'Venta'
      },
      {
        id: SEED_IDS.movEntradaRepuesto,
        productoId: productos[1].id,
        tipo: 'ENTRADA',
        cantidad: 30,
        motivo: 'Stock inicial',
        referencia_id: 'seed-inicial',
        referencia_tipo: 'Seed'
      }
    ],
    skipDuplicates: true
  });

  const fechaApertura = new Date();
  fechaApertura.setHours(8, 30, 0, 0);
  const cierreHora = new Date();
  cierreHora.setHours(18, 15, 0, 0);

  const salidasSeed = [
    {
      id: SEED_IDS.salidaCajaProveedor,
      descripcion: 'Pago de proveedor de repuestos',
      monto: 200000,
      fecha: cierreHora
    },
    {
      id: SEED_IDS.salidaCajaViaticos,
      descripcion: 'Viáticos de mensajería',
      monto: 100000,
      fecha: cierreHora
    }
  ];

  const totalSalidas = salidasSeed.reduce((acc, item) => acc + item.monto, 0);
  const totalEfectivo = 2500000;
  const efectivoDeclarado = 2200000;
  const saldoInicial = 0;

  const aperturaCaja = await prisma.aperturaCaja.upsert({
    where: { id: SEED_IDS.aperturaCajaDemo },
    update: {
      usuarioId: admin.id,
      fecha_apertura: fechaApertura,
      fecha_cierre: cierreHora,
      saldo_inicial: saldoInicial,
      observaciones: 'Apertura demo generada por seed',
      deleted_at: null
    },
    create: {
      id: SEED_IDS.aperturaCajaDemo,
      usuario: { connect: { id: admin.id } },
      fecha_apertura: fechaApertura,
      fecha_cierre: cierreHora,
      saldo_inicial: saldoInicial,
      observaciones: 'Apertura demo generada por seed'
    }
  });

  const cierre = await prisma.cierreCaja.upsert({
    where: { id: SEED_IDS.cierreCajaDemo },
    update: {
      usuarioId: admin.id,
      aperturaId: aperturaCaja.id,
      saldo_inicial: saldoInicial,
      fecha_apertura: fechaApertura,
      fecha_cierre: cierreHora,
      total_ventas: 2500000,
      total_efectivo: totalEfectivo,
      total_tarjeta: 0,
      total_transferencia: 0,
      total_salidas: totalSalidas,
      efectivo_declarado: efectivoDeclarado,
      diferencia: efectivoDeclarado - ((saldoInicial + totalEfectivo) - totalSalidas),
      observaciones: 'Cierre demo generado por seed',
      deleted_at: null
    },
    create: {
      id: SEED_IDS.cierreCajaDemo,
      usuario: { connect: { id: admin.id } },
      apertura: { connect: { id: aperturaCaja.id } },
      saldo_inicial: saldoInicial,
      fecha_apertura: fechaApertura,
      fecha_cierre: cierreHora,
      total_ventas: 2500000,
      total_efectivo: totalEfectivo,
      total_tarjeta: 0,
      total_transferencia: 0,
      total_salidas: totalSalidas,
      efectivo_declarado: efectivoDeclarado,
      diferencia: efectivoDeclarado - ((saldoInicial + totalEfectivo) - totalSalidas),
      observaciones: 'Cierre demo generado por seed'
    }
  });

  for (const salida of salidasSeed) {
    await prisma.salidaCaja.upsert({
      where: { id: salida.id },
      update: {
        cierreId: cierre.id,
        usuarioId: admin.id,
        descripcion: salida.descripcion,
        monto: salida.monto,
        fecha: salida.fecha,
        observacion: null,
        deleted_at: null
      },
      create: {
        id: salida.id,
        cierre: { connect: { id: cierre.id } },
        usuario: { connect: { id: admin.id } },
        descripcion: salida.descripcion,
        monto: salida.monto,
        fecha: salida.fecha
      }
    });
  }

  console.log('Seed completado.');
  console.table([
    { recurso: 'Usuario', detalle: admin.usuario },
    ...categorias.map((c) => ({ recurso: 'Categoría', detalle: c.nombre })),
    ...clientes.map((c) => ({ recurso: 'Cliente', detalle: c.nombre_razon_social })),
    ...productos.map((p) => ({ recurso: 'Producto', detalle: `${p.sku} (${p.stock_actual} uds)` })),
    { recurso: 'Apertura de caja', detalle: aperturaCaja.id },
    { recurso: 'Venta', detalle: `Venta demo ${venta.id}` },
    { recurso: 'Cierre de caja', detalle: cierre.id },
    ...salidasSeed.map((salida) => ({ recurso: 'Salida de caja', detalle: `${salida.descripcion} (${salida.monto} Gs)` }))
  ]);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  runSeed(prisma)
    .catch((err) => {
      console.error('Error durante el seed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = { runSeed };
