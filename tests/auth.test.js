const bcrypt = require('bcryptjs');
const request = require('supertest');
const { app, prisma } = require('../src/app');

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

describe('Auth API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('inicia sesion con credenciales validas y devuelve sucursal activa por defecto', async () => {
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const sucursalEliminada = await prisma.sucursal.create({
      data: {
        nombre: `Sucursal eliminada ${unique}`,
        deleted_at: new Date()
      }
    });
    const sucursalActiva = await prisma.sucursal.create({
      data: { nombre: `Sucursal activa ${unique}` }
    });
    const password = 'admin123';
    const user = await prisma.usuario.create({
      data: {
        nombre: 'Admin auth',
        usuario: `admin_auth_${unique}`,
        password_hash: await bcrypt.hash(password, 10),
        rol: 'ADMIN'
      }
    });

    await prisma.usuarioSucursal.createMany({
      data: [
        { usuarioId: user.id, sucursalId: sucursalEliminada.id, rol: 'ADMIN' },
        { usuarioId: user.id, sucursalId: sucursalActiva.id, rol: 'ADMIN' }
      ]
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ usuario: user.usuario, password })
      .expect(200);

    expect(res.body.message).toMatch(/exitoso/i);
    expect(res.body.usuario.id).toBe(user.id);
    expect(res.body.usuario.sucursalId).toBe(sucursalActiva.id);
    expect(res.body.usuario).not.toHaveProperty('password_hash');
    expect(res.body.usuario.sucursales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sucursalId: sucursalEliminada.id, nombre: sucursalEliminada.nombre, rol: 'ADMIN' }),
        expect.objectContaining({ sucursalId: sucursalActiva.id, nombre: sucursalActiva.nombre, rol: 'ADMIN' })
      ])
    );
  });

  test('rechaza password incorrecta', async () => {
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const user = await prisma.usuario.create({
      data: {
        nombre: 'Usuario auth',
        usuario: `usuario_auth_${unique}`,
        password_hash: await bcrypt.hash('clave-correcta', 10),
        rol: 'ADMIN'
      }
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ usuario: user.usuario, password: 'clave-incorrecta' })
      .expect(401);

    expect(res.body.error).toMatch(/incorrectos/i);
  });

  test('rechaza usuario eliminado aunque la password sea correcta', async () => {
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const password = 'clave-valida';
    const user = await prisma.usuario.create({
      data: {
        nombre: 'Usuario borrado',
        usuario: `usuario_borrado_${unique}`,
        password_hash: await bcrypt.hash(password, 10),
        rol: 'ADMIN',
        deleted_at: new Date()
      }
    });

    const res = await request(app)
      .post('/auth/login')
      .send({ usuario: user.usuario, password })
      .expect(401);

    expect(res.body.error).toMatch(/incorrectos/i);
  });

  test('valida payload obligatorio en login', async () => {
    const res = await request(app).post('/auth/login').send({ usuario: '' }).expect(400);

    expect(res.body.error).toMatch(/credenciales inv[áa]lidas/i);
    expect(res.body.detalles).toBeTruthy();
  });
});