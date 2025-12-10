const baseNombre = 'TRIDENT INNOVA E.A.S';

module.exports = {
  nombre: baseNombre,
  ruc: '80132959-0',
  direccion: 'Casa Central: Curupayty 8444, Obligado - Itapúa',
  telefono: '+595 983 784444',
  email: 'info@tridentinnova.com',
  actividades: [
    
  ],
  sucursales: [
    'Casa Central: Curupayty 8444, Obligado - Itapúa, Paraguay. Cel. (0983) 784 444',
    'Sucursal: Mcal. Francisco S. López - San Ignacio, Misiones - Paraguay. Cel. (0994) 499 279'
  ],
  timbrado: {
    numero: process.env.FACTURA_DIGITAL_TIMBRADO || '17177702',
    vigencia_inicio: process.env.FACTURA_DIGITAL_VIGENCIA_INICIO || '01/05/2024',
    vigencia_fin: process.env.FACTURA_DIGITAL_VIGENCIA_FIN || '31/12/2030',
    establecimiento: process.env.FACTURA_DIGITAL_ESTABLECIMIENTO || '001',
    punto_expedicion: process.env.FACTURA_DIGITAL_PUNTO || '001'
  }
};
