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
    enviarFacturaDigitalPorCorreo: jest.fn(),
    EmailNotConfiguredError,
    DestinatarioInvalidoError
  };
});

const fs = require('fs/promises');
const path = require('path');
const request = require('supertest');
const { app, prisma } = require('../src/app');
const {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  DestinatarioInvalidoError
} = require('../src/services/email/facturaDigitalMailer');

let adminUser;
let sucursal;

function auth(req, user = adminUser, branch = sucursal) {
  if (!user || !branch) {
    throw new Error('Falta contexto para autenticar el test.');
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

async function createVentaConFacturaDigital({ pdfPath, clienteCorreo = 'cliente@test.com' } = {}) {
  const cliente = await prisma.cliente.create({
    data: {
      nombre_razon_social: `Cliente factura ${Date.now()}`,
      ruc: `${Math.floor(10000000 + Math.random() * 89999999)}-0`,
      direccion: 'Calle factura 123',
      correo: clienteCorreo
    }
  });

  const venta = await prisma.venta.create({
    data: {
      clienteId: cliente.id,
      usuarioId: adminUser.id,
      sucursalId: sucursal.id,
      subtotal: 150000,
      total: 150000,
      impuesto_total: 13636.36,
      moneda: 'PYG',
      iva_porcentaje: 10,
      estado: 'FACTURADO'
    }
  });

  return prisma.facturaDigital.create({
    data: {
      ventaId: venta.id,
      sucursalId: sucursal.id,
      nro_factura: `001-001-${String(Math.floor(Math.random() * 9999999)).padStart(7, '0')}`,
      timbrado: `TIM-${Date.now()}`,
      establecimiento: '001',
      punto_expedicion: '001',
      secuencia: Math.floor(Math.random() * 1000000),
      condicion_venta: 'CONTADO',
      moneda: 'PYG',
      total: 150000,
      total_iva: 13636.36,
      estado_envio: 'PENDIENTE',
      pdf_path: pdfPath || null
    }
  });
}

describe('Factura digital API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    jest.clearAllMocks();
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursal = await prisma.sucursal.create({ data: { nombre: `Sucursal factura digital ${unique}` } });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin factura digital',
        usuario: `admin_factura_digital_${unique}`,
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });
    await prisma.usuarioSucursal.create({ data: { usuarioId: adminUser.id, sucursalId: sucursal.id, rol: 'ADMIN' } });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('redirige cuando el PDF es una URL externa', async () => {
    const factura = await createVentaConFacturaDigital({ pdfPath: 'https://cdn.test/facturas/001.pdf' });

    const res = await auth(request(app).get(`/facturas-digitales/${factura.id}/pdf`)).expect(302);
    expect(res.headers.location).toBe('https://cdn.test/facturas/001.pdf');
  });

  test('sirve el PDF local cuando el archivo existe', async () => {
    const relativePath = `/storage/facturas_digitales/test_${Date.now()}.pdf`;
    const absolutePath = path.join(process.cwd(), relativePath.replace(/^\/+/, ''));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'PDF de prueba');

    const factura = await createVentaConFacturaDigital({ pdfPath: relativePath });

    const res = await auth(request(app).get(`/facturas-digitales/${factura.id}/pdf`)).expect(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.toString()).toBe('PDF de prueba');

    await fs.unlink(absolutePath).catch(() => {});
  });

  test('devuelve 404 si el archivo PDF local ya no existe', async () => {
    const factura = await createVentaConFacturaDigital({ pdfPath: '/storage/facturas_digitales/inexistente.pdf' });

    const res = await auth(request(app).get(`/facturas-digitales/${factura.id}/pdf`)).expect(404);
    expect(res.body.error).toMatch(/ya no está disponible/i);
  });

  test('no monta la ruta legacy en produccion cuando no se habilita explicitamente', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLegacy = process.env.FACTURA_DIGITAL_LEGACY_ENABLED;

    process.env.NODE_ENV = 'production';
    delete process.env.FACTURA_DIGITAL_LEGACY_ENABLED;
    jest.resetModules();

    try {
      const { app: prodApp } = require('../src/app');
      await request(prodApp).get('/facturas-digitales/legacy-id/pdf').expect(404);
    } finally {
      jest.resetModules();
      process.env.NODE_ENV = previousNodeEnv;
      if (previousLegacy === undefined) {
        delete process.env.FACTURA_DIGITAL_LEGACY_ENABLED;
      } else {
        process.env.FACTURA_DIGITAL_LEGACY_ENABLED = previousLegacy;
      }
    }
  });

  test('reenvia la factura por correo y devuelve la factura serializada', async () => {
    const factura = await createVentaConFacturaDigital({ pdfPath: 'https://cdn.test/facturas/001.pdf' });

    enviarFacturaDigitalPorCorreo.mockResolvedValue({
      ...factura,
      estado_envio: 'ENVIADO',
      enviado_a: 'destino@test.com',
      intentos: 1
    });

    const res = await auth(request(app).post(`/facturas-digitales/${factura.id}/enviar`))
      .send({ destinatario: 'destino@test.com' })
      .expect(200);

    expect(res.body.message).toMatch(/enviada correctamente/i);
    expect(res.body.factura.estado_envio).toBe('ENVIADO');
    expect(enviarFacturaDigitalPorCorreo).toHaveBeenCalledWith(
      expect.objectContaining({ id: factura.id }),
      expect.objectContaining({ id: factura.ventaId }),
      { destinatario: 'destino@test.com' }
    );
  });

  test('propaga error 412 cuando no hay configuracion de correo', async () => {
    const factura = await createVentaConFacturaDigital({ pdfPath: 'https://cdn.test/facturas/002.pdf' });
    enviarFacturaDigitalPorCorreo.mockRejectedValue(new EmailNotConfiguredError());

    const res = await auth(request(app).post(`/facturas-digitales/${factura.id}/enviar`)).send({}).expect(412);

    expect(res.body.code).toBe('EMAIL_NO_CONFIGURADO');
  });

  test('propaga error 400 cuando el destinatario es invalido', async () => {
    const factura = await createVentaConFacturaDigital({ pdfPath: 'https://cdn.test/facturas/003.pdf' });
    enviarFacturaDigitalPorCorreo.mockRejectedValue(new DestinatarioInvalidoError());

    const res = await auth(request(app).post(`/facturas-digitales/${factura.id}/enviar`)).send({}).expect(400);

    expect(res.body.code).toBe('DESTINATARIO_NO_DISPONIBLE');
  });
});