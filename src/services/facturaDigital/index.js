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
const { getSaleDetailSnapshot } = require('../../utils/productPricing');

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

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

  const facturaElectronica = ventaCompleta.factura_electronica;

  const timbrado = selectTimbradoParaVenta(ventaCompleta, empresaConfig);
  validateTimbradoConfig(timbrado);

  const totals = computeTotals(ventaCompleta);
  const breakdown = computeBreakdown(ventaCompleta);
  const condicionVenta = options.condicion || inferCondicionVenta(ventaCompleta);

  // Tomar establecimiento y punto_expedicion de la sucursal si existen, si no del timbrado/config
  const sucursal = ventaCompleta.sucursal || {};
  const establecimiento = sucursal.establecimiento?.trim() || timbrado.establecimiento || '001';
  const punto_expedicion = sucursal.punto_expedicion?.trim() || timbrado.punto_expedicion || '001';

  const baseRecord = await prisma.$transaction(async (tx) => {
    const sucursalId = ventaCompleta.sucursalId || sucursal.id || null;
    const existente = await tx.facturaDigital.findUnique({ where: { ventaId: ventaCompleta.id } });
    let secuencia = await resolveSecuencia(tx, existente, { ...timbrado, establecimiento, punto_expedicion }, sucursalId);
    const secuenciaDesdeFactura = parseSecuenciaFromNumero(facturaElectronica?.nro_factura);
    if (typeof secuenciaDesdeFactura === 'number') {
      secuencia = secuenciaDesdeFactura;
    }

    const numeroFactura = facturaElectronica?.nro_factura || existente?.nro_factura || buildNumeroFactura({ ...timbrado, establecimiento, punto_expedicion }, secuencia);
    const now = new Date();
    const qrPayload = facturaElectronica?.qr_data || buildQrPayload(numeroFactura, ventaCompleta, totals, { ...timbrado, establecimiento, punto_expedicion });
    const qrData = typeof qrPayload === 'string' ? qrPayload : JSON.stringify(qrPayload);
    const numeroControl = facturaElectronica?.qr_data || buildControlCode(numeroFactura, timbrado.numero, totals.total, now);
    const data = {
      ventaId: ventaCompleta.id,
      nro_factura: numeroFactura,
      timbrado: timbrado.numero,
      establecimiento,
      punto_expedicion,
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
      intentos: existente?.intentos || 0,
      sucursalId
    };

    if (existente) {
      return tx.facturaDigital.update({ where: { id: existente.id }, data });
    }

    try {
      return await tx.facturaDigital.create({ data });
    } catch (err) {
      if (err?.code === 'P2002' && Array.isArray(err.meta?.target) && err.meta.target.includes('nro_factura')) {
        // En conflicto por nro_factura, actualizamos el existente en una nueva transacción para evitar el estado abortado 25P02
        const choque = await prisma.facturaDigital.findUnique({ where: { nro_factura: numeroFactura } });
        if (choque) {
          return prisma.facturaDigital.update({ where: { id: choque.id }, data });
        }
      }
      throw err;
    }
  });

  const qrBuffer = await QRCode.toBuffer(baseRecord.qr_data || baseRecord.nro_factura, {
    width: 150,
    margin: 0,
    errorCorrectionLevel: 'M'
  });
  const fileInfo = await generarPdf(baseRecord, ventaCompleta, totals, breakdown, qrBuffer, timbrado, facturaElectronica);
  const hash = await hashFile(fileInfo.absolutePath);
  // Si ya existe un pdf_path externo (http/https), no lo sobrescribas
  let pdfPathToSave = fileInfo.webPath;
  if (baseRecord.pdf_path && /^https?:\/\//i.test(baseRecord.pdf_path)) {
    pdfPathToSave = baseRecord.pdf_path;
  }
  const actualizado = await prisma.facturaDigital.update({
    where: { id: baseRecord.id },
    data: {
      pdf_path: pdfPathToSave,
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
      factura_electronica: true,
      sucursal: true,
      detalles: { include: { producto: true } }
    }
  });
}

async function resolveSecuencia(tx, existente, timbrado, sucursalId) {
  if (existente && typeof existente.secuencia === 'number') {
    return existente.secuencia;
  }
  const where = {
    timbrado: timbrado.numero,
    establecimiento: timbrado.establecimiento || '001',
    punto_expedicion: timbrado.punto_expedicion || '001',
    ...(sucursalId ? { sucursalId } : {})
  };
  const ultimo = await tx.facturaDigital.findFirst({
    where,
    orderBy: { secuencia: 'desc' },
    select: { secuencia: true }
  });
  return (ultimo?.secuencia || 0) + 1;
}

async function generarPdf(registro, venta, totals, breakdown, qrBuffer, timbrado, facturaElectronica) {
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
      numero: facturaElectronica?.nro_factura || registro.nro_factura,
      fecha_emision: registro.fecha_emision,
      condicion: registro.condicion_venta,
      nota_remision: null,
      numero_control: registro.numero_control,
      moneda: (venta.moneda || 'PYG').toUpperCase(),
      tipo_cambio: venta.tipo_cambio,
      total_moneda: venta.total_moneda,
      tipo_transaccion: 'Venta de mercadería',
      correo_emisor: empresaConfig.email || '',
      cdc: deriveCdc(facturaElectronica, registro)
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
  const tipoCambio = Number(venta?.tipo_cambio) || 0;
  const isUsd = venta?.moneda?.toUpperCase() === 'USD' && tipoCambio > 0;

  const subtotalGs = detalles.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);
  const descuentoGs = Number(venta?.descuento_total) || 0;
  const subtotal = isUsd
    ? round(detalles.reduce((acc, detalle) => acc + Number(getSaleDetailSnapshot(detalle, venta).subtotalCurrency || 0), 0), 4)
    : subtotalGs;
  const descuento = isUsd ? (tipoCambio > 0 ? descuentoGs / tipoCambio : 0) : descuentoGs;
  const total = Math.max(subtotal - descuento, 0);

  const ivaPorcentaje = Number(venta?.iva_porcentaje) || 10;
  const divisor = ivaPorcentaje === 5 ? 21 : 11;
  const iva = total > 0 ? total / divisor : 0;

  return { subtotal, descuento, total, iva, factor: isUsd ? 1 / tipoCambio : 1 };
}

function computeBreakdown(venta) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const descuentoGlobal = Number(venta?.descuento_total) || 0;
  const subtotalBruto = detalles.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);
  const factorDescuento = subtotalBruto > 0 ? Math.max(subtotalBruto - descuentoGlobal, 0) / subtotalBruto : 1;
  const tipoCambio = Number(venta?.tipo_cambio) || 0;
  const factorMoneda = venta?.moneda?.toUpperCase() === 'USD' && tipoCambio > 0 ? 1 / tipoCambio : 1;

  return detalles.reduce(
    (acc, detalle) => {
      const snapshot = getSaleDetailSnapshot(detalle, venta);
      const subtotalBrutoItem = venta?.moneda?.toUpperCase() === 'USD'
        ? Number(snapshot.subtotalCurrency || 0)
        : Number((snapshot.subtotalCurrency ?? snapshot.subtotalGs) || 0);
      const subtotal = Number((subtotalBrutoItem * factorDescuento * factorMoneda).toFixed(2));
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

function selectTimbradoParaVenta(venta, config) {
  const baseTimbrado = config.timbrado || {};
  const overrides = Array.isArray(config.timbradosPorSucursal) ? config.timbradosPorSucursal : [];
  if (!venta) return baseTimbrado;
  const sucursalId = venta.sucursalId || venta.sucursal?.id;
  const sucursalNombre = (venta.sucursal?.nombre || '').trim().toLowerCase();
  const match = overrides.find((item) => {
    if (item.sucursalId && sucursalId && item.sucursalId === sucursalId) return true;
    if (item.nombre && sucursalNombre && sucursalNombre === String(item.nombre).trim().toLowerCase()) return true;
    return false;
  });
  if (match) {
    return { ...baseTimbrado, ...match };
  }
  return baseTimbrado;
}

function buildNumeroFactura(timbrado, secuencia) {
  const establecimiento = (timbrado.establecimiento || '001').padStart(3, '0');
  const punto = (timbrado.punto_expedicion || '001').padStart(3, '0');
  const correlativo = String(secuencia || 1).padStart(7, '0');
  return `${establecimiento}-${punto}-${correlativo}`;
}

function deriveCdc(facturaElectronica, registro) {
  const raw = facturaElectronica?.qr_data || facturaElectronica?.cdc || registro?.numero_control;
  if (typeof raw !== 'string') return raw || null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.cdc) return parsed.cdc;
      if (parsed?.control) return parsed.control;
      if (parsed?.factura) return parsed.factura;
    } catch (_err) {
      // ignore
    }
  }
  return trimmed;
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
  if (venta.condicion_venta && venta.condicion_venta.toUpperCase().includes('CREDITO')) return 'CRÉDITO';
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

function parseSecuenciaFromNumero(nroFactura) {
  if (!nroFactura || typeof nroFactura !== 'string') return null;
  const parts = nroFactura.split('-');
  if (parts.length !== 3) return null;
  const correlativo = parts[2].replace(/[^0-9]/g, '');
  if (!correlativo) return null;
  const parsed = Number(correlativo);
  return Number.isFinite(parsed) ? parsed : null;
}

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
