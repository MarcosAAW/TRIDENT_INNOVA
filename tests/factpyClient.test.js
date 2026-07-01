describe('FactPy client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  test('rechaza respuestas HTML durante la emision', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn().mockReturnValue('text/html; charset=utf-8')
      },
      text: jest.fn().mockResolvedValue('<!DOCTYPE html><html><body>login</body></html>')
    });

    const { emitirFactura } = require('../src/services/factpy/client');

    await expect(
      emitirFactura({ dataJson: { total: 1 }, recordID: 'RID-1', baseUrl: 'https://factpy.test' })
    ).rejects.toThrow(/devolvió html/i);
  });

  test('acepta respuestas JSON validas durante la emision', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn().mockReturnValue('application/json; charset=utf-8')
      },
      text: jest.fn().mockResolvedValue('{"status":true,"receiptid":"RID-1"}')
    });

    const { emitirFactura } = require('../src/services/factpy/client');

    await expect(
      emitirFactura({ dataJson: { total: 1 }, recordID: 'RID-1', baseUrl: 'https://factpy.test' })
    ).resolves.toMatchObject({ status: true, receiptid: 'RID-1' });
  });
});