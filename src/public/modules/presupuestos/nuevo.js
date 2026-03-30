import { request } from '../common/api.js';

export async function createPresupuesto(body) {
  return request('/presupuestos', { method: 'POST', body });
}

export function buildPresupuestoPayload(payload) {
  let detalles = parseDetalles(payload.detalles);
  if (!detalles.length) {
    throw new Error('Agregá al menos un ítem en el campo Detalles (JSON).');
  }

  const body = { detalles };

  const clienteId = String(payload.clienteId || '').trim();
  if (clienteId) {
    body.clienteId = clienteId;
  }

  if (payload.validez_hasta) {
    body.validez_hasta = payload.validez_hasta;
  }

  const moneda = String(payload.moneda || 'PYG').toUpperCase();
  body.moneda = moneda;

  const tipoCambio = toNumber(payload.tipo_cambio);
  if (moneda === 'USD' && (!tipoCambio || tipoCambio <= 0)) {
    throw new Error('Para moneda USD ingresá el tipo de cambio.');
  }
  if (moneda === 'USD' && tipoCambio) {
    body.tipo_cambio = tipoCambio;
    detalles = detalles.map((item) => ({
      ...item,
      precio_unitario: item.moneda_precio_unitario === 'USD' && item.precio_unitario !== undefined && item.precio_unitario !== null
        ? Number((item.precio_unitario * tipoCambio).toFixed(2))
        : item.precio_unitario
    }));
    body.detalles = detalles;
  }

  if (moneda === 'PYG' && detalles.some((item) => item.moneda_precio_unitario === 'USD')) {
    throw new Error('Hay ítems cargados en USD. Volvé a agregarlos en guaraníes antes de guardar el presupuesto.');
  }

  const descuento = toNumber(payload.descuento_total);
  if (descuento && descuento > 0) {
    body.descuento_total = descuento;
  }

  const notas = String(payload.notas || '').trim();
  if (notas) {
    body.notas = notas;
  }

  return body;
}

function parseDetalles(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        productoId: item.productoId ? String(item.productoId).trim() : undefined,
        cantidad: Number.parseInt(item.cantidad, 10),
        precio_unitario: toNumber(item.precio_unitario),
        moneda_precio_unitario: normalizeCurrency(item.moneda_precio_unitario),
        iva_porcentaje: normalizeIva(item.iva_porcentaje)
      }))
      .filter((item) => Number.isInteger(item.cantidad) && item.cantidad > 0)
      .map((item) => {
        if (!item.productoId && (!item.precio_unitario || item.precio_unitario <= 0)) {
          throw new Error('Cada ítem debe tener productoId o precio_unitario.');
        }
        return item;
      });
  } catch (error) {
    console.error('No se pudieron interpretar los detalles de presupuesto', error);
    throw new Error('Formato de detalles inválido: usa un array JSON con cantidad, productoId y precio_unitario.');
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : undefined;
}

function normalizeIva(raw) {
  const parsed = Number(raw);
  if (parsed === 0 || parsed === 5 || parsed === 10) return parsed;
  return 10;
}

function normalizeCurrency(value) {
  const normalized = String(value || 'PYG').trim().toUpperCase();
  return normalized === 'USD' ? 'USD' : 'PYG';
}
