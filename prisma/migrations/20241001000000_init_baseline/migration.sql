-- Migración base para sincronizar Prisma con el esquema existente (snake_case)
-- Todas las instrucciones usan IF NOT EXISTS para evitar conflictos en bases ya pobladas

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
    CREATE TYPE "EstadoFactura" AS ENUM ('PENDIENTE', 'ENVIADO', 'ACEPTADO', 'RECHAZADO');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "categoria" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "nombre" varchar(255) NOT NULL,
  "descripcion" text,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "producto" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "sku" varchar(100) NOT NULL UNIQUE,
  "nombre" varchar(255) NOT NULL,
  "descripcion" text,
  "tipo" "TipoProducto" NOT NULL,
  "precio_venta" numeric(12,2) NOT NULL,
  "precio_venta_original" numeric(12,2),
  "moneda_precio_venta" varchar(10) NOT NULL DEFAULT 'PYG',
  "tipo_cambio_precio_venta" numeric(12,4),
  "precio_compra" numeric(12,2),
  "precio_compra_original" numeric(12,2),
  "moneda_precio_compra" varchar(10) DEFAULT 'PYG',
  "tipo_cambio_precio_compra" numeric(12,4),
  "stock_actual" integer DEFAULT 0,
  "codigo_barra" varchar(255) UNIQUE,
  "categoria_id" uuid,
  "minimo_stock" integer,
  "unidad" varchar(50),
  "imagen_url" text,
  "activo" boolean DEFAULT true,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "producto_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categoria"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "cliente" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "nombre_razon_social" varchar(255) NOT NULL,
  "ruc" varchar(100) UNIQUE,
  "direccion" text,
  "telefono" varchar(50),
  "correo" varchar(255),
  "tipo_cliente" varchar(50),
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "proveedor" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "nombre_razon_social" varchar(255) NOT NULL,
  "ruc" varchar(100) UNIQUE,
  "contacto" varchar(255),
  "direccion" text,
  "telefono" varchar(50),
  "correo" varchar(255),
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "usuario" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "nombre" varchar(255) NOT NULL,
  "usuario" varchar(150) NOT NULL UNIQUE,
  "password_hash" varchar(255) NOT NULL,
  "rol" "RolUsuario" NOT NULL,
  "activo" boolean DEFAULT true,
  "last_login" timestamptz,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "venta" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "cliente_id" uuid,
  "usuario_id" uuid NOT NULL,
  "fecha" timestamptz DEFAULT now(),
  "subtotal" numeric(12,2) NOT NULL,
  "descuento_total" numeric(12,2),
  "impuesto_total" numeric(12,2),
  "total" numeric(12,2) NOT NULL,
  "estado" varchar(50) NOT NULL,
  "factura_electronica_id" uuid,
  "moneda" varchar(10) DEFAULT 'PYG',
  "tipo_cambio" numeric(12,4),
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "venta_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "cliente"("id") ON DELETE SET NULL,
  CONSTRAINT "venta_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "detalle_venta" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "venta_id" uuid NOT NULL,
  "producto_id" uuid NOT NULL,
  "cantidad" integer NOT NULL,
  "precio_unitario" numeric(12,2) NOT NULL,
  "subtotal" numeric(12,2) NOT NULL,
  CONSTRAINT "detalle_venta_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE CASCADE,
  CONSTRAINT "detalle_venta_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "compra" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "proveedor_id" uuid,
  "fecha" timestamptz DEFAULT now(),
  "subtotal" numeric(12,2) NOT NULL,
  "total" numeric(12,2) NOT NULL,
  "estado" varchar(50) NOT NULL,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "compra_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedor"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "detalle_compra" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "compra_id" uuid NOT NULL,
  "producto_id" uuid NOT NULL,
  "cantidad" integer NOT NULL,
  "precio_unitario" numeric(12,2) NOT NULL,
  CONSTRAINT "detalle_compra_compra_id_fkey" FOREIGN KEY ("compra_id") REFERENCES "compra"("id") ON DELETE CASCADE,
  CONSTRAINT "detalle_compra_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "factura_electronica" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "venta_id" uuid UNIQUE,
  "nro_factura" varchar(100) UNIQUE,
  "timbrado" varchar(255),
  "fecha_emision" timestamptz,
  "xml_path" text,
  "pdf_path" text,
  "qr_data" text,
  "estado" "EstadoFactura" NOT NULL,
  "respuesta_set" jsonb,
  "intentos" integer DEFAULT 0,
  "ambiente" varchar(50),
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  CONSTRAINT "factura_electronica_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "movimiento_stock" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "producto_id" uuid NOT NULL,
  "tipo" "TipoMovimiento" NOT NULL,
  "cantidad" integer NOT NULL,
  "motivo" varchar(255),
  "referencia_id" uuid,
  "referencia_tipo" varchar(100),
  "almacen_id" uuid,
  "usuario_id" uuid,
  "fecha" timestamptz DEFAULT now(),
  CONSTRAINT "movimiento_stock_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "pago" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "venta_id" uuid NOT NULL,
  "fecha_pago" timestamptz DEFAULT now(),
  "monto" numeric(12,2) NOT NULL,
  "metodo" varchar(100) NOT NULL,
  "referencia" varchar(255),
  CONSTRAINT "pago_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "archivo" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tipo_entidad" varchar(100) NOT NULL,
  "entidad_id" uuid NOT NULL,
  "nombre" varchar(255) NOT NULL,
  "ruta" text NOT NULL,
  "mime" varchar(100) NOT NULL,
  "subido_por" uuid,
  "subido_en" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "certificado" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "huella" varchar(255) UNIQUE,
  "ruta_cifrada" text NOT NULL,
  "valido_desde" timestamptz,
  "valido_hasta" timestamptz,
  "ambiente" varchar(50),
  "activo" boolean DEFAULT true,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "almacen" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "nombre" varchar(255) NOT NULL,
  "direccion" text,
  "created_at" timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "usuario_id" uuid,
  "accion" varchar(255) NOT NULL,
  "tabla" varchar(255) NOT NULL,
  "registro_id" uuid NOT NULL,
  "old_value" jsonb,
  "new_value" jsonb,
  "creado_en" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_producto_sku" ON "producto"("sku");
CREATE INDEX IF NOT EXISTS "idx_producto_codigo_barra" ON "producto"("codigo_barra");
CREATE INDEX IF NOT EXISTS "idx_cliente_ruc" ON "cliente"("ruc");
CREATE INDEX IF NOT EXISTS "idx_venta_fecha" ON "venta"("fecha");
CREATE INDEX IF NOT EXISTS "idx_movimiento_producto" ON "movimiento_stock"("producto_id");
