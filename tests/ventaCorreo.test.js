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
      id: venta?.factura_electronica?.id,
      nro_factura: venta?.factura_electronica?.nro_factura,
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
    enviarFacturaDigitalPorCorreo: jest.fn(),
    EmailNotConfiguredError,
    DestinatarioInvalidoError,
    isEmailEnabled: jest.fn(() => true)
  };
});

const request = require('supertest');
const { app, prisma } = require('../src/app');
const {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  DestinatarioInvalidoError,
  isEmailEnabled
} = require('../src/services/email/facturaDigitalMailer');

let adminUser;
let sucursal;
let producto;
let cliente;

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

describe('Ventas facturacion sin factura digital interna', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    jest.clearAllMocks();
    isEmailEnabled.mockReturnValue(true);

    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursal = await prisma.sucursal.create({
      data: {
        nombre: `Sucursal venta correo ${unique}`,
        establecimiento: '001',
        punto_expedicion: '001'
      }
    });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin venta correo',
        usuario: `admin_venta_correo_${unique}`,
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

    producto = await prisma.producto.create({
      data: {
        sku: `VENTA-CORREO-${unique}`,
        nombre: 'Producto correo',
        tipo: 'REPUESTO',
        precio_venta: '1000.00',
        stock_actual: 10,
        sucursalId: sucursal.id
      }
    });

    cliente = await prisma.cliente.create({
      data: {
        nombre_razon_social: 'Cliente correo real',
        ruc: `${Math.floor(10000000 + Math.random() * 89999999)}-0`,
        direccion: 'Calle correo 123',
        correo: 'cliente-correo@test.com'
      }
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('devuelve 200 sin generar factura digital interna aunque el correo no esté configurado', async () => {
    enviarFacturaDigitalPorCorreo.mockRejectedValueOnce(new EmailNotConfiguredError());

    const createRes = await auth(request(app).post('/ventas'))
      .send({
        usuarioId: adminUser.id,
        clienteId: cliente.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const facturaRes = await auth(request(app).post(`/ventas/${createRes.body.id}/facturar`)).expect(200);

    expect(enviarFacturaDigitalPorCorreo).not.toHaveBeenCalled();
    expect(facturaRes.body.factura?.id).toBeTruthy();
    expect(facturaRes.body.venta?.factura_digital ?? null).toBeNull();
  });

  test('devuelve 200 sin intentar correo legacy aunque falte destinatario válido', async () => {
    enviarFacturaDigitalPorCorreo.mockRejectedValueOnce(new DestinatarioInvalidoError());

    const createRes = await auth(request(app).post('/ventas'))
      .send({
        usuarioId: adminUser.id,
        clienteId: cliente.id,
        iva_porcentaje: 10,
        detalles: [{ productoId: producto.id, cantidad: 1 }]
      })
      .expect(201);

    const facturaRes = await auth(request(app).post(`/ventas/${createRes.body.id}/facturar`)).expect(200);

    expect(enviarFacturaDigitalPorCorreo).not.toHaveBeenCalled();
    expect(facturaRes.body.factura?.id).toBeTruthy();
    expect(facturaRes.body.venta?.factura_digital ?? null).toBeNull();
  });
});