-- Convertir columnas dependientes de usuario a UUID antes de crear nuevas tablas
ALTER TABLE "venta" DROP CONSTRAINT IF EXISTS "venta_usuario_id_fkey";

ALTER TABLE "usuario"
    ALTER COLUMN "id" SET DATA TYPE UUID USING "id"::uuid,
    ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();

ALTER TABLE "venta"
    ALTER COLUMN "usuario_id" SET DATA TYPE UUID USING "usuario_id"::uuid;

ALTER TABLE "audit_log"
    ALTER COLUMN "usuario_id" SET DATA TYPE UUID USING "usuario_id"::uuid;

ALTER TABLE "movimiento_stock"
    ALTER COLUMN "usuario_id" SET DATA TYPE UUID USING "usuario_id"::uuid;

ALTER TABLE "venta" ADD CONSTRAINT "venta_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "cierre_caja" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "fecha_apertura" TIMESTAMP(3),
    "fecha_cierre" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_ventas" DECIMAL(12,2) NOT NULL,
    "total_efectivo" DECIMAL(12,2) NOT NULL,
    "total_tarjeta" DECIMAL(12,2),
    "total_transferencia" DECIMAL(12,2),
    "total_salidas" DECIMAL(12,2),
    "efectivo_declarado" DECIMAL(12,2),
    "diferencia" DECIMAL(12,2),
    "observaciones" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cierre_caja_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salida_caja" (
    "id" UUID NOT NULL,
    "cierre_id" UUID,
    "usuario_id" UUID NOT NULL,
    "descripcion" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "salida_caja_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_cierre_id_fkey" FOREIGN KEY ("cierre_id") REFERENCES "cierre_caja"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
