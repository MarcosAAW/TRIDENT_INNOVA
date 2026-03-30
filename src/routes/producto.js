const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { TipoProducto } = require('@prisma/client');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');
const {
  decorateProductoWithSucursalStock,
  decorateProductosWithSucursalStock,
  resolveProductoStock,
  getProductoStockMap,
  ensureProductoStockRow,
  applyProductoStockDelta,
  toStockNumber
} = require('../utils/productStock');

const REPORT_LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logotridentgrande.png');
const PRODUCT_IMAGES_DIR = path.join(__dirname, '..', '..', 'storage', 'productos');
if (!fs.existsSync(PRODUCT_IMAGES_DIR)) {
  fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PRODUCT_IMAGES_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      const safeExt = ext.length <= 6 ? ext : '.jpg';
      const name = `${req.params.id || 'producto'}-${Date.now()}${safeExt}`;
      cb(null, name);
    }
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes'));
    }
    cb(null, true);
  },
  limits: { fileSize: 3 * 1024 * 1024 }
});

const SKU_PREFIX_BY_TIPO = {
  DRON: 'DRON',
  REPUESTO: 'REP',
  SERVICIO: 'SERV',
  OTRO: 'OTR'
};

const MONEDAS_PERMITIDAS = new Set(['PYG', 'USD']);
const MAX_DECIMAL_VALUE = 10_000_000_000; // límite por definición Decimal(12,2)

const currencySchema = z
  .string()
  .trim()
  .min(3)
  .max(3)
  .transform((value) => value.toUpperCase())
  .refine((value) => MONEDAS_PERMITIDAS.has(value), {
    message: 'Moneda no soportada (usa PYG o USD).'
  });

const optionalCurrencySchema = currencySchema.optional();

const optionalDecimal = (message) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (value === '' || value === null || value === undefined) return undefined;
      return typeof value === 'number' ? value : Number(value);
    })
    .refine((value) => value === undefined || Number.isFinite(value), {
      message: message || 'Valor numérico inválido.'
    })
    .transform((value) => (value === undefined ? undefined : Number(value)));

const createProductoSchema = z.object({
  sku: z.string().min(1),
  nombre: z.string().min(1),
  tipo: z.nativeEnum(TipoProducto),
  precio_venta: optionalDecimal('El precio de venta debe ser numérico.').transform((value) => {
    if (value === undefined) {
      throw new Error('El precio de venta es obligatorio.');
    }
    return value;
  }),
  moneda_precio_venta: currencySchema.default('PYG'),
  tipo_cambio_precio_venta: optionalDecimal('El tipo de cambio debe ser numérico.'),
  precio_venta_original: optionalDecimal('El precio original debe ser numérico.'),
  descripcion: z.string().optional(),
  precio_compra: optionalDecimal('El precio de compra debe ser numérico.'),
  moneda_precio_compra: optionalCurrencySchema,
  tipo_cambio_precio_compra: optionalDecimal('El tipo de cambio debe ser numérico.'),
  precio_compra_original: optionalDecimal('El precio original debe ser numérico.'),
  stock_actual: z.coerce.number().int().optional(),
  codigo_dji: z.string().optional(),
  codigo_barra: z.string().optional(),
  categoriaId: z.string().uuid().optional(),
  minimo_stock: z.coerce.number().int().optional(),
  unidad: z.string().optional(),
  imagen_url: z.string().optional(),
  activo: z.coerce.boolean().optional()
});

const updateProductoSchema = createProductoSchema.partial();

router.use(requireAuth, requireSucursal);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  tipo: z.nativeEnum(TipoProducto).optional(),
  activo: z.coerce.boolean().optional(),
  include_deleted: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).optional(),
  critico: z.coerce.boolean().optional()
}).partial();

function buildWhere(filters) {
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.tipo) {
    where.tipo = filters.tipo;
  }

  if (typeof filters.activo === 'boolean') {
    where.activo = filters.activo;
  }

  if (filters.search) {
    const searchValue = filters.search;
    where.OR = [
      { nombre: { contains: searchValue, mode: 'insensitive' } },
      { sku: { contains: searchValue, mode: 'insensitive' } },
      { codigo_dji: { contains: searchValue, mode: 'insensitive' } },
      { codigo_barra: { contains: searchValue, mode: 'insensitive' } }
    ];
  }

  return where;
}

function handlePrismaError(err, res, fallbackMessage) {
  if (err?.code === 'P2002') {
    const field = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
    return res.status(409).json({ error: `El valor ya existe para ${field || 'el campo único'}` });
  }

  if (err?.code === 'P2025') {
    return res.status(404).json({ error: 'Recurso no encontrado' });
  }

  if (typeof err?.message === 'string' && err.message.includes('numeric field overflow')) {
    return res.status(400).json({ error: 'El monto excede el máximo permitido (9.999.999.999,99).' });
  }

  console.error(err);
  return res.status(500).json({ error: fallbackMessage });
}

class ProductoValidationError extends Error {}

function isStockBajo(producto) {
  if (!producto) return false;
  const actual = producto.stock_actual;
  const minimo = producto.minimo_stock;
  if (actual === null || actual === undefined) return false;
  if (minimo === null || minimo === undefined) return false;
  const actualNum = Number(actual);
  const minimoNum = Number(minimo);
  if (!Number.isFinite(actualNum) || !Number.isFinite(minimoNum)) return false;
  return actualNum <= minimoNum;
}

function decorateProducto(producto) {
  if (!producto) return producto;
  return {
    ...producto,
    stock_bajo: isStockBajo(producto)
  };
}

function parseSkuSuffix(prefix, skuValue) {
  if (!skuValue || !prefix) return null;
  const regex = new RegExp(`^${prefix}-([0-9]+)$`, 'i');
  const match = skuValue.match(regex);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) ? num : null;
}

async function computeNextSku(tipoProducto) {
  const prefix = SKU_PREFIX_BY_TIPO[tipoProducto] || 'PROD';

  const candidates = await prisma.producto.findMany({
    where: {
      sku: {
        startsWith: `${prefix}-`
      }
    },
    select: { sku: true },
    orderBy: { sku: 'desc' },
    take: 50 // muestra pequeña para encontrar el máximo sufijo
  });

  let maxSuffix = 0;
  for (const item of candidates) {
    const suffix = parseSkuSuffix(prefix, item.sku);
    if (suffix !== null && suffix > maxSuffix) {
      maxSuffix = suffix;
    }
  }

  const nextSuffix = String(maxSuffix + 1).padStart(3, '0');
  return `${prefix}-${nextSuffix}`;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function normalizeCurrency(value, defaultValue = 'PYG') {
  if (!value) return defaultValue;
  return String(value).trim().toUpperCase();
}

function ensureWithinLimit(valor, etiqueta) {
  if (valor === undefined || valor === null) return;
  if (Math.abs(Number(valor)) >= MAX_DECIMAL_VALUE) {
    throw new ProductoValidationError(`${etiqueta} excede el máximo permitido (9.999.999.999,99).`);
  }
}

function normalizePrecioFields(data, { partial = false } = {}) {
  const normalized = { ...data };

  const processPrecio = (campoPrecio, campoMoneda, campoOriginal, campoCambio, descripcionCampo) => {
    const tienePrecio = normalized[campoPrecio] !== undefined;
    const monedaEnviada = normalized[campoMoneda];
    const tipoCambioEnviado = normalized[campoCambio];
    const valorOriginalEnviado = normalized[campoOriginal];
    const etiqueta = descripcionCampo || 'El monto';

    if (!tienePrecio) {
      if (partial && (monedaEnviada !== undefined || tipoCambioEnviado !== undefined || valorOriginalEnviado !== undefined)) {
        throw new ProductoValidationError('Debes enviar el monto cuando modificas la moneda o el tipo de cambio.');
      }
      delete normalized[campoMoneda];
      delete normalized[campoOriginal];
      delete normalized[campoCambio];
      return;
    }

    const montoIngresado = normalized[campoPrecio];
    if (!Number.isFinite(montoIngresado) || montoIngresado < 0) {
      throw new ProductoValidationError('El monto debe ser un número positivo.');
    }
    ensureWithinLimit(montoIngresado, etiqueta);

    const moneda = normalizeCurrency(monedaEnviada);
    if (!MONEDAS_PERMITIDAS.has(moneda)) {
      throw new ProductoValidationError('Moneda no soportada (usa PYG o USD).');
    }
    normalized[campoMoneda] = moneda;

    if (moneda === 'PYG') {
      const montoRedondeado = round(montoIngresado, 2);
      ensureWithinLimit(montoRedondeado, etiqueta);
      normalized[campoPrecio] = montoRedondeado;
      normalized[campoOriginal] = null;
      normalized[campoCambio] = null;
      return;
    }

    const tipoCambio = Number(tipoCambioEnviado);
    if (!Number.isFinite(tipoCambio) || tipoCambio <= 0) {
      throw new ProductoValidationError('Ingresá un tipo de cambio válido para USD.');
    }

    const montoOriginal = round(montoIngresado, 2);
    const tipoCambioRedondeado = round(tipoCambio, 4);
    ensureWithinLimit(montoOriginal, `${etiqueta} (USD)`);

    const montoConvertido = round(montoOriginal * tipoCambioRedondeado, 2);
    ensureWithinLimit(montoConvertido, etiqueta);

    normalized[campoOriginal] = montoOriginal;
    normalized[campoCambio] = tipoCambioRedondeado;
    normalized[campoPrecio] = montoConvertido;
  };

  processPrecio('precio_venta', 'moneda_precio_venta', 'precio_venta_original', 'tipo_cambio_precio_venta', 'El precio de venta');
  processPrecio('precio_compra', 'moneda_precio_compra', 'precio_compra_original', 'tipo_cambio_precio_compra', 'El precio de compra');

  return normalized;
}

// Listar productos con filtros y paginación
router.get('/', async (req, res) => {
  const parseResult = listQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parseResult.error.flatten() });
  }

  const { page = 1, pageSize = 20, critico, ...filters } = parseResult.data;
  const where = buildWhere(filters);
  const offset = (page - 1) * pageSize;

  try {
    if (critico) {
      const productos = await prisma.producto.findMany({ where, orderBy: { created_at: 'desc' } });
      const conStock = await decorateProductosWithSucursalStock(prisma, productos, req.sucursalId);
      const serializados = serialize(conStock).map(decorateProducto);
      const criticos = serializados.filter((item) => item.stock_bajo);
      const paginated = criticos.slice(offset, offset + pageSize);
      const total = criticos.length;
      return res.json({
        data: paginated,
        meta: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize))
        }
      });
    }

    const [productos, total] = await Promise.all([
      prisma.producto.findMany({ where, skip: offset, take: pageSize, orderBy: { created_at: 'desc' } }),
      prisma.producto.count({ where })
    ]);

    const conStock = await decorateProductosWithSucursalStock(prisma, productos, req.sucursalId);
    const data = serialize(conStock).map(decorateProducto);

    res.json({
      data,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al listar productos' });
  }
});

router.get('/next-sku', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  const parsed = z.object({ tipo: z.nativeEnum(TipoProducto) }).safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Tipo de producto inválido' });
  }

  try {
    const sku = await computeNextSku(parsed.data.tipo);
    res.json({ sku });
  } catch (error) {
    console.error('[productos] next-sku', error);
    res.status(500).json({ error: 'No se pudo sugerir un SKU.' });
  }
});

router.get('/reporte/inventario', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  const includeDeleted = String(req.query.include_deleted).toLowerCase() === 'true';

  try {
    const productos = await prisma.producto.findMany({
      where: includeDeleted ? {} : { deleted_at: null },
      orderBy: { nombre: 'asc' }
    });

    const conStock = await decorateProductosWithSucursalStock(prisma, productos, req.sucursalId);
    const data = sortForInventoryReport(serialize(conStock).map(decorateProducto));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="reporte-inventario.pdf"');

    const doc = new PDFDocument({ size: 'A4', margin: 32, layout: 'landscape' });
    doc.pipe(res);
    renderInventoryReport(doc, data);
    doc.end();
  } catch (error) {
    console.error('[productos] reporte inventario', error);
    res.status(500).json({ error: 'No se pudo generar el reporte de inventario.' });
  }
});

router.get('/reporte/inventario.xlsx', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  const includeDeleted = String(req.query.include_deleted).toLowerCase() === 'true';

  try {
    const productos = await prisma.producto.findMany({
      where: includeDeleted ? {} : { deleted_at: null },
      orderBy: { nombre: 'asc' }
    });

    const conStock = await decorateProductosWithSucursalStock(prisma, productos, req.sucursalId);
    const data = sortForInventoryReport(serialize(conStock).map(decorateProducto));
    const rows = data.map((p) => ({
      SKU: p.sku || '',
      'Codigo DJI': p.codigo_dji || '',
      Nombre: p.nombre || '',
      Descripcion: p.descripcion || '',
      Tipo: p.tipo || '',
      'Stock actual': Number(p.stock_actual ?? 0),
      'Stock mínimo': Number(p.minimo_stock ?? 0),
      'Precio venta (Gs)': Number(p.precio_venta ?? 0),
      'Precio compra (Gs)': p.precio_compra != null ? Number(p.precio_compra) : null,
      Estado: p.deleted_at ? 'Eliminado' : p.activo === false ? 'Inactivo' : 'Activo'
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventario');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="reporte-inventario.xlsx"');
    res.send(buffer);
  } catch (error) {
    console.error('[productos] reporte inventario xlsx', error);
    res.status(500).json({ error: 'No se pudo generar el Excel de inventario.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const producto = await prisma.producto.findUnique({ where: { id } });
    if (!producto || producto.deleted_at) return res.status(404).json({ error: 'Producto no encontrado' });
    const conStock = decorateProductoWithSucursalStock(producto, req.sucursalId, await getProductoStockMap(prisma, [producto.id], req.sucursalId));
    res.json(decorateProducto(serialize(conStock)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

router.post('/', authorizeRoles('ADMIN', 'VENDEDOR'), validate(createProductoSchema), async (req, res) => {
  try {
    const data = normalizePrecioFields(req.validatedBody);
    const stockInicial = toStockNumber(data.stock_actual);
    const created = await prisma.$transaction(async (tx) => {
      const producto = await tx.producto.create({
        data: { ...data, stock_actual: stockInicial, sucursalId: null }
      });
      await tx.productoStock.create({
        data: {
          productoId: producto.id,
          sucursalId: req.sucursalId,
          stock_actual: stockInicial
        }
      });
      return producto;
    });
    const conStock = decorateProductoWithSucursalStock(created, req.sucursalId, await getProductoStockMap(prisma, [created.id], req.sucursalId));
    res.status(201).json(decorateProducto(serialize(conStock)));
  } catch (err) {
    if (err instanceof ProductoValidationError) {
      return res.status(400).json({ error: err.message });
    }
    handlePrismaError(err, res, 'Error al crear producto');
  }
});

router.put('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), validate(updateProductoSchema), async (req, res) => {
  try {
    const { id } = req.params;
    const data = normalizePrecioFields(req.validatedBody, { partial: true });
    // No permitir actualizar el id
    delete data.id;
    const stockActualInput = data.stock_actual;
    delete data.stock_actual;
    const existing = await prisma.producto.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const productoActualizado = await tx.producto.update({ where: { id }, data });
      if (stockActualInput !== undefined) {
        const stockRow = await ensureProductoStockRow(tx, existing, req.sucursalId);
        const stockAnterior = toStockNumber(stockRow.stock_actual);
        const stockNuevo = toStockNumber(stockActualInput);
        const delta = stockNuevo - stockAnterior;
        if (delta !== 0) {
          await applyProductoStockDelta(tx, existing, req.sucursalId, delta);
        }
      }
      return tx.producto.findUnique({ where: { id } });
    });
    const conStock = decorateProductoWithSucursalStock(updated, req.sucursalId, await getProductoStockMap(prisma, [updated.id], req.sucursalId));
    res.json(decorateProducto(serialize(conStock)));
  } catch (err) {
    if (err instanceof ProductoValidationError) {
      return res.status(400).json({ error: err.message });
    }
    handlePrismaError(err, res, 'Error al actualizar producto');
  }
});

router.post('/:id/imagen', authorizeRoles('ADMIN', 'VENDEDOR'), upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const producto = await prisma.producto.findUnique({ where: { id } });
    if (!producto || producto.deleted_at) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ninguna imagen.' });
    }

    // Eliminar imagen previa si existía
    if (producto.imagen_url) {
      const prevPath = path.join(__dirname, '..', '..', producto.imagen_url.replace(/^\//, ''));
      if (fs.existsSync(prevPath)) {
        try {
          fs.unlinkSync(prevPath);
        } catch (unlinkErr) {
          console.warn('[productos] No se pudo eliminar la imagen previa', unlinkErr);
        }
      }
    }

    const relativePath = `/storage/productos/${req.file.filename}`;
    const updated = await prisma.producto.update({ where: { id }, data: { imagen_url: relativePath } });
    res.json({ imagen_url: relativePath, producto: decorateProducto(serialize(updated)) });
  } catch (error) {
    console.error('[productos] upload imagen', error);
    res.status(500).json({ error: 'No se pudo guardar la imagen.' });
  }
});

// Soft-delete: marcar deleted_at
router.delete('/:id', authorizeRoles('ADMIN', 'VENDEDOR'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.producto.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const deleted = await prisma.producto.update({ where: { id }, data: { deleted_at: new Date() } });
  res.json({ ok: true, producto: decorateProducto(serialize(deleted)) });
  } catch (err) {
    handlePrismaError(err, res, 'Error al eliminar producto');
  }
});

const currencyFormatter = new Intl.NumberFormat('es-PY', { style: 'currency', currency: 'PYG' });
const numberFormatter = new Intl.NumberFormat('es-PY');

function formatCurrencyPyG(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return currencyFormatter.format(numeric);
}

function formatCurrencyCompactPyG(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  const compact = new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: 'PYG',
    notation: 'compact',
    maximumFractionDigits: 1
  });
  return compact.format(numeric);
}

function formatNumberValue(value) {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numberFormatter.format(numeric);
}

function formatDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function stockDelta(producto) {
  if (producto == null) return Number.POSITIVE_INFINITY;
  if (producto.minimo_stock === undefined || producto.minimo_stock === null) {
    return Number.POSITIVE_INFINITY;
  }
  const actual = Number(producto.stock_actual ?? 0);
  const minimo = Number(producto.minimo_stock ?? 0);
  return actual - minimo;
}

function sortForInventoryReport(productos) {
  return [...productos].sort((a, b) => {
    if (a.stock_bajo && !b.stock_bajo) return -1;
    if (!a.stock_bajo && b.stock_bajo) return 1;
    const deltaA = stockDelta(a);
    const deltaB = stockDelta(b);
    if (deltaA !== deltaB) return deltaA - deltaB;
    const nombreA = (a.nombre || '').toUpperCase();
    const nombreB = (b.nombre || '').toUpperCase();
    return nombreA.localeCompare(nombreB, 'es');
  });
}

function renderInventoryReport(doc, productos) {
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const generatedAt = new Date();
  const metrics = computeInventoryMetrics(productos);

  renderInventoryHeader(doc, startX, usableWidth, generatedAt);

  doc.moveDown(1.2);
  const summary = [
    { label: 'Productos totales', value: metrics.totalProductos },
    { label: 'Con stock bajo', value: metrics.stockBajo },
    { label: 'Inactivos o eliminados', value: metrics.inactivos },
    {
      label: 'Valor inventario venta',
      value: formatCurrencyPyG(metrics.valorInventarioVenta),
      display: formatCurrencyCompactPyG(metrics.valorInventarioVenta),
      full: formatCurrencyPyG(metrics.valorInventarioVenta)
    },
    {
      label: 'Valor inventario compra',
      value: formatCurrencyPyG(metrics.valorInventarioCompra),
      display: formatCurrencyCompactPyG(metrics.valorInventarioCompra),
      full: formatCurrencyPyG(metrics.valorInventarioCompra)
    }
  ];
  drawSummaryChips(doc, summary, startX, usableWidth);
  doc.moveDown(0.6);

  drawInventoryTable(doc, productos, startX, usableWidth);

  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#94a3b8')
    .text('Documento generado automáticamente por TRIDENT INNOVA E.A.S.', startX, doc.y, {
      width: usableWidth,
      align: 'center'
    });
}

function renderInventoryHeader(doc, startX, usableWidth, generatedAt) {
  const headerHeight = 92;
  const bgY = doc.page.margins.top;
  const padding = 16;
  const accentColor = '#f97316';

  doc.save();
  doc.roundedRect(startX, bgY, usableWidth, headerHeight, 14).fill('#0f172a');
  doc.restore();

  const logoSize = 64;
  let cursorX = startX + padding;
  let contentWidth = usableWidth - padding * 2;

  const hasLogo = fs.existsSync(REPORT_LOGO_PATH);
  if (hasLogo) {
    try {
      doc.image(REPORT_LOGO_PATH, cursorX, bgY + 12, { fit: [logoSize, logoSize], align: 'left' });
      cursorX += logoSize + 12;
      contentWidth -= logoSize + 12;
    } catch (logoError) {
      console.warn('[Reportes] No se pudo incrustar el logo.', logoError);
    }
  }

  const textWidth = contentWidth * 0.7;
  const rightWidth = contentWidth - textWidth;
  const baseY = bgY + padding;

  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(accentColor)
    .text('Reporte de inventario', cursorX, baseY, { width: textWidth, align: 'left' });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#e2e8f0')
    .text('TRIDENT INNOVA E.A.S · RUC 80132959-0', cursorX, doc.y + 6, {
      width: textWidth,
      align: 'left'
    });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#e2e8f0')
    .text(`Generado: ${formatDateTime(generatedAt)}`, cursorX + textWidth, baseY + 2, {
      width: rightWidth,
      align: 'right'
    });

  doc.y = bgY + headerHeight + 12;
}

function computeInventoryMetrics(productos) {
  let valorInventarioVenta = 0;
  let valorInventarioCompra = 0;
  let stockBajo = 0;
  let inactivos = 0;

  productos.forEach((p) => {
    const stock = Number(p.stock_actual ?? 0);
    const precioVenta = Number(p.precio_venta ?? 0);
    const precioCompra = Number(p.precio_compra ?? 0);
    if (Number.isFinite(stock) && stock > 0 && Number.isFinite(precioVenta)) {
      valorInventarioVenta += stock * precioVenta;
    }
    if (Number.isFinite(stock) && stock > 0 && Number.isFinite(precioCompra)) {
      valorInventarioCompra += stock * precioCompra;
    }
    if (p.stock_bajo) stockBajo += 1;
    if (p.deleted_at || p.activo === false) inactivos += 1;
  });

  return {
    totalProductos: productos.length,
    stockBajo,
    inactivos,
    valorInventarioVenta,
    valorInventarioCompra
  };
}

function drawSummaryChips(doc, items, startX, usableWidth) {
  if (!items.length) return;
  const gap = 12;
  const chipWidth = (usableWidth - gap * (items.length - 1)) / items.length;
  const chipHeight = 72;
  const baseY = doc.y;

  items.forEach((item, index) => {
    const x = startX + index * (chipWidth + gap);
    doc.save();
    doc.roundedRect(x, baseY, chipWidth, chipHeight, 10).fill('#fff7ed');
    doc.restore();
    const textWidth = chipWidth - 24;
    const labelY = baseY + 10;
    doc.font('Helvetica').fontSize(9).fillColor('#ea580c');
    const labelHeight = doc.heightOfString(item.label, { width: textWidth, align: 'left' });
    doc.text(item.label, x + 12, labelY, { width: textWidth });

    const valueY = labelY + labelHeight + 6;
    const valueText = String(item.display ?? item.value ?? '—');
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#0f172a')
      .text(valueText, x + 12, valueY, {
        width: textWidth,
        align: 'left',
        lineBreak: false
      });

    if (item.full && item.display && item.full !== item.display) {
      const valueHeight = doc.heightOfString(valueText, { width: textWidth, align: 'left' });
      const fullY = valueY + valueHeight + 2;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#475569')
        .text(`(${item.full})`, x + 12, fullY, {
          width: textWidth,
          align: 'left',
          lineBreak: false
        });
    }
  });

  doc.y = baseY + chipHeight + 8;
}

function drawInventoryTable(doc, productos, startX, usableWidth) {
  const columns = buildInventoryColumns(usableWidth);
  const rows = productos.map((producto, index) => buildInventoryRow(producto, index));

  const headerHeight = 24;
  const maxY = () => doc.page.height - doc.page.margins.bottom;

  const drawHeader = () => {
    const headerY = doc.y;
    doc.save();
    doc.rect(startX, doc.y, usableWidth, headerHeight).fill('#0f172a');
    let cursorX = startX;
    columns.forEach((col, columnIndex) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#ffffff')
        .text(col.label, cursorX + 6, headerY + 6, { width: col.width - 12, align: col.align || 'left' });
      doc.y = headerY;
      cursorX += col.width;
      if (columnIndex < columns.length - 1) {
        doc
          .moveTo(cursorX, doc.y)
          .lineTo(cursorX, doc.y + headerHeight)
          .stroke('#1e293b');
      }
    });
    doc.restore();
    doc.y += headerHeight;
  };

  drawHeader();
  rows.forEach((row, idx) => {
    const rowHeight = measureRowHeight(doc, row, columns);
    if (doc.y + rowHeight > maxY()) {
      doc.addPage();
      drawHeader();
    }

    const fillColor = row.stock_bajo ? '#fff7ed' : idx % 2 === 0 ? '#f8fafc' : '#ffffff';
    const rowY = doc.y;
    doc.save();
    doc.rect(startX, doc.y, usableWidth, rowHeight).fill(fillColor);
    doc.restore();
    doc.rect(startX, doc.y, usableWidth, rowHeight).stroke('#e2e8f0');

    let cursorX = startX;
    columns.forEach((col, columnIndex) => {
      const value = row[col.key] ?? '—';
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#0f172a')
        .text(value, cursorX + 6, rowY + 6, {
          width: col.width - 12,
          align: col.align || 'left'
        });
      doc.y = rowY;
      cursorX += col.width;
      if (columnIndex < columns.length - 1) {
        doc
          .moveTo(cursorX, doc.y)
          .lineTo(cursorX, doc.y + rowHeight)
          .stroke('#e2e8f0');
      }
    });

    doc.y = rowY + rowHeight;
  });
}

function buildInventoryColumns(usableWidth) {
  const definitions = [
    { key: 'sku', label: 'SKU', ratio: 0.09, align: 'left' },
    { key: 'codigo_dji', label: 'Código DJI', ratio: 0.11, align: 'left' },
    { key: 'nombre', label: 'Nombre', ratio: 0.16, align: 'left' },
    { key: 'descripcion', label: 'Descripción', ratio: 0.18, align: 'left' },
    { key: 'tipo', label: 'Tipo', ratio: 0.07, align: 'left' },
    { key: 'stockResumen', label: 'Stock (act/min)', ratio: 0.11, align: 'center' },
    { key: 'precioVenta', label: 'Precio venta', ratio: 0.11, align: 'right' },
    { key: 'precioCompra', label: 'Precio compra', ratio: 0.09, align: 'right' },
    { key: 'estado', label: 'Estado', ratio: 0.08, align: 'center' }
  ];

  return definitions.map((column) => ({
    ...column,
    width: usableWidth * column.ratio
  }));
}

function buildInventoryRow(producto, index) {
  const estado = producto.deleted_at
    ? 'Eliminado'
    : producto.activo === false
      ? 'Inactivo'
      : 'Activo';

  return {
    sku: producto.sku || '—',
    codigo_dji: producto.codigo_dji || '—',
    nombre: producto.nombre || '—',
    descripcion: producto.descripcion || '—',
    tipo: producto.tipo || '—',
    stockResumen: `${formatNumberValue(producto.stock_actual)} / ${formatNumberValue(producto.minimo_stock)}`,
    precioVenta: formatCurrencyPyG(producto.precio_venta),
    precioCompra: producto.precio_compra != null ? formatCurrencyPyG(producto.precio_compra) : '—',
    estado,
    stock_bajo: Boolean(producto.stock_bajo)
  };
}

function measureRowHeight(doc, row, columns) {
  let height = 20;
  doc.font('Helvetica').fontSize(9);
  columns.forEach((col) => {
    const value = row[col.key] ?? '—';
    const textHeight = doc.heightOfString(value, {
      width: Math.max(col.width - 12, 20),
      align: col.align || 'left'
    });
    height = Math.max(height, textHeight + 12);
  });
  return height;
}

module.exports = router;
