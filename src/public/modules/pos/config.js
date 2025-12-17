import { request, buildQuery } from '../common/api.js';
import { formatCurrency, formatNumber, formatDate } from '../common/format.js';
import { loadSession } from '../auth/session.js';

const IVA_OPTIONS = [
  { value: 10, label: 'IVA 10%' },
  { value: 5, label: 'IVA 5%' }
];

const IVA_DIVISOR = {
  10: 11,
  5: 21
};

const posState = {
  cliente: null,
  cart: [],
  descuento: 0,
  ivaPorcentaje: 10,
  moneda: 'PYG',
  tipoCambio: null,
  lastSale: null,
  loading: false,
  productSearch: {
    term: '',
    loading: false,
    results: []
  },
  clientSearch: {
    term: '',
    loading: false,
    results: []
  }
};

let posDom = null;
let productSearchTimer = null;
let clientSearchTimer = null;
let productSearchToken = 0;
let clientSearchToken = 0;
let globalKeydownHandler = null;

function ensureDom(container) {
  if (posDom && posDom.root === container) {
    return;
  }

  container.innerHTML = `
    <div class="pos-layout" id="pos-root">
      <section class="pos-column pos-cart">
        <header class="pos-cart-header">
          <h3>Venta rápida</h3>
          <p>Selecciona un cliente, agrega productos al carrito y confirma la venta.</p>
        </header>
        <div class="pos-client">
          <label for="pos-client-search">Cliente</label>
          <div class="pos-client-selector">
            <div class="pos-client-selected" id="pos-client-selected">
              <span class="placeholder">Cliente eventual</span>
            </div>
            <button type="button" class="btn ghost small" id="pos-client-clear" hidden>Quitar cliente</button>
          </div>
          <div class="pos-client-search">
            <input type="search" id="pos-client-search" placeholder="Buscar por nombre o RUC" autocomplete="off">
            <div class="pos-search-results" id="pos-client-results"></div>
          </div>
        </div>
        <div class="pos-cart-list" id="pos-cart-list">
          <p class="empty">Agrega productos para iniciar la venta.</p>
        </div>
        <div class="pos-summary">
          <div class="pos-summary-row">
            <label for="pos-discount">Descuento (Gs.)</label>
            <input type="number" id="pos-discount" min="0" step="1000" placeholder="0">
          </div>
          <div class="pos-summary-row">
            <label for="pos-iva">IVA aplicado</label>
            <select id="pos-iva">
              ${IVA_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
            </select>
          </div>
          <div class="pos-summary-row">
            <label for="pos-currency">Moneda de cobro</label>
            <select id="pos-currency">
              <option value="PYG">Guaraníes (PYG)</option>
              <option value="USD">Dólares (USD)</option>
            </select>
          </div>
          <div class="pos-summary-row" id="pos-exchange-row" hidden>
            <label for="pos-exchange">Tipo de cambio</label>
            <input type="number" id="pos-exchange" min="0" step="0.0001" placeholder="0.0000">
          </div>
          <div class="pos-summary-totals" id="pos-summary-totals"></div>
        </div>
        <div class="pos-actions">
          <button type="button" class="btn primary" id="pos-confirm">Confirmar venta</button>
          <button type="button" class="btn ghost" id="pos-clear">Limpiar</button>
          <button type="button" class="btn ghost" id="pos-print" hidden>Imprimir factura</button>
        </div>
        <div id="pos-feedback" class="feedback"></div>
        <div class="pos-last-sale" id="pos-last-sale" hidden></div>
      </section>
      <section class="pos-column pos-products">
        <label for="pos-product-search">Buscar productos</label>
        <input type="search" id="pos-product-search" placeholder="Escribe nombre, SKU o categoría" autocomplete="off">
        <div class="pos-search-results" id="pos-product-results">
          <p class="empty">Escribe al menos 2 caracteres para buscar.</p>
        </div>
      </section>
    </div>
  `;

  const layout = container.querySelector('#pos-root');
  if (!layout) {
    console.error('[POS] No se pudo inicializar el diseño principal.');
    return;
  }

  posDom = {
    wrapper: container,
    root: layout,
    clientSelected: layout?.querySelector('#pos-client-selected') || null,
    clientClearButton: layout?.querySelector('#pos-client-clear') || null,
    clientSearchInput: layout?.querySelector('#pos-client-search') || null,
    clientResults: layout?.querySelector('#pos-client-results') || null,
    productSearchInput: layout?.querySelector('#pos-product-search') || null,
    productResults: layout?.querySelector('#pos-product-results') || null,
    cartList: layout?.querySelector('#pos-cart-list') || null,
    discountInput: layout?.querySelector('#pos-discount') || null,
    ivaSelect: layout?.querySelector('#pos-iva') || null,
    currencySelect: layout?.querySelector('#pos-currency') || null,
    exchangeRow: layout?.querySelector('#pos-exchange-row') || null,
    exchangeInput: layout?.querySelector('#pos-exchange') || null,
    feedback: layout?.querySelector('#pos-feedback') || null,
    confirmButton: layout?.querySelector('#pos-confirm') || null,
    clearButton: layout?.querySelector('#pos-clear') || null,
    printButton: layout?.querySelector('#pos-print') || null,
    summaryTotals: layout?.querySelector('#pos-summary-totals') || null,
    lastSale: layout?.querySelector('#pos-last-sale') || null
  };

  renderCurrencyControls();
  attachEventListeners();
  attachGlobalShortcuts();

  if (posDom.root && !posDom.root.hasAttribute('tabindex')) {
    posDom.root.setAttribute('tabindex', '-1');
  }
  if (posDom.confirmButton && !posDom.confirmButton.dataset.defaultLabel) {
    posDom.confirmButton.dataset.defaultLabel = posDom.confirmButton.textContent || 'Confirmar venta';
  }
  if (posDom.printButton && !posDom.printButton.dataset.defaultLabel) {
    posDom.printButton.dataset.defaultLabel = posDom.printButton.textContent || 'Imprimir factura';
  }

  focusProductSearch();
  updateActionStates();
}

function attachEventListeners() {
  if (!posDom) return;

  if (posDom.productSearchInput) {
    posDom.productSearchInput.addEventListener('input', (event) => {
      const term = event.target.value.trim();
      posState.productSearch.term = term;
      scheduleProductSearch(term);
    });

    posDom.productSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (posState.productSearch.loading) {
          setFeedback('Espera a que termine la búsqueda.', 'info');
          return;
        }
        const candidate = posState.productSearch.results[0];
        if (candidate) {
          addProductToCart(candidate);
        } else {
          setFeedback('Selecciona un producto de la lista.', 'info');
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clearProductSearch();
      }
    });
  }

  if (posDom.clientSearchInput) {
    posDom.clientSearchInput.addEventListener('input', (event) => {
      const term = event.target.value.trim();
      posState.clientSearch.term = term;
      scheduleClientSearch(term);
    });

    posDom.clientSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (posState.clientSearch.loading) {
          setFeedback('Espera a que termine la búsqueda.', 'info');
          return;
        }
        const candidate = posState.clientSearch.results[0];
        if (candidate) {
          posState.cliente = candidate;
          posState.clientSearch.results = [];
          posDom.clientSearchInput.value = '';
          renderClientSection();
          renderClientResults();
          focusProductSearch();
        } else {
          setFeedback('No hay coincidencias para seleccionar.', 'info');
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clearClientSearch();
      }
    });
  }

  if (posDom.clientResults) {
    posDom.clientResults.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pos-select-client]');
    if (!button) return;
    const clientId = button.dataset.posSelectClient;
    const cliente = posState.clientSearch.results.find((item) => item.id === clientId);
    if (cliente) {
      posState.cliente = cliente;
      posState.clientSearch.results = [];
      posDom.clientSearchInput.value = '';
      renderClientSection();
      renderClientResults();
      focusProductSearch();
    }
  });
  }

  if (posDom.clientClearButton) {
    posDom.clientClearButton.addEventListener('click', () => {
      posState.cliente = null;
      renderClientSection();
    });
  }

  if (posDom.productResults) {
    posDom.productResults.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pos-add-product]');
    if (!button) return;
    const productId = button.dataset.posAddProduct;
    const product = posState.productSearch.results.find((item) => item.id === productId);
    if (product) {
      addProductToCart(product);
    }
  });
  }

  if (posDom.cartList) {
    posDom.cartList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pos-cart-action]');
    if (!button) return;
    const productId = button.dataset.posCartId;
    const action = button.dataset.posCartAction;
    if (action === 'remove') {
      removeProductFromCart(productId);
    }
    if (action === 'increment') {
      adjustCartQuantity(productId, 1);
    }
    if (action === 'decrement') {
      adjustCartQuantity(productId, -1);
    }
  });

    posDom.cartList.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-pos-cart-qty]');
    if (!input) return;
    const productId = input.dataset.posCartId;
    const value = Number(input.value);
    setCartQuantity(productId, value);
  });
  }

  if (posDom.discountInput) {
    posDom.discountInput.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value < 0) {
      posState.descuento = 0;
    } else {
      posState.descuento = value;
    }
    renderSummary();
    });
  }

  if (posDom.ivaSelect) {
    posDom.ivaSelect.addEventListener('change', (event) => {
    const value = Number(event.target.value);
    posState.ivaPorcentaje = IVA_OPTIONS.some((option) => option.value === value) ? value : 10;
    renderSummary();
  });
  }

  if (posDom.currencySelect) {
    posDom.currencySelect.addEventListener('change', (event) => {
      const nextValue = String(event.target.value || 'PYG').toUpperCase();
      posState.moneda = nextValue === 'USD' ? 'USD' : 'PYG';
      if (posState.moneda !== 'USD') {
        posState.tipoCambio = null;
        if (posDom.exchangeInput && document.activeElement !== posDom.exchangeInput) {
          posDom.exchangeInput.value = '';
        }
      }
      renderCurrencyControls();
      renderSummary();
    });
  }

  if (posDom.exchangeInput) {
    posDom.exchangeInput.addEventListener('input', (event) => {
      const numeric = Number(event.target.value);
      if (Number.isFinite(numeric) && numeric > 0) {
        posState.tipoCambio = numeric;
      } else {
        posState.tipoCambio = null;
      }
      renderSummary();
    });
  }

  if (posDom.clearButton) {
    posDom.clearButton.addEventListener('click', () => {
    clearCart();
  });
  }

  if (posDom.confirmButton) {
    posDom.confirmButton.addEventListener('click', async () => {
      await confirmSale();
    });
  }

  if (posDom.printButton) {
    posDom.printButton.addEventListener('click', async () => {
      await generateInvoice();
    });
  }
}

function scheduleProductSearch(term) {
  if (productSearchTimer) {
    clearTimeout(productSearchTimer);
  }
  if (!term || term.length < 2) {
    posState.productSearch.results = [];
    posState.productSearch.loading = false;
    renderProductResults();
    return;
  }
  posState.productSearch.loading = true;
  renderProductResults();
  productSearchTimer = setTimeout(() => {
    fetchProducts(term);
  }, 350);
}

async function fetchProducts(term) {
  const token = ++productSearchToken;
  try {
    const query = buildQuery({
      page: 1,
      pageSize: 12,
      search: term,
      activo: 'true'
    });
    const response = await request(`/productos?${query}`);
    const data = Array.isArray(response?.data) ? response.data : [];
    const mapped = data.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      sku: item.sku,
      precio_venta: Number(item.precio_venta) || 0,
      stock_actual: Number(item.stock_actual) || 0,
      minimo_stock: Number(item.minimo_stock) || 0,
      moneda_precio_venta: item.moneda_precio_venta || 'PYG'
    }));
    if (token !== productSearchToken) return;
    posState.productSearch.results = mapped;
  } catch (error) {
    console.error(error);
    setFeedback(error.message || 'No se pudieron cargar los productos.', 'error');
  } finally {
    if (token === productSearchToken) {
      posState.productSearch.loading = false;
      renderProductResults();
    }
  }
}

function scheduleClientSearch(term) {
  if (clientSearchTimer) {
    clearTimeout(clientSearchTimer);
  }
  if (!term || term.length < 2) {
    posState.clientSearch.results = [];
    posState.clientSearch.loading = false;
    renderClientResults();
    return;
  }
  posState.clientSearch.loading = true;
  renderClientResults();
  clientSearchTimer = setTimeout(() => {
    fetchClients(term);
  }, 350);
}

async function fetchClients(term) {
  const token = ++clientSearchToken;
  try {
    const query = buildQuery({
      page: 1,
      pageSize: 8,
      search: term
    });
    const response = await request(`/clientes?${query}`);
    const data = Array.isArray(response?.data) ? response.data : [];
    if (token !== clientSearchToken) return;
    posState.clientSearch.results = data.map((item) => ({
      id: item.id,
      nombre_razon_social: item.nombre_razon_social,
      ruc: item.ruc,
      telefono: item.telefono,
      correo: item.correo
    }));
  } catch (error) {
    console.error(error);
    setFeedback(error.message || 'No se pudieron cargar los clientes.', 'error');
  } finally {
    if (token === clientSearchToken) {
      posState.clientSearch.loading = false;
      renderClientResults();
    }
  }
}

function addProductToCart(product) {
  const existing = posState.cart.find((item) => item.productoId === product.id);
  const maxStock = Math.max(Number(product.stock_actual) || 0, 0);
  if (maxStock <= 0) {
    setFeedback('El producto no tiene stock disponible.', 'error');
    return;
  }
  if (existing) {
    if (existing.cantidad >= maxStock) {
      setFeedback('Alcanzaste el stock disponible para este producto.', 'info');
      return;
    }
    existing.cantidad = Math.min(existing.cantidad + 1, maxStock);
  } else {
    posState.cart.push({
      productoId: product.id,
      nombre: product.nombre,
      sku: product.sku,
      precio: Number(product.precio_venta) || 0,
      stock: maxStock,
      cantidad: 1
    });
  }
  renderCart();
  renderSummary();
  focusProductSearch();
  setFeedback('Producto agregado al carrito.', 'success');
}

function removeProductFromCart(productId) {
  posState.cart = posState.cart.filter((item) => item.productoId !== productId);
  renderCart();
  renderSummary();
}

function adjustCartQuantity(productId, delta) {
  const item = posState.cart.find((entry) => entry.productoId === productId);
  if (!item) return;
  const next = Math.min(Math.max(item.cantidad + delta, 1), item.stock || 1);
  item.cantidad = next;
  renderCart();
  renderSummary();
}

function setCartQuantity(productId, quantity) {
  const item = posState.cart.find((entry) => entry.productoId === productId);
  if (!item) return;
  const parsed = Number(quantity);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    item.cantidad = 1;
  } else {
    item.cantidad = Math.min(Math.round(parsed), item.stock || Math.round(parsed));
  }
  renderCart();
  renderSummary();
}

function clearCart() {
  posState.cart = [];
  posState.descuento = 0;
  posState.ivaPorcentaje = 10;
  posState.moneda = 'PYG';
  posState.tipoCambio = null;
  posState.lastSale = null;
  if (posDom.discountInput) posDom.discountInput.value = '';
  if (posDom.ivaSelect) posDom.ivaSelect.value = '10';
  renderCurrencyControls();
  renderCart();
  renderSummary();
  renderLastSale();
  setFeedback('', null);
  if (posDom.printButton) {
    posDom.printButton.hidden = true;
  }
  updateActionStates();
  focusProductSearch();
}

function renderClientSection() {
  if (!posDom) return;
  const wrapper = posDom.clientSelected;
  if (!wrapper) return;
  if (posState.cliente) {
    wrapper.innerHTML = `
      <strong>${escapeHtml(posState.cliente.nombre_razon_social || 'Cliente sin nombre')}</strong>
      <small>${escapeHtml(posState.cliente.ruc || 'Sin RUC')}</small>
    `;
    wrapper.classList.add('has-client');
    posDom.clientClearButton.hidden = false;
  } else {
    wrapper.innerHTML = '<span class="placeholder">Cliente eventual</span>';
    wrapper.classList.remove('has-client');
    posDom.clientClearButton.hidden = true;
  }
  updateActionStates();
}

function renderClientResults() {
  if (!posDom) return;
  if (!posDom.clientResults) return;
  const { loading, results, term } = posState.clientSearch;
  if (!term || term.length < 2) {
    posDom.clientResults.innerHTML = '<p class="empty">Empieza a escribir para buscar.</p>';
    return;
  }
  if (loading) {
    posDom.clientResults.innerHTML = '<p class="loading">Buscando clientes...</p>';
    return;
  }
  if (!results.length) {
    posDom.clientResults.innerHTML = '<p class="empty">Sin coincidencias.</p>';
    return;
  }
  posDom.clientResults.innerHTML = `
    <ul class="pos-result-list">
      ${results
        .map(
          (item) => `
            <li>
              <div>
                <strong>${escapeHtml(item.nombre_razon_social)}</strong>
                <small>${escapeHtml(item.ruc || 'Sin RUC')}</small>
              </div>
              <button type="button" class="btn ghost small" data-pos-select-client="${item.id}">Usar</button>
            </li>
          `
        )
        .join('')}
    </ul>
  `;
}

function renderProductResults() {
  if (!posDom || !posDom.productResults) return;
  const { loading, results, term } = posState.productSearch;
  if (!term || term.length < 2) {
    posDom.productResults.innerHTML = '<p class="empty">Escribe al menos 2 caracteres para buscar.</p>';
    return;
  }
  if (loading) {
    posDom.productResults.innerHTML = '<p class="loading">Buscando productos...</p>';
    return;
  }
  if (!results.length) {
    posDom.productResults.innerHTML = '<p class="empty">Sin productos disponibles para ese filtro.</p>';
    return;
  }
  posDom.productResults.innerHTML = `
    <ul class="pos-result-grid">
      ${results
        .map(
          (item) => `
            <li>
              <div class="info">
                <strong>${escapeHtml(item.nombre)}</strong>
                <small>SKU: ${escapeHtml(item.sku || '-')}</small>
                <small>Stock: ${formatNumber(item.stock_actual, 0)}</small>
              </div>
              <div class="price">${formatCurrency(item.precio_venta, item.moneda_precio_venta || 'PYG')}</div>
              <button type="button" class="btn ghost small" data-pos-add-product="${item.id}">Agregar</button>
            </li>
          `
        )
        .join('')}
    </ul>
  `;
}

function renderCart() {
  if (!posDom || !posDom.cartList) return;
  if (!posState.cart.length) {
    posDom.cartList.innerHTML = '<p class="empty">Agrega productos para iniciar la venta.</p>';
    updateActionStates();
    return;
  }
  posDom.cartList.innerHTML = `
    <ul class="pos-cart-items">
      ${posState.cart
        .map(
          (item) => {
            const subtotal = item.cantidad * item.precio;
            const stockLabel = item.stock ? `${formatNumber(item.stock, 0)} en stock` : 'Sin stock disponible';
            return `
              <li>
                <div class="meta">
                  <strong>${escapeHtml(item.nombre)}</strong>
                  <small>SKU: ${escapeHtml(item.sku || '-')} · ${stockLabel}</small>
                </div>
                <div class="controls">
                  <div class="qty">
                    <button type="button" class="btn ghost small" data-pos-cart-action="decrement" data-pos-cart-id="${item.productoId}">-</button>
                    <input type="number" min="1" ${item.stock ? `max="${item.stock}" ` : ''}step="1" data-pos-cart-qty data-pos-cart-id="${item.productoId}" value="${item.cantidad}">
                    <button type="button" class="btn ghost small" data-pos-cart-action="increment" data-pos-cart-id="${item.productoId}">+</button>
                  </div>
                  <div class="amount">
                    <span>${formatCurrency(item.precio, 'PYG')}</span>
                    <small>Subtotal: ${formatCurrency(subtotal, 'PYG')}</small>
                  </div>
                  <button type="button" class="btn danger small" data-pos-cart-action="remove" data-pos-cart-id="${item.productoId}">Quitar</button>
                </div>
              </li>
            `;
          }
        )
        .join('')}
    </ul>
  `;
  updateActionStates();
}

function computeTotals() {
  const subtotal = posState.cart.reduce((acc, item) => acc + item.precio * item.cantidad, 0);
  const descuento = Math.min(Math.max(posState.descuento || 0, 0), subtotal);
  const base = Math.max(subtotal - descuento, 0);
  const divisor = IVA_DIVISOR[posState.ivaPorcentaje] || IVA_DIVISOR[10];
  const ivaCalculado = base > 0 ? base / divisor : 0;
  const total = base;
  return {
    subtotal,
    descuento,
    base,
    ivaCalculado,
    total
  };
}

function renderCurrencyControls() {
  if (!posDom) return;
  if (posDom.currencySelect) {
    posDom.currencySelect.value = posState.moneda || 'PYG';
  }
  if (posDom.exchangeRow) {
    posDom.exchangeRow.hidden = posState.moneda !== 'USD';
  }
  if (posDom.exchangeInput) {
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    if (posState.moneda !== 'USD') {
      if (activeElement !== posDom.exchangeInput) {
        posDom.exchangeInput.value = '';
      }
    } else if (posState.tipoCambio && activeElement !== posDom.exchangeInput) {
      posDom.exchangeInput.value = posState.tipoCambio;
    }
  }
}

function renderSummary() {
  if (!posDom || !posDom.summaryTotals) return;
  const totals = computeTotals();
  const requiereCambio = posState.moneda === 'USD';
  const tipoCambioValido = requiereCambio && Number(posState.tipoCambio) > 0;
  const totalUsd = requiereCambio && tipoCambioValido ? totals.total / Number(posState.tipoCambio) : 0;

  let summaryHtml = `
    <div class="row"><span>Subtotal</span><strong>${formatCurrency(totals.subtotal, 'PYG')}</strong></div>
    <div class="row"><span>Descuento</span><strong>${formatCurrency(totals.descuento, 'PYG')}</strong></div>
    <div class="row"><span>IVA (${posState.ivaPorcentaje}%)</span><strong>${formatCurrency(totals.ivaCalculado, 'PYG')}</strong></div>
    <div class="row total"><span>Total</span><strong>${formatCurrency(totals.total, 'PYG')}</strong></div>
  `;

  if (requiereCambio) {
    summaryHtml += `
      <div class="row"><span>Tipo de cambio</span><strong>${tipoCambioValido ? formatNumber(posState.tipoCambio, 4) : '—'} Gs.</strong></div>
      <div class="row total"><span>Total (USD)</span><strong>${
        tipoCambioValido ? formatCurrency(totalUsd, 'USD') : 'Completar tipo de cambio'
      }</strong></div>
    `;
  }

  posDom.summaryTotals.innerHTML = summaryHtml;
  if (posDom.printButton) {
    posDom.printButton.hidden = !posState.lastSale;
  }
  renderCurrencyControls();
  updateActionStates();
}

function renderLastSale() {
  if (!posDom || !posDom.lastSale) return;
  if (!posState.lastSale) {
    posDom.lastSale.hidden = true;
    posDom.lastSale.innerHTML = '';
    return;
  }
  const venta = posState.lastSale;
  const totalGs = Number(venta.total) || 0;
  const monedaVenta = String(venta.moneda || 'PYG').toUpperCase();
  const isUsd = monedaVenta === 'USD';
  const totalUsd = isUsd
    ? Number(venta.total_moneda) ||
      (Number(venta.tipo_cambio) && Number(venta.tipo_cambio) > 0 ? totalGs / Number(venta.tipo_cambio) : null)
    : null;
  posDom.lastSale.hidden = false;
  posDom.lastSale.innerHTML = `
    <h4>Venta registrada</h4>
    <p>ID: <code>${escapeHtml(venta.id)}</code></p>
    <p>Cliente: ${escapeHtml(venta.cliente?.nombre_razon_social || 'Cliente eventual')}</p>
    <p>Total Gs.: ${formatCurrency(totalGs, 'PYG')}</p>
    ${
      isUsd
        ? `<p>Total USD: ${totalUsd ? formatCurrency(totalUsd, 'USD') : '—'}</p><small>Cambio aplicado: ${formatNumber(
            venta.tipo_cambio,
            4
          )} Gs.</small>`
        : ''
    }
    <small>${formatDate(venta.created_at || new Date().toISOString())}</small>
  `;
}

function setFeedback(message, variant) {
  if (!posDom || !posDom.feedback) return;
  posDom.feedback.textContent = message || '';
  posDom.feedback.className = 'feedback';
  if (variant) {
    posDom.feedback.classList.add(variant);
  }
}

async function confirmSale() {
  if (!posDom) return;
  if (posState.loading) return;
  if (!posState.cart.length) {
    setFeedback('Agrega al menos un producto al carrito.', 'error');
    updateActionStates();
    focusProductSearch();
    return;
  }
  const session = loadSession();
  if (!session || !session.id) {
    setFeedback('Inicia sesión nuevamente para registrar la venta.', 'error');
    updateActionStates();
    return;
  }
  const totals = computeTotals();
  if (totals.descuento > totals.subtotal) {
    setFeedback('El descuento no puede superar al subtotal.', 'error');
    updateActionStates();
    return;
  }

  if (posState.moneda === 'USD') {
    const tipoCambioValido = Number(posState.tipoCambio);
    if (!Number.isFinite(tipoCambioValido) || tipoCambioValido <= 0) {
      setFeedback('Ingresá el tipo de cambio vigente para cobrar en USD.', 'error');
      updateActionStates();
      return;
    }
  }

  setFeedback('Registrando venta...', 'info');
  setPosLoading(true, 'Guardando...');

  try {
    const payload = {
      usuarioId: session.id,
      clienteId: posState.cliente?.id || undefined,
      iva_porcentaje: posState.ivaPorcentaje,
      descuento_total: totals.descuento,
      moneda: posState.moneda,
      tipo_cambio: posState.moneda === 'USD' ? posState.tipoCambio : undefined,
      detalles: posState.cart.map((item) => ({
        productoId: item.productoId,
        cantidad: item.cantidad
      }))
    };

    const venta = await request('/ventas', {
      method: 'POST',
      body: payload
    });

    posState.lastSale = venta;
    setFeedback('Venta registrada correctamente.', 'success');
    renderLastSale();
    if (posDom.printButton) {
      posDom.printButton.hidden = false;
    }
    posState.cart = [];
    posState.descuento = 0;
    posDom.discountInput.value = '';
    renderCart();
    renderSummary();
  } catch (error) {
    console.error(error);
    setFeedback(error.message || 'No se pudo registrar la venta.', 'error');
  } finally {
    setPosLoading(false);
    updateActionStates();
    focusProductSearch();
  }
}

async function generateInvoice() {
  if (!posState.lastSale) {
    setFeedback('Registra una venta antes de generar la factura.', 'info');
    return;
  }
  const defaultLabel = posDom?.printButton?.dataset?.defaultLabel || 'Imprimir factura';
  if (posDom?.printButton) {
    posDom.printButton.disabled = true;
    posDom.printButton.textContent = 'Generando...';
  }
  try {
    setFeedback('Generando factura digital...', 'info');
    const response = await request(`/ventas/${posState.lastSale.id}/facturar`, {
      method: 'POST'
    });
    const venta = response?.venta || response;
    const facturaDigital = venta?.factura_digital;
    const facturaElectronica = response?.factura || venta?.factura_electronica;
    const pdfUrl = facturaDigital?.id
      ? `/facturas-digitales/${encodeURIComponent(facturaDigital.id)}/pdf`
      : facturaElectronica?.pdf_path;
    const facturaTipo = facturaDigital ? 'digital' : 'electrónica';
    if (!venta) {
      throw new Error('No se recibió la venta generada.');
    }
    if (pdfUrl) {
      const win = window.open(pdfUrl, '_blank');
      if (!win) {
        setFeedback(`Factura ${facturaTipo} generada. Desbloquea las ventanas emergentes para descargar el PDF.`, 'warn');
      } else {
        win.focus();
        setFeedback(`Factura ${facturaTipo} generada. El PDF se abrió en una nueva pestaña.`, 'success');
      }
    } else {
      openInvoiceWindow(venta, facturaDigital || facturaElectronica);
      setFeedback(`Factura ${facturaTipo} generada. Puedes imprimirla desde la ventana emergente.`, 'success');
    }
    posState.lastSale = venta;
    renderLastSale();
  } catch (error) {
    console.error(error);
    setFeedback(error.message || 'No se pudo generar la factura digital.', 'error');
  } finally {
    if (posDom?.printButton) {
      posDom.printButton.disabled = false;
      posDom.printButton.textContent = defaultLabel;
    }
    updateActionStates();
  }
}

function openInvoiceWindow(venta, factura) {
  const win = window.open('', '', 'width=900,height=800');
  if (!win) {
    setFeedback('No se pudo abrir la ventana de impresión. Revisa el bloqueo de pop-ups.', 'error');
    return;
  }
  const cliente = venta?.cliente;
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const totals = computeInvoiceTotals(venta);
  const numeroFactura = factura?.nro_factura || `TEMP-${venta.id.slice(0, 8).toUpperCase()}`;
  const fechaEmision = factura?.fecha_emision || venta?.created_at || new Date().toISOString();

  const detalleFilas = detalles
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.producto?.nombre || 'Producto')}</td>
          <td class="right">${formatNumber(item.cantidad)}</td>
          <td class="right">${formatCurrency(Number(item.precio_unitario) || 0, 'PYG')}</td>
          <td class="right">${formatCurrency(Number(item.subtotal) || 0, 'PYG')}</td>
        </tr>
      `
    )
    .join('');

  win.document.open();
  win.document.write(`<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="utf-8">
      <title>Factura ${numeroFactura}</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; margin: 32px; color: #111827; }
        header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
        header h1 { margin: 0 0 8px; font-size: 20px; }
        .meta { font-size: 0.9rem; color: #374151; }
        table { width: 100%; border-collapse: collapse; margin-top: 24px; }
        th, td { border: 1px solid #d1d5db; padding: 10px 12px; text-align: left; }
        th { background: #f97316; color: #fff; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
        td.right { text-align: right; }
        footer { margin-top: 32px; font-size: 0.85rem; color: #4b5563; }
        .totals { margin-top: 16px; width: 320px; margin-left: auto; }
        .totals div { display: flex; justify-content: space-between; padding: 6px 0; }
        .totals div.total { font-weight: 700; font-size: 1.05rem; border-top: 1px solid #d1d5db; margin-top: 6px; padding-top: 10px; }
      </style>
    </head>
    <body>
      <header>
        <div>
          <h1>Factura digital</h1>
          <div class="meta">
            <div>Nro: ${escapeHtml(numeroFactura)}</div>
            <div>Fecha: ${escapeHtml(formatDate(fechaEmision))}</div>
            <div>Estado: ${escapeHtml((factura?.estado || 'EMITIDA').toUpperCase())}</div>
          </div>
        </div>
        <div class="meta">
          <div><strong>Cliente</strong></div>
          <div>${escapeHtml(cliente?.nombre_razon_social || 'Cliente eventual')}</div>
          <div>RUC: ${escapeHtml(cliente?.ruc || 'S/D')}</div>
        </div>
      </header>
      <main>
        <table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Cant.</th>
              <th>Precio</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${detalleFilas || '<tr><td colspan="4">Sin detalles</td></tr>'}
          </tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span><span>${formatCurrency(totals.subtotal, 'PYG')}</span></div>
          <div><span>Descuento</span><span>${formatCurrency(totals.descuento, 'PYG')}</span></div>
          <div><span>IVA ${venta?.iva_porcentaje || 10}%</span><span>${formatCurrency(totals.iva, 'PYG')}</span></div>
          <div class="total"><span>Total</span><span>${formatCurrency(totals.total, 'PYG')}</span></div>
        </div>
      </main>
      <footer>
  <small>Generado automáticamente por TRIDENT INNOVA E.A.S · ${escapeHtml(formatDate(new Date().toISOString()))}</small>
      </footer>
      <script>
        window.addEventListener('load', function () {
          window.focus();
          window.print();
        });
      </script>
    </body>
  </html>`);
  win.document.close();
}

function computeInvoiceTotals(venta) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const subtotal = detalles.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);
  const descuento = Number(venta?.descuento_total) || 0;
  const total = Number(venta?.total) || Math.max(subtotal - descuento, 0);
  const divisor = IVA_DIVISOR[Number(venta?.iva_porcentaje) || 10] || IVA_DIVISOR[10];
  const iva = total > 0 ? total / divisor : 0;
  return { subtotal, descuento, total, iva };
}

function attachGlobalShortcuts() {
  if (typeof window === 'undefined') return;
  if (globalKeydownHandler) {
    window.removeEventListener('keydown', globalKeydownHandler);
  }
  globalKeydownHandler = (event) => {
    if (!posDom || !posDom.root || !posDom.root.isConnected) return;
    if (posState.loading) return;
    if (event.key === 'F2') {
      event.preventDefault();
      focusProductSearch({ select: true });
      return;
    }
    if (event.key === 'F3') {
      event.preventDefault();
      focusClientSearch({ select: true });
      return;
    }
    if ((event.key === 'Enter' || event.key === 'NumpadEnter') && event.ctrlKey) {
      event.preventDefault();
      void confirmSale();
    }
  };
  window.addEventListener('keydown', globalKeydownHandler);
}

function focusInputSafely(input, { select = true, preventScroll = true } = {}) {
  if (!input || input.disabled) return;
  try {
    input.focus({ preventScroll });
  } catch (error) {
    input.focus();
  }
  if (select && typeof input.select === 'function') {
    const selectFn = () => input.select();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(selectFn);
    } else {
      setTimeout(selectFn, 0);
    }
  }
}

function focusProductSearch(options = {}) {
  if (!posDom || !posDom.productSearchInput) return;
  focusInputSafely(posDom.productSearchInput, options);
}

function focusClientSearch(options = {}) {
  if (!posDom || !posDom.clientSearchInput) return;
  focusInputSafely(posDom.clientSearchInput, options);
}

function clearProductSearch() {
  posState.productSearch.term = '';
  posState.productSearch.results = [];
  posState.productSearch.loading = false;
  if (posDom?.productSearchInput) {
    posDom.productSearchInput.value = '';
  }
  renderProductResults();
}

function clearClientSearch() {
  posState.clientSearch.term = '';
  posState.clientSearch.results = [];
  posState.clientSearch.loading = false;
  if (posDom?.clientSearchInput) {
    posDom.clientSearchInput.value = '';
  }
  renderClientResults();
}

function updateActionStates() {
  if (!posDom) return;
  const hasCart = posState.cart.length > 0;
  const hasClearable = hasCart || Boolean(posState.cliente) || (posState.descuento || 0) > 0;
  const requiereTipoCambio = posState.moneda === 'USD';
  const tipoCambioValido = Number(posState.tipoCambio) > 0;
  const canConfirm = hasCart && (!requiereTipoCambio || tipoCambioValido);

  if (posDom.confirmButton) {
    if (!posDom.confirmButton.dataset.defaultLabel) {
      posDom.confirmButton.dataset.defaultLabel = posDom.confirmButton.textContent || 'Confirmar venta';
    }
    if (!posState.loading) {
      posDom.confirmButton.disabled = !canConfirm;
      posDom.confirmButton.textContent = posDom.confirmButton.dataset.defaultLabel;
    }
  }

  if (posDom.clearButton) {
    posDom.clearButton.disabled = posState.loading || !hasClearable;
  }

  if (posDom.printButton) {
    posDom.printButton.disabled = posState.loading || posDom.printButton.hidden;
  }
}

function setPosLoading(isLoading, loadingLabel) {
  posState.loading = Boolean(isLoading);
  if (!posDom) return;

  if (posDom.root) {
    posDom.root.classList.toggle('is-loading', posState.loading);
  }

  if (posDom.confirmButton) {
    if (!posDom.confirmButton.dataset.defaultLabel) {
      posDom.confirmButton.dataset.defaultLabel = posDom.confirmButton.textContent || 'Confirmar venta';
    }
    if (posState.loading) {
      posDom.confirmButton.disabled = true;
      posDom.confirmButton.textContent = loadingLabel || 'Guardando...';
    } else {
      posDom.confirmButton.textContent = posDom.confirmButton.dataset.defaultLabel;
    }
  }

  [
    posDom.productSearchInput,
    posDom.clientSearchInput,
    posDom.discountInput,
    posDom.ivaSelect,
    posDom.currencySelect,
    posDom.exchangeInput
  ].forEach((control) => {
    if (control) {
      control.disabled = posState.loading;
    }
  });

  if (posDom.clearButton) {
    const hasClearable = posState.cart.length || posState.cliente || posState.descuento;
    posDom.clearButton.disabled = posState.loading || !hasClearable;
  }

  if (posDom.printButton) {
    posDom.printButton.disabled = posState.loading || posDom.printButton.hidden;
  }

  updateActionStates();
}

function renderPos(container) {
  ensureDom(container);
  renderClientSection();
  renderClientResults();
  renderProductResults();
  renderCart();
  renderSummary();
  renderLastSale();
  updateActionStates();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const posModule = {
  key: 'pos',
  label: 'Punto de venta',
  labelSingular: 'Venta POS',
  singular: 'Venta POS',
  singularLower: 'venta POS',
  endpoint: '/ventas',
  supportsForm: false,
  supportsPagination: false,
  hideFilters: true,
  columns: [],
  customRender: ({ container }) => {
    renderPos(container);
  },
  async fetchList() {
    return {
      data: [],
      meta: {
        page: 1,
        pageSize: 0,
        total: 0,
        totalPages: 1
      }
    };
  }
};
