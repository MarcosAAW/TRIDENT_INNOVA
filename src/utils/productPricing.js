function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeCurrency(value, defaultValue = 'PYG') {
  if (!value) return defaultValue;
  return String(value).trim().toUpperCase();
}

function toRoundedOrNull(value, decimals = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return round(numeric, decimals);
}

function resolveProductSalePricing(producto, { targetCurrency = 'PYG', exchangeRate = null } = {}) {
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
    throw new Error('El producto no tiene un precio de venta válido.');
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
    throw new Error('Ingresá un tipo de cambio válido para operar en USD.');
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

function getSaleDetailSnapshot(detalle, venta = null) {
  const currency = normalizeCurrency(detalle?.moneda_precio_unitario || venta?.moneda, 'PYG');
  const quantity = Number(detalle?.cantidad) || 0;
  const unitGs = round(detalle?.precio_unitario, 2);
  const subtotalGs = toRoundedOrNull(detalle?.subtotal, 2) ?? round(quantity * unitGs, 2);
  const exchangeRateRaw = Number(detalle?.tipo_cambio_aplicado ?? venta?.tipo_cambio);
  const hasExchangeRate = Number.isFinite(exchangeRateRaw) && exchangeRateRaw > 0;
  const exchangeRate = hasExchangeRate ? round(exchangeRateRaw, 4) : null;
  const unitCurrencyStored = toRoundedOrNull(detalle?.precio_unitario_moneda, currency === 'USD' ? 4 : 2);
  const subtotalCurrencyStored = toRoundedOrNull(detalle?.subtotal_moneda, currency === 'USD' ? 4 : 2);

  if (currency === 'USD') {
    const unitCurrency = unitCurrencyStored ?? (hasExchangeRate ? round(unitGs / exchangeRateRaw, 4) : null);
    const subtotalCurrency = subtotalCurrencyStored
      ?? (unitCurrency !== null ? round(unitCurrency * quantity, 4) : null);

    return {
      currency,
      quantity,
      unitGs,
      subtotalGs,
      exchangeRate,
      unitCurrency,
      subtotalCurrency
    };
  }

  return {
    currency: 'PYG',
    quantity,
    unitGs,
    subtotalGs,
    exchangeRate,
    unitCurrency: unitCurrencyStored ?? unitGs,
    subtotalCurrency: subtotalCurrencyStored ?? subtotalGs
  };
}

module.exports = {
  round,
  normalizeCurrency,
  resolveProductSalePricing,
  getSaleDetailSnapshot
};