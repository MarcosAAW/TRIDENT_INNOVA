const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;

function auth(req, user = adminUser) {
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', sucursal.id);
}

async function cleanDatabase() {
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
  await prisma.detalleNotaPedido?.deleteMany?.();
  await prisma.notaPedido?.deleteMany?.();
  await prisma.detalleCompra?.deleteMany?.();
  await prisma.compra?.deleteMany?.();
  await prisma.pago?.deleteMany?.();
  await prisma.salidaCaja?.deleteMany?.();
  await prisma.cierreCaja?.deleteMany?.();
  await prisma.aperturaCaja?.deleteMany?.();
  await prisma.cliente?.deleteMany?.();
  await prisma.producto?.deleteMany?.();
  await prisma.proveedor?.deleteMany?.();
  await prisma.categoria?.deleteMany?.();
  await prisma.usuarioSucursal?.deleteMany?.();
  await prisma.usuario?.deleteMany?.();
  await prisma.sucursal?.deleteMany?.();
}

describe('Proveedores API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursal = await prisma.sucursal.create({ data: { nombre: `Sucursal Test ${unique}` } });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin pruebas',
        usuario: `admin_proveedor_${unique}`,
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

  test('crea y lista proveedores', async () => {
    const payload = {
      nombre_razon_social: 'Proveedor Uno S.A.',
      ruc: '80011111-1',
      contacto: 'Compras',
      correo: 'compras@proveedor.test'
    };

    const created = await auth(request(app).post('/proveedores')).send(payload).expect(201);
    expect(created.body.nombre_razon_social).toBe(payload.nombre_razon_social);

    const list = await auth(request(app).get('/proveedores?search=uno')).expect(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.data.some((item) => item.id === created.body.id)).toBe(true);
  });

  test('impide duplicar RUC', async () => {
    const payload = {
      nombre_razon_social: 'Proveedor Base',
      ruc: '80022222-2'
    };

    await auth(request(app).post('/proveedores')).send(payload).expect(201);
    const duplicate = await auth(request(app).post('/proveedores')).send({ ...payload, nombre_razon_social: 'Proveedor Duplicado' }).expect(409);
    expect(duplicate.body.error).toMatch(/existe/i);
  });
});