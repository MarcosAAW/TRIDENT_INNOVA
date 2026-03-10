const FormData = require('form-data');
const { baseUrl: DEFAULT_BASE_URL, recordId: DEFAULT_RECORD_ID, timeoutMs: DEFAULT_TIMEOUT_MS } = require('../../config/factpy');

const FACTPY_DEBUG = ['1', 'true', 'yes'].includes(String(process.env.FACTPY_DEBUG || '').toLowerCase());
const FACTPY_USE_JSON = ['1', 'true', 'yes'].includes(String(process.env.FACTPY_USE_JSON || '').toLowerCase());

let fetchImpl = globalThis.fetch;

async function httpFetch(url, options = {}) {
  if (typeof fetchImpl !== 'function') {
    const mod = await import('node-fetch');
    fetchImpl = mod.default;
  }

  const { timeout, ...rest } = options;
  if (timeout && typeof AbortController === 'function') {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetchImpl(url, { ...rest, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  }

  return fetchImpl(url, rest);
}

function resolveRecordId(recordID) {
  const value = recordID || DEFAULT_RECORD_ID;
  if (!value) {
    throw new Error('Falta FACTPY_RECORD_ID (configura env o envialo en la peticion).');
  }
  return value;
}

function resolveBaseUrl(baseUrl) {
  return baseUrl || DEFAULT_BASE_URL;
}

function toJsonString(dataJson) {
  if (dataJson === undefined || dataJson === null) {
    throw new Error('dataJson es requerido');
  }
  if (typeof dataJson === 'string') return dataJson;
  return JSON.stringify(dataJson);
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_err) {
    return null;
  }
}

async function emitirFactura({ dataJson, recordID, baseUrl, timeoutMs } = {}) {
  const rid = resolveRecordId(recordID);
  const payloadString = toJsonString(dataJson);
  if (FACTPY_DEBUG) {
    console.log('[FactPy] Enviando dataJson:', payloadString);
  }

  const url = `${resolveBaseUrl(baseUrl)}/data.php`;

  if (FACTPY_USE_JSON) {
    const body = JSON.stringify({ recordID: rid, recordid: rid, dataJson, datajson: dataJson });
    const response = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS
    });

    const text = await response.text();
    const parsed = parseJsonSafe(text);

    if (!response.ok) {
      const error = new Error('FactPy emisión falló');
      error.status = response.status;
      error.body = parsed || text;
      throw error;
    }

    return parsed ?? text;
  }

  const params = new URLSearchParams();
  params.append('recordID', rid);
  params.append('recordid', rid);
  params.append('dataJson', payloadString);
  params.append('datajson', payloadString);

  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS
  });

  const text = await response.text();
  const parsed = parseJsonSafe(text);

  if (!response.ok) {
    const error = new Error('FactPy emisión falló');
    error.status = response.status;
    error.body = parsed || text;
    throw error;
  }

  return parsed ?? text;
}

async function consultarEstados({ receiptIds, recordID, baseUrl, timeoutMs } = {}) {
  if (!Array.isArray(receiptIds) || receiptIds.length === 0) {
    throw new Error('receiptIds es requerido y debe ser un array con al menos un elemento.');
  }

  const payload = { receiptid: receiptIds };
  const params = new URLSearchParams();
  params.append('receiptid', JSON.stringify(payload));
  const rid = resolveRecordId(recordID);
  params.append('recordID', rid);
  params.append('recordid', rid);

  const url = `${resolveBaseUrl(baseUrl)}/estadoDE.php`;
  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS
  });

  const text = await response.text();
  const parsed = parseJsonSafe(text);

  if (!response.ok) {
    const error = new Error('FactPy consulta de estados falló');
    error.status = response.status;
    error.body = parsed || text;
    throw error;
  }

  return parsed ?? text;
}

module.exports = {
  emitirFactura,
  consultarEstados
};
