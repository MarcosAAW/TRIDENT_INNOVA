ALTER TYPE "EstadoNotaPedido" RENAME TO "EstadoNotaPedido_old";

CREATE TYPE "EstadoNotaPedido" AS ENUM ('BORRADOR', 'EMITIDA', 'RECIBIDA', 'COMPRADA', 'ANULADA');

ALTER TABLE "nota_pedido"
  ALTER COLUMN "estado" DROP DEFAULT,
  ALTER COLUMN "estado" TYPE "EstadoNotaPedido"
  USING (
    CASE
      WHEN "estado"::text = 'ATENDIDA' THEN 'RECIBIDA'
      ELSE "estado"::text
    END
  )::"EstadoNotaPedido",
  ALTER COLUMN "estado" SET DEFAULT 'BORRADOR';

DROP TYPE "EstadoNotaPedido_old";