CREATE TABLE "nota_credito_detalle" (
    "id" UUID NOT NULL,
    "nota_credito_id" UUID NOT NULL,
    "detalle_venta_id" UUID,
    "producto_id" UUID,
    "descripcion" TEXT NOT NULL,
    "codigo_producto" TEXT,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" DECIMAL(12,4) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "iva_porcentaje" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nota_credito_detalle_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "nota_credito_detalle"
ADD CONSTRAINT "nota_credito_detalle_nota_credito_id_fkey"
FOREIGN KEY ("nota_credito_id") REFERENCES "nota_credito_electronica"("id") ON DELETE CASCADE ON UPDATE CASCADE;