describe('FactPy client', () => {
  const originalFetch = global.fetch;
  const originalFormData = global.FormData;

  afterEach(() => {
    global.fetch = originalFetch;
    global.FormData = originalFormData;
    jest.resetModules();
  });

  function createFormDataSpy() {
    const fields = [];
    class FakeFormData {
      append(key, value) {
        fields.push([key, value]);
      }
    }
    return { FakeFormData, fields };
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
    const { FakeFormData, fields } = createFormDataSpy();
    global.FormData = FakeFormData;
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

    expect(fields).toEqual([
      ['recordID', 'RID-1'],
      ['dataJson', '{"total":1000,"receiptid":"RID-100"}']
    ]);
  });

  test('consulta estados como multipart con receiptid serializado', async () => {
    const { FakeFormData, fields } = createFormDataSpy();
    global.FormData = FakeFormData;
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

    expect(fields).toEqual([
      ['receiptid', '{"receiptid":["RID-1"]}'],
      ['recordID', 'RID-FACTPY']
    ]);
  });
});