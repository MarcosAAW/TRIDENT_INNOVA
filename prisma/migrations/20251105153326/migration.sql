/*
  Warnings:

  - Made the column `total_tarjeta` on table `cierre_caja` required. This step will fail if there are existing NULL values in that column.
  - Made the column `total_transferencia` on table `cierre_caja` required. This step will fail if there are existing NULL values in that column.
  - Made the column `total_salidas` on table `cierre_caja` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "public"."apertura_caja" DROP CONSTRAINT "apertura_caja_usuario_id_fkey";

-- AlterTable
ALTER TABLE "apertura_caja" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "cierre_caja" ALTER COLUMN "total_tarjeta" SET NOT NULL,
ALTER COLUMN "total_tarjeta" SET DEFAULT 0,
ALTER COLUMN "total_transferencia" SET NOT NULL,
ALTER COLUMN "total_transferencia" SET DEFAULT 0,
ALTER COLUMN "total_salidas" SET NOT NULL,
ALTER COLUMN "total_salidas" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "usuario" ALTER COLUMN "id" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "apertura_caja" ADD CONSTRAINT "apertura_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
