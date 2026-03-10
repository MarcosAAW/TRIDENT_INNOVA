require('dotenv').config();

// Fuerza desactivar SIFEN para la prueba contra FactPy
process.env.SIFEN_ENABLE = process.env.SIFEN_ENABLE || 'false';

const { PrismaClient, Prisma } = require('@prisma/client');
const request = require('supertest');
const { app } = require('../src/app');

const prisma = new PrismaClient();

const sucursalId = '11111111-1111-1111-1111-111111111111';
const usuarioId = '22222222-2222-2222-2222-222222222222';
const productoId = '33333333-3333-3333-3333-333333333333';
const producto2Id = '44444444-4444-4444-4444-444444444444';
const clienteId = '55555555-5555-5555-5555-555555555555';
const usarUsd = true;
const tipoCambioUsd = Number(process.env.FACTPY_TC || process.env.FACTPY_TIPO_CAMBIO || 7300); // TC configurable por env
const creditoMode = String(process.env.FACTPY_CREDITO_MODE || 'plazo').toLowerCase(); // plazo | cuotas

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function buildCreditoPayload(total) {
  const fechaBase = new Date();
  const fechaVencimiento = addDays(fechaBase, 30).toISOString().slice(0, 10);

  if (creditoMode === 'cuotas') {
    const montoCuota = Math.round((Number(total) || 0) / 3);
    return {
      condicion_pago: 'CREDITO',
      fecha_vencimiento: fechaVencimiento,
      credito: {
        tipo: 'CUOTAS',
        cantidad_cuotas: 3,
        cuotas: [1, 2, 3].map((num) => ({
          numero: num,
          monto: montoCuota,
          fecha_vencimiento: addDays(fechaBase, num * 30).toISOString().slice(0, 10)
        }))
      }
    };
  }

  return {
    condicion_pago: 'CREDITO',
    fecha_vencimiento: fechaVencimiento,
    credito: {
      tipo: 'PLAZO',
      descripcion: '30 dias'
    }
  };
}

async function ensureData() {
  const sucursal = await prisma.sucursal.upsert({
    where: { id: sucursalId },
    update: { nombre: 'Sucursal FactPy Demo' },
    create: { id: sucursalId, nombre: 'Sucursal FactPy Demo', ciudad: 'Test', direccion: '', telefono: '' }
  });

  const usuario = await prisma.usuario.upsert({
    where: { id: usuarioId },
    update: { nombre: 'Usuario FactPy', usuario: 'factpy_user' },
    create: {
      id: usuarioId,
      nombre: 'Usuario FactPy',
      usuario: 'factpy_user',
      password_hash: 'hash',
      rol: 'ADMIN'
    }
  });

  await prisma.usuarioSucursal.upsert({
    where: { usuarioId_sucursalId: { usuarioId, sucursalId } },
    update: {},
    create: { usuarioId, sucursalId, rol: 'ADMIN' }
  });

  const cliente = await prisma.cliente.upsert({
    where: { id: clienteId },
    update: { nombre_razon_social: 'Cliente Demo RUC', ruc: '80132959-0', correo: 'demo@tridentinnova.com' },
    create: {
      id: clienteId,
      nombre_razon_social: 'Cliente Demo RUC',
      ruc: '80132959-0',
      correo: 'demo@tridentinnova.com',
      telefono: '0981000000',
      direccion: 'Obligado, Itapúa'
    }
  });

  let producto;
  try {
    producto = await prisma.producto.upsert({
      where: { id: productoId },
      update: { nombre: 'Producto Demo', sku: 'FACTPY-DEMO', precio_venta: new Prisma.Decimal(10000), stock_actual: 10 },
      create: {
        id: productoId,
        nombre: 'Producto Demo',
        sku: 'FACTPY-DEMO',
        tipo: 'DRON',
        precio_venta: new Prisma.Decimal(10000),
        stock_actual: 10
      }
    });
  } catch (err) {
    if (err.code === 'P2002') {
      producto = await prisma.producto.update({
        where: { sku: 'FACTPY-DEMO' },
        data: { nombre: 'Producto Demo', precio_venta: new Prisma.Decimal(10000), stock_actual: 10 }
      });
    } else {
      throw err;
    }
  }

  await prisma.producto.upsert({
    where: { id: producto2Id },
    update: { nombre: 'Servicio Demo', sku: 'FACTPY-SRV', precio_venta: new Prisma.Decimal(55000), stock_actual: 5 },
    create: {
      id: producto2Id,
      nombre: 'Servicio Demo',
      sku: 'FACTPY-SRV',
      tipo: 'SERVICIO',
      precio_venta: new Prisma.Decimal(55000),
      stock_actual: 5
    }
  });

  return { sucursal, usuario, producto, cliente };
}

async function main() {
  const { cliente } = await ensureData();

  const headers = { 'x-user-id': usuarioId, 'x-sucursal-id': sucursalId };

  const ventaRes = await request(app)
    .post('/ventas')
    .set(headers)
    .send({
      usuarioId,
      clienteId: cliente.id,
      iva_porcentaje: 10,
      moneda: usarUsd ? 'USD' : 'PYG',
      tipo_cambio: usarUsd ? tipoCambioUsd : undefined,
      detalles: [
        { productoId, cantidad: 1 },
        { productoId: producto2Id, cantidad: 2 }
      ]
    });

  console.log('Venta status', ventaRes.status, 'id', ventaRes.body?.id);
  if (ventaRes.status !== 201) {
    console.log('Venta error', ventaRes.body);
    return;
  }

  const ventaId = ventaRes.body.id;
  const factRes = await request(app)
    .post(`/ventas/${ventaId}/facturar`)
    .set(headers)
    .send(buildCreditoPayload(ventaRes.body.total));

  console.log('Facturar status', factRes.status);
  console.log('Factura estado', factRes.body?.factura?.estado);
  console.log('Factura pdf', factRes.body?.factura?.pdf_path);
  console.log('Factura xml', factRes.body?.factura?.xml_path);
  console.log('Respuesta FactPy', factRes.body?.factura?.respuesta_set);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });