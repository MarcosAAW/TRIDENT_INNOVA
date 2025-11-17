import { formatDate } from '../common/format.js';
import { request, buildQuery } from '../common/api.js';
import { createUsuario } from './nuevo.js';
import { updateUsuario } from './editar.js';
import { deleteUsuario } from './eliminar.js';

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
    { name: 'activo', label: 'Usuario activo', type: 'checkbox', defaultValue: true }
  ],
  columns: [
    { header: 'Nombre', accessor: (item) => item.nombre || '' },
    { header: 'Usuario', accessor: (item) => item.usuario || '' },
    { header: 'Rol', accessor: (item) => item.rol || '-' },
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
      password: ''
    };
  },
  hooks: {
    onResetForm({ form }) {
      const passwordControl = form?.elements.password;
      if (passwordControl) {
        passwordControl.required = true;
        passwordControl.value = '';
        passwordControl.placeholder = '';
      }
    },
    afterEditStart({ form }) {
      const passwordControl = form?.elements.password;
      if (passwordControl) {
        passwordControl.required = false;
        passwordControl.placeholder = 'Deja en blanco para mantener';
      }
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
