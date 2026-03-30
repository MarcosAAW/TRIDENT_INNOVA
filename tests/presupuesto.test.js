const request = require('supertest');
const { app } = require('../src/app');
const prisma = require('../src/prismaClient');

describe('Presupuestos API', () => {
  let token;
  let sucursalId;
  let clienteId;
  let usuarioId;

  beforeAll(async () => {
    // Limpieza ordenada: primero presupuestos, luego usuarios y sucursales
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
    await prisma.usuarioSucursal?.deleteMany?.();
    await prisma.usuario?.deleteMany?.();
    await prisma.cliente?.deleteMany?.();
    await prisma.sucursal?.deleteMany?.();

    // Generar sufijo único
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;

    // Crear sucursal de prueba
    const sucursal = await prisma.sucursal.create({
      data: {
        nombre: `Sucursal Test ${unique}`,
        ciudad: 'Test City',
        direccion: 'Test Address',
        telefono: '1234567'
      }
    });
    sucursalId = sucursal.id;

    // Crear usuario de prueba
    const usuario = await prisma.usuario.create({
      data: {
        nombre: 'Usuario Test',
        usuario: `usuariotest_presupuesto_${unique}`,
        password_hash: await require('bcryptjs').hash('testpass123', 10),
        rol: 'ADMIN',
        activo: true
      }
    });
    usuarioId = usuario.id;

    // Relacionar usuario con sucursal
    await prisma.usuarioSucursal.create({
      data: {
        usuarioId,
        sucursalId,
        rol: 'ADMIN'
      }
    });

    // Crear cliente de prueba
    const cliente = await prisma.cliente.create({
      data: {
        nombre_razon_social: `Cliente Test ${unique}`,
        ruc: `1234567-${unique.slice(-4)}`,
        direccion: 'Calle Falsa 123',
        telefono: '555-1234',
        correo: `cliente${unique}@test.com`
      }
    });
    clienteId = cliente.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('Crea un presupuesto válido', async () => {
    const res = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({
        clienteId,
        moneda: 'PYG',
        detalles: [
          { cantidad: 1, precio_unitario: 10000, iva_porcentaje: 10 }
        ]
      });
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.moneda).toBe('PYG');
  });

  test('mantiene el precio original en USD al presupuestar con nuevo tipo de cambio', async () => {
    const productoUsd = await prisma.producto.create({
      data: {
        sku: `PRES-USD-${Date.now()}`,
        nombre: 'Producto presupuesto USD',
        tipo: 'REPUESTO',
        precio_venta: 70000,
        precio_venta_original: 10,
        moneda_precio_venta: 'USD',
        tipo_cambio_precio_venta: 7000,
        stock_actual: 4,
        sucursalId
      }
    });

    const res = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({
        clienteId,
        moneda: 'USD',
        tipo_cambio: 6500,
        detalles: [
          { productoId: productoUsd.id, cantidad: 1, iva_porcentaje: 10 }
        ]
      });

    expect(res.statusCode).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(65000, 2);
    expect(Number(res.body.total_moneda)).toBeCloseTo(10, 2);
  });

  test('Lista presupuestos paginados', async () => {
    const res = await request(app)
      .get('/presupuestos?page=1&pageSize=5')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('Obtiene un presupuesto por ID', async () => {
    // Primero crea uno
    const createRes = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({
        clienteId,
        moneda: 'PYG',
        detalles: [
          { cantidad: 2, precio_unitario: 5000, iva_porcentaje: 5 }
        ]
      });
    const id = createRes.body.id;
    const res = await request(app)
      .get(`/presupuestos/${id}`)
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('id', id);
  });

  test('Actualiza el estado del presupuesto', async () => {
    // Crea uno
    const createRes = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({
        clienteId,
        moneda: 'PYG',
        detalles: [
          { cantidad: 1, precio_unitario: 10000, iva_porcentaje: 10 }
        ]
      });
    const id = createRes.body.id;
    const res = await request(app)
      .put(`/presupuestos/${id}/estado`)
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({ estado: 'VENCIDO' });
    expect(res.statusCode).toBe(200);
    expect(res.body.estado).toBe('VENCIDO');
  });

  test('Genera PDF de presupuesto', async () => {
    // Crea uno
    const createRes = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({
        clienteId,
        moneda: 'PYG',
        detalles: [
          { cantidad: 1, precio_unitario: 10000, iva_porcentaje: 10 }
        ]
      });
    const id = createRes.body.id;
    const res = await request(app)
      .get(`/presupuestos/${id}/pdf`)
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });
  // Test: Faltan campos obligatorios
  test('rechaza creación sin clienteId o detalles', async () => {
    const res = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({ moneda: 'PYG' })
      .expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Detalles con datos inválidos
  test('rechaza detalles con cantidad negativa', async () => {
    const res = await request(app)
      .post('/presupuestos')
      .set('x-user-id', usuarioId)
      .set('x-sucursal-id', sucursalId)
      .send({ clienteId, moneda: 'PYG', detalles: [{ cantidad: -1, precio_unitario: 1000, iva_porcentaje: 10 }] })
      .expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Acceso sin autenticación
  test('rechaza acceso sin autenticación', async () => {
    const res = await request(app).get('/presupuestos').expect(401);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Acceso con rol incorrecto
  test('rechaza creación con rol no permitido', async () => {
    // Crear usuario con rol TECNICO
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;
    const suc = await prisma.sucursal.create({ data: { nombre: `Sucursal Test ${unique}` } });
    const user = await prisma.usuario.create({ data: { nombre: 'User', usuario: `user_${unique}`, password_hash: 'hash', rol: 'TECNICO', activo: true } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: user.id, sucursalId: suc.id, rol: 'TECNICO' } });
    const req = request(app).post('/presupuestos').set('x-user-id', user.id).set('x-sucursal-id', suc.id);
    const res = await req.send({ clienteId, moneda: 'PYG', detalles: [{ cantidad: 1, precio_unitario: 1000, iva_porcentaje: 10 }] }).expect(403);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/permisos/i);
  });

  // Test: Acceso cruzado de sucursal
  test('impide acceso a presupuestos de otra sucursal', async () => {
    // Crear sucursal y usuario A
    const unique = `${Date.now()}_${Math.floor(Math.random()*10000)}`;
    const sucA = await prisma.sucursal.create({ data: { nombre: `Sucursal A ${unique}` } });
    const userA = await prisma.usuario.create({ data: { nombre: 'UserA', usuario: `userA_${unique}`, password_hash: 'hash', rol: 'ADMIN', activo: true } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: userA.id, sucursalId: sucA.id, rol: 'ADMIN' } });
    // Crear sucursal y usuario B
    const sucB = await prisma.sucursal.create({ data: { nombre: `Sucursal B ${unique}` } });
    const userB = await prisma.usuario.create({ data: { nombre: 'UserB', usuario: `userB_${unique}`, password_hash: 'hash', rol: 'ADMIN', activo: true } });
    await prisma.usuarioSucursal.create({ data: { usuarioId: userB.id, sucursalId: sucB.id, rol: 'ADMIN' } });
    // Crear presupuesto en sucursal A
    const presA = await request(app).post('/presupuestos').set('x-user-id', userA.id).set('x-sucursal-id', sucA.id).send({ clienteId, moneda: 'PYG', detalles: [{ cantidad: 1, precio_unitario: 1000, iva_porcentaje: 10 }] }).expect(201);
    // Usuario B intenta acceder
    const res = await request(app).get(`/presupuestos/${presA.body.id}`).set('x-user-id', userB.id).set('x-sucursal-id', sucB.id).expect(404);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Soft delete y consulta directa
  test('verifica que deleted_at funciona', async () => {
    const pres = await request(app).post('/presupuestos').set('x-user-id', usuarioId).set('x-sucursal-id', sucursalId).send({ clienteId, moneda: 'PYG', detalles: [{ cantidad: 1, precio_unitario: 1000, iva_porcentaje: 10 }] }).expect(201);
    await request(app).delete(`/presupuestos/${pres.body.id}`).set('x-user-id', usuarioId).set('x-sucursal-id', sucursalId).expect(200);
    // Consulta directa (debería incluir deleted_at)
    const presupuesto = await prisma.presupuesto.findUnique({ where: { id: pres.body.id } });
    expect(presupuesto.deleted_at).not.toBeNull();
  });

  // Test: Listado incluye/excluye borrados según flag
  test('listado incluye borrados si se pide', async () => {
    const pres = await request(app).post('/presupuestos').set('x-user-id', usuarioId).set('x-sucursal-id', sucursalId).send({ clienteId, moneda: 'PYG', detalles: [{ cantidad: 1, precio_unitario: 1000, iva_porcentaje: 10 }] }).expect(201);
    await request(app).delete(`/presupuestos/${pres.body.id}`).set('x-user-id', usuarioId).set('x-sucursal-id', sucursalId).expect(200);
    const res = await request(app).get('/presupuestos?include_deleted=true').set('x-user-id', usuarioId).set('x-sucursal-id', sucursalId).expect(200);
    expect(res.body.data.some((p) => p.id === pres.body.id)).toBe(true);
  });

  // Test: Simulación de error de integración (mock)
  test.skip('maneja error de integración externa', async () => {
    // Aquí se podría mockear una dependencia y forzar un error
    // Ejemplo: jest.spyOn(servicio, 'enviar').mockRejectedValue(new Error('Fallo externo'));
    // ...
    expect(true).toBe(true);
  });
});
