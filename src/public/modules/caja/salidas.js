import { request, buildQuery } from '../common/api.js';
import { formatCurrency, formatDate } from '../common/format.js';
import { loadSession } from '../auth/session.js';

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function toISO(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
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

async function createSalida(body) {
  return request('/caja/salidas', { method: 'POST', body });
}

function transformPayload(raw) {
  const payload = {
    usuarioId: raw.usuarioId,
    descripcion: raw.descripcion?.trim(),
    monto: toNumber(raw.monto),
    fecha: toISO(raw.fecha) || new Date().toISOString(),
    observacion: raw.observacion?.trim() || undefined,
    cierreId: raw.cierreId?.trim() || undefined
  };

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      delete payload[key];
    }
  });

  return payload;
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
  input.value = session?.id || '';
}

function ensureFechaDefault(form) {
  const field = form.elements.fecha;
  if (field && !field.value) {
    field.value = toLocalInputValue(new Date());
  }
}

export const salidasCajaModule = {
  key: 'salidas-caja',
  label: 'Salidas de Caja',
  singular: 'Salida de caja',
  endpoint: '/caja/salidas',
  pageSize: 20,
  supportsEdit: false,
  supportsDelete: false,
  filters: [
    { name: 'fecha_desde', label: 'Desde', type: 'date' },
    { name: 'fecha_hasta', label: 'Hasta', type: 'date' },
    { name: 'sin_cierre', label: 'Sin cierre asociado', type: 'checkbox' },
    { name: 'cierreId', label: 'Cierre ID', type: 'text', placeholder: 'uuid...' },
    { name: 'usuarioId', label: 'Usuario ID', type: 'text', placeholder: 'uuid...' }
  ],
  fields: [
    { name: 'descripcion', label: 'Descripción', type: 'textarea', rows: 2, required: true },
    { name: 'monto', label: 'Monto (Gs.)', type: 'number', required: true, min: 0, step: '1000' },
    { name: 'fecha', label: 'Fecha', type: 'datetime-local' },
    { name: 'cierreId', label: 'Asociar a cierre (opcional)', type: 'text', placeholder: 'uuid del cierre' },
    { name: 'observacion', label: 'Observación', type: 'textarea', rows: 2 }
  ],
  columns: [
    {
      header: 'Fecha',
      render: (item) => formatDate(item.fecha)
    },
    {
      header: 'Descripción',
      accessor: (item) => item.descripcion || '-'
    },
    {
      header: 'Monto',
      render: (item) => formatCurrency(item.monto, 'PYG')
    },
    {
      header: 'Usuario',
      render: (item) => item.usuario?.nombre || item.usuario?.usuario || '-'
    },
    {
      header: 'Cierre',
      render: (item) => (item.cierre ? item.cierre.id : '—')
    },
    {
      header: 'Observación',
      accessor: (item) => item.observacion || '-'
    }
  ],
  actions: {
    nuevo: {
      submit: createSalida,
      successMessage: 'Salida registrada correctamente.',
      transform: transformPayload
    }
  },
  hooks: {
    afterFormRender({ form }) {
      ensureUsuarioField(form);
      ensureFechaDefault(form);
    }
  },
  async fetchList({ filters }) {
    const query = buildQuery({
      fecha_desde: filters.fecha_desde,
      fecha_hasta: filters.fecha_hasta,
      sin_cierre: filters.sin_cierre ? 'true' : undefined,
      cierreId: filters.cierreId,
      usuarioId: filters.usuarioId,
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
