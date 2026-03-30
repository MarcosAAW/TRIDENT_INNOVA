import { request } from '../common/api.js';

export async function updateNotaPedido(id, body) {
  return request(`/notas-pedido/${encodeURIComponent(id)}`, { method: 'PUT', body });
}