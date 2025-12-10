import { request, buildQuery } from '../common/api.js';
import { createCliente } from './nuevo.js';
import { updateCliente } from './editar.js';
import { deleteCliente } from './eliminar.js';

const TIPO_CLIENTE_OPTIONS = [
  { value: 'EMPRESA', label: 'Empresa' },
  { value: 'CLIENTE_OCASIONAL', label: 'Cliente ocasional' }
];

const TIPO_CLIENTE_LABELS = TIPO_CLIENTE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

export const clientesModule = {
  key: 'clientes',
  label: 'Clientes',
  labelSingular: 'Cliente',
  singular: 'Cliente',
  singularLower: 'cliente',
  endpoint: '/clientes',
  pageSize: 10,
  searchPlaceholder: 'Buscar por nombre, RUC o correo',
  filters: [
    {
      name: 'tipo_cliente',
      label: 'Tipo de cliente',
      type: 'select',
      options: [{ value: '', label: 'Todos' }, ...TIPO_CLIENTE_OPTIONS]
    }
  ],
  fields: [
    { name: 'nombre_razon_social', label: 'Nombre o razón social', type: 'text', required: true, placeholder: 'Cliente Demo S.A.' },
    { name: 'ruc', label: 'RUC', type: 'text', placeholder: '8001234-5' },
    { name: 'correo', label: 'Correo electrónico', type: 'email', placeholder: 'contacto@cliente.com' },
    { name: 'telefono', label: 'Teléfono', type: 'text', placeholder: '+595...' },
    { name: 'direccion', label: 'Dirección', type: 'text', placeholder: 'Ciudad, dirección' },
    { name: 'tipo_cliente', label: 'Tipo de cliente', type: 'select', defaultValue: 'EMPRESA', options: TIPO_CLIENTE_OPTIONS }
  ],
  columns: [
    { header: 'Nombre', accessor: (item) => item.nombre_razon_social || '' },
    { header: 'RUC', accessor: (item) => item.ruc || '-' },
    { header: 'Correo', accessor: (item) => item.correo || '-' },
    {
      header: 'Tipo',
      accessor: (item) => TIPO_CLIENTE_LABELS[item.tipo_cliente] || item.tipo_cliente || '-'
    },
    {
      header: 'Estado',
      render: (item) => (item.deleted_at ? '<span class="badge error">Eliminado</span>' : '<span class="badge ok">Activo</span>')
    }
  ],
  async fetchList({ page, pageSize, filters }) {
    const tipoClienteFilter = filters.tipo_cliente || undefined;
    const query = buildQuery({
      page,
      pageSize,
      search: filters.search,
      tipo_cliente: tipoClienteFilter,
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
      submit: createCliente,
      successMessage: 'Cliente creado correctamente.'
    },
    editar: {
      submit: updateCliente,
      successMessage: 'Cliente actualizado.'
    },
    eliminar: {
      submit: deleteCliente,
      successMessage: 'Cliente eliminado.',
      confirmMessage: '¿Deseas eliminar este cliente?'
    }
  }
};
