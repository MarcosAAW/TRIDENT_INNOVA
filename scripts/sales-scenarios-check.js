#!/usr/bin/env node
require('dotenv').config();
const request = require('supertest');
const { app } = require('../src/app');
const prisma = require('../src/prismaClient');

function addDays(base, days) {
  const result = new Date(base.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

async function resolveContext() {
  let membership = await prisma.usuarioSucursal.findFirst({ include: { usuario: true, sucursal: true } });

  if (!membership) {
    const sucursal = await prisma.sucursal.create({ data: { nombre: 'Sucursal QA' } });
    const usuario = await prisma.usuario.create({
      data: {
        nombre: 'QA Bot',
        usuario: `qa.bot.${Date.now()}`,
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });

    membership = await prisma.usuarioSucursal.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: sucursal.id,
        rol: 'ADMIN'
      },
      include: { usuario: true, sucursal: true }
    });
  }

  let producto = await prisma.producto.findFirst({
    where: { deleted_at: null, stock_actual: { gt: 0 }, sucursalId: membership.sucursalId },
    orderBy: { updated_at: 'desc' }
  });

  if (!producto) {
    producto = await prisma.producto.create({
      data: {
        sku: `AUTO-${Date.now()}`,
        nombre: 'Producto QA',
        tipo: 'DRON',
        precio_venta: 1000000,
        precio_compra: 500000,
        stock_actual: 10,
        sucursalId: membership.sucursalId
      }
    });
  }

  let cliente = await prisma.cliente.findFirst({ where: { deleted_at: null } });
  if (!cliente) {
    cliente = await prisma.cliente.create({
      data: {
        nombre_razon_social: 'Cliente QA',
        ruc: `800-${Math.floor(Math.random() * 999999)}`,
        direccion: 'QA',
        telefono: '000000',
        sucursalId: membership.sucursalId
      }
    });
  }

  return {
    headers: {
      'x-user-id': membership.usuarioId,
      'x-sucursal-id': membership.sucursalId
    },
    usuario: membership.usuario,
    sucursal: membership.sucursal,
    cliente,
    producto
  };
}

function buildBaseVenta(ctx) {
  return {
    usuarioId: ctx.headers['x-user-id'],
    clienteId: ctx.cliente?.id,
    detalles: [{ productoId: ctx.producto.id, cantidad: 1 }],
    iva_porcentaje: 10
  };
}

async function createVenta(ctx, overrides) {
  const payload = { ...buildBaseVenta(ctx), ...overrides };
  const res = await request(app).post('/ventas').set(ctx.headers).send(payload);
  if (res.status !== 201) {
    throw new Error(`Venta falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function facturar(ctx, ventaId, body = {}) {
  const res = await request(app).post(`/ventas/${ventaId}/facturar`).set(ctx.headers).send(body);
  if (res.status !== 200) {
    throw new Error(`Facturar ${ventaId} falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function runScenario(ctx, scenario) {
  console.log(`\n[${scenario.name}] creando venta...`);
  const venta = await createVenta(ctx, scenario.ventaOverrides);
  console.log(`Venta OK -> ${venta.id} | total ${venta.total} ${venta.moneda}`);

  if (scenario.skipFacturar) {
    return { ventaId: venta.id, factura: null, facturaDigital: null };
  }

  console.log(`[${scenario.name}] facturando...`);
  const factura = await facturar(ctx, venta.id, scenario.facturarBody);
  const facturaElectronica = factura?.factura;
  const facturaDigital = factura?.venta?.factura_digital;
  console.log(`Factura OK -> ${facturaElectronica?.nro_factura || 'n/a'} | digital ${facturaDigital?.id}`);
  return { ventaId: venta.id, facturaElectronica, facturaDigital };
}

async function main() {
  await prisma.$connect();
  const ctx = await resolveContext();

  const vencimiento = addDays(new Date(), 15);

  const scenarios = [
    {
      name: 'contado-pyg-factura',
      ventaOverrides: { moneda: 'PYG', condicion_venta: 'CONTADO' }
    },
    {
      name: 'contado-usd-factura',
      ventaOverrides: { moneda: 'USD', condicion_venta: 'CONTADO', tipo_cambio: 7200 },
      facturarBody: { condicion_pago: 'CONTADO', moneda: 'USD', tipo_cambio: 7200 }
    },
    {
      name: 'credito-pyg-factura',
      ventaOverrides: {
        moneda: 'PYG',
        condicion_venta: 'CREDITO',
        fecha_vencimiento: vencimiento,
        credito: { tipo: 'PLAZO', fecha_vencimiento: vencimiento }
      },
      facturarBody: { condicion_pago: 'CREDITO', fecha_vencimiento: vencimiento }
    },
    {
      name: 'credito-usd-factura',
      ventaOverrides: {
        moneda: 'USD',
        condicion_venta: 'CREDITO',
        tipo_cambio: 7200,
        fecha_vencimiento: vencimiento,
        credito: { tipo: 'PLAZO', fecha_vencimiento: vencimiento }
      },
      facturarBody: { condicion_pago: 'CREDITO', moneda: 'USD', tipo_cambio: 7200, fecha_vencimiento: vencimiento }
    },
    {
      name: 'ticket-pyg',
      ventaOverrides: { moneda: 'PYG', condicion_venta: 'CONTADO', estado: 'TICKET' },
      skipFacturar: true
    }
  ];

  const results = [];
  for (const scenario of scenarios) {
    try {
      const outcome = await runScenario(ctx, scenario);
      results.push({ name: scenario.name, ok: true, ...outcome });
    } catch (err) {
      console.error(`[${scenario.name}] fallo:`, err.message);
      results.push({ name: scenario.name, ok: false, error: err.message });
    }
  }

  console.log('\nResumen final:');
  for (const r of results) {
    if (r.ok) {
      console.log(`✔ ${r.name}: venta ${r.ventaId}` + (r.facturaDigital ? ` | factura digital ${r.facturaDigital.id}` : ''));
    } else {
      console.log(`✖ ${r.name}: ${r.error}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('Error general:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
