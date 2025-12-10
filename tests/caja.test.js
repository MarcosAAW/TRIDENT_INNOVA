jest.mock('../src/prismaClient', () => {
  const { FakePrisma } = require('./helpers/fakePrisma');
  return new FakePrisma();
});

const request = require('supertest');
const prisma = require('../src/prismaClient');
const { app } = require('../src/app');

describe('Cierre de Caja API', () => {
  let usuario;
  let inicioJornada;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.salidaCaja.deleteMany().catch(() => {});
    await prisma.cierreCaja.deleteMany().catch(() => {});
    await prisma.aperturaCaja?.deleteMany?.().catch(() => {});
    await prisma.venta.deleteMany().catch(() => {});
    await prisma.usuario.deleteMany().catch(() => {});

    usuario = await prisma.usuario.create({
      data: {
        nombre: 'Caja Tester',
        usuario: 'caja.tester',
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });

    inicioJornada = new Date('2025-11-05T08:00:00Z');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function fechaRelativa(minutos) {
    return new Date(inicioJornada.getTime() + minutos * 60000).toISOString();
  }

  async function crearVenta(total, { estado = 'COMPLETADA', minuto = 60, moneda = 'PYG', totalMoneda, tipo_cambio } = {}) {
    const data = {
      usuarioId: usuario.id,
      subtotal: total,
      total,
      estado,
      fecha: fechaRelativa(minuto),
      moneda
    };

    if (totalMoneda !== undefined) {
      data.total_moneda = totalMoneda;
    }
    if (tipo_cambio !== undefined) {
      data.tipo_cambio = tipo_cambio;
    }

    return prisma.venta.create({ data });
  }

  async function crearSalidaPendiente(monto, overrides = {}) {
    return request(app)
      .post('/salidas-caja')
      .send({
        usuarioId: usuario.id,
        descripcion: overrides.descripcion || 'Gasto operativo',
        monto,
        observacion: overrides.observacion
      })
      .expect(201);
  }

  async function crearApertura({ saldo = 0, minuto = 0 } = {}) {
    return request(app)
      .post('/cierres-caja/aperturas')
      .send({
        usuarioId: usuario.id,
        saldo_inicial: saldo,
        fecha_apertura: fechaRelativa(minuto),
        observaciones: 'Apertura automática de prueba'
      })
      .expect(201);
  }

  test('rechaza cerrar la caja si no existe apertura activa', async () => {
    const response = await request(app)
      .post('/cierres-caja')
      .send({ usuarioId: usuario.id })
      .expect(409);

    expect(response.body.error).toMatch(/apertura/i);
  });

  test('estado de caja resume ventas y salidas pendientes', async () => {
    await crearApertura({ saldo: 1000000, minuto: 0 });
    await crearVenta(900000, { minuto: 120 });
    const usdTipoCambio = 7200;
    const usdMonto = 150;
    await crearVenta(usdTipoCambio * usdMonto, {
      minuto: 150,
      moneda: 'USD',
      totalMoneda: usdMonto,
      tipo_cambio: usdTipoCambio
    });
    await crearVenta(500000, { estado: 'ANULADA', minuto: 180 });
    await crearSalidaPendiente(150000, { descripcion: 'Reposición insumos' });

    const query = new URLSearchParams({ usuarioId: usuario.id }).toString();
    const res = await request(app).get(`/cierres-caja/estado?${query}`).expect(200);

    expect(res.body.totales).toBeDefined();
    const totalVentasGs = 900000 + usdTipoCambio * usdMonto;
    expect(res.body.totales.ventas).toBeCloseTo(totalVentasGs, 2);
    expect(res.body.totales.efectivo).toBeCloseTo(totalVentasGs, 2);
    expect(res.body.totales.ventasUsd).toBeCloseTo(usdMonto, 2);
    expect(res.body.totales.efectivoUsd).toBeCloseTo(usdMonto, 2);
    expect(res.body.totales.efectivoEsperadoUsd).toBeCloseTo(usdMonto, 2);
    expect(res.body.totales.saldoInicial).toBeCloseTo(1000000, 2);
    expect(res.body.totales.salidas).toBeCloseTo(150000, 2);
    expect(res.body.salidasPendientes).toHaveLength(1);
  });

  test('cerrar caja consume el estado y asigna salidas pendientes', async () => {
    await crearApertura({ saldo: 500000, minuto: 0 });
    await crearVenta(800000, { minuto: 90 });
    const usdTipoCambio = 7300;
    const usdMonto = 200;
    await crearVenta(usdTipoCambio * usdMonto, {
      minuto: 120,
      moneda: 'USD',
      totalMoneda: usdMonto,
      tipo_cambio: usdTipoCambio
    });
    await crearSalidaPendiente(120000, { descripcion: 'Pago delivery' });

    const cierreRes = await request(app)
      .post('/cierres-caja')
      .send({
        usuarioId: usuario.id,
        fecha_cierre: fechaRelativa(720),
        efectivo_declarado: 900000,
        observaciones: 'Cierre automático de prueba',
        total_tarjeta: 250000,
        total_transferencia: 150000
      })
      .expect(201);

    const totalVentasGs = 800000 + usdTipoCambio * usdMonto;
    expect(cierreRes.body.total_ventas).toBeCloseTo(totalVentasGs, 2);
    expect(cierreRes.body.total_ventas_usd).toBeCloseTo(usdMonto, 2);
    expect(cierreRes.body.saldo_inicial).toBeCloseTo(500000, 2);
    expect(cierreRes.body.total_salidas).toBeCloseTo(120000, 2);
    expect(cierreRes.body.total_tarjeta).toBeCloseTo(250000, 2);
    expect(cierreRes.body.total_transferencia).toBeCloseTo(150000, 2);
    const totalEfectivo = totalVentasGs - 250000 - 150000;
    expect(cierreRes.body.total_efectivo).toBeCloseTo(totalEfectivo, 2);
    expect(cierreRes.body.efectivo_usd).toBeCloseTo(usdMonto, 2);
    expect(Array.isArray(cierreRes.body.salidas)).toBe(true);
    expect(cierreRes.body.salidas.length).toBe(1);

    const esperado = 500000 + totalEfectivo - 120000;
    expect(Number(cierreRes.body.diferencia)).toBeCloseTo(900000 - esperado, 2);

    const sinCierre = await prisma.salidaCaja.findMany({ where: { cierreId: null } });
    expect(sinCierre).toHaveLength(0);

    const estadoPosterior = await request(app)
      .get(`/cierres-caja/estado?usuarioId=${usuario.id}`)
      .expect(404);

    expect(estadoPosterior.body.error).toMatch(/apertura activa/i);
  });

  test('registrar salida sin cierre y listarla', async () => {
    await crearSalidaPendiente(100000, { descripcion: 'Compra insumos' });

    const res = await request(app).get('/salidas-caja?sin_cierre=true').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.montoTotal).toBeCloseTo(100000, 2);
  });
});
