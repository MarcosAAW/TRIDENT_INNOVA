-- AlterTable
ALTER TABLE "apertura_caja" ADD COLUMN     "sucursal_id" TEXT;

-- AlterTable
ALTER TABLE "cierre_caja" ADD COLUMN     "sucursal_id" TEXT;

-- AlterTable
ALTER TABLE "factura_digital" ADD COLUMN     "sucursal_id" TEXT;

-- AlterTable
ALTER TABLE "factura_electronica" ADD COLUMN     "sucursal_id" TEXT;

-- AlterTable
ALTER TABLE "pago" ADD COLUMN     "sucursal_id" TEXT;

-- AlterTable
ALTER TABLE "salida_caja" ADD COLUMN     "sucursal_id" TEXT;

-- AlterTable
ALTER TABLE "venta" ADD COLUMN     "condicion_venta" TEXT NOT NULL DEFAULT 'CONTADO',
ADD COLUMN     "es_credito" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fecha_vencimiento" TIMESTAMP(3),
ADD COLUMN     "saldo_pendiente" DECIMAL(12,2),
ADD COLUMN     "sucursal_id" TEXT;

-- CreateTable
CREATE TABLE "sucursal" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "ciudad" TEXT,
    "direccion" TEXT,
    "telefono" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sucursal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario_sucursal" (
    "usuario_id" UUID NOT NULL,
    "sucursal_id" TEXT NOT NULL,
    "rol" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_sucursal_pkey" PRIMARY KEY ("usuario_id","sucursal_id")
);

-- CreateTable
CREATE TABLE "recibo" (
    "id" TEXT NOT NULL,
    "numero" TEXT,
    "cliente_id" TEXT,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total" DECIMAL(12,2) NOT NULL,
    "metodo" TEXT NOT NULL,
    "referencia" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "observacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recibo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recibo_detalle" (
    "id" TEXT NOT NULL,
    "recibo_id" TEXT NOT NULL,
    "venta_id" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "recibo_detalle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recibo_numero_key" ON "recibo"("numero");

-- AddForeignKey
ALTER TABLE "usuario_sucursal" ADD CONSTRAINT "usuario_sucursal_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_sucursal" ADD CONSTRAINT "usuario_sucursal_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta" ADD CONSTRAINT "venta_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_electronica" ADD CONSTRAINT "factura_electronica_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_digital" ADD CONSTRAINT "factura_digital_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apertura_caja" ADD CONSTRAINT "apertura_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo_detalle" ADD CONSTRAINT "recibo_detalle_recibo_id_fkey" FOREIGN KEY ("recibo_id") REFERENCES "recibo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo_detalle" ADD CONSTRAINT "recibo_detalle_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
