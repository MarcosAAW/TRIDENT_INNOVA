import { formatCurrency } from '../common/format.js';
import { request, buildQuery } from '../common/api.js';
import { createProducto } from './nuevo.js';
import { updateProducto } from './editar.js';
import { deleteProducto } from './eliminar.js';

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printProductLabel(item) {
  if (!item) return;
  const sku = escapeText(item.sku || '');
  const nombre = escapeText(item.nombre || '');
  const precioPYG = item.precio_venta !== undefined && item.precio_venta !== null
    ? formatCurrency(item.precio_venta, 'PYG')
    : '';
  const precioOriginal = item.moneda_precio_venta && item.moneda_precio_venta !== 'PYG' && item.precio_venta_original
    ? formatCurrency(item.precio_venta_original, item.moneda_precio_venta)
    : '';

  const fecha = new Date().toLocaleDateString('es-PY');
  const win = window.open('', '', 'width=360,height=480');
  if (!win) {
    window.alert('No se pudo abrir la ventana de impresión. Verificá el bloqueador de ventanas emergentes.');
    return;
  }

  win.document.open();
  win.document.write(`<!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>Etiqueta ${sku}</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 24px; }
          .label { border: 2px solid #111827; border-radius: 12px; padding: 18px; width: 260px; }
          h1 { margin: 0 0 8px; font-size: 18px; color: #111827; }
          .sku { font-size: 24px; font-weight: 700; letter-spacing: 0.18em; margin: 12px 0; color: #111827; text-align: center; }
          .barcode { display: flex; justify-content: center; margin: 16px 0 6px; }
          .price { font-size: 22px; font-weight: 600; color: #0f766e; margin: 8px 0; text-align: center; }
          .original { font-size: 14px; color: #6b7280; text-align: center; }
          .meta { font-size: 12px; color: #6b7280; display: flex; justify-content: space-between; margin-top: 18px; }
          .footer { font-size: 11px; color: #6b7280; text-align: center; margin-top: 10px; }
        </style>
        <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
      </head>
      <body>
        <div class="label">
          <h1>${nombre || 'Producto'}</h1>
          <div class="sku">${sku}</div>
          <div class="barcode">
            <svg id="barcode"></svg>
          </div>
          ${precioPYG ? `<div class="price">${escapeText(precioPYG)}</div>` : ''}
          ${precioOriginal ? `<div class="original">${escapeText(precioOriginal)}</div>` : ''}
          <div class="meta"><span>Fecha:</span><span>${escapeText(fecha)}</span></div>
          <div class="footer">Trident Innova</div>
        </div>
        <script>
          window.addEventListener('DOMContentLoaded', function() {
            var skuValue = ${JSON.stringify(sku)};
            if (typeof JsBarcode === 'function' && skuValue) {
              JsBarcode('#barcode', skuValue, {
                format: 'CODE128',
                displayValue: false,
                margin: 0,
                height: 60,
                width: 1.8
              });
            }
            setTimeout(function(){
              window.focus();
              window.print();
              setTimeout(function(){ window.close(); }, 150);
            }, 200);
          });
        </script>
      </body>
    </html>`);
  win.document.close();
}

const TIPO_OPTIONS = [
  { value: 'DRON', label: 'Dron' },
  { value: 'REPUESTO', label: 'Repuesto' },
  { value: 'SERVICIO', label: 'Servicio' },
  { value: 'OTRO', label: 'Otro' }
];

const ESTADO_OPTIONS = [
  { value: 'true', label: 'Activos' },
  { value: 'false', label: 'Inactivos' }
];

const MONEDA_OPTIONS = [
  { value: 'PYG', label: 'Guaraníes (PYG)' },
  { value: 'USD', label: 'Dólares (USD)' }
];

const UNIDAD_OPTIONS = [
  { value: 'Unidad', label: 'Unidad' }
];

export const productosModule = {
  key: 'productos',
  label: 'Productos',
  labelSingular: 'Producto',
  singular: 'Producto',
  singularLower: 'producto',
  endpoint: '/productos',
  pageSize: 10,
  searchPlaceholder: 'Buscar por nombre o SKU',
  moduleActions: [
    { action: 'inventory-report', label: 'Reporte de inventario', className: 'btn ghost' }
  ],
  moduleActionHandlers: {
    'inventory-report': () => {
      window.open('/productos/reporte/inventario', '_blank', 'noopener');
    }
  },
  rowActions: [
    { action: 'print-label', label: 'Imprimir etiqueta', className: 'btn ghost small' }
  ],
  rowActionHandlers: {
    'print-label': ({ item }) => printProductLabel(item)
  },
  filters: [
    {
      name: 'tipo',
      label: 'Tipo de producto',
      type: 'select',
      options: TIPO_OPTIONS
    },
    {
      name: 'activo',
      label: 'Estado',
      type: 'select',
      options: ESTADO_OPTIONS
    },
    {
      name: 'critico',
      label: 'Solo stock bajo',
      type: 'checkbox'
    }
  ],
  fields: [
    { name: 'sku', label: 'SKU', type: 'text', required: true, placeholder: 'DRON-001' },
    { name: 'nombre', label: 'Nombre', type: 'text', required: true, placeholder: 'Drone de inspección' },
    { name: 'tipo', label: 'Tipo', type: 'select', required: true, defaultValue: 'DRON', options: TIPO_OPTIONS },
    { name: 'moneda_precio_venta', label: 'Moneda del precio de venta', type: 'select', required: true, defaultValue: 'PYG', options: MONEDA_OPTIONS },
    {
      name: 'precio_venta',
      label: 'Precio de venta',
      type: 'number',
      required: true,
      step: '0.01',
      cast: 'float',
      helperText: 'Si eliges USD se convertirá automáticamente a guaraníes usando el tipo de cambio.'
    },
    {
      name: 'tipo_cambio_precio_venta',
      label: 'Tipo de cambio (venta → PYG)',
      type: 'number',
      step: '0.0001',
      cast: 'float',
      helperText: 'Obligatorio solo cuando la moneda es USD.'
    },
    { name: 'moneda_precio_compra', label: 'Moneda del precio de compra', type: 'select', defaultValue: 'PYG', options: MONEDA_OPTIONS },
    {
      name: 'precio_compra',
      label: 'Precio de compra',
      type: 'number',
      step: '0.01',
      cast: 'float',
      helperText: 'Opcional. Si es USD se convertirá con el tipo de cambio indicado.'
    },
    {
      name: 'tipo_cambio_precio_compra',
      label: 'Tipo de cambio (compra → PYG)',
      type: 'number',
      step: '0.0001',
      cast: 'float',
      helperText: 'Solo si la moneda seleccionada es USD.'
    },
    { name: 'stock_actual', label: 'Stock actual', type: 'number', step: '1', min: 0, cast: 'int', defaultValue: 0 },
    { name: 'minimo_stock', label: 'Stock mínimo', type: 'number', step: '1', min: 0, cast: 'int' },
    { name: 'unidad', label: 'Unidad', type: 'select', defaultValue: 'Unidad', options: UNIDAD_OPTIONS },
    { name: 'descripcion', label: 'Descripción', type: 'textarea', rows: 3 },
    { name: 'activo', label: 'Producto activo', type: 'checkbox', defaultValue: true }
  ],
  columns: [
    { header: 'Nombre', accessor: (item) => item.nombre || '' },
    { header: 'SKU', accessor: (item) => item.sku || '' },
    { header: 'Tipo', accessor: (item) => item.tipo || '' },
    {
      header: 'Precio venta',
      render: (item) => {
        const base = formatCurrency(item.precio_venta, 'PYG');
        if (item.moneda_precio_venta && item.moneda_precio_venta !== 'PYG' && item.precio_venta_original) {
          const original = formatCurrency(item.precio_venta_original, item.moneda_precio_venta);
          return `${base}<div class="badge">${original}</div>`;
        }
        return base;
      }
    },
    {
      header: 'Precio compra',
      render: (item) => {
        if (item.precio_compra === null || item.precio_compra === undefined) return '-';
        const base = formatCurrency(item.precio_compra, 'PYG');
        if (item.moneda_precio_compra && item.moneda_precio_compra !== 'PYG' && item.precio_compra_original) {
          const original = formatCurrency(item.precio_compra_original, item.moneda_precio_compra);
          return `${base}<div class="badge">${original}</div>`;
        }
        return base;
      }
    },
    {
      header: 'Stock',
      render: (item) => {
        const actual = item.stock_actual ?? 0;
        const minimo = item.minimo_stock ?? null;
        const badge = item.stock_bajo
          ? '<span class="badge warn">Stock bajo</span>'
          : '';
        const minimoHtml = minimo !== null && minimo !== undefined
          ? `<div class="table-sub">Min: ${minimo}</div>`
          : '';
        return `<div class="stock-cell">${actual}${minimoHtml}${badge}</div>`;
      }
    },
    {
      header: 'Estado',
      render: (item) => {
        if (item.deleted_at) return '<span class="badge error">Eliminado</span>';
        if (item.activo === false) return '<span class="badge warn">Inactivo</span>';
        return '<span class="badge ok">Activo</span>';
      }
    }
  ],
  async fetchList({ page, pageSize, filters }) {
    const query = buildQuery({
      page,
      pageSize,
      search: filters.search,
      tipo: filters.tipo,
      activo: filters.activo,
      include_deleted: filters.include_deleted ? 'true' : undefined,
      critico: filters.critico ? 'true' : undefined
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
      unidad: item.unidad || 'Unidad',
      moneda_precio_venta: (item.moneda_precio_venta || 'PYG').toUpperCase(),
      precio_venta:
        item.moneda_precio_venta && item.moneda_precio_venta !== 'PYG' && item.precio_venta_original
          ? Number(item.precio_venta_original)
          : Number(item.precio_venta ?? 0),
      tipo_cambio_precio_venta:
        item.tipo_cambio_precio_venta !== undefined && item.tipo_cambio_precio_venta !== null
          ? Number(item.tipo_cambio_precio_venta)
          : '',
      moneda_precio_compra: item.moneda_precio_compra ? item.moneda_precio_compra.toUpperCase() : 'PYG',
      precio_compra:
        item.moneda_precio_compra && item.moneda_precio_compra !== 'PYG' && item.precio_compra_original
          ? Number(item.precio_compra_original)
          : item.precio_compra !== undefined && item.precio_compra !== null
            ? Number(item.precio_compra)
            : '',
      tipo_cambio_precio_compra:
        item.tipo_cambio_precio_compra !== undefined && item.tipo_cambio_precio_compra !== null
          ? Number(item.tipo_cambio_precio_compra)
          : ''
    };
  },
  hooks: {
    afterFormRender({ form, setVisibility }) {
      const monedaVenta = form?.elements.moneda_precio_venta;
      const tipoCambioVenta = form?.elements.tipo_cambio_precio_venta;
      const monedaCompra = form?.elements.moneda_precio_compra;
      const tipoCambioCompra = form?.elements.tipo_cambio_precio_compra;

      const toggleVenta = () => {
        const isUsd = monedaVenta?.value?.toUpperCase() === 'USD';
        setVisibility('tipo_cambio_precio_venta', isUsd);
        if (!isUsd && tipoCambioVenta) {
          tipoCambioVenta.value = '';
        }
      };

      const toggleCompra = () => {
        const isUsd = monedaCompra?.value?.toUpperCase() === 'USD';
        setVisibility('tipo_cambio_precio_compra', isUsd);
        if (!isUsd && tipoCambioCompra) {
          tipoCambioCompra.value = '';
        }
      };

      if (monedaVenta) {
        monedaVenta.addEventListener('change', toggleVenta);
        toggleVenta();
      }

      if (monedaCompra) {
        monedaCompra.addEventListener('change', toggleCompra);
        toggleCompra();
      }
    },
    afterEditStart({ form }) {
      const monedaVenta = form?.elements.moneda_precio_venta;
      monedaVenta?.dispatchEvent(new Event('change'));
      const monedaCompra = form?.elements.moneda_precio_compra;
      monedaCompra?.dispatchEvent(new Event('change'));
    },
    onResetForm({ form }) {
      const monedaVenta = form?.elements.moneda_precio_venta;
      if (monedaVenta) {
        monedaVenta.value = 'PYG';
        monedaVenta.dispatchEvent(new Event('change'));
      }
      const monedaCompra = form?.elements.moneda_precio_compra;
      if (monedaCompra) {
        monedaCompra.value = 'PYG';
        monedaCompra.dispatchEvent(new Event('change'));
      }
    }
  },
  actions: {
    nuevo: {
      submit: createProducto,
      successMessage: 'Producto creado correctamente.'
    },
    editar: {
      submit: updateProducto,
      successMessage: 'Producto actualizado.'
    },
    eliminar: {
      submit: deleteProducto,
      successMessage: 'Producto eliminado.',
      confirmMessage: '¿Seguro que deseas eliminar este producto?'
    }
  }
};
