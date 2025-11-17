import { request } from '../common/api.js';

export async function createVenta(body) {
  return request('/ventas', { method: 'POST', body });
}

export function buildVentaPayload(payload) {
  const usuarioId = String(payload.usuarioId || '').trim();
  if (!usuarioId) {
    throw new Error('No se pudo determinar el usuario responsable de la venta. Volvé a iniciar sesión.');
  }

  const detalles = parseDetalles(payload.detalles);
  if (!detalles.length) {
    throw new Error('Agregá al menos un producto a la venta.');
  }

  const iva = parseIva(payload.iva_porcentaje);
  const descuento = toNumber(payload.descuento_total);

  const body = {
    usuarioId,
    iva_porcentaje: iva,
    estado: payload.estado?.trim() || 'PENDIENTE',
    detalles
  };

  const clienteId = String(payload.clienteId || '').trim();
  if (clienteId) {
    body.clienteId = clienteId;
  }

  if (Number.isFinite(descuento) && descuento > 0) {
    body.descuento_total = Number(descuento.toFixed(2));
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
        productoId: String(item.productoId || '').trim(),
        cantidad: Number.parseInt(item.cantidad, 10)
      }))
      .filter((item) => item.productoId && Number.isInteger(item.cantidad) && item.cantidad > 0);
  } catch (error) {
    console.error('No se pudieron interpretar los detalles enviados', error);
    return [];
  }
}

function parseIva(raw) {
  const value = Number(raw);
  return value === 5 ? 5 : 10;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}
