import { request, buildQuery } from '../common/api.js';
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
  lastResumen: null
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
  const url = query ? `/ventas/reporte/${type}?${query}` : `/ventas/reporte/${type}`;
  const win = typeof window !== 'undefined' ? window.open(url, '_blank') : null;
  if (!win) {
    showMessage('No se pudo abrir la ventana del reporte. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
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
  pageSize: 50,
  supportsPagination: false,
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
    { action: 'print-margin', label: 'Reporte margen', className: 'btn ghost small' }
  ],
  rowActions: [
    {
      action: 'facturar',
      label: 'Facturar',
      className: 'btn secondary small',
      shouldRender: ({ item }) => {
        if (!item || item.deleted_at) return false;
        const estado = String(item.estado || '').toUpperCase();
        return estado !== 'ANULADA' && estado !== 'FACTURADO';
      },
      isDisabled: ({ item }) => {
        if (!item) return true;
        const estado = String(item.estado || '').toUpperCase();
        return estado === 'ANULADA';
      }
    },
    {
      action: 'anular',
      label: 'Anular',
      className: 'btn danger small',
      shouldRender: ({ item }) => !item.deleted_at,
      isDisabled: ({ item }) => item.estado && item.estado.toUpperCase() === 'ANULADA'
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
    }
  },
  moduleActionHandlers: {
    'print-daily': ({ filters, showMessage }) => printDailyReport(filters, showMessage),
    'print-margin': ({ filters, showMessage }) => printMarginReport(filters, showMessage)
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
      header: 'Items',
      render: (item) => `${Array.isArray(item.detalles) ? item.detalles.length : 0}`
    },
    {
      header: 'Factura digital',
      render: (item) => {
        const factura = item.factura_digital;
        if (factura?.id) {
          const url = `/facturas-digitales/${encodeURIComponent(factura.id)}/pdf`;
          return `<a href="${url}" target="_blank" rel="noopener" class="btn ghost small">Ver PDF</a>`;
        }
        return '<span class="badge muted">Pendiente</span>';
      }
    }
  ],
  async fetchList({ filters }) {
    ventasState.lastFilters = { ...filters };
    const query = buildQuery({
      search: filters.search,
      iva_porcentaje: filters.iva_porcentaje,
      moneda: filters.moneda,
      fecha_desde: filters.fecha_desde,
      fecha_hasta: filters.fecha_hasta,
      include_deleted: filters.include_deleted ? 'true' : undefined
    });
    const endpoint = query ? `${this.endpoint}?${query}` : this.endpoint;
    const response = await request(endpoint);
    const data = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    const sorted = data.slice().sort((a, b) => new Date(b.fecha || b.created_at || 0) - new Date(a.fecha || a.created_at || 0));
    ventasState.lastList = sorted;
    ventasState.lastResumen = response?.meta?.resumen || null;
    renderVentasResumenCard(ventasState.lastResumen, sorted.length);
    return {
      data: sorted,
      meta: {
        page: 1,
        pageSize: sorted.length,
        total: sorted.length,
        totalPages: 1
      }
    };
  }
};
