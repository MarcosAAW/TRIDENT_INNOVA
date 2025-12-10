const path = require('path');
const fs = require('fs/promises');
const prisma = require('../../prismaClient');
const { generateFacturaElectronicaXML } = require('./xmlGenerator');
const { signXml } = require('./signing');
const { sendDocumentoElectronico, getAmbiente } = require('./client');

async function ensureVentaCompleta(venta) {
  if (venta?.cliente && venta?.usuario && Array.isArray(venta?.detalles)) {
    return venta;
  }
  if (!venta?.id) {
    throw new Error('Venta inválida para procesar la factura electrónica.');
  }
  return prisma.venta.findUnique({
    where: { id: venta.id },
    include: {
      cliente: true,
      usuario: true,
      detalles: { include: { producto: true } },
      factura_electronica: true
    }
  });
}

async function guardarXmlFirmado(basePath, xmlFirmado) {
  const dir = path.dirname(basePath);
  const extIndex = basePath.lastIndexOf('.');
  const signedPath = extIndex > -1 ? `${basePath.slice(0, extIndex)}-firmado${basePath.slice(extIndex)}` : `${basePath}-firmado.xml`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(signedPath, xmlFirmado, 'utf8');
  return signedPath;
}

function buildRespuestaSet(envio) {
  return {
    ambiente: getAmbiente(),
    status: envio.status,
    ok: envio.ok,
    body: envio.body?.slice(0, 2000)
  };
}

async function procesarFacturaElectronica(venta) {
  const ventaCompleta = await ensureVentaCompleta(venta);
  if (!ventaCompleta) {
    throw new Error('No se encontró la venta para procesar la factura.');
  }

  const factura = ventaCompleta.factura_electronica;
  if (!factura) {
    throw new Error('La venta todavía no cuenta con un registro de factura electrónica.');
  }

  const { xml, filePath } = await generateFacturaElectronicaXML({
    venta: ventaCompleta,
    detalles: ventaCompleta.detalles,
    cliente: ventaCompleta.cliente
  });

  const firmado = await signXml(xml);
  const signedPath = await guardarXmlFirmado(filePath || path.join(__dirname, '..', '..', '..', 'storage', 'facturas', `${factura.id}.xml`), firmado.xml);

  let envio = null;
  try {
    envio = await sendDocumentoElectronico({ xml: firmado.xml });
  } catch (error) {
    envio = { ok: false, status: 0, body: error.message };
  }

  const nuevoEstado = envio.ok ? 'ENVIADA' : 'PENDIENTE';
  const respuesta_set = buildRespuestaSet(envio);

  const relativePath = (() => {
    const idx = signedPath.toLowerCase().lastIndexOf('storage');
    if (idx === -1) return signedPath;
    return `/storage${signedPath.slice(idx + 'storage'.length).replace(/\\/g, '/')}`;
  })();

  const facturaActualizada = await prisma.facturaElectronica.update({
    where: { id: factura.id },
    data: {
      xml_path: relativePath,
      estado: nuevoEstado,
      respuesta_set,
      intentos: { increment: 1 },
      ambiente: getAmbiente()
    }
  });

  return {
    factura: facturaActualizada,
    envio,
    signedPath
  };
}

module.exports = {
  procesarFacturaElectronica
};
