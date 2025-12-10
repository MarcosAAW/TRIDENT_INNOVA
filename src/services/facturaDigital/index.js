const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { Prisma } = require('@prisma/client');
const prisma = require('../../prismaClient');
const empresaConfig = require('../../config/empresa');
const { renderFacturaDigitalPdf } = require('./pdfTemplate');

const FACTURA_DIGITAL_DIR = path.join(__dirname, '..', '..', '..', 'storage', 'facturas_digitales');

class FacturaDigitalError extends Error {
  constructor(message, code = 'FACTURA_DIGITAL_ERROR') {
    super(message);
    this.name = 'FacturaDigitalError';
    this.code = code;
  }
}

async function generarFacturaDigital(venta, options = {}) {
  const ventaCompleta = await ensureVentaCompleta(venta);
  if (!ventaCompleta) {
    throw new Error('Venta no encontrada para factura digital');
  }

  const timbrado = empresaConfig.timbrado || {};
  validateTimbradoConfig(timbrado);

  const totals = computeTotals(ventaCompleta);
  const breakdown = computeBreakdown(ventaCompleta);
  const condicionVenta = options.condicion || inferCondicionVenta(ventaCompleta);

  const baseRecord = await prisma.$transaction(async (tx) => {
    const existente = await tx.facturaDigital.findUnique({ where: { ventaId: ventaCompleta.id } });
    const secuencia = await resolveSecuencia(tx, existente, timbrado);
    const numeroFactura = existente?.nro_factura || buildNumeroFactura(timbrado, secuencia);
    const now = new Date();
    const qrPayload = buildQrPayload(numeroFactura, ventaCompleta, totals, timbrado);
    const qrData = JSON.stringify(qrPayload);
    const numeroControl = buildControlCode(numeroFactura, timbrado.numero, totals.total, now);
    const data = {
      ventaId: ventaCompleta.id,
      nro_factura: numeroFactura,
      timbrado: timbrado.numero,
      establecimiento: timbrado.establecimiento || '001',
      punto_expedicion: timbrado.punto_expedicion || '001',
      secuencia,
      condicion_venta: condicionVenta,
      fecha_emision: now,
      moneda: ventaCompleta.moneda || 'PYG',
      total_exentas: toDecimal(breakdown.exentas),
      total_gravada_5: toDecimal(breakdown.gravado5),
      total_gravada_10: toDecimal(breakdown.gravado10),
      total_iva_5: toDecimal(breakdown.iva5),
      total_iva_10: toDecimal(breakdown.iva10),
      total: toDecimal(totals.total),
      total_iva: toDecimal(breakdown.iva5 + breakdown.iva10),
      pdf_path: null,
      hash_pdf: null,
      total_letras: options.total_letras || null,
      qr_data: qrData,
      numero_control: numeroControl,
      estado_envio: existente?.estado_envio || 'PENDIENTE',
      enviado_a: existente?.enviado_a || null,
      enviado_en: existente?.enviado_en || null,
      intentos: existente?.intentos || 0
    };

    if (existente) {
      return tx.facturaDigital.update({ where: { id: existente.id }, data });
    }
    return tx.facturaDigital.create({ data });
  });

  const qrBuffer = await QRCode.toBuffer(baseRecord.qr_data || baseRecord.nro_factura, {
    width: 150,
    margin: 0,
    errorCorrectionLevel: 'M'
  });
  const fileInfo = await generarPdf(baseRecord, ventaCompleta, totals, breakdown, qrBuffer, timbrado);
  const hash = await hashFile(fileInfo.absolutePath);
  const actualizado = await prisma.facturaDigital.update({
    where: { id: baseRecord.id },
    data: {
      pdf_path: fileInfo.webPath,
      hash_pdf: hash
    }
  });

  return actualizado;
}

async function ensureVentaCompleta(venta) {
  if (venta && venta.detalles && venta.detalles.length && venta.detalles[0]?.producto) {
    return venta;
  }
  if (!venta || !venta.id) return null;
  return prisma.venta.findUnique({
    where: { id: venta.id },
    include: {
      cliente: true,
      usuario: true,
      detalles: { include: { producto: true } }
    }
  });
}

async function resolveSecuencia(tx, existente, timbrado) {
  if (existente && typeof existente.secuencia === 'number') {
    return existente.secuencia;
  }
  const ultimo = await tx.facturaDigital.findFirst({
    where: {
      timbrado: timbrado.numero,
      establecimiento: timbrado.establecimiento || '001',
      punto_expedicion: timbrado.punto_expedicion || '001'
    },
    orderBy: { secuencia: 'desc' },
    select: { secuencia: true }
  });
  return (ultimo?.secuencia || 0) + 1;
}

async function generarPdf(registro, venta, totals, breakdown, qrBuffer, timbrado) {
  await fsPromises.mkdir(FACTURA_DIGITAL_DIR, { recursive: true });
  const safeName = registro.nro_factura.replace(/[^0-9A-Za-z-_]/gu, '_');
  const filename = `${safeName}.pdf`;
  const absolutePath = path.join(FACTURA_DIGITAL_DIR, filename);
  const webPath = `/storage/facturas_digitales/${filename}`;

  const doc = new PDFDocument({ size: 'A4', margin: 32 });
  const writeStream = fs.createWriteStream(absolutePath);
  doc.pipe(writeStream);

  renderFacturaDigitalPdf(doc, {
    empresa: empresaConfig,
    timbrado,
    factura: {
      numero: registro.nro_factura,
      fecha_emision: registro.fecha_emision,
      condicion: registro.condicion_venta,
      nota_remision: null,
      numero_control: registro.numero_control
    },
    venta,
    detalles: venta.detalles,
    totals,
    breakdown,
    qrBuffer
  });

  doc.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  return { absolutePath, webPath };
}

function computeTotals(venta) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const subtotal = detalles.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);
  const descuento = Number(venta?.descuento_total) || 0;
  const total = Number(venta?.total) || Math.max(subtotal - descuento, 0);
  const ivaPorcentaje = Number(venta?.iva_porcentaje) || 10;
  const divisor = ivaPorcentaje === 5 ? 21 : 11;
  const iva = total > 0 ? total / divisor : 0;
  return { subtotal, descuento, total, iva };
}

function computeBreakdown(venta) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  return detalles.reduce(
    (acc, detalle) => {
      const cantidad = Number(detalle.cantidad) || 0;
      const precio = Number(detalle.precio_unitario) || 0;
      const subtotal = Number(detalle.subtotal) || cantidad * precio;
      const iva = resolveDetalleIva(detalle, venta);
      if (iva === 5) {
        acc.gravado5 += subtotal;
        acc.iva5 += subtotal / 21;
      } else if (iva === 10) {
        acc.gravado10 += subtotal;
        acc.iva10 += subtotal / 11;
      } else {
        acc.exentas += subtotal;
      }
      return acc;
    },
    { exentas: 0, gravado5: 0, iva5: 0, gravado10: 0, iva10: 0 }
  );
}

function resolveDetalleIva(detalle, venta) {
  if (typeof detalle?.iva_porcentaje === 'number') return detalle.iva_porcentaje;
  if (typeof detalle?.producto?.iva_porcentaje === 'number') return detalle.producto.iva_porcentaje;
  return Number(venta?.iva_porcentaje) || 10;
}

function buildNumeroFactura(timbrado, secuencia) {
  const establecimiento = (timbrado.establecimiento || '001').padStart(3, '0');
  const punto = (timbrado.punto_expedicion || '001').padStart(3, '0');
  const correlativo = String(secuencia || 1).padStart(7, '0');
  return `${establecimiento}-${punto}-${correlativo}`;
}

function buildQrPayload(nroFactura, venta, totals, timbrado) {
  return {
    timbrado: timbrado.numero,
    factura: nroFactura,
    ruc_emisor: empresaConfig.ruc,
    total: totals.total,
    fecha: new Date(venta?.created_at || Date.now()).toISOString(),
    cliente: venta?.cliente?.ruc || 'S/D'
  };
}

function buildControlCode(nroFactura, timbrado, total, fecha) {
  return crypto.createHash('md5').update(`${nroFactura}|${timbrado}|${total}|${fecha.toISOString()}`).digest('hex').slice(0, 16).toUpperCase();
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function toDecimal(value) {
  const number = Number(value) || 0;
  return new Prisma.Decimal(number.toFixed(2));
}

function inferCondicionVenta(venta) {
  if (!venta) return 'CONTADO';
  const estado = (venta.estado || '').toUpperCase();
  if (estado.includes('CREDITO')) return 'CRÉDITO';
  return 'CONTADO';
}

module.exports = {
  generarFacturaDigital,
  buildNumeroFactura,
  FacturaDigitalError,
  validateTimbradoConfig
};

function validateTimbradoConfig(timbrado) {
  if (!timbrado || !timbrado.numero) {
    throw new FacturaDigitalError('No se configuró un número de timbrado para la factura digital.', 'TIMBRADO_NO_CONFIGURADO');
  }
  const ahora = new Date();
  const inicio = parseTimbradoDate(timbrado.vigencia_inicio);
  const fin = parseTimbradoDate(timbrado.vigencia_fin);
  if (inicio && ahora < inicio) {
    throw new FacturaDigitalError('El timbrado informado aún no está vigente.', 'TIMBRADO_NO_VIGENTE');
  }
  if (fin && ahora > fin) {
    throw new FacturaDigitalError('El timbrado informado está vencido.', 'TIMBRADO_VENCIDO');
  }
}

function parseTimbradoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const parts = value.includes('/') ? value.split('/') : value.split('-');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map((chunk) => Number(chunk));
  if (!day || !month || !year) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
