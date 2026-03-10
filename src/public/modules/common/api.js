import { loadSession } from '../auth/session.js';

export async function request(url, options = {}) {
  const config = {
    headers: {
      Accept: 'application/json',
      ...(options.headers || {})
    },
    ...options
  };

  attachSessionHeaders(config.headers);

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.headers['Content-Type'] = config.headers['Content-Type'] || 'application/json';
    config.body = JSON.stringify(config.body);
  }

  const response = await fetch(url, config);
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_err) {
      payload = text;
    }
  }

  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.error ? payload.error : text || `Error ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export function buildQuery(params) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((v) => searchParams.append(key, v));
      return;
    }
    searchParams.set(key, value);
  });
  return searchParams.toString();
}

function attachSessionHeaders(headers = {}) {
  try {
    const session = loadSession();
    if (session?.id) {
      headers['x-user-id'] = session.id;
    }
    if (session?.rol) {
      headers['x-user-role'] = session.rol;
    }
    const sucursalId = resolveSucursalId(session);
    if (sucursalId) {
      headers['x-sucursal-id'] = sucursalId;
    }
  } catch (error) {
    console.warn('[API] No se pudo adjuntar la sesión al request.', error);
  }
}

function resolveSucursalId(session) {
  try {
    const fromSession = session?.sucursalId;
    const fromQuery = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('sucursalId') : null;
    if (fromQuery && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem('sucursalId', fromQuery);
    }
    const fromStorage = typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem('sucursalId') : null;
    return fromQuery || fromStorage || fromSession || null;
  } catch (err) {
    console.warn('[API] No se pudo resolver sucursalId.', err);
    return null;
  }
}

export function urlWithSession(url) {
  try {
    const session = loadSession();
    if (!session?.id) return url;
    const base = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost';
    const u = new URL(url, base);
    u.searchParams.set('uid', session.id);
    const sucursalId = resolveSucursalId(session);
    if (sucursalId) {
      u.searchParams.set('sucursalId', sucursalId);
    }
    return u.pathname + u.search + u.hash;
  } catch (error) {
    console.warn('[API] No se pudo adjuntar la sesión a la URL.', error);
    return url;
  }
}
