export async function request(url, options = {}) {
  const config = {
    headers: {
      Accept: 'application/json',
      ...(options.headers || {})
    },
    ...options
  };

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
