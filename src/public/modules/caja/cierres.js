import { request, buildQuery } from '../common/api.js';
import { formatCurrency, formatDate } from '../common/format.js';
import { loadSession } from '../auth/session.js';

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toLocalInputValue(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function toISO(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function ensureUsuarioField(form) {
  let input = form.querySelector('input[name="usuarioId"]');
  if (!input) {
    input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'usuarioId';
    form.appendChild(input);
  }
  const session = loadSession();
  if (session?.id) {
    input.value = session.id;
  } else {
    input.value = '';
  }
}

function ensureDateDefaults(form) {
  const cierreInput = form.elements.fecha_cierre;
  if (cierreInput && !cierreInput.value) {
    cierreInput.value = toLocalInputValue(new Date());
  }
  const aperturaInput = form.elements.fecha_apertura;
  if (aperturaInput && !aperturaInput.value) {
    const apertura = new Date();
    apertura.setHours(8, 0, 0, 0);
    aperturaInput.value = toLocalInputValue(apertura);
  }
}

function attachDifferenceWatcher(form) {
  const efectivoField = form.elements.total_efectivo;
  const salidasField = form.elements.total_salidas;
  const declaradoField = form.elements.efectivo_declarado;
  if (!efectivoField || !salidasField || !declaradoField) return;

  let helper = declaradoField.parentElement?.querySelector('[data-diff-output]');
  if (!helper) {
    helper = document.createElement('small');
    helper.dataset.diffOutput = 'true';
    helper.className = 'form-helper';
    declaradoField.parentElement?.appendChild(helper);
  }

  const updateMessage = () => {
    const efectivo = toNumber(efectivoField.value) || 0;
    const salidas = toNumber(salidasField.value) || 0;
    const declarado = toNumber(declaradoField.value);
    if (declarado === undefined) {
      helper.textContent = 'Ingresá el efectivo declarado para calcular la diferencia.';
      helper.classList.remove('warn');
      helper.classList.remove('ok');
      return;
    }
    const diferencia = declarado - (efectivo - salidas);
    helper.textContent = `Diferencia: ${formatCurrency(diferencia, 'PYG')}`;
    helper.classList.toggle('warn', Math.abs(diferencia) > 0.009);
    helper.classList.toggle('ok', Math.abs(diferencia) <= 0.009);
  };

  efectivoField.addEventListener('input', updateMessage);
  salidasField.addEventListener('input', updateMessage);
  declaradoField.addEventListener('input', updateMessage);
  updateMessage();
}

async function createCierre(body) {
  return request('/caja/cierres', { method: 'POST', body });
}

function transformPayload(raw) {
  const payload = {
    usuarioId: raw.usuarioId,
    fecha_apertura: toISO(raw.fecha_apertura),
    fecha_cierre: toISO(raw.fecha_cierre) || new Date().toISOString(),
    total_ventas: toNumber(raw.total_ventas),
    total_efectivo: toNumber(raw.total_efectivo),
    total_tarjeta: toNumber(raw.total_tarjeta),
    total_transferencia: toNumber(raw.total_transferencia),
    total_salidas: toNumber(raw.total_salidas),
    efectivo_declarado: toNumber(raw.efectivo_declarado),
    observaciones: raw.observaciones?.trim() || undefined
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      delete payload[key];
    }
  });

  return payload;
}

function buildDetalleMensaje(cierre) {
  const lineas = [
    `Cierre ${cierre.id}`,
    `Fecha cierre: ${formatDate(cierre.fecha_cierre)}`,
    `Responsable: ${cierre.usuario?.nombre || cierre.usuario?.usuario || 'N/D'}`,
    `Total ventas: ${formatCurrency(cierre.total_ventas, 'PYG')}`,
    `Total efectivo: ${formatCurrency(cierre.total_efectivo, 'PYG')}`,
    `Total salidas: ${formatCurrency(cierre.total_salidas || 0, 'PYG')}`,
    `Efectivo declarado: ${formatCurrency(cierre.efectivo_declarado || 0, 'PYG')}`,
    `Diferencia: ${formatCurrency(cierre.diferencia || 0, 'PYG')}`
  ];

  if (cierre.salidas?.length) {
    lineas.push('\nSalidas registradas:');
    cierre.salidas.forEach((salida) => {
      lineas.push(`- ${salida.descripcion}: ${formatCurrency(salida.monto, 'PYG')} (${formatDate(salida.fecha)})`);
    });
  }

  if (cierre.observaciones) {
    lineas.push('\nObservaciones:');
    lineas.push(cierre.observaciones);
  }

  return lineas.join('\n');
}

export const cierresCajaModule = {
  key: 'cierres-caja',
  label: 'Cierres de Caja',
  singular: 'Cierre de caja',
  endpoint: '/caja/cierres',
  pageSize: 15,
  supportsEdit: false,
  filters: [
    { name: 'fecha_desde', label: 'Desde', type: 'date' },
    { name: 'fecha_hasta', label: 'Hasta', type: 'date' },
    { name: 'usuarioId', label: 'Usuario ID', type: 'text', placeholder: 'uuid...' },
    { name: 'search', label: 'Buscar', type: 'text', placeholder: 'Observaciones o usuario' }
  ],
  fields: [
    { name: 'fecha_apertura', label: 'Fecha apertura', type: 'datetime-local' },
    { name: 'fecha_cierre', label: 'Fecha cierre', type: 'datetime-local' },
    { name: 'total_ventas', label: 'Total ventas (Gs.)', type: 'number', required: true, step: '1000', min: 0 },
    { name: 'total_efectivo', label: 'Total efectivo (Gs.)', type: 'number', required: true, step: '1000', min: 0 },
    { name: 'total_tarjeta', label: 'Total tarjeta (Gs.)', type: 'number', step: '1000', min: 0 },
    { name: 'total_transferencia', label: 'Total transferencia (Gs.)', type: 'number', step: '1000', min: 0 },
    { name: 'total_salidas', label: 'Salidas registradas (Gs.)', type: 'number', step: '1000', min: 0, helperText: 'Si no completás este campo se calculará desde las salidas cargadas manualmente.' },
    { name: 'efectivo_declarado', label: 'Efectivo declarado (Gs.)', type: 'number', step: '1000', min: 0 },
    { name: 'observaciones', label: 'Observaciones', type: 'textarea', rows: 3 }
  ],
  columns: [
    {
      header: 'Fecha cierre',
      render: (item) => formatDate(item.fecha_cierre)
    },
    {
      header: 'Usuario',
      render: (item) => item.usuario?.nombre || item.usuario?.usuario || '-'
    },
    {
      header: 'Ventas',
      render: (item) => formatCurrency(item.total_ventas, 'PYG')
    },
    {
      header: 'Efectivo',
      render: (item) => formatCurrency(item.total_efectivo, 'PYG')
    },
    {
      header: 'Salidas',
      render: (item) => formatCurrency(item.total_salidas || 0, 'PYG')
    },
    {
      header: 'Diferencia',
      render: (item) => {
        const diff = Number(item.diferencia || 0);
        const badge = diff === 0 ? 'badge ok' : diff > 0 ? 'badge warn' : 'badge error';
        return `<span class="${badge}">${formatCurrency(diff, 'PYG')}</span>`;
      }
    }
  ],
  rowActions: [
    { action: 'detalle', label: 'Detalle', className: 'btn ghost small' }
  ],
  rowActionHandlers: {
    async detalle({ id, showMessage }) {
      try {
        const detalle = await request(`/caja/cierres/${id}`);
        const mensaje = buildDetalleMensaje(detalle);
        if (typeof window !== 'undefined') {
          window.alert(mensaje);
        } else {
          showMessage('Detalle disponible en la consola.', 'info');
          console.info(mensaje);
        }
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo obtener el detalle del cierre.', 'error');
      }
    }
  },
  actions: {
    nuevo: {
      submit: createCierre,
      successMessage: 'Cierre registrado correctamente.',
      transform: transformPayload
    }
  },
  hooks: {
    afterFormRender({ form }) {
      ensureUsuarioField(form);
      ensureDateDefaults(form);
      attachDifferenceWatcher(form);
    }
  },
  async fetchList({ filters }) {
    const query = buildQuery({
      fecha_desde: filters.fecha_desde,
      fecha_hasta: filters.fecha_hasta,
      usuarioId: filters.usuarioId,
      search: filters.search,
      include_deleted: filters.include_deleted ? 'true' : undefined
    });

    const url = query ? `${this.endpoint}?${query}` : this.endpoint;
    const response = await request(url);
    return {
      data: response?.data || [],
      meta: response?.meta || {
        page: 1,
        pageSize: (response?.data || []).length,
        total: (response?.data || []).length,
        totalPages: 1
      }
    };
  }
};
