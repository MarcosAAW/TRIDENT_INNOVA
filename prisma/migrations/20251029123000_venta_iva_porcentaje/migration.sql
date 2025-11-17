-- Agrega columna para registrar el porcentaje de IVA aplicado en ventas
ALTER TABLE "venta"
  ADD COLUMN IF NOT EXISTS "iva_porcentaje" integer NOT NULL DEFAULT 10;
