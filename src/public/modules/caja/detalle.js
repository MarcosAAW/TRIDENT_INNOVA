import { request } from '../common/api.js';

export async function fetchCierreDetalle(id) {
  if (!id) throw new Error('Identificador inválido.');
  return request(`/cierres-caja/${id}`);
}
