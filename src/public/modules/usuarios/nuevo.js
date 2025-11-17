import { request } from '../common/api.js';

export async function createUsuario(data) {
  if (!data?.nombre || !data?.usuario) {
    throw new Error('Completá el nombre y el usuario.');
  }

  if (!data.password) {
    throw new Error('Ingresá una contraseña para crear el usuario.');
  }

  const payload = {
    nombre: data.nombre,
    usuario: data.usuario,
    password: data.password,
    rol: data.rol || 'VENDEDOR',
    activo: data.activo !== undefined ? Boolean(data.activo) : true
  };

  return request('/usuarios', {
    method: 'POST',
    body: payload
  });
}
