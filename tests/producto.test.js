const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;

const basePayload = {
  sku: 'DRON-TEST',
  nombre: 'Dron de prueba',
  tipo: 'DRON',
  precio_venta: 1000000,
  stock_actual: 5
};

function binaryParser(res, callback) {
  res.setEncoding('binary');
  res.data = '';
  res.on('data', (chunk) => {
    res.data += chunk;
  });
  res.on('end', () => {
    callback(null, Buffer.from(res.data, 'binary'));
  });
}

function auth(req, user = adminUser) {
  if (!user) {
    throw new Error('No hay usuario autenticado configurado para el test.');
  }
  return req.set('x-user-id', user.id).set('x-user-role', user.rol);
}

describe('Productos API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.detalleVenta.deleteMany();
    await prisma.movimientoStock.deleteMany();
    await prisma.venta.deleteMany();
    await prisma.producto.deleteMany();
    await prisma.salidaCaja.deleteMany();
    await prisma.cierreCaja.deleteMany();
    await prisma.aperturaCaja.deleteMany();
    await prisma.usuario.deleteMany();

    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin pruebas',
        usuario: 'admin.pruebas',
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('rechaza tipo inválido', async () => {
    const response = await auth(request(app).post('/productos'))
      .send({ ...basePayload, tipo: 'INVALIDO' })
      .expect(400);

    expect(response.body).toHaveProperty('error');
  });

  test('crea producto y evita duplicados de sku', async () => {
    await auth(request(app).post('/productos')).send(basePayload).expect(201);

    const dup = await auth(request(app).post('/productos'))
      .send({ ...basePayload, nombre: 'Otro nombre' })
      .expect(409);

    expect(dup.body.error).toMatch(/ya existe/i);
  });

  test('lista con filtros, paginación y excluye borrados por defecto', async () => {
    const productos = [
      { sku: 'DRON-001', nombre: 'Dron Profesional', tipo: 'DRON', precio_venta: 2500000, stock_actual: 8 },
      { sku: 'REP-001', nombre: 'Repuesto Hélice', tipo: 'REPUESTO', precio_venta: 120000, stock_actual: 25 },
      { sku: 'SER-001', nombre: 'Servicio Técnico', tipo: 'SERVICIO', precio_venta: 500000, stock_actual: 0 }
    ];

    const created = [];
    for (const payload of productos) {
      const res = await auth(request(app).post('/productos')).send(payload).expect(201);
      created.push(res.body);
    }

    // Soft delete uno
    await auth(request(app).delete(`/productos/${created[2].id}`)).expect(200);

    const list = await auth(request(app).get('/productos?search=dron&pageSize=1')).expect(200);
    expect(list.body).toEqual(
      expect.objectContaining({
        data: expect.any(Array),
        meta: expect.objectContaining({ page: 1, pageSize: 1, total: 1, totalPages: 1 })
      })
    );
    expect(list.body.data[0].sku).toBe('DRON-001');

    const listadoGeneral = await auth(request(app).get('/productos')).expect(200);
    expect(listadoGeneral.body.data.some((p) => p.id === created[2].id)).toBe(false);

    const incluyeEliminados = await auth(request(app).get('/productos?include_deleted=true')).expect(200);

    const deletedItems = incluyeEliminados.body.data.filter((p) => p.deleted_at !== null);
    expect(deletedItems.length).toBeGreaterThanOrEqual(1);

    const activos = await auth(request(app).get('/productos?activo=true&pageSize=10')).expect(200);

    expect(activos.body.data.every((p) => p.activo)).toBe(true);
  });

  test('convierte precios en USD a guaraníes y guarda la referencia', async () => {
    const payload = {
      sku: 'DRON-USD',
      nombre: 'Dron importado',
      tipo: 'DRON',
      precio_venta: 100,
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: 7300,
      stock_actual: 2
    };

    const response = await auth(request(app).post('/productos')).send(payload).expect(201);
    expect(response.body).toHaveProperty('id');

    const stored = await prisma.producto.findUnique({ where: { id: response.body.id } });
    expect(stored).not.toBeNull();
    expect(stored.moneda_precio_venta).toBe('USD');
    expect(Number(stored.precio_venta.toString())).toBeCloseTo(730000, 2);
    expect(Number(stored.precio_venta_original.toString())).toBeCloseTo(100, 2);
    expect(Number(stored.tipo_cambio_precio_venta.toString())).toBeCloseTo(7300, 4);
  });

  test('genera un PDF con el reporte de inventario', async () => {
    await auth(request(app).post('/productos')).send(basePayload).expect(201);
    await auth(request(app).post('/productos'))
      .send({ ...basePayload, sku: 'CRITICO-1', nombre: 'Bajo stock', stock_actual: 1, minimo_stock: 5 })
      .expect(201);

    const response = await auth(request(app).get('/productos/reporte/inventario'))
      .buffer()
      .parse(binaryParser)
      .expect(200);

    expect(response.headers['content-type']).toMatch(/application\/pdf/);
    expect(response.body).toBeInstanceOf(Buffer);
    expect(response.body.length).toBeGreaterThan(1000);
  });
});
