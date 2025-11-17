-- CreateTable
CREATE TABLE "apertura_caja" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "usuario_id" UUID NOT NULL,
    "fecha_apertura" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_cierre" TIMESTAMP(3),
    "saldo_inicial" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "observaciones" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "apertura_caja_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "apertura_caja" ADD CONSTRAINT "apertura_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "cierre_caja" ADD COLUMN "apertura_id" UUID;
ALTER TABLE "cierre_caja" ADD COLUMN "saldo_inicial" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_apertura_id_key" UNIQUE("apertura_id");

-- AddForeignKey
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_apertura_id_fkey" FOREIGN KEY ("apertura_id") REFERENCES "apertura_caja"("id") ON DELETE SET NULL ON UPDATE CASCADE;
