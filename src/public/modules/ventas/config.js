import { request, buildQuery } from '../common/api.js';
import { formatCurrency, formatDate } from '../common/format.js';

const IVA_OPTIONS = [
  { value: '10', label: 'IVA 10%' },
  { value: '5', label: 'IVA 5%' }
];

const ventasState = {
  lastList: [],
  lastFilters: {}
};

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_ONLY_REGEX = /^\d{4}-\d{2}$/;
const DATE_ONLY_FORMATTER = new Intl.DateTimeFormat('es-PY', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat('es-PY', {
  year: 'numeric',
  month: 'long'
});

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

function normalizeMonthString(input) {
  if (!input) return null;
  if (typeof input === 'string' && MONTH_ONLY_REGEX.test(input)) {
    return input;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 7);
}

function formatDateOnly(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return DATE_ONLY_FORMATTER.format(date);
}

function formatMonthLabel(month) {
  if (!MONTH_ONLY_REGEX.test(month)) return month;
  const [year, monthIndex] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, (monthIndex || 1) - 1, 1));
  return MONTH_LABEL_FORMATTER.format(date);
}

function calculateTotals(ventas) {
  return ventas.reduce(
    (acc, venta) => {
      acc.subtotal += toNumber(venta.subtotal);
      acc.descuento += toNumber(venta.descuento_total);
      acc.impuesto += toNumber(venta.impuesto_total);
      const total = venta.total !== undefined ? toNumber(venta.total) : toNumber(venta.subtotal) - toNumber(venta.descuento_total);
      acc.total += total;
      return acc;
    },
    { subtotal: 0, descuento: 0, impuesto: 0, total: 0 }
  );
}

function buildFiltersSummary(filters) {
  if (!filters) return '';
  const chips = [];
  if (filters.search) chips.push(`Búsqueda: <strong>${escapeHtml(filters.search)}</strong>`);
  if (filters.estado) chips.push(`Estado contiene: <strong>${escapeHtml(filters.estado)}</strong>`);
  if (filters.iva_porcentaje) chips.push(`IVA: <strong>${escapeHtml(String(filters.iva_porcentaje))}%</strong>`);
  if (filters.include_deleted) chips.push('Incluye registros eliminados');
  if (!chips.length) return '';
  return `<ul class="filters">${chips.map((chip) => `<li>${chip}</li>`).join('')}</ul>`;
}

function resolveInvoiceNumber(venta) {
  if (!venta) return '-';
  if (venta.factura_electronica?.nro_factura) {
    return venta.factura_electronica.nro_factura;
  }
  if (venta.numero_factura) {
    return venta.numero_factura;
  }
  return venta.id ? venta.id.slice(0, 8).toUpperCase() : '-';
}

function openPrintWindow({ title, heading, subtitle, bodyHtml }) {
  if (typeof window === 'undefined') return null;
  const win = window.open('', '', 'width=900,height=650');
  if (!win) return null;
  const safeTitle = escapeHtml(title || 'Reporte de ventas');
  const safeHeading = escapeHtml(heading || 'Reporte de ventas');
  const safeSubtitle = subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : '';
  const generated = formatDate(new Date().toISOString());

  win.document.open();
  win.document.write(`<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="utf-8">
      <title>${safeTitle}</title>
      <style>
  :root { color-scheme: light; }
  *, *::before, *::after { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
  body { font-family: 'Segoe UI', sans-serif; margin: 32px; color: #111827; background-color: #ffffff; }
        header { text-align: center; margin-bottom: 24px; }
        header h1 { margin: 0; font-size: 24px; }
        header .subtitle { margin: 6px 0 0; font-size: 15px; color: #4b5563; }
        .filters { list-style: none; padding: 0; margin: 0 0 16px; display: flex; flex-wrap: wrap; gap: 10px; }
  .filters li { background-color: #fef3c7; color: #7c2d12; border-radius: 999px; padding: 6px 12px; font-size: 0.8rem; }
  .report-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .report-table thead th { background-color: #f97316; color: #ffffff; text-transform: uppercase; letter-spacing: 0.04em; }
  .report-table th, .report-table td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
  .report-table td.right { text-align: right; }
  .report-table tfoot tr { background-color: #111827; color: #ffffff; }
        .report-table tfoot td { font-weight: 600; }
        footer { margin-top: 28px; text-align: right; font-size: 0.78rem; color: #6b7280; }
        @media print {
          body { margin: 20px; }
          .filters li { background: #e5e7eb; color: #111827; }
        }
      </style>
    </head>
    <body>
      <header>
        <h1>${safeHeading}</h1>
        ${safeSubtitle}
      </header>
      <main>
        ${bodyHtml}
      </main>
      <footer>
        <small>Generado ${escapeHtml(generated)}</small>
      </footer>
      <script>
        window.addEventListener('load', function () {
          window.focus();
          window.print();
          setTimeout(function () { window.close(); }, 250);
        });
      </script>
    </body>
  </html>`);
  win.document.close();
  return win;
}

function printDailyReport(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para generar el reporte.', 'info');
    return;
  }
  // Accept a single date or a date range (fecha_desde..fecha_hasta). If both are provided and
  // valid, generate a consolidated report for the inclusive range.
  let start = null;
  let end = null;

  if (filters && filters.fecha_desde) {
    if (!DATE_ONLY_REGEX.test(filters.fecha_desde)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha desde del reporte.', 'error');
      return;
    }
    start = filters.fecha_desde;
  }
  if (filters && filters.fecha_hasta) {
    if (!DATE_ONLY_REGEX.test(filters.fecha_hasta)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha hasta del reporte.', 'error');
      return;
    }
    end = filters.fecha_hasta;
  }

  // If neither provided, prompt the user for a single date
  if (!start && !end) {
    const suggestion = new Date().toISOString().slice(0, 10);
    const input = window.prompt('Ingresá la fecha (YYYY-MM-DD) para el reporte diario', suggestion);
    if (!input) return;
    if (!DATE_ONLY_REGEX.test(input)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha del reporte.', 'error');
      return;
    }
    start = input;
    end = input;
  }

  // If only one side provided, treat as single-day range
  if (start && !end) end = start;
  if (!start && end) start = end;

  // Ensure start <= end
  if (start > end) {
    showMessage('La fecha "Desde" debe ser anterior o igual a la fecha "Hasta".', 'error');
    return;
  }

  // Build inclusive set of date keys
  function datesBetween(a, b) {
    const out = [];
    const s = new Date(a + 'T00:00:00');
    const e = new Date(b + 'T00:00:00');
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  const range = datesBetween(start, end);
  const rangeSet = new Set(range);

  const ventas = ventasState.lastList.filter((venta) => rangeSet.has(normalizeDateString(venta.fecha || venta.created_at)));
  if (!ventas.length) {
    const label = start === end ? start : `${start} → ${end}`;
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }

  const totals = calculateTotals(ventas);
  const filtersSummary = buildFiltersSummary(filters);
  const itemsTotal = ventas.reduce(
    (acc, venta) => acc + (Array.isArray(venta.detalles) ? venta.detalles.length : 0),
    0
  );
  const rows = ventas
    .map((venta) => {
      const cliente = venta.cliente?.nombre_razon_social || 'Cliente eventual';
      const usuario = venta.usuario?.nombre || venta.usuario?.usuario || '-';
      const itemsCount = Array.isArray(venta.detalles) ? venta.detalles.length : 0;
      const numeroFactura = resolveInvoiceNumber(venta);
      return `
        <tr>
          <td>${escapeHtml(formatDate(venta.fecha))}</td>
          <td>${escapeHtml(numeroFactura)}</td>
          <td>${escapeHtml(cliente)}</td>
          <td>${escapeHtml(usuario)}</td>
          <td>${escapeHtml(venta.estado || '-')}</td>
          <td class="right">${formatCurrency(toNumber(venta.subtotal), 'PYG')}</td>
          <td class="right">${formatCurrency(toNumber(venta.descuento_total), 'PYG')}</td>
          <td class="right">${formatCurrency(toNumber(venta.impuesto_total), 'PYG')}</td>
          <td class="right">${formatCurrency(toNumber(venta.total), 'PYG')}</td>
          <td class="right">${itemsCount}</td>
        </tr>
      `;
    })
    .join('');

  const totalsRow = `
    <tr class="totals-row">
      <td colspan="5">Totales (${ventas.length} ventas)</td>
      <td class="right">${formatCurrency(round(totals.subtotal), 'PYG')}</td>
      <td class="right">${formatCurrency(round(totals.descuento), 'PYG')}</td>
      <td class="right">${formatCurrency(round(totals.impuesto), 'PYG')}</td>
      <td class="right">${formatCurrency(round(totals.total), 'PYG')}</td>
      <td class="right">${itemsTotal}</td>
    </tr>
  `;

  const bodyHtml = `
    ${filtersSummary}
    <table class="report-table">
      <thead>
        <tr>
          <th>Fecha</th>
          <th>N° factura</th>
          <th>Cliente</th>
          <th>Usuario</th>
          <th>Estado</th>
          <th>Subtotal</th>
          <th>Descuento</th>
          <th>IVA</th>
          <th>Total</th>
          <th>Items</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>${totalsRow}</tfoot>
    </table>
  `;

  const subtitle = start === end
    ? `Fecha: ${formatDateOnly(start)}`
    : `Rango: ${formatDateOnly(start)} – ${formatDateOnly(end)}`;
  const titleRange = start === end ? start : `${start}_${end}`;
  const win = openPrintWindow({
    title: `Reporte diario ${titleRange}`,
    heading: 'Reporte diario de ventas',
    subtitle,
    bodyHtml
  });

  if (!win) {
    showMessage('No se pudo abrir la ventana de impresión. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
}

function printMonthlyReport(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para generar el reporte.', 'info');
    return;
  }

  let month = '';
  if (filters.mes) {
    month = filters.mes;
  } else if (filters.fecha_desde && DATE_ONLY_REGEX.test(filters.fecha_desde)) {
    month = filters.fecha_desde.slice(0, 7);
  }

  if (month && !MONTH_ONLY_REGEX.test(month)) {
    showMessage('Usa el formato YYYY-MM para el mes del reporte.', 'error');
    return;
  }

  if (!month) {
    const suggestion = new Date().toISOString().slice(0, 7);
    const input = window.prompt('Ingresá el mes (YYYY-MM) para el reporte mensual', suggestion);
    if (!input) return;
    if (!MONTH_ONLY_REGEX.test(input)) {
      showMessage('Usa el formato YYYY-MM para el mes del reporte.', 'error');
      return;
    }
    month = input;
  }

  const monthlySales = ventasState.lastList.filter((venta) => normalizeMonthString(venta.fecha || venta.created_at) === month);
  if (!monthlySales.length) {
    showMessage(`No se encontraron ventas para ${month}.`, 'info');
    return;
  }

  const grouped = new Map();
  monthlySales.forEach((venta) => {
    const dayKey = normalizeDateString(venta.fecha || venta.created_at);
    if (!dayKey) return;
    if (!grouped.has(dayKey)) {
      grouped.set(dayKey, { count: 0, subtotal: 0, descuento: 0, impuesto: 0, total: 0 });
    }
    const bucket = grouped.get(dayKey);
    bucket.count += 1;
    bucket.subtotal += toNumber(venta.subtotal);
    bucket.descuento += toNumber(venta.descuento_total);
    bucket.impuesto += toNumber(venta.impuesto_total);
    bucket.total += toNumber(venta.total !== undefined ? venta.total : venta.subtotal);
  });

  const sorted = Array.from(grouped.entries()).sort((a, b) => (a[0] > b[0] ? 1 : -1));
  const rows = sorted
    .map(([day, bucket]) => `
      <tr>
        <td>${escapeHtml(formatDateOnly(day))}</td>
        <td class="right">${bucket.count}</td>
        <td class="right">${formatCurrency(round(bucket.subtotal), 'PYG')}</td>
        <td class="right">${formatCurrency(round(bucket.descuento), 'PYG')}</td>
        <td class="right">${formatCurrency(round(bucket.impuesto), 'PYG')}</td>
        <td class="right">${formatCurrency(round(bucket.total), 'PYG')}</td>
      </tr>
    `)
    .join('');

  const totals = calculateTotals(monthlySales);
  const filtersSummary = buildFiltersSummary(filters);
  const totalsRow = `
    <tr class="totals-row">
      <td>Totales (${monthlySales.length} ventas en ${sorted.length} días)</td>
      <td class="right">${monthlySales.length}</td>
      <td class="right">${formatCurrency(round(totals.subtotal), 'PYG')}</td>
      <td class="right">${formatCurrency(round(totals.descuento), 'PYG')}</td>
      <td class="right">${formatCurrency(round(totals.impuesto), 'PYG')}</td>
      <td class="right">${formatCurrency(round(totals.total), 'PYG')}</td>
    </tr>
  `;
  const bodyHtml = `
    ${filtersSummary}
    <table class="report-table">
      <thead>
        <tr>
          <th>Día</th>
          <th>Ventas</th>
          <th>Subtotal</th>
          <th>Descuento</th>
          <th>IVA</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>${totalsRow}</tfoot>
    </table>
  `;

  const subtitle = `Mes: ${formatMonthLabel(month)}`;
  const win = openPrintWindow({
    title: `Reporte mensual ${month}`,
    heading: 'Reporte mensual de ventas',
    subtitle,
    bodyHtml
  });

  if (!win) {
    showMessage('No se pudo abrir la ventana de impresión. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
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
  searchPlaceholder: 'Buscar por cliente, usuario o ID',
  filters: [
    {
      name: 'estado',
      label: 'Estado',
      type: 'text',
      placeholder: 'PENDIENTE, PAGADA...'
    },
    {
      name: 'iva_porcentaje',
      label: 'IVA',
      type: 'select',
      options: IVA_OPTIONS
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
    },
    {
      name: 'mes',
      label: 'Mes',
      type: 'month'
    }
  ],
  moduleActions: [
    { action: 'print-daily', label: 'Reporte diario', className: 'btn ghost small' },
    { action: 'print-monthly', label: 'Reporte mensual', className: 'btn ghost small' }
  ],
  rowActions: [
    {
      action: 'anular',
      label: 'Anular',
      className: 'btn danger small',
      shouldRender: ({ item }) => !item.deleted_at,
      isDisabled: ({ item }) => item.estado && item.estado.toUpperCase() === 'ANULADA'
    }
  ],
  rowActionHandlers: {
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
    'print-monthly': ({ filters, showMessage }) => printMonthlyReport(filters, showMessage)
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
      render: (item) => formatCurrency(item.total, 'PYG')
    },
    {
      header: 'Items',
      render: (item) => `${Array.isArray(item.detalles) ? item.detalles.length : 0}`
    }
  ],
  async fetchList({ filters }) {
    ventasState.lastFilters = { ...filters };
    const query = buildQuery({
      search: filters.search,
      estado: filters.estado,
      iva_porcentaje: filters.iva_porcentaje,
      fecha_desde: filters.fecha_desde,
      fecha_hasta: filters.fecha_hasta,
      mes: filters.mes,
      include_deleted: filters.include_deleted ? 'true' : undefined
    });
    const endpoint = query ? `${this.endpoint}?${query}` : this.endpoint;
    const response = await request(endpoint);
    const data = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    const sorted = data.slice().sort((a, b) => new Date(b.fecha || b.created_at || 0) - new Date(a.fecha || a.created_at || 0));
    ventasState.lastList = sorted;
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
