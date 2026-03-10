import { request, buildQuery, urlWithSession } from '../common/api.js';
import { formatCurrency, formatDate } from '../common/format.js';

const IVA_OPTIONS = [
  { value: '10', label: 'IVA 10%' },
  { value: '5', label: 'IVA 5%' }
];

const MONEDA_OPTIONS = [
  { value: 'PYG', label: 'Guaraníes (PYG)' },
  { value: 'USD', label: 'Dólares (USD)' }
];

const ventasState = {
  lastList: [],
  lastFilters: {},
  lastResumen: null,
  currentPage: 1
};

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeDateString(input) {
  if (!input) return null;
  if (typeof input === 'string' && DATE_ONLY_REGEX.test(input)) {
    return input;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatMonedaLabel(value) {
  if (!value) return '';
  const upper = String(value).toUpperCase();
  if (upper === 'USD') return 'Dólares (USD)';
  return 'Guaraníes (PYG)';
}

function renderTotalAmount(venta) {
  const base = formatCurrency(venta?.total, 'PYG');
  const currency = (venta?.moneda || 'PYG').toUpperCase();
  const usdAmount = Number(venta?.total_moneda || 0);
  if (currency === 'USD' && Number.isFinite(usdAmount) && usdAmount > 0) {
    return `<div class="table-amount"><span>${base}</span><div class="table-sub">${formatCurrency(usdAmount, 'USD')}</div></div>`;
  }
  return base;
}

let ventasResumenNode = null;

function ensureVentasResumenNode() {
  if (ventasResumenNode && ventasResumenNode.isConnected) return ventasResumenNode;
  const listCard = document.querySelector('.list-card');
  if (!listCard) return null;
  const node = document.createElement('section');
  node.id = 'ventas-resumen-card';
  node.className = 'ventas-resumen-card';
  listCard.prepend(node);
  ventasResumenNode = node;
  return node;
}

function clearVentasResumenNode() {
  if (ventasResumenNode && ventasResumenNode.parentNode) {
    ventasResumenNode.parentNode.removeChild(ventasResumenNode);
  }
  ventasResumenNode = null;
}

function renderVentasResumenCard(resumen, totalRegistros = 0) {
  const node = ensureVentasResumenNode();
  if (!node) return;
  if (!resumen) {
    node.innerHTML = '<p class="muted">Consultá las ventas para ver el resumen.</p>';
    return;
  }

  const totalPyg = formatCurrency(resumen.total_pyg || 0, 'PYG');
  const totalUsd = formatCurrency(resumen.total_usd || 0, 'USD');

  node.innerHTML = `
    <div class="ventas-resumen-card__header">
      <h3>Resumen de ventas</h3>
      <span>${totalRegistros} registros</span>
    </div>
    <div class="ventas-resumen-card__grid">
      <div>
        <span>Ventas en guaraníes</span>
        <strong>${totalPyg}</strong>
      </div>
      <div>
        <span>Ventas en dólares</span>
        <strong>${totalUsd}</strong>
      </div>
    </div>
  `;
}

function datesBetween(start, end) {
  const out = [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function resolveDateRange(filters, showMessage) {
  let start = null;
  let end = null;

  if (filters && filters.fecha_desde) {
    if (!DATE_ONLY_REGEX.test(filters.fecha_desde)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha desde del reporte.', 'error');
      return null;
    }
    start = filters.fecha_desde;
  }
  if (filters && filters.fecha_hasta) {
    if (!DATE_ONLY_REGEX.test(filters.fecha_hasta)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha hasta del reporte.', 'error');
      return null;
    }
    end = filters.fecha_hasta;
  }

  if (!start && !end) {
    const suggestion = new Date().toISOString().slice(0, 10);
    const input = typeof window !== 'undefined' ? window.prompt('Ingresá la fecha (YYYY-MM-DD) para el reporte', suggestion) : null;
    if (!input) {
      return null;
    }
    if (!DATE_ONLY_REGEX.test(input)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha del reporte.', 'error');
      return null;
    }
    start = input;
    end = input;
  }

  if (start && !end) end = start;
  if (!start && end) start = end;

  if (start > end) {
    showMessage('La fecha "Desde" debe ser anterior o igual a la fecha "Hasta".', 'error');
    return null;
  }

  const rangeList = datesBetween(start, end);
  return {
    start,
    end,
    rangeList,
    rangeSet: new Set(rangeList),
    label: start === end ? start : `${start} → ${end}`
  };
}

function filterVentasByRange(rangeInfo) {
  const targetDates = rangeInfo?.rangeSet;
  if (!targetDates || !(targetDates instanceof Set)) return [];
  return ventasState.lastList.filter((venta) => targetDates.has(normalizeDateString(venta.fecha || venta.created_at)));
}

function openReportPdf(type, filters, rangeInfo, showMessage) {
  const query = buildQuery({
    search: filters?.search,
    iva_porcentaje: filters?.iva_porcentaje,
    moneda: filters?.moneda,
    include_deleted: filters?.include_deleted ? 'true' : undefined,
    fecha_desde: rangeInfo.start,
    fecha_hasta: rangeInfo.end
  });
  const rawUrl = query ? `/ventas/reporte/${type}?${query}` : `/ventas/reporte/${type}`;
  const url = urlWithSession(rawUrl);
  const win = typeof window !== 'undefined' ? window.open(url, '_blank') : null;
  if (!win) {
    showMessage('No se pudo abrir la ventana del reporte. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
}

function downloadReportXlsx(filters, rangeInfo, showMessage) {
  const query = buildQuery({
    search: filters?.search,
    iva_porcentaje: filters?.iva_porcentaje,
    moneda: filters?.moneda,
    include_deleted: filters?.include_deleted ? 'true' : undefined,
    fecha_desde: rangeInfo.start,
    fecha_hasta: rangeInfo.end
  });
  const rawUrl = query ? `/ventas/reporte/diario/xlsx?${query}` : '/ventas/reporte/diario/xlsx';
  const url = urlWithSession(rawUrl);
  const win = typeof window !== 'undefined' ? window.open(url, '_blank') : null;
  if (!win) {
    showMessage('No se pudo iniciar la descarga del Excel. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
}

function openCobroDialog({ saldo, monedaVenta, tipoCambioVenta }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.style.background = '#0f172a';
    modal.style.color = '#e2e8f0';
    modal.style.padding = '20px';
    modal.style.borderRadius = '10px';
    modal.style.minWidth = '320px';
    modal.style.boxShadow = '0 10px 30px rgba(0,0,0,0.4)';

    const title = document.createElement('h3');
    title.textContent = 'Cobrar venta';
    title.style.margin = '0 0 12px 0';
    modal.appendChild(title);

    const fieldMoneda = document.createElement('div');
    fieldMoneda.style.marginBottom = '10px';
    const labelMoneda = document.createElement('label');
    labelMoneda.textContent = 'Moneda de cobro';
    labelMoneda.style.display = 'block';
    labelMoneda.style.marginBottom = '4px';
    const selectMoneda = document.createElement('select');
    selectMoneda.style.width = '100%';
    selectMoneda.style.padding = '8px';
    selectMoneda.style.borderRadius = '6px';
    selectMoneda.style.border = '1px solid #1f2937';
    ['PYG', 'USD'].forEach((val) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val === 'USD' ? 'Dólares (USD)' : 'Guaraníes (PYG)';
      if (val === monedaVenta) opt.selected = true;
      selectMoneda.appendChild(opt);
    });
    fieldMoneda.appendChild(labelMoneda);
    fieldMoneda.appendChild(selectMoneda);
    modal.appendChild(fieldMoneda);

    const fieldCambio = document.createElement('div');
    fieldCambio.style.marginBottom = '10px';
    const labelCambio = document.createElement('label');
    labelCambio.textContent = 'Tipo de cambio (Gs por USD)';
    labelCambio.style.display = 'block';
    labelCambio.style.marginBottom = '4px';
    const inputCambio = document.createElement('input');
    inputCambio.type = 'number';
    inputCambio.step = '0.0001';
    inputCambio.min = '0';
    inputCambio.value = tipoCambioVenta > 0 ? String(tipoCambioVenta) : '';
    inputCambio.style.width = '100%';
    inputCambio.style.padding = '8px';
    inputCambio.style.borderRadius = '6px';
    inputCambio.style.border = '1px solid #1f2937';
    fieldCambio.appendChild(labelCambio);
    fieldCambio.appendChild(inputCambio);
    modal.appendChild(fieldCambio);

    const fieldMonto = document.createElement('div');
    fieldMonto.style.marginBottom = '10px';
    const labelMonto = document.createElement('label');
    labelMonto.textContent = 'Monto a cobrar';
    labelMonto.style.display = 'block';
    labelMonto.style.marginBottom = '4px';
    const inputMonto = document.createElement('input');
    inputMonto.type = 'number';
    inputMonto.min = '0';
    inputMonto.step = '0.01';
    inputMonto.style.width = '100%';
    inputMonto.style.padding = '8px';
    inputMonto.style.borderRadius = '6px';
    inputMonto.style.border = '1px solid #1f2937';
    fieldMonto.appendChild(labelMonto);
    fieldMonto.appendChild(inputMonto);
    modal.appendChild(fieldMonto);

    const saldoInfo = document.createElement('div');
    saldoInfo.style.fontSize = '12px';
    saldoInfo.style.margin = '4px 0 12px';
    saldoInfo.style.color = '#cbd5e1';
    modal.appendChild(saldoInfo);

    const fieldMetodo = document.createElement('div');
    fieldMetodo.style.marginBottom = '12px';
    const labelMetodo = document.createElement('label');
    labelMetodo.textContent = 'Método de cobro';
    labelMetodo.style.display = 'block';
    labelMetodo.style.marginBottom = '4px';
    const selectMetodo = document.createElement('select');
    selectMetodo.style.width = '100%';
    selectMetodo.style.padding = '8px';
    selectMetodo.style.borderRadius = '6px';
    selectMetodo.style.border = '1px solid #1f2937';
    ['efectivo', 'transferencia', 'tarjeta', 'cheque', 'otros'].forEach((val) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
      selectMetodo.appendChild(opt);
    });
    fieldMetodo.appendChild(labelMetodo);
    fieldMetodo.appendChild(selectMetodo);
    modal.appendChild(fieldMetodo);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '10px';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancelar';
    btnCancel.style.padding = '8px 12px';
    btnCancel.style.border = 'none';
    btnCancel.style.borderRadius = '6px';
    btnCancel.style.background = '#334155';
    btnCancel.style.color = '#e2e8f0';
    const btnOk = document.createElement('button');
    btnOk.textContent = 'Aceptar';
    btnOk.style.padding = '8px 12px';
    btnOk.style.border = 'none';
    btnOk.style.borderRadius = '6px';
    btnOk.style.background = '#16a34a';
    btnOk.style.color = '#e2e8f0';
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function updateSaldoInfo() {
      const moneda = selectMoneda.value;
      const cambio = Number(inputCambio.value);
      const saldoEnMoneda = moneda === 'USD' && cambio > 0 ? round(saldo / cambio, 2) : saldo;
      saldoInfo.textContent = `Saldo pendiente: ${formatCurrency(saldoEnMoneda, moneda)}`;
      if (moneda === 'USD') {
        saldoInfo.textContent += ` (equiv. Gs ${formatCurrency(saldo, 'PYG')})`;
        fieldCambio.style.display = 'block';
      } else {
        fieldCambio.style.display = 'none';
      }
      if (!inputMonto.value) {
        inputMonto.value = saldoEnMoneda;
      }
    }

    selectMoneda.addEventListener('change', updateSaldoInfo);
    updateSaldoInfo();

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    btnCancel.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    btnOk.addEventListener('click', () => {
      const monedaCobro = selectMoneda.value;
      let tipoCambio = Number(inputCambio.value);
      if (monedaCobro === 'USD') {
        if (!Number.isFinite(tipoCambio) || tipoCambio <= 0) {
          alert('Ingresá un tipo de cambio válido.');
          return;
        }
      } else {
        tipoCambio = null;
      }
      const monto = toNumber(inputMonto.value);
      if (!Number.isFinite(monto) || monto <= 0) {
        alert('Ingresá un monto válido.');
        return;
      }
      const metodo = selectMetodo.value || 'efectivo';
      close({ monedaCobro, tipoCambio, monto, metodo });
    });
  });
}

function printDailyReport(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para generar el reporte.', 'info');
    return;
  }
  const rangeInfo = resolveDateRange(filters, showMessage);
  if (!rangeInfo) return;
  const { label } = rangeInfo;
  const ventas = filterVentasByRange(rangeInfo);
  if (!ventas.length) {
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }
  openReportPdf('diario', filters || {}, rangeInfo, showMessage);
}

function downloadDailyXlsx(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para exportar.', 'info');
    return;
  }
  const rangeInfo = resolveDateRange(filters, showMessage);
  if (!rangeInfo) return;
  const { label } = rangeInfo;
  const ventas = filterVentasByRange(rangeInfo);
  if (!ventas.length) {
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }
  downloadReportXlsx(filters || {}, rangeInfo, showMessage);
}

function printMarginReport(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para generar el reporte.', 'info');
    return;
  }

  const rangeInfo = resolveDateRange(filters, showMessage);
  if (!rangeInfo) return;
  const { label } = rangeInfo;
  const ventas = filterVentasByRange(rangeInfo);
  if (!ventas.length) {
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }
  openReportPdf('margen', filters || {}, rangeInfo, showMessage);
}


export const ventasModule = {
  key: 'ventas',
  label: 'Ventas',
  labelSingular: 'Venta',
  singular: 'Venta',
  singularLower: 'venta',
  endpoint: '/ventas',
  pageSize: 10,
  supportsPagination: true,
  supportsEdit: false,
  supportsDelete: false,
  supportsForm: false,
  searchPlaceholder: 'Buscar por cliente, usuario, ID o estado',
  filters: [
    {
      name: 'iva_porcentaje',
      label: 'IVA',
      type: 'select',
      options: IVA_OPTIONS
    },
    {
      name: 'moneda',
      label: 'Moneda',
      type: 'select',
      options: MONEDA_OPTIONS
    },
    {
      name: 'fecha_desde',
      label: 'Desde',
      type: 'date'
    },
    {
      name: 'fecha_hasta',
      label: 'Hasta',
      type: 'date'
    }
  ],
  moduleActions: [
    { action: 'print-daily', label: 'Reporte diario', className: 'btn ghost small' },
    { action: 'print-margin', label: 'Reporte margen', className: 'btn ghost small' },
    { action: 'download-daily-xlsx', label: 'Exportar XLSX', className: 'btn ghost small' }
  ],
  rowActions: [
    {
      action: 'facturar',
      label: 'Facturar',
      className: 'btn secondary small',
      shouldRender: ({ item }) => {
        if (!item || item.deleted_at) return false;
        const estado = String(item.estado || '').toUpperCase();
        const yaFacturada = Boolean(item.factura_digital?.id);
        return estado !== 'ANULADA' && estado !== 'FACTURADO' && !yaFacturada;
      },
      isDisabled: ({ item }) => {
        if (!item) return true;
        const estado = String(item.estado || '').toUpperCase();
        if (estado === 'ANULADA') return true;
        if (item.factura_digital?.id) return true;
        return false;
      }
    },
    {
      action: 'anular',
      label: 'Anular',
      className: 'btn danger small',
      shouldRender: ({ item }) => !item.deleted_at,
      isDisabled: ({ item }) => item.estado && item.estado.toUpperCase() === 'ANULADA'
    },
    {
      action: 'cobrar',
      label: 'Cobrar',
      className: 'btn primary small',
      shouldRender: ({ item }) => {
        const saldo = Number(item?.saldo_pendiente ?? 0);
        return !item?.deleted_at && saldo > 0;
      },
      isDisabled: ({ item }) => {
        const saldo = Number(item?.saldo_pendiente ?? 0);
        return !item || saldo <= 0;
      }
    }
  ],
  rowActionHandlers: {
    async facturar({ id, showMessage, reload }) {
      const confirmed = window.confirm('¿Generar la factura para esta venta?');
      if (!confirmed) return;
      try {
        await request(`/ventas/${id}/facturar`, { method: 'POST' });
        showMessage('Factura generada correctamente.', 'success');
        await reload();
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo generar la factura.', 'error');
      }
    },
    async anular({ id, item, showMessage, reload }) {
      if (item.deleted_at) {
        showMessage('Esta venta ya fue anulada.', 'info');
        return;
      }
      const confirmation = window.confirm('¿Anular esta venta? Se repondrá el stock de los productos.');
      if (!confirmation) return;
      try {
        await request(`/ventas/${id}/anular`, { method: 'POST' });
        showMessage('Venta anulada correctamente.', 'success');
        await reload();
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo anular la venta.', 'error');
      }
    },
    async cobrar({ item, showMessage, reload }) {
      if (!item) return;
      const saldo = Number(item.saldo_pendiente ?? 0);
      if (!Number.isFinite(saldo) || saldo <= 0) {
        showMessage('Esta venta no tiene saldo pendiente.', 'info');
        return;
      }
      const dialogResult = await openCobroDialog({
        saldo,
        monedaVenta: (item.moneda || 'PYG').toUpperCase(),
        tipoCambioVenta: Number(item.tipo_cambio) || 0
      });

      if (!dialogResult) return;

      const { monedaCobro, tipoCambio, monto, metodo } = dialogResult;
      const montoGs = monedaCobro === 'USD' ? monto * tipoCambio : monto;
      if (montoGs > saldo) {
        const continuar = window.confirm('El monto supera el saldo pendiente. ¿Continuar de todas formas?');
        if (!continuar) return;
      }
      try {
        const recibo = await request('/recibos', {
          method: 'POST',
          body: {
            clienteId: item.clienteId,
            metodo: metodo.trim(),
            moneda: monedaCobro,
            tipo_cambio: monedaCobro === 'USD' ? tipoCambio : undefined,
            ventas: [
              {
                ventaId: item.id,
                monto
              }
            ]
          }
        });
        showMessage('Recibo registrado correctamente.', 'success');
        if (recibo?.id) {
          const pdfUrl = urlWithSession(`/recibos/${recibo.id}/pdf`);
          const win = window.open(pdfUrl, '_blank');
          if (!win) {
            showMessage('Recibo generado. Desbloquea ventanas emergentes para ver el PDF.', 'warn');
          }
        }
        await reload();
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo registrar el recibo.', 'error');
      }
    }
  },
  moduleActionHandlers: {
    'print-daily': ({ filters, showMessage }) => printDailyReport(filters, showMessage),
    'print-margin': ({ filters, showMessage }) => printMarginReport(filters, showMessage),
    'download-daily-xlsx': ({ filters, showMessage }) => downloadDailyXlsx(filters, showMessage)
  },
  hooks: {
    afterModuleChange: () => renderVentasResumenCard(ventasState.lastResumen, ventasState.lastList.length),
    beforeModuleChange: () => clearVentasResumenNode()
  },
  columns: [
    {
      header: 'Fecha',
      render: (item) => formatDate(item.fecha)
    },
    {
      header: 'Cliente',
      render: (item) => item.cliente?.nombre_razon_social || 'Cliente eventual'
    },
    {
      header: 'Usuario',
      render: (item) => item.usuario?.nombre || item.usuarioId || '-'
    },
    {
      header: 'Estado',
      render: (item) => {
        if (item.deleted_at || (item.estado && item.estado.toUpperCase() === 'ANULADA')) {
          return '<span class="badge error">Anulada</span>';
        }
        return `<span class="badge ok">${escapeHtml(item.estado || '-')}</span>`;
      }
    },
    {
      header: 'Condición',
      render: (item) => {
        const isCredito = String(item.condicion_venta || item.condicion || '').toUpperCase().includes('CREDITO');
        return isCredito ? '<span class="badge warn">Crédito</span>' : '<span class="badge ok">Contado</span>';
      }
    },
    {
      header: 'IVA',
      render: (item) => `${item.iva_porcentaje || 10}%`
    },
    {
      header: 'Subtotal',
      render: (item) => formatCurrency(item.subtotal, 'PYG')
    },
    {
      header: 'Descuento',
      render: (item) => (item.descuento_total ? formatCurrency(item.descuento_total, 'PYG') : '-')
    },
    {
      header: 'IVA calculado',
      render: (item) => formatCurrency(item.impuesto_total || 0, 'PYG')
    },
    {
      header: 'Total',
      render: (item) => renderTotalAmount(item)
    },
    {
      header: 'Saldo pendiente',
      render: (item) => {
        const saldo = Number(item.saldo_pendiente ?? 0);
        if (saldo > 0) {
          return `<span class="badge warn">${formatCurrency(saldo, 'PYG')}</span>`;
        }
        return '<span class="badge ok">0</span>';
      }
    },
    {
      header: 'Items',
      render: (item) => `${Array.isArray(item.detalles) ? item.detalles.length : 0}`
    },
    {
      header: 'Factura digital',
      render: (item) => {
        const isAnulada = item.deleted_at || (item.estado && item.estado.toUpperCase() === 'ANULADA');
        if (isAnulada) {
          return '<span class="badge error">Anulada</span>';
        }
        const factura = item.factura_digital;
        if (factura?.id) {
          return `<button type="button" class="btn ghost small" data-docs-id="${item.id}">Ver PDF</button>`;
        }
        return '<span class="badge muted">Pendiente</span>';
      }
    }
  ],
  async fetchList({ filters, page, pageSize }) {
    const safeFilters = { ...filters };
    if (!safeFilters.fecha_desde && !safeFilters.fecha_hasta) {
      const today = todayIso();
      safeFilters.fecha_desde = today;
      safeFilters.fecha_hasta = today;
    }

    ventasState.lastFilters = { ...safeFilters };
    const query = buildQuery({
      search: safeFilters.search,
      iva_porcentaje: safeFilters.iva_porcentaje,
      moneda: safeFilters.moneda,
      fecha_desde: safeFilters.fecha_desde,
      fecha_hasta: safeFilters.fecha_hasta,
      include_deleted: safeFilters.include_deleted ? 'true' : undefined
    });
    const endpoint = query ? `${this.endpoint}?${query}` : this.endpoint;
    const response = await request(endpoint);
    const data = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    const sorted = data.slice().sort((a, b) => new Date(b.fecha || b.created_at || 0) - new Date(a.fecha || a.created_at || 0));
    ventasState.lastList = sorted;
    ventasState.lastResumen = response?.meta?.resumen || null;
    const currentPage = Number(page ?? filters?.page) || 1;
    const currentPageSize = Number(pageSize ?? filters?.pageSize) || this.pageSize || 10;
    ventasState.currentPage = currentPage;
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / currentPageSize));
    const startIndex = (currentPage - 1) * currentPageSize;
    const paged = sorted.slice(startIndex, startIndex + currentPageSize);

    renderVentasResumenCard(ventasState.lastResumen, total);
    return {
      data: paged,
      meta: {
        page: currentPage,
        pageSize: currentPageSize,
        total,
        totalPages
      }
    };
  }
};

// Permite abrir factura digital y recibos asociados a la venta
if (typeof window !== 'undefined') {
  window.__openDocsVenta = async function openDocsVenta(ventaId) {
    if (!ventaId) return;
    const venta = ventasState.lastList.find((v) => v.id === ventaId);
    if (!venta || !venta.factura_digital?.id) return;

    // Abrir factura digital
    const facturaUrl = urlWithSession(`/facturas-digitales/${encodeURIComponent(venta.factura_digital.id)}/pdf`);
    const facturaWin = window.open(facturaUrl, '_blank');
    if (!facturaWin) {
      alert('No se pudo abrir la factura. Desbloquea ventanas emergentes.');
    }

    // Si es crédito o tiene saldo, abrir recibos asociados
    try {
      const recibos = await request(`/recibos?ventaId=${encodeURIComponent(ventaId)}`);
      const lista = Array.isArray(recibos) ? recibos : Array.isArray(recibos?.data) ? recibos.data : [];
      lista.forEach((rec) => {
        if (rec?.id) {
          window.open(urlWithSession(`/recibos/${encodeURIComponent(rec.id)}/pdf`), '_blank');
        }
      });
    } catch (err) {
      console.error('[Recibos] No se pudieron abrir.', err);
    }
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.matches('button[data-docs-id]')) {
      event.preventDefault();
      const ventaId = target.getAttribute('data-docs-id');
      window.__openDocsVenta(ventaId);
    }
  });
}
