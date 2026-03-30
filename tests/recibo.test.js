const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;
let cliente;

function auth(req, user = adminUser, branch = sucursal) {
  if (!user || !branch) {
    throw new Error('Falta contexto de usuario o sucursal para el test.');
  }
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', branch.id);
}

async function crearVentaCredito(overrides = {}) {
  const creditoBase = overrides.credito_config || {
    tipo: 'PLAZO',
    fecha_vencimiento: '2026-05-31',
    descripcion: '30 dias'
  };
  const fechaVencimiento = overrides.fecha_vencimiento || creditoBase.fecha_vencimiento;
  const fechaVencimientoIso = fechaVencimiento
    ? `${fechaVencimiento}T00:00:00.000Z`
    : null;

  return prisma.venta.create({
    data: {
      usuarioId: overrides.usuarioId || adminUser.id,
      clienteId: overrides.clienteId === undefined ? cliente.id : overrides.clienteId,
      sucursalId: overrides.sucursalId || sucursal.id,
      subtotal: overrides.subtotal ?? 200000,
      impuesto_total: overrides.impuesto_total ?? 18181.82,
      total: overrides.total ?? 200000,
      estado: overrides.estado || 'FACTURADO',
      moneda: overrides.moneda || 'PYG',
      tipo_cambio: overrides.tipo_cambio ?? null,
      total_moneda: overrides.total_moneda ?? null,
      iva_porcentaje: overrides.iva_porcentaje ?? 10,
      condicion_venta: 'CREDITO',
      es_credito: true,
      saldo_pendiente: overrides.saldo_pendiente ?? overrides.total ?? 200000,
      fecha_vencimiento: fechaVencimientoIso,
      credito_config: creditoBase
    }
  });
}

describe('Recibos API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.reciboDetalle?.deleteMany?.();
    await prisma.recibo?.deleteMany?.();
    await prisma.notaCreditoDetalle?.deleteMany?.();
    await prisma.notaCreditoElectronica?.deleteMany?.();
    await prisma.facturaDigital?.deleteMany?.();
    await prisma.facturaElectronica?.deleteMany?.();
    await prisma.detalleVenta?.deleteMany?.();
    await prisma.venta?.deleteMany?.();
    await prisma.detallePresupuesto?.deleteMany?.();
    await prisma.presupuesto?.deleteMany?.();
    await prisma.movimientoStock?.deleteMany?.();
    await prisma.salidaCaja?.deleteMany?.();
    await prisma.cierreCaja?.deleteMany?.();
    await prisma.aperturaCaja?.deleteMany?.();
    await prisma.usuarioSucursal?.deleteMany?.();
    await prisma.usuario?.deleteMany?.();
    await prisma.cliente?.deleteMany?.();
    await prisma.sucursal?.deleteMany?.();

    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    sucursal = await prisma.sucursal.create({
      data: { nombre: `Sucursal Recibos ${unique}` }
    });

    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin recibos',
        usuario: `admin.recibos_${unique}`,
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });

    await prisma.usuarioSucursal.create({
      data: {
        usuarioId: adminUser.id,
        sucursalId: sucursal.id,
        rol: 'ADMIN'
      }
    });

    cliente = await prisma.cliente.create({
      data: {
        nombre_razon_social: `Cliente recibos ${unique}`,
        ruc: `800${unique.slice(-5)}-1`,
        direccion: 'Calle Recibo 123'
      }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('crea un recibo y reduce el saldo pendiente de una venta a crédito', async () => {
    const venta = await crearVentaCredito();

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'EFECTIVO',
        observacion: 'Cobro parcial',
        ventas: [{ ventaId: venta.id, monto: 50000 }]
      })
      .expect(201);

    expect(response.body.total).toBe('50000');
    expect(response.body.metodo).toBe('EFECTIVO');
    expect(response.body.aplicaciones).toHaveLength(1);
    expect(Number(response.body.aplicaciones[0].saldo_posterior)).toBeCloseTo(150000, 2);

    const ventaActualizada = await prisma.venta.findUnique({ where: { id: venta.id } });
    expect(Number(ventaActualizada.saldo_pendiente)).toBeCloseTo(150000, 2);
    expect(ventaActualizada.estado).toBe('FACTURADO');
  });

  test('rechaza cobros de ventas que no pertenecen a la sucursal activa', async () => {
    const otraSucursal = await prisma.sucursal.create({
      data: { nombre: 'Sucursal ajena' }
    });

    const ventaAjena = await crearVentaCredito({ sucursalId: otraSucursal.id });

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'TRANSFERENCIA',
        ventas: [{ ventaId: ventaAjena.id, monto: 10000 }]
      })
      .expect(404);

    expect(response.body.error).toMatch(/no pertenece a esta sucursal|no existe/i);
  });

  test('aplica cobro FIFO sobre cuotas y marca la primera como pagada', async () => {
    const venta = await crearVentaCredito({
      total: 200000,
      saldo_pendiente: 200000,
      credito_config: {
        tipo: 'CUOTAS',
        cuotas: [
          { numero: 1, monto: 100000, fecha_vencimiento: '2026-05-10' },
          { numero: 2, monto: 100000, fecha_vencimiento: '2026-06-10' }
        ]
      }
    });

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'EFECTIVO',
        ventas: [{ ventaId: venta.id, monto: 100000 }]
      })
      .expect(201);

    expect(response.body.aplicaciones).toHaveLength(1);
    expect(Number(response.body.aplicaciones[0].saldo_posterior)).toBeCloseTo(100000, 2);

    const ventaActualizada = await prisma.venta.findUnique({ where: { id: venta.id } });
    expect(Number(ventaActualizada.saldo_pendiente)).toBeCloseTo(100000, 2);
    expect(ventaActualizada.credito_config).toMatchObject({ tipo: 'CUOTAS' });
    expect(ventaActualizada.credito_config.cuotas[0].pagada).toBe(true);
    expect(ventaActualizada.credito_config.cuotas[1].pagada || false).toBe(false);
  });

  test('respeta cuotas seleccionadas al cobrar una venta financiada', async () => {
    const venta = await crearVentaCredito({
      total: 300000,
      saldo_pendiente: 300000,
      credito_config: {
        tipo: 'CUOTAS',
        cuotas: [
          { numero: 1, monto: 100000, fecha_vencimiento: '2026-05-10' },
          { numero: 2, monto: 100000, fecha_vencimiento: '2026-06-10' },
          { numero: 3, monto: 100000, fecha_vencimiento: '2026-07-10' }
        ]
      }
    });

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'TRANSFERENCIA',
        ventas: [{ ventaId: venta.id, monto: 100000, cuotas: [2] }]
      })
      .expect(201);

    expect(response.body.aplicaciones).toHaveLength(1);
    expect(Number(response.body.aplicaciones[0].saldo_posterior)).toBeCloseTo(200000, 2);

    const ventaActualizada = await prisma.venta.findUnique({ where: { id: venta.id } });
    expect(ventaActualizada.credito_config.cuotas[0].pagada || false).toBe(false);
    expect(ventaActualizada.credito_config.cuotas[1].pagada).toBe(true);
    expect(ventaActualizada.credito_config.cuotas[2].pagada || false).toBe(false);
  });

  test('cobra cuotas seleccionadas en USD usando tipo de cambio y conserva montos en ambas monedas', async () => {
    const venta = await crearVentaCredito({
      total: 1460000,
      subtotal: 1460000,
      impuesto_total: 132727.27,
      saldo_pendiente: 1460000,
      moneda: 'USD',
      total_moneda: 200,
      tipo_cambio: 7300,
      credito_config: {
        tipo: 'CUOTAS',
        cuotas: [
          { numero: 1, monto: 100, fecha_vencimiento: '2026-05-10' },
          { numero: 2, monto: 100, fecha_vencimiento: '2026-06-10' }
        ]
      }
    });

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'TRANSFERENCIA',
        moneda: 'USD',
        tipo_cambio: 7300,
        ventas: [{ ventaId: venta.id, monto: 100, cuotas: [2] }]
      })
      .expect(201);

    expect(response.body.moneda).toBe('USD');
    expect(Number(response.body.total)).toBeCloseTo(730000, 2);
    expect(Number(response.body.total_moneda)).toBeCloseTo(100, 2);
    expect(response.body.aplicaciones).toHaveLength(1);
    expect(Number(response.body.aplicaciones[0].monto)).toBeCloseTo(730000, 2);
    expect(Number(response.body.aplicaciones[0].monto_moneda)).toBeCloseTo(100, 2);
    expect(Number(response.body.aplicaciones[0].saldo_posterior)).toBeCloseTo(730000, 2);

    const ventaActualizada = await prisma.venta.findUnique({ where: { id: venta.id } });
    expect(Number(ventaActualizada.saldo_pendiente)).toBeCloseTo(730000, 2);
    expect(ventaActualizada.credito_config.cuotas[0].pagada || false).toBe(false);
    expect(ventaActualizada.credito_config.cuotas[1].pagada).toBe(true);
    expect(Number(ventaActualizada.credito_config.cuotas[1].monto_pagado)).toBeCloseTo(100, 2);
  });

  test('permite cobrar las ultimas cuotas en USD aunque el saldo pendiente en Gs tenga redondeo menor al tc de cobro', async () => {
    const venta = await crearVentaCredito({
      total: 65100,
      subtotal: 65100,
      impuesto_total: 5918.18,
      saldo_pendiente: 32520,
      moneda: 'USD',
      total_moneda: 9.3,
      tipo_cambio: 7000,
      credito_config: {
        tipo: 'CUOTAS',
        cuotas: [
          { numero: 1, monto: 2.32, fecha_vencimiento: '2026-05-10', pagada: true, monto_pagado: 2.32 },
          { numero: 2, monto: 2.33, fecha_vencimiento: '2026-06-10', pagada: true, monto_pagado: 2.33 },
          { numero: 3, monto: 2.32, fecha_vencimiento: '2026-07-10' },
          { numero: 4, monto: 2.33, fecha_vencimiento: '2026-08-10' }
        ]
      }
    });

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'TRANSFERENCIA',
        moneda: 'USD',
        tipo_cambio: 7000,
        ventas: [{ ventaId: venta.id, monto: 4.65, cuotas: [3, 4] }]
      })
      .expect(201);

    expect(response.body.moneda).toBe('USD');
    expect(Number(response.body.total)).toBeCloseTo(32520, 2);
    expect(Number(response.body.total_moneda)).toBeCloseTo(4.65, 2);
    expect(Number(response.body.aplicaciones[0].saldo_posterior)).toBeCloseTo(0, 2);

    const ventaActualizada = await prisma.venta.findUnique({ where: { id: venta.id } });
    expect(Number(ventaActualizada.saldo_pendiente)).toBeCloseTo(0, 2);
    expect(ventaActualizada.estado).toBe('PAGADA');
    expect(ventaActualizada.credito_config.cuotas[2].pagada).toBe(true);
    expect(ventaActualizada.credito_config.cuotas[3].pagada).toBe(true);
    expect(Number(ventaActualizada.credito_config.cuotas[2].monto_pagado)).toBeCloseTo(2.32, 2);
    expect(Number(ventaActualizada.credito_config.cuotas[3].monto_pagado)).toBeCloseTo(2.33, 2);
  });

  test('genera el siguiente numero de recibo usando el mayor correlativo existente', async () => {
    const venta = await crearVentaCredito();

    await prisma.recibo.create({
      data: {
        numero: '0000000010',
        clienteId: cliente.id,
        usuarioId: adminUser.id,
        sucursalId: sucursal.id,
        total: 10000,
        moneda: 'PYG',
        metodo: 'EFECTIVO',
        created_at: new Date('2026-03-27T10:00:00.000Z')
      }
    });

    await prisma.recibo.create({
      data: {
        numero: '0000000009',
        clienteId: cliente.id,
        usuarioId: adminUser.id,
        sucursalId: sucursal.id,
        total: 10000,
        moneda: 'PYG',
        metodo: 'EFECTIVO',
        created_at: new Date('2026-03-27T11:00:00.000Z')
      }
    });

    const response = await auth(request(app).post('/recibos'))
      .send({
        metodo: 'EFECTIVO',
        ventas: [{ ventaId: venta.id, monto: 50000 }]
      })
      .expect(201);

    expect(response.body.numero).toBe('0000000011');
  });
});