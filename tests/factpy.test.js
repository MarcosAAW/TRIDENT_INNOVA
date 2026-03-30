jest.mock('../src/services/factpy/client', () => ({
  emitirFactura: jest.fn(),
  consultarEstados: jest.fn()
}));

const request = require('supertest');
const { app, prisma } = require('../src/app');
const { emitirFactura, consultarEstados } = require('../src/services/factpy/client');

let adminUser;
let sucursal;

function auth(req, user = adminUser, branch = sucursal) {
  if (!user || !branch) {
    throw new Error('Falta contexto para autenticar el test.');
  }
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', branch.id);
}

async function cleanDatabase() {
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
  await prisma.detalleNotaPedido?.deleteMany?.();
  await prisma.notaPedido?.deleteMany?.();
  await prisma.detalleCompra?.deleteMany?.();
  await prisma.compra?.deleteMany?.();
  await prisma.salidaCaja?.deleteMany?.();
  await prisma.cierreCaja?.deleteMany?.();
  await prisma.aperturaCaja?.deleteMany?.();
  await prisma.cliente?.deleteMany?.();
  await prisma.productoStock?.deleteMany?.();
  await prisma.producto?.deleteMany?.();
  await prisma.proveedor?.deleteMany?.();
  await prisma.categoria?.deleteMany?.();
  await prisma.usuarioSucursal?.deleteMany?.();
  await prisma.usuario?.deleteMany?.();
  await prisma.sucursal?.deleteMany?.();
}

describe('FactPy API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    jest.clearAllMocks();

    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursal = await prisma.sucursal.create({ data: { nombre: `Sucursal factpy ${unique}` } });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin factpy',
        usuario: `admin_factpy_${unique}`,
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });
    await prisma.usuarioSucursal.create({ data: { usuarioId: adminUser.id, sucursalId: sucursal.id, rol: 'ADMIN' } });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('emite factura y reenvia el payload al cliente externo', async () => {
    emitirFactura.mockResolvedValue({ ok: true, receiptid: 'RID-100' });

    const payload = {
      dataJson: { documento: '001-001-0000001', total: 150000 },
      recordID: 'venta-100',
      baseUrl: 'https://factpy.test'
    };

    const res = await auth(request(app).post('/factpy/emitir')).send(payload).expect(200);

    expect(res.body).toEqual({ ok: true, receiptid: 'RID-100' });
    expect(emitirFactura).toHaveBeenCalledWith(payload);
  });

  test('valida body requerido para emitir', async () => {
    const res = await auth(request(app).post('/factpy/emitir'))
      .send({ dataJson: { total: 1000 }, baseUrl: 'no-es-url' })
      .expect(400);

    expect(res.body.error).toMatch(/body invalido/i);
  });

  test('consulta estados con receiptid enviados por el cliente', async () => {
    consultarEstados.mockResolvedValue([{ receiptid: 'RID-1', estado: 'Aprobado' }]);

    const payload = {
      receiptid: ['RID-1'],
      recordID: 'venta-1',
      baseUrl: 'https://factpy.test'
    };

    const res = await auth(request(app).post('/factpy/estado')).send(payload).expect(200);

    expect(res.body).toEqual([{ receiptid: 'RID-1', estado: 'Aprobado' }]);
    expect(consultarEstados).toHaveBeenCalledWith({
      receiptIds: ['RID-1'],
      recordID: 'venta-1',
      baseUrl: 'https://factpy.test'
    });
  });

  test('poll actualiza estado y metadatos de facturas pendientes de la sucursal', async () => {
    const venta = await prisma.venta.create({
      data: {
        usuarioId: adminUser.id,
        sucursalId: sucursal.id,
        subtotal: 100000,
        total: 100000,
        impuesto_total: 9090.91,
        moneda: 'PYG',
        iva_porcentaje: 10,
        estado: 'FACTURADO'
      }
    });

    const otraSucursal = await prisma.sucursal.create({ data: { nombre: `Sucursal ajena ${Date.now()}` } });
    const ventaAjena = await prisma.venta.create({
      data: {
        usuarioId: adminUser.id,
        sucursalId: otraSucursal.id,
        subtotal: 200000,
        total: 200000,
        impuesto_total: 18181.82,
        moneda: 'PYG',
        iva_porcentaje: 10,
        estado: 'FACTURADO'
      }
    });

    const local = await prisma.facturaElectronica.create({
      data: {
        ventaId: venta.id,
        sucursalId: sucursal.id,
        estado: 'PENDIENTE',
        respuesta_set: { receiptid: 'RID-LOCAL' },
        intentos: 0
      }
    });

    const ajena = await prisma.facturaElectronica.create({
      data: {
        ventaId: ventaAjena.id,
        sucursalId: otraSucursal.id,
        estado: 'PENDIENTE',
        respuesta_set: { receiptid: 'RID-AJENA' },
        intentos: 0
      }
    });

    consultarEstados.mockResolvedValue([
      {
        receiptid: 'RID-LOCAL',
        estado: 'Aprobado',
        cdc: 'CDC-123',
        documento: '001-001-0000456'
      }
    ]);

    const res = await auth(request(app).post('/factpy/poll')).send({ limit: 10 }).expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.consultados).toBe(1);
    expect(res.body.actualizados).toBe(1);
    expect(consultarEstados).toHaveBeenCalledWith({
      receiptIds: ['RID-LOCAL'],
      recordID: undefined,
      baseUrl: undefined
    });

    const updatedLocal = await prisma.facturaElectronica.findUnique({ where: { id: local.id } });
    const untouched = await prisma.facturaElectronica.findUnique({ where: { id: ajena.id } });

    expect(updatedLocal.estado).toBe('ACEPTADO');
    expect(updatedLocal.qr_data).toBe('CDC-123');
    expect(updatedLocal.nro_factura).toBe('001-001-0000456');
    expect(updatedLocal.intentos).toBe(1);
    expect(updatedLocal.respuesta_set.last_estado).toMatchObject({ receiptid: 'RID-LOCAL', estado: 'Aprobado' });
    expect(untouched.estado).toBe('PENDIENTE');
    expect(untouched.intentos).toBe(0);
  });

  test('poll responde mensaje util cuando no hay pendientes', async () => {
    const res = await auth(request(app).post('/factpy/poll')).send({}).expect(200);

    expect(res.body).toMatchObject({ status: 'ok', message: 'Sin facturas pendientes' });
    expect(consultarEstados).not.toHaveBeenCalled();
  });
});