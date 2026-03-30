const request = require('supertest');
const { app, prisma } = require('../src/app');

let adminUser;
let sucursal;
let proveedor;
let producto;

function auth(req, user = adminUser) {
  return req.set('x-user-id', user.id).set('x-user-role', user.rol).set('x-sucursal-id', sucursal.id);
}

async function cleanDatabase() {
  await prisma.reciboDetalle?.deleteMany?.();
  await prisma.recibo?.deleteMany?.();
  await prisma.notaCreditoDetalle?.deleteMany?.();
  await prisma.notaCreditoElectronica?.deleteMany?.();
  await prisma.facturaDigital?.deleteMany?.();
  await prisma.facturaElectronica?.deleteMany?.();
  await prisma.detalleVenta?.deleteMany?.();
  await prisma.venta?.deleteMany?.();
  await prisma.detalleNotaPedido?.deleteMany?.();
  await prisma.notaPedido?.deleteMany?.();
  await prisma.detalleCompra?.deleteMany?.();
  await prisma.compra?.deleteMany?.();
  await prisma.detallePresupuesto?.deleteMany?.();
  await prisma.presupuesto?.deleteMany?.();
  await prisma.movimientoStock?.deleteMany?.();
  await prisma.pago?.deleteMany?.();
  await prisma.salidaCaja?.deleteMany?.();
  await prisma.cierreCaja?.deleteMany?.();
  await prisma.aperturaCaja?.deleteMany?.();
  await prisma.cliente?.deleteMany?.();
  await prisma.producto?.deleteMany?.();
  await prisma.proveedor?.deleteMany?.();
  await prisma.categoria?.deleteMany?.();
  await prisma.usuarioSucursal?.deleteMany?.();
  await prisma.usuario?.deleteMany?.();
  await prisma.sucursal?.deleteMany?.();
}

describe('Notas de pedido API', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    sucursal = await prisma.sucursal.create({ data: { nombre: `Sucursal Test ${unique}` } });
    adminUser = await prisma.usuario.create({
      data: {
        nombre: 'Admin pruebas',
        usuario: `admin_nota_${unique}`,
        password_hash: 'hash',
        rol: 'ADMIN'
      }
    });
    await prisma.usuarioSucursal.create({ data: { usuarioId: adminUser.id, sucursalId: sucursal.id, rol: 'ADMIN' } });
    proveedor = await prisma.proveedor.create({
      data: {
        nombre_razon_social: 'Proveedor Repuestos',
        ruc: `8003${Math.floor(Math.random() * 10000)}-0`
      }
    });
    producto = await prisma.producto.create({
      data: {
        sku: `REP-${unique}`,
        nombre: 'Cable coaxial RTK',
        tipo: 'REPUESTO',
        precio_venta: 100000,
        codigo_dji: 'YC.XC.TT000104',
        sucursalId: sucursal.id
      }
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('crea, lista y genera PDF de una nota de pedido', async () => {
    const payload = {
      proveedorId: proveedor.id,
      tipo: 'REPUESTOS',
      estado: 'BORRADOR',
      equipo_destino: 'Dron T40',
      observaciones: 'Pedido interno de prueba',
      detalles: [
        {
          productoId: producto.id,
          cantidad: 2,
          equipo_destino: 'Dron T40',
          observacion: 'Cambio preventivo'
        }
      ]
    };

    const created = await auth(request(app).post('/notas-pedido')).send(payload).expect(201);
    expect(created.body.numero).toMatch(/^NP-/);
    expect(created.body.detalles[0].codigo_articulo).toBe('YC.XC.TT000104');

    const list = await auth(request(app).get('/notas-pedido?search=T40')).expect(200);
    expect(list.body.data.some((item) => item.id === created.body.id)).toBe(true);

    const pdf = await auth(request(app).get(`/notas-pedido/${created.body.id}/pdf`)).expect(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('permite ítems libres sin producto usando código y descripción manual', async () => {
    const payload = {
      proveedorId: proveedor.id,
      tipo: 'GENERAL',
      detalles: [
        {
          codigo_articulo: 'MAN-001',
          descripcion: 'Ítem manual de prueba',
          cantidad: 1
        }
      ]
    };

    const created = await auth(request(app).post('/notas-pedido')).send(payload).expect(201);
    expect(created.body.detalles[0].productoId).toBeNull();
    expect(created.body.detalles[0].codigo_articulo).toBe('MAN-001');
  });

  test('actualiza el estado de una nota de pedido', async () => {
    const created = await auth(request(app).post('/notas-pedido')).send({
      proveedorId: proveedor.id,
      tipo: 'GENERAL',
      detalles: [
        {
          codigo_articulo: 'MAN-002',
          descripcion: 'Equipo de prueba',
          cantidad: 1
        }
      ]
    }).expect(201);

    const updated = await auth(request(app).put(`/notas-pedido/${created.body.id}/estado`)).send({ estado: 'EMITIDA' }).expect(200);
    expect(updated.body.estado).toBe('EMITIDA');
  });

  test('convierte una nota recibida en compra y la marca como comprada', async () => {
    const created = await auth(request(app).post('/notas-pedido')).send({
      proveedorId: proveedor.id,
      tipo: 'REPUESTOS',
      estado: 'RECIBIDA',
      equipo_destino: 'Dron T40',
      detalles: [
        {
          productoId: producto.id,
          cantidad: 3,
          equipo_destino: 'Dron T40'
        }
      ]
    }).expect(201);

    const compra = await auth(request(app).post(`/notas-pedido/${created.body.id}/convertir-compra`)).expect(201);
    expect(compra.body.notaPedidoId).toBe(created.body.id);
    expect(Array.isArray(compra.body.detalles)).toBe(true);
    expect(compra.body.detalles).toHaveLength(1);
    expect(compra.body.estado).toBe('GENERADA_DESDE_NOTA');

    const nota = await auth(request(app).get(`/notas-pedido/${created.body.id}`)).expect(200);
    expect(nota.body.estado).toBe('COMPRADA');
    expect(nota.body.compra).toBeTruthy();
    expect(nota.body.compra.id).toBe(compra.body.id);
  });

  test('agrega al stock una compra generada desde nota de pedido', async () => {
    const stockInicial = Number(producto.stock_actual || 0);

    const created = await auth(request(app).post('/notas-pedido')).send({
      proveedorId: proveedor.id,
      tipo: 'REPUESTOS',
      estado: 'RECIBIDA',
      equipo_destino: 'Dron T40',
      detalles: [
        {
          productoId: producto.id,
          cantidad: 3,
          equipo_destino: 'Dron T40'
        }
      ]
    }).expect(201);

    await auth(request(app).post(`/notas-pedido/${created.body.id}/convertir-compra`)).expect(201);

    const ingreso = await auth(request(app).post(`/notas-pedido/${created.body.id}/agregar-stock`)).expect(200);
    expect(ingreso.body.estado).toBe('STOCK_INGRESADO');

    const productoActualizado = await prisma.producto.findUnique({ where: { id: producto.id } });
    expect(Number(productoActualizado.stock_actual)).toBe(stockInicial + 3);

    const movimientos = await prisma.movimientoStock.findMany({ where: { productoId: producto.id, referencia_tipo: 'Compra' } });
    expect(movimientos).toHaveLength(1);
    expect(Number(movimientos[0].cantidad)).toBe(3);

    await auth(request(app).post(`/notas-pedido/${created.body.id}/agregar-stock`)).expect(409);

    await auth(request(app).put(`/notas-pedido/${created.body.id}`)).send({
      observaciones: 'Intento de edición tardía'
    }).expect(400);
  });
});