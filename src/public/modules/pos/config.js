import { request, buildQuery, urlWithSession } from '../common/api.js';
import { formatCurrency, formatNumber, formatDate } from '../common/format.js';
import { loadSession } from '../auth/session.js';
import { createDeferredDocumentWindow, openUrlInNewTab } from '../common/dialogs.js';
import { resolveProductUnitPricing } from '../common/pricing.js';

const IVA_OPTIONS = [
  { value: 10, label: 'IVA 10%' },
  { value: 5, label: 'IVA 5%' },
  { value: 0, label: 'Exentas (0%)' }
];

const IVA_DIVISOR = {
  10: 11,
  5: 21,
  0: null
};

const FACTURA_PDF_POLL_ATTEMPTS = 6;
const FACTURA_PDF_POLL_DELAY_MS = 1200;

function getIvaLabel(value) {
  const numeric = Number(value);
  if (numeric === 0) return 'IVA Exentas (0%)';
  if (!Number.isFinite(numeric)) return 'IVA 10%';
  return `IVA ${numeric}%`;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isExternalDocumentUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isCanonicalFacturaPdfUrl(url) {
  if (!url || typeof window === 'undefined') return false;
  try {
    const resolved = new URL(String(url), window.location.origin);
    return /^https?:$/i.test(resolved.protocol) && resolved.origin !== window.location.origin;
  } catch (_error) {
    return false;
  }
}

function mergeVentaFacturaState(venta, facturaElectronica) {
  if (!venta) return null;
  if (!facturaElectronica) return venta;
  return {
    ...venta,
    factura_electronicaId: venta.factura_electronicaId || facturaElectronica.id || null,
    factura_electronica: {
      ...(venta.factura_electronica || {}),
      ...facturaElectronica
    }
  };
}

function numberToWordsEs(num) {
  const units = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
  const teens = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve'];
  const tens = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const hundreds = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  const toWordsBelowThousand = (n) => {
    if (n === 0) return '';
    if (n < 10) return units[n];
    if (n < 20) return teens[n - 10];
    if (n < 100) {
      const ten = Math.trunc(n / 10);
      const unit = n % 10;
      if (n === 20) return 'veinte';
      const suffix = unit ? ` y ${units[unit]}` : '';
      return `${tens[ten]}${suffix}`;
    }
    if (n === 100) return 'cien';
    const hundred = Math.trunc(n / 100);
    const remainder = n % 100;
    const rest = remainder ? ` ${toWordsBelowThousand(remainder)}` : '';
    return `${hundreds[hundred]}${rest}`;
  };

  const toWords = (n) => {
    if (n === 0) return 'cero';
    let result = '';
    const billions = Math.trunc(n / 1_000_000_000);
    const millions = Math.trunc((n % 1_000_000_000) / 1_000_000);
    const thousands = Math.trunc((n % 1_000_000) / 1000);
    const remainder = n % 1000;

    if (billions) {
      result += `${toWords(billions)} mil millones`;
    }
    if (millions) {
      result += `${result ? ' ' : ''}${millions === 1 ? 'un millon' : `${toWords(millions)} millones`}`;
    }
    if (thousands) {
      result += `${result ? ' ' : ''}${thousands === 1 ? 'mil' : `${toWordsBelowThousand(thousands)} mil`}`;
    }
    if (remainder) {
      result += `${result ? ' ' : ''}${toWordsBelowThousand(remainder)}`;
    }
    return result.trim();
  };

  return toWords(Math.trunc(Math.abs(num)));
}

function montoEnLetras(monto, moneda) {
  const safeMonto = Number.isFinite(Number(monto)) ? Math.abs(Number(monto)) : 0;
  const entero = Math.trunc(safeMonto);
  const centavos = Math.round((safeMonto - entero) * 100);
  const monedaNombre = String(moneda || 'PYG').toUpperCase() === 'USD' ? 'dolares' : 'guaranies';
  const textoNumero = numberToWordsEs(entero);
  const textoCentavos = centavos.toString().padStart(2, '0');
  return `${textoNumero} ${monedaNombre} con ${textoCentavos}/100`;
}

const posState = {
  cliente: null,
  cart: [],
  descuento: 0,
  ivaPorcentaje: 10,
  moneda: 'PYG',
  tipoCambio: null,
  condicionVenta: 'CONTADO',
  fechaVencimiento: null,
  creditTipo: 'PLAZO',
  entregaInicial: 0,
  metodoEntrega: 'EFECTIVO',
  cantidadCuotas: 3,
  cuotas: [],
  comprobante: 'FACTURA',
  lastSale: null,
  lastCreditoConfig: null,
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
let checkoutMediaQuery = null;

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
        <section class="pos-overview" id="pos-overview">
          <div class="pos-overview__stats">
            <article class="pos-overview__card">
              <span>Cliente</span>
              <strong id="pos-overview-client">Eventual</strong>
            </article>
            <article class="pos-overview__card">
              <span>Ítems</span>
              <strong id="pos-overview-items">0</strong>
            </article>
            <article class="pos-overview__card">
              <span>Total actual</span>
              <strong id="pos-overview-total">Gs. 0</strong>
            </article>
          </div>
          <div class="pos-overview__actions">
            <button type="button" class="btn ghost small" id="pos-overview-search">Buscar productos</button>
            <button type="button" class="btn ghost small" id="pos-overview-checkout">Ir al cobro</button>
          </div>
        </section>
        <div class="pos-cart-list" id="pos-cart-list">
          <p class="empty">Agrega productos para iniciar la venta.</p>
        </div>
        <section class="pos-checkout" id="pos-checkout">
          <button type="button" class="pos-checkout-toggle" id="pos-checkout-toggle" aria-expanded="true">
            <span class="pos-checkout-toggle__copy">
              <strong>Resumen y cobro</strong>
              <small>Comprobante, moneda, IVA y cierre</small>
            </span>
            <span class="pos-checkout-toggle__totals">
              <small id="pos-mini-subtotal">Subtotal: Gs. 0</small>
              <strong id="pos-mini-total">Gs. 0</strong>
            </span>
          </button>
          <div class="pos-checkout-body" id="pos-checkout-body">
            <div class="pos-summary">
              <div class="pos-summary-row">
                <label for="pos-comprobante">Comprobante</label>
                <select id="pos-comprobante">
                  <option value="FACTURA">Factura</option>
                  <option value="TICKET">Ticket</option>
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
              <div class="pos-summary-row">
                <label for="pos-iva">IVA aplicado</label>
                <select id="pos-iva">
                  ${IVA_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
                </select>
              </div>
              <div class="pos-summary-row">
                <label for="pos-discount">Descuento <span data-discount-unit>(auto)</span></label>
                <input type="number" id="pos-discount" min="0" step="0.01" placeholder="0">
              </div>
              <div class="pos-summary-row">
                <label for="pos-condicion">Condición de venta</label>
                <select id="pos-condicion">
                  <option value="CONTADO">Contado</option>
                  <option value="CREDITO">Crédito</option>
                </select>
              </div>
              <div class="pos-summary-row" id="pos-credit-row" hidden>
                <label for="pos-credit-type">Modalidad crédito</label>
                <select id="pos-credit-type">
                  <option value="PLAZO">Plazo</option>
                  <option value="CUOTAS">Cuotas</option>
                </select>
              </div>
              <div class="pos-summary-row" id="pos-credit-entrega-row" hidden>
                <label for="pos-credit-entrega">Entrega inicial</label>
                <input type="number" id="pos-credit-entrega" min="0" step="0.01" placeholder="0">
              </div>
              <div class="pos-summary-row" id="pos-credit-metodo-row" hidden>
                <label for="pos-credit-metodo">Método entrega</label>
                <select id="pos-credit-metodo">
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="TRANSFERENCIA">Transferencia</option>
                  <option value="TARJETA">Tarjeta</option>
                  <option value="CHEQUE">Cheque</option>
                </select>
              </div>
              <div class="pos-summary-row" id="pos-credit-plazo-row" hidden>
                <label for="pos-fecha-venc">Vencimiento (plazo)</label>
                <input type="date" id="pos-fecha-venc">
              </div>
              <div class="pos-summary-row" id="pos-credit-cuotas-row" hidden>
                <label for="pos-cantidad-cuotas">Cuotas</label>
                <div class="pos-cuotas-inline">
                  <input type="number" id="pos-cantidad-cuotas" min="1" step="1" value="3">
                  <button type="button" class="btn ghost small" id="pos-cuotas-generar">Generar plan</button>
                </div>
              </div>
              <div class="pos-cuotas-list" id="pos-cuotas-list" hidden></div>
              <div class="pos-summary-totals" id="pos-summary-totals"></div>
            </div>
            <div class="pos-actions">
              <button type="button" class="btn primary" id="pos-confirm">Confirmar venta</button>
              <button type="button" class="btn ghost" id="pos-clear">Limpiar</button>
              <button type="button" class="btn ghost" id="pos-print" hidden>Imprimir factura</button>
              <button type="button" class="btn ghost" id="pos-ticket" hidden>Imprimir ticket</button>
            </div>
            <div id="pos-feedback" class="feedback"></div>
            <div class="pos-last-sale" id="pos-last-sale" hidden></div>
          </div>
        </section>
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
    overviewClient: layout?.querySelector('#pos-overview-client') || null,
    overviewItems: layout?.querySelector('#pos-overview-items') || null,
    overviewTotal: layout?.querySelector('#pos-overview-total') || null,
    overviewSearchButton: layout?.querySelector('#pos-overview-search') || null,
    overviewCheckoutButton: layout?.querySelector('#pos-overview-checkout') || null,
    clientSelected: layout?.querySelector('#pos-client-selected') || null,
    clientClearButton: layout?.querySelector('#pos-client-clear') || null,
    clientSearchInput: layout?.querySelector('#pos-client-search') || null,
    clientResults: layout?.querySelector('#pos-client-results') || null,
    productSearchInput: layout?.querySelector('#pos-product-search') || null,
    productResults: layout?.querySelector('#pos-product-results') || null,
    cartList: layout?.querySelector('#pos-cart-list') || null,
    checkout: layout?.querySelector('#pos-checkout') || null,
    checkoutToggle: layout?.querySelector('#pos-checkout-toggle') || null,
    checkoutBody: layout?.querySelector('#pos-checkout-body') || null,
    miniSubtotal: layout?.querySelector('#pos-mini-subtotal') || null,
    miniTotal: layout?.querySelector('#pos-mini-total') || null,
    discountInput: layout?.querySelector('#pos-discount') || null,
    discountUnit: layout?.querySelector('[data-discount-unit]') || null,
    ivaSelect: layout?.querySelector('#pos-iva') || null,
    currencySelect: layout?.querySelector('#pos-currency') || null,
    exchangeRow: layout?.querySelector('#pos-exchange-row') || null,
    exchangeInput: layout?.querySelector('#pos-exchange') || null,
    condicionSelect: layout?.querySelector('#pos-condicion') || null,
    comprobanteSelect: layout?.querySelector('#pos-comprobante') || null,
    creditRow: layout?.querySelector('#pos-credit-row') || null,
    creditTypeSelect: layout?.querySelector('#pos-credit-type') || null,
    creditEntregaRow: layout?.querySelector('#pos-credit-entrega-row') || null,
    creditEntregaInput: layout?.querySelector('#pos-credit-entrega') || null,
    creditMetodoRow: layout?.querySelector('#pos-credit-metodo-row') || null,
    creditMetodoSelect: layout?.querySelector('#pos-credit-metodo') || null,
    creditPlazoRow: layout?.querySelector('#pos-credit-plazo-row') || null,
    creditCuotasRow: layout?.querySelector('#pos-credit-cuotas-row') || null,
    cantidadCuotasInput: layout?.querySelector('#pos-cantidad-cuotas') || null,
    cuotasList: layout?.querySelector('#pos-cuotas-list') || null,
    cuotasGenerateButton: layout?.querySelector('#pos-cuotas-generar') || null,
    fechaVencInput: layout?.querySelector('#pos-fecha-venc') || null,
    feedback: layout?.querySelector('#pos-feedback') || null,
    confirmButton: layout?.querySelector('#pos-confirm') || null,
    clearButton: layout?.querySelector('#pos-clear') || null,
    printButton: layout?.querySelector('#pos-print') || null,
    ticketButton: layout?.querySelector('#pos-ticket') || null,
    summaryTotals: layout?.querySelector('#pos-summary-totals') || null,
    lastSale: layout?.querySelector('#pos-last-sale') || null
  };

  renderCurrencyControls();
  toggleCreditFields();
  attachEventListeners();
  attachGlobalShortcuts();
  attachCheckoutMediaListener();

  if (posDom.root && !posDom.root.hasAttribute('tabindex')) {
    posDom.root.setAttribute('tabindex', '-1');
  }
  if (posDom.confirmButton && !posDom.confirmButton.dataset.defaultLabel) {
    posDom.confirmButton.dataset.defaultLabel = posDom.confirmButton.textContent || 'Confirmar venta';
  }
  if (posDom.printButton && !posDom.printButton.dataset.defaultLabel) {
    posDom.printButton.dataset.defaultLabel = posDom.printButton.textContent || 'Imprimir factura';
  }
  if (posDom.ticketButton && !posDom.ticketButton.dataset.defaultLabel) {
    posDom.ticketButton.dataset.defaultLabel = posDom.ticketButton.textContent || 'Imprimir ticket';
  }

  syncCheckoutForViewport();
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
      const client = posState.clientSearch.results.find((item) => item.id === clientId);
      if (!client) return;
      posState.cliente = client;
      posState.clientSearch.results = [];
      renderClientSection();
      renderClientResults();
      focusProductSearch();
    });
  }

  if (posDom.clientClearButton) {
    posDom.clientClearButton.addEventListener('click', () => {
      posState.cliente = null;
      renderClientSection();
      clearClientSearch();
      focusClientSearch();
    });
  }

  if (posDom.overviewSearchButton) {
    posDom.overviewSearchButton.addEventListener('click', () => {
      focusProductSearch({ select: true, preventScroll: false });
    });
  }

  if (posDom.overviewCheckoutButton) {
    posDom.overviewCheckoutButton.addEventListener('click', () => {
      expandCheckoutAndScroll();
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
      if (posDom.discountUnit) {
        posDom.discountUnit.textContent = posState.moneda === 'USD' ? 'USD' : 'Gs.';
      }
      renderCart();
      renderSummary();
    });
  }

  if (posDom.comprobanteSelect) {
    posDom.comprobanteSelect.addEventListener('change', (event) => {
      const selected = String(event.target.value || 'FACTURA').toUpperCase();
      posState.comprobante = selected === 'TICKET' ? 'TICKET' : 'FACTURA';
      if (posState.comprobante === 'TICKET') {
        posState.condicionVenta = 'CONTADO';
        posState.fechaVencimiento = null;
      }
      toggleCreditFields();
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
      renderCart();
      renderSummary();
    });
  }

  if (posDom.condicionSelect) {
    posDom.condicionSelect.addEventListener('change', (event) => {
      posState.condicionVenta = event.target.value === 'CREDITO' ? 'CREDITO' : 'CONTADO';
      toggleCreditFields();
      renderSummary();
    });
  }

  if (posDom.creditTypeSelect) {
    posDom.creditTypeSelect.addEventListener('change', (event) => {
      const next = event.target.value === 'CUOTAS' ? 'CUOTAS' : 'PLAZO';
      posState.creditTipo = next;
      if (next === 'PLAZO') {
        posState.cuotas = [];
        posState.cantidadCuotas = 3;
      } else {
        syncCuotasPlanWithCurrentCredit();
      }
      toggleCreditFields();
      renderSummary();
    });
  }

  if (posDom.creditEntregaInput) {
    posDom.creditEntregaInput.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      posState.entregaInicial = Number.isFinite(value) && value > 0 ? round2(value) : 0;
      syncCuotasPlanWithCurrentCredit();
      renderSummary();
    });
  }

  if (posDom.creditMetodoSelect) {
    posDom.creditMetodoSelect.addEventListener('change', (event) => {
      posState.metodoEntrega = String(event.target.value || 'EFECTIVO').toUpperCase();
      renderSummary();
    });
  }

  if (posDom.cantidadCuotasInput) {
    posDom.cantidadCuotasInput.addEventListener('input', (event) => {
      const value = Math.max(1, Math.round(Number(event.target.value) || 1));
      posState.cantidadCuotas = value;
      if (posState.creditTipo === 'CUOTAS' && posState.cuotas.length) {
        syncCuotasPlanWithCurrentCredit();
        renderSummary();
      }
    });
  }

  if (posDom.cuotasGenerateButton) {
    posDom.cuotasGenerateButton.addEventListener('click', () => {
      generateCuotasPlan();
      renderSummary();
    });
  }

  if (posDom.cuotasList) {
    posDom.cuotasList.addEventListener('input', (event) => {
      const row = event.target.closest('[data-pos-cuota-idx]');
      if (!row) return;
      const idx = Number(row.dataset.posCuotaIdx);
      if (!Number.isFinite(idx) || idx < 0) return;
      const cuota = posState.cuotas[idx];
      if (!cuota) return;
      if (event.target.matches('input[data-pos-cuota-monto]')) {
        const monto = round2(event.target.value);
        cuota.monto = monto;
      }
      if (event.target.matches('input[data-pos-cuota-fecha]')) {
        cuota.fecha_vencimiento = event.target.value || '';
      }
    });
  }

  if (posDom.fechaVencInput) {
    posDom.fechaVencInput.addEventListener('change', (event) => {
      const value = event.target.value || null;
      posState.fechaVencimiento = value;
      renderSummary();
    });
  }

  if (posDom.clearButton) {
    posDom.clearButton.addEventListener('click', () => {
    clearCart();
  });
  }

  if (posDom.checkoutToggle) {
    posDom.checkoutToggle.addEventListener('click', () => {
      if (!isMobileCheckout()) return;
      setCheckoutExpanded(!posDom.checkout?.classList.contains('is-expanded'));
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

  if (posDom.ticketButton) {
    posDom.ticketButton.addEventListener('click', async () => {
      await generateTicket();
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
      precio_venta_original: item.precio_venta_original != null ? Number(item.precio_venta_original) : null,
      stock_actual: Number(item.stock_actual) || 0,
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

function getPosProductPricing(product, options = {}) {
  return resolveProductUnitPricing(product, {
    targetCurrency: options.targetCurrency || posState.moneda,
    exchangeRate: options.exchangeRate !== undefined ? options.exchangeRate : posState.tipoCambio
  });
}

function getCartItemPricing(item) {
  return getPosProductPricing({
    precio_venta: item.precioGs,
    precio_venta_original: item.precioOriginalUsd,
    moneda_precio_venta: item.monedaPrecioVenta
  });
}

function renderCatalogPrice(product) {
  if (String(product?.moneda_precio_venta || 'PYG').toUpperCase() === 'USD' && Number(product?.precio_venta_original) > 0) {
    return `<div>${formatCurrency(product.precio_venta_original, 'USD')}</div><small>${formatCurrency(product.precio_venta, 'PYG')}</small>`;
  }
  return formatCurrency(product?.precio_venta || 0, 'PYG');
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
      precioGs: Number(product.precio_venta) || 0,
      precioOriginalUsd: product.precio_venta_original != null ? Number(product.precio_venta_original) : null,
      monedaPrecioVenta: product.moneda_precio_venta || 'PYG',
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
  posState.cliente = null;
  posState.descuento = 0;
  posState.ivaPorcentaje = 10;
  posState.moneda = 'PYG';
  posState.tipoCambio = null;
  posState.condicionVenta = 'CONTADO';
  posState.fechaVencimiento = null;
  posState.creditTipo = 'PLAZO';
  posState.entregaInicial = 0;
  posState.metodoEntrega = 'EFECTIVO';
  posState.cantidadCuotas = 3;
  posState.cuotas = [];
  posState.lastSale = null;
  posState.lastCreditoConfig = null;
  if (posDom.discountInput) posDom.discountInput.value = '';
  if (posDom.ivaSelect) posDom.ivaSelect.value = '10';
  if (posDom.condicionSelect) posDom.condicionSelect.value = 'CONTADO';
  if (posDom.comprobanteSelect) posDom.comprobanteSelect.value = 'FACTURA';
  if (posDom.creditEntregaInput) posDom.creditEntregaInput.value = '';
  if (posDom.creditMetodoSelect) posDom.creditMetodoSelect.value = 'EFECTIVO';
  if (posDom.fechaVencInput) posDom.fechaVencInput.value = '';
  if (posDom.creditTypeSelect) posDom.creditTypeSelect.value = 'PLAZO';
  if (posDom.cantidadCuotasInput) posDom.cantidadCuotasInput.value = 3;
  if (posDom.cuotasList) posDom.cuotasList.innerHTML = '';
  clearClientSearch();
  renderCurrencyControls();
  toggleCreditFields();
  renderClientSection();
  renderClientResults();
  renderCart();
  renderSummary();
  renderLastSale();
  setFeedback('', null);
  if (posDom.printButton) {
    posDom.printButton.hidden = true;
  }
  syncCheckoutForViewport();
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
  renderOverview();
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
              <div class="price">${renderCatalogPrice(item)}</div>
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
            const pricing = getCartItemPricing(item);
            const subtotal = round2(item.cantidad * pricing.unitGs);
            const stockLabel = item.stock ? `${formatNumber(item.stock, 0)} en stock` : 'Sin stock disponible';
            const isUsdSale = posState.moneda === 'USD' && Number(posState.tipoCambio) > 0;
            const amountLabel = isUsdSale && pricing.unitCurrency != null
              ? formatCurrency(pricing.unitCurrency, 'USD')
              : formatCurrency(pricing.unitGs, 'PYG');
            const subtotalLabel = isUsdSale && pricing.unitCurrency != null
              ? `${formatCurrency(round2(pricing.unitCurrency * item.cantidad), 'USD')} · ${formatCurrency(subtotal, 'PYG')}`
              : formatCurrency(subtotal, 'PYG');
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
                    <span>${amountLabel}</span>
                    <small>Subtotal: ${subtotalLabel}</small>
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
  const requiereCambio = posState.moneda === 'USD';
  const tipoCambioValido = Number(posState.tipoCambio) > 0;
  const tc = requiereCambio && tipoCambioValido ? Number(posState.tipoCambio) : null;
  let subtotal = 0;
  let subtotalMoneda = 0;

  posState.cart.forEach((item) => {
    const pricing = getCartItemPricing(item);
    subtotal += pricing.unitGs * item.cantidad;
    if (requiereCambio && tc && pricing.unitCurrency != null) {
      subtotalMoneda += pricing.unitCurrency * item.cantidad;
    }
  });

  subtotal = round2(subtotal);
  subtotalMoneda = round2(subtotalMoneda);

  const descuentoEntrada = Math.max(posState.descuento || 0, 0);
  const descuentoMoneda = tc ? Math.min(descuentoEntrada, subtotalMoneda) : Math.min(descuentoEntrada, subtotal);
  const descuentoGs = tc ? round2(descuentoMoneda * tc) : descuentoMoneda;

  const base = Math.max(subtotal - descuentoGs, 0);
  const divisor = IVA_DIVISOR[posState.ivaPorcentaje];
  const ivaCalculado = divisor && base > 0 ? base / divisor : 0;
  const total = base;
  return {
    subtotal,
    subtotalMoneda,
    descuento: descuentoGs,
    descuentoMoneda,
    base,
    ivaCalculado,
    total,
    totalMoneda: tc ? round2(Math.max(subtotalMoneda - descuentoMoneda, 0)) : null
  };
}

function toDateInputValue(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

function addDays(date, days) {
  const base = date instanceof Date ? date : new Date(date);
  const result = new Date(base.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function spreadCuotas(total, count) {
  const n = Math.max(1, Math.round(count) || 1);
  const totalCents = Math.round(total * 100);
  const baseCents = Math.round(totalCents / n);
  const cuotas = [];
  let remainingCents = totalCents;
  const start = new Date();
  for (let i = 0; i < n; i += 1) {
    const isLast = i === n - 1;
    const montoCents = isLast ? remainingCents : baseCents;
    const monto = montoCents / 100;
    remainingCents -= montoCents;
    const fecha = addDays(start, 30 * (i + 1));
    cuotas.push({
      numero: i + 1,
      monto: Math.round(monto * 100) / 100,
      fecha_vencimiento: toDateInputValue(fecha)
    });
  }
  return cuotas;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function syncCuotasPlanWithCurrentCredit() {
  if (posState.condicionVenta !== 'CREDITO' || posState.creditTipo !== 'CUOTAS') {
    return;
  }
  const totals = computeTotals();
  if (!(Number(totals.total || 0) > 0)) {
    posState.cuotas = [];
    renderCuotasList();
    return;
  }
  generateCuotasPlan();
}

function getFinancedAmount(totals, cambio) {
  const totalVenta = posState.moneda === 'USD' && cambio ? round2(totals.totalMoneda || 0) : round2(totals.total);
  const entregaInicial = round2(posState.entregaInicial || 0);
  return round2(Math.max(totalVenta - entregaInicial, 0));
}

function validateEntregaInicial(totals, cambio) {
  if (posState.condicionVenta !== 'CREDITO') return null;
  const totalVenta = posState.moneda === 'USD' && cambio ? round2(totals.totalMoneda || 0) : round2(totals.total);
  const entregaInicial = round2(posState.entregaInicial || 0);
  if (entregaInicial < 0) return 'La entrega inicial no puede ser negativa.';
  if (entregaInicial >= totalVenta && totalVenta > 0) {
    return 'La entrega inicial debe ser menor al total para usar crédito.';
  }
  return null;
}

function renderCurrencyControls() {
  if (!posDom) return;
  if (posDom.currencySelect) {
    posDom.currencySelect.value = posState.moneda || 'PYG';
  }
  if (posDom.exchangeRow) {
    const showExchange = posState.moneda === 'USD';
    posDom.exchangeRow.hidden = !showExchange;
    posDom.exchangeRow.style.display = showExchange ? '' : 'none';
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
  const cambio = tipoCambioValido ? Number(posState.tipoCambio) : null;
  const toUsd = (monto) => (cambio ? monto / cambio : 0);
  const subtotalUsd = requiereCambio && cambio ? totals.subtotalMoneda : 0;
  const descuentoUsd = requiereCambio && cambio ? totals.descuentoMoneda : toUsd(totals.descuento);
  const ivaUsd = requiereCambio && cambio ? toUsd(totals.ivaCalculado) : 0;
  const totalUsd = requiereCambio && cambio ? (totals.totalMoneda || 0) : 0;
  const isCredito = posState.condicionVenta === 'CREDITO';
  const showUsd = requiereCambio && cambio;
  const currencyMain = showUsd ? 'USD' : 'PYG';
  const planCurrency = posState.moneda === 'USD' && cambio ? 'USD' : 'PYG';
  const entregaInicial = isCredito ? round2(posState.entregaInicial || 0) : 0;
  const financedAmount = isCredito ? getFinancedAmount(totals, cambio) : 0;
  const planTotalBase = planCurrency === 'USD' ? financedAmount : financedAmount || totals.total;

  let summaryHtml = `
    <div class="row"><span>Subtotal</span><strong>${formatCurrency(showUsd ? subtotalUsd : totals.subtotal, currencyMain)}</strong></div>
    <div class="row"><span>Descuento</span><strong>${formatCurrency(showUsd ? descuentoUsd : totals.descuento, currencyMain)}</strong></div>
    <div class="row"><span>${getIvaLabel(posState.ivaPorcentaje)}</span><strong>${formatCurrency(showUsd ? ivaUsd : totals.ivaCalculado, currencyMain)}</strong></div>
    <div class="row total"><span>Total</span><strong>${formatCurrency(showUsd ? totalUsd : totals.total, currencyMain)}</strong></div>
    <div class="row"><span>Condición</span><strong>${isCredito ? 'Crédito' : 'Contado'}</strong></div>
  `;

  if (requiereCambio) {
    summaryHtml += `
      <div class="row"><span>Tipo de cambio</span><strong>${tipoCambioValido ? formatNumber(posState.tipoCambio, 4) : '—'} Gs.</strong></div>
      <div class="row total"><span>Total (USD)</span><strong>${
        tipoCambioValido ? formatCurrency(totalUsd, 'USD') : 'Completar tipo de cambio'
      }</strong></div>
      <div class="row"><span>Total (Gs.)</span><strong>${formatCurrency(totals.total, 'PYG')}</strong></div>
    `;
  }

  if (isCredito) {
    const isPlazo = posState.creditTipo === 'PLAZO';
    summaryHtml += `
      <div class="row"><span>Modalidad</span><strong>${isPlazo ? 'Plazo' : 'Cuotas'}</strong></div>
      <div class="row"><span>Entrega inicial</span><strong>${formatCurrency(entregaInicial, planCurrency)}</strong></div>
      <div class="row"><span>Saldo financiado</span><strong>${formatCurrency(financedAmount, planCurrency)}</strong></div>
    `;
    if (isPlazo) {
      summaryHtml += `
        <div class="row"><span>Vencimiento</span><strong>${posState.fechaVencimiento || 'Sin definir'}</strong></div>
      `;
    } else {
      const cuotas = Array.isArray(posState.cuotas) ? posState.cuotas : [];
      const cuotasTotal = round2(cuotas.reduce((acc, c) => acc + Number(c.monto || 0), 0));
      summaryHtml += `
        <div class="row"><span>Cuotas</span><strong>${cuotas.length || posState.cantidadCuotas || 0}</strong></div>
        <div class="row"><span>Total cuotas</span><strong>${formatCurrency(cuotasTotal || planTotalBase, planCurrency)}</strong></div>
      `;
    }
  }

  posDom.summaryTotals.innerHTML = summaryHtml;
  if (posDom.miniSubtotal) {
    posDom.miniSubtotal.textContent = `Subtotal: ${formatCurrency(showUsd ? subtotalUsd : totals.subtotal, currencyMain)}`;
  }
  if (posDom.miniTotal) {
    posDom.miniTotal.textContent = formatCurrency(showUsd ? totalUsd : totals.total, currencyMain);
  }
  renderOverview();
  const lastSaleEstado = String(posState.lastSale?.estado || '').toUpperCase();
  const lastSaleEsTicket = lastSaleEstado === 'TICKET';
  if (posDom.printButton) {
    posDom.printButton.hidden = !posState.lastSale || lastSaleEsTicket;
  }
  if (posDom.ticketButton) {
    posDom.ticketButton.hidden = !posState.lastSale || !lastSaleEsTicket;
  }
  updateActionStates();
}

function toggleCreditFields() {
  if (!posDom) return;
  if (posDom.comprobanteSelect) {
    posDom.comprobanteSelect.value = posState.comprobante;
  }
  const forceContado = posState.comprobante === 'TICKET';
  if (forceContado) {
    posState.condicionVenta = 'CONTADO';
    posState.fechaVencimiento = null;
    posState.creditTipo = 'PLAZO';
    posState.entregaInicial = 0;
    posState.cuotas = [];
  }
  const isCredito = posState.condicionVenta === 'CREDITO';
  if (posDom.condicionSelect) {
    posDom.condicionSelect.value = posState.condicionVenta;
    posDom.condicionSelect.disabled = forceContado;
  }
  if (posDom.creditRow) {
    posDom.creditRow.hidden = !isCredito;
    posDom.creditRow.style.display = isCredito ? '' : 'none';
  }
  if (posDom.creditTypeSelect) {
    posDom.creditTypeSelect.value = posState.creditTipo;
  }
  if (posDom.creditEntregaRow) {
    posDom.creditEntregaRow.hidden = !isCredito;
    posDom.creditEntregaRow.style.display = isCredito ? '' : 'none';
  }
  if (posDom.creditMetodoRow) {
    posDom.creditMetodoRow.hidden = !isCredito;
    posDom.creditMetodoRow.style.display = isCredito ? '' : 'none';
  }
  if (posDom.creditEntregaInput) {
    posDom.creditEntregaInput.value = posState.entregaInicial ? String(posState.entregaInicial) : '';
  }
  if (posDom.creditMetodoSelect) {
    posDom.creditMetodoSelect.value = posState.metodoEntrega || 'EFECTIVO';
  }

  // Si no es crédito, ocultamos todo lo relacionado y salimos
  if (!isCredito) {
    if (posDom.creditEntregaRow) { posDom.creditEntregaRow.hidden = true; posDom.creditEntregaRow.style.display = 'none'; }
    if (posDom.creditMetodoRow) { posDom.creditMetodoRow.hidden = true; posDom.creditMetodoRow.style.display = 'none'; }
    if (posDom.creditPlazoRow) { posDom.creditPlazoRow.hidden = true; posDom.creditPlazoRow.style.display = 'none'; }
    if (posDom.creditCuotasRow) { posDom.creditCuotasRow.hidden = true; posDom.creditCuotasRow.style.display = 'none'; }
    if (posDom.cuotasList) { posDom.cuotasList.hidden = true; posDom.cuotasList.style.display = 'none'; }
    posState.fechaVencimiento = null;
    posState.entregaInicial = 0;
    posState.metodoEntrega = 'EFECTIVO';
    posState.cuotas = [];
    posState.cantidadCuotas = 3;
    posState.creditTipo = 'PLAZO';
    renderCuotasList();
    renderSummary();
    return;
  }

  const isPlazo = posState.creditTipo === 'PLAZO';
  const isCuotas = posState.creditTipo === 'CUOTAS';

  if (posDom.creditPlazoRow) {
    posDom.creditPlazoRow.hidden = !isPlazo;
    posDom.creditPlazoRow.style.display = isPlazo ? '' : 'none';
  }
  if (posDom.creditCuotasRow) {
    posDom.creditCuotasRow.hidden = !isCuotas;
    posDom.creditCuotasRow.style.display = isCuotas ? '' : 'none';
  }
  if (posDom.cuotasList) {
    posDom.cuotasList.hidden = !isCuotas;
    posDom.cuotasList.style.display = isCuotas ? '' : 'none';
  }

  if (posDom.fechaVencInput && isPlazo) {
    posDom.fechaVencInput.value = posState.fechaVencimiento || '';
  }
  if (posDom.cantidadCuotasInput) {
    posDom.cantidadCuotasInput.value = posState.cantidadCuotas || 1;
  }
  renderCuotasList();
  renderSummary();
}

function renderCuotasList() {
  if (!posDom || !posDom.cuotasList) return;
  const show = posState.condicionVenta === 'CREDITO' && posState.creditTipo === 'CUOTAS';
  posDom.cuotasList.hidden = !show;
  if (!show) {
    posDom.cuotasList.innerHTML = '';
    return;
  }
  const cuotas = Array.isArray(posState.cuotas) ? posState.cuotas : [];
  if (!cuotas.length) {
    posDom.cuotasList.innerHTML = '<p class="empty">Genera un plan de cuotas.</p>';
    return;
  }
  const rows = cuotas
    .map(
      (cuota, idx) => `
        <tr data-pos-cuota-idx="${idx}">
          <td data-label="Nro">#${idx + 1}</td>
          <td data-label="Monto"><input type="number" min="0" step="0.01" data-pos-cuota-monto value="${round2(cuota.monto)}"></td>
          <td data-label="Vencimiento"><input type="date" data-pos-cuota-fecha value="${cuota.fecha_vencimiento || ''}"></td>
        </tr>
      `
    )
    .join('');
  posDom.cuotasList.innerHTML = `
    <table class="pos-cuotas-table">
      <thead><tr><th>Nro</th><th>Monto</th><th>Vencimiento</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function generateCuotasPlan() {
  const totals = computeTotals();
  const cambio = posState.moneda === 'USD' && Number(posState.tipoCambio) > 0 ? Number(posState.tipoCambio) : null;
  const entregaError = validateEntregaInicial(totals, cambio);
  if (entregaError) {
    setFeedback(entregaError, 'error');
    return;
  }
  const total = getFinancedAmount(totals, cambio);
  const n = Math.max(1, posState.cantidadCuotas || 1);
  if (!Number.isFinite(total) || total <= 0) {
    setFeedback('La entrega inicial no puede cubrir todo el saldo financiado.', 'error');
    return;
  }
  posState.creditTipo = 'CUOTAS';
  posState.cuotas = spreadCuotas(total, n);
  renderCuotasList();
}

function validateCuotas(totals, cambio) {
  const entregaError = validateEntregaInicial(totals, cambio);
  if (entregaError) return entregaError;
  const expected = getFinancedAmount(totals, cambio);
  const cuotas = Array.isArray(posState.cuotas) ? posState.cuotas : [];
  if (!cuotas.length) return 'Genera el plan de cuotas antes de continuar.';
  const sum = round2(cuotas.reduce((acc, c) => acc + Number(c.monto || 0), 0));
  if (Math.abs(sum - expected) > 0.01) {
    return 'La suma de cuotas debe igualar el saldo financiado.';
  }
  const missingDate = cuotas.some((c) => !c.fecha_vencimiento);
  if (missingDate) return 'Completa las fechas de vencimiento de todas las cuotas.';
  return null;
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
  const esTicket = String(venta.estado || '').toUpperCase() === 'TICKET';
  const totalUsd = isUsd
    ? Number(venta.total_moneda) ||
      (Number(venta.tipo_cambio) && Number(venta.tipo_cambio) > 0 ? totalGs / Number(venta.tipo_cambio) : null)
    : null;
  posDom.lastSale.hidden = false;
  posDom.lastSale.innerHTML = `
    <h4>Venta registrada</h4>
    <p>Tipo: ${esTicket ? 'Ticket' : 'Factura/venta'}</p>
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
  const comprobanteEsTicket = posState.comprobante === 'TICKET';
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
  const cambio = posState.moneda === 'USD' && Number(posState.tipoCambio) > 0 ? Number(posState.tipoCambio) : null;
  if (totals.descuento > totals.subtotal) {
    setFeedback('El descuento no puede superar al subtotal.', 'error');
    updateActionStates();
    return;
  }

  if (comprobanteEsTicket) {
    posState.condicionVenta = 'CONTADO';
    posState.fechaVencimiento = null;
  }

  const isCredito = !comprobanteEsTicket && posState.condicionVenta === 'CREDITO';
  if (isCredito && !posState.cliente) {
    setFeedback('Selecciona un cliente para ventas a crédito.', 'error');
    updateActionStates();
    focusClientSearch();
    return;
  }
  const isPlazo = isCredito && posState.creditTipo === 'PLAZO';
  const isCuotas = isCredito && posState.creditTipo === 'CUOTAS';
  if (isPlazo && !posState.fechaVencimiento) {
    setFeedback('Ingresa la fecha de vencimiento para el plazo.', 'error');
    updateActionStates();
    if (posDom?.fechaVencInput) posDom.fechaVencInput.focus();
    return;
  }
  if (isCuotas) {
    const errorCuotas = validateCuotas(totals, cambio);
    if (errorCuotas) {
      setFeedback(errorCuotas, 'error');
      updateActionStates();
      if (posDom?.cuotasList) {
        const firstInput = posDom.cuotasList.querySelector('input');
        if (firstInput) firstInput.focus();
      }
      return;
    }
  }

  if (isCredito) {
    const entregaError = validateEntregaInicial(totals, cambio);
    if (entregaError) {
      setFeedback(entregaError, 'error');
      updateActionStates();
      if (posDom?.creditEntregaInput) posDom.creditEntregaInput.focus();
      return;
    }
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
    let creditoPayload = undefined;
    if (isCredito) {
      if (isPlazo) {
        creditoPayload = {
          tipo: 'PLAZO',
          fecha_vencimiento: posState.fechaVencimiento || undefined,
          entrega_inicial: round2(posState.entregaInicial || 0),
          metodo_entrega: round2(posState.entregaInicial || 0) > 0 ? posState.metodoEntrega : undefined
        };
      }
      if (isCuotas) {
        creditoPayload = {
          tipo: 'CUOTAS',
          entrega_inicial: round2(posState.entregaInicial || 0),
          metodo_entrega: round2(posState.entregaInicial || 0) > 0 ? posState.metodoEntrega : undefined,
          cantidad_cuotas: Math.max(1, posState.cuotas.length || posState.cantidadCuotas || 1),
          cuotas: (posState.cuotas || []).map((c, idx) => ({
            numero: idx + 1,
            monto: round2(c.monto),
            fecha_vencimiento: c.fecha_vencimiento
          }))
        };
      }
    }

    posState.lastCreditoConfig = creditoPayload || null;

    const payload = {
      usuarioId: session.id,
      clienteId: posState.cliente?.id || undefined,
      iva_porcentaje: posState.ivaPorcentaje,
      // Enviamos el descuento en la moneda de la venta (USD si la venta es USD); el backend convierte a Gs.
      descuento_total: Number(posState.descuento) || 0,
      moneda: posState.moneda,
      tipo_cambio: posState.moneda === 'USD' ? posState.tipoCambio : undefined,
      condicion_venta: posState.condicionVenta,
      estado: comprobanteEsTicket ? 'TICKET' : undefined,
      fecha_vencimiento: isCredito && isPlazo ? posState.fechaVencimiento : undefined,
      credito: creditoPayload,
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
    const esTicket = String(venta?.estado || '').toUpperCase() === 'TICKET';
    if (posDom.printButton) {
      posDom.printButton.hidden = esTicket;
    }
    if (posDom.ticketButton) {
      posDom.ticketButton.hidden = !esTicket;
    }
    posState.cart = [];
    posState.descuento = 0;
    posState.creditTipo = 'PLAZO';
    posState.entregaInicial = 0;
    posState.metodoEntrega = 'EFECTIVO';
    posState.cantidadCuotas = 3;
    posState.cuotas = [];
    posState.lastCreditoConfig = creditoPayload || null;
    if (posDom.discountInput) posDom.discountInput.value = '';
    if (posDom.creditTypeSelect) posDom.creditTypeSelect.value = 'PLAZO';
    if (posDom.creditEntregaInput) posDom.creditEntregaInput.value = '';
    if (posDom.creditMetodoSelect) posDom.creditMetodoSelect.value = 'EFECTIVO';
    if (posDom.cantidadCuotasInput) posDom.cantidadCuotasInput.value = 3;
    if (posDom.cuotasList) posDom.cuotasList.innerHTML = '';
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
  let pendingInvoiceWindow = null;
  try {
    let currentSale = posState.lastSale;
    try {
      const refreshedSale = await fetchVentaById(posState.lastSale.id);
      if (refreshedSale) {
        currentSale = refreshedSale;
        posState.lastSale = refreshedSale;
        renderLastSale();
      }
    } catch (refreshError) {
      console.warn('[POS] No se pudo refrescar la venta antes de facturar.', refreshError);
    }

    const existingPdfUrl = getFacturaPdfUrl(currentSale?.factura_electronica);
    const existingCanonicalPdfUrl = isCanonicalFacturaPdfUrl(existingPdfUrl) ? existingPdfUrl : null;
    if (currentSale?.factura_electronica?.id) {
      if (existingCanonicalPdfUrl) {
        const opened = openUrlInNewTab(existingCanonicalPdfUrl, {
          blockedTitle: 'No se pudo abrir la factura',
          blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF de la factura.'
        });
        if (!opened) {
          setFeedback('No se pudo abrir la factura. Desbloquea las ventanas emergentes para descargar el PDF.', 'warn');
        } else {
          setFeedback('Factura electrónica abierta en una nueva pestaña.', 'success');
        }
        return;
      }

      setFeedback('La factura ya fue emitida. Esperando el PDF canónico de FactPy...', 'info');
      const refreshed = await waitForCanonicalFacturaPdf(currentSale.id);
      if (refreshed?.venta) {
        posState.lastSale = refreshed.venta;
        renderLastSale();
      }
      if (refreshed?.pdfUrl) {
        const opened = openUrlInNewTab(refreshed.pdfUrl, {
          blockedTitle: 'No se pudo abrir la factura',
          blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF de la factura.'
        });
        if (!opened) {
          setFeedback('No se pudo abrir la factura. Desbloquea las ventanas emergentes para descargar el PDF.', 'warn');
        } else {
          setFeedback('Factura electrónica abierta en una nueva pestaña.', 'success');
        }
      } else {
        setFeedback('La factura ya fue emitida, pero FactPy aún no devolvió el PDF. Ábrela luego desde Ventas con "Ver factura".', 'warn');
      }
      return;
    }

    setFeedback('Generando factura digital...', 'info');
    pendingInvoiceWindow = createDeferredDocumentWindow({
      pendingTitle: 'Generando factura...',
      pendingDescription: 'La factura electrónica se está procesando. Esta pestaña mostrará el PDF apenas esté listo.',
      blockedTitle: 'No se pudo abrir la factura',
      blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF de la factura.'
    });
    const facturarBody = {};
    if (currentSale?.condicion_venta) {
      facturarBody.condicion_pago = currentSale.condicion_venta;
    }
    const creditConfig = posState.lastCreditoConfig || currentSale?.credito_config || null;
    if (creditConfig) {
      facturarBody.credito = creditConfig;
      if (creditConfig.fecha_vencimiento && !facturarBody.fecha_vencimiento) {
        facturarBody.fecha_vencimiento = creditConfig.fecha_vencimiento;
      }
    } else if (currentSale?.fecha_vencimiento) {
      facturarBody.fecha_vencimiento = currentSale.fecha_vencimiento;
    }

    const response = await request(`/ventas/${currentSale.id}/facturar`, {
      method: 'POST',
      body: facturarBody
    });
    let facturaElectronica = response?.factura || null;
    let venta = mergeVentaFacturaState(response?.venta || response, facturaElectronica);
    facturaElectronica = venta?.factura_electronica || facturaElectronica;
    let pdfUrl = isCanonicalFacturaPdfUrl(getFacturaPdfUrl(facturaElectronica))
      ? getFacturaPdfUrl(facturaElectronica)
      : null;
    const facturaTipo = 'electrónica';
    if (!venta) {
      throw new Error('No se recibió la venta generada.');
    }

    if (!pdfUrl) {
      const refreshed = await waitForCanonicalFacturaPdf(venta.id);
      if (refreshed?.venta) {
        venta = mergeVentaFacturaState(refreshed.venta, facturaElectronica);
        facturaElectronica = venta.factura_electronica;
      }
      if (refreshed?.pdfUrl) {
        pdfUrl = refreshed.pdfUrl;
      }
    }

    posState.lastSale = mergeVentaFacturaState(venta, facturaElectronica);
    renderLastSale();

    if (pdfUrl) {
      const opened = pendingInvoiceWindow.navigate(pdfUrl);
      if (!opened) {
        setFeedback(`Factura ${facturaTipo} generada. Desbloquea las ventanas emergentes para descargar el PDF.`, 'warn');
      } else {
        setFeedback(`Factura ${facturaTipo} generada. El PDF se abrió en una nueva pestaña.`, 'success');
      }
    } else {
      pendingInvoiceWindow.close();
      setFeedback(`Factura ${facturaTipo} generada, pero FactPy aún no devolvió el PDF. Ábrela luego desde Ventas con "Ver factura".`, 'warn');
    }
  } catch (error) {
    pendingInvoiceWindow?.close();
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

function getFacturaPdfUrl(facturaElectronica) {
  const electronicaPdfPath = facturaElectronica?.pdf_path;
  if (electronicaPdfPath) {
    return /^https?:\/\//i.test(electronicaPdfPath)
      ? electronicaPdfPath
      : urlWithSession(electronicaPdfPath);
  }

  return null;
}

async function fetchVentaById(id) {
  if (!id) return null;
  const query = buildQuery({ search: id });
  const response = await request(`/ventas?${query}`);
  const ventas = Array.isArray(response?.data)
    ? response.data
    : Array.isArray(response?.ventas)
      ? response.ventas
      : Array.isArray(response)
        ? response
        : [];
  return ventas.find((venta) => venta?.id === id) || null;
}

async function waitForCanonicalFacturaPdf(ventaId, {
  attempts = FACTURA_PDF_POLL_ATTEMPTS,
  delayMs = FACTURA_PDF_POLL_DELAY_MS
} = {}) {
  let latestVenta = null;

  for (let index = 0; index < attempts; index += 1) {
    latestVenta = await fetchVentaById(ventaId);
    const latestPdfPath = latestVenta?.factura_electronica?.pdf_path;
    if (isCanonicalFacturaPdfUrl(latestPdfPath)) {
      return {
        venta: latestVenta,
        pdfUrl: latestPdfPath
      };
    }

    if (index < attempts - 1) {
      await delay(delayMs);
    }
  }

  return {
    venta: latestVenta,
    pdfUrl: null
  };
}

async function generateTicket() {
  if (!posState.lastSale) {
    setFeedback('Registra una venta antes de imprimir el ticket.', 'info');
    return;
  }
  const isTicketSale = String(posState.lastSale?.estado || '').toUpperCase() === 'TICKET';
  if (!isTicketSale) {
    setFeedback('Esta venta está marcada para factura. Selecciona Ticket antes de confirmar.', 'warn');
    return;
  }
  const defaultLabel = posDom?.ticketButton?.dataset?.defaultLabel || 'Imprimir ticket';
  if (posDom?.ticketButton) {
    posDom.ticketButton.disabled = true;
    posDom.ticketButton.textContent = 'Abriendo...';
  }
  try {
    const ticketUrl = urlWithSession(`/ventas/${encodeURIComponent(posState.lastSale.id)}/ticket/pdf`);
    const win = openUrlInNewTab(ticketUrl, {
      blockedTitle: 'No se pudo abrir el ticket',
      blockedDescription: 'Desbloquea las ventanas emergentes para ver el ticket.'
    });
    if (!win) {
      setFeedback('No se pudo abrir el ticket. Desbloquea las ventanas emergentes.', 'warn');
    } else {
      setFeedback('Ticket PDF abierto en una nueva pestaña.', 'success');
    }
  } catch (error) {
    console.error(error);
    setFeedback(error.message || 'No se pudo generar el ticket.', 'error');
  } finally {
    if (posDom?.ticketButton) {
      posDom.ticketButton.disabled = false;
      posDom.ticketButton.textContent = defaultLabel;
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
          <div><span>${getIvaLabel(venta?.iva_porcentaje || 10)}</span><span>${formatCurrency(totals.iva, 'PYG')}</span></div>
          <div class="total"><span>Total</span><span>${formatCurrency(totals.total, 'PYG')}</span></div>
          <div class="row"><span>Total en letras</span><span>${escapeHtml(montoEnLetras(totals.total, venta?.moneda || 'PYG'))}</span></div>
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
  const parsedIva = Number(venta?.iva_porcentaje);
  const ivaPorcentaje = Number.isFinite(parsedIva) ? parsedIva : 10;
  const divisor = IVA_DIVISOR[ivaPorcentaje];
  const iva = divisor && total > 0 ? total / divisor : 0;
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
  const cambio = requiereTipoCambio && tipoCambioValido ? Number(posState.tipoCambio) : null;
  const isCredito = posState.condicionVenta === 'CREDITO';
  const hasCliente = Boolean(posState.cliente);
  const isPlazo = isCredito && posState.creditTipo === 'PLAZO';
  const isCuotas = isCredito && posState.creditTipo === 'CUOTAS';
  const totals = computeTotals();
  const hasVencimiento = !!posState.fechaVencimiento;
  const entregaValid = !isCredito || validateEntregaInicial(totals, cambio) === null;
  const cuotasValid = !isCuotas || validateCuotas(totals, cambio) === null;
  const creditoOk = !isCredito || (hasCliente && entregaValid && (!isPlazo || hasVencimiento) && cuotasValid);
  const canConfirm = hasCart && (!requiereTipoCambio || tipoCambioValido) && creditoOk;

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
  if (posDom.ticketButton) {
    posDom.ticketButton.disabled = posState.loading || posDom.ticketButton.hidden;
  }

  if (posDom.checkoutToggle) {
    posDom.checkoutToggle.disabled = posState.loading && !isMobileCheckout();
  }

  if (posDom.overviewSearchButton) {
    posDom.overviewSearchButton.disabled = posState.loading;
  }

  if (posDom.overviewCheckoutButton) {
    posDom.overviewCheckoutButton.disabled = posState.loading || !hasCart;
  }
}

function renderOverview() {
  if (!posDom) return;
  const totals = computeTotals();
  const requiereCambio = posState.moneda === 'USD';
  const tipoCambioValido = requiereCambio && Number(posState.tipoCambio) > 0;
  const currencyMain = requiereCambio && tipoCambioValido ? 'USD' : 'PYG';
  const totalMain = requiereCambio && tipoCambioValido ? (totals.totalMoneda || 0) : totals.total;
  const itemCount = posState.cart.reduce((acc, item) => acc + Number(item.cantidad || 0), 0);
  const clientLabel = posState.cliente?.nombre_razon_social || 'Eventual';

  if (posDom.overviewClient) {
    posDom.overviewClient.textContent = clientLabel;
    posDom.overviewClient.title = clientLabel;
  }
  if (posDom.overviewItems) {
    posDom.overviewItems.textContent = formatNumber(itemCount, 0);
  }
  if (posDom.overviewTotal) {
    posDom.overviewTotal.textContent = formatCurrency(totalMain, currencyMain);
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
    posDom.exchangeInput,
    posDom.comprobanteSelect
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
  if (posDom.ticketButton) {
    posDom.ticketButton.disabled = posState.loading || posDom.ticketButton.hidden;
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

function isMobileCheckout() {
  if (checkoutMediaQuery) {
    return checkoutMediaQuery.matches;
  }
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
}

function setCheckoutExpanded(expanded) {
  if (!posDom?.checkout || !posDom?.checkoutToggle || !posDom?.checkoutBody) return;
  const shouldExpand = !isMobileCheckout() || Boolean(expanded);
  posDom.checkout.classList.toggle('is-expanded', shouldExpand);
  posDom.checkoutBody.hidden = !shouldExpand;
  posDom.checkoutToggle.setAttribute('aria-expanded', shouldExpand ? 'true' : 'false');
}

function expandCheckoutAndScroll() {
  if (!posDom?.checkout) return;
  setCheckoutExpanded(true);
  if (typeof posDom.checkout.scrollIntoView === 'function') {
    posDom.checkout.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function syncCheckoutForViewport() {
  if (!posDom?.checkout) return;
  if (isMobileCheckout()) {
    const shouldExpand = posState.cart.length === 0 || posState.condicionVenta === 'CREDITO' || Boolean(posState.lastSale);
    setCheckoutExpanded(shouldExpand);
    return;
  }
  setCheckoutExpanded(true);
}

function attachCheckoutMediaListener() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (!checkoutMediaQuery) {
    checkoutMediaQuery = window.matchMedia('(max-width: 768px)');
  }
  if (checkoutMediaQuery.__posCheckoutBound) return;

  const listener = () => {
    syncCheckoutForViewport();
  };

  if (typeof checkoutMediaQuery.addEventListener === 'function') {
    checkoutMediaQuery.addEventListener('change', listener);
  } else if (typeof checkoutMediaQuery.addListener === 'function') {
    checkoutMediaQuery.addListener(listener);
  }
  checkoutMediaQuery.__posCheckoutBound = true;
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
