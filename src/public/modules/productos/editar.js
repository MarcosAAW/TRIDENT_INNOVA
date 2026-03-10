import { request } from '../common/api.js';
import { sanitizeProductoPayload, uploadProductoImagen } from './nuevo.js';

export async function updateProducto(id, payload, rawPayload = {}) {
  if (!id) throw new Error('Identificador de producto requerido.');
  const body = sanitizeProductoPayload(payload);
  const updated = await request(`/productos/${id}`, { method: 'PUT', body });
  const file = rawPayload?.imagen_archivo;
  if (file instanceof File && file.size > 0) {
    await uploadProductoImagen(id, file);
  }
  return updated;
}
