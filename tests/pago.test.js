const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;
let ventaCredito;

function auth(req, user = adminUser, branch = sucursal) {
  if (!user || !branch) {
    throw new Error('Falta contexto de usuario o sucursal para el test.');
  }
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', branch.id);
}

describe('Pagos API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.reciboDetalle?.deleteMany?.();
    await prisma.recibo?.deleteMany?.();
    await prisma.pago?.deleteMany?.();
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
      data: {
        nombre: `Sucursal Pagos ${unique}`
      }
    });

    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin pagos',
        usuario: `admin.pagos_${unique}`,
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

    ventaCredito = await prisma.venta.create({
      data: {
        usuarioId: adminUser.id,
        sucursalId: sucursal.id,
        subtotal: 300000,
        impuesto_total: 27272.73,
        total: 300000,
        estado: 'FACTURADO',
        moneda: 'PYG',
        iva_porcentaje: 10,
        condicion_venta: 'CREDITO',
        es_credito: true,
        saldo_pendiente: 300000,
        fecha_vencimiento: '2026-06-30T00:00:00.000Z',
        credito_config: {
          tipo: 'PLAZO',
          fecha_vencimiento: '2026-06-30',
          descripcion: '30 dias'
        }
      }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('registra un pago y reduce el saldo pendiente de la venta', async () => {
    const response = await auth(request(app).post('/pagos'))
      .send({
        ventaId: ventaCredito.id,
        monto: 120000,
        metodo: 'TRANSFERENCIA',
        referencia: 'TRX-001'
      })
      .expect(201);

    expect(Number(response.body.pago.monto)).toBeCloseTo(120000, 2);
    expect(response.body.pago.metodo).toBe('TRANSFERENCIA');
    expect(response.body.pago.sucursalId).toBe(sucursal.id);
    expect(Number(response.body.venta.saldo_pendiente)).toBeCloseTo(180000, 2);
    expect(response.body.venta.estado).toBe('FACTURADO');
  });

  test('marca la venta como pagada cuando el pago cubre el saldo completo', async () => {
    const response = await auth(request(app).post('/pagos'))
      .send({
        ventaId: ventaCredito.id,
        monto: 300000,
        metodo: 'EFECTIVO'
      })
      .expect(201);

    expect(Number(response.body.venta.saldo_pendiente)).toBeCloseTo(0, 2);
    expect(response.body.venta.estado).toBe('PAGADA');
  });

  test('lista pagos y permite filtrar por venta', async () => {
    await auth(request(app).post('/pagos'))
      .send({
        ventaId: ventaCredito.id,
        monto: 50000,
        metodo: 'EFECTIVO'
      })
      .expect(201);

    const list = await auth(request(app).get('/pagos').query({ ventaId: ventaCredito.id })).expect(200);

    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].ventaId).toBe(ventaCredito.id);
  });

  test('rechaza pagos de ventas de otra sucursal', async () => {
    const otraSucursal = await prisma.sucursal.create({ data: { nombre: 'Sucursal externa pagos' } });
    const ventaAjena = await prisma.venta.create({
      data: {
        usuarioId: adminUser.id,
        sucursalId: otraSucursal.id,
        subtotal: 100000,
        impuesto_total: 9090.91,
        total: 100000,
        estado: 'FACTURADO',
        moneda: 'PYG',
        iva_porcentaje: 10,
        condicion_venta: 'CREDITO',
        es_credito: true,
        saldo_pendiente: 100000
      }
    });

    const response = await auth(request(app).post('/pagos'))
      .send({
        ventaId: ventaAjena.id,
        monto: 10000,
        metodo: 'EFECTIVO'
      })
      .expect(404);

    expect(response.body.error).toMatch(/venta no encontrada/i);
  });
});