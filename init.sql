-- init.sql
-- Esquema SQL actualizado para Trident Innova (PostgreSQL)
-- Sincronizado con prisma/schema.prisma (sucursales, crédito y recibos)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TipoProducto') THEN
    CREATE TYPE "TipoProducto" AS ENUM ('DRON', 'REPUESTO', 'SERVICIO', 'OTRO');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RolUsuario') THEN
    CREATE TYPE "RolUsuario" AS ENUM ('ADMIN', 'VENDEDOR', 'TECNICO', 'GERENCIA');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TipoMovimiento') THEN
    CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA', 'SALIDA');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EstadoFactura') THEN
    CREATE TYPE "EstadoFactura" AS ENUM ('PENDIENTE', 'ENVIADO', 'ACEPTADO', 'PAGADA', 'RECHAZADO');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EstadoNotaPedido') THEN
    CREATE TYPE "EstadoNotaPedido" AS ENUM ('BORRADOR', 'EMITIDA', 'RECIBIDA', 'COMPRADA', 'ANULADA');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TipoNotaPedido') THEN
    CREATE TYPE "TipoNotaPedido" AS ENUM ('GENERAL', 'REPUESTOS');
  END IF;
END $$;

-- Tablas base
CREATE TABLE IF NOT EXISTS categoria (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  descripcion text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS sucursal (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  ciudad varchar(255),
  direccion text,
  telefono varchar(100),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS usuario (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  usuario varchar(150) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  rol "RolUsuario" NOT NULL DEFAULT 'ADMIN',
  activo boolean DEFAULT true,
  last_login timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS usuario_sucursal (
  usuario_id uuid NOT NULL,
  sucursal_id uuid NOT NULL,
  rol varchar(100),
  creado_en timestamptz DEFAULT now(),
  PRIMARY KEY (usuario_id, sucursal_id),
  CONSTRAINT fk_usuario_sucursal_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE CASCADE,
  CONSTRAINT fk_usuario_sucursal_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cliente (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre_razon_social varchar(255) NOT NULL,
  ruc varchar(100) UNIQUE,
  direccion text,
  telefono varchar(50),
  correo varchar(255),
  tipo_cliente varchar(50),
  sucursal_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
  , CONSTRAINT fk_cliente_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS proveedor (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre_razon_social varchar(255) NOT NULL,
  ruc varchar(100) UNIQUE,
  contacto varchar(255),
  direccion text,
  telefono varchar(50),
  correo varchar(255),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS producto (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  sku varchar(100) NOT NULL UNIQUE,
  nombre varchar(255) NOT NULL,
  descripcion text,
  tipo "TipoProducto" NOT NULL,
  precio_venta numeric(12,2) NOT NULL,
  precio_venta_original numeric(12,2),
  moneda_precio_venta varchar(10) NOT NULL DEFAULT 'PYG',
  tipo_cambio_precio_venta numeric(12,4),
  precio_compra numeric(12,2),
  precio_compra_original numeric(12,2),
  moneda_precio_compra varchar(10) DEFAULT 'PYG',
  tipo_cambio_precio_compra numeric(12,4),
  stock_actual integer DEFAULT 0,
  codigo_dji varchar(255),
  codigo_barra varchar(255) UNIQUE,
  categoria_id uuid,
  minimo_stock integer,
  unidad varchar(50),
  imagen_url text,
  activo boolean DEFAULT true,
  sucursal_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_producto_categoria FOREIGN KEY (categoria_id) REFERENCES categoria(id) ON DELETE SET NULL,
  CONSTRAINT fk_producto_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS producto_stock (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  producto_id uuid NOT NULL,
  sucursal_id uuid NOT NULL,
  stock_actual integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT producto_stock_producto_sucursal_unique UNIQUE (producto_id, sucursal_id),
  CONSTRAINT fk_producto_stock_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE CASCADE,
  CONSTRAINT fk_producto_stock_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS presupuesto (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero varchar(50) NOT NULL,
  cliente_id uuid,
  usuario_id uuid NOT NULL,
  sucursal_id uuid,
  fecha timestamptz DEFAULT now(),
  validez_hasta timestamptz,
  moneda varchar(10) NOT NULL DEFAULT 'PYG',
  tipo_cambio numeric(12,4),
  subtotal numeric(12,2) NOT NULL,
  descuento_total numeric(12,2),
  impuesto_total numeric(12,2),
  total numeric(12,2) NOT NULL,
  total_moneda numeric(12,2),
  estado varchar(30) NOT NULL DEFAULT 'BORRADOR',
  notas text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT presupuesto_numero_sucursal_unique UNIQUE (numero, sucursal_id),
  CONSTRAINT fk_presupuesto_cliente FOREIGN KEY (cliente_id) REFERENCES cliente(id) ON DELETE SET NULL,
  CONSTRAINT fk_presupuesto_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_presupuesto_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS detalle_presupuesto (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  presupuesto_id uuid NOT NULL,
  producto_id uuid,
  cantidad integer NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  iva_porcentaje integer NOT NULL DEFAULT 10,
  CONSTRAINT fk_detalle_presupuesto FOREIGN KEY (presupuesto_id) REFERENCES presupuesto(id) ON DELETE CASCADE,
  CONSTRAINT fk_detallepresupuesto_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE SET NULL
);

-- Índices de sucursal para cliente y producto
CREATE INDEX IF NOT EXISTS idx_cliente_sucursal ON cliente (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_producto_sucursal ON producto (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_producto_stock_sucursal ON producto_stock (sucursal_id);

-- Ventas y compras
CREATE TABLE IF NOT EXISTS venta (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cliente_id uuid,
  usuario_id uuid NOT NULL,
  sucursal_id uuid,
  fecha timestamptz DEFAULT now(),
  subtotal numeric(12,2) NOT NULL,
  descuento_total numeric(12,2),
  impuesto_total numeric(12,2),
  total numeric(12,2) NOT NULL,
  total_moneda numeric(12,2),
  iva_porcentaje integer DEFAULT 10,
  estado varchar(50) NOT NULL,
  factura_electronica_id uuid,
  factura_digital_id uuid,
  moneda varchar(10) DEFAULT 'PYG',
  tipo_cambio numeric(12,4),
  condicion_venta varchar(20) NOT NULL DEFAULT 'CONTADO',
  es_credito boolean NOT NULL DEFAULT false,
  fecha_vencimiento timestamptz,
  saldo_pendiente numeric(12,2),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_venta_cliente FOREIGN KEY (cliente_id) REFERENCES cliente(id) ON DELETE SET NULL,
  CONSTRAINT fk_venta_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_venta_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS detalle_venta (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid NOT NULL,
  producto_id uuid NOT NULL,
  cantidad integer NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  moneda_precio_unitario varchar(3),
  precio_unitario_moneda numeric(12,4),
  subtotal_moneda numeric(12,4),
  tipo_cambio_aplicado numeric(12,4),
  CONSTRAINT fk_detalleventa_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE CASCADE,
  CONSTRAINT fk_detalleventa_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS compra (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  proveedor_id uuid,
  nota_pedido_id uuid UNIQUE,
  fecha timestamptz DEFAULT now(),
  subtotal numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  estado varchar(50) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_compra_proveedor FOREIGN KEY (proveedor_id) REFERENCES proveedor(id) ON DELETE SET NULL,
  CONSTRAINT fk_compra_nota_pedido FOREIGN KEY (nota_pedido_id) REFERENCES nota_pedido(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS detalle_compra (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  compra_id uuid NOT NULL,
  producto_id uuid NOT NULL,
  cantidad integer NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  CONSTRAINT fk_detallecompra_compra FOREIGN KEY (compra_id) REFERENCES compra(id) ON DELETE CASCADE,
  CONSTRAINT fk_detallecompra_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS nota_pedido (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero varchar(50) NOT NULL,
  proveedor_id uuid NOT NULL,
  usuario_id uuid NOT NULL,
  sucursal_id uuid,
  fecha timestamptz DEFAULT now(),
  estado "EstadoNotaPedido" NOT NULL DEFAULT 'BORRADOR',
  tipo "TipoNotaPedido" NOT NULL DEFAULT 'GENERAL',
  equipo_destino varchar(255),
  observaciones text,
  pdf_path text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT nota_pedido_numero_sucursal_unique UNIQUE (numero, sucursal_id),
  CONSTRAINT fk_nota_pedido_proveedor FOREIGN KEY (proveedor_id) REFERENCES proveedor(id) ON DELETE RESTRICT,
  CONSTRAINT fk_nota_pedido_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_nota_pedido_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS detalle_nota_pedido (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nota_pedido_id uuid NOT NULL,
  producto_id uuid,
  codigo_articulo varchar(255) NOT NULL,
  codigo_dji varchar(255),
  sku varchar(100),
  descripcion text NOT NULL,
  cantidad integer NOT NULL,
  equipo_destino varchar(255),
  observacion text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT fk_detalle_nota_pedido_nota FOREIGN KEY (nota_pedido_id) REFERENCES nota_pedido(id) ON DELETE CASCADE,
  CONSTRAINT fk_detalle_nota_pedido_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_nota_pedido_sucursal ON nota_pedido (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_nota_pedido_proveedor ON nota_pedido (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_detalle_nota_pedido_producto ON detalle_nota_pedido (producto_id);

-- Facturación
CREATE TABLE IF NOT EXISTS factura_electronica (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid UNIQUE,
  sucursal_id uuid,
  nro_factura varchar(100) UNIQUE,
  timbrado varchar(255),
  fecha_emision timestamptz,
  xml_path text,
  pdf_path text,
  qr_data text,
  estado "EstadoFactura" NOT NULL DEFAULT 'PENDIENTE',
  respuesta_set jsonb,
  intentos integer DEFAULT 0,
  ambiente varchar(50),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT fk_factura_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE SET NULL,
  CONSTRAINT fk_factura_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS factura_digital (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid UNIQUE,
  sucursal_id uuid,
  nro_factura varchar(100) NOT NULL UNIQUE,
  timbrado varchar(30) NOT NULL,
  establecimiento varchar(5) NOT NULL,
  punto_expedicion varchar(5) NOT NULL,
  secuencia integer NOT NULL,
  condicion_venta varchar(20) NOT NULL DEFAULT 'CONTADO',
  fecha_emision timestamptz NOT NULL DEFAULT now(),
  moneda varchar(10) NOT NULL DEFAULT 'PYG',
  total_exentas numeric(12,2),
  total_gravada_5 numeric(12,2),
  total_gravada_10 numeric(12,2),
  total_iva_5 numeric(12,2),
  total_iva_10 numeric(12,2),
  total numeric(12,2) NOT NULL,
  total_iva numeric(12,2),
  total_letras text,
  pdf_path text,
  hash_pdf varchar(128),
  qr_data text,
  numero_control varchar(64),
  estado_envio varchar(30) NOT NULL DEFAULT 'PENDIENTE',
  enviado_a text,
  enviado_en timestamptz,
  intentos integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_factura_digital_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE SET NULL,
  CONSTRAINT fk_factura_digital_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL,
  CONSTRAINT uq_factura_digital_secuencia UNIQUE (timbrado, establecimiento, punto_expedicion, secuencia)
);

CREATE TABLE IF NOT EXISTS nota_credito_electronica (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid NOT NULL,
  factura_electronica_id uuid NOT NULL,
  sucursal_id uuid,
  nro_nota varchar(100) NOT NULL UNIQUE,
  timbrado varchar(30) NOT NULL,
  establecimiento varchar(5) NOT NULL,
  punto_expedicion varchar(5) NOT NULL,
  secuencia integer NOT NULL,
  motivo varchar(200) NOT NULL,
  tipo_ajuste varchar(20) NOT NULL DEFAULT 'TOTAL',
  fecha_emision timestamptz NOT NULL DEFAULT now(),
  moneda varchar(10) NOT NULL DEFAULT 'PYG',
  tipo_cambio numeric(12,4),
  total numeric(12,2) NOT NULL,
  total_moneda numeric(12,2),
  cdc varchar(255),
  xml_path text,
  pdf_path text,
  qr_data text,
  estado "EstadoFactura" NOT NULL DEFAULT 'PENDIENTE',
  respuesta_set jsonb,
  intentos integer NOT NULL DEFAULT 0,
  ambiente varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_nota_credito_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE RESTRICT,
  CONSTRAINT fk_nota_credito_factura FOREIGN KEY (factura_electronica_id) REFERENCES factura_electronica(id) ON DELETE RESTRICT,
  CONSTRAINT fk_nota_credito_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL,
  CONSTRAINT uq_nota_credito_secuencia UNIQUE (timbrado, establecimiento, punto_expedicion, secuencia)
);

CREATE TABLE IF NOT EXISTS nota_credito_detalle (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nota_credito_id uuid NOT NULL,
  detalle_venta_id uuid,
  producto_id uuid,
  descripcion varchar(255) NOT NULL,
  codigo_producto varchar(100),
  cantidad integer NOT NULL,
  precio_unitario numeric(14,4) NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  iva_porcentaje integer NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_nota_credito_detalle_nota FOREIGN KEY (nota_credito_id) REFERENCES nota_credito_electronica(id) ON DELETE CASCADE,
  CONSTRAINT fk_nota_credito_detalle_detalle_venta FOREIGN KEY (detalle_venta_id) REFERENCES detalle_venta(id) ON DELETE SET NULL,
  CONSTRAINT fk_nota_credito_detalle_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE SET NULL
);

-- Movimientos y pagos
CREATE TABLE IF NOT EXISTS movimiento_stock (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  producto_id uuid NOT NULL,
  tipo "TipoMovimiento" NOT NULL,
  cantidad integer NOT NULL,
  motivo varchar(255),
  referencia_id uuid,
  referencia_tipo varchar(100),
  almacen_id uuid,
  usuario_id uuid,
  fecha timestamptz DEFAULT now(),
  CONSTRAINT fk_mov_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS pago (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid NOT NULL,
  sucursal_id uuid,
  fecha_pago timestamptz DEFAULT now(),
  monto numeric(12,2) NOT NULL,
  metodo varchar(100),
  referencia varchar(255),
  CONSTRAINT fk_pago_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE CASCADE,
  CONSTRAINT fk_pago_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

-- Caja
CREATE TABLE IF NOT EXISTS apertura_caja (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id uuid NOT NULL,
  sucursal_id uuid,
  fecha_apertura timestamptz DEFAULT now(),
  fecha_cierre timestamptz,
  saldo_inicial numeric(12,2) NOT NULL DEFAULT 0,
  observaciones text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_apertura_caja_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_apertura_caja_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cierre_caja (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id uuid NOT NULL,
  apertura_id uuid UNIQUE,
  sucursal_id uuid,
  saldo_inicial numeric(12,2) NOT NULL DEFAULT 0,
  fecha_apertura timestamptz,
  fecha_cierre timestamptz DEFAULT now(),
  total_ventas numeric(12,2) NOT NULL,
  total_ventas_usd numeric(12,2) NOT NULL DEFAULT 0,
  total_efectivo numeric(12,2) NOT NULL,
  efectivo_usd numeric(12,2),
  total_tarjeta numeric(12,2) DEFAULT 0,
  total_transferencia numeric(12,2) DEFAULT 0,
  total_salidas numeric(12,2) DEFAULT 0,
  efectivo_declarado numeric(12,2),
  diferencia numeric(12,2),
  observaciones text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_cierre_caja_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cierre_caja_apertura FOREIGN KEY (apertura_id) REFERENCES apertura_caja(id) ON DELETE SET NULL,
  CONSTRAINT fk_cierre_caja_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS salida_caja (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cierre_id uuid,
  usuario_id uuid NOT NULL,
  sucursal_id uuid,
  descripcion text NOT NULL,
  monto numeric(12,2) NOT NULL,
  fecha timestamptz DEFAULT now(),
  observacion text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_salida_caja_cierre FOREIGN KEY (cierre_id) REFERENCES cierre_caja(id) ON DELETE SET NULL,
  CONSTRAINT fk_salida_caja_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salida_caja_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

-- Recibos y aplicaciones
CREATE TABLE IF NOT EXISTS recibo (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero varchar(100) UNIQUE,
  cliente_id uuid,
  usuario_id uuid NOT NULL,
  sucursal_id uuid,
  fecha timestamptz DEFAULT now(),
  total numeric(12,2) NOT NULL,
  total_moneda numeric(12,2),
  moneda varchar(10) NOT NULL DEFAULT 'PYG',
  tipo_cambio numeric(12,4),
  metodo varchar(100) NOT NULL,
  referencia varchar(255),
  estado varchar(50) NOT NULL DEFAULT 'PENDIENTE',
  observacion text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT fk_recibo_cliente FOREIGN KEY (cliente_id) REFERENCES cliente(id) ON DELETE SET NULL,
  CONSTRAINT fk_recibo_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT,
  CONSTRAINT fk_recibo_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recibo_detalle (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  recibo_id uuid NOT NULL,
  venta_id uuid NOT NULL,
  monto numeric(12,2) NOT NULL,
  monto_moneda numeric(12,2),
  saldo_previo numeric(12,2),
  saldo_posterior numeric(12,2),
  CONSTRAINT fk_recibo_detalle_recibo FOREIGN KEY (recibo_id) REFERENCES recibo(id) ON DELETE CASCADE,
  CONSTRAINT fk_recibo_detalle_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE CASCADE
);

-- Otros
CREATE TABLE IF NOT EXISTS archivo (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo_entidad varchar(100),
  entidad_id uuid,
  nombre varchar(255),
  ruta text,
  mime varchar(100),
  subido_por uuid,
  subido_en timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS certificado (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  huella varchar(255) UNIQUE,
  ruta_cifrada text,
  valido_desde timestamptz,
  valido_hasta timestamptz,
  ambiente varchar(50),
  activo boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS almacen (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  direccion text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id uuid,
  accion varchar(255),
  tabla varchar(255),
  registro_id uuid,
  old_value jsonb,
  new_value jsonb,
  creado_en timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_producto_sku ON producto(sku);
CREATE INDEX IF NOT EXISTS idx_producto_codigo_barra ON producto(codigo_barra);
CREATE INDEX IF NOT EXISTS idx_cliente_ruc ON cliente(ruc);
CREATE INDEX IF NOT EXISTS idx_venta_fecha ON venta(fecha);
CREATE INDEX IF NOT EXISTS idx_venta_sucursal ON venta(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_pago_fecha ON pago(fecha_pago);
CREATE INDEX IF NOT EXISTS idx_movimiento_producto ON movimiento_stock(producto_id);
CREATE INDEX IF NOT EXISTS idx_cierre_caja_fecha ON cierre_caja(fecha_cierre);
CREATE INDEX IF NOT EXISTS idx_salida_caja_fecha ON salida_caja(fecha);
CREATE INDEX IF NOT EXISTS idx_recibo_fecha ON recibo(fecha);

-- Fin del script
