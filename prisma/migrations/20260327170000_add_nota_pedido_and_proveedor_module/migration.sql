CREATE TYPE "EstadoNotaPedido" AS ENUM ('BORRADOR', 'EMITIDA', 'ANULADA', 'ATENDIDA');

CREATE TYPE "TipoNotaPedido" AS ENUM ('GENERAL', 'REPUESTOS');

CREATE TABLE "nota_pedido" (
    "id" UUID NOT NULL,
    "numero" TEXT NOT NULL,
    "proveedor_id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" "EstadoNotaPedido" NOT NULL DEFAULT 'BORRADOR',
    "tipo" "TipoNotaPedido" NOT NULL DEFAULT 'GENERAL',
    "equipo_destino" TEXT,
    "observaciones" TEXT,
    "pdf_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "nota_pedido_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "detalle_nota_pedido" (
    "id" UUID NOT NULL,
    "nota_pedido_id" UUID NOT NULL,
    "producto_id" UUID,
    "codigo_articulo" TEXT NOT NULL,
    "codigo_dji" TEXT,
    "sku" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "equipo_destino" TEXT,
    "observacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detalle_nota_pedido_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "nota_pedido_numero_sucursal_unique" ON "nota_pedido"("numero", "sucursal_id");
CREATE INDEX "idx_nota_pedido_sucursal" ON "nota_pedido"("sucursal_id");
CREATE INDEX "idx_nota_pedido_proveedor" ON "nota_pedido"("proveedor_id");
CREATE INDEX "idx_detalle_nota_pedido_producto" ON "detalle_nota_pedido"("producto_id");

ALTER TABLE "nota_pedido"
ADD CONSTRAINT "nota_pedido_proveedor_id_fkey"
FOREIGN KEY ("proveedor_id") REFERENCES "proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "nota_pedido"
ADD CONSTRAINT "nota_pedido_usuario_id_fkey"
FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "nota_pedido"
ADD CONSTRAINT "nota_pedido_sucursal_id_fkey"
FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "detalle_nota_pedido"
ADD CONSTRAINT "detalle_nota_pedido_nota_pedido_id_fkey"
FOREIGN KEY ("nota_pedido_id") REFERENCES "nota_pedido"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "detalle_nota_pedido"
ADD CONSTRAINT "detalle_nota_pedido_producto_id_fkey"
FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE SET NULL ON UPDATE CASCADE;