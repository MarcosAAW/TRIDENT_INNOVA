import { request } from '../common/api.js';
import { sanitizeClientePayload } from './nuevo.js';

export async function updateCliente(id, payload) {
  if (!id) throw new Error('Identificador de cliente requerido.');
  const body = sanitizeClientePayload(payload);
  return request(`/clientes/${id}`, { method: 'PUT', body });
}
