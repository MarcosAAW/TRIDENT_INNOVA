#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, prisma } = require('../src/app');

function resolveFromWebPath(webPath) {
  if (!webPath) return null;
  const relative = webPath.replace(/^\/+/, '');
  return path.join(__dirname, '..', relative);
}

async function pickUsuario() {
  const usuario = await prisma.usuario.findFirst({ where: { deleted_at: null } });
  if (!usuario) {
    throw new Error('No se encontró un usuario para crear la venta. Ejecuta el seed antes.');
  }
  return usuario;
}

async function pickCliente() {
  return prisma.cliente.findFirst({ where: { deleted_at: null } });
}

async function pickProducto() {
  const producto = await prisma.producto.findFirst({
    where: {
      deleted_at: null,
      stock_actual: { gt: 0 }
    },
    orderBy: { updated_at: 'desc' }
  });
  if (!producto) {
    throw new Error('No hay productos disponibles con stock para crear la venta.');
  }
  return producto;
}

async function main() {
  console.log('Conectando a la base de datos...');
  await prisma.$connect();

  const usuario = await pickUsuario();
  const cliente = await pickCliente();
  const producto = await pickProducto();

  console.log('Creando venta de prueba...');
  const ventaPayload = {
    usuarioId: usuario.id,
    clienteId: cliente?.id,
    iva_porcentaje: 10,
    detalles: [{ productoId: producto.id, cantidad: 1 }]
  };

  const ventaRes = await request(app).post('/ventas').send(ventaPayload);
  if (ventaRes.status !== 201) {
    console.error('Error al crear la venta:', ventaRes.body);
    throw new Error(`Creación de venta falló con status ${ventaRes.status}`);
  }

  const ventaId = ventaRes.body.id;
  console.log('Venta creada:', ventaId);

  console.log('Generando factura digital...');
  const facturaRes = await request(app).post(`/ventas/${ventaId}/facturar`).send();
  if (facturaRes.status !== 200) {
    console.error('Error al facturar:', facturaRes.body);
    throw new Error(`Facturación falló con status ${facturaRes.status}`);
  }

  const facturaElectronica = facturaRes.body?.factura;
  const facturaDigital = facturaRes.body?.venta?.factura_digital;
  if (!facturaDigital?.id) {
    throw new Error('No se generó la factura digital. Revisa los logs.');
  }

  console.log('Factura electrónica:', facturaElectronica?.nro_factura);
  console.log('Factura digital:', facturaDigital.id);

  const pdfPath = facturaDigital.pdf_path;
  const pdfAbsolute = resolveFromWebPath(pdfPath);

  if (pdfAbsolute && fs.existsSync(pdfAbsolute)) {
    console.log('PDF generado en:', pdfAbsolute);
  } else {
    console.warn('No se encontró el archivo PDF en disco todavía.');
  }

  console.log('Descargando PDF vía API...');
  const pdfRes = await request(app).get(`/facturas-digitales/${facturaDigital.id}/pdf`);
  if (pdfRes.status !== 200) {
    throw new Error(`Descarga de PDF falló con status ${pdfRes.status}`);
  }
  console.log('Descarga exitosa. Bytes recibidos:', pdfRes.body.length || pdfRes.text?.length || 0);

  console.log('\nResumen:');
  console.log(`  Venta ID: ${ventaId}`);
  console.log(`  Factura electrónica: ${facturaElectronica?.id}`);
  console.log(`  Factura digital: ${facturaDigital.id}`);
  console.log(`  PDF: ${pdfPath}`);
}

main()
  .catch((err) => {
    console.error('Fallo durante la prueba de factura digital:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
