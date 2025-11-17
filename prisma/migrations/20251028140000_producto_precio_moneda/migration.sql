-- Agrega soporte para precios en moneda extranjera en productos
ALTER TABLE "producto"
  ADD COLUMN IF NOT EXISTS "precio_venta_original" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "moneda_precio_venta" varchar(10) NOT NULL DEFAULT 'PYG',
  ADD COLUMN IF NOT EXISTS "tipo_cambio_precio_venta" numeric(12,4),
  ADD COLUMN IF NOT EXISTS "precio_compra_original" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "moneda_precio_compra" varchar(10) DEFAULT 'PYG',
  ADD COLUMN IF NOT EXISTS "tipo_cambio_precio_compra" numeric(12,4);
