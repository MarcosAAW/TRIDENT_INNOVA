import { request, buildQuery } from '../common/api.js';
import { createProveedor } from './nuevo.js';
import { updateProveedor } from './editar.js';
import { deleteProveedor } from './eliminar.js';

export const proveedoresModule = {
  key: 'proveedores',
  label: 'Proveedores',
  labelSingular: 'Proveedor',
  singular: 'Proveedor',
  singularLower: 'proveedor',
  endpoint: '/proveedores',
  pageSize: 10,
  searchPlaceholder: 'Buscar por nombre, RUC, contacto o correo',
  fields: [
    { name: 'nombre_razon_social', label: 'Nombre o razón social', type: 'text', required: true, placeholder: 'Proveedor Demo S.A.' },
    { name: 'ruc', label: 'RUC', type: 'text', placeholder: '8001234-5' },
    { name: 'contacto', label: 'Contacto', type: 'text', placeholder: 'Nombre de contacto' },
    { name: 'telefono', label: 'Teléfono', type: 'text', placeholder: '+595...' },
    { name: 'correo', label: 'Correo electrónico', type: 'email', placeholder: 'compras@proveedor.com' },
    { name: 'direccion', label: 'Dirección', type: 'textarea', rows: 3, placeholder: 'Ciudad, dirección' }
  ],
  columns: [
    { header: 'Nombre', accessor: (item) => item.nombre_razon_social || '' },
    { header: 'RUC', accessor: (item) => item.ruc || '-' },
    { header: 'Contacto', accessor: (item) => item.contacto || item.telefono || '-' },
    { header: 'Correo', accessor: (item) => item.correo || '-' },
    {
      header: 'Estado',
      render: (item) => (item.deleted_at ? '<span class="badge error">Eliminado</span>' : '<span class="badge ok">Activo</span>')
    }
  ],
  async fetchList({ page, pageSize, filters }) {
    const query = buildQuery({
      page,
      pageSize,
      search: filters.search,
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
  actions: {
    nuevo: {
      submit: createProveedor,
      successMessage: 'Proveedor creado correctamente.'
    },
    editar: {
      submit: updateProveedor,
      successMessage: 'Proveedor actualizado.'
    },
    eliminar: {
      submit: deleteProveedor,
      successMessage: 'Proveedor eliminado.',
      confirmMessage: '¿Deseas eliminar este proveedor?'
    }
  }
};