-- Un cliente eliminado (soft delete) no debe bloquear la creacion de uno nuevo con el mismo RUC.
-- cliente_ruc_key se creo como INDEX (no como table constraint), por eso se dropea con DROP INDEX.
DROP INDEX IF EXISTS "cliente_ruc_key";

CREATE UNIQUE INDEX "cliente_ruc_active_key" ON "cliente"("ruc") WHERE "deleted_at" IS NULL;
