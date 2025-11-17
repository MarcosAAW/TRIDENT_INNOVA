import { request } from '../common/api.js';

export async function deleteCliente(id) {
  if (!id) throw new Error('Identificador de cliente requerido.');
  return request(`/clientes/${id}`, { method: 'DELETE' });
}
