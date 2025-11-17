import { request } from '../common/api.js';
import { loadSession } from '../auth/session.js';

function getSessionOrThrow() {
  const session = loadSession();
  if (!session || !session.id) {
    throw new Error('Volvé a iniciar sesión para continuar.');
  }
  return session;
}

function parseDecimalInput(value, { allowEmpty = true, min = undefined, message } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowEmpty) return undefined;
    throw new Error(message || 'Ingresa un valor numérico.');
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(message || 'Ingresa un valor numérico válido.');
  }
  if (min !== undefined && num < min) {
    throw new Error(message || `El valor debe ser mayor o igual a ${min}.`);
  }
  return Number(num.toFixed(2));
}

function toISOString(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Fecha inválida.');
  }
  return date.toISOString();
}

export function prepareCierrePayload(values = {}) {
  const session = getSessionOrThrow();

  const body = {
    usuarioId: session.id
  };

  if (values.fecha_cierre) {
    body.fecha_cierre = toISOString(values.fecha_cierre);
  }

  const declarado = parseDecimalInput(values.efectivo_declarado, {
    allowEmpty: true,
    min: 0,
    message: 'El efectivo declarado debe ser mayor o igual a cero.'
  });
  if (declarado !== undefined) {
    body.efectivo_declarado = declarado;
  }

  if (values.observaciones) {
    const text = String(values.observaciones).trim();
    if (text) {
      body.observaciones = text;
    }
  }

  const tarjeta = parseDecimalInput(values.total_tarjeta, {
    allowEmpty: true,
    min: 0,
    message: 'El monto con tarjeta debe ser mayor o igual a cero.'
  });
  if (tarjeta !== undefined) {
    body.total_tarjeta = tarjeta;
  }

  const transferencia = parseDecimalInput(values.total_transferencia, {
    allowEmpty: true,
    min: 0,
    message: 'El monto por transferencia debe ser mayor o igual a cero.'
  });
  if (transferencia !== undefined) {
    body.total_transferencia = transferencia;
  }

  return body;
}

export async function createCierreCaja(body) {
  return request('/cierres-caja', {
    method: 'POST',
    body
  });
}

export async function fetchEstadoCaja({ fechaHasta } = {}) {
  const session = getSessionOrThrow();
  const params = new URLSearchParams({ usuarioId: session.id });
  if (fechaHasta) {
    params.set('fecha_hasta', toISOString(fechaHasta));
  }

  try {
    return await request(`/cierres-caja/estado?${params.toString()}`);
  } catch (error) {
    if (error.message && /apertura activa/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function crearAperturaCaja({ saldo_inicial, fecha_apertura, observaciones } = {}) {
  const session = getSessionOrThrow();
  const saldoValue = saldo_inicial === undefined || saldo_inicial === null || saldo_inicial === '' ? 0 : saldo_inicial;
  const saldo = parseDecimalInput(saldoValue, {
    allowEmpty: false,
    min: 0,
    message: 'El saldo inicial debe ser mayor o igual a cero.'
  });

  const body = {
    usuarioId: session.id,
    saldo_inicial: saldo
  };

  if (fecha_apertura) {
    body.fecha_apertura = toISOString(fecha_apertura);
  }

  if (observaciones) {
    const text = String(observaciones).trim();
    if (text) {
      body.observaciones = text;
    }
  }

  return request('/cierres-caja/aperturas', {
    method: 'POST',
    body
  });
}
