const request = require('supertest');
const { app } = require('../src/app');
const prisma = require('../src/prismaClient');

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SUCURSAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function main() {
  const unique = Date.now();

  const producto = await prisma.producto.create({
    data: {
      sku: `NC-TEST-${unique}`,
      nombre: `Producto NC ${unique}`,
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
      detalles: [{ productoId: producto.id, cantidad: 1 }]
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

  const notaRes = await request(app)
    .post(`/ventas/${ventaId}/nota-credito`)
    .set('x-user-id', ADMIN_ID)
    .set('x-sucursal-id', SUCURSAL_ID)
    .send({ motivo: 'Anulacion total de prueba desde script' });

  console.log('NOTA_STATUS', notaRes.statusCode);
  console.log(JSON.stringify(notaRes.body, null, 2));

  if (notaRes.statusCode !== 201) {
    process.exitCode = 4;
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
