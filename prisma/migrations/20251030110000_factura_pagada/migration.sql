-- Alter enum EstadoFactura to include PAGADA (idempotent guard)
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_enum e
		JOIN pg_type t ON e.enumtypid = t.oid
		WHERE t.typname = 'EstadoFactura'
			AND e.enumlabel = 'PAGADA'
	) THEN
		ALTER TYPE "EstadoFactura" ADD VALUE 'PAGADA';
	END IF;
END $$;
