import { formatCurrency, formatDate } from '../common/format.js';
import { buildQuery, request } from '../common/api.js';
import { createCierreCaja, prepareCierrePayload, fetchEstadoCaja, crearAperturaCaja } from './nuevo.js';
import { crearSalidaCaja } from './salida.js';
import { fetchCierreDetalle } from './detalle.js';

let resumenContainer = null;
let formElement = null;
let estadoActual = null;

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return char;
    }
  });
}

function ensureResumenContainer(form) {
  if (!form) return null;
  if (resumenContainer && resumenContainer.isConnected) {
    return resumenContainer;
  }
  resumenContainer = document.createElement('section');
  resumenContainer.className = 'caja-resumen';
  resumenContainer.innerHTML = '<p class="muted">Consultando estado de caja...</p>';
  form.prepend(resumenContainer);
  return resumenContainer;
}

function cleanupResumenContainer() {
  if (resumenContainer && resumenContainer.parentNode) {
    resumenContainer.parentNode.removeChild(resumenContainer);
  }
  resumenContainer = null;
}

function setFormEnabled(enabled) {
  if (!formElement) return;
  const controlNames = ['fecha_cierre', 'efectivo_declarado', 'total_tarjeta', 'total_transferencia', 'observaciones'];
  controlNames.forEach((name) => {
    const control = formElement.elements[name];
    if (control) {
      control.disabled = !enabled;
    }
  });
  const submit = formElement.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = !enabled;
  }
}

function setDefaultFechaCierre() {
  if (!formElement) return;
  const control = formElement.elements.fecha_cierre;
  if (!control || control.value) return;
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  control.value = local;
}

function renderResumen(estado, error) {
  const container = ensureResumenContainer(formElement);
  if (!container) return;

  if (error) {
    container.innerHTML = `<p class="error-text">${escapeHtml(error.message || 'No se pudo obtener el estado de caja.')}</p>`;
    setFormEnabled(false);
    return;
  }

  if (!estado) {
    container.innerHTML =
      '<p class="muted">No hay una apertura activa. Usá el botón "Apertura de caja" para iniciar la jornada.</p>';
    setFormEnabled(false);
    return;
  }

  setFormEnabled(true);
  setDefaultFechaCierre();

  const { totales = {}, periodo = {} } = estado;
  const salidas = Array.isArray(estado.salidasPendientes) ? estado.salidasPendientes : [];
  const periodoTexto = periodo.desde
    ? `${formatDate(periodo.desde)} -> ${formatDate(periodo.hasta)}`
    : 'Periodo no disponible';

  const salidasHtml = salidas.length
    ? `<ul class="caja-resumen__salidas">${salidas
        .map(
          (salida) =>
            `<li>${formatDate(salida.fecha)} · ${escapeHtml(salida.descripcion)} · ${formatCurrency(
              salida.monto,
              'PYG'
            )}</li>`
        )
        .join('')}</ul>`
    : '<p class="muted">Sin salidas pendientes.</p>';

  container.innerHTML = `
    <div class="caja-resumen__header">
      <h3>Estado de caja</h3>
      <p>${escapeHtml(periodoTexto)}</p>
    </div>
    <div class="caja-resumen__totales">
      <div><span>Saldo inicial</span><strong>${formatCurrency(totales.saldoInicial, 'PYG')}</strong></div>
      <div><span>Ventas</span><strong>${formatCurrency(totales.ventas, 'PYG')}</strong></div>
      <div><span>Salidas pendientes</span><strong>${formatCurrency(totales.salidas, 'PYG')}</strong></div>
      <div><span>Efectivo esperado</span><strong>${formatCurrency(totales.efectivoEsperado, 'PYG')}</strong></div>
    </div>
    ${salidasHtml}
  `;
}

async function actualizarResumen({ showMessage } = {}) {
  const container = ensureResumenContainer(formElement);
  if (container) {
    container.innerHTML = '<p class="muted">Consultando estado de caja...</p>';
  }

  try {
    const estado = await fetchEstadoCaja();
    estadoActual = estado;
    renderResumen(estado, null);
  } catch (error) {
    console.error('[caja] estado', error);
    estadoActual = null;
    renderResumen(null, error);
    if (showMessage) {
      showMessage(error.message || 'No se pudo obtener el estado de caja.', 'error');
    }
  }
}

function resumenEnTexto(estado) {
  if (!estado) {
    return 'No hay una apertura activa en este momento.';
  }
  const { totales = {}, periodo = {} } = estado;
  const salidas = Array.isArray(estado.salidasPendientes) ? estado.salidasPendientes : [];
  return [
    `Periodo: ${formatDate(periodo.desde)} -> ${formatDate(periodo.hasta)}`,
    `Saldo inicial: ${formatCurrency(totales.saldoInicial, 'PYG')}`,
    `Ventas registradas: ${formatCurrency(totales.ventas, 'PYG')}`,
    `Salidas pendientes: ${formatCurrency(totales.salidas, 'PYG')} (${salidas.length})`,
    `Efectivo esperado: ${formatCurrency(totales.efectivoEsperado, 'PYG')}`
  ].join('\n');
}

function formatBadge(value) {
  if (value === null || value === undefined || value === '') return '-';
  return formatCurrency(value, 'PYG');
}

export const cajaModule = {
  key: 'caja',
  label: 'Cierre de Caja',
  labelSingular: 'Cierre',
  singular: 'Cierre',
  singularLower: 'cierre',
  endpoint: '/cierres-caja',
  pageSize: 10,
  searchPlaceholder: 'Buscar por observación o responsable',
  supportsEdit: false,
  supportsDelete: false,
  fields: [
    { name: 'fecha_cierre', label: 'Fecha de cierre', type: 'datetime-local' },
    { name: 'efectivo_declarado', label: 'Efectivo contado (PYG)', type: 'number', step: '0.01', min: '0', cast: 'float' },
    { name: 'total_tarjeta', label: 'Cobros con tarjeta (PYG)', type: 'number', step: '0.01', min: '0', cast: 'float' },
    {
      name: 'total_transferencia',
      label: 'Cobros por transferencia (PYG)',
      type: 'number',
      step: '0.01',
      min: '0',
      cast: 'float'
    },
    { name: 'observaciones', label: 'Observaciones', type: 'textarea', rows: 3 }
  ],
  filters: [
    { name: 'fecha_desde', label: 'Desde', type: 'date' },
    { name: 'fecha_hasta', label: 'Hasta', type: 'date' }
  ],
  moduleActions: [
    {
      action: 'abrir-caja',
      label: 'Apertura de caja',
      className: 'btn primary'
    },
    {
      action: 'ver-estado',
      label: 'Ver estado',
      className: 'btn ghost'
    },
    {
      action: 'registrar-salida',
      label: 'Registrar salida de caja',
      className: 'btn ghost'
    }
  ],
  moduleActionHandlers: {
    'abrir-caja': async ({ showMessage, reload }) => {
      try {
        const saldoPrompt = window.prompt(
          'Saldo inicial de la apertura (Gs)',
          estadoActual?.totales?.saldoInicial ?? '0'
        );
        if (saldoPrompt === null) return;
        const observacion = window.prompt('Observaciones (opcional)') ?? undefined;
        await crearAperturaCaja({ saldo_inicial: saldoPrompt, observaciones: observacion });
        showMessage('Apertura registrada correctamente.', 'success');
        await actualizarResumen({ showMessage });
        await reload();
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo registrar la apertura.', 'error');
      }
    },
    'ver-estado': async ({ showMessage }) => {
      await actualizarResumen({ showMessage });
      if (!estadoActual) {
        showMessage('No hay una apertura activa.', 'info');
        return;
      }
      window.alert(resumenEnTexto(estadoActual));
    },
    'registrar-salida': async ({ showMessage, reload }) => {
      try {
        await crearSalidaCaja();
        showMessage('Salida registrada correctamente.', 'success');
        await actualizarResumen({ showMessage });
        await reload();
      } catch (error) {
        if (error.message === 'Registro cancelado.') return;
        console.error(error);
        showMessage(error.message || 'No se pudo registrar la salida.', 'error');
      }
    }
  },
  rowActions: [
    {
      action: 'ver-salidas',
      label: 'Ver salidas',
      shouldRender: ({ item }) => Array.isArray(item.salidas) && item.salidas.length > 0
    },
    {
      action: 'descargar-reporte',
      label: 'Reporte PDF',
      className: 'btn ghost small'
    },
    {
      action: 'registrar-salida-cierre',
      label: 'Registrar salida',
      className: 'btn ghost small'
    }
  ],
  rowActionHandlers: {
    'ver-salidas': async ({ id, showMessage }) => {
      try {
        const detalle = await fetchCierreDetalle(id);
        const salidas = Array.isArray(detalle?.salidas) ? detalle.salidas : [];
        if (!salidas.length) {
          showMessage('El cierre no tiene salidas registradas.', 'info');
          return;
        }
        const list = salidas
          .map((salida) => `${formatDate(salida.fecha)} · ${salida.descripcion} · ${formatCurrency(salida.monto, 'PYG')}`)
          .join('\n');
        window.alert(`Salidas registradas:\n\n${list}`);
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudieron obtener las salidas.', 'error');
      }
    },
    'descargar-reporte': ({ id }) => {
      if (!id) return;
      const url = `/cierres-caja/${id}/reporte`;
      window.open(url, '_blank', 'noopener');
    },
    'registrar-salida-cierre': async ({ id, showMessage, reload }) => {
      if (!id) return;
      try {
        await crearSalidaCaja({ cierreId: id });
        showMessage('Salida registrada en el cierre.', 'success');
        if (typeof reload === 'function') {
          await reload();
        }
      } catch (error) {
        if (error.message === 'Registro cancelado.') return;
        console.error(error);
        showMessage(error.message || 'No se pudo registrar la salida.', 'error');
      }
    }
  },
  columns: [
    { header: 'Fecha apertura', render: (item) => formatDate(item.fecha_apertura) },
    { header: 'Fecha cierre', render: (item) => formatDate(item.fecha_cierre) },
    {
      header: 'Responsable',
      render: (item) => item.usuario?.nombre || item.usuario?.usuario || item.usuarioId || '-'
    },
    { header: 'Saldo inicial', render: (item) => formatCurrency(item.saldo_inicial, 'PYG') },
    { header: 'Ventas', render: (item) => formatCurrency(item.total_ventas, 'PYG') },
    { header: 'Efectivo', render: (item) => formatCurrency(item.total_efectivo, 'PYG') },
    { header: 'Salidas', render: (item) => formatBadge(item.total_salidas) },
    {
      header: 'Declarado',
      render: (item) => (item.efectivo_declarado != null ? formatCurrency(item.efectivo_declarado, 'PYG') : '-')
    },
    {
      header: 'Diferencia',
      render: (item) => {
        const diff = item.diferencia != null ? Number(item.diferencia) : null;
        if (diff === null) return '-';
        const label = formatCurrency(diff, 'PYG');
        if (diff === 0) return `<span class="badge ok">${label}</span>`;
        return `<span class="badge warn">${label}</span>`;
      }
    },
    {
      header: 'Obs.',
      render: (item) => (item.observaciones ? escapeHtml(item.observaciones) : '-')
    }
  ],
  async fetchList({ page, pageSize, filters }) {
    const query = buildQuery({
      search: filters.search,
      fecha_desde: filters.fecha_desde,
      fecha_hasta: filters.fecha_hasta,
      include_deleted: filters.include_deleted ? 'true' : undefined
    });
    const endpoint = query ? `${this.endpoint}?${query}` : this.endpoint;
    const response = await request(endpoint);
    const data = Array.isArray(response?.data) ? response.data : [];
    return {
      data,
      meta: {
        page,
        pageSize,
        total: response?.meta?.total ?? data.length,
        totalPages: Math.max(1, Math.ceil((response?.meta?.total ?? data.length) / pageSize)),
        resumen: response?.meta || null
      }
    };
  },
  actions: {
    nuevo: {
      submit: createCierreCaja,
      transform: prepareCierrePayload,
      successMessage: 'Cierre de caja registrado.'
    }
  },
  hooks: {
    beforeModuleChange: () => {
      cleanupResumenContainer();
      formElement = null;
    },
    afterFormRender: ({ form }) => {
      formElement = form || null;
      ensureResumenContainer(formElement);
      setDefaultFechaCierre();
    },
    afterModuleChange: ({ form }) => {
      formElement = form || null;
      ensureResumenContainer(formElement);
      setDefaultFechaCierre();
      actualizarResumen().catch(() => {});
    },
    afterSave: async () => {
      await actualizarResumen();
    },
    onResetForm: ({ form }) => {
      formElement = form || formElement;
      setDefaultFechaCierre();
    }
  }
};
