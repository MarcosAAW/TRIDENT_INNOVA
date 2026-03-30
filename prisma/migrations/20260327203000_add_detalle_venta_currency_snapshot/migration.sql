ALTER TABLE detalle_venta
  ADD COLUMN moneda_precio_unitario varchar(3),
  ADD COLUMN precio_unitario_moneda numeric(12,4),
  ADD COLUMN subtotal_moneda numeric(12,4),
  ADD COLUMN tipo_cambio_aplicado numeric(12,4);

UPDATE detalle_venta AS dv
SET
  moneda_precio_unitario = COALESCE(UPPER(v.moneda), 'PYG'),
  precio_unitario_moneda = CASE
    WHEN COALESCE(UPPER(v.moneda), 'PYG') = 'USD' AND COALESCE(v.tipo_cambio, 0) > 0
      THEN ROUND((dv.precio_unitario / v.tipo_cambio)::numeric, 4)
    ELSE ROUND(dv.precio_unitario::numeric, 4)
  END,
  subtotal_moneda = CASE
    WHEN COALESCE(UPPER(v.moneda), 'PYG') = 'USD' AND COALESCE(v.tipo_cambio, 0) > 0
      THEN ROUND((dv.subtotal / v.tipo_cambio)::numeric, 4)
    ELSE ROUND(dv.subtotal::numeric, 4)
  END,
  tipo_cambio_aplicado = CASE
    WHEN COALESCE(UPPER(v.moneda), 'PYG') = 'USD' AND COALESCE(v.tipo_cambio, 0) > 0
      THEN ROUND(v.tipo_cambio::numeric, 4)
    ELSE NULL
  END
FROM venta AS v
WHERE v.id = dv.venta_id;