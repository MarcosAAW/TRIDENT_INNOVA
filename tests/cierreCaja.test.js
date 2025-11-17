jest.mock('../src/prismaClient', () => {
  const { FakePrisma } = require('./helpers/fakePrisma');
  return new FakePrisma();
});

const request = require('supertest');
const prisma = require('../src/prismaClient');
const { app } = require('../src/app');

describe('Cierre de caja API', () => {
  let usuario;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.salidaCaja.deleteMany().catch(() => {});
    await prisma.cierreCaja.deleteMany().catch(() => {});
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
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('crea un cierre con detalle de salidas', async () => {
    const aperturaRes = await request(app)
      .post('/cierres-caja/aperturas')
      .send({
        usuarioId: usuario.id,
        saldo_inicial: 500000,
        observaciones: 'Apertura de prueba'
      })
      .expect(201);

    expect(aperturaRes.body).toBeDefined();
    expect(aperturaRes.body.usuarioId).toBe(usuario.id);

    const salidaPendiente = await request(app)
      .post('/cierres-caja/salidas')
      .send({
        usuarioId: usuario.id,
        descripcion: 'Pago proveedor',
        monto: 40000
      })
      .expect(201);

    expect(salidaPendiente.body).toBeDefined();
    expect(salidaPendiente.body.cierreId).toBeNull();

    const res = await request(app)
      .post('/cierres-caja')
      .send({
        usuarioId: usuario.id,
        observaciones: 'Cierre de prueba'
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.usuarioId).toBe(usuario.id);
    expect(Array.isArray(res.body.salidas)).toBe(true);
    expect(res.body.salidas).toHaveLength(1);
    expect(Number(res.body.salidas[0].monto)).toBeCloseTo(40000, 2);

    const difference = Number(res.body.diferencia || 0);
    expect(Number.isFinite(difference)).toBe(true);

    const list = await request(app).get('/cierres-caja').expect(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.data.length).toBe(1);
    expect(list.body.meta.total).toBe(1);
  });

  test('registra una salida sin cierre asociado', async () => {
    const salidaRes = await request(app)
      .post('/cierres-caja/salidas')
      .send({
        usuarioId: usuario.id,
        descripcion: 'Pago de servicio',
        monto: 125000
      })
      .expect(201);

    expect(salidaRes.body).toBeDefined();
    expect(salidaRes.body.usuarioId).toBe(usuario.id);
    expect(Number(salidaRes.body.monto)).toBe(125000);
    expect(salidaRes.body.cierreId).toBeNull();
  });
});
