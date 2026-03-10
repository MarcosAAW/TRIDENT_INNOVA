import { request } from '../common/api.js';

export async function deleteSucursal(id) {
  return request(`/sucursales/${id}`, {
    method: 'DELETE'
  });
}
