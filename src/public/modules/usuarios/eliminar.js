import { request } from '../common/api.js';

export async function deleteUsuario(id) {
  if (!id) {
    throw new Error('Seleccioná un usuario válido.');
  }

  return request(`/usuarios/${id}`, {
    method: 'DELETE'
  });
}
