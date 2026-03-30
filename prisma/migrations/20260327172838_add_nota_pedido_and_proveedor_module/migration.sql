-- DropForeignKey
ALTER TABLE "public"."detalle_nota_pedido" DROP CONSTRAINT "detalle_nota_pedido_nota_pedido_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."nota_credito_detalle" DROP CONSTRAINT "nota_credito_detalle_nota_credito_id_fkey";

-- DropIndex
DROP INDEX "public"."idx_detalle_nota_pedido_producto";

-- DropIndex
DROP INDEX "public"."idx_nota_pedido_proveedor";

-- DropIndex
DROP INDEX "public"."idx_nota_pedido_sucursal";

-- AddForeignKey
ALTER TABLE "detalle_nota_pedido" ADD CONSTRAINT "detalle_nota_pedido_nota_pedido_id_fkey" FOREIGN KEY ("nota_pedido_id") REFERENCES "nota_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nota_credito_detalle" ADD CONSTRAINT "nota_credito_detalle_nota_credito_id_fkey" FOREIGN KEY ("nota_credito_id") REFERENCES "nota_credito_electronica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "nota_pedido_numero_sucursal_unique" RENAME TO "nota_pedido_numero_sucursal_id_key";
