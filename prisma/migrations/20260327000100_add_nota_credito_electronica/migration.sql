CREATE TABLE "nota_credito_electronica" (
    "id" UUID NOT NULL,
    "venta_id" UUID NOT NULL,
    "factura_electronica_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "nro_nota" TEXT NOT NULL,
    "timbrado" TEXT NOT NULL,
    "establecimiento" TEXT NOT NULL,
    "punto_expedicion" TEXT NOT NULL,
    "secuencia" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "tipo_ajuste" TEXT NOT NULL DEFAULT 'TOTAL',
    "fecha_emision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moneda" TEXT NOT NULL DEFAULT 'PYG',
    "tipo_cambio" DECIMAL(12,4),
    "total" DECIMAL(12,2) NOT NULL,
    "total_moneda" DECIMAL(12,2),
    "cdc" TEXT,
    "xml_path" TEXT,
    "pdf_path" TEXT,
    "qr_data" TEXT,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'PENDIENTE',
    "respuesta_set" JSONB,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "ambiente" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "nota_credito_electronica_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "nota_credito_electronica_nro_nota_key" ON "nota_credito_electronica"("nro_nota");
CREATE UNIQUE INDEX "nota_credito_electronica_secuencia_unica" ON "nota_credito_electronica"("timbrado", "establecimiento", "punto_expedicion", "secuencia");

ALTER TABLE "nota_credito_electronica" ADD CONSTRAINT "nota_credito_electronica_venta_id_fkey"
    FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "nota_credito_electronica" ADD CONSTRAINT "nota_credito_electronica_factura_electronica_id_fkey"
    FOREIGN KEY ("factura_electronica_id") REFERENCES "factura_electronica"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "nota_credito_electronica" ADD CONSTRAINT "nota_credito_electronica_sucursal_id_fkey"
    FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
