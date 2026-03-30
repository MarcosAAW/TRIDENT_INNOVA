import { request } from '../common/api.js';

export async function deleteNotaPedido(id) {
  return request(`/notas-pedido/${encodeURIComponent(id)}`, { method: 'DELETE' });
}