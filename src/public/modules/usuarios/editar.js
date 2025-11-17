import { request } from '../common/api.js';

export async function updateUsuario(id, data) {
  if (!id) {
    throw new Error('No se encontró el identificador del usuario.');
  }

  if (!data) {
    throw new Error('Datos incompletos para actualizar.');
  }

  const payload = {
    nombre: data.nombre,
    usuario: data.usuario,
    rol: data.rol,
    activo: data.activo
  };

  if (data.password) {
    if (data.password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres.');
    }
    payload.password = data.password;
  }

  return request(`/usuarios/${id}`, {
    method: 'PUT',
    body: payload
  });
}
