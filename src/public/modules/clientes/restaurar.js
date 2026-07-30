import { request } from '../common/api.js';

export async function restoreCliente(id) {
  if (!id) throw new Error('Identificador de cliente requerido.');
  return request(`/clientes/${id}/restaurar`, { method: 'PATCH' });
}
