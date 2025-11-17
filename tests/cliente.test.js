const request = require('supertest');
const { app, prisma } = require('../src/app');

describe('Clientes API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.detalleVenta.deleteMany();
    await prisma.venta.deleteMany();
    await prisma.cliente.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('valida que nombre sea obligatorio', async () => {
    const res = await request(app).post('/clientes').send({}).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  test('crea cliente y maneja ruc duplicado', async () => {
    const payload = {
      nombre_razon_social: 'Cliente Test',
      ruc: '80000001-0',
      correo: 'cliente@test.com'
    };

    const created = await request(app).post('/clientes').send(payload).expect(201);
    expect(created.body.nombre_razon_social).toBe(payload.nombre_razon_social);

    const dup = await request(app).post('/clientes').send({ ...payload, nombre_razon_social: 'Otro' }).expect(409);
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
      const res = await request(app).post('/clientes').send(payload).expect(201);
      created.push(res.body);
    }

    await request(app).delete(`/clientes/${created[1].id}`).expect(200);

    const list = await request(app).get('/clientes?search=cliente&pageSize=2').expect(200);
    expect(list.body.data.length).toBeLessThanOrEqual(2);
    expect(list.body.meta.total).toBe(2);

    const empresas = await request(app).get('/clientes?tipo_cliente=empresa').expect(200);
    expect(empresas.body.data.every((c) => c.tipo_cliente?.toUpperCase() === 'EMPRESA')).toBe(true);

    const withDeleted = await request(app).get('/clientes?include_deleted=true').expect(200);
    expect(withDeleted.body.data.some((c) => c.id === created[1].id)).toBe(true);
  });
});
