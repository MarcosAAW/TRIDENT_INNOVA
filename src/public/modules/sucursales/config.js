import { request, buildQuery } from '../common/api.js';
import { createSucursal } from './nuevo.js';
import { updateSucursal } from './editar.js';
import { deleteSucursal } from './eliminar.js';

function extractData(response) {
  return Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
}

export const sucursalesModule = {
  key: 'sucursales',
  label: 'Sucursales',
  labelSingular: 'Sucursal',
  singular: 'Sucursal',
  singularLower: 'sucursal',
  endpoint: '/sucursales',
  pageSize: 10,
  searchPlaceholder: 'Buscar por nombre o ciudad',
  fields: [
    { name: 'nombre', label: 'Nombre', type: 'text', required: true, placeholder: 'Casa Central' },
    { name: 'ciudad', label: 'Ciudad', type: 'text', placeholder: 'Asunción' },
    { name: 'direccion', label: 'Dirección', type: 'text', placeholder: 'Ruta Mcal. López 123' },
    { name: 'telefono', label: 'Teléfono', type: 'text', placeholder: '+595 981 000 000' }
  ],
  columns: [
    { header: 'Nombre', accessor: (item) => item.nombre || '' },
    { header: 'Ciudad', accessor: (item) => item.ciudad || '' },
    { header: 'Dirección', accessor: (item) => item.direccion || '' },
    { header: 'Teléfono', accessor: (item) => item.telefono || '' },
    {
      header: 'Estado',
      render: (item) => item.deleted_at ? '<span class="badge error">Eliminada</span>' : '<span class="badge ok">Activa</span>'
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
    const data = extractData(response);
    const meta = response?.meta || {
      page,
      pageSize,
      total: data.length,
      totalPages: Math.max(1, Math.ceil(data.length / pageSize))
    };
    return { data, meta };
  },
  prepareForEdit(item) {
    return {
      ...item,
      nombre: item?.nombre || '',
      ciudad: item?.ciudad || '',
      direccion: item?.direccion || '',
      telefono: item?.telefono || ''
    };
  },
  actions: {
    nuevo: {
      submit: createSucursal,
      successMessage: 'Sucursal creada correctamente.'
    },
    editar: {
      submit: updateSucursal,
      successMessage: 'Sucursal actualizada.'
    },
    eliminar: {
      submit: deleteSucursal,
      successMessage: 'Sucursal eliminada.'
    }
  }
};
