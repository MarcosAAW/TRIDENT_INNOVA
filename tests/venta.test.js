jest.mock('../src/prismaClient', () => {
  const { FakePrisma } = require('./helpers/fakePrisma');
  return new FakePrisma();
});

const request = require('supertest');
const prisma = require('../src/prismaClient');
const { app } = require('../src/app');

describe('Ventas API (integración)', () => {
  let usuario;
  let producto;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    // Limpiar tablas relevantes
    await prisma.detalleVenta.deleteMany().catch(() => {});
    await prisma.movimientoStock.deleteMany().catch(() => {});
  await prisma.facturaElectronica.deleteMany().catch(() => {});
    await prisma.venta.deleteMany().catch(() => {});
    await prisma.producto.deleteMany().catch(() => {});
    await prisma.usuario.deleteMany().catch(() => {});

    usuario = await prisma.usuario.create({ data: {
      nombre: 'Tester', usuario: 'tester', password_hash: 'hash', rol: 'ADMIN'
    }});

    producto = await prisma.producto.create({ data: {
      sku: 'TEST-SKU', nombre: 'Producto Test', tipo: 'REPUESTO', precio_venta: '1000.00', stock_actual: 5
    }});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('Crear venta válida decrementa stock y crea movimiento', async () => {
    const payload = {
      usuarioId: usuario.id,
      iva_porcentaje: 10,
      detalles: [ { productoId: producto.id, cantidad: 2 } ]
    };

    const res = await request(app).post('/ventas').send(payload).expect(201);
    expect(res.body).toBeDefined();
    expect(res.body.iva_porcentaje).toBe(10);
    expect(Number(res.body.subtotal)).toBe(2000);
    expect(Number(res.body.total)).toBeCloseTo(2000, 2);
    expect(Number(res.body.impuesto_total)).toBeCloseTo(2000 / 11, 2);
    // Verificar stock
    const prod = await prisma.producto.findUnique({ where: { id: producto.id } });
    expect(prod.stock_actual).toBe(3);

    // Verificar movimiento
    const movimientos = await prisma.movimientoStock.findMany({ where: { productoId: producto.id } });
    expect(movimientos.length).toBeGreaterThanOrEqual(1);
    expect(movimientos[0].tipo).toBe('SALIDA');
  });

  test('Crear venta con stock insuficiente revierte y devuelve 400', async () => {
    const payload = {
      usuarioId: usuario.id,
      iva_porcentaje: 10,
      detalles: [ { productoId: producto.id, cantidad: 10 } ]
    };

    const res = await request(app).post('/ventas').send(payload).expect(400);
    expect(res.body).toBeDefined();
    // Stock no debe cambiar
    const prod = await prisma.producto.findUnique({ where: { id: producto.id } });
    expect(prod.stock_actual).toBe(5);
  });

  test('Listar ventas devuelve historial con cliente y usuario', async () => {
    await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const res = await request(app).get('/ventas').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const venta = res.body.data[0];
    expect(venta).toHaveProperty('detalles');
    expect(venta).toHaveProperty('usuario');
    expect(venta).toHaveProperty('cliente');
    expect(res.body.meta).toMatchObject({ page: 1, total: res.body.data.length });
  });

  test('Buscar ventas por número de factura devuelve coincidencias', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const facturaRes = await request(app).post(`/ventas/${createRes.body.id}/facturar`).expect(200);
    const numeroFactura = facturaRes.body.factura?.nro_factura;
    expect(numeroFactura).toBeTruthy();

    const res = await request(app).get('/ventas').query({ search: numeroFactura }).expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].factura_electronica?.nro_factura).toBe(numeroFactura);
  });

  test('Anular venta repone stock y marca estado', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    const ventaId = createRes.body.id;
    expect(ventaId).toBeDefined();

    const cancelRes = await request(app)
      .post(`/ventas/${ventaId}/anular`)
      .send({ motivo: 'Error de carga' })
      .expect(200);

    expect(cancelRes.body.estado).toBe('ANULADA');
    expect(cancelRes.body.deleted_at).toBeTruthy();

    const productoActualizado = await prisma.producto.findUnique({ where: { id: producto.id } });
    expect(productoActualizado.stock_actual).toBe(5);

    const movimientos = await prisma.movimientoStock.findMany({ where: { productoId: producto.id } });
    const tieneEntrada = movimientos.some((mov) => mov.tipo === 'ENTRADA');
    expect(tieneEntrada).toBe(true);

    await request(app).post(`/ventas/${ventaId}/anular`).send({ motivo: 'Otro' }).expect(400);
  });

  test('Generar factura electrónica para una venta', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const ventaId = createRes.body.id;
    expect(ventaId).toBeDefined();

    const facturaRes = await request(app).post(`/ventas/${ventaId}/facturar`).expect(200);
    expect(facturaRes.body).toBeDefined();
    expect(facturaRes.body.factura).toBeDefined();
    expect(facturaRes.body.venta).toBeDefined();
    expect(facturaRes.body.venta.factura_electronicaId).toBe(facturaRes.body.factura.id);
    expect(facturaRes.body.venta.estado).toBe('FACTURADO');
    expect(facturaRes.body.factura.nro_factura).toMatch(/^001-001-/);
    expect(facturaRes.body.factura.estado).toBe('PAGADA');
    expect(Number(facturaRes.body.factura.intentos)).toBe(1);
  expect(typeof facturaRes.body.factura.pdf_path).toBe('string');
  expect(facturaRes.body.factura.pdf_path.endsWith('.pdf')).toBe(true);
    expect(typeof facturaRes.body.factura.xml_path).toBe('string');
    expect(facturaRes.body.factura.xml_path.endsWith('.xml')).toBe(true);

    const segundoIntento = await request(app).post(`/ventas/${ventaId}/facturar`).expect(200);
    expect(Number(segundoIntento.body.factura.intentos)).toBeGreaterThan(1);
    expect(segundoIntento.body.factura.pdf_path).toBe(facturaRes.body.factura.pdf_path);
    expect(segundoIntento.body.factura.xml_path).toBe(facturaRes.body.factura.xml_path);
  });
});
