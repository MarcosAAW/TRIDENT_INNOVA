import { request } from '../common/api.js';

export async function deleteProveedor(id) {
  return request(`/proveedores/${encodeURIComponent(id)}`, { method: 'DELETE' });
}