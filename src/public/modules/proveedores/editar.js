import { request } from '../common/api.js';

export async function updateProveedor(id, body) {
  return request(`/proveedores/${encodeURIComponent(id)}`, { method: 'PUT', body });
}