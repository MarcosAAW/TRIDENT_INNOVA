ALTER TABLE "compra" ADD COLUMN "nota_pedido_id" UUID;

CREATE UNIQUE INDEX "compra_nota_pedido_id_key" ON "compra"("nota_pedido_id");

ALTER TABLE "compra"
ADD CONSTRAINT "compra_nota_pedido_id_fkey"
FOREIGN KEY ("nota_pedido_id") REFERENCES "nota_pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;