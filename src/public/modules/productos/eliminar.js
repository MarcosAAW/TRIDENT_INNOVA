import { request } from '../common/api.js';

export async function deleteProducto(id) {
  if (!id) throw new Error('Identificador de producto requerido.');
  return request(`/productos/${id}`, { method: 'DELETE' });
}
