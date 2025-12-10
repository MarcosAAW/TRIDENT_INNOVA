/*
  Warnings:

  - The primary key for the `factura_digital` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE "public"."factura_digital" DROP CONSTRAINT "factura_digital_venta_fk";

-- AlterTable
ALTER TABLE "factura_digital" DROP CONSTRAINT "factura_digital_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "nro_factura" SET DATA TYPE TEXT,
ALTER COLUMN "timbrado" SET DATA TYPE TEXT,
ALTER COLUMN "establecimiento" SET DATA TYPE TEXT,
ALTER COLUMN "punto_expedicion" SET DATA TYPE TEXT,
ALTER COLUMN "condicion_venta" SET DATA TYPE TEXT,
ALTER COLUMN "fecha_emision" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "moneda" SET DATA TYPE TEXT,
ALTER COLUMN "hash_pdf" SET DATA TYPE TEXT,
ALTER COLUMN "numero_control" SET DATA TYPE TEXT,
ALTER COLUMN "estado_envio" SET DATA TYPE TEXT,
ALTER COLUMN "enviado_en" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "factura_digital_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "factura_digital" ADD CONSTRAINT "factura_digital_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "factura_digital_secuencia_unica" RENAME TO "factura_digital_timbrado_establecimiento_punto_expedicion_s_key";
