import { request } from '../common/api.js';

export async function deletePresupuesto(id) {
  return request(`/presupuestos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}