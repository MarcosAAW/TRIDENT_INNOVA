function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeCurrency(value, defaultValue = 'PYG') {
  if (!value) return defaultValue;
  return String(value).trim().toUpperCase();
}

export function resolveProductUnitPricing(producto, { targetCurrency = 'PYG', exchangeRate = null } = {}) {
  const monedaObjetivo = normalizeCurrency(targetCurrency, 'PYG');
  const monedaProducto = normalizeCurrency(producto?.moneda_precio_venta, 'PYG');
  const precioGs = round(producto?.precio_venta, 2);
  const precioUsdOriginalRaw = Number(producto?.precio_venta_original);
  const precioUsdOriginal = Number.isFinite(precioUsdOriginalRaw) && precioUsdOriginalRaw >= 0
    ? round(precioUsdOriginalRaw, 2)
    : null;
  const tipoCambio = Number(exchangeRate);
  const hasTipoCambio = Number.isFinite(tipoCambio) && tipoCambio > 0;

  if (!Number.isFinite(precioGs) || precioGs < 0) {
    throw new Error('El producto no tiene un precio de venta valido.');
  }

  if (monedaObjetivo !== 'USD') {
    return {
      unitGs: precioGs,
      unitCurrency: precioGs,
      currency: 'PYG',
      sourceCurrency: monedaProducto,
      usedOriginalUsd: false
    };
  }

  if (!hasTipoCambio) {
    throw new Error('Ingresa un tipo de cambio valido para operar en USD.');
  }

  if (monedaProducto === 'USD' && precioUsdOriginal !== null) {
    return {
      unitGs: round(precioUsdOriginal * tipoCambio, 2),
      unitCurrency: precioUsdOriginal,
      currency: 'USD',
      sourceCurrency: 'USD',
      usedOriginalUsd: true
    };
  }

  return {
    unitGs: precioGs,
    unitCurrency: round(precioGs / tipoCambio, 2),
    currency: 'USD',
    sourceCurrency: monedaProducto,
    usedOriginalUsd: false
  };
}
