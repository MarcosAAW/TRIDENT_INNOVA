module.exports = {
  baseUrl: process.env.FACTPY_BASE_URL || 'https://api.factpy.com/facturacion-api',
  recordId: process.env.FACTPY_RECORD_ID || '',
  timeoutMs: Number(process.env.FACTPY_TIMEOUT_MS) || 15000
};
