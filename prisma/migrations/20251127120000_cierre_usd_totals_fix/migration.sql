-- Move USD totals tracking from aperturas to cierres
ALTER TABLE "cierre_caja"
  ADD COLUMN "total_ventas_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "efectivo_usd" DECIMAL(12,2);

-- Copy previously stored values, if any
UPDATE "cierre_caja" AS cc
SET
  "total_ventas_usd" = COALESCE(ac."total_ventas_usd", 0),
  "efectivo_usd" = ac."efectivo_usd"
FROM "apertura_caja" ac
WHERE cc."apertura_id" = ac."id";

-- Clean up the columns in aperturas
ALTER TABLE "apertura_caja"
  DROP COLUMN IF EXISTS "total_ventas_usd",
  DROP COLUMN IF EXISTS "efectivo_usd";
