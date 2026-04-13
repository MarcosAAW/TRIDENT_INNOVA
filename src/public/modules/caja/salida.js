import { request } from '../common/api.js';
import { loadSession } from '../auth/session.js';

function parseNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('El monto debe ser mayor a cero.');
  }
  return Number(num.toFixed(2));
}

export async function crearSalidaCaja(initialData = {}) {
  const session = loadSession();
  if (!session || !session.id) {
    throw new Error('Volvé a iniciar sesión para registrar salidas.');
  }

  const descripcion = initialData.descripcion;
  if (!descripcion || !descripcion.trim()) {
    throw new Error('La descripción es obligatoria.');
  }

  const montoInput = initialData.monto;
  if (montoInput === undefined || montoInput === null || montoInput === '') {
    throw new Error('El monto es obligatorio.');
  }

  const monto = parseNumber(montoInput);
  const observacion = initialData.observacion ?? undefined;

  return request('/salidas-caja', {
    method: 'POST',
    body: {
      usuarioId: session.id,
      descripcion: descripcion.trim(),
      monto,
      observacion: observacion ? observacion.trim() || undefined : undefined,
      cierreId: initialData.cierreId
    }
  });
}
