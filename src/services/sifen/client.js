let fetchImpl = globalThis.fetch;

async function httpFetch(...args) {
  if (typeof fetchImpl !== 'function') {
    const mod = await import('node-fetch');
    fetchImpl = mod.default;
  }
  return fetchImpl(...args);
}

const DEFAULT_ENDPOINTS = {
  certificacion: {
    recepcion: process.env.SIFEN_ENDPOINT_DE_CERT || 'https://sifen.set.gov.py/de/ws/deRecepcionDE.php',
    consulta: process.env.SIFEN_ENDPOINT_CONSULTA_CERT || 'https://sifen.set.gov.py/de/ws/consultasDE.php'
  },
  produccion: {
    recepcion: process.env.SIFEN_ENDPOINT_DE_PROD || 'https://sifen.set.gov.py/de/ws/deRecepcionDE.php',
    consulta: process.env.SIFEN_ENDPOINT_CONSULTA_PROD || 'https://sifen.set.gov.py/de/ws/consultasDE.php'
  }
};

function getAmbiente() {
  const value = (process.env.SIFEN_AMBIENTE || 'certificacion').toLowerCase();
  return value === 'produccion' ? 'produccion' : 'certificacion';
}

function getEndpoints(ambiente = getAmbiente()) {
  return DEFAULT_ENDPOINTS[ambiente] || DEFAULT_ENDPOINTS.certificacion;
}

async function sendDocumentoElectronico({ xml, ambiente, headers = {} }) {
  if (!xml) {
    throw new Error('No se recibió el XML firmado para enviar al SIFEN.');
  }
  const endpoints = getEndpoints(ambiente);
  const response = await httpFetch(endpoints.recepcion, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'User-Agent': 'TridentInnova/1.0',
      ...headers
    },
    body: xml
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: text
  };
}

async function consultarEstado({ cdc, ambiente, headers = {} }) {
  if (!cdc) {
    throw new Error('Se requiere el CDC para consultar el estado.');
  }
  const payload = `<ConsultaDe><cdc>${cdc}</cdc></ConsultaDe>`;
  const endpoints = getEndpoints(ambiente);
  const response = await httpFetch(endpoints.consulta, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'User-Agent': 'TridentInnova/1.0',
      ...headers
    },
    body: payload
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: text
  };
}

module.exports = {
  sendDocumentoElectronico,
  consultarEstado,
  getEndpoints,
  getAmbiente
};
