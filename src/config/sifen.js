const DEFAULT_EMPRESA = {
  version: Number(process.env.SIFEN_VERSION) || 150,
  ruc: process.env.SIFEN_RUC || '80132959-0',
  razonSocial: process.env.SIFEN_RAZON_SOCIAL || 'TRIDENT INNOVA E.A.S',
  nombreFantasia: process.env.SIFEN_NOMBRE_FANTASIA || 'TRIDENT INNOVA',
  tipoContribuyente: Number(process.env.SIFEN_TIPO_CONTRIBUYENTE) || 2,
  tipoRegimen: Number(process.env.SIFEN_TIPO_REGIMEN) || 8,
  timbradoNumero: process.env.SIFEN_TIMBRADO || '00000000',
  timbradoFecha: process.env.SIFEN_TIMBRADO_FECHA || '2024-01-01'
};

const DEFAULT_ESTABLECIMIENTO = {
  codigo: process.env.SIFEN_ESTABLECIMIENTO || '001',
  direccion:
    process.env.SIFEN_ESTABLECIMIENTO_DIRECCION || 'Ruta 01, Casi Mcal. López. San Ignacio-Misiones',
  numeroCasa: process.env.SIFEN_ESTABLECIMIENTO_NUM || '0',
  complementoDireccion1: process.env.SIFEN_ESTABLECIMIENTO_COMP1 || 'Zona Centro',
  complementoDireccion2: process.env.SIFEN_ESTABLECIMIENTO_COMP2 || '',
  departamento: Number(process.env.SIFEN_ESTABLECIMIENTO_DEPTO) || 7,
  departamentoDescripcion: process.env.SIFEN_ESTABLECIMIENTO_DEPTO_DESC || 'ITAPÚA',
  distrito: Number(process.env.SIFEN_ESTABLECIMIENTO_DISTRITO) || 143,
  distritoDescripcion:
    process.env.SIFEN_ESTABLECIMIENTO_DISTRITO_DESC || 'DOMINGO MARTÍNEZ DE IRALA',
  ciudad: Number(process.env.SIFEN_ESTABLECIMIENTO_CIUDAD) || 3432,
  ciudadDescripcion: process.env.SIFEN_ESTABLECIMIENTO_CIUDAD_DESC || 'SAN IGNACIO',
  telefono: process.env.SIFEN_ESTABLECIMIENTO_TELEFONO || '+595983784444',
  email: process.env.SIFEN_ESTABLECIMIENTO_EMAIL || 'info@tridentinnova.com',
  denominacion: process.env.SIFEN_ESTABLECIMIENTO_NOMBRE || 'Casa Central'
};

function loadEmisorParams(overrides = {}) {
  const actividadesEconomicas = overrides.actividadesEconomicas || [
    {
      codigo: process.env.SIFEN_ACTIVIDAD_CODIGO || '62010',
      descripcion: process.env.SIFEN_ACTIVIDAD_DESC || 'Desarrollo de software'
    }
  ];

  return {
    ...DEFAULT_EMPRESA,
    actividadesEconomicas,
    establecimientos: [{ ...DEFAULT_ESTABLECIMIENTO, ...(overrides.establecimiento || {}) }],
    ...overrides
  };
}

module.exports = {
  loadEmisorParams
};
