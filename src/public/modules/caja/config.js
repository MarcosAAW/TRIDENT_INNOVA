import { formatCurrency, formatDate } from '../common/format.js';
import { buildQuery, request, urlWithSession } from '../common/api.js';
import { openUrlInNewTab } from '../common/dialogs.js';
import { createCierreCaja, prepareCierrePayload, fetchEstadoCaja, crearAperturaCaja } from './nuevo.js';
import { crearSalidaCaja } from './salida.js';
import { fetchCierreDetalle } from './detalle.js';

let resumenContainer = null;
let formElement = null;
let estadoActual = null;

function openCajaDialog({ title, description, fields, submitLabel = 'Guardar' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'caja-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'caja-dialog';

    const heading = document.createElement('h3');
    heading.textContent = title || 'Completar datos';
    dialog.appendChild(heading);

    if (description) {
      const descriptionNode = document.createElement('p');
      descriptionNode.className = 'caja-dialog__description';
      descriptionNode.textContent = description;
      dialog.appendChild(descriptionNode);
    }

    const form = document.createElement('form');
    form.className = 'caja-dialog__form';

    const cleanup = (value) => {
      overlay.remove();
      resolve(value);
    };

    fields.forEach((field) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'caja-dialog__field';

      const label = document.createElement('span');
      label.textContent = field.label;
      wrapper.appendChild(label);

      const input = field.type === 'textarea'
        ? document.createElement('textarea')
        : document.createElement('input');

      if (field.type && field.type !== 'textarea') {
        input.type = field.type;
      }

      input.name = field.name;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.value !== undefined && field.value !== null) input.value = String(field.value);
      if (field.step !== undefined) input.step = field.step;
      if (field.min !== undefined) input.min = field.min;
      if (field.rows !== undefined && input.tagName === 'TEXTAREA') input.rows = field.rows;
      if (field.required) input.required = true;

      wrapper.appendChild(input);
      form.appendChild(wrapper);
    });

    const actions = document.createElement('div');
    actions.className = 'caja-dialog__actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn ghost';
    cancelButton.textContent = 'Cancelar';
    cancelButton.addEventListener('click', () => cleanup(null));

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'btn primary';
    submitButton.textContent = submitLabel;

    actions.append(cancelButton, submitButton);
    form.appendChild(actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      fields.forEach((field) => {
        const control = form.elements[field.name];
        values[field.name] = control?.value ?? '';
      });
      cleanup(values);
    });

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });

    document.addEventListener(
      'keydown',
      function onKeydown(event) {
        if (event.key === 'Escape') {
          document.removeEventListener('keydown', onKeydown);
          cleanup(null);
        }
      },
      { once: true }
    );

    dialog.appendChild(form);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const firstInput = form.querySelector('input, textarea');
    if (firstInput) {
      firstInput.focus();
      if (typeof firstInput.select === 'function') {
        firstInput.select();
      }
    }
  });
}

function openCajaInfoDialog({ title, description, content, closeLabel = 'Cerrar' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'caja-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'caja-dialog caja-dialog--info';

    const heading = document.createElement('h3');
    heading.textContent = title || 'Detalle';
    dialog.appendChild(heading);

    if (description) {
      const descriptionNode = document.createElement('p');
      descriptionNode.className = 'caja-dialog__description';
      descriptionNode.textContent = description;
      dialog.appendChild(descriptionNode);
    }

    const body = document.createElement('div');
    body.className = 'caja-dialog__body';
    if (typeof content === 'string') {
      body.innerHTML = content;
    } else if (content) {
      body.appendChild(content);
    }
    dialog.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'caja-dialog__actions';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn primary';
    closeButton.textContent = closeLabel;

    const cleanup = () => {
      overlay.remove();
      resolve();
    };

    closeButton.addEventListener('click', cleanup);
    actions.appendChild(closeButton);
    dialog.appendChild(actions);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        cleanup();
      }
    });

    document.addEventListener(
      'keydown',
      function onKeydown(event) {
        if (event.key === 'Escape') {
          document.removeEventListener('keydown', onKeydown);
          cleanup();
        }
      },
      { once: true }
    );

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    closeButton.focus();
  });
}

async function promptSalidaCaja() {
  return openCajaDialog({
    title: 'Registrar salida de caja',
    description: 'Cargá el motivo y el monto para registrar una salida manual.',
    submitLabel: 'Registrar salida',
    fields: [
      {
        name: 'descripcion',
        label: 'Descripción',
        type: 'text',
        required: true,
        placeholder: 'Ej. compra chica, viático, entrega'
      },
      {
        name: 'monto',
        label: 'Monto (Gs)',
        type: 'number',
        min: '0.01',
        step: '0.01',
        required: true
      },
      {
        name: 'observacion',
        label: 'Observación',
        type: 'textarea',
        rows: 3,
        placeholder: 'Opcional'
      }
    ]
  });
}

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

  const totalCards = [
    { label: 'Saldo inicial', value: formatCurrency(totales.saldoInicial, 'PYG') },
    { label: 'Ventas', value: formatCurrency(totales.ventas, 'PYG') },
    { label: 'Salidas pendientes', value: formatCurrency(totales.salidas, 'PYG') },
    { label: 'Efectivo esperado', value: formatCurrency(totales.efectivoEsperado, 'PYG') }
  ];

  if (Number(totales.tarjeta) > 0) {
    totalCards.splice(3, 0, { label: 'Cobros tarjeta', value: formatCurrency(totales.tarjeta, 'PYG') });
  }

  if (Number(totales.transferencia) > 0) {
    totalCards.splice(4, 0, { label: 'Cobros transferencia', value: formatCurrency(totales.transferencia, 'PYG') });
  }

  if (Number(totales.ventasUsd) > 0) {
    totalCards.splice(2, 0, { label: 'Ventas USD', value: formatCurrency(totales.ventasUsd, 'USD') });
  }

  if (Number(totales.efectivoUsd) > 0) {
    totalCards.push({ label: 'Efectivo USD', value: formatCurrency(totales.efectivoUsd, 'USD') });
  }

  if (Number(totales.efectivoEsperadoUsd) > 0) {
    totalCards.push({ label: 'Efectivo esperado USD', value: formatCurrency(totales.efectivoEsperadoUsd, 'USD') });
  }

  const totalesHtml = totalCards
    .map((card) => `<div><span>${escapeHtml(card.label)}</span><strong>${card.value}</strong></div>`)
    .join('');

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
    <div class="caja-resumen__totales">${totalesHtml}</div>
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

async function assertAperturaActiva() {
  if (estadoActual) return true;
  await actualizarResumen();
  if (estadoActual) return true;
  throw new Error('No hay una apertura activa.');
}

async function ensureAperturaActivaParaAccion({ showMessage } = {}) {
  try {
    await assertAperturaActiva();
    return true;
  } catch (error) {
    if (showMessage) {
      showMessage('No hay una apertura activa.', 'info');
    }
    return false;
  }
}

function resumenEnTexto(estado) {
  if (!estado) {
    return 'No hay una apertura activa en este momento.';
  }
  const { totales = {}, periodo = {} } = estado;
  const salidas = Array.isArray(estado.salidasPendientes) ? estado.salidasPendientes : [];
  const lineas = [
    `Periodo: ${formatDate(periodo.desde)} -> ${formatDate(periodo.hasta)}`,
    `Saldo inicial: ${formatCurrency(totales.saldoInicial, 'PYG')}`,
    `Ventas registradas: ${formatCurrency(totales.ventas, 'PYG')}`,
    `Salidas pendientes: ${formatCurrency(totales.salidas, 'PYG')} (${salidas.length})`,
    `Efectivo esperado: ${formatCurrency(totales.efectivoEsperado, 'PYG')}`
  ];

  if (Number(totales.tarjeta) > 0) {
    lineas.splice(4, 0, `Cobros tarjeta: ${formatCurrency(totales.tarjeta, 'PYG')}`);
  }

  if (Number(totales.transferencia) > 0) {
    lineas.splice(5, 0, `Cobros transferencia: ${formatCurrency(totales.transferencia, 'PYG')}`);
  }

  if (Number(totales.ventasUsd) > 0) {
    lineas.splice(3, 0, `Ventas USD: ${formatCurrency(totales.ventasUsd, 'USD')}`);
  }
  if (Number(totales.efectivoUsd) > 0) {
    lineas.push(`Efectivo USD: ${formatCurrency(totales.efectivoUsd, 'USD')}`);
  }
  if (Number(totales.efectivoEsperadoUsd) > 0) {
    lineas.push(`Efectivo esperado USD: ${formatCurrency(totales.efectivoEsperadoUsd, 'USD')}`);
  }

  return lineas.join('\n');
}

function formatBadge(value, currency = 'PYG') {
  if (value === null || value === undefined || value === '') return '-';
  return formatCurrency(value, currency);
}

function renderDualCurrency(primary, secondary) {
  const base = formatCurrency(primary, 'PYG');
  if (Number(secondary) > 0) {
    return `${base}<div class="table-sub">${formatCurrency(secondary, 'USD')}</div>`;
  }
  return base;
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
        const payload = await openCajaDialog({
          title: 'Apertura de caja',
          description: 'Registrá el saldo inicial y una observación opcional para iniciar la jornada.',
          submitLabel: 'Registrar apertura',
          fields: [
            {
              name: 'saldo_inicial',
              label: 'Saldo inicial (Gs)',
              type: 'number',
              min: '0',
              step: '0.01',
              required: true,
              value: estadoActual?.totales?.saldoInicial ?? '0'
            },
            {
              name: 'observaciones',
              label: 'Observaciones',
              type: 'textarea',
              rows: 3,
              placeholder: 'Opcional'
            }
          ]
        });
        if (!payload) return;
        await crearAperturaCaja({
          saldo_inicial: payload.saldo_inicial,
          observaciones: payload.observaciones
        });
        showMessage('Apertura registrada correctamente.', 'success');
        await actualizarResumen({ showMessage });
        await reload({ preserveScroll: true });
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
      const lines = resumenEnTexto(estadoActual)
        .split('\n')
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('');
      await openCajaInfoDialog({
        title: 'Estado de caja',
        description: 'Resumen actual de la caja abierta.',
        content: `<ul class="caja-dialog__list">${lines}</ul>`
      });
    },
    'registrar-salida': async ({ showMessage, reload }) => {
      try {
        const aperturaDisponible = await ensureAperturaActivaParaAccion({ showMessage });
        if (!aperturaDisponible) return;
        const payload = await promptSalidaCaja();
        if (!payload) return;
        await crearSalidaCaja(payload);
        showMessage('Salida registrada correctamente.', 'success');
        await actualizarResumen({ showMessage });
        await reload({ preserveScroll: true });
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
          .map(
            (salida) =>
              `<li><strong>${escapeHtml(salida.descripcion)}</strong><span>${escapeHtml(
                formatDate(salida.fecha)
              )}</span><span>${escapeHtml(formatCurrency(salida.monto, 'PYG'))}</span>${
                salida.observacion
                  ? `<small>${escapeHtml(salida.observacion)}</small>`
                  : ''
              }</li>`
          )
          .join('');
        await openCajaInfoDialog({
          title: 'Salidas registradas',
          description: `Cierre con ${salidas.length} salida${salidas.length === 1 ? '' : 's'} asociada${
            salidas.length === 1 ? '' : 's'
          }.`,
          content: `<ul class="caja-dialog__list caja-dialog__list--salidas">${list}</ul>`
        });
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudieron obtener las salidas.', 'error');
      }
    },
    'descargar-reporte': ({ id }) => {
      if (!id) return;
      const url = urlWithSession(`/cierres-caja/${id}/reporte`);
      openUrlInNewTab(url, {
        blockedTitle: 'No se pudo abrir el reporte',
        blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF del cierre de caja.'
      });
    },
    'registrar-salida-cierre': async ({ id, showMessage, reload }) => {
      if (!id) return;
      try {
        const payload = await promptSalidaCaja();
        if (!payload) return;
        await crearSalidaCaja({ ...payload, cierreId: id });
        showMessage('Salida registrada en el cierre.', 'success');
        if (typeof reload === 'function') {
          await reload({ preserveScroll: true });
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
    { header: 'Ventas', render: (item) => renderDualCurrency(item.total_ventas, item.total_ventas_usd) },
    { header: 'Efectivo', render: (item) => renderDualCurrency(item.total_efectivo, item.efectivo_usd) },
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
      submit: async (payload) => {
        await assertAperturaActiva();
        return createCierreCaja(payload);
      },
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
