-- Almacena saldos previos y posteriores por detalle de recibo
ALTER TABLE "recibo_detalle" ADD COLUMN "saldo_previo" numeric(12,2);
ALTER TABLE "recibo_detalle" ADD COLUMN "saldo_posterior" numeric(12,2);

-- Backfill básico con valores actuales si existen
UPDATE "recibo_detalle" rd
SET saldo_previo = v.saldo_pendiente + rd.monto,
    saldo_posterior = v.saldo_pendiente
FROM "venta" v
WHERE rd.venta_id = v.id AND (rd.saldo_previo IS NULL OR rd.saldo_posterior IS NULL);
