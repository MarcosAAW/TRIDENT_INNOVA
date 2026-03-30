import { request, buildQuery, urlWithSession } from '../common/api.js';
import { formatCurrency } from '../common/format.js';
import { resolveProductUnitPricing } from '../common/pricing.js';
import { createPresupuesto, buildPresupuestoPayload } from './nuevo.js';

async function updateEstadoPresupuesto(id, estado) {
  return request(`/presupuestos/${encodeURIComponent(id)}/estado`, {
    method: 'PUT',
    body: { estado }
  });
}

let listVisibilityCleanup = [];
let pdfHandlerAttached = false;
let estadoHandlerAttached = false;

function cleanupListVisibility() {
  if (Array.isArray(listVisibilityCleanup)) {
    listVisibilityCleanup.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn('[Presupuestos] Limpieza de visibilidad', err);
      }
    });
  }
  listVisibilityCleanup = [];

  const listCard = document.querySelector('.list-card');
  const pagination = document.querySelector('#pagination');
  const filterBar = document.querySelector('.list-actions');
  const panelBody = document.querySelector('.panel-body');
  const formCard = document.querySelector('.form-card');
  if (listCard) listCard.style.display = '';
  if (pagination) pagination.style.display = '';
  if (filterBar) filterBar.style.display = '';
  if (panelBody) panelBody.classList.remove('presupuesto-expanded', 'presupuestos');
  if (formCard) formCard.classList.remove('presupuestos-form');
}

function syncListVisibility() {
  const listCard = document.querySelector('.list-card');
  const pagination = document.querySelector('#pagination');
  const filterBar = document.querySelector('.list-actions');
  const formCard = document.querySelector('.form-card');
  const panelBody = document.querySelector('.panel-body');
  const isFormVisible = formCard && formCard.style.display !== 'none';
  const showList = !isFormVisible;

  if (panelBody) {
    panelBody.classList.add('presupuestos');
    panelBody.classList.toggle('presupuesto-expanded', !showList);
  }
  if (formCard) {
    formCard.classList.add('presupuestos-form');
  }

  if (listCard) listCard.style.display = showList ? '' : 'none';
  if (pagination) pagination.style.display = showList ? '' : 'none';
  if (filterBar) filterBar.style.display = showList ? '' : 'none';
}

function setupListVisibilitySync() {
  cleanupListVisibility();

  const toggleBtn = document.getElementById('toggle-form-card');
  const cancelBtn = document.getElementById('cancel-edit');

  const attach = (el) => {
    if (!el) return;
    const handler = () => {
      setTimeout(syncListVisibility, 0);
    };
    el.addEventListener('click', handler);
    listVisibilityCleanup.push(() => el.removeEventListener('click', handler));
  };

  syncListVisibility();
  attach(toggleBtn);
  attach(cancelBtn);
}

const ESTADO_OPTIONS = [
  { value: 'GENERADO', label: 'Generado' },
  { value: 'VENCIDO', label: 'Vencido' }
];

const ESTADO_LABEL = ESTADO_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

function renderEstado(valor) {
  if (!valor) return '-';
  const label = ESTADO_LABEL[valor] || valor;
  if (valor === 'GENERADO') return `<span class="badge info">${label}</span>`;
  if (valor === 'VENCIDO') return `<span class="badge error">${label}</span>`;
  return label;
}

function renderTotal(item) {
  const total = item?.total ?? null;
  const moneda = (item?.moneda || 'PYG').toUpperCase();
  const totalMoneda = item?.total_moneda ?? null;
  if (moneda === 'USD') {
    const usdLabel = totalMoneda !== null ? formatCurrency(totalMoneda, 'USD') : '-';
    const gsLabel = total !== null ? formatCurrency(total, 'PYG') : '-';
    return `<div>${usdLabel}</div><div class="badge">${gsLabel}</div>`;
  }
  return total !== null ? formatCurrency(total, 'PYG') : '-';
}

function attachPdfHandler() {
  if (pdfHandlerAttached) return;

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-presupuesto-pdf]');
    if (!btn) return;
    event.preventDefault();
    const id = btn.dataset.presupuestoPdf;
    if (!id) return;

    const url = urlWithSession(`/presupuestos/${encodeURIComponent(id)}/pdf`);
    const win = window.open(url, '_blank');
    if (!win || win.closed || typeof win.closed === 'undefined') {
      alert('Permití las ventanas emergentes para ver el PDF del presupuesto.');
    }
  });

  pdfHandlerAttached = true;
}

function attachEstadoHandler() {
  if (estadoHandlerAttached) return;

  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-estado-id]');
    if (!btn) return;
    event.preventDefault();

    const id = btn.dataset.estadoId;
    const target = btn.dataset.estadoTarget;
    if (!id || !target) return;

    const confirmMsg = target === 'VENCIDO'
      ? '¿Marcar este presupuesto como VENCIDO?'
      : '¿Marcar este presupuesto como GENERADO?';
    const ok = window.confirm(confirmMsg);
    if (!ok) return;

    btn.disabled = true;
    try {
      await updateEstadoPresupuesto(id, target);
      // Refresh list silently
      const reloadBtn = document.querySelector('[data-refresh-list]') || document.getElementById('refresh-list');
      if (reloadBtn) {
        reloadBtn.click();
      } else {
        window.location.reload();
      }
    } catch (err) {
      console.error('[Presupuestos] No se pudo actualizar el estado', err);
      alert('No se pudo actualizar el estado del presupuesto.');
    } finally {
      btn.disabled = false;
    }
  });

  estadoHandlerAttached = true;
}

export const presupuestosModule = {
  key: 'presupuestos',
  label: 'Presupuestos',
  labelSingular: 'Presupuesto',
  singular: 'Presupuesto',
  singularLower: 'presupuesto',
  focusFormLayout: true,
  endpoint: '/presupuestos',
  pageSize: 10,
  searchPlaceholder: 'Buscar por número o cliente',
  supportsForm: true,
  filters: [
    {
      name: 'estado',
      label: 'Estado',
      type: 'select',
      options: [{ value: '', label: 'Todos' }, ...ESTADO_OPTIONS]
    }
  ],
  fields: [
    { name: 'clienteId', label: 'Cliente', type: 'select', options: [{ value: '', label: 'Elegí un cliente' }] },
    {
      name: 'detalles',
      label: 'Ítems del presupuesto',
      type: 'textarea',
      rows: 2,
      placeholder: 'Se completa automáticamente al agregar ítems',
      helperText: 'Agregá ítems usando el constructor de líneas (producto, cantidad, precio, IVA).'
    },
    { name: 'validez_hasta', label: 'Válido hasta', type: 'date' },
    {
      name: 'moneda',
      label: 'Moneda',
      type: 'select',
      defaultValue: 'PYG',
      options: [
        { value: 'PYG', label: 'Guaraníes (PYG)' },
        { value: 'USD', label: 'Dólares (USD)' }
      ]
    },
    {
      name: 'tipo_cambio',
      label: 'Tipo de cambio (PYG → moneda)',
      type: 'number',
      step: '0.0001',
      cast: 'float',
      helperText: 'Obligatorio solo si usás USD.'
    },
    { name: 'descuento_total', label: 'Descuento total', type: 'number', step: '0.01', cast: 'float' },
    { name: 'notas', label: 'Notas', type: 'textarea', rows: 3 }
  ],
  columns: [
    { header: 'Número', accessor: (item) => item.numero || '-' },
    { header: 'Cliente', accessor: (item) => item.cliente_nombre || item.cliente?.nombre_razon_social || '-' },
    { header: 'Fecha', accessor: (item) => (item.fecha ? new Date(item.fecha).toLocaleDateString('es-PY') : '-') },
    { header: 'Validez', accessor: (item) => (item.validez_hasta ? new Date(item.validez_hasta).toLocaleDateString('es-PY') : '-') },
    { header: 'Estado', render: (item) => renderEstado(item.estado) },
    { header: 'Total', render: renderTotal },
    {
      header: 'PDF',
      render: (item) => item?.id
        ? `<button type="button" class="btn ghost small" data-presupuesto-pdf="${item.id}">Ver PDF</button>`
        : '-'
    },
    {
      header: 'Cambiar estado',
      render: (item) => {
        if (!item?.id) return '-';
        const esVencido = String(item.estado || '').toUpperCase() === 'VENCIDO';
        const target = esVencido ? 'GENERADO' : 'VENCIDO';
        const label = esVencido ? 'Marcar generado' : 'Marcar vencido';
        return `<button type="button" class="btn small" data-estado-id="${item.id}" data-estado-target="${target}">${label}</button>`;
      }
    }
  ],
  actions: {
    nuevo: {
      transform: buildPresupuestoPayload,
      submit: createPresupuesto,
      successMessage: 'Presupuesto creado correctamente.'
    }
  },
  hooks: {
    afterModuleChange() {
      setupListVisibilitySync();
      attachPdfHandler();
      attachEstadoHandler();
    },
    beforeModuleChange() {
      cleanupListVisibility();
    },
    afterFormRender({ form, setVisibility }) {
      const monedaField = form?.elements?.moneda;
      const tipoCambioField = form?.elements?.tipo_cambio;
      const detallesField = form?.elements?.detalles;
      const clienteField = form?.elements?.clienteId;
      const descuentoField = form?.elements?.descuento_total;

      const itemsState = [];
      let repriceItemsForFormCurrency = () => {};

      const setSpan = (fieldName, className) => {
        const control = form?.elements?.[fieldName];
        if (!control) return;
        const wrapper = control.closest('.form-field');
        if (wrapper) wrapper.classList.add(className);
      };

      const descuentoLabel = descuentoField?.closest('.form-field')?.querySelector('label');

      const syncDescuentoLabel = () => {
        const currency = String(monedaField?.value || 'PYG').toUpperCase();
        if (descuentoLabel) {
          descuentoLabel.textContent = currency === 'USD' ? 'Descuento total (USD)' : 'Descuento total (Gs.)';
        }
        if (descuentoField) {
          descuentoField.placeholder = currency === 'USD' ? 'Ej: 50 (USD)' : 'Ej: 50.000 (Gs)';
        }
      };

      let clientesCache = [];

      const clienteSearchInput = document.createElement('input');
      clienteSearchInput.type = 'search';
      clienteSearchInput.placeholder = 'Buscar cliente (nombre o CI/RUC)';
      clienteSearchInput.autocomplete = 'off';
      clienteSearchInput.className = 'cliente-search__input';

      const clienteSuggestions = document.createElement('div');
      clienteSuggestions.className = 'items-builder__suggestions cliente-search__suggestions';

      const clienteSearchWrapper = document.createElement('div');
      clienteSearchWrapper.className = 'cliente-search';
      clienteSearchWrapper.appendChild(clienteSearchInput);
      clienteSearchWrapper.appendChild(clienteSuggestions);

      async function loadClientes() {
        if (!clienteField) return;
        try {
          const res = await request('/clientes?pageSize=200');
          const data = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
          clientesCache = data;
          clienteField.innerHTML = '<option value="">Elegí un cliente</option>' +
            data.map((c) => `<option value="${c.id}">${(c.nombre_razon_social || '').replace(/</g, '&lt;')}</option>`).join('');
        } catch (err) {
          console.warn('[Presupuestos] No se pudieron cargar clientes', err);
          clientesCache = [];
        }
      }

      function renderClienteSuggestions(query = '') {
        const normalized = (query || '').trim().toLowerCase();
        if (!normalized || normalized.length < 2) {
          clienteSuggestions.innerHTML = '';
          clienteSuggestions.style.display = 'none';
          return;
        }

        const filtered = clientesCache
          .filter((c) => {
            const nombre = (c.nombre_razon_social || '').toLowerCase();
            const ruc = (c.ruc || c.documento || '').toLowerCase();
            return nombre.includes(normalized) || (ruc && ruc.includes(normalized));
          })
          .slice(0, 8);

        if (!filtered.length) {
          clienteSuggestions.innerHTML = '<p class="muted" style="margin:4px 0;">Sin coincidencias</p>';
          clienteSuggestions.style.display = 'block';
          return;
        }

        clienteSuggestions.innerHTML = filtered
          .map((c) => {
            const nombre = (c.nombre_razon_social || '').replace(/</g, '&lt;');
            const doc = (c.ruc || c.documento || '').replace(/</g, '&lt;');
            return `<button type="button" class="suggestion-btn" data-id="${c.id}" data-label="${nombre}" data-doc="${doc}">${nombre}${doc ? ` · ${doc}` : ''}</button>`;
          })
          .join('');
        clienteSuggestions.style.display = 'block';
      }

      let productosCache = [];

      async function loadProductos() {
        try {
          const res = await request('/productos?pageSize=50');
          const data = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
          productosCache = data;
          return data;
        } catch (err) {
          console.warn('[Presupuestos] No se pudieron cargar productos', err);
          return [];
        }
      }

      function findProducto(id) {
        return productosCache.find((p) => p.id === id) || null;
      }

      function syncDetallesField() {
        if (detallesField) {
          detallesField.value = JSON.stringify(itemsState.map(({ productoId, cantidad, precio_unitario, iva_porcentaje, moneda_precio_unitario }) => ({
            productoId: productoId || undefined,
            cantidad,
            precio_unitario,
            iva_porcentaje,
            moneda_precio_unitario
          })));
        }
      }

      function getFormCurrency() {
        return String(form?.elements?.moneda?.value || 'PYG').toUpperCase();
      }

      function getFormExchangeRate() {
        const raw = Number(form?.elements?.tipo_cambio?.value || 0);
        return Number.isFinite(raw) && raw > 0 ? raw : null;
      }

      function renderItemsList(container) {
        if (!container) return;
        if (!itemsState.length) {
          container.innerHTML = '<p class="muted">Sin ítems cargados.</p>';
          return;
        }
        container.innerHTML = `
          <div class="items-table">
            <div class="items-row header">
              <span>Producto</span>
              <span>Cantidad</span>
              <span>Precio</span>
              <span>IVA</span>
              <span></span>
            </div>
            ${itemsState.map((item, idx) => {
              const producto = findProducto(item.productoId);
              const nombre = item.nombre || producto?.nombre || producto?.sku || 'Ítem libre';
              const monedaPrecio = String(item.moneda_precio_unitario || 'PYG').toUpperCase();
              const precio = formatCurrency(item.precio_unitario, monedaPrecio);
              return `
                <div class="items-row">
                  <span>${nombre}</span>
                  <span>${item.cantidad}</span>
                  <span>${precio}</span>
                  <span>${item.iva_porcentaje || 10}%</span>
                  <button type="button" class="btn ghost small" data-remove-index="${idx}">Quitar</button>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      function buildItemsBuilder(detallesWrapper) {
        if (!detallesWrapper) return;
        const builder = document.createElement('div');
        builder.className = 'items-builder';

        const row = document.createElement('div');
        row.className = 'items-builder-row';
        row.style.position = 'relative';

        const productoInput = document.createElement('input');
        productoInput.type = 'search';
        productoInput.placeholder = 'Buscar producto (nombre o SKU)';
        productoInput.className = 'items-builder__producto';
        productoInput.autocomplete = 'off';

        const productoIdHidden = document.createElement('input');
        productoIdHidden.type = 'hidden';
        productoIdHidden.className = 'items-builder__productoId';

        const suggestions = document.createElement('div');
        suggestions.className = 'items-builder__suggestions';

          const searchWrapper = document.createElement('div');
          searchWrapper.className = 'items-builder__search';
          searchWrapper.appendChild(productoInput);
          searchWrapper.appendChild(productoIdHidden);
          searchWrapper.appendChild(suggestions);

        const cantidadInput = document.createElement('input');
        cantidadInput.type = 'number';
        cantidadInput.min = '1';
        cantidadInput.step = '1';
        cantidadInput.value = '1';
        cantidadInput.placeholder = 'Cantidad';
        cantidadInput.className = 'items-builder__cantidad';

        const precioInput = document.createElement('input');
        precioInput.type = 'number';
        precioInput.min = '0';
        precioInput.step = '0.01';
        precioInput.placeholder = 'Precio';
        precioInput.className = 'items-builder__precio';
        let precioFueEditadoManualmente = false;

        const ivaSelect = document.createElement('select');
        ivaSelect.className = 'items-builder__iva';
        ivaSelect.innerHTML = '<option value="10">IVA 10%</option><option value="5">IVA 5%</option><option value="0">Exento</option>';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn secondary small';
        addBtn.textContent = 'Agregar ítem';

        const topRow = document.createElement('div');
        topRow.className = 'items-builder-row';
        topRow.style.position = 'relative';
        topRow.appendChild(searchWrapper);
        topRow.appendChild(precioInput);
        topRow.appendChild(ivaSelect);
        topRow.appendChild(addBtn);

        const quantityRow = document.createElement('div');
        quantityRow.className = 'items-builder-row items-builder-row--secondary';
        const stockHint = document.createElement('small');
        stockHint.className = 'muted';
        const stockWrapper = document.createElement('div');
        stockWrapper.className = 'items-builder__stock';
        stockWrapper.appendChild(stockHint);
        quantityRow.appendChild(cantidadInput);
        quantityRow.appendChild(stockWrapper);
        quantityRow.appendChild(document.createElement('div'));
        quantityRow.appendChild(document.createElement('div'));
        quantityRow.appendChild(document.createElement('div'));

        const listContainer = document.createElement('div');
        listContainer.className = 'items-list';

        builder.appendChild(topRow);
        builder.appendChild(quantityRow);
        builder.appendChild(listContainer);
        detallesWrapper.appendChild(builder);

        function clearSuggestions() {
          suggestions.innerHTML = '';
          suggestions.style.display = 'none';
        }

        function setPrecioInputValue(value, { manual = false } = {}) {
          precioInput.value = value;
          precioFueEditadoManualmente = manual;
        }

        function renderSuggestions(query = '') {
          if (!suggestions) return;
          const normalized = query.trim().toLowerCase();
          if (!normalized) {
            clearSuggestions();
            return;
          }

          if (normalized.length < 2) {
            clearSuggestions();
            return;
          }

          const filtered = productosCache
            .filter((p) =>
              (p.nombre || '').toLowerCase().includes(normalized) ||
              (p.sku || '').toLowerCase().includes(normalized)
            )
            .slice(0, 8);

          if (!filtered.length) {
            suggestions.innerHTML = '<p class="muted" style="margin:4px 0;">Sin coincidencias</p>';
            suggestions.style.display = 'block';
            return;
          }

          suggestions.innerHTML = filtered
            .map((p) => `<button type="button" class="suggestion-btn" data-id="${p.id}" data-precio="${p.precio_venta}" data-stock="${p.stock_actual}" data-tipo="${p.tipo}">${(p.sku || '').replace(/</g, '&lt;')} - ${(p.nombre || '').replace(/</g, '&lt;')}</button>`)
            .join('');
          suggestions.style.display = 'block';
        }

        const getCantidadAcumulada = (productoId) => {
          if (!productoId) return 0;
          return itemsState
            .filter((item) => item.productoId === productoId)
            .reduce((acc, curr) => acc + (Number(curr.cantidad) || 0), 0);
        };

        function updateStockHint(producto) {
          if (!stockHint) return;
          if (!producto) {
            stockHint.textContent = '';
            cantidadInput.removeAttribute('max');
            return;
          }

          if (producto.tipo === 'SERVICIO') {
            stockHint.textContent = 'Servicio sin límite de stock.';
            cantidadInput.removeAttribute('max');
            return;
          }

          const stockDisponibleRaw = Number(producto.stock_actual);
          const stockDisponible = Number.isFinite(stockDisponibleRaw) ? stockDisponibleRaw : 0;
          const reservado = getCantidadAcumulada(producto.id);
          const restante = Math.max(stockDisponible - reservado, 0);
          stockHint.textContent = `Stock disponible: ${restante}`;
          if (restante > 0) {
            cantidadInput.max = String(restante);
          } else {
            cantidadInput.removeAttribute('max');
          }
        }

        function getFormCurrencyPricing(producto) {
          const monedaFormulario = getFormCurrency();
          const tipoCambioFormulario = Number(form?.elements?.tipo_cambio?.value || 0);
          return resolveProductUnitPricing(producto, {
            targetCurrency: monedaFormulario,
            exchangeRate: tipoCambioFormulario > 0 ? tipoCambioFormulario : null
          });
        }

        repriceItemsForFormCurrency = () => {
          const monedaFormulario = getFormCurrency();
          const tipoCambioFormulario = getFormExchangeRate();

          if (monedaFormulario === 'USD' && !tipoCambioFormulario) {
            renderItemsList(listContainer);
            syncDetallesField();
            return;
          }

          let changed = false;
          for (const item of itemsState) {
            if (!item?.productoId || item.precio_es_manual) {
              continue;
            }

            const producto = findProducto(item.productoId);
            if (!producto) {
              continue;
            }

            try {
              const pricing = resolveProductUnitPricing(producto, {
                targetCurrency: monedaFormulario,
                exchangeRate: tipoCambioFormulario
              });
              item.precio_unitario = Number(pricing.unitCurrency.toFixed(2));
              item.moneda_precio_unitario = monedaFormulario;
              changed = true;
            } catch (_error) {
              // Si falta tipo de cambio para USD, dejamos el valor actual hasta que el usuario lo complete.
            }
          }

          if (changed) {
            renderItemsList(listContainer);
            syncDetallesField();
          }
        };

        addBtn.addEventListener('click', () => {
          const productoId = productoIdHidden.value || null;
          const productoNombre = productoInput.value || '';
          const cantidad = Number(cantidadInput.value);
          const precio = Number(precioInput.value);
          const precioIngresadoManualmente = Number.isFinite(precio) && precio > 0;
          const iva = Number(ivaSelect.value) || 10;
          const producto = productoId ? findProducto(productoId) : null;
          const monedaFormulario = getFormCurrency();

          if (productoId && !producto) {
            alert('Seleccioná un producto válido de la lista.');
            return;
          }

          if (!Number.isInteger(cantidad) || cantidad <= 0) {
            alert('Ingresá una cantidad válida.');
            return;
          }

          let precioUnitario = precio;
          if ((!precioUnitario || precioUnitario <= 0) && producto) {
            const pricing = getFormCurrencyPricing(producto);
            if (Number(pricing.unitCurrency) > 0) {
              precioUnitario = Number(pricing.unitCurrency);
            }
          }

          if (!precioUnitario || precioUnitario <= 0) {
            alert('Ingresá un precio unitario válido.');
            return;
          }

          const requiereStock = producto && producto.tipo !== 'SERVICIO';
          const stockDisponibleRaw = Number(producto?.stock_actual);
          const stockDisponible = requiereStock && Number.isFinite(stockDisponibleRaw) ? stockDisponibleRaw : Infinity;
          const yaReservado = productoId ? getCantidadAcumulada(productoId) : 0;
          const totalSolicitado = yaReservado + cantidad;

          if (requiereStock && (stockDisponible <= 0 || !Number.isFinite(stockDisponible))) {
            alert('El producto no tiene stock disponible.');
            return;
          }

          if (requiereStock && totalSolicitado > stockDisponible) {
            alert(`Solo hay ${stockDisponible} unidades disponibles (ya agregaste ${yaReservado}).`);
            return;
          }

          itemsState.push({
            productoId,
            nombre: productoNombre,
            cantidad,
            precio_unitario: Number(precioUnitario.toFixed(2)),
            iva_porcentaje: iva,
            moneda_precio_unitario: monedaFormulario,
            precio_es_manual: producto ? precioFueEditadoManualmente : precioIngresadoManualmente
          });

          renderItemsList(listContainer);
          syncDetallesField();
          updateStockHint(producto || null);
          productoInput.value = '';
          productoIdHidden.value = '';
          setPrecioInputValue('');
          cantidadInput.value = '1';
          cantidadInput.removeAttribute('max');
          stockHint.textContent = '';
          clearSuggestions();
        });

        listContainer.addEventListener('click', (event) => {
          const button = event.target.closest('button[data-remove-index]');
          if (!button) return;
          const idx = Number(button.dataset.removeIndex);
          if (Number.isInteger(idx)) {
            itemsState.splice(idx, 1);
            renderItemsList(listContainer);
            syncDetallesField();
          }
        });

        loadProductos();

        let ignoreNextInput = false;
        productoInput.addEventListener('input', (event) => {
          if (ignoreNextInput) {
            ignoreNextInput = false;
            return;
          }
          productoIdHidden.value = '';
          renderSuggestions(event.target.value || '');
          updateStockHint(null);
        });

        precioInput.addEventListener('input', () => {
          precioFueEditadoManualmente = true;
        });

        productoInput.addEventListener('blur', () => {
          setTimeout(clearSuggestions, 150);
        });

        suggestions.addEventListener('mousedown', (event) => {
          const btn = event.target.closest('button[data-id]');
          if (!btn) return;
          const prodId = btn.dataset.id;
          const prod = findProducto(prodId);
          productoIdHidden.value = prodId;
          productoInput.value = `${prod?.sku || ''} - ${prod?.nombre || ''}`.trim();
          if (prod) {
            const pricing = getFormCurrencyPricing(prod);
            if (Number(pricing.unitCurrency) > 0) {
              setPrecioInputValue(Number(pricing.unitCurrency).toFixed(2));
            }
          }
          updateStockHint(prod || null);
          clearSuggestions();
          // Evita que el próximo input borre el id oculto tras seleccionar
          ignoreNextInput = true;
        });

        form.addEventListener('reset', () => {
          setTimeout(() => {
            itemsState.splice(0, itemsState.length);
            syncDetallesField();
            renderItemsList(listContainer);
            cantidadInput.value = '1';
            productoInput.value = '';
            productoIdHidden.value = '';
            setPrecioInputValue('');
            cantidadInput.removeAttribute('max');
            stockHint.textContent = '';
            updateStockHint(null);
            clearSuggestions();
          }, 0);
        });

        renderItemsList(listContainer);
      }

      if (clienteField) {
        const clienteWrapper = clienteField.closest('.form-field') || clienteField.parentElement;
        if (clienteWrapper) {
          clienteWrapper.insertBefore(clienteSearchWrapper, clienteField);
          clienteField.style.display = 'none';
        }
        clienteSearchInput.addEventListener('input', (event) => {
          renderClienteSuggestions(event.target.value || '');
        });
        clienteSearchInput.addEventListener('blur', () => {
          setTimeout(() => {
            clienteSuggestions.style.display = 'none';
          }, 150);
        });
        clienteSuggestions.addEventListener('mousedown', (event) => {
          const btn = event.target.closest('button[data-id]');
          if (!btn) return;
          const id = btn.dataset.id;
          const label = btn.dataset.label || '';
          const doc = btn.dataset.doc || '';
          if (clienteField) {
            clienteField.value = id;
          }
          clienteSearchInput.value = doc ? `${label} · ${doc}` : label;
          clienteSuggestions.style.display = 'none';
        });
      }

      if (detallesField) {
        detallesField.value = '[]';
        const wrapper = detallesField.closest('.form-field') || detallesField.parentElement;
        if (wrapper) {
          detallesField.style.display = 'none';
          buildItemsBuilder(wrapper);
            wrapper.classList.add('full-span');
        }
      }

      setSpan('clienteId', 'span-2');
      setSpan('validez_hasta', 'span-1');
      setSpan('moneda', 'span-1');
      setSpan('tipo_cambio', 'span-1');
      setSpan('descuento_total', 'span-1');
      setSpan('notas', 'full-span');

      loadClientes();

      const toggleTipoCambio = () => {
        const isUsd = String(monedaField?.value || 'PYG').toUpperCase() === 'USD';
        setVisibility('tipo_cambio', isUsd);
        if (!isUsd && tipoCambioField) {
          tipoCambioField.value = '';
        }
        syncDescuentoLabel();
      };

      if (monedaField) {
        monedaField.addEventListener('change', toggleTipoCambio);
        monedaField.addEventListener('change', () => {
          repriceItemsForFormCurrency();
        });
        toggleTipoCambio();
      } else {
        syncDescuentoLabel();
      }

      if (tipoCambioField) {
        tipoCambioField.addEventListener('input', repriceItemsForFormCurrency);
        tipoCambioField.addEventListener('change', repriceItemsForFormCurrency);
        tipoCambioField.addEventListener('blur', repriceItemsForFormCurrency);
      }

      if (detallesField && !detallesField.value) {
        detallesField.value = '[]';
      }
    },
    afterSave() {
      const formCard = document.querySelector('.form-card');
      const toggleBtn = document.getElementById('toggle-form-card');
      const isFormVisible = formCard && formCard.style.display !== 'none';
      if (isFormVisible && toggleBtn) {
        toggleBtn.click();
      } else {
        syncListVisibility();
      }
    }
  },
  async fetchList({ page, pageSize, filters }) {
    const query = buildQuery({
      page,
      pageSize,
      search: filters.search,
      estado: filters.estado || undefined,
      include_deleted: filters.include_deleted ? 'true' : undefined
    });

    try {
      const response = await request(`${this.endpoint}?${query}`);
      return {
        data: response?.data || [],
        meta: response?.meta || {
          page,
          pageSize,
          total: (response?.data || []).length,
          totalPages: Math.max(1, Math.ceil((response?.data || []).length / pageSize))
        }
      };
    } catch (error) {
      // Graceful fallback so the tab still renders even if the backend endpoint is pending
      console.warn('[Presupuestos] No se pudo cargar la lista', error);
      throw new Error('No se pudieron cargar los presupuestos.');
    }
  }
};
