import { request } from '../common/api.js';

export async function createProveedor(body) {
  return request('/proveedores', { method: 'POST', body });
}