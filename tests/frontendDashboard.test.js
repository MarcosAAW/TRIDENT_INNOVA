const puppeteer = require('puppeteer');
const fs = require('fs');
const { app, prisma } = require('../src/app');

let browser;
let server;
let baseUrl;
let usuario;
let sucursal;

async function seedCliente(data = {}) {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  return prisma.cliente.create({
    data: {
      nombre_razon_social: data.nombre_razon_social || `Cliente frontend ${unique}`,
      ruc: data.ruc || `800${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}-1`,
      direccion: data.direccion || 'Calle frontend 123',
      correo: data.correo || `cliente_${unique}@test.com`
    }
  });
}

async function seedProducto(data = {}) {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  return prisma.producto.create({
    data: {
      sku: data.sku || `FRONT-USD-${unique}`,
      nombre: data.nombre || `Producto frontend USD ${unique}`,
      tipo: data.tipo || 'REPUESTO',
      precio_venta: data.precio_venta ?? 70000,
      precio_venta_original: data.precio_venta_original ?? 10,
      moneda_precio_venta: data.moneda_precio_venta || 'USD',
      tipo_cambio_precio_venta: data.tipo_cambio_precio_venta ?? 7000,
      stock_actual: data.stock_actual ?? 5,
      sucursalId: data.sucursalId || sucursal.id
    }
  });
}

async function seedProveedor(data = {}) {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  return prisma.proveedor.create({
    data: {
      nombre_razon_social: data.nombre_razon_social || `Proveedor frontend ${unique}`,
      ruc: data.ruc || `801${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}-2`,
      contacto: data.contacto || 'Compras',
      direccion: data.direccion || 'Calle proveedor 123',
      telefono: data.telefono || '0981000000',
      correo: data.correo || `proveedor_${unique}@test.com`
    }
  });
}

async function seedNotaPedido(data = {}) {
  return prisma.notaPedido.create({
    data: {
      numero: data.numero || `NP-${String(Math.floor(Math.random() * 999999)).padStart(6, '0')}`,
      proveedorId: data.proveedorId,
      usuarioId: data.usuarioId || usuario.id,
      sucursalId: data.sucursalId || sucursal.id,
      fecha: data.fecha || new Date('2026-03-30T00:00:00.000Z'),
      estado: data.estado || 'BORRADOR',
      tipo: data.tipo || 'REPUESTOS',
      equipo_destino: data.equipo_destino || 'Dron T40',
      observaciones: data.observaciones || 'Nota de pedido de prueba',
      detalles: {
        create: data.detalles || [
          {
            productoId: data.productoId || null,
            codigo_articulo: data.codigo_articulo || 'COD-FRONT-001',
            codigo_dji: data.codigo_dji || null,
            sku: data.sku || null,
            descripcion: data.descripcion || 'Ítem de prueba frontend',
            cantidad: data.cantidad || 2,
            equipo_destino: data.detalle_equipo_destino || data.equipo_destino || 'Dron T40',
            observacion: data.detalle_observacion || 'Cambio preventivo'
          }
        ]
      }
    },
    include: {
      proveedor: true,
      detalles: true
    }
  });
}

function resolveBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function cleanDatabase() {
  await prisma.reciboDetalle?.deleteMany?.();
  await prisma.recibo?.deleteMany?.();
  await prisma.pago?.deleteMany?.();
  await prisma.notaCreditoDetalle?.deleteMany?.();
  await prisma.notaCreditoElectronica?.deleteMany?.();
  await prisma.facturaDigital?.deleteMany?.();
  await prisma.facturaElectronica?.deleteMany?.();
  await prisma.detalleVenta?.deleteMany?.();
  await prisma.venta?.deleteMany?.();
  await prisma.detallePresupuesto?.deleteMany?.();
  await prisma.presupuesto?.deleteMany?.();
  await prisma.movimientoStock?.deleteMany?.();
  await prisma.detalleNotaPedido?.deleteMany?.();
  await prisma.notaPedido?.deleteMany?.();
  await prisma.detalleCompra?.deleteMany?.();
  await prisma.compra?.deleteMany?.();
  await prisma.salidaCaja?.deleteMany?.();
  await prisma.cierreCaja?.deleteMany?.();
  await prisma.aperturaCaja?.deleteMany?.();
  await prisma.cliente?.deleteMany?.();
  await prisma.productoStock?.deleteMany?.();
  await prisma.producto?.deleteMany?.();
  await prisma.proveedor?.deleteMany?.();
  await prisma.categoria?.deleteMany?.();
  await prisma.usuarioSucursal?.deleteMany?.();
  await prisma.usuario?.deleteMany?.();
  await prisma.sucursal?.deleteMany?.();
}

async function seedSessionContext() {
  const unique = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  sucursal = await prisma.sucursal.create({
    data: {
      nombre: `Sucursal frontend ${unique}`,
      ciudad: 'Asuncion'
    }
  });

  usuario = await prisma.usuario.create({
    data: {
      nombre: 'Admin frontend',
      usuario: `admin_frontend_${unique}`,
      password_hash: 'hash',
      rol: 'ADMIN'
    }
  });

  await prisma.usuarioSucursal.create({
    data: {
      usuarioId: usuario.id,
      sucursalId: sucursal.id,
      rol: 'ADMIN'
    }
  });
}

function sessionEnvelope() {
  const now = Date.now();
  return {
    version: 1,
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      usuario: usuario.usuario,
      rol: usuario.rol,
      sucursalId: sucursal.id,
      sucursales: [{ sucursalId: sucursal.id, nombre: sucursal.nombre, rol: 'ADMIN' }]
    },
    createdAt: now,
    lastActivity: now,
    idleExpiresAt: now + 30 * 60 * 1000,
    absoluteExpiresAt: now + 12 * 60 * 60 * 1000
  };
}

async function newPageWithSession({ delayProveedoresMs = 0, delayNextSkuTipo = null, delayNextSkuMs = 0 } = {}) {
  const page = await browser.newPage();
  const envelope = sessionEnvelope();

  await page.evaluateOnNewDocument((storedEnvelope, sucursalId, delayMs, skuTipo, skuDelayMs) => {
    const storageKey = 'trident_innova_usuario_activo';
    const sucursalKey = 'sucursalId';
    localStorage.setItem(storageKey, JSON.stringify(storedEnvelope));
    localStorage.setItem(sucursalKey, sucursalId);

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const requestUrl = String(args[0] || '');
      if (delayMs > 0 && requestUrl.includes('/proveedores')) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (skuDelayMs > 0 && skuTipo && requestUrl.includes('/productos/next-sku') && requestUrl.includes(`tipo=${encodeURIComponent(skuTipo)}`)) {
        await new Promise((resolve) => setTimeout(resolve, skuDelayMs));
      }
      return originalFetch(...args);
    };
  }, envelope, sucursal.id, delayProveedoresMs, delayNextSkuTipo, delayNextSkuMs);

  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.entity-tabs');
  return page;
}

async function clickTab(page, label) {
  await page.evaluate((tabLabel) => {
    const tabs = Array.from(document.querySelectorAll('.tab-button'));
    const target = tabs.find((tab) => tab.textContent.trim() === tabLabel);
    if (!target) {
      throw new Error(`No se encontró la pestaña ${tabLabel}`);
    }
    target.click();
  }, label);
}

async function tableHeaders(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#records-table thead th')).map((node) => node.textContent.trim()));
}

describe('Frontend dashboard modules', () => {
  beforeAll(async () => {
    await prisma.$connect();
    await cleanDatabase();
    await seedSessionContext();

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const executablePath = resolveBrowserExecutable();
    if (!executablePath) {
      throw new Error('No se encontró un navegador Chrome/Edge para ejecutar las pruebas de frontend.');
    }

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await cleanDatabase();
    await prisma.$disconnect();
  });

  test('presupuestos ignora la respuesta tardía de proveedores y mantiene sus columnas', async () => {
    const page = await newPageWithSession({ delayProveedoresMs: 400 });

    await clickTab(page, 'Proveedores');
    await clickTab(page, 'Presupuestos');

    await page.waitForFunction(() => {
      const active = document.querySelector('.tab-button.active');
      const headers = Array.from(document.querySelectorAll('#records-table thead th')).map((node) => node.textContent.trim());
      return active?.textContent.trim() === 'Presupuestos' && headers.includes('Número') && headers.includes('Cliente');
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const headers = await tableHeaders(page);
    expect(headers).toEqual(expect.arrayContaining(['Número', 'Cliente', 'Fecha', 'Validez']));
    expect(headers).not.toEqual(expect.arrayContaining(['Nombre', 'RUC', 'Contacto', 'Correo']));

    await page.close();
  });

  test('mantiene el scroll de la ventana al avanzar y retroceder paginas en el listado', async () => {
    const productos = Array.from({ length: 24 }, (_, index) => seedProducto({
      sku: `FRONT-PAG-${String(index + 1).padStart(3, '0')}`,
      nombre: `Producto paginado ${index + 1}`,
      stock_actual: 10 + index
    }));
    await Promise.all(productos);

    const page = await newPageWithSession();
    await page.setViewport({ width: 1280, height: 620 });

    await clickTab(page, 'Productos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Productos');
    await page.waitForFunction(() => {
      const pager = document.getElementById('pagination');
      return pager && pager.textContent.includes('Página 1 de');
    });

    await page.evaluate(() => {
      window.scrollTo({ top: 540, behavior: 'auto' });
    });

    await page.waitForFunction(() => window.scrollY >= 500);
    const before = await page.evaluate(() => ({
      scrollY: window.scrollY,
      paginationTop: document.getElementById('pagination')?.getBoundingClientRect().top ?? null
    }));

    const clickPageButton = async (pageNumber) => {
      await page.evaluate((targetPage) => {
        const button = document.querySelector(`#pagination button[data-page="${targetPage}"]`);
        if (!button) {
          throw new Error(`No se encontró el botón de la página ${targetPage}.`);
        }
        button.click();
      }, pageNumber);
      await page.waitForFunction((targetPage) => (
        document.querySelector('#pagination button[aria-current="page"]')?.textContent.trim() === String(targetPage)
      ), {}, pageNumber);
      await new Promise((resolve) => setTimeout(resolve, 140));
    };

    await clickPageButton(2);
    const afterForward = await page.evaluate(() => ({
      scrollY: window.scrollY,
      paginationTop: document.getElementById('pagination')?.getBoundingClientRect().top ?? null
    }));

    await clickPageButton(3);
    const beforeBackward = await page.evaluate(() => ({
      scrollY: window.scrollY,
      paginationTop: document.getElementById('pagination')?.getBoundingClientRect().top ?? null
    }));

    await clickPageButton(2);
    const afterBackward = await page.evaluate(() => ({
      scrollY: window.scrollY,
      paginationTop: document.getElementById('pagination')?.getBoundingClientRect().top ?? null
    }));

    expect(before.scrollY).toBeGreaterThan(0);
    expect(Math.abs(afterForward.paginationTop - before.paginationTop)).toBeLessThanOrEqual(24);
    expect(Math.abs(afterBackward.paginationTop - beforeBackward.paginationTop)).toBeLessThanOrEqual(24);

    await page.close();
  });

  test('productos respeta el primer cambio de tipo aunque la sugerencia inicial de SKU llegue tarde', async () => {
    const page = await newPageWithSession({ delayNextSkuTipo: 'DRON', delayNextSkuMs: 500 });

    await clickTab(page, 'Productos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Productos');
    await page.waitForSelector('[name="tipo"]');

    await page.select('[name="tipo"]', 'REPUESTO');

    await page.waitForFunction(() => {
      const sku = document.querySelector('[name="sku"]')?.value || '';
      return sku.startsWith('REP-');
    });

    const state = await page.evaluate(() => ({
      tipo: document.querySelector('[name="tipo"]')?.value || '',
      sku: document.querySelector('[name="sku"]')?.value || ''
    }));

    expect(state.tipo).toBe('REPUESTO');
    expect(state.sku).toMatch(/^REP-\d{3}$/);

    await page.close();
  });

  test('productos vuelve a sugerir SKU correcto al regresar al modulo sin recargar la pagina', async () => {
    const page = await newPageWithSession();

    await clickTab(page, 'Productos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Productos');
    await page.click('#toggle-form-card');
    await page.waitForSelector('#field-productos-tipo');

    await clickTab(page, 'Clientes');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Clientes');

    await clickTab(page, 'Productos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Productos');
    await page.click('#toggle-form-card');
    await page.waitForSelector('#field-productos-tipo');

    await page.select('#field-productos-tipo', 'SERVICIO');
    await page.waitForFunction(() => {
      const sku = document.querySelector('#field-productos-sku')?.value || '';
      return sku.startsWith('SERV-');
    });

    const state = await page.evaluate(() => ({
      tipo: document.querySelector('#field-productos-tipo')?.value || '',
      sku: document.querySelector('#field-productos-sku')?.value || ''
    }));

    expect(state.tipo).toBe('SERVICIO');
    expect(state.sku).toMatch(/^SERV-\d{3}$/);

    await page.close();
  });

  test('presupuestos oculta la lista cuando se abre el formulario', async () => {
    const page = await newPageWithSession();

    await clickTab(page, 'Presupuestos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Presupuestos');

    await page.click('#toggle-form-card');
    await page.waitForFunction(() => {
      const panel = document.querySelector('.panel-body');
      const listCard = document.querySelector('.list-card');
      const toggle = document.getElementById('toggle-form-card');
      const toggleText = toggle?.textContent || '';
      return panel?.classList.contains('form-focus-mode')
        && listCard?.style.display === 'none'
        && (toggleText.includes('Ocultar') || toggleText.includes('Volver a la lista'));
    });

    const state = await page.evaluate(() => ({
      title: document.getElementById('form-title')?.textContent.trim(),
      listDisplay: document.querySelector('.list-card')?.style.display || '',
      paginationDisplay: document.getElementById('pagination')?.style.display || '',
      panelClasses: document.querySelector('.panel-body')?.className || ''
    }));

    expect(state.title).toBe('Nuevo presupuesto');
    expect(state.listDisplay).toBe('none');
    expect(state.paginationDisplay).toBe('none');
    expect(state.panelClasses).toContain('form-focus-mode');

    await page.close();
  });

  test('notas de pedido oculta la lista cuando se abre el formulario', async () => {
    const page = await newPageWithSession();

    await clickTab(page, 'Notas de pedido');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Notas de pedido');

    await page.click('#toggle-form-card');
    await page.waitForFunction(() => {
      const listCard = document.querySelector('.list-card');
      const panel = document.querySelector('.panel-body');
      const formTitle = document.getElementById('form-title');
      return formTitle?.textContent.trim() === 'Nuevo nota de pedido'
        && listCard?.style.display === 'none'
        && panel?.classList.contains('nota-pedido-expanded');
    });

    const headers = await tableHeaders(page);
    expect(headers).toEqual(expect.arrayContaining(['Número', 'Proveedor', 'Fecha', 'Tipo']));

    const state = await page.evaluate(() => ({
      listDisplay: document.querySelector('.list-card')?.style.display || '',
      paginationDisplay: document.getElementById('pagination')?.style.display || '',
      panelClasses: document.querySelector('.panel-body')?.className || ''
    }));

    expect(state.listDisplay).toBe('none');
    expect(state.paginationDisplay).toBe('none');
    expect(state.panelClasses).toContain('nota-pedido-expanded');

    await page.close();
  });

  test('presupuestos crea un presupuesto en USD desde la UI sin desbordar el valor guardado', async () => {
    const cliente = await seedCliente({ nombre_razon_social: 'Cliente UI USD' });
    const producto = await seedProducto({
      sku: 'FRONT-USD-PRE',
      nombre: 'Producto UI USD',
      precio_venta: 70000,
      precio_venta_original: 10,
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: 7000,
      stock_actual: 3
    });

    const page = await newPageWithSession();

    await clickTab(page, 'Presupuestos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Presupuestos');
    await page.click('#toggle-form-card');

    await page.waitForSelector('[name="clienteId"]');
    await page.select('[name="clienteId"]', cliente.id);
    await page.select('[name="moneda"]', 'USD');
    await page.type('[name="tipo_cambio"]', '6500');

    const productSearchSelector = '.items-builder__producto';
    await page.click(productSearchSelector);
    await page.type(productSearchSelector, producto.sku);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.suggestion-btn')).some((node) => node.textContent.includes('FRONT-USD-PRE')));
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('.suggestion-btn')).find((node) => node.textContent.includes('FRONT-USD-PRE'));
      if (!button) {
        throw new Error('No se encontró la sugerencia del producto USD.');
      }
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    await page.click('.items-builder button.btn.secondary.small');
    await page.click('#submit-button');

    await page.waitForFunction(() => document.getElementById('feedback')?.textContent.includes('Presupuesto creado correctamente.'));
    await page.waitForFunction(() => document.querySelector('.list-card') && document.querySelector('.list-card').style.display !== 'none');

    const presupuesto = await prisma.presupuesto.findFirst({
      where: { clienteId: cliente.id, moneda: 'USD', sucursalId: sucursal.id },
      orderBy: { created_at: 'desc' }
    });

    expect(presupuesto).toBeTruthy();
    expect(Number(presupuesto.total)).toBeCloseTo(65000, 2);
    expect(Number(presupuesto.total_moneda)).toBeCloseTo(10, 2);

    await page.close();
  });

  test('presupuestos recalcula a USD usando el valor original del producto cuando cambia la moneda luego de agregar el item', async () => {
    const cliente = await seedCliente({ nombre_razon_social: 'Cliente UI USD Reprice' });
    const producto = await seedProducto({
      sku: 'FRONT-USD-REPRICE',
      nombre: 'Producto UI USD Reprice',
      precio_venta: 70000,
      precio_venta_original: 10,
      moneda_precio_venta: 'USD',
      tipo_cambio_precio_venta: 7000,
      stock_actual: 4
    });

    const page = await newPageWithSession();

    await clickTab(page, 'Presupuestos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Presupuestos');
    await page.click('#toggle-form-card');

    await page.waitForSelector('[name="clienteId"]');
    await page.select('[name="clienteId"]', cliente.id);

    const productSearchSelector = '.items-builder__producto';
    await page.click(productSearchSelector);
    await page.type(productSearchSelector, producto.sku);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.suggestion-btn')).some((node) => node.textContent.includes('FRONT-USD-REPRICE')));
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('.suggestion-btn')).find((node) => node.textContent.includes('FRONT-USD-REPRICE'));
      if (!button) {
        throw new Error('No se encontró la sugerencia del producto USD reprice.');
      }
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    await page.$eval('.items-builder__cantidad', (input) => {
      input.value = '2';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('.items-builder button.btn.secondary.small');

    await page.select('[name="moneda"]', 'USD');
    await page.type('[name="tipo_cambio"]', '6500');

    await page.waitForFunction(() => document.querySelector('.items-list')?.textContent.includes('USD 10,00') || document.querySelector('.items-list')?.textContent.includes('USD 10,00'));

    await page.click('#submit-button');
    await page.waitForFunction(() => document.getElementById('feedback')?.textContent.includes('Presupuesto creado correctamente.'));

    const presupuesto = await prisma.presupuesto.findFirst({
      where: { clienteId: cliente.id, moneda: 'USD', sucursalId: sucursal.id },
      orderBy: { created_at: 'desc' },
      include: { detalles: true }
    });

    expect(presupuesto).toBeTruthy();
    expect(Number(presupuesto.total)).toBeCloseTo(130000, 2);
    expect(Number(presupuesto.total_moneda)).toBeCloseTo(20, 2);
    expect(Number(presupuesto.detalles[0].precio_unitario)).toBeCloseTo(65000, 2);

    await page.close();
  });

  test('presupuestos restaura la lista al cerrar el formulario', async () => {
    const page = await newPageWithSession();

    await clickTab(page, 'Presupuestos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Presupuestos');

    await page.click('#toggle-form-card');
    await page.waitForFunction(() => document.querySelector('.panel-body')?.classList.contains('form-focus-mode'));

    await page.click('#toggle-form-card');
    await page.waitForFunction(() => {
      const listCard = document.querySelector('.list-card');
      const panel = document.querySelector('.panel-body');
      const toggle = document.getElementById('toggle-form-card');
      return listCard?.style.display !== 'none'
        && !panel?.classList.contains('form-focus-mode')
        && toggle?.textContent.includes('Nuevo presupuesto');
    });

    const headers = await tableHeaders(page);
    expect(headers).toEqual(expect.arrayContaining(['Número', 'Cliente', 'Fecha', 'Validez']));

    await page.close();
  });

  test('presupuestos usa todo el ancho del panel cuando el formulario esta oculto', async () => {
    const page = await newPageWithSession();

    await clickTab(page, 'Presupuestos');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Presupuestos');

    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.panel-body');
      const listCard = document.querySelector('.list-card');
      if (!panel || !listCard) {
        throw new Error('No se encontró el panel de presupuestos.');
      }
      const panelRect = panel.getBoundingClientRect();
      const listRect = listCard.getBoundingClientRect();
      return {
        classes: panel.className,
        gridTemplateColumns: getComputedStyle(panel).gridTemplateColumns,
        leftOffset: Math.round(listRect.left - panelRect.left),
        widthDelta: Math.round(panelRect.width - listRect.width)
      };
    });

    expect(layout.classes).toContain('is-form-collapsed');
    expect(layout.gridTemplateColumns).not.toMatch(/\b4(2|3)0px\b/);
    expect(layout.leftOffset).toBeLessThanOrEqual(2);
    expect(layout.widthDelta).toBeLessThan(8);

    await page.close();
  });

  test('notas de pedido carga el formulario de edición con los datos del registro', async () => {
    const proveedor = await seedProveedor({ nombre_razon_social: 'Proveedor UI Editar' });
    const producto = await seedProducto({
      sku: 'NOTA-EDIT-001',
      nombre: 'Repuesto nota editar',
      tipo: 'REPUESTO',
      moneda_precio_venta: 'PYG',
      precio_venta_original: null,
      tipo_cambio_precio_venta: null
    });
    const nota = await seedNotaPedido({
      proveedorId: proveedor.id,
      productoId: producto.id,
      codigo_articulo: producto.codigo_dji || producto.sku,
      sku: producto.sku,
      descripcion: producto.nombre,
      equipo_destino: 'Drone Agras T40',
      observaciones: 'Editar desde UI',
      cantidad: 3
    });

    const page = await newPageWithSession();

    await clickTab(page, 'Notas de pedido');
    await page.waitForFunction(() => document.querySelector('.tab-button.active')?.textContent.trim() === 'Notas de pedido');
    await page.waitForFunction((numero) => document.body.innerText.includes(numero), {}, nota.numero);

    await page.evaluate((numero) => {
      const row = Array.from(document.querySelectorAll('#records-table tbody tr')).find((node) => node.textContent.includes(numero));
      if (!row) {
        throw new Error(`No se encontró la fila ${numero}`);
      }
      const button = row.querySelector('button[data-action="edit"]');
      if (!button) {
        throw new Error('No se encontró el botón Editar de la nota de pedido.');
      }
      button.click();
    }, nota.numero);

    await page.waitForFunction(() => {
      const formTitle = document.getElementById('form-title');
      const listCard = document.querySelector('.list-card');
      return formTitle?.textContent.trim() === 'Editar nota de pedido' && listCard?.style.display === 'none';
    });

    await page.waitForFunction((proveedorNombre) => {
      const proveedorInput = document.querySelector('.cliente-search__input');
      return proveedorInput && proveedorInput.value.includes(proveedorNombre);
    }, {}, proveedor.nombre_razon_social);

    const formState = await page.evaluate(() => ({
      title: document.getElementById('form-title')?.textContent.trim(),
      proveedorTexto: document.querySelector('.cliente-search__input')?.value || '',
      equipoDestino: document.querySelector('[name="equipo_destino"]')?.value || '',
      observaciones: document.querySelector('[name="observaciones"]')?.value || '',
      submitLabel: document.getElementById('submit-button')?.textContent.trim(),
      panelClasses: document.querySelector('.panel-body')?.className || ''
    }));

    expect(formState.title).toBe('Editar nota de pedido');
    expect(formState.proveedorTexto).toContain('Proveedor UI Editar');
    expect(formState.equipoDestino).toBe('Drone Agras T40');
    expect(formState.observaciones).toBe('Editar desde UI');
    expect(formState.submitLabel).toBe('Actualizar');
    expect(formState.panelClasses).toContain('nota-pedido-expanded');

    await page.close();
  });
});