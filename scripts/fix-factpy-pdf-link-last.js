// Script para forzar la sincronización del link externo de Factpy en factura_digital para la última venta
// Ejecutar: node scripts/fix-factpy-pdf-link-last.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Buscar la última factura electrónica emitida (ajustar si necesitas otro criterio)
  const facturaElectronica = await prisma.facturaElectronica.findFirst({
    orderBy: { created_at: 'desc' },
    where: { pdf_path: { startsWith: 'http' } },
  });
  if (!facturaElectronica) {
    console.error('No se encontró factura electrónica con link externo.');
    process.exit(1);
  }
  // Buscar la factura digital asociada a la venta
  const facturaDigital = await prisma.facturaDigital.findFirst({
    where: { ventaId: facturaElectronica.ventaId },
  });
  if (!facturaDigital) {
    console.error('No se encontró factura digital asociada a la venta.');
    process.exit(1);
  }
  // Actualizar el campo pdf_path con el link externo
  await prisma.facturaDigital.update({
    where: { id: facturaDigital.id },
    data: { pdf_path: facturaElectronica.pdf_path },
  });
  console.log('¡Sincronización exitosa! Ahora el botón Ver PDF debe abrir el link externo:', facturaElectronica.pdf_path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
