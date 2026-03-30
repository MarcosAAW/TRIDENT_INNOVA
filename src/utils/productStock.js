function toStockNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(Math.trunc(numeric), 0);
}

async function getProductoStockMap(prismaLike, productoIds, sucursalId) {
  if (!sucursalId || !Array.isArray(productoIds) || !productoIds.length) {
    return new Map();
  }

  const rows = await prismaLike.productoStock.findMany({
    where: {
      productoId: { in: productoIds },
      sucursalId
    }
  });

  return new Map(rows.map((row) => [row.productoId, row]));
}

function resolveProductoStock(producto, sucursalId, stockMap = new Map()) {
  if (!producto) return 0;
  const stockRow = stockMap instanceof Map ? stockMap.get(producto.id) : stockMap;
  if (stockRow) {
    return toStockNumber(stockRow.stock_actual);
  }
  if (producto.sucursalId && sucursalId && producto.sucursalId === sucursalId) {
    return toStockNumber(producto.stock_actual);
  }
  return 0;
}

function decorateProductoWithSucursalStock(producto, sucursalId, stockMap = new Map()) {
  if (!producto) return producto;
  return {
    ...producto,
    stock_actual: resolveProductoStock(producto, sucursalId, stockMap)
  };
}

async function decorateProductosWithSucursalStock(prismaLike, productos, sucursalId) {
  const safeProductos = Array.isArray(productos) ? productos : [];
  const stockMap = await getProductoStockMap(
    prismaLike,
    safeProductos.map((producto) => producto.id),
    sucursalId
  );
  return safeProductos.map((producto) => decorateProductoWithSucursalStock(producto, sucursalId, stockMap));
}

async function ensureProductoStockRow(tx, producto, sucursalId) {
  if (!producto?.id || !sucursalId) {
    throw new Error('Producto y sucursal son obligatorios para resolver stock.');
  }

  const existingRows = await tx.productoStock.findMany({
    where: {
      productoId: { in: [producto.id] },
      sucursalId
    }
  });
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing) return existing;

  const initialStock = producto.sucursalId === sucursalId ? toStockNumber(producto.stock_actual) : 0;
  return tx.productoStock.create({
    data: {
      productoId: producto.id,
      sucursalId,
      stock_actual: initialStock
    }
  });
}

async function applyProductoStockDelta(tx, producto, sucursalId, delta) {
  const stockRow = await ensureProductoStockRow(tx, producto, sucursalId);
  const nextStock = toStockNumber(stockRow.stock_actual) + Number(delta);
  if (!Number.isFinite(nextStock) || nextStock < 0) {
    throw new Error('El stock no puede quedar negativo.');
  }

  const updatedStock = await tx.productoStock.update({
    where: { id: stockRow.id },
    data: {
      stock_actual: nextStock
    }
  });

  await tx.producto.update({
    where: { id: producto.id },
    data: {
      stock_actual: {
        increment: Number(delta)
      }
    }
  });

  return updatedStock;
}

module.exports = {
  toStockNumber,
  getProductoStockMap,
  resolveProductoStock,
  decorateProductoWithSucursalStock,
  decorateProductosWithSucursalStock,
  ensureProductoStockRow,
  applyProductoStockDelta
};
