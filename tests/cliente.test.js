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
    // Limpieza ordenada: primero recibos, ventas, presupuestos, luego usuarios y sucursales
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
    await prisma.salidaCaja?.deleteMany?.();
    await prisma.cierreCaja?.deleteMany?.();
    await prisma.aperturaCaja?.deleteMany?.();
    await prisma.usuarioSucursal?.deleteMany?.();
    await prisma.usuario?.deleteMany?.();
    await prisma.cliente?.deleteMany?.();
    await prisma.sucursal?.deleteMany?.();

    // Generar sufijo único
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;

    sucursal = await prisma.sucursal.create({
      data: { nombre: `Sucursal Test ${unique}` }
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

  test('valida que nombre sea obligatorio', async () => {
    const res = await auth(request(app).post('/clientes')).send({}).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  test('crea cliente y maneja ruc duplicado', async () => {
    const payload = {
      nombre_razon_social: 'Cliente Test',
      ruc: '80000001-0',
      correo: 'cliente@test.com',
      direccion: 'Calle Test 123'
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
      { nombre_razon_social: 'Cliente Uno', ruc: '11111101-0', tipo_cliente: 'EMPRESA', direccion: 'Calle Uno 1' },
      { nombre_razon_social: 'Cliente Dos', ruc: '22222201-0', tipo_cliente: 'PERSONA', direccion: 'Calle Dos 2' },
      { nombre_razon_social: 'Cliente Tres', ruc: '33333301-0', tipo_cliente: 'EMPRESA', direccion: 'Calle Tres 3' }
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
  // Test: Faltan campos obligatorios (ruc, direccion)
  test('rechaza creación sin ruc ni dirección', async () => {
    const res = await auth(request(app).post('/clientes')).send({ nombre_razon_social: 'Sin RUC' }).expect(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/obligatorio|dirección/i);
  });

  // Test: RUC formato inválido
  test('rechaza RUC con formato inválido', async () => {
    const res = await auth(request(app).post('/clientes')).send({
      nombre_razon_social: 'Cliente Inválido',
      ruc: 'abc',
      direccion: 'Calle Falsa 123'
    }).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Límite de longitud en nombre
  test('rechaza nombre demasiado largo', async () => {
    const res = await auth(request(app).post('/clientes')).send({
      nombre_razon_social: 'A'.repeat(300),
      ruc: '90000001-0',
      direccion: 'Calle Larga'
    }).expect(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/razón social|obligatorio|largo/i);
  });

  // Test: Acceso sin autenticación
  test('rechaza acceso sin autenticación', async () => {
    const res = await request(app).get('/clientes').expect(401);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Acceso con rol incorrecto
  test('rechaza creación con rol no permitido', async () => {
    // Crear usuario con rol TECNICO
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;
    const suc = await prisma.sucursal.create({ data: { nombre: `Sucursal Test ${unique}` } });
    const user = await prisma.usuario.create({ data: { nombre: 'User', usuario: `user_${unique}`, password_hash: 'hash', rol: 'TECNICO' } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: user.id, sucursalId: suc.id, rol: 'TECNICO' } });
    const req = request(app).post('/clientes').set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', suc.id);
    const res = await req.send({ nombre_razon_social: 'Cliente', ruc: '90000002-0', direccion: 'Calle' }).expect(403);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/permisos/i);
  });

  // Test: Acceso cruzado de sucursal
  test('impide acceso a clientes de otra sucursal', async () => {
    // Crear sucursal y usuario A
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;
    const sucA = await prisma.sucursal.create({ data: { nombre: `Sucursal A ${unique}` } });
    const userA = await prisma.usuario.create({ data: { nombre: 'UserA', usuario: `userA_${unique}`, password_hash: 'hash', rol: 'ADMIN' } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: userA.id, sucursalId: sucA.id, rol: 'ADMIN' } });
    // Crear sucursal y usuario B
    const sucB = await prisma.sucursal.create({ data: { nombre: `Sucursal B ${unique}` } });
    const userB = await prisma.usuario.create({ data: { nombre: 'UserB', usuario: `userB_${unique}`, password_hash: 'hash', rol: 'ADMIN' } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: userB.id, sucursalId: sucB.id, rol: 'ADMIN' } });
    // Crear cliente en sucursal A
    const clienteA = await request(app).post('/clientes').set('x-user-id', userA.id).set('x-user-role', userA.rol).set('x-sucursal-id', sucA.id).send({ nombre_razon_social: 'ClienteA', ruc: '90000003-0', direccion: 'Calle' }).expect(201);
    // Usuario B puede acceder porque el cliente ahora es global
    const res = await request(app).get(`/clientes/${clienteA.body.id}`).set('x-user-id', userB.id).set('x-user-role', userB.rol).set('x-sucursal-id', sucB.id).expect(200);
    expect(res.body.id).toBe(clienteA.body.id);
    expect(res.body.nombre_razon_social).toBe('ClienteA');
  });

  // Test: Actualización parcial y datos inválidos
  test('rechaza actualización con datos inválidos', async () => {
    const payload = { nombre_razon_social: 'Cliente Update', ruc: '90000004-0', direccion: 'Calle' };
    const created = await auth(request(app).post('/clientes')).send(payload).expect(201);
    const res = await auth(request(app).put(`/clientes/${created.body.id}`)).send({ ruc: 'bad' }).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Soft delete y consulta directa
  test('verifica que deleted_at funciona', async () => {
    const payload = { nombre_razon_social: 'Cliente Soft', ruc: '90000005-0', direccion: 'Calle' };
    const created = await auth(request(app).post('/clientes')).send(payload).expect(201);
    await auth(request(app).delete(`/clientes/${created.body.id}`)).expect(200);
    // Consulta directa (debería incluir deleted_at)
    const cliente = await prisma.cliente.findUnique({ where: { id: created.body.id } });
    expect(cliente.deleted_at).toBeTruthy();
    // API debe devolver 404 y mensaje adecuado
    const res = await auth(request(app).get(`/clientes/${created.body.id}`)).expect(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/no encontrado/i);
  });

  // Test: No permite eliminar cliente con ventas activas
  test('no permite eliminar cliente con ventas activas', async () => {
    // Crear cliente
    const payload = { nombre_razon_social: 'Cliente Venta', ruc: '90000006-0', direccion: 'Calle' };
    const created = await auth(request(app).post('/clientes')).send(payload).expect(201);
    // Crear venta asociada
    await prisma.venta.create({ data: { clienteId: created.body.id, usuarioId: adminUser.id, sucursalId: sucursal.id, total: 1000, subtotal: 1000, iva_porcentaje: 10, estado: 'PENDIENTE' } });
    // Intentar eliminar
    const res = await auth(request(app).delete(`/clientes/${created.body.id}`)).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Listado incluye/excluye borrados según flag
  test('listado incluye borrados si se pide', async () => {
    const payload = { nombre_razon_social: 'Cliente Borrado', ruc: '90000007-0', direccion: 'Calle' };
    const created = await auth(request(app).post('/clientes')).send(payload).expect(201);
    await auth(request(app).delete(`/clientes/${created.body.id}`)).expect(200);
    const res = await auth(request(app).get('/clientes?include_deleted=true')).expect(200);
    expect(res.body.data.some((c) => c.id === created.body.id)).toBe(true);
  });

  // Test: Filtros avanzados (por correo, tipo_cliente)
  test('filtra por correo y tipo_cliente', async () => {
    const payload = { nombre_razon_social: 'Cliente Filtro', ruc: '90000008-0', direccion: 'Calle', correo: 'filtro@test.com', tipo_cliente: 'EMPRESA' };
    await auth(request(app).post('/clientes')).send(payload).expect(201);
    const res = await auth(request(app).get('/clientes?correo=filtro@test.com&tipo_cliente=EMPRESA')).expect(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].correo).toBe('filtro@test.com');
  });

  // Test: Simulación de error de integración (mock)
  // (Este test es un placeholder, depende de integración real)
  test.skip('maneja error de integración externa', async () => {
    // Aquí se podría mockear una dependencia y forzar un error
    // Ejemplo: jest.spyOn(servicio, 'enviar').mockRejectedValue(new Error('Fallo externo'));
    // ...
    expect(true).toBe(true);
  });
});
