const path = require('path');
const fs = require('fs/promises');
const xmlgen = require('facturacionelectronicapy-xmlgen');
const { loadEmisorParams } = require('../../config/sifen');
const { resolveUbicacion } = require('./geoCodes');

const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'storage', 'facturas');
const DEFAULT_PUNTO = process.env.SIFEN_PUNTO_EXPEDICION || '001';
const DEFAULT_DOCUMENT_DESCRIPTION = 'Documento electrónico generado desde Trident Innova';
const IVA_DIVISOR = {
  5: 21,
  10: 11
};

const UNIDAD_DEFAULT = 77; // Unidad (UN)
const UNIDADES_MAP = {
  UNIDAD: 77,
  UN: 77,
  KG: 6,
  L: 7,
  HORA: 96
};

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function splitMontoConIva(monto, tasa = 10) {
  const divisor = IVA_DIVISOR[tasa] || IVA_DIVISOR[10];
  const iva = round(monto / divisor);
  const base = round(monto - iva);
  return { base, iva };
}

function padNumber(value, size = 7) {
  const text = String(value ?? '').replace(/[^0-9]/g, '');
  if (text.length >= size) return text.slice(-size);
  return text.padStart(size, '0');
}

function randomSecurityCode() {
  return String(Math.floor(Math.random() * 999999)).padStart(6, '0');
}

function mapEstablecimientoToUbicacion(establecimiento = {}) {
  return {
    departamentoCodigo: establecimiento.departamento ? String(establecimiento.departamento) : undefined,
    departamento: establecimiento.departamentoDescripcion,
    distritoCodigo: establecimiento.distrito ? String(establecimiento.distrito) : undefined,
    distrito: establecimiento.distritoDescripcion,
    ciudadCodigo: establecimiento.ciudad ? String(establecimiento.ciudad) : undefined,
    ciudad: establecimiento.ciudadDescripcion,
    telefono: establecimiento.telefono,
    email: establecimiento.email,
    direccion: establecimiento.direccion,
    numeroCasa: establecimiento.numeroCasa
  };
}

function buildClientePayload(cliente = {}, fallbackUbicacion = {}) {
  const contribuyente = Boolean(cliente?.ruc);
  const fallbackUbicacionRow = mapEstablecimientoToUbicacion(fallbackUbicacion);
  const ubicacion = resolveUbicacion({ cliente, fallback: fallbackUbicacionRow }) || fallbackUbicacionRow;
  const departamentoCodigo = cliente?.departamentoCodigo || ubicacion.departamentoCodigo || 7;
  const distritoCodigo = cliente?.distritoCodigo || ubicacion.distritoCodigo || 143;
  const ciudadCodigo = cliente?.ciudadCodigo || ubicacion.ciudadCodigo || 3432;

  return {
    contribuyente,
    ruc: cliente?.ruc || '44444401-7',
    razonSocial: cliente?.nombre_razon_social || 'Consumidor Final',
    nombreFantasia: cliente?.nombre_razon_social || 'Consumidor Final',
    tipoOperacion: contribuyente ? 1 : 2,
    direccion: cliente?.direccion || ubicacion.direccion || 'Sin dirección',
    numeroCasa: cliente?.numeroCasa || ubicacion.numeroCasa || 'S/N',
    departamento: Number(departamentoCodigo),
    departamentoDescripcion:
      cliente?.departamentoDescripcion || ubicacion.departamento || 'ITAPÚA',
    distrito: Number(distritoCodigo),
    distritoDescripcion:
      cliente?.distritoDescripcion || ubicacion.distrito || 'DOMINGO MARTÍNEZ DE IRALA',
    ciudad: Number(ciudadCodigo),
    ciudadDescripcion: cliente?.ciudadDescripcion || ubicacion.ciudad || 'SAN IGNACIO',
    pais: 'PRY',
    paisDescripcion: 'Paraguay',
    tipoContribuyente: contribuyente ? 1 : 2,
    documentoTipo: contribuyente ? 1 : 5,
    documentoNumero: cliente?.ruc || cliente?.documento || '0000000',
    telefono: cliente?.telefono || ubicacion.telefono,
    celular: cliente?.celular,
    email: cliente?.correo || ubicacion.email,
    codigo: cliente?.id
  };
}

function resolveUnidadMedida(producto = {}) {
  if (producto.unidad_codigo || producto.unidadCodigo) {
    return Number(producto.unidad_codigo || producto.unidadCodigo);
  }
  const unidadTexto = typeof producto.unidad === 'string' ? producto.unidad.trim().toUpperCase() : '';
  return UNIDADES_MAP[unidadTexto] || UNIDAD_DEFAULT;
}

function buildItemsPayload(detalles = [], venta) {
  if (!Array.isArray(detalles) || !detalles.length) {
    throw new Error('La venta debe incluir ítems para generar el XML.');
  }

  return detalles.map((detalle, index) => {
    const producto = detalle.producto || {};
    const cantidad = toNumber(detalle.cantidad, 1);
    const precioUnitario = toNumber(detalle.precio_unitario, 0);
    const subtotal = toNumber(detalle.subtotal, cantidad * precioUnitario);
    const tasa = Number(producto.iva_porcentaje || venta?.iva_porcentaje || 10);
    const { base, iva } = splitMontoConIva(subtotal, tasa);

    return {
      codigo: producto.sku || producto.id || `ITEM-${index + 1}`,
      descripcion: producto.nombre || 'Producto / Servicio',
      observacion: producto.descripcion || undefined,
      unidadMedida: resolveUnidadMedida(producto),
      cantidad,
      precioUnitario,
      descuento: 0,
      anticipo: 0,
      ivaTipo: tasa === 5 ? 2 : 1,
      ivaBase: base,
      iva
    };
  });
}

function inferNumeroDocumento(venta) {
  const numeroExistente = venta?.factura_electronica?.nro_factura || venta?.nro_factura;
  if (numeroExistente) {
    const parts = numeroExistente.split('-');
    return padNumber(parts[2] || parts.pop());
  }
  return padNumber(venta?.secuencia || venta?.id);
}

function buildDocumentoData({ venta, cliente, detalles, emisorParams, overrides = {} }) {
  if (!venta) {
    throw new Error('Se requiere la venta para construir el Documento Electrónico.');
  }
  const establecimientoConfig = emisorParams?.establecimientos?.[0] || {};
  const clientePayload = buildClientePayload(cliente, establecimientoConfig);
  const items = buildItemsPayload(detalles, venta);
  const fecha = (venta.fecha instanceof Date ? venta.fecha : new Date(venta.fecha || Date.now())).toISOString();
  const punto = overrides.punto || DEFAULT_PUNTO;
  const establecimiento = overrides.establecimiento || establecimientoConfig.codigo || '001';

  return {
    tipoDocumento: overrides.tipoDocumento || 1,
    establecimiento,
    punto,
    numero: overrides.numero || inferNumeroDocumento(venta),
    codigoSeguridadAleatorio: overrides.codigoSeguridadAleatorio || randomSecurityCode(),
    descripcion: overrides.descripcion || DEFAULT_DOCUMENT_DESCRIPTION,
    observacion: overrides.observacion,
    fecha,
    tipoEmision: overrides.tipoEmision || 1,
    tipoTransaccion: overrides.tipoTransaccion || 1,
    tipoImpuesto: overrides.tipoImpuesto || 1,
    moneda: venta.moneda || 'PYG',
    condicionAnticipo: overrides.condicionAnticipo || 1,
    condicionTipoCambio: overrides.condicionTipoCambio || 1,
    descuentoGlobal: toNumber(venta.descuento_total, 0),
    anticipoGlobal: overrides.anticipoGlobal || 0,
    cambio: toNumber(venta.tipo_cambio, 0),
    cliente: clientePayload,
    usuario: overrides.usuario || {
      documentoTipo: 1,
      documentoNumero: venta.usuario?.numero_documento || '0000000',
      nombre: venta.usuario?.nombre || venta.usuario?.usuario || 'Vendedor',
      cargo: 'Vendedor'
    },
    factura: overrides.factura || {
      presencia: overrides.presencia || 1
    },
    condicion: overrides.condicion || {
      tipo: 1,
      entregas: [
        {
          tipo: 1,
          monto: toNumber(venta.total, 0),
          moneda: venta.moneda || 'PYG',
          cambio: 0
        }
      ]
    },
    items,
    total: toNumber(venta.total, 0)
  };
}

async function generateFacturaElectronicaXML({
  venta,
  detalles = venta?.detalles || [],
  cliente = venta?.cliente,
  emisorParams = loadEmisorParams(),
  outputDir = DEFAULT_OUTPUT_DIR,
  fileName,
  xmlOptions = {},
  overrides = {}
} = {}) {
  if (!venta) {
    throw new Error('Debe proporcionar la venta para emitir el Documento Electrónico.');
  }

  const data = buildDocumentoData({ venta, cliente, detalles, emisorParams, overrides });
  const xml = await xmlgen.generateXMLDE(emisorParams, data, xmlOptions);

  let savedFilePath = null;
  if (outputDir) {
    const targetName = fileName || `${data.establecimiento}-${data.punto}-${data.numero}.xml`;
    savedFilePath = path.join(outputDir, targetName);
    await fs.mkdir(path.dirname(savedFilePath), { recursive: true });
    await fs.writeFile(savedFilePath, xml, 'utf8');
  }

  return {
    xml,
    data,
    params: emisorParams,
    filePath: savedFilePath
  };
}

module.exports = {
  generateFacturaElectronicaXML,
  buildDocumentoData,
  buildItemsPayload,
  buildClientePayload,
  splitMontoConIva,
  toNumber
};
