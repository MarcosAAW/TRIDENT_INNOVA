describe('FactPy client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  function mockLegacyFormData() {
    const fields = [];
    jest.doMock('form-data', () => {
      return class FakeLegacyFormData {
        append(key, value) {
          fields.push([key, value]);
        }

        getHeaders() {
          return { 'content-type': 'multipart/form-data; boundary=----copilot-test' };
        }

        getLengthSync() {
          return 123;
        }
      };
    });
    return fields;
  }

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

  test('envia la emision como multipart con dataJson serializado', async () => {
    const fields = mockLegacyFormData();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn().mockReturnValue('application/json; charset=utf-8')
      },
      text: jest.fn().mockResolvedValue('{"status":true}')
    });

    const { emitirFactura } = require('../src/services/factpy/client');

    await emitirFactura({
      dataJson: { total: 1000, receiptid: 'RID-100' },
      recordID: 'RID-1',
      baseUrl: 'https://factpy.test'
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://factpy.test/data.php',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': expect.stringContaining('multipart/form-data; boundary='),
          'Content-Length': '123'
        })
      })
    );
    expect(fields).toEqual([
      ['recordID', 'RID-1'],
      ['dataJson', '{"total":1000,"receiptid":"RID-100"}']
    ]);
  });

  test('consulta estados como multipart con receiptid serializado', async () => {
    const fields = mockLegacyFormData();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: jest.fn().mockReturnValue('application/json; charset=utf-8')
      },
      text: jest.fn().mockResolvedValue('[{"receiptid":"RID-1","estado":"Aprobado"}]')
    });

    const { consultarEstados } = require('../src/services/factpy/client');

    await expect(
      consultarEstados({ receiptIds: ['RID-1'], recordID: 'RID-FACTPY', baseUrl: 'https://factpy.test' })
    ).resolves.toEqual([{ receiptid: 'RID-1', estado: 'Aprobado' }]);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://factpy.test/estadoDE.php',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': expect.stringContaining('multipart/form-data; boundary='),
          'Content-Length': '123'
        })
      })
    );
    expect(fields).toEqual([
      ['datajson', '{"receiptid":["RID-1"]}'],
      ['recordID', 'RID-FACTPY']
    ]);
  });
});