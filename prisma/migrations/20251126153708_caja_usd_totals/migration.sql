-- AlterTable
ALTER TABLE "apertura_caja" ADD COLUMN     "efectivo_usd" DECIMAL(12,2),
ADD COLUMN     "total_ventas_usd" DECIMAL(12,2) NOT NULL DEFAULT 0;
