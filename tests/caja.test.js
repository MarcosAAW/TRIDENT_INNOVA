jest.mock('../src/prismaClient', () => {
  const { FakePrisma } = require('./helpers/fakePrisma');
  return new FakePrisma();
});

jest.mock('../src/middleware/authContext', () => ({
  attachUser: (req, _res, next) => {
    req.usuarioActual = req.usuarioActual || { id: 'test-user', rol: 'ADMIN' };
    next();
  },
  requireAuth: (req, res, next) => {
    req.usuarioActual = req.usuarioActual || { id: 'test-user', rol: 'ADMIN' };
    return next();
  },
  authorizeRoles: () => (req, res, next) => {
    req.usuarioActual = req.usuarioActual || { id: 'test-user', rol: 'ADMIN' };
    return next();
  }
}));

jest.mock('../src/middleware/sucursalContext', () => ({
  requireSucursal: (req, _res, next) => {
    req.sucursalId = req.sucursalId || '00000000-0000-0000-0000-000000000001';
    return next();
  }
}));

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
    // Limpieza ordenada: primero salidas, cierres, aperturas, ventas, luego usuarios
    await prisma.salidaCaja?.deleteMany?.();
    await prisma.cierreCaja?.deleteMany?.();
    await prisma.aperturaCaja?.deleteMany?.();
    await prisma.venta?.deleteMany?.();
    await prisma.usuario?.deleteMany?.();

    // Generar sufijo único
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;

    usuario = await prisma.usuario.create({
      data: {
        nombre: 'Caja Tester',
        usuario: `caja.tester_${unique}`,
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
      sucursalId: '00000000-0000-0000-0000-000000000001',
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

  test('estado y cierre cuentan solo cobros reales para ventas a crédito con entrega inicial', async () => {
    await crearApertura({ saldo: 250000, minuto: 0 });

    const ventaCredito = await prisma.venta.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        subtotal: 1000000,
        total: 1000000,
        estado: 'COMPLETADA',
        fecha: fechaRelativa(30),
        moneda: 'PYG',
        condicion_venta: 'CREDITO',
        es_credito: true,
        saldo_pendiente: 700000,
        credito_config: {
          entrega_inicial: 300000,
          entrega_inicial_gs: 300000,
          metodo_entrega: 'EFECTIVO'
        }
      }
    });

    const reciboEntrega = await prisma.recibo.create({
      data: {
        numero: 'REC-INI-001',
        clienteId: null,
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        fecha: fechaRelativa(31),
        total: 300000,
        moneda: 'PYG',
        metodo: 'EFECTIVO',
        estado: 'CONFIRMADO'
      }
    });

    await prisma.reciboDetalle.create({
      data: {
        reciboId: reciboEntrega.id,
        ventaId: ventaCredito.id,
        monto: 300000,
        saldo_previo: 1000000,
        saldo_posterior: 700000
      }
    });

    const reciboCuota = await prisma.recibo.create({
      data: {
        numero: 'REC-CUO-001',
        clienteId: null,
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        fecha: fechaRelativa(120),
        total: 200000,
        moneda: 'PYG',
        metodo: 'TRANSFERENCIA',
        estado: 'CONFIRMADO'
      }
    });

    await prisma.reciboDetalle.create({
      data: {
        reciboId: reciboCuota.id,
        ventaId: ventaCredito.id,
        monto: 200000,
        saldo_previo: 700000,
        saldo_posterior: 500000
      }
    });

    const estadoRes = await request(app)
      .get(`/cierres-caja/estado?usuarioId=${usuario.id}`)
      .expect(200);

    expect(estadoRes.body.totales.ventas).toBeCloseTo(1000000, 2);
    expect(estadoRes.body.totales.efectivo).toBeCloseTo(300000, 2);
    expect(estadoRes.body.totales.transferencia).toBeCloseTo(200000, 2);
    expect(estadoRes.body.totales.tarjeta).toBeCloseTo(0, 2);
    expect(estadoRes.body.totales.efectivoEsperado).toBeCloseTo(550000, 2);

    const cierreRes = await request(app)
      .post('/cierres-caja')
      .send({
        usuarioId: usuario.id,
        fecha_cierre: fechaRelativa(300),
        efectivo_declarado: 550000
      })
      .expect(201);

    expect(cierreRes.body.total_ventas).toBeCloseTo(1000000, 2);
    expect(cierreRes.body.total_efectivo).toBeCloseTo(300000, 2);
    expect(cierreRes.body.total_transferencia).toBeCloseTo(200000, 2);
    expect(Number(cierreRes.body.diferencia)).toBeCloseTo(0, 2);
  });

  test('registrar salida sin cierre y listarla', async () => {
    await crearSalidaPendiente(100000, { descripcion: 'Compra insumos' });

    const res = await request(app).get('/salidas-caja?sin_cierre=true').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.montoTotal).toBeCloseTo(100000, 2);
  });
});
