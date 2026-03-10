-- Drop FK before altering PK type
ALTER TABLE "usuario_sucursal" DROP CONSTRAINT IF EXISTS "usuario_sucursal_sucursal_id_fkey";
ALTER TABLE "venta" DROP CONSTRAINT IF EXISTS "venta_sucursal_id_fkey";
ALTER TABLE "factura_electronica" DROP CONSTRAINT IF EXISTS "factura_electronica_sucursal_id_fkey";
ALTER TABLE "factura_digital" DROP CONSTRAINT IF EXISTS "factura_digital_sucursal_id_fkey";
ALTER TABLE "apertura_caja" DROP CONSTRAINT IF EXISTS "apertura_caja_sucursal_id_fkey";
ALTER TABLE "cierre_caja" DROP CONSTRAINT IF EXISTS "cierre_caja_sucursal_id_fkey";
ALTER TABLE "salida_caja" DROP CONSTRAINT IF EXISTS "salida_caja_sucursal_id_fkey";
ALTER TABLE "pago" DROP CONSTRAINT IF EXISTS "pago_sucursal_id_fkey";
ALTER TABLE "recibo" DROP CONSTRAINT IF EXISTS "recibo_sucursal_id_fkey";

-- Ensure sucursal.id is UUID (in case previous schema used text)
ALTER TABLE "sucursal"
ALTER COLUMN "id" TYPE UUID USING "id"::uuid,
ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();

-- Align usuario_sucursal.sucursal_id with UUID type
ALTER TABLE "usuario_sucursal"
	ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;

ALTER TABLE "venta" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "factura_electronica" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "factura_digital" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "apertura_caja" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "cierre_caja" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "salida_caja" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "pago" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;
ALTER TABLE "recibo" ALTER COLUMN "sucursal_id" TYPE UUID USING "sucursal_id"::uuid;

ALTER TABLE "usuario_sucursal"
	ADD CONSTRAINT "usuario_sucursal_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE CASCADE;
ALTER TABLE "venta" ADD CONSTRAINT "venta_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "factura_electronica" ADD CONSTRAINT "factura_electronica_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "factura_digital" ADD CONSTRAINT "factura_digital_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "apertura_caja" ADD CONSTRAINT "apertura_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "pago" ADD CONSTRAINT "pago_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL;

-- Add sucursal_id to cliente
ALTER TABLE "cliente"
ADD COLUMN IF NOT EXISTS "sucursal_id" UUID REFERENCES "sucursal"("id") ON DELETE SET NULL;

-- Add sucursal_id to producto
ALTER TABLE "producto"
ADD COLUMN IF NOT EXISTS "sucursal_id" UUID REFERENCES "sucursal"("id") ON DELETE SET NULL;

-- Optional: indexes to speed up filters
CREATE INDEX IF NOT EXISTS "idx_cliente_sucursal" ON "cliente" ("sucursal_id");
CREATE INDEX IF NOT EXISTS "idx_producto_sucursal" ON "producto" ("sucursal_id");
