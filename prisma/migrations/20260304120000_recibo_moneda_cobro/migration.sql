-- Agrega moneda y tipo de cambio a los recibos y conserva el monto en moneda original
ALTER TABLE "recibo" ADD COLUMN "total_moneda" numeric(12,2);
ALTER TABLE "recibo" ADD COLUMN "moneda" varchar(10) NOT NULL DEFAULT 'PYG';
ALTER TABLE "recibo" ADD COLUMN "tipo_cambio" numeric(12,4);

ALTER TABLE "recibo_detalle" ADD COLUMN "monto_moneda" numeric(12,2);

-- Backfill de montos existentes
UPDATE "recibo" SET "total_moneda" = "total" WHERE "total_moneda" IS NULL;
UPDATE "recibo_detalle" SET "monto_moneda" = "monto" WHERE "monto_moneda" IS NULL;
