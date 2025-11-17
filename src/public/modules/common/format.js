const DEFAULT_LOCALE = 'es-PY';

export function formatCurrency(value, currency = 'PYG', options = {}) {
  if (value === null || value === undefined || value === '') return '-';
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return String(value);
  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: currency === 'PYG' ? 0 : 2,
      maximumFractionDigits: currency === 'PYG' ? 0 : 2,
      ...options
    }).format(numericValue);
  } catch (_err) {
    return numericValue.toFixed(currency === 'PYG' ? 0 : 2);
  }
}

export function formatNumber(value, fractionDigits = 2) {
  if (value === null || value === undefined || value === '') return '-';
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return String(value);
  return numericValue.toLocaleString(DEFAULT_LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits
  });
}

export function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(DEFAULT_LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}
