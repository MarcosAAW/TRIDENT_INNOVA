// Simple runner to test FactPy without touching the DB
require('dotenv').config();

const { emitirFactura, consultarEstados } = require('../src/services/factpy/client');

// Replace this with a real payload that FactPy espera. Keep it small while testing.
const demoPayload = {
  timbrado: '12345678',
  establecimiento: '001',
  puntoExpedicion: '001',
  tipoEmision: '1',
  moneda: 'PYG',
  cliente: {
    documento: '1234567',
    tipo: '1',
    razonSocial: 'Cliente Demo'
  },
  items: [
    {
      codigo: 'SKU-1',
      descripcion: 'Producto demo',
      cantidad: 1,
      precioUnitario: 10000,
      iva: 10
    }
  ]
};

async function main() {
  const mode = process.argv[2] || 'emitir';
  const timeoutMs = Number(process.env.FACTPY_TIMEOUT_MS) || 20000;

  try {
    if (mode === 'emitir') {
      const res = await emitirFactura({ dataJson: demoPayload, timeoutMs });
      console.log('Emisión OK:', res);
    } else if (mode === 'estado') {
      const receiptId = process.argv[3];
      if (!receiptId) {
        throw new Error('Proporcione receiptId: node scripts/factpy-test.js estado <receiptId>');
      }
      const res = await consultarEstados({ receiptIds: [receiptId], timeoutMs });
      console.log('Estados:', JSON.stringify(res, null, 2));
    } else {
      throw new Error('Modo no reconocido. Use "emitir" o "estado".');
    }
  } catch (err) {
    const status = err.status || 'n/a';
    const body = err.body || err.message;
    console.error('Error:', status, body);
    process.exitCode = 1;
  }
}

main();
