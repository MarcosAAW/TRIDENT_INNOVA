import { request } from '../common/api.js';

export async function updateSucursal(id, payload) {
  return request(`/sucursales/${id}`, {
    method: 'PUT',
    body: payload
  });
}
