require('dotenv').config();

const prisma = require('../src/prismaClient');
const ventaRouter = require('../src/routes/venta');

const buildFactPyPayload = ventaRouter.buildFactPyPayload;

async function main() {
  const ventaId = process.argv[2];

  if (!ventaId) {
    console.error('Uso: node scripts/inspect-factpy-payload.js <ventaId>');
    process.exitCode = 1;
    return;
  }

  if (typeof buildFactPyPayload !== 'function') {
    throw new Error('No se pudo cargar buildFactPyPayload desde src/routes/venta.js');
  }

  const venta = await prisma.venta.findFirst({
    where: { id: ventaId },
    include: {
      cliente: true,
      usuario: true,
      sucursal: true,
      detalles: { include: { producto: true } },
      factura_electronica: true
    }
  });

  if (!venta) {
    throw new Error(`No se encontró la venta ${ventaId}`);
  }

  const factura = venta.factura_electronica || null;
  const credito = factura?.respuesta_set?.credito || null;
  const payload = buildFactPyPayload(venta, factura, {
    condicion_pago: venta?.condicion_venta,
    fecha_vencimiento: venta?.fecha_vencimiento,
    credito
  });

  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });