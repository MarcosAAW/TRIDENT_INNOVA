const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;

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
  if (!sucursal) {
    throw new Error('No hay sucursal configurada para el test.');
  }
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', sucursal.id);
}

describe('Productos API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    // Limpieza ordenada: primero recibos, ventas, presupuestos, luego usuarios y sucursales
    await prisma.reciboDetalle?.deleteMany?.();
    await prisma.recibo?.deleteMany?.();
    await prisma.notaCreditoDetalle?.deleteMany?.();
    await prisma.notaCreditoElectronica?.deleteMany?.();
    await prisma.facturaDigital?.deleteMany?.();
    await prisma.facturaElectronica?.deleteMany?.();
    await prisma.detalleVenta?.deleteMany?.();
    await prisma.movimientoStock?.deleteMany?.();
    await prisma.venta?.deleteMany?.();
    await prisma.detallePresupuesto?.deleteMany?.();
    await prisma.presupuesto?.deleteMany?.();
    await prisma.productoStock?.deleteMany?.();
    await prisma.producto?.deleteMany?.();
    await prisma.salidaCaja?.deleteMany?.();
    await prisma.cierreCaja?.deleteMany?.();
    await prisma.aperturaCaja?.deleteMany?.();
    await prisma.usuarioSucursal?.deleteMany?.();
    await prisma.usuario?.deleteMany?.();
    await prisma.sucursal?.deleteMany?.();

    // Generar sufijo único
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;

    sucursal = await prisma.sucursal.create({
      data: {
        nombre: `Sucursal Test ${unique}`
      }
    });

    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin pruebas',
        usuario: `admin.pruebas_${unique}`,
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
  // Test: Faltan campos obligatorios
  test('rechaza creación sin sku ni nombre', async () => {
    const res = await auth(request(app).post('/productos')).send({ tipo: 'DRON', precio_venta: 1000, stock_actual: 1 }).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Precio negativo
  test('rechaza precio_venta negativo', async () => {
    const res = await auth(request(app).post('/productos')).send({ ...basePayload, precio_venta: -100 }).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Acceso sin autenticación
  test('rechaza acceso sin autenticación', async () => {
    const res = await request(app).get('/productos').expect(401);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Acceso con rol incorrecto
  test('rechaza creación con rol no permitido', async () => {
    // Crear usuario con rol GERENCIA
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;
    const suc = await prisma.sucursal.create({ data: { nombre: `Sucursal Test ${unique}` } });
    const user = await prisma.usuario.create({ data: { nombre: 'User', usuario: `user_${unique}`, password_hash: 'hash', rol: 'GERENCIA' } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: user.id, sucursalId: suc.id, rol: 'GERENCIA' } });
    const req = request(app).post('/productos').set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', suc.id);
    const res = await req.send({ ...basePayload, sku: 'ROL-TEST', nombre: 'Rol Test' }).expect(403);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/permisos/i);
  });

  // Test: Acceso cruzado de sucursal
  test('comparte productos entre sucursales pero mantiene stock separado', async () => {
    // Crear sucursal y usuario A
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;
    const sucA = await prisma.sucursal.create({ data: { nombre: `Sucursal A ${unique}` } });
    const userA = await prisma.usuario.create({ data: { nombre: 'UserA', usuario: `userA_${unique}`, password_hash: 'hash', rol: 'ADMIN' } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: userA.id, sucursalId: sucA.id, rol: 'ADMIN' } });
    // Crear sucursal y usuario B
    const sucB = await prisma.sucursal.create({ data: { nombre: `Sucursal B ${unique}` } });
    const userB = await prisma.usuario.create({ data: { nombre: 'UserB', usuario: `userB_${unique}`, password_hash: 'hash', rol: 'ADMIN' } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: userB.id, sucursalId: sucB.id, rol: 'ADMIN' } });
    // Crear producto en sucursal A
    const prodA = await request(app).post('/productos').set('x-user-id', userA.id).set('x-user-role', userA.rol).set('x-sucursal-id', sucA.id).send({ ...basePayload, sku: `SKU-A-${unique}` }).expect(201);

    const desdeSucursalB = await request(app).get(`/productos/${prodA.body.id}`).set('x-user-id', userB.id).set('x-user-role', userB.rol).set('x-sucursal-id', sucB.id).expect(200);
    expect(Number(desdeSucursalB.body.stock_actual)).toBe(0);

    await request(app)
      .put(`/productos/${prodA.body.id}`)
      .set('x-user-id', userB.id)
      .set('x-user-role', userB.rol)
      .set('x-sucursal-id', sucB.id)
      .send({ stock_actual: 3 })
      .expect(200);

    const desdeSucursalA = await request(app).get(`/productos/${prodA.body.id}`).set('x-user-id', userA.id).set('x-user-role', userA.rol).set('x-sucursal-id', sucA.id).expect(200);
    const actualizadoSucursalB = await request(app).get(`/productos/${prodA.body.id}`).set('x-user-id', userB.id).set('x-user-role', userB.rol).set('x-sucursal-id', sucB.id).expect(200);

    expect(Number(desdeSucursalA.body.stock_actual)).toBe(5);
    expect(Number(actualizadoSucursalB.body.stock_actual)).toBe(3);
  });

  // Test: Soft delete y consulta directa
  test('verifica que deleted_at funciona', async () => {
    const prod = await auth(request(app).post('/productos')).send({ ...basePayload, sku: `SOFT-DEL-${Date.now()}` }).expect(201);
    await auth(request(app).delete(`/productos/${prod.body.id}`)).expect(200);
    // Consulta directa (debería incluir deleted_at)
    const producto = await prisma.producto.findUnique({ where: { id: prod.body.id } });
    expect(producto.deleted_at).not.toBeNull();
  });

  // Test: Listado incluye/excluye borrados según flag
  test('listado incluye borrados si se pide', async () => {
    const prod = await auth(request(app).post('/productos')).send({ ...basePayload, sku: `BORRADO-${Date.now()}` }).expect(201);
    await auth(request(app).delete(`/productos/${prod.body.id}`)).expect(200);
    const res = await auth(request(app).get('/productos?include_deleted=true')).expect(200);
    expect(res.body.data.some((p) => p.id === prod.body.id)).toBe(true);
  });

  // Test: Simulación de error de integración (mock)
  test.skip('maneja error de integración externa', async () => {
    // Aquí se podría mockear una dependencia y forzar un error
    // Ejemplo: jest.spyOn(servicio, 'generarReporte').mockRejectedValue(new Error('Fallo externo'));
    // ...
    expect(true).toBe(true);
  });
});
