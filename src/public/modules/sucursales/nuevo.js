import { request } from '../common/api.js';

export async function createSucursal(payload) {
  return request('/sucursales', {
    method: 'POST',
    body: payload
  });
}
