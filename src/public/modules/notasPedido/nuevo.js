import { request } from '../common/api.js';

export async function createNotaPedido(body) {
  return request('/notas-pedido', { method: 'POST', body });
}

export function buildNotaPedidoPayload(payload) {
  const detalles = parseDetalles(payload.detalles);
  if (!detalles.length) {
    throw new Error('Agregá al menos un ítem a la nota de pedido.');
  }

  const body = {
    proveedorId: String(payload.proveedorId || '').trim(),
    tipo: String(payload.tipo || 'GENERAL').toUpperCase(),
    estado: String(payload.estado || 'BORRADOR').toUpperCase(),
    detalles
  };

  if (!body.proveedorId) {
    throw new Error('Seleccioná un proveedor.');
  }

  if (payload.fecha) {
    body.fecha = payload.fecha;
  }

  const destino = String(payload.equipo_destino || '').trim();
  if (destino) {
    body.equipo_destino = destino;
  }

  const observaciones = String(payload.observaciones || '').trim();
  if (observaciones) {
    body.observaciones = observaciones;
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
        codigo_articulo: item.codigo_articulo ? String(item.codigo_articulo).trim() : undefined,
        descripcion: item.descripcion ? String(item.descripcion).trim() : undefined,
        cantidad: Number.parseInt(item.cantidad, 10),
        equipo_destino: item.equipo_destino ? String(item.equipo_destino).trim() : undefined,
        observacion: item.observacion ? String(item.observacion).trim() : undefined
      }))
      .filter((item) => Number.isInteger(item.cantidad) && item.cantidad > 0)
      .map((item) => {
        if (!item.productoId && !item.codigo_articulo) {
          throw new Error('Cada ítem libre debe tener código.');
        }
        if (!item.productoId && !item.descripcion) {
          throw new Error('Cada ítem libre debe tener descripción.');
        }
        return item;
      });
  } catch (error) {
    console.error('No se pudieron interpretar los detalles de la nota de pedido', error);
    throw new Error('Formato de ítems inválido en la nota de pedido.');
  }
}