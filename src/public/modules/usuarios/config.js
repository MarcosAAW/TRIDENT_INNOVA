import { formatDate } from '../common/format.js';
import { request, buildQuery } from '../common/api.js';
import { createUsuario } from './nuevo.js';
import { updateUsuario } from './editar.js';
import { deleteUsuario } from './eliminar.js';

let sucursalOptions = [];
let sucursalOptionsPromise = null;

function resetSucursalOptions() {
  sucursalOptions = [];
  sucursalOptionsPromise = null;
}

function mapSucursalOptions(rows) {
  return rows
    .filter(Boolean)
    .map((row) => ({
      value: row.id,
      label: row.nombre || row.ciudad || row.id
    }));
}

async function ensureSucursalOptions({ force = false } = {}) {
  if (force) {
    resetSucursalOptions();
  }
  if (sucursalOptions.length) return sucursalOptions;
  if (!sucursalOptionsPromise) {
    sucursalOptionsPromise = request('/sucursales')
      .then((response) => {
        const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
        return mapSucursalOptions(rows);
      })
      .catch((error) => {
        console.error('[Usuarios] No se pudo cargar sucursales', error);
        return [];
      })
      .finally(() => {
        sucursalOptionsPromise = null;
      });
  }
  sucursalOptions = await sucursalOptionsPromise;
  return sucursalOptions;
}

function applySucursalOptions(control, selectedIds = []) {
  if (!control) return;
  const selection = new Set((selectedIds || []).map((id) => String(id)));
  control.innerHTML = sucursalOptions
    .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
    .join('');
  Array.from(control.options || []).forEach((opt) => {
    opt.selected = selection.has(opt.value);
  });
}

function hydrateSucursales(control, selectedIds = [], { force = false } = {}) {
  if (!control) return;
  ensureSucursalOptions({ force })
    .then(() => applySucursalOptions(control, selectedIds))
    .catch((error) => {
      console.error('[Usuarios] No se pudo preparar sucursales', error);
    });
}

function renderSucursalLabels(item) {
  const labels = (item?.sucursales || [])
    .map((rel) => rel?.sucursal?.nombre || rel?.sucursalId)
    .filter(Boolean);
  return labels.length ? labels.join(', ') : '-';
}

const ROL_OPTIONS = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'VENDEDOR', label: 'Vendedor' },
  { value: 'TECNICO', label: 'Técnico' },
  { value: 'GERENCIA', label: 'Gerencia' }
];

const ACTIVO_OPTIONS = [
  { value: 'true', label: 'Activos' },
  { value: 'false', label: 'Inactivos' }
];

export const usuariosModule = {
  key: 'usuarios',
  label: 'Usuarios',
  labelSingular: 'Usuario',
  singular: 'Usuario',
  singularLower: 'usuario',
  endpoint: '/usuarios',
  pageSize: 10,
  searchPlaceholder: 'Buscar por nombre o usuario',
  filters: [
    {
      name: 'rol',
      label: 'Rol',
      type: 'select',
      options: ROL_OPTIONS
    },
    {
      name: 'activo',
      label: 'Estado',
      type: 'select',
      options: ACTIVO_OPTIONS
    }
  ],
  fields: [
    { name: 'nombre', label: 'Nombre', type: 'text', required: true, placeholder: 'Nombre completo' },
    { name: 'usuario', label: 'Usuario', type: 'text', required: true, placeholder: 'usuario.interno' },
    { name: 'password', label: 'Contraseña', type: 'password', helperText: 'Mínimo 6 caracteres.' },
    { name: 'rol', label: 'Rol', type: 'select', required: true, defaultValue: 'VENDEDOR', options: ROL_OPTIONS },
    {
      name: 'sucursalIds',
      label: 'Sucursales habilitadas',
      type: 'select',
      multiple: true,
      required: true,
      options: [],
      size: 5,
      helperText: 'Seleccioná una o más sucursales para el usuario.'
    },
    { name: 'activo', label: 'Usuario activo', type: 'checkbox', defaultValue: true }
  ],
  columns: [
    { header: 'Nombre', accessor: (item) => item.nombre || '' },
    { header: 'Usuario', accessor: (item) => item.usuario || '' },
    { header: 'Rol', accessor: (item) => item.rol || '-' },
    { header: 'Sucursales', render: (item) => renderSucursalLabels(item) },
    {
      header: 'Estado',
      render: (item) => {
        if (item.deleted_at) return '<span class="badge error">Eliminado</span>';
        if (item.activo === false) return '<span class="badge warn">Inactivo</span>';
        return '<span class="badge ok">Activo</span>';
      }
    },
    {
      header: 'Creado',
      render: (item) => formatDate(item.created_at)
    }
  ],
  async fetchList({ page, pageSize, filters }) {
    const query = buildQuery({
      page,
      pageSize,
      search: filters.search,
      rol: filters.rol,
      activo: filters.activo,
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
      ...item,
      activo: Boolean(item.activo),
      password: '',
      sucursalIds: Array.isArray(item.sucursales)
        ? item.sucursales.map((rel) => rel.sucursalId)
        : []
    };
  },
  hooks: {
    afterFormRender({ form }) {
      hydrateSucursales(form?.elements.sucursalIds, [], { force: true });
    },
    onResetForm({ form }) {
      const passwordControl = form?.elements.password;
      if (passwordControl) {
        passwordControl.required = true;
        passwordControl.value = '';
        passwordControl.placeholder = '';
      }

      hydrateSucursales(form?.elements.sucursalIds, [], { force: true });
    },
    afterEditStart({ form, item }) {
      const passwordControl = form?.elements.password;
      if (passwordControl) {
        passwordControl.required = false;
        passwordControl.placeholder = 'Deja en blanco para mantener';
      }

      const selectedSucursales = Array.isArray(item?.sucursalIds) ? item.sucursalIds : [];
      hydrateSucursales(form?.elements.sucursalIds, selectedSucursales, { force: true });
    }
  },
  actions: {
    nuevo: {
      submit: createUsuario,
      successMessage: 'Usuario creado correctamente.'
    },
    editar: {
      submit: updateUsuario,
      successMessage: 'Usuario actualizado.'
    },
    eliminar: {
      submit: deleteUsuario,
      successMessage: 'Usuario desactivado.'
    }
  }
};
