const request = require('supertest');
const { app } = require('../src/app');
const prisma = require('../src/prismaClient');

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SUCURSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function main() {
  const unique = Date.now();

  const producto = await prisma.producto.create({
    data: {
      sku: `NC-PARCIAL-${unique}`,
      nombre: `Producto NC Parcial ${unique}`,
      tipo: 'REPUESTO',
      precio_venta: 1000,
      stock_actual: 10,
      sucursalId: SUCURSAL_ID
    }
  });

  const ventaRes = await request(app)
    .post('/ventas')
    .set('x-user-id', ADMIN_ID)
    .set('x-sucursal-id', SUCURSAL_ID)
    .send({
      usuarioId: ADMIN_ID,
      iva_porcentaje: 10,
      detalles: [{ productoId: producto.id, cantidad: 2 }]
    });

  console.log('VENTA_STATUS', ventaRes.statusCode);
  console.log(JSON.stringify(ventaRes.body, null, 2));
  if (ventaRes.statusCode !== 201) {
    process.exitCode = 2;
    return;
  }

  const ventaId = ventaRes.body.id;

  const facturaRes = await request(app)
    .post(`/ventas/${ventaId}/facturar`)
    .set('x-user-id', ADMIN_ID)
    .set('x-sucursal-id', SUCURSAL_ID)
    .send({});

  console.log('FACTURA_STATUS', facturaRes.statusCode);
  console.log(JSON.stringify(facturaRes.body, null, 2));
  if (facturaRes.statusCode !== 200) {
    process.exitCode = 3;
    return;
  }

  const venta = await prisma.venta.findUnique({
    where: { id: ventaId },
    include: { detalles: true }
  });

  const detalleVenta = Array.isArray(venta?.detalles) ? venta.detalles[0] : null;
  if (!detalleVenta?.id) {
    console.error('No se encontró detalle de venta para emitir la nota parcial.');
    process.exitCode = 4;
    return;
  }

  const notaRes = await request(app)
    .post(`/ventas/${ventaId}/nota-credito`)
    .set('x-user-id', ADMIN_ID)
    .set('x-sucursal-id', SUCURSAL_ID)
    .send({
      motivo: 'Devolucion parcial de prueba desde script',
      tipo_ajuste: 'PARCIAL',
      detalles: [{ detalleVentaId: detalleVenta.id, cantidad: 1 }]
    });

  console.log('NOTA_STATUS', notaRes.statusCode);
  console.log(JSON.stringify(notaRes.body, null, 2));

  if (notaRes.statusCode !== 201) {
    process.exitCode = 5;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });