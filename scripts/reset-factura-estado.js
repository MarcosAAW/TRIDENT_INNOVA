/**
 * Destraba una factura electrónica que quedó marcada como ACEPTADO en la BD
 * pese a que SIFEN la rechazó (bug histórico: la emisión marcaba ACEPTADO por
 * el solo hecho de recibir un cdc de FactPy).
 *
 * Deja la factura en RECHAZADO y revierte la venta a PENDIENTE para permitir
 * el reenvío con el mismo número de comprobante.
 *
 * Uso (dry-run, solo muestra):
 *   node scripts/reset-factura-estado.js 001-001-0000011
 *
 * Aplicar los cambios:
 *   node scripts/reset-factura-estado.js 001-001-0000011 --apply
 *
 * Opcional: forzar un estado de factura distinto (por defecto RECHAZADO):
 *   node scripts/reset-factura-estado.js 001-001-0000011 --apply --estado PENDIENTE
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ESTADOS_FACTURA_VALIDOS = ['PENDIENTE', 'ENVIADO', 'ACEPTADO', 'PAGADA', 'RECHAZADO'];

function parseArgs(argv) {
  const args = { nroFactura: null, apply: false, estado: 'RECHAZADO' };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--apply') {
      args.apply = true;
    } else if (value === '--estado') {
      args.estado = String(argv[i + 1] || '').toUpperCase();
      i += 1;
    } else if (!value.startsWith('--') && !args.nroFactura) {
      args.nroFactura = value;
    }
  }
  return args;
}

async function main() {
  const { nroFactura, apply, estado } = parseArgs(process.argv.slice(2));

  if (!nroFactura) {
    console.error('Falta el número de factura. Ej: node scripts/reset-factura-estado.js 001-001-0000011 [--apply]');
    process.exitCode = 1;
    return;
  }

  if (!ESTADOS_FACTURA_VALIDOS.includes(estado)) {
    console.error(`Estado inválido: ${estado}. Válidos: ${ESTADOS_FACTURA_VALIDOS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const factura = await prisma.facturaElectronica.findUnique({
    where: { nro_factura: nroFactura },
    include: { venta: true }
  });

  if (!factura) {
    console.error(`No se encontró una factura electrónica con nro_factura = ${nroFactura}`);
    process.exitCode = 1;
    return;
  }

  console.log('--- Estado actual ---');
  console.log(`Factura ${factura.nro_factura} (id ${factura.id})`);
  console.log(`  estado factura : ${factura.estado}`);
  console.log(`  intentos       : ${factura.intentos}`);
  console.log(`  venta id       : ${factura.ventaId || '(sin venta)'}`);
  console.log(`  estado venta   : ${factura.venta ? factura.venta.estado : '(sin venta)'}`);

  const nuevoEstadoVenta =
    factura.venta && factura.venta.estado === 'FACTURADO' ? 'PENDIENTE' : factura.venta?.estado;

  console.log('\n--- Cambios propuestos ---');
  console.log(`  estado factura : ${factura.estado} -> ${estado}`);
  console.log('  pdf_path       : se limpia (era del documento rechazado)');
  console.log('  xml_path       : se limpia');
  console.log('  qr_data        : se limpia');
  if (factura.venta) {
    console.log(`  estado venta   : ${factura.venta.estado} -> ${nuevoEstadoVenta}`);
  }

  if (!apply) {
    console.log('\n(dry-run) No se aplicó ningún cambio. Volvé a correr con --apply para persistir.');
    return;
  }

  const ops = [
    prisma.facturaElectronica.update({
      where: { id: factura.id },
      data: { estado, pdf_path: null, xml_path: null, qr_data: null }
    })
  ];

  if (factura.venta && factura.venta.estado === 'FACTURADO') {
    ops.push(
      prisma.venta.update({
        where: { id: factura.ventaId },
        data: { estado: 'PENDIENTE' }
      })
    );
  }

  await prisma.$transaction(ops);

  console.log('\n✓ Cambios aplicados. La factura queda habilitada para reenvío con el mismo número.');
}

main()
  .catch((err) => {
    console.error('Error ejecutando el script:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
