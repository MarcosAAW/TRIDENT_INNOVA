const bcrypt = require('bcryptjs');
const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;
let sucursalSecundaria;

function auth(req, user = adminUser, branch = sucursal) {
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

describe('Usuarios API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursal = await prisma.sucursal.create({ data: { nombre: `Sucursal usuarios ${unique}` } });
    sucursalSecundaria = await prisma.sucursal.create({ data: { nombre: `Sucursal usuarios secundaria ${unique}` } });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin usuarios',
        usuario: `admin_usuarios_${unique}`,
        password_hash: await bcrypt.hash('admin123', 10),
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
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('crea usuario con password hasheada y membresias de sucursal', async () => {
    const payload = {
      nombre: 'Vendedor uno',
      usuario: `vendedor_${Date.now()}`,
      password: 'claveSegura1',
      rol: 'VENDEDOR',
      sucursalIds: [sucursal.id, sucursalSecundaria.id]
    };

    const res = await auth(request(app).post('/usuarios')).send(payload).expect(201);

    expect(res.body.usuario).toBe(payload.usuario);
    expect(res.body.rol).toBe('VENDEDOR');
    expect(res.body).not.toHaveProperty('password_hash');
    expect(res.body.sucursales).toHaveLength(2);

    const stored = await prisma.usuario.findUnique({ where: { id: res.body.id } });
    expect(await bcrypt.compare(payload.password, stored.password_hash)).toBe(true);
  });

  test('lista usuarios con filtros por rol y busqueda', async () => {
    await auth(request(app).post('/usuarios')).send({
      nombre: 'Vendedor filtro',
      usuario: `vendedor_filtro_${Date.now()}`,
      password: 'claveSegura1',
      rol: 'VENDEDOR'
    }).expect(201);

    await auth(request(app).post('/usuarios')).send({
      nombre: 'Tecnico filtro',
      usuario: `tecnico_filtro_${Date.now()}`,
      password: 'claveSegura1',
      rol: 'TECNICO'
    }).expect(201);

    const filtered = await auth(request(app).get('/usuarios?rol=VENDEDOR&search=filtro')).expect(200);

    expect(filtered.body.meta.total).toBe(1);
    expect(filtered.body.data[0].rol).toBe('VENDEDOR');
    expect(filtered.body.data[0].nombre).toMatch(/vendedor/i);
  });

  test('actualiza password, rol y sucursales del usuario', async () => {
    const created = await auth(request(app).post('/usuarios')).send({
      nombre: 'Usuario update',
      usuario: `usuario_update_${Date.now()}`,
      password: 'claveOriginal',
      rol: 'VENDEDOR',
      sucursalIds: [sucursal.id]
    }).expect(201);

    const updated = await auth(request(app).put(`/usuarios/${created.body.id}`))
      .send({
        rol: 'GERENCIA',
        password: 'nuevaClave99',
        sucursalIds: [sucursalSecundaria.id],
        activo: false
      })
      .expect(200);

    expect(updated.body.rol).toBe('GERENCIA');
    expect(updated.body.activo).toBe(false);
    expect(updated.body.sucursales).toHaveLength(1);
    expect(updated.body.sucursales[0].sucursalId).toBe(sucursalSecundaria.id);

    const stored = await prisma.usuario.findUnique({ where: { id: created.body.id } });
    expect(await bcrypt.compare('nuevaClave99', stored.password_hash)).toBe(true);
  });

  test('soft delete oculta el usuario en la consulta directa', async () => {
    const created = await auth(request(app).post('/usuarios')).send({
      nombre: 'Usuario borrar',
      usuario: `usuario_borrar_${Date.now()}`,
      password: 'claveSegura1',
      rol: 'VENDEDOR'
    }).expect(201);

    await auth(request(app).delete(`/usuarios/${created.body.id}`)).expect(200);

    const stored = await prisma.usuario.findUnique({ where: { id: created.body.id } });
    expect(stored.deleted_at).toBeTruthy();
    expect(stored.activo).toBe(false);

    await auth(request(app).get(`/usuarios/${created.body.id}`)).expect(404);
    const withDeleted = await auth(request(app).get('/usuarios?include_deleted=true&search=borrar')).expect(200);
    expect(withDeleted.body.data.some((item) => item.id === created.body.id)).toBe(true);
  });

  test('requiere autenticacion y rol admin', async () => {
    await request(app).get('/usuarios').expect(401);

    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const user = await prisma.usuario.create({
      data: {
        nombre: 'Tecnico usuarios',
        usuario: `tecnico_usuarios_${unique}`,
        password_hash: 'hash',
        rol: 'TECNICO'
      }
    });
    await prisma.usuarioSucursal.create({ data: { usuarioId: user.id, sucursalId: sucursal.id, rol: 'TECNICO' } });

    const res = await auth(request(app).get('/usuarios'), user).expect(403);
    expect(res.body.error).toMatch(/permisos/i);
  });

  test('rechaza usuario duplicado', async () => {
    const payload = {
      nombre: 'Duplicado',
      usuario: `duplicado_${Date.now()}`,
      password: 'claveSegura1',
      rol: 'VENDEDOR'
    };

    await auth(request(app).post('/usuarios')).send(payload).expect(201);
    const duplicate = await auth(request(app).post('/usuarios')).send({ ...payload, nombre: 'Otro nombre' }).expect(409);
    expect(duplicate.body.error).toMatch(/existe/i);
  });
});