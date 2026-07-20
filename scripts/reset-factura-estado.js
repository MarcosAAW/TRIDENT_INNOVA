/**
 * Ajusta manualmente el estado de una factura electrónica y sincroniza la venta.
 * Útil mientras el poll automático contra SIFEN no esté operativo.
 *
 * Dos direcciones según el estado destino:
 *
 *  a) Destrabar (RECHAZADO / PENDIENTE): limpia pdf/xml/qr y deja la venta en
 *     PENDIENTE para permitir el reenvío con el mismo número.
 *       node scripts/reset-factura-estado.js 001-001-0000011 --apply --estado RECHAZADO
 *
 *  b) Marcar aprobada (ACEPTADO / PAGADA / ENVIADO): NO borra los assets y deja
 *     la venta en FACTURADO. Opcionalmente guarda el CDC y el link QR reales.
 *       node scripts/reset-factura-estado.js 001-001-0000011 --apply --estado ACEPTADO \
 *         --cdc 0180132959... --qr "https://ekuatia.set.gov.py/consultas/qr?..."
 *
 * Siempre corre en dry-run salvo que agregues --apply.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ESTADOS_FACTURA_VALIDOS = ['PENDIENTE', 'ENVIADO', 'ACEPTADO', 'PAGADA', 'RECHAZADO'];
// Estados donde la factura representa un comprobante válido/en curso: la venta queda FACTURADO
// y conservamos los assets del documento.
const ESTADOS_EXITOSOS = ['ENVIADO', 'ACEPTADO', 'PAGADA'];

function parseArgs(argv) {
  const args = { nroFactura: null, apply: false, estado: 'RECHAZADO', cdc: null, qr: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--apply') {
      args.apply = true;
    } else if (value === '--estado') {
      args.estado = String(argv[i + 1] || '').toUpperCase();
      i += 1;
    } else if (value === '--cdc') {
      args.cdc = String(argv[i + 1] || '').trim() || null;
      i += 1;
    } else if (value === '--qr') {
      args.qr = String(argv[i + 1] || '').trim() || null;
      i += 1;
    } else if (!value.startsWith('--') && !args.nroFactura) {
      args.nroFactura = value;
    }
  }
  return args;
}

async function main() {
  const { nroFactura, apply, estado, cdc, qr } = parseArgs(process.argv.slice(2));

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

  const esExitoso = ESTADOS_EXITOSOS.includes(estado);
  const nuevoEstadoVenta = (() => {
    if (!factura.venta) return null;
    if (esExitoso) return 'FACTURADO';
    return factura.venta.estado === 'FACTURADO' ? 'PENDIENTE' : factura.venta.estado;
  })();

  console.log('--- Estado actual ---');
  console.log(`Factura ${factura.nro_factura} (id ${factura.id})`);
  console.log(`  estado factura : ${factura.estado}`);
  console.log(`  intentos       : ${factura.intentos}`);
  console.log(`  qr_data        : ${factura.qr_data ? 'presente' : '(vacío)'}`);
  console.log(`  venta id       : ${factura.ventaId || '(sin venta)'}`);
  console.log(`  estado venta   : ${factura.venta ? factura.venta.estado : '(sin venta)'}`);

  console.log('\n--- Cambios propuestos ---');
  console.log(`  estado factura : ${factura.estado} -> ${estado}`);
  if (esExitoso) {
    console.log('  pdf/xml/qr     : se conservan');
    if (cdc) console.log(`  cdc            : ${cdc}`);
    if (qr) console.log('  qr_data        : se actualiza con el link provisto');
  } else {
    console.log('  pdf_path       : se limpia (documento a reenviar)');
    console.log('  xml_path       : se limpia');
    console.log('  qr_data        : se limpia');
  }
  if (factura.venta) {
    console.log(`  estado venta   : ${factura.venta.estado} -> ${nuevoEstadoVenta}`);
  }

  if (!apply) {
    console.log('\n(dry-run) No se aplicó ningún cambio. Volvé a correr con --apply para persistir.');
    return;
  }

  const dataFactura = esExitoso
    ? {
        estado,
        ...(qr ? { qr_data: qr } : {}),
        respuesta_set: {
          ...(factura.respuesta_set && typeof factura.respuesta_set === 'object' ? factura.respuesta_set : {}),
          ajuste_manual: {
            estado,
            cdc: cdc || null,
            fecha: new Date().toISOString()
          },
          ...(cdc ? { last_estado: { estado, cdc } } : {})
        }
      }
    : { estado, pdf_path: null, xml_path: null, qr_data: null };

  const ops = [
    prisma.facturaElectronica.update({
      where: { id: factura.id },
      data: dataFactura
    })
  ];

  if (factura.venta && nuevoEstadoVenta && nuevoEstadoVenta !== factura.venta.estado) {
    ops.push(
      prisma.venta.update({
        where: { id: factura.ventaId },
        data: { estado: nuevoEstadoVenta }
      })
    );
  }

  await prisma.$transaction(ops);

  console.log(
    esExitoso
      ? '\n✓ Factura marcada como aprobada/en curso y venta sincronizada a FACTURADO.'
      : '\n✓ Factura destrabada. Queda habilitada para reenvío con el mismo número.'
  );
}

main()
  .catch((err) => {
    console.error('Error ejecutando el script:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
