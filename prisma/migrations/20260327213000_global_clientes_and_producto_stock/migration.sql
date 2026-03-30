CREATE TABLE IF NOT EXISTS producto_stock (
  id uuid PRIMARY KEY,
  producto_id uuid NOT NULL,
  sucursal_id uuid NOT NULL,
  stock_actual integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_producto_stock_producto FOREIGN KEY (producto_id) REFERENCES producto(id) ON DELETE CASCADE,
  CONSTRAINT fk_producto_stock_sucursal FOREIGN KEY (sucursal_id) REFERENCES sucursal(id) ON DELETE CASCADE,
  CONSTRAINT producto_stock_producto_sucursal_unique UNIQUE (producto_id, sucursal_id)
);

INSERT INTO producto_stock (id, producto_id, sucursal_id, stock_actual)
SELECT p.id, p.id, p.sucursal_id, COALESCE(p.stock_actual, 0)
FROM producto p
WHERE p.sucursal_id IS NOT NULL
ON CONFLICT (producto_id, sucursal_id) DO UPDATE
SET stock_actual = EXCLUDED.stock_actual,
    updated_at = now();
