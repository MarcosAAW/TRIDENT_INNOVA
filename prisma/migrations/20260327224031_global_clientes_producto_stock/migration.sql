-- DropForeignKey
ALTER TABLE "public"."producto_stock" DROP CONSTRAINT "fk_producto_stock_producto";

-- DropForeignKey
ALTER TABLE "public"."producto_stock" DROP CONSTRAINT "fk_producto_stock_sucursal";

-- AlterTable
ALTER TABLE "producto_stock" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "producto_stock" ADD CONSTRAINT "producto_stock_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_stock" ADD CONSTRAINT "producto_stock_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "producto_stock_producto_sucursal_unique" RENAME TO "producto_stock_producto_id_sucursal_id_key";
