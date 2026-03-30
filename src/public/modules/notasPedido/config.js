import { request, buildQuery, urlWithSession } from '../common/api.js';
import { createNotaPedido, buildNotaPedidoPayload } from './nuevo.js';
import { updateNotaPedido } from './editar.js';
import { deleteNotaPedido } from './eliminar.js';

const TIPO_OPTIONS = [
  { value: 'GENERAL', label: 'General' },
  { value: 'REPUESTOS', label: 'Repuestos' }
];

const ESTADO_OPTIONS = [
  { value: 'BORRADOR', label: 'Borrador' },
  { value: 'EMITIDA', label: 'Emitida' },
  { value: 'RECIBIDA', label: 'Recibida' },
  { value: 'COMPRADA', label: 'Comprada' }
];

let pdfHandlerAttached = false;
let editSyncHandlerAttached = false;
let estadoHandlerAttached = false;
let listVisibilityCleanup = [];

function cleanupListVisibility() {
  if (Array.isArray(listVisibilityCleanup)) {
    listVisibilityCleanup.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn('[NotasPedido] Limpieza de visibilidad', err);
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
  if (panelBody) panelBody.classList.remove('nota-pedido-expanded', 'notas-pedido');
  if (formCard) formCard.classList.remove('notas-pedido-form');
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
    panelBody.classList.add('notas-pedido');
    panelBody.classList.toggle('nota-pedido-expanded', !showList);
  }
  if (formCard) {
    formCard.classList.add('notas-pedido-form');
  }

  if (listCard) listCard.style.display = showList ? '' : 'none';
  if (pagination) pagination.style.display = showList ? '' : 'none';
  if (filterBar) filterBar.style.display = showList ? '' : 'none';
}

function setupListVisibilitySync() {
  cleanupListVisibility();

  const toggleBtn = document.getElementById('toggle-form-card');
  const cancelBtn = document.getElementById('cancel-edit');

  const attach = (element) => {
    if (!element) return;
    const handler = () => {
      setTimeout(syncListVisibility, 0);
    };
    element.addEventListener('click', handler);
    listVisibilityCleanup.push(() => element.removeEventListener('click', handler));
  };

  syncListVisibility();
  attach(toggleBtn);
  attach(cancelBtn);
}

async function convertirNotaPedidoACompra(id) {
  return request(`/notas-pedido/${encodeURIComponent(id)}/convertir-compra`, {
    method: 'POST'
  });
}

async function agregarNotaPedidoAStock(id) {
  return request(`/notas-pedido/${encodeURIComponent(id)}/agregar-stock`, {
    method: 'POST'
  });
}

async function updateEstadoNotaPedido(id, estado) {
  return request(`/notas-pedido/${encodeURIComponent(id)}/estado`, {
    method: 'PUT',
    body: { estado }
  });
}

function renderEstadoBadge(value) {
  const normalized = String(value || '').toUpperCase();
  if (normalized === 'EMITIDA') return '<span class="badge info">Emitida</span>';
  if (normalized === 'RECIBIDA') return '<span class="badge warn">Recibida</span>';
  if (normalized === 'COMPRADA') return '<span class="badge ok">Comprada</span>';
  if (normalized === 'ANULADA') return '<span class="badge error">Anulada</span>';
  return '<span class="badge">Borrador</span>';
}

function renderEstadoControls(item) {
  if (!item?.id) return renderEstadoBadge(item?.estado);
  const estado = String(item.estado || 'BORRADOR').toUpperCase();
  const hasCompra = Boolean(item?.compra?.id);
  let actionHtml = '';

  if (!hasCompra && estado === 'BORRADOR') {
    actionHtml = `<button type="button" class="btn ghost small" data-nota-pedido-estado="${item.id}" data-estado-target="EMITIDA">Emitir</button>`;
  } else if (!hasCompra && estado === 'EMITIDA') {
    actionHtml = `<button type="button" class="btn ghost small" data-nota-pedido-estado="${item.id}" data-estado-target="RECIBIDA">Marcar recibida</button>`;
  } else if (!hasCompra && estado === 'RECIBIDA') {
    actionHtml = `<button type="button" class="btn ghost small" data-nota-pedido-estado="${item.id}" data-estado-target="EMITIDA">Reabrir</button>`;
  }

  return `
    <div class="nota-pedido-estado-cell">
      ${renderEstadoBadge(item.estado)}
      ${actionHtml}
    </div>
  `;
}

function attachPdfHandler() {
  if (pdfHandlerAttached) return;
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-nota-pedido-pdf]');
    if (!btn) return;
    event.preventDefault();
    const id = btn.dataset.notaPedidoPdf;
    if (!id) return;

    const url = urlWithSession(`/notas-pedido/${encodeURIComponent(id)}/pdf`);
    const win = window.open(url, '_blank');
    if (!win || win.closed || typeof win.closed === 'undefined') {
      alert('Permití las ventanas emergentes para ver el PDF de la nota de pedido.');
    }
  });
  pdfHandlerAttached = true;
}

function attachEditSyncHandler() {
  if (editSyncHandlerAttached) return;
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action="edit"]');
    if (!btn) return;
    const activeTab = document.querySelector('.tab-button.active');
    if (!activeTab || activeTab.dataset.module !== 'notasPedido') return;
    setTimeout(() => {
      syncListVisibility();
      const form = document.getElementById('record-form');
      form?.__notaPedidoSyncProveedor?.();
      form?.__notaPedidoSyncFromField?.();
      form?.__notaPedidoSyncTipo?.();
    }, 0);
  });
  editSyncHandlerAttached = true;
}

function attachEstadoHandler() {
  if (estadoHandlerAttached) return;
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-nota-pedido-estado]');
    if (!btn) return;
    event.preventDefault();

    const id = btn.dataset.notaPedidoEstado;
    const estado = btn.dataset.estadoTarget;
    if (!id || !estado) return;

    const label = estado === 'RECIBIDA'
      ? 'marcar como recibida'
      : estado === 'EMITIDA'
        ? 'marcar como emitida'
        : 'marcar como borrador';
    const confirmed = window.confirm(`¿Deseas ${label}?`);
    if (!confirmed) return;

    btn.disabled = true;
    try {
      await updateEstadoNotaPedido(id, estado);
      const refreshBtn = document.querySelector('[data-refresh-list]') || document.getElementById('refresh-list');
      if (refreshBtn) {
        refreshBtn.click();
      } else {
        window.location.reload();
      }
    } catch (error) {
      console.error('[NotasPedido] No se pudo actualizar el estado', error);
      alert('No se pudo actualizar el estado de la nota de pedido.');
    } finally {
      btn.disabled = false;
    }
  });
  estadoHandlerAttached = true;
}

export const notasPedidoModule = {
  key: 'notasPedido',
  label: 'Notas de pedido',
  labelSingular: 'Nota de pedido',
  singular: 'Nota de pedido',
  singularLower: 'nota de pedido',
  endpoint: '/notas-pedido',
  pageSize: 10,
  searchPlaceholder: 'Buscar por número, proveedor, código DJI, SKU o artículo',
  filters: [
    {
      name: 'tipo',
      label: 'Tipo',
      type: 'select',
      options: [{ value: '', label: 'Todos' }, ...TIPO_OPTIONS]
    },
    {
      name: 'estado',
      label: 'Estado',
      type: 'select',
      options: [{ value: '', label: 'Todos' }, ...ESTADO_OPTIONS]
    }
  ],
  fields: [
    { name: 'proveedorId', label: 'Proveedor', type: 'select', options: [{ value: '', label: 'Elegí un proveedor' }] },
    { name: 'fecha', label: 'Fecha', type: 'date' },
    { name: 'tipo', label: 'Tipo de pedido', type: 'select', defaultValue: 'GENERAL', options: TIPO_OPTIONS },
    { name: 'estado', label: 'Estado', type: 'select', defaultValue: 'BORRADOR', options: ESTADO_OPTIONS },
    { name: 'equipo_destino', label: 'Equipo destino general', type: 'text', placeholder: 'Ej: Dron T40' },
    {
      name: 'detalles',
      label: 'Ítems',
      type: 'textarea',
      rows: 2,
      placeholder: 'Se completa automáticamente al agregar ítems',
      helperText: 'Buscá productos por código DJI, SKU o nombre. También podés cargar un ítem libre manual.'
    },
    { name: 'observaciones', label: 'Observaciones', type: 'textarea', rows: 3, placeholder: 'Notas internas del pedido' }
  ],
  columns: [
    { header: 'Número', accessor: (item) => item.numero || '-' },
    { header: 'Proveedor', accessor: (item) => item.proveedor?.nombre_razon_social || '-' },
    { header: 'Fecha', accessor: (item) => (item.fecha ? new Date(item.fecha).toLocaleDateString('es-PY') : '-') },
    { header: 'Tipo', accessor: (item) => item.tipo || '-' },
    { header: 'Destino', accessor: (item) => item.equipo_destino || '-' },
    { header: 'Ítems', accessor: (item) => String(item.detalles?.length || 0) },
    { header: 'Estado', render: (item) => renderEstadoControls(item) },
    {
      header: 'Compra',
      render: (item) => {
        if (item?.compra?.id) {
          if (String(item?.compra?.estado || '').toUpperCase() === 'STOCK_INGRESADO') {
            return '<span class="badge ok">Stock agregado</span>';
          }
          return '<span class="badge info">Generada</span>';
        }
        return '<span class="badge">Pendiente</span>';
      }
    },
    {
      header: 'PDF',
      render: (item) => item?.id
        ? `<button type="button" class="btn ghost small" data-nota-pedido-pdf="${item.id}">Ver PDF</button>`
        : '-'
    }
  ],
  rowActions: [
    {
      action: 'convertir-compra',
      label: 'Generar compra',
      className: 'btn secondary small',
      shouldRender: ({ item }) => String(item?.estado || '').toUpperCase() === 'RECIBIDA' && !item?.compra?.id
    },
    {
      action: 'agregar-stock',
      label: 'Agregar al stock',
      className: 'btn primary small',
      shouldRender: ({ item }) => String(item?.estado || '').toUpperCase() === 'COMPRADA'
        && Boolean(item?.compra?.id)
        && String(item?.compra?.estado || '').toUpperCase() !== 'STOCK_INGRESADO'
    }
  ],
  canEdit({ item }) {
    return String(item?.compra?.estado || '').toUpperCase() !== 'STOCK_INGRESADO';
  },
  canDelete({ item }) {
    return !item?.compra?.id;
  },
  rowActionHandlers: {
    async 'convertir-compra'({ id, item, reload, showMessage }) {
      const confirmed = window.confirm(`¿Generar una compra a partir de la nota ${item?.numero || ''}?`);
      if (!confirmed) return;
      const compra = await convertirNotaPedidoACompra(id);
      showMessage(`Compra generada correctamente. ID: ${compra?.id || '-'}`, 'success');
      await reload({ preserveScroll: true });
    },
    async 'agregar-stock'({ id, item, reload, showMessage }) {
      const confirmed = window.confirm(`¿Agregar al stock los ítems de la compra generada desde la nota ${item?.numero || ''}?`);
      if (!confirmed) return;
      await agregarNotaPedidoAStock(id);
      showMessage('Stock ingresado correctamente.', 'success');
      await reload({ preserveScroll: true });
    }
  },
  async fetchList({ page, pageSize, filters }) {
    const query = buildQuery({
      page,
      pageSize,
      search: filters.search,
      tipo: filters.tipo,
      estado: filters.estado,
      include_deleted: filters.include_deleted ? 'true' : undefined
    });
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
  },
  prepareForEdit(item) {
    return {
      proveedorId: item.proveedorId || item.proveedor?.id || '',
      fecha: item.fecha ? String(item.fecha).slice(0, 10) : '',
      tipo: item.tipo || 'GENERAL',
      estado: item.estado || 'BORRADOR',
      equipo_destino: item.equipo_destino || '',
      observaciones: item.observaciones || '',
      detalles: JSON.stringify(
        Array.isArray(item.detalles)
          ? item.detalles.map((detalle) => ({
            productoId: detalle.productoId || undefined,
            codigo_articulo: detalle.codigo_articulo || '',
            descripcion: detalle.descripcion || '',
            cantidad: Number(detalle.cantidad || 0),
            equipo_destino: detalle.equipo_destino || '',
            observacion: detalle.observacion || ''
          }))
          : []
      )
    };
  },
  actions: {
    nuevo: {
      transform: buildNotaPedidoPayload,
      submit: createNotaPedido,
      successMessage: 'Nota de pedido creada correctamente.'
    },
    editar: {
      transform: buildNotaPedidoPayload,
      submit: updateNotaPedido,
      successMessage: 'Nota de pedido actualizada.'
    },
    eliminar: {
      submit: deleteNotaPedido,
      successMessage: 'Nota de pedido eliminada.',
      confirmMessage: '¿Deseas anular esta nota de pedido?'
    }
  },
  hooks: {
    afterModuleChange() {
      setupListVisibilitySync();
      attachPdfHandler();
      attachEditSyncHandler();
      attachEstadoHandler();
    },
    beforeModuleChange() {
      cleanupListVisibility();
    },
    afterFormRender({ form }) {
      const proveedorField = form?.elements?.proveedorId;
      const detallesField = form?.elements?.detalles;
      const tipoField = form?.elements?.tipo;
      const equipoGeneralField = form?.elements?.equipo_destino;
      const itemsState = [];
      let proveedoresCache = [];
      let productosCache = [];
      let searchTimer = null;

      const setSpan = (fieldName, className) => {
        const control = form?.elements?.[fieldName];
        if (!control) return;
        const wrapper = control.closest('.form-field');
        if (wrapper) wrapper.classList.add(className);
      };

      async function loadProveedores() {
        try {
          const response = await request('/proveedores?pageSize=200');
          proveedoresCache = Array.isArray(response?.data) ? response.data : [];
          if (proveedorField) {
            proveedorField.innerHTML = '<option value="">Elegí un proveedor</option>' + proveedoresCache
              .map((item) => `<option value="${item.id}">${escapeHtml(item.nombre_razon_social || '')}</option>`)
              .join('');
            if (proveedorField.dataset.pendingValue) {
              proveedorField.value = proveedorField.dataset.pendingValue;
              delete proveedorField.dataset.pendingValue;
            }
          }
        } catch (error) {
          console.warn('[NotasPedido] No se pudieron cargar proveedores', error);
          proveedoresCache = [];
        }
      }

      function findProveedor(id) {
        return proveedoresCache.find((item) => item.id === id) || null;
      }

      const proveedorSearchInput = document.createElement('input');
      proveedorSearchInput.type = 'search';
      proveedorSearchInput.placeholder = 'Buscar proveedor por nombre o RUC';
      proveedorSearchInput.autocomplete = 'off';
      proveedorSearchInput.className = 'cliente-search__input';

      const proveedorSuggestions = document.createElement('div');
      proveedorSuggestions.className = 'items-builder__suggestions cliente-search__suggestions';

      const proveedorSearchWrapper = document.createElement('div');
      proveedorSearchWrapper.className = 'cliente-search';
      proveedorSearchWrapper.appendChild(proveedorSearchInput);
      proveedorSearchWrapper.appendChild(proveedorSuggestions);

      function syncProveedorLabel() {
        const proveedor = findProveedor(proveedorField?.value || '');
        proveedorSearchInput.value = proveedor ? proveedor.nombre_razon_social || '' : '';
      }

      function renderProveedorSuggestions(query = '') {
        const normalized = query.trim().toLowerCase();
        if (!normalized || normalized.length < 2) {
          proveedorSuggestions.innerHTML = '';
          proveedorSuggestions.style.display = 'none';
          return;
        }

        const filtered = proveedoresCache
          .filter((item) => {
            const nombre = String(item.nombre_razon_social || '').toLowerCase();
            const ruc = String(item.ruc || '').toLowerCase();
            return nombre.includes(normalized) || ruc.includes(normalized);
          })
          .slice(0, 8);

        if (!filtered.length) {
          proveedorSuggestions.innerHTML = '<p class="muted" style="margin:4px 0;">Sin coincidencias</p>';
          proveedorSuggestions.style.display = 'block';
          return;
        }

        proveedorSuggestions.innerHTML = filtered
          .map((item) => `<button type="button" class="suggestion-btn" data-id="${item.id}" data-label="${escapeHtml(item.nombre_razon_social || '')}">${escapeHtml(item.nombre_razon_social || '')}${item.ruc ? ` · ${escapeHtml(item.ruc)}` : ''}</button>`)
          .join('');
        proveedorSuggestions.style.display = 'block';
      }

      function syncDetallesField() {
        if (!detallesField) return;
        detallesField.value = JSON.stringify(itemsState.map((item) => ({
          productoId: item.productoId || undefined,
          codigo_articulo: item.codigo_articulo,
          descripcion: item.descripcion,
          cantidad: item.cantidad,
          equipo_destino: item.equipo_destino || undefined,
          observacion: item.observacion || undefined
        })));
      }

      function renderItemsList(container) {
        if (!container) return;
        const isRepuestos = String(tipoField?.value || 'GENERAL').toUpperCase() === 'REPUESTOS';
        if (!itemsState.length) {
          container.innerHTML = '<p class="muted">Sin ítems cargados.</p>';
          return;
        }

        container.innerHTML = `
          <div class="items-table">
            <div class="items-row header">
              <span>Código</span>
              <span>Artículo</span>
              <span>Cant.</span>
              <span>${isRepuestos ? 'Equipo' : 'Detalle'}</span>
              <span></span>
            </div>
            ${itemsState.map((item, index) => `
              <div class="items-row">
                <span>${escapeHtml(item.codigo_articulo || '-')}</span>
                <span>${escapeHtml(item.descripcion || '-')}</span>
                <span>${item.cantidad}</span>
                <span>${escapeHtml(isRepuestos ? (item.equipo_destino || '-') : (item.observacion || item.equipo_destino || '-'))}</span>
                <button type="button" class="btn ghost small" data-remove-index="${index}">Quitar</button>
              </div>
            `).join('')}
          </div>
        `;
      }

      function parseDetallesField() {
        try {
          const raw = detallesField?.value || '[]';
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return parsed.map((item) => ({
            productoId: item.productoId || null,
            codigo_articulo: item.codigo_articulo || '',
            descripcion: item.descripcion || '',
            cantidad: Number.parseInt(item.cantidad, 10) || 1,
            equipo_destino: item.equipo_destino || '',
            observacion: item.observacion || ''
          }));
        } catch (_error) {
          return [];
        }
      }

      function escapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      async function searchProductos(query) {
        if (!query || query.trim().length < 2) {
          productosCache = [];
          return [];
        }
        try {
          const response = await request(`/productos?${buildQuery({ pageSize: 20, search: query.trim() })}`);
          productosCache = Array.isArray(response?.data) ? response.data : [];
          return productosCache;
        } catch (error) {
          console.warn('[NotasPedido] No se pudieron buscar productos', error);
          productosCache = [];
          return [];
        }
      }

      function findProducto(id) {
        return productosCache.find((item) => item.id === id) || null;
      }

      function buildItemsBuilder(detallesWrapper) {
        if (!detallesWrapper) return;
        const builder = document.createElement('div');
        builder.className = 'items-builder notas-pedido-builder';

        const modeHint = document.createElement('div');
        modeHint.className = 'items-list';
        modeHint.style.padding = '0.65rem 0.8rem';
        modeHint.style.marginBottom = '0.2rem';

        const productoInput = document.createElement('input');
        productoInput.type = 'search';
        productoInput.placeholder = 'Buscar producto por código DJI, SKU o nombre';
        productoInput.className = 'items-builder__producto';
        productoInput.autocomplete = 'off';

        const productoIdHidden = document.createElement('input');
        productoIdHidden.type = 'hidden';

        const suggestions = document.createElement('div');
        suggestions.className = 'items-builder__suggestions';

        const searchWrapper = document.createElement('div');
        searchWrapper.className = 'items-builder__search';
        searchWrapper.appendChild(productoInput);
        searchWrapper.appendChild(productoIdHidden);
        searchWrapper.appendChild(suggestions);

        const codigoInput = document.createElement('input');
        codigoInput.type = 'text';
        codigoInput.placeholder = 'Código artículo';

        const cantidadInput = document.createElement('input');
        cantidadInput.type = 'number';
        cantidadInput.min = '1';
        cantidadInput.step = '1';
        cantidadInput.value = '1';
        cantidadInput.placeholder = 'Cantidad';

        const equipoInput = document.createElement('input');
        equipoInput.type = 'text';
        equipoInput.placeholder = 'Equipo destino';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn secondary small';
        addBtn.textContent = 'Agregar ítem';

        const descripcionInput = document.createElement('input');
        descripcionInput.type = 'text';
        descripcionInput.placeholder = 'Descripción del artículo';

        const observacionInput = document.createElement('input');
        observacionInput.type = 'text';
        observacionInput.placeholder = 'Observación de la línea';

        const topRow = document.createElement('div');
        topRow.className = 'items-builder-row notas-pedido-builder__top';
        topRow.appendChild(searchWrapper);
        topRow.appendChild(codigoInput);
        topRow.appendChild(cantidadInput);
        topRow.appendChild(equipoInput);
        topRow.appendChild(addBtn);

        const secondRow = document.createElement('div');
        secondRow.className = 'items-builder-row items-builder-row--secondary notas-pedido-builder__bottom';
        secondRow.appendChild(descripcionInput);
        secondRow.appendChild(observacionInput);

        const listContainer = document.createElement('div');
        listContainer.className = 'items-list notas-pedido-builder__list';

        builder.appendChild(modeHint);
        builder.appendChild(topRow);
        builder.appendChild(secondRow);
        builder.appendChild(listContainer);
        detallesWrapper.appendChild(builder);

        const clearSuggestions = () => {
          suggestions.innerHTML = '';
          suggestions.style.display = 'none';
        };

        const clearInputs = () => {
          productoInput.value = '';
          productoIdHidden.value = '';
          codigoInput.value = '';
          descripcionInput.value = '';
          cantidadInput.value = '1';
          equipoInput.value = '';
          observacionInput.value = '';
        };

        const syncBuilderMode = () => {
          const isRepuestos = String(tipoField?.value || 'GENERAL').toUpperCase() === 'REPUESTOS';
          if (isRepuestos) {
            modeHint.innerHTML = '<strong>Modo repuestos:</strong> cada línea puede indicar para qué equipo va el repuesto.';
            equipoInput.placeholder = 'Equipo destino del repuesto';
            descripcionInput.placeholder = 'Nombre del repuesto';
            observacionInput.placeholder = 'Observación opcional';
            equipoInput.style.display = '';
          } else {
            modeHint.innerHTML = '<strong>Modo general:</strong> usá la observación por línea para detalle adicional y el destino general arriba si aplica.';
            descripcionInput.placeholder = 'Descripción del artículo';
            observacionInput.placeholder = 'Detalle adicional de la línea';
            equipoInput.placeholder = 'Destino opcional';
          }
          renderItemsList(listContainer);
        };

        const renderSuggestions = async (query) => {
          const results = await searchProductos(query);
          if (!results.length) {
            suggestions.innerHTML = '<p class="muted" style="margin:4px 0;">Sin coincidencias</p>';
            suggestions.style.display = 'block';
            return;
          }

          suggestions.innerHTML = results
            .map((item) => {
              const code = item.codigo_dji || item.sku || '-';
              return `<button type="button" class="suggestion-btn" data-id="${item.id}">${escapeHtml(code)} · ${escapeHtml(item.nombre || '')}</button>`;
            })
            .join('');
          suggestions.style.display = 'block';
        };

        productoInput.addEventListener('input', (event) => {
          productoIdHidden.value = '';
          if (searchTimer) {
            window.clearTimeout(searchTimer);
          }
          const query = event.target.value || '';
          if (query.trim().length < 2) {
            clearSuggestions();
            return;
          }
          searchTimer = window.setTimeout(() => {
            renderSuggestions(query);
          }, 180);
        });

        productoInput.addEventListener('blur', () => {
          window.setTimeout(clearSuggestions, 150);
        });

        suggestions.addEventListener('mousedown', (event) => {
          const btn = event.target.closest('button[data-id]');
          if (!btn) return;
          const producto = findProducto(btn.dataset.id);
          if (!producto) return;
          productoIdHidden.value = producto.id;
          productoInput.value = `${producto.codigo_dji || producto.sku || ''} · ${producto.nombre || ''}`.trim();
          codigoInput.value = producto.codigo_dji || producto.sku || '';
          descripcionInput.value = producto.nombre || '';
          clearSuggestions();
        });

        addBtn.addEventListener('click', () => {
          const isRepuestos = String(tipoField?.value || 'GENERAL').toUpperCase() === 'REPUESTOS';
          const productoId = productoIdHidden.value || null;
          const codigoArticulo = String(codigoInput.value || '').trim();
          const descripcion = String(descripcionInput.value || '').trim();
          const cantidad = Number.parseInt(cantidadInput.value, 10);
          const equipoDestino = String(equipoInput.value || '').trim();
          const observacion = String(observacionInput.value || '').trim();

          if (!codigoArticulo) {
            alert('Indicá el código del artículo.');
            return;
          }

          if (!descripcion) {
            alert('Indicá la descripción del artículo.');
            return;
          }

          if (!Number.isInteger(cantidad) || cantidad <= 0) {
            alert('Ingresá una cantidad válida.');
            return;
          }

          if (isRepuestos && !equipoDestino && !String(equipoGeneralField?.value || '').trim()) {
            alert('En pedidos de repuestos indicá el equipo destino general o por línea.');
            return;
          }

          itemsState.push({
            productoId,
            codigo_articulo: codigoArticulo,
            descripcion,
            cantidad,
            equipo_destino: equipoDestino,
            observacion: observacion
          });
          syncDetallesField();
          renderItemsList(listContainer);
          clearInputs();
          clearSuggestions();
        });

        listContainer.addEventListener('click', (event) => {
          const button = event.target.closest('button[data-remove-index]');
          if (!button) return;
          const index = Number(button.dataset.removeIndex);
          if (!Number.isInteger(index)) return;
          itemsState.splice(index, 1);
          syncDetallesField();
          renderItemsList(listContainer);
        });

        form.__notaPedidoSyncFromField = () => {
          itemsState.splice(0, itemsState.length, ...parseDetallesField());
          syncBuilderMode();
          renderItemsList(listContainer);
        };

        form.addEventListener('reset', () => {
          window.setTimeout(() => {
            itemsState.splice(0, itemsState.length);
            syncDetallesField();
            renderItemsList(listContainer);
            clearInputs();
            clearSuggestions();
          }, 0);
        });

        syncBuilderMode();
        renderItemsList(listContainer);
      }

      function syncTipoVisibility() {
        const isRepuestos = String(tipoField?.value || 'GENERAL').toUpperCase() === 'REPUESTOS';
        if (equipoGeneralField) {
          const label = equipoGeneralField.closest('.form-field')?.querySelector('span');
          if (label) {
            label.textContent = isRepuestos ? 'Equipo destino general *' : 'Equipo destino general';
          }
          equipoGeneralField.placeholder = isRepuestos ? 'Ej: Dron T40' : 'Opcional';
        }
        form.__notaPedidoSyncFromField?.();
      }

      if (proveedorField) {
        const wrapper = proveedorField.closest('.form-field');
        if (wrapper) {
          wrapper.insertBefore(proveedorSearchWrapper, proveedorField);
          proveedorField.style.display = 'none';
        }

        proveedorSearchInput.addEventListener('input', (event) => renderProveedorSuggestions(event.target.value || ''));
        proveedorSearchInput.addEventListener('blur', () => {
          window.setTimeout(() => {
            proveedorSuggestions.style.display = 'none';
          }, 150);
        });
        proveedorSuggestions.addEventListener('mousedown', (event) => {
          const btn = event.target.closest('button[data-id]');
          if (!btn) return;
          proveedorField.value = btn.dataset.id || '';
          proveedorSearchInput.value = btn.dataset.label || '';
          proveedorSuggestions.style.display = 'none';
        });
      }

      if (detallesField) {
        const wrapper = detallesField.closest('.form-field');
        if (wrapper) {
          detallesField.style.display = 'none';
          buildItemsBuilder(wrapper);
          wrapper.classList.add('full-span');
        }
        if (!detallesField.value) {
          detallesField.value = '[]';
        }
      }

      setSpan('proveedorId', 'span-2');
      setSpan('fecha', 'span-1');
      setSpan('tipo', 'span-1');
      setSpan('estado', 'span-1');
      setSpan('equipo_destino', 'span-2');
      setSpan('observaciones', 'full-span');

      form.__notaPedidoSyncProveedor = syncProveedorLabel;
      form.__notaPedidoSyncTipo = syncTipoVisibility;

      if (tipoField) {
        tipoField.addEventListener('change', syncTipoVisibility);
      }

      loadProveedores().then(() => {
        syncProveedorLabel();
      });
      syncTipoVisibility();
      form.__notaPedidoSyncFromField?.();
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
  }
};