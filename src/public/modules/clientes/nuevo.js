import { request } from '../common/api.js';

export async function createCliente(payload) {
  const body = sanitizeClientePayload(payload);
  return request('/clientes', { method: 'POST', body });
}

export function sanitizeClientePayload(payload) {
  const body = { ...payload };
  ['ruc', 'correo', 'telefono', 'direccion', 'tipo_cliente'].forEach((key) => {
    if (!body[key]) delete body[key];
  });
  return body;
}
