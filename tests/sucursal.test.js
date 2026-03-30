const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursalBase;

function auth(req, user = adminUser, branch = sucursalBase) {
  if (!user || !branch) {
    throw new Error('Falta usuario o sucursal para el test.');
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

describe('Sucursales API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursalBase = await prisma.sucursal.create({ data: { nombre: `Sucursal base ${unique}` } });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin sucursales',
        usuario: `admin_sucursales_${unique}`,
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });
    await prisma.usuarioSucursal.create({
      data: {
        usuarioId: adminUser.id,
        sucursalId: sucursalBase.id,
        rol: 'ADMIN'
      }
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('crea y lista sucursales con busqueda', async () => {
    const created = await auth(request(app).post('/sucursales'))
      .send({
        nombre: '  Casa Matriz Centro  ',
        ciudad: '  Asuncion  ',
        direccion: '  Calle Principal 123  ',
        establecimiento: '001',
        punto_expedicion: '002'
      })
      .expect(201);

    expect(created.body.nombre).toBe('Casa Matriz Centro');
    expect(created.body.ciudad).toBe('Asuncion');

    const listed = await auth(request(app).get('/sucursales?search=matriz')).expect(200);
    expect(listed.body.data.some((item) => item.id === created.body.id)).toBe(true);
  });

  test('actualiza datos y mantiene saneado el payload', async () => {
    const created = await auth(request(app).post('/sucursales'))
      .send({ nombre: 'Sucursal editar', ciudad: 'Luque' })
      .expect(201);

    const updated = await auth(request(app).put(`/sucursales/${created.body.id}`))
      .send({ telefono: ' 0981002000 ', direccion: ' Avenida Nueva 456 ' })
      .expect(200);

    expect(updated.body.telefono).toBe('0981002000');
    expect(updated.body.direccion).toBe('Avenida Nueva 456');
  });

  test('soft delete excluye del listado normal y aparece con include_deleted', async () => {
    const created = await auth(request(app).post('/sucursales'))
      .send({ nombre: `Sucursal borrar ${Date.now()}` })
      .expect(201);

    await auth(request(app).delete(`/sucursales/${created.body.id}`)).expect(200);

    const normal = await auth(request(app).get('/sucursales?search=borrar')).expect(200);
    expect(normal.body.data.some((item) => item.id === created.body.id)).toBe(false);

    const withDeleted = await auth(request(app).get('/sucursales?include_deleted=true&search=borrar')).expect(200);
    expect(withDeleted.body.data.some((item) => item.id === created.body.id)).toBe(true);
  });

  test('rechaza actualizacion vacia y sucursal inexistente', async () => {
    const created = await auth(request(app).post('/sucursales')).send({ nombre: 'Sucursal vacia' }).expect(201);

    const empty = await auth(request(app).put(`/sucursales/${created.body.id}`)).send({}).expect(400);
    expect(empty.body.error).toMatch(/no se enviaron datos/i);

    const missing = await auth(request(app).put('/sucursales/11111111-1111-4111-8111-111111111111'))
      .send({ nombre: 'No existe' })
      .expect(404);
    expect(missing.body.error).toMatch(/no encontrada/i);
  });

  test('requiere autenticacion y rol admin', async () => {
    await request(app).get('/sucursales').expect(401);

    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const tecnico = await prisma.usuario.create({
      data: {
        nombre: 'Tecnico sucursal',
        usuario: `tecnico_sucursal_${unique}`,
        password_hash: 'hash',
        rol: 'TECNICO'
      }
    });
    await prisma.usuarioSucursal.create({ data: { usuarioId: tecnico.id, sucursalId: sucursalBase.id, rol: 'TECNICO' } });

    const res = await auth(request(app).post('/sucursales'), tecnico)
      .send({ nombre: 'Sucursal prohibida' })
      .expect(403);

    expect(res.body.error).toMatch(/permisos/i);
  });
});