const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;

function auth(req, user = adminUser) {
  if (!user) {
    throw new Error('No hay usuario autenticado configurado para el test.');
  }
  if (!sucursal) {
    throw new Error('No hay sucursal configurada para el test.');
  }
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', sucursal.id);
}

describe('Clientes API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
      // Orden de borrado respeta FK: recibo_detalle -> recibo -> ventas -> caja/usuarios
    await prisma.reciboDetalle.deleteMany();
    await prisma.recibo.deleteMany();
    await prisma.detalleVenta.deleteMany();
    await prisma.venta.deleteMany();
    await prisma.salidaCaja.deleteMany();
    await prisma.cierreCaja.deleteMany();
    await prisma.aperturaCaja.deleteMany();
    await prisma.usuarioSucursal.deleteMany();
    await prisma.usuario.deleteMany();
    await prisma.cliente.deleteMany();
    await prisma.sucursal.deleteMany();

    sucursal = await prisma.sucursal.create({
      data: { nombre: 'Sucursal Test' }
    });

    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin pruebas',
        usuario: 'admin.pruebas',
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
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('valida que nombre sea obligatorio', async () => {
    const res = await auth(request(app).post('/clientes')).send({}).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  test('crea cliente y maneja ruc duplicado', async () => {
    const payload = {
      nombre_razon_social: 'Cliente Test',
      ruc: '80000001-0',
      correo: 'cliente@test.com'
    };

    const created = await auth(request(app).post('/clientes')).send(payload).expect(201);
    expect(created.body.nombre_razon_social).toBe(payload.nombre_razon_social);

    const dup = await auth(request(app).post('/clientes'))
      .send({ ...payload, nombre_razon_social: 'Otro' })
      .expect(409);
    expect(dup.body.error).toMatch(/ya existe/i);
  });

  test('lista clientes con filtros y soporta soft delete', async () => {
    const clientes = [
      { nombre_razon_social: 'Cliente Uno', ruc: '11111101-0', tipo_cliente: 'EMPRESA' },
      { nombre_razon_social: 'Cliente Dos', ruc: '22222201-0', tipo_cliente: 'PERSONA' },
      { nombre_razon_social: 'Cliente Tres', ruc: '33333301-0', tipo_cliente: 'EMPRESA' }
    ];

    const created = [];
    for (const payload of clientes) {
      const res = await auth(request(app).post('/clientes')).send(payload).expect(201);
      created.push(res.body);
    }

    await auth(request(app).delete(`/clientes/${created[1].id}`)).expect(200);

    const list = await auth(request(app).get('/clientes?search=cliente&pageSize=2')).expect(200);
    expect(list.body.data.length).toBeLessThanOrEqual(2);
    expect(list.body.meta.total).toBe(2);

    const empresas = await auth(request(app).get('/clientes?tipo_cliente=empresa')).expect(200);
    expect(empresas.body.data.every((c) => c.tipo_cliente?.toUpperCase() === 'EMPRESA')).toBe(true);

    const withDeleted = await auth(request(app).get('/clientes?include_deleted=true')).expect(200);
    expect(withDeleted.body.data.some((c) => c.id === created[1].id)).toBe(true);
  });
});
