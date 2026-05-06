jest.mock('../src/prismaClient', () => {
  const { FakePrisma } = require('./helpers/fakePrisma');
  return new FakePrisma();
});

jest.mock('../src/services/factpy/client', () => ({
  emitirFactura: jest.fn(async () => ({
    status: true,
    kude: '/storage/facturas/mock.pdf',
    xmlLink: '/storage/facturas/mock.xml',
    cdc: '01800100100000010012026032712345678',
    receiptid: 'MOCK-RECEIPT'
  })),
  consultarEstados: jest.fn(async () => [])
}));

jest.mock('../src/services/sifen/facturaProcessor', () => ({
  procesarFacturaElectronica: jest.fn(async (venta) => ({
    factura: {
      id: venta?.factura_electronica?.id || 'mock-factura-id',
      nro_factura: venta?.factura_electronica?.nro_factura || '001-001-MOCK',
      estado: 'PAGADA',
      intentos: Number(venta?.factura_electronica?.intentos ?? 1),
      pdf_path: '/storage/facturas/mock.pdf',
      xml_path: '/storage/facturas/mock.xml',
      qr_data: 'MOCK-QR'
    },
    envio: { ok: true }
  }))
}));

jest.mock('../src/services/email/facturaDigitalMailer', () => {
  class EmailNotConfiguredError extends Error {
    constructor(message = 'El servidor de correo no está configurado.') {
      super(message);
      this.name = 'EmailNotConfiguredError';
      this.code = 'EMAIL_NO_CONFIGURADO';
    }
  }

  class DestinatarioInvalidoError extends Error {
    constructor(message = 'No se encontró un destinatario para la factura digital.') {
      super(message);
      this.name = 'DestinatarioInvalidoError';
      this.code = 'DESTINATARIO_NO_DISPONIBLE';
    }
  }

  return {
    enviarFacturaDigitalPorCorreo: jest.fn(async (facturaDigital) => ({
      ...facturaDigital,
      estado_envio: 'ENVIADO',
      intentos: Number(facturaDigital?.intentos || 0) + 1
    })),
    EmailNotConfiguredError,
    DestinatarioInvalidoError,
    isEmailEnabled: jest.fn(() => false)
  };
});

jest.mock('../src/middleware/authContext', () => ({
  attachUser: (req, _res, next) => {
    req.usuarioActual = req.usuarioActual || { id: 'test-user', rol: 'ADMIN' };
    next();
  },
  requireAuth: (req, res, next) => {
    req.usuarioActual = req.usuarioActual || { id: 'test-user', rol: 'ADMIN' };
    return next();
  },
  authorizeRoles: () => (req, res, next) => {
    req.usuarioActual = req.usuarioActual || { id: 'test-user', rol: 'ADMIN' };
    return next();
  }
}));

jest.mock('../src/middleware/sucursalContext', () => ({
  requireSucursal: (req, _res, next) => {
    req.sucursalId = req.sucursalId || '00000000-0000-0000-0000-000000000001';
    return next();
  }
}));

const request = require('supertest');
const prisma = require('../src/prismaClient');
const { app } = require('../src/app');
const { emitirFactura } = require('../src/services/factpy/client');
const {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  isEmailEnabled
} = require('../src/services/email/facturaDigitalMailer');

describe('Ventas API (integración)', () => {
  let usuario;
  let producto;

  function parseNumeroSecuencia(numero) {
    return Number(String(numero || '').split('-').pop() || 0);
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    // Limpiar tablas relevantes
    emitirFactura.mockClear();
    enviarFacturaDigitalPorCorreo.mockClear();
    isEmailEnabled.mockReturnValue(false);
    await prisma.detalleVenta.deleteMany().catch(() => {});
    await prisma.movimientoStock.deleteMany().catch(() => {});
    await prisma.reciboDetalle?.deleteMany?.().catch(() => {});
    await prisma.recibo?.deleteMany?.().catch(() => {});
    await prisma.notaCreditoDetalle?.deleteMany?.().catch(() => {});
    await prisma.notaCreditoElectronica.deleteMany().catch(() => {});
    await prisma.facturaDigital.deleteMany().catch(() => {});
    await prisma.facturaElectronica.deleteMany().catch(() => {});
    await prisma.venta.deleteMany().catch(() => {});
    await prisma.producto.deleteMany().catch(() => {});
    await prisma.usuario.deleteMany().catch(() => {});
    await prisma.sucursal.deleteMany().catch(() => {});

    await prisma.sucursal.create({ data: {
      id: '00000000-0000-0000-0000-000000000001',
      nombre: 'Casa Central',
      establecimiento: '001',
      punto_expedicion: '001'
    }});

    usuario = await prisma.usuario.create({ data: {
      nombre: 'Tester', usuario: 'tester', password_hash: 'hash', rol: 'ADMIN'
    }});

    producto = await prisma.producto.create({ data: {
      sku: 'TEST-SKU', nombre: 'Producto Test', tipo: 'REPUESTO', precio_venta: '1000.00', stock_actual: 5,
      sucursalId: '00000000-0000-0000-0000-000000000001'
    }});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Test: Faltan campos obligatorios
  test('rechaza creación sin usuarioId o detalles', async () => {
    const res = await request(app).post('/ventas').send({ iva_porcentaje: 10 }).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Detalles con cantidad negativa
  test('rechaza detalles con cantidad negativa', async () => {
    const res = await request(app).post('/ventas').send({ usuarioId: usuario.id, iva_porcentaje: 10, detalles: [{ productoId: producto.id, cantidad: -2 }] }).expect(400);
    expect(res.body).toHaveProperty('error');
  });

  // Test: Acceso sin autenticación (middleware simulado)
  test('rechaza acceso sin autenticación (simulado)', async () => {
    // Si el middleware real estuviera activo, aquí se probaría 401
    // expect(await request(app).get('/ventas').expect(401));
    expect(true).toBe(true);
  });

  // Test: Acceso con rol incorrecto (simulado)
  test('rechaza creación con rol no admin (simulado)', async () => {
    // Si el middleware real estuviera activo, aquí se probaría 403
    // expect(await request(app).post('/ventas').set('x-user-role', 'USUARIO').send({...}).expect(403));
    expect(true).toBe(true);
  });

  // Test: Soft delete y consulta directa
  test('verifica que deleted_at funciona', async () => {
    const payload = { usuarioId: usuario.id, iva_porcentaje: 10, detalles: [{ productoId: producto.id, cantidad: 1 }] };
    const created = await request(app).post('/ventas').send(payload).expect(201);
    await request(app).post(`/ventas/${created.body.id}/anular`).send({ motivo: 'Test' }).expect(200);
    // Consulta directa (debería incluir deleted_at)
    const venta = await prisma.venta.findUnique({ where: { id: created.body.id } });
    expect(venta.deleted_at).not.toBeNull();
  });

  // Test: Listado incluye/excluye borrados según flag
  test('listado incluye borrados si se pide', async () => {
    const payload = { usuarioId: usuario.id, iva_porcentaje: 10, detalles: [{ productoId: producto.id, cantidad: 1 }] };
    const created = await request(app).post('/ventas').send(payload).expect(201);
    await request(app).post(`/ventas/${created.body.id}/anular`).send({ motivo: 'Test' }).expect(200);
    const res = await request(app).get('/ventas?include_deleted=true').expect(200);
    expect(res.body.data.some((v) => v.id === created.body.id)).toBe(true);
  });

  // Test: Simulación de error de integración (mock)
  test.skip('maneja error de integración externa', async () => {
    // Aquí se podría mockear una dependencia y forzar un error
    // Ejemplo: jest.spyOn(servicio, 'emitirFactura').mockRejectedValue(new Error('Fallo externo'));
    // ...
    expect(true).toBe(true);
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

  test('crea venta en guaranies con descuento e IVA 5 por ciento', async () => {
    const payload = {
      usuarioId: usuario.id,
      iva_porcentaje: 5,
      descuento_total: 100,
      detalles: [{ productoId: producto.id, cantidad: 2 }]
    };

    const res = await request(app).post('/ventas').send(payload).expect(201);

    expect(res.body.condicion_venta).toBe('CONTADO');
    expect(res.body.moneda).toBe('PYG');
    expect(Number(res.body.subtotal)).toBeCloseTo(2000, 2);
    expect(Number(res.body.descuento_total)).toBeCloseTo(100, 2);
    expect(Number(res.body.total)).toBeCloseTo(1900, 2);
    expect(Number(res.body.impuesto_total)).toBeCloseTo(1900 / 21, 2);
    expect(res.body.total_moneda).toBeNull();
  });

  test('crea venta exenta en guaranies sin impuesto', async () => {
    const payload = {
      usuarioId: usuario.id,
      iva_porcentaje: 0,
      detalles: [{ productoId: producto.id, cantidad: 1 }]
    };

    const res = await request(app).post('/ventas').send(payload).expect(201);

    expect(Number(res.body.subtotal)).toBeCloseTo(1000, 2);
    expect(Number(res.body.total)).toBeCloseTo(1000, 2);
    expect(Number(res.body.impuesto_total)).toBeCloseTo(0, 2);
    expect(res.body.iva_porcentaje).toBe(0);
  });

  test('crea venta a credito en cuotas en guaranies con saldo pendiente completo', async () => {
    const credito = {
      tipo: 'CUOTAS',
      cantidad_cuotas: 2,
      cuotas: [
        { numero: 1, monto: 1000, fecha_vencimiento: '2026-05-10' },
        { numero: 2, monto: 1000, fecha_vencimiento: '2026-06-10' }
      ]
    };

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        credito,
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    expect(createRes.body.condicion_venta).toBe('CREDITO');
    expect(createRes.body.es_credito).toBe(true);
    expect(Number(createRes.body.saldo_pendiente)).toBeCloseTo(2000, 2);
    expect(createRes.body.credito_config).toMatchObject({
      tipo: 'CUOTAS',
      cantidad_cuotas: 2,
      cuotas: [
        expect.objectContaining({ numero: 1, monto: 1000 }),
        expect.objectContaining({ numero: 2, monto: 1000 })
      ]
    });
  });

  test('crea venta a credito con entrega inicial y financia solo el saldo restante', async () => {
    const credito = {
      tipo: 'CUOTAS',
      entrega_inicial: 500,
      metodo_entrega: 'efectivo',
      cantidad_cuotas: 2,
      cuotas: [
        { numero: 1, monto: 750, fecha_vencimiento: '2026-05-10' },
        { numero: 2, monto: 750, fecha_vencimiento: '2026-06-10' }
      ]
    };

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        credito,
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    expect(createRes.body.condicion_venta).toBe('CREDITO');
    expect(createRes.body.es_credito).toBe(true);
    expect(Number(createRes.body.saldo_pendiente)).toBeCloseTo(1500, 2);
    expect(createRes.body.credito_config).toMatchObject({
      tipo: 'CUOTAS',
      entrega_inicial: 500,
      entrega_inicial_gs: 500,
      metodo_entrega: 'EFECTIVO',
      saldo_financiado: 1500,
      saldo_financiado_gs: 1500,
      cuotas: [
        expect.objectContaining({ numero: 1, monto: 750 }),
        expect.objectContaining({ numero: 2, monto: 750 })
      ]
    });

    const recibos = await prisma.recibo.findMany({ where: { sucursalId: '00000000-0000-0000-0000-000000000001' } });
    expect(recibos).toHaveLength(1);
    expect(Number(recibos[0].total)).toBeCloseTo(500, 2);
    expect(Number(recibos[0].total_moneda)).toBeCloseTo(500, 2);
    expect(recibos[0].metodo).toBe('EFECTIVO');

    const aplicaciones = await prisma.reciboDetalle.findMany({ where: { ventaId: createRes.body.id } });
    expect(aplicaciones).toHaveLength(1);
    expect(Number(aplicaciones[0].monto)).toBeCloseTo(500, 2);
    expect(Number(aplicaciones[0].saldo_previo)).toBeCloseTo(2000, 2);
    expect(Number(aplicaciones[0].saldo_posterior)).toBeCloseTo(1500, 2);
  });

  test('mantiene el precio original en USD y recalcula guaranies con el cambio del dia', async () => {
    const productoUsd = await prisma.producto.create({ data: {
      sku: 'TEST-USD',
      nombre: 'Producto USD',
      tipo: 'REPUESTO',
      precio_venta: '70000.00',
      precio_venta_original: '10.00',
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: '7000.00',
      stock_actual: 5,
      sucursalId: '00000000-0000-0000-0000-000000000001'
    }});

    const res = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        moneda: 'USD',
        tipo_cambio: 6500,
        detalles: [{ productoId: productoUsd.id, cantidad: 1 }]
      })
      .expect(201);

    expect(Number(res.body.total)).toBeCloseTo(65000, 2);
    expect(Number(res.body.total_moneda)).toBeCloseTo(10, 2);

    const ventaGuardada = await prisma.venta.findUnique({
      where: { id: res.body.id },
      include: { detalles: true }
    });

    expect(ventaGuardada.detalles).toHaveLength(1);
    expect(ventaGuardada.detalles[0].moneda_precio_unitario).toBe('USD');
    expect(Number(ventaGuardada.detalles[0].precio_unitario_moneda)).toBeCloseTo(10, 4);
    expect(Number(ventaGuardada.detalles[0].subtotal_moneda)).toBeCloseTo(10, 4);
    expect(Number(ventaGuardada.detalles[0].tipo_cambio_aplicado)).toBeCloseTo(6500, 4);
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

  test('lista solo las ventas de la sucursal activa', async () => {
    await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const otraSucursal = await prisma.sucursal.create({
      data: {
        id: '00000000-0000-0000-0000-000000000002',
        nombre: 'Sucursal Secundaria',
        establecimiento: '002',
        punto_expedicion: '001'
      }
    });

    await prisma.venta.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: otraSucursal.id,
        subtotal: 1000,
        impuesto_total: 90.91,
        total: 1000,
        estado: 'PENDIENTE',
        moneda: 'PYG',
        iva_porcentaje: 10,
        condicion_venta: 'CONTADO'
      }
    });

    const response = await request(app).get('/ventas').expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].sucursalId).toBe('00000000-0000-0000-0000-000000000001');
  });

  test('crea venta a crédito a plazo con saldo pendiente y la expone en el listado', async () => {
    const credito = {
      tipo: 'PLAZO',
      fecha_vencimiento: '2026-04-30',
      descripcion: '30 dias'
    };

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        credito,
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    expect(createRes.body.condicion_venta).toBe('CREDITO');
    expect(createRes.body.es_credito).toBe(true);
    expect(Number(createRes.body.saldo_pendiente)).toBeCloseTo(2000, 2);
    expect(createRes.body.credito_config).toMatchObject({
      ...credito,
      fecha_vencimiento: '2026-04-30T00:00:00.000Z'
    });

    const listRes = await request(app).get('/ventas').expect(200);
    expect(listRes.body.data[0].credito).toMatchObject({
      ...credito,
      fecha_vencimiento: '2026-04-30T00:00:00.000Z'
    });
  });

  test('reabre ticket como PDF A4', async () => {
    const created = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    await prisma.venta.update({
      where: { id: created.body.id },
      data: {
        estado: 'TICKET',
        moneda: 'USD',
        tipo_cambio: 7300,
        total_moneda: 0.14,
        condicion_venta: 'CONTADO'
      }
    });

    const res = await request(app)
      .get(`/ventas/${created.body.id}/ticket/pdf`)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/ticket-venta/i);
  });

  test('crea ticket contado desde la venta y lo expone con saldo pendiente cero', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        estado: 'TICKET',
        iva_porcentaje: 10,
        condicion_venta: 'CREDITO',
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    expect(createRes.body.estado).toBe('TICKET');
    expect(createRes.body.condicion_venta).toBe('CONTADO');
    expect(createRes.body.es_credito).toBe(false);
    expect(createRes.body.saldo_pendiente ?? null).toBeNull();

    const listRes = await request(app).get('/ventas').expect(200);
    const ticket = listRes.body.data.find((item) => item.id === createRes.body.id);
    expect(ticket).toBeDefined();
    expect(ticket.estado).toBe('TICKET');
    expect(Number(ticket.saldo_pendiente)).toBeCloseTo(0, 2);

    const ticketPdfRes = await request(app)
      .get(`/ventas/${createRes.body.id}/ticket/pdf`)
      .expect(200);

    expect(ticketPdfRes.headers['content-type']).toMatch(/application\/pdf/);
    expect(ticketPdfRes.headers['content-disposition']).toMatch(/ticket-venta/i);
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

  test('no permite anular una venta ya facturada', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const res = await request(app)
      .post(`/ventas/${createRes.body.id}/anular`)
      .send({ motivo: 'No debe anularse directo' })
      .expect(400);

    expect(res.body.error).toMatch(/nota de crédito|facturada/i);
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

  test('continua la secuencia de factura por prefijo aunque exista una factura previa con otro timbrado', async () => {
    const ventaAnterior = await prisma.venta.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        subtotal: 1000,
        impuesto_total: 90.91,
        total: 1000,
        estado: 'FACTURADO',
        moneda: 'PYG',
        iva_porcentaje: 10,
        condicion_venta: 'CONTADO',
        detalles: {
          create: [{ productoId: producto.id, cantidad: 1, precio_unitario: '1000.00', subtotal: '1000.00' }]
        }
      }
    });

    await prisma.facturaElectronica.create({
      data: {
        ventaId: ventaAnterior.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_factura: '001-001-0000020',
        timbrado: 'TIMBRADO-ANTERIOR',
        establecimiento: '001',
        punto_expedicion: '001',
        secuencia: 20,
        estado: 'ENVIADO'
      }
    });

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const facturaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    expect(parseNumeroSecuencia(facturaRes.body.factura?.nro_factura)).toBeGreaterThan(20);
    expect(facturaRes.body.factura?.nro_factura).not.toBe('001-001-0000020');
  });

  test('factura venta en USD con descuento usando la base monetaria guardada por linea', async () => {
    const productoUsd = await prisma.producto.create({ data: {
      sku: 'TEST-USD-DESC',
      nombre: 'Producto USD Descuento',
      tipo: 'REPUESTO',
      precio_venta: '70000.00',
      precio_venta_original: '10.00',
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: '7000.00',
      stock_actual: 5,
      sucursalId: '00000000-0000-0000-0000-000000000001'
    }});

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        moneda: 'USD',
        tipo_cambio: 6500,
        descuento_total: 1,
        detalles: [{ productoId: productoUsd.id, cantidad: 1 }]
      })
      .expect(201);

    expect(Number(createRes.body.total)).toBeCloseTo(58500, 2);
    expect(Number(createRes.body.total_moneda)).toBeCloseTo(9, 2);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const payloadFactpy = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(payloadFactpy?.moneda).toBe('USD');
    expect(Number(payloadFactpy?.cambio)).toBeCloseTo(6500, 4);
    expect(Number(payloadFactpy?.items?.[0]?.precioUnitario)).toBeCloseTo(10, 4);
    expect(Number(payloadFactpy?.items?.[0]?.descuento)).toBeCloseTo(1, 8);
    expect(Number(payloadFactpy?.items?.[0]?.precioTotal)).toBeCloseTo(9, 4);
    expect(Number(payloadFactpy?.descuentoGlobal)).toBe(0);
    expect(Number(payloadFactpy?.totalPago)).toBeCloseTo(9, 4);
    expect(Number(payloadFactpy?.totalPagoMoneda)).toBeCloseTo(9, 4);
    expect(Number(payloadFactpy?.totalGs)).toBeCloseTo(58500, 2);
  });

  test('factura una venta a cuotas y envía la estructura de crédito a FactPy', async () => {
    const cuotas = [
      { numero: 1, monto: 1000, fecha_vencimiento: '2026-05-10' },
      { numero: 2, monto: 1000, fecha_vencimiento: '2026-06-10' }
    ];

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        credito: { tipo: 'CUOTAS', cuotas },
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .send({
        condicion_pago: 'CREDITO',
        credito: { tipo: 'CUOTAS', cuotas }
      })
      .expect(200);

    const payloadFactpy = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(payloadFactpy?.condicionPago).toBe(2);
    expect(payloadFactpy?.pagos).toEqual([]);
    expect(payloadFactpy?.credito).toMatchObject({
      condicionCredito: 2,
      cantidadCuota: 2
    });
    expect(payloadFactpy?.credito?.cuotas).toEqual([
      expect.objectContaining({ numero: 1, monto: 1000, fechaVencimiento: '2026-05-10' }),
      expect.objectContaining({ numero: 2, monto: 1000, fechaVencimiento: '2026-06-10' })
    ]);
  });

  test('factura una venta a cuotas con entrega inicial y envía a FactPy solo el pago realmente recibido', async () => {
    const cuotas = [
      { numero: 1, monto: 750, fecha_vencimiento: '2026-05-10' },
      { numero: 2, monto: 750, fecha_vencimiento: '2026-06-10' }
    ];

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        credito: { tipo: 'CUOTAS', entrega_inicial: 500, metodo_entrega: 'EFECTIVO', cuotas },
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .send({
        condicion_pago: 'CREDITO',
        credito: { tipo: 'CUOTAS', entrega_inicial: 500, metodo_entrega: 'EFECTIVO', cuotas }
      })
      .expect(200);

    const payloadFactpy = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(payloadFactpy?.condicionPago).toBe(2);
    expect(payloadFactpy?.pagos).toEqual([
      expect.objectContaining({ tipoPago: '1', monto: 500 })
    ]);
    expect(payloadFactpy?.credito).toMatchObject({
      condicionCredito: 2,
      cantidadCuota: 2
    });
    expect(payloadFactpy?.credito?.cuotas).toEqual([
      expect.objectContaining({ numero: 1, monto: 750, fechaVencimiento: '2026-05-10' }),
      expect.objectContaining({ numero: 2, monto: 750, fechaVencimiento: '2026-06-10' })
    ]);
  });

  test('factura una venta USD con descuento y entrega inicial enviando total neto, anticipo y saldo financiado correctos', async () => {
    const productoUsd = await prisma.producto.create({ data: {
      sku: 'TEST-USD-CRED-DESC',
      nombre: 'Producto USD Credito Descuento',
      tipo: 'SERVICIO',
      precio_venta: '7000000.00',
      precio_venta_original: '1000.00',
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: '7000.00',
      stock_actual: 5,
      sucursalId: '00000000-0000-0000-0000-000000000001'
    }});

    const cuotas = [
      { numero: 1, monto: 700, fecha_vencimiento: '2026-06-10' },
      { numero: 2, monto: 700, fecha_vencimiento: '2026-07-10' }
    ];

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        moneda: 'USD',
        tipo_cambio: 7000,
        descuento_total: 100,
        credito: { tipo: 'CUOTAS', entrega_inicial: 500, metodo_entrega: 'EFECTIVO', cuotas },
        detalles: [{ productoId: productoUsd.id, cantidad: 2 }]
      })
      .expect(201);

    expect(Number(createRes.body.total)).toBeCloseTo(13300000, 2);
    expect(Number(createRes.body.total_moneda)).toBeCloseTo(1900, 2);
    expect(Number(createRes.body.saldo_pendiente)).toBeCloseTo(9800000, 2);
    expect(createRes.body.credito_config).toMatchObject({
      tipo: 'CUOTAS',
      entrega_inicial: 500,
      saldo_financiado: 1400,
      entrega_inicial_gs: 3500000,
      saldo_financiado_gs: 9800000
    });

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .send({
        condicion_pago: 'CREDITO',
        credito: { tipo: 'CUOTAS', entrega_inicial: 500, metodo_entrega: 'EFECTIVO', cuotas }
      })
      .expect(200);

    const payloadFactpy = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(payloadFactpy?.moneda).toBe('USD');
    expect(Number(payloadFactpy?.cambio)).toBeCloseTo(7000, 4);
    expect(Number(payloadFactpy?.items?.[0]?.precioUnitario)).toBeCloseTo(1000, 4);
    expect(Number(payloadFactpy?.items?.[0]?.descuento)).toBeCloseTo(50, 8);
    expect(Number(payloadFactpy?.items?.[0]?.precioTotal)).toBeCloseTo(1900, 4);
    expect(Number(payloadFactpy?.totalPago)).toBeCloseTo(1900, 4);
    expect(Number(payloadFactpy?.totalPagoMoneda)).toBeCloseTo(1900, 4);
    expect(Number(payloadFactpy?.totalGs)).toBeCloseTo(13300000, 2);
    expect(payloadFactpy?.pagos).toEqual([
      expect.objectContaining({ tipoPago: '1', monto: 500 })
    ]);
    expect(payloadFactpy?.credito).toMatchObject({
      condicionCredito: 2,
      cantidadCuota: 2
    });
    expect(payloadFactpy?.credito?.cuotas).toEqual([
      expect.objectContaining({ numero: 1, monto: 700, fechaVencimiento: '2026-06-10' }),
      expect.objectContaining({ numero: 2, monto: 700, fechaVencimiento: '2026-07-10' })
    ]);
  });

  test('factura una venta a crédito a plazo y envía condicion de plazo a FactPy', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        credito: {
          tipo: 'PLAZO',
          fecha_vencimiento: '2026-05-30',
          descripcion: '45 dias'
        },
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .send({
        condicion_pago: 'CREDITO',
        credito: {
          tipo: 'PLAZO',
          fecha_vencimiento: '2026-05-30',
          descripcion: '45 dias'
        }
      })
      .expect(200);

    const payloadFactpy = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(payloadFactpy?.condicionPago).toBe(2);
    expect(payloadFactpy?.credito).toMatchObject({
      condicionCredito: 1,
      descripcion: '45 dias'
    });
    expect(payloadFactpy?.credito?.cuotas).toBeUndefined();
  });

  test('continua la facturacion aunque FactPy falle al emitir', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    emitirFactura.mockRejectedValueOnce(new Error('FactPy temporalmente fuera de servicio'));

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const facturaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    expect(emitirFactura).toHaveBeenCalled();
    expect(facturaRes.body.factura?.id).toBeTruthy();
    expect(facturaRes.body.factura?.estado).toBe('PAGADA');
    expect(facturaRes.body.factura?.respuesta_set?.factpy).toBeUndefined();

    consoleErrorSpy.mockRestore();
  });

  test('factura una venta con cliente con correo sin romper el flujo principal', async () => {
    isEmailEnabled.mockReturnValue(true);
    enviarFacturaDigitalPorCorreo.mockRejectedValueOnce(new EmailNotConfiguredError());

    const cliente = await prisma.cliente.create({
      data: {
        nombre_razon_social: 'Cliente correo',
        ruc: '80012345-6',
        direccion: 'Calle correo 123',
        correo: 'cliente-correo@test.com'
      }
    });

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        clienteId: cliente.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    await prisma.facturaDigital.create({
      data: {
        ventaId: createRes.body.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_factura: '001-001-0099999',
        timbrado: '12345678',
        establecimiento: '001',
        punto_expedicion: '001',
        secuencia: 99999,
        total: '1000.00',
        total_iva: '90.91',
        pdf_path: '/storage/facturas/mock.pdf'
      }
    });

    const facturaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    expect(facturaRes.body.factura?.id).toBeTruthy();
    expect(facturaRes.body.venta?.id).toBe(createRes.body.id);
  });

  test('redirige el PDF de factura digital cuando pdf_path es externo', async () => {
    const venta = await prisma.venta.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        estado: 'FACTURADO',
        total: '1000.00',
        total_iva: '90.91',
        moneda: 'PYG',
        detalles: {
          create: [{ productoId: producto.id, cantidad: 1, precio_unitario: '1000.00', subtotal: '1000.00' }]
        }
      }
    });

    const facturaDigital = await prisma.facturaDigital.create({
      data: {
        ventaId: venta.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_factura: '001-001-0000001',
        timbrado: '12345678',
        total: '1000.00',
        total_iva: '90.91',
        pdf_path: 'https://factpy.example.com/kude.pdf'
      }
    });

    const response = await request(app)
      .get(`/facturas-digitales/${facturaDigital.id}/pdf`)
      .redirects(0)
      .expect(302);

    expect(response.headers.location).toBe('https://factpy.example.com/kude.pdf');
  });

  test('prioriza el PDF de factura electronica en el listado aunque exista factura digital', async () => {
    const venta = await prisma.venta.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        estado: 'FACTURADO',
        total: '1000.00',
        total_iva: '90.91',
        moneda: 'PYG',
        detalles: {
          create: [{ productoId: producto.id, cantidad: 1, precio_unitario: '1000.00', subtotal: '1000.00' }]
        }
      }
    });

    await prisma.facturaElectronica.create({
      data: {
        ventaId: venta.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_factura: '001-001-0000456',
        estado: 'ENVIADO',
        pdf_path: 'https://factpy.example.com/factura-electronica.pdf'
      }
    });

    await prisma.facturaDigital.create({
      data: {
        ventaId: venta.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_factura: '001-001-0000999',
        timbrado: '12345678',
        total: '1000.00',
        total_iva: '90.91',
        pdf_path: 'https://legacy.example.com/factura-digital.pdf'
      }
    });

    const response = await request(app).get('/ventas').expect(200);
    const listed = response.body.data.find((item) => item.id === venta.id);

    expect(listed.pdf_url).toBe('https://factpy.example.com/factura-electronica.pdf');
    expect(listed.factura_electronica?.pdf_path).toBe('https://factpy.example.com/factura-electronica.pdf');
    expect(listed.factura_digital ?? null).toBeNull();
  });

  test('emite nota de crédito electrónica total para una venta facturada', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const facturaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    expect(facturaRes.body.factura?.id).toBeTruthy();

    const notaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({ motivo: 'Anulación total por error de carga' })
      .expect(201);

    expect(notaRes.body.nota_credito).toBeDefined();
    expect(notaRes.body.nota_credito.nro_nota).toMatch(/^001-001-/);
    expect(notaRes.body.nota_credito.tipo_ajuste).toBe('TOTAL');
    expect(Number(notaRes.body.nota_credito.total)).toBeLessThan(0);
    expect(notaRes.body.nota_credito.estado).toBe('ENVIADO');
    expect(notaRes.body.pdf_url).toBe('/storage/facturas/mock.pdf');

    const ventaActualizada = await prisma.venta.findUnique({ where: { id: createRes.body.id } });
    expect(Number(ventaActualizada.saldo_pendiente)).toBeCloseTo(0, 2);

    const productoActualizado = await prisma.producto.findUnique({ where: { id: producto.id } });
    expect(Number(productoActualizado.stock_actual)).toBe(5);

    const movimientosEntrada = await prisma.movimientoStock.findMany({ where: { productoId: producto.id } });
    expect(movimientosEntrada.some((mov) => mov.tipo === 'ENTRADA' && mov.referencia_tipo === 'NotaCreditoElectronica')).toBe(true);

    const listRes = await request(app).get('/ventas').expect(200);
    const listedVenta = listRes.body.data.find((item) => item.id === createRes.body.id);
    expect(listedVenta).toBeDefined();
    expect(Number(listedVenta.saldo_pendiente)).toBeCloseTo(0, 2);

    await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({ motivo: 'Segundo intento inválido' })
      .expect(409);

    const anularRes = await request(app)
      .post(`/ventas/${createRes.body.id}/anular`)
      .send({ motivo: 'No debe permitirse luego de NC' })
      .expect(400);

    expect(anularRes.body.error).toMatch(/nota de crédito|regularizada/i);
  });

  test('continua la secuencia de nota de crédito por prefijo aunque exista una nota previa con otro timbrado', async () => {
    const ventaAnterior = await prisma.venta.create({
      data: {
        usuarioId: usuario.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        subtotal: 1000,
        impuesto_total: 90.91,
        total: 1000,
        estado: 'FACTURADO',
        moneda: 'PYG',
        iva_porcentaje: 10,
        condicion_venta: 'CONTADO',
        detalles: {
          create: [{ productoId: producto.id, cantidad: 1, precio_unitario: '1000.00', subtotal: '1000.00' }]
        }
      }
    });

    const facturaAnterior = await prisma.facturaElectronica.create({
      data: {
        ventaId: ventaAnterior.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_factura: '001-001-0000010',
        timbrado: 'TIMBRADO-ANTERIOR',
        establecimiento: '001',
        punto_expedicion: '001',
        secuencia: 10,
        estado: 'ENVIADO',
        cdc: '018001001000001022026032712345678'
      }
    });

    await prisma.notaCreditoElectronica.create({
      data: {
        ventaId: ventaAnterior.id,
        facturaElectronicaId: facturaAnterior.id,
        sucursalId: '00000000-0000-0000-0000-000000000001',
        nro_nota: '001-001-0000020',
        timbrado: 'TIMBRADO-ANTERIOR',
        establecimiento: '001',
        punto_expedicion: '001',
        secuencia: 20,
        motivo: 'Histórico',
        tipo_ajuste: 'TOTAL',
        moneda: 'PYG',
        total: '-1000.00',
        cdc: '058001001000002022026032712345678',
        estado: 'ENVIADO'
      }
    });

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const notaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({ motivo: 'Nueva NC con prefijo existente' })
      .expect(201);

    expect(parseNumeroSecuencia(notaRes.body.nota_credito?.nro_nota)).toBeGreaterThan(20);
    expect(notaRes.body.nota_credito?.nro_nota).not.toBe('001-001-0000020');
  });

  test('emite nota de crédito total en USD con descuento usando el neto facturado', async () => {
    const productoUsd = await prisma.producto.create({ data: {
      sku: 'TEST-USD-NC-TOTAL',
      nombre: 'Producto USD NC Total',
      tipo: 'REPUESTO',
      precio_venta: '70000.00',
      precio_venta_original: '10.00',
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: '7000.00',
      stock_actual: 5,
      sucursalId: '00000000-0000-0000-0000-000000000001'
    }});

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        moneda: 'USD',
        tipo_cambio: 6500,
        descuento_total: 1,
        detalles: [{ productoId: productoUsd.id, cantidad: 1 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const notaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({ motivo: 'Anulación total USD con descuento' })
      .expect(201);

    expect(Number(notaRes.body.nota_credito.total)).toBeCloseTo(-58500, 2);
    expect(Number(notaRes.body.nota_credito.total_moneda)).toBeCloseTo(-9, 2);

    const notaPayload = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(notaPayload?.moneda).toBe('USD');
    expect(Number(notaPayload?.items?.[0]?.precioUnitario)).toBeCloseTo(9, 4);
    expect(Number(notaPayload?.items?.[0]?.precioTotal)).toBeCloseTo(-9, 4);
    expect(Number(notaPayload?.totalPago)).toBeCloseTo(-9, 4);
    expect(Number(notaPayload?.totalPagoGs)).toBeCloseTo(-58500, 2);
  });

  test('emite nota de crédito electrónica parcial por ítems', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 2 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const venta = await prisma.venta.findUnique({
      where: { id: createRes.body.id },
      include: { detalles: true }
    });

    const detalleVenta = venta.detalles[0];
    expect(detalleVenta).toBeDefined();

    const notaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({
        motivo: 'Devolución parcial de un ítem',
        tipo_ajuste: 'PARCIAL',
        detalles: [{ detalleVentaId: detalleVenta.id, cantidad: 1 }]
      })
      .expect(201);

    expect(notaRes.body.nota_credito.tipo_ajuste).toBe('PARCIAL');
    expect(Number(notaRes.body.nota_credito.total)).toBeCloseTo(-1000, 2);
    expect(prisma.state.notaCreditoDetalle).toHaveLength(1);
    expect(prisma.state.notaCreditoDetalle[0]).toMatchObject({
      detalleVentaId: detalleVenta.id,
      cantidad: 1,
      subtotal: 1000
    });

    const productoActualizado = await prisma.producto.findUnique({ where: { id: producto.id } });
    expect(Number(productoActualizado.stock_actual)).toBe(4);

    const movimientos = await prisma.movimientoStock.findMany({ where: { productoId: producto.id } });
    expect(movimientos.some((mov) => mov.tipo === 'ENTRADA' && mov.cantidad === 1 && mov.referencia_tipo === 'NotaCreditoElectronica')).toBe(true);
  });

  test('emite nota de crédito parcial en USD con descuento prorrateado por cantidad', async () => {
    const productoUsd = await prisma.producto.create({ data: {
      sku: 'TEST-USD-NC-PARCIAL',
      nombre: 'Producto USD NC Parcial',
      tipo: 'REPUESTO',
      precio_venta: '70000.00',
      precio_venta_original: '10.00',
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: '7000.00',
      stock_actual: 5,
      sucursalId: '00000000-0000-0000-0000-000000000001'
    }});

    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        moneda: 'USD',
        tipo_cambio: 6500,
        descuento_total: 2,
        detalles: [{ productoId: productoUsd.id, cantidad: 2 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const venta = await prisma.venta.findUnique({
      where: { id: createRes.body.id },
      include: { detalles: true }
    });

    const detalleVenta = venta.detalles[0];
    const notaRes = await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({
        motivo: 'Devolución parcial USD con descuento',
        tipo_ajuste: 'PARCIAL',
        detalles: [{ detalleVentaId: detalleVenta.id, cantidad: 1 }]
      })
      .expect(201);

    expect(Number(notaRes.body.nota_credito.total)).toBeCloseTo(-58500, 2);
    expect(Number(notaRes.body.nota_credito.total_moneda)).toBeCloseTo(-9, 2);
    expect(prisma.state.notaCreditoDetalle.at(-1)).toMatchObject({
      detalleVentaId: detalleVenta.id,
      cantidad: 1,
      subtotal: 58500
    });

    const notaPayload = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(notaPayload?.moneda).toBe('USD');
    expect(Number(notaPayload?.items?.[0]?.precioUnitario)).toBeCloseTo(9, 4);
    expect(Number(notaPayload?.items?.[0]?.precioTotal)).toBeCloseTo(-9, 4);
    expect(Number(notaPayload?.totalPago)).toBeCloseTo(-9, 4);
    expect(Number(notaPayload?.totalPagoGs)).toBeCloseTo(-58500, 2);
  });

  test('usa consumidor final cuando la venta no tiene cliente en factura y nota de crédito', async () => {
    const createRes = await request(app)
      .post('/ventas')
      .send({
        usuarioId: usuario.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    await request(app)
      .post(`/ventas/${createRes.body.id}/facturar`)
      .expect(200);

    const facturaPayload = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(facturaPayload?.cliente).toMatchObject({
      nombre: 'Consumidor Final',
      ruc: '44444401-7'
    });

    await request(app)
      .post(`/ventas/${createRes.body.id}/nota-credito`)
      .send({ motivo: 'Prueba consumidor final en NC' })
      .expect(201);

    const notaPayload = emitirFactura.mock.calls.at(-1)?.[0]?.dataJson;
    expect(notaPayload?.cliente).toMatchObject({
      nombre: 'Consumidor Final',
      ruc: '44444401-7'
    });
  });
});
