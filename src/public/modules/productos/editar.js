import { request } from '../common/api.js';
import { sanitizeProductoPayload } from './nuevo.js';

export async function updateProducto(id, payload) {
  if (!id) throw new Error('Identificador de producto requerido.');
  const body = sanitizeProductoPayload(payload);
  return request(`/productos/${id}`, { method: 'PUT', body });
}
