const { baseUrl: DEFAULT_BASE_URL, recordId: DEFAULT_RECORD_ID, timeoutMs: DEFAULT_TIMEOUT_MS } = require('../../config/factpy');

const FACTPY_DEBUG = ['1', 'true', 'yes'].includes(String(process.env.FACTPY_DEBUG || '').toLowerCase());

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

function createMultipartFormData(fields = {}) {
  const LegacyFormData = require('form-data');
  const form = new LegacyFormData();
  Object.entries(fields).forEach(([key, value]) => {
    form.append(key, value);
  });
  return { body: form, headers: form.getHeaders() };
}

function isHtmlResponse(text = '', contentType = '') {
  const normalizedType = String(contentType || '').toLowerCase();
  const normalizedText = String(text || '').trim().toLowerCase();
  if (normalizedType.includes('text/html')) return true;
  return normalizedText.startsWith('<!doctype html') || normalizedText.startsWith('<html');
}

function parseFactPySuccessResponse(response, text, operation) {
  const parsed = parseJsonSafe(text);
  const contentType = response?.headers?.get?.('content-type') || '';

  if (isHtmlResponse(text, contentType)) {
    const error = new Error(`FactPy ${operation} devolvió HTML en lugar de JSON.`);
    error.status = response?.status || 502;
    error.body = text;
    throw error;
  }

  return parsed ?? text;
}

async function emitirFactura({ dataJson, recordID, baseUrl, timeoutMs } = {}) {
  const rid = resolveRecordId(recordID);
  const payloadString = toJsonString(dataJson);
  if (FACTPY_DEBUG) {
    console.log('[FactPy] Enviando dataJson:', payloadString);
  }

  const url = `${resolveBaseUrl(baseUrl)}/data.php`;

  const multipart = createMultipartFormData({
    recordID: rid,
    dataJson: payloadString
  });

  const response = await httpFetch(url, {
    method: 'POST',
    headers: multipart.headers,
    body: multipart.body,
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error('FactPy emisión falló');
    error.status = response.status;
    error.body = parseJsonSafe(text) || text;
    throw error;
  }

  return parseFactPySuccessResponse(response, text, 'emisión');
}

async function consultarEstados({ receiptIds, recordID, baseUrl, timeoutMs } = {}) {
  if (!Array.isArray(receiptIds) || receiptIds.length === 0) {
    throw new Error('receiptIds es requerido y debe ser un array con al menos un elemento.');
  }

  const rid = resolveRecordId(recordID);
  const payload = { receiptid: receiptIds };
  const multipart = createMultipartFormData({
    receiptid: JSON.stringify(payload),
    recordID: rid
  });

  const url = `${resolveBaseUrl(baseUrl)}/estadoDE.php`;
  const response = await httpFetch(url, {
    method: 'POST',
    headers: multipart.headers,
    body: multipart.body,
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error('FactPy consulta de estados falló');
    error.status = response.status;
    error.body = parseJsonSafe(text) || text;
    throw error;
  }

  return parseFactPySuccessResponse(response, text, 'consulta de estados');
}

module.exports = {
  emitirFactura,
  consultarEstados
};
