-- init.sql
-- Esquema SQL inicial para Trident Innova (PostgreSQL)
-- Generado a partir del prisma/schema.prisma proporcionado

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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

-- Tabla: categoria
CREATE TABLE IF NOT EXISTS categoria (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  descripcion text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

-- Tabla: producto
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
  codigo_barra varchar(255) UNIQUE,
  categoria_id uuid,
  minimo_stock integer,
  unidad varchar(50),
  imagen_url text,
  activo boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_producto_categoria FOREIGN KEY (categoria_id) REFERENCES categoria(id) ON DELETE SET NULL
);

-- Tabla: cliente
CREATE TABLE IF NOT EXISTS cliente (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre_razon_social varchar(255) NOT NULL,
  ruc varchar(100) UNIQUE,
  direccion text,
  telefono varchar(50),
  correo varchar(255),
  tipo_cliente varchar(50),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

-- Tabla: proveedor
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

-- Tabla: usuario
CREATE TABLE IF NOT EXISTS usuario (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  usuario varchar(150) NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  rol "RolUsuario" NOT NULL,
  activo boolean DEFAULT true,
  last_login timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

-- Tabla: venta
CREATE TABLE IF NOT EXISTS venta (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cliente_id uuid,
  usuario_id uuid NOT NULL,
  fecha timestamptz DEFAULT now(),
  subtotal numeric(12,2) NOT NULL,
  descuento_total numeric(12,2),
  impuesto_total numeric(12,2),
  total numeric(12,2) NOT NULL,
  total_moneda numeric(12,2),
  iva_porcentaje integer DEFAULT 10,
  estado varchar(50) NOT NULL,
  factura_electronica_id uuid,
  moneda varchar(10) DEFAULT 'PYG',
  tipo_cambio numeric(12,4),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_venta_cliente FOREIGN KEY (cliente_id) REFERENCES cliente(id) ON DELETE SET NULL,
  CONSTRAINT fk_venta_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT
);

-- Tabla: detalle_venta
CREATE TABLE IF NOT EXISTS detalle_venta (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid NOT NULL,
  producto_id uuid NOT NULL,
  cantidad integer NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  CONSTRAINT fk_detalleventa_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE CASCADE,
  CONSTRAINT fk_detalleventa_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE RESTRICT
);

-- Tabla: compra
CREATE TABLE IF NOT EXISTS compra (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  proveedor_id uuid,
  fecha timestamptz DEFAULT now(),
  subtotal numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  estado varchar(50) NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_compra_proveedor FOREIGN KEY (proveedor_id) REFERENCES proveedor(id) ON DELETE SET NULL
);

-- Tabla: detalle_compra
CREATE TABLE IF NOT EXISTS detalle_compra (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  compra_id uuid NOT NULL,
  producto_id uuid NOT NULL,
  cantidad integer NOT NULL,
  precio_unitario numeric(12,2) NOT NULL,
  CONSTRAINT fk_detallecompra_compra FOREIGN KEY (compra_id) REFERENCES compra(id) ON DELETE CASCADE,
  CONSTRAINT fk_detallecompra_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE RESTRICT
);

-- Tabla: factura_electronica
CREATE TABLE IF NOT EXISTS factura_electronica (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id uuid,
  nro_factura varchar(100) UNIQUE,
  timbrado varchar(255),
  fecha_emision timestamptz,
  xml_path text,
  CONSTRAINT fk_cierre_caja_apertura FOREIGN KEY (apertura_id) REFERENCES apertura_caja(id) ON DELETE SET NULL,
  CONSTRAINT uq_cierre_caja_apertura UNIQUE (apertura_id)
  qr_data text,
  estado "EstadoFactura" NOT NULL,
  respuesta_set jsonb,
  intentos integer DEFAULT 0,
  ambiente varchar(50),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT fk_factura_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE SET NULL
);

-- Tabla: factura_digital
CREATE TABLE IF NOT EXISTS factura_digital (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  venta_id text UNIQUE,
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
  CONSTRAINT uq_factura_digital_secuencia UNIQUE (timbrado, establecimiento, punto_expedicion, secuencia)
);

-- Tabla: movimiento_stock
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
  fecha_pago timestamptz DEFAULT now(),
  monto numeric(12,2) NOT NULL,
  metodo varchar(100),
  referencia varchar(255),
  CONSTRAINT fk_pago_venta FOREIGN KEY (venta_id) REFERENCES venta(id) ON DELETE CASCADE
);

-- Tabla: apertura_caja
CREATE TABLE IF NOT EXISTS apertura_caja (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id uuid NOT NULL,
  fecha_apertura timestamptz DEFAULT now(),
  fecha_cierre timestamptz,
  saldo_inicial numeric(12,2) NOT NULL DEFAULT 0,
  observaciones text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_apertura_caja_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT
);

-- Tabla: cierre_caja
CREATE TABLE IF NOT EXISTS cierre_caja (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id uuid NOT NULL,
  apertura_id uuid,
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
  CONSTRAINT fk_cierre_caja_apertura FOREIGN KEY (apertura_id) REFERENCES apertura_caja(id) ON DELETE SET NULL
);

-- Tabla: salida_caja
CREATE TABLE IF NOT EXISTS salida_caja (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cierre_id uuid,
  usuario_id uuid NOT NULL,
  descripcion text NOT NULL,
  monto numeric(12,2) NOT NULL,
  fecha timestamptz DEFAULT now(),
  observacion text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_salida_caja_cierre FOREIGN KEY (cierre_id) REFERENCES cierre_caja(id) ON DELETE SET NULL,
  CONSTRAINT fk_salida_caja_usuario FOREIGN KEY (usuario_id) REFERENCES usuario(id) ON DELETE RESTRICT
);

-- Tabla: archivo
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

-- Tabla: certificado
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

-- Tabla: almacen
CREATE TABLE IF NOT EXISTS almacen (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre varchar(255) NOT NULL,
  direccion text,
  created_at timestamptz DEFAULT now()
);

-- Tabla: audit_log
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

-- Índices recomendados
CREATE INDEX IF NOT EXISTS idx_producto_sku ON producto(sku);
CREATE INDEX IF NOT EXISTS idx_producto_codigo_barra ON producto(codigo_barra);
CREATE INDEX IF NOT EXISTS idx_cliente_ruc ON cliente(ruc);
CREATE INDEX IF NOT EXISTS idx_venta_fecha ON venta(fecha);
CREATE INDEX IF NOT EXISTS idx_movimiento_producto ON movimiento_stock(producto_id);
CREATE INDEX IF NOT EXISTS idx_cierre_caja_fecha ON cierre_caja(fecha_cierre);
CREATE INDEX IF NOT EXISTS idx_salida_caja_fecha ON salida_caja(fecha);

-- Fin del script
