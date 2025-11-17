import { request } from '../common/api.js';

const DEFAULT_CURRENCY = 'PYG';

export async function createProducto(payload) {
  const body = sanitizeProductoPayload(payload);
  return request('/productos', { method: 'POST', body });
}

export function sanitizeProductoPayload(payload) {
  const body = { ...payload };
  body.activo = body.activo !== undefined ? Boolean(body.activo) : true;

  const parseDecimal = (value, decimals = 2) => {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error('Ingresá un valor numérico válido.');
    }
    return Number(numeric.toFixed(decimals));
  };

  const normalizeMoneda = (value) => {
    if (!value) return DEFAULT_CURRENCY;
    return String(value).trim().toUpperCase();
  };

  const ensurePositive = (value, message) => {
    if (value === undefined || value === null) return undefined;
    if (!(value > 0)) {
      throw new Error(message);
    }
    return value;
  };

  const processPrecio = (precioKey, monedaKey, cambioKey, originalKey, isRequired) => {
    const precio = parseDecimal(body[precioKey]);
    if (precio === undefined) {
      if (isRequired) {
        throw new Error('Ingresá un precio de venta válido.');
      }
      delete body[monedaKey];
      delete body[cambioKey];
      delete body[originalKey];
      delete body[precioKey];
      return;
    }

    if (precio < 0) {
      throw new Error('El precio debe ser mayor o igual a 0.');
    }

    if (isRequired && precio === 0) {
      throw new Error('El precio debe ser mayor a 0.');
    }

    const moneda = normalizeMoneda(body[monedaKey]);
    body[monedaKey] = moneda;

    if (moneda === DEFAULT_CURRENCY) {
      body[precioKey] = precio;
      delete body[cambioKey];
      delete body[originalKey];
      return;
    }

    if (moneda !== 'USD') {
      throw new Error('Por ahora solo soportamos PYG o USD.');
    }

    const tipoCambio = ensurePositive(parseDecimal(body[cambioKey], 4), 'Ingresá un tipo de cambio mayor a 0.');
    if (!tipoCambio) {
      throw new Error('Ingresá un tipo de cambio mayor a 0.');
    }

    body[originalKey] = precio;
    body[cambioKey] = tipoCambio;
    body[precioKey] = precio;
  };

  processPrecio('precio_venta', 'moneda_precio_venta', 'tipo_cambio_precio_venta', 'precio_venta_original', true);
  processPrecio('precio_compra', 'moneda_precio_compra', 'tipo_cambio_precio_compra', 'precio_compra_original', false);

  ['stock_actual', 'minimo_stock'].forEach((key) => {
    if (body[key] === undefined || body[key] === null || body[key] === '') {
      delete body[key];
      return;
    }
    if (!Number.isFinite(body[key])) {
      throw new Error('Los campos de stock deben ser numéricos.');
    }
  });

  if (!body.descripcion) delete body.descripcion;
  if (!body.unidad) delete body.unidad;
  if (!body.codigo_barra) delete body.codigo_barra;
  if (!body.imagen_url) delete body.imagen_url;
  if (!body.categoriaId) delete body.categoriaId;

  return body;
}
