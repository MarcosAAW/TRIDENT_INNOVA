
// ...existing code...







// ...existing code...


// ...existing code...

// Mover todos los imports y la inicialización de router al principio del archivo
const express = require('express');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const XLSX = require('xlsx');
const router = express.Router();
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { procesarFacturaElectronica } = require('../services/sifen/facturaProcessor');
const empresaConfig = require('../config/empresa');
const factpyConfig = require('../config/factpy');
const { emitirFactura } = require('../services/factpy/client');
const { FacturaDigitalError, validateTimbradoConfig, buildNumeroFactura } = require('../services/facturaDigital');
const { requireAuth, authorizeRoles } = require('../middleware/authContext');
const { requireSucursal } = require('../middleware/sucursalContext');
const { resolveProductSalePricing, getSaleDetailSnapshot } = require('../utils/productPricing');
const {
  getProductoStockMap,
  resolveProductoStock,
  applyProductoStockDelta
} = require('../utils/productStock');

const MONEDAS_PERMITIDAS = new Set(['PYG', 'USD']);
const SIFEN_ENABLED = !['false', '0', 'off'].includes(String(process.env.SIFEN_ENABLE || 'true').toLowerCase());

function hasSifenCert() {
  const certPath = process.env.SIFEN_CERT_PATH;
  if (!certPath) return false;
  try {
    return fs.existsSync(certPath);
  } catch (_err) {
    return false;
  }
}

const VENTAS_REPORT_INCLUDE = {
  cliente: true,
  usuario: true,
  factura_electronica: {
    select: {
      id: true,
      nro_factura: true
    }
  },
  notas_credito: {
    where: { deleted_at: null },
    select: {
      id: true,
      nro_nota: true,
      pdf_path: true,
      estado: true,
      fecha_emision: true
    }
  },
  detalles: {
    include: {
      producto: true
    }
  }
};

const TICKET_PDF_INCLUDE = {
  cliente: true,
  usuario: true,
  sucursal: true,
  detalles: {
    include: {
      producto: true
    }
  }
};

const detalleSchema = z.object({
  productoId: z.string().uuid(),
  cantidad: z.coerce.number().int().min(1),
  precio_unitario: z.coerce.number().optional(),
  subtotal: z.coerce.number().optional()
});

const ivaSchema = z
  .union([z.literal(0), z.literal(5), z.literal(10), z.literal('0'), z.literal('5'), z.literal('10')])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null) return undefined;
    return Number(value);
  });

const monedaFilterSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toUpperCase())
  .refine((value) => MONEDAS_PERMITIDAS.has(value), { message: 'Moneda no soportada (usa PYG o USD).' })
  .optional();

const creditoCuotaSchema = z.object({
  numero: z.coerce.number().int().min(1),
  monto: z.coerce.number().positive(),
  fecha_vencimiento: z.union([z.coerce.date(), z.string().trim().min(1)])
});

// Mover todos los imports y la inicialización de router al principio del archivo
// Endpoint para servir el PDF del ticket de venta contado (hoja completa)
// (Colocado después de la inicialización de router)

const creditoConfigSchema = z.object({
  tipo: z.enum(['PLAZO', 'CUOTAS']).default('PLAZO'),
  descripcion: z.string().trim().min(1).max(10).optional(),
  entrega_inicial: z.coerce.number().min(0).optional(),
  metodo_entrega: z.string().trim().min(1).max(30).optional(),
  cantidad_cuotas: z.coerce.number().int().min(1).optional(),
  cuotas: z.array(creditoCuotaSchema).min(1).optional(),
  fecha_vencimiento: z.coerce.date().optional()
});

const notaCreditoDetalleSchema = z.object({
  detalleVentaId: z.string().uuid(),
  cantidad: z.coerce.number().int().min(1)
});

const createNotaCreditoSchema = z
  .object({
    motivo: z.string().trim().min(5).max(200),
    tipo_ajuste: z.enum(['TOTAL', 'PARCIAL']).optional(),
    detalles: z.array(notaCreditoDetalleSchema).optional()
  })
  .transform((value) => {
    const detalles = Array.isArray(value.detalles) ? value.detalles : [];
    return {
      ...value,
      detalles,
      tipo_ajuste: value.tipo_ajuste || (detalles.length ? 'PARCIAL' : 'TOTAL')
    };
  })
  .superRefine((value, ctx) => {
    if (value.tipo_ajuste === 'PARCIAL' && (!Array.isArray(value.detalles) || !value.detalles.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Debes indicar al menos un ítem para la nota de crédito parcial.',
        path: ['detalles']
      });
    }
  });

const facturarRequestSchema = z
  .object({
    condicion_pago: z.string().trim().optional(),
    fecha_vencimiento: z.coerce.date().optional(),
    credito: creditoConfigSchema.optional()
  })
  .optional()
  .transform((value) => value || {});

const createVentaSchema = z.object({
  usuarioId: z.string().uuid(),
  clienteId: z.string().uuid().optional(),
  detalles: z.array(detalleSchema).min(1),
  descuento_total: z.coerce.number().min(0).optional(),
  estado: z.string().optional(),
  motivo: z.string().optional(),
  almacenId: z.string().uuid().optional(),
  iva_porcentaje: ivaSchema,
  condicion_venta: z.string().trim().optional(),
  moneda: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => MONEDAS_PERMITIDAS.has(value), {
      message: 'Moneda no soportada (usa PYG o USD).'
    })
    .optional(),
  tipo_cambio: z
    .coerce.number({ invalid_type_error: 'El tipo de cambio debe ser numérico.' })
    .positive('El tipo de cambio debe ser mayor a cero.')
    .max(20000, 'El tipo de cambio es demasiado alto.')
    .optional(),
  fecha_vencimiento: z.coerce.date().optional(),
  credito: creditoConfigSchema.optional()
});

class VentaValidationError extends Error {}

function normalizeMetodoEntrega(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toUpperCase();
  return normalized || undefined;
}

function getVentaTotalCreditoMoneda(moneda, totalGs, totalMoneda) {
  if (String(moneda || 'PYG').toUpperCase() === 'USD') {
    return round(Number(totalMoneda) || 0, 2);
  }
  return round(Number(totalGs) || 0, 2);
}

function normalizeCreditoConfigForVenta(creditoConfig, {
  moneda,
  tipoCambio,
  totalGs,
  totalMoneda,
  fechaVencimientoDefault
} = {}) {
  if (!creditoConfig) return null;

  const monedaVenta = String(moneda || 'PYG').toUpperCase();
  const totalVentaGs = round(Number(totalGs) || 0, 2);
  const totalVentaMoneda = getVentaTotalCreditoMoneda(monedaVenta, totalVentaGs, totalMoneda);
  const tipo = creditoConfig?.tipo === 'CUOTAS' ? 'CUOTAS' : 'PLAZO';
  const entregaInicial = round(Number(creditoConfig?.entrega_inicial) || 0, 2);

  if (entregaInicial < 0) {
    throw new VentaValidationError('La entrega inicial no puede ser negativa.');
  }

  if (entregaInicial >= totalVentaMoneda && totalVentaMoneda > 0) {
    throw new VentaValidationError('La entrega inicial debe ser menor al total para ventas a crédito.');
  }

  const cambio = Number(tipoCambio) || 0;
  if (monedaVenta === 'USD' && entregaInicial > 0 && (!Number.isFinite(cambio) || cambio <= 0)) {
    throw new VentaValidationError('La venta en USD requiere tipo de cambio válido para registrar la entrega inicial.');
  }

  const entregaInicialGs = monedaVenta === 'USD'
    ? round(entregaInicial * cambio, 2)
    : entregaInicial;
  const saldoFinanciadoMoneda = round(Math.max(totalVentaMoneda - entregaInicial, 0), 2);
  const saldoFinanciadoGs = round(Math.max(totalVentaGs - entregaInicialGs, 0), 2);

  const normalizedBase = {
    tipo,
    saldo_financiado: saldoFinanciadoMoneda,
    saldo_financiado_gs: saldoFinanciadoGs
  };

  if (entregaInicial > 0) {
    normalizedBase.entrega_inicial = entregaInicial;
    normalizedBase.entrega_inicial_gs = entregaInicialGs;
  }

  const metodoEntrega = normalizeMetodoEntrega(creditoConfig?.metodo_entrega);
  if (metodoEntrega) {
    normalizedBase.metodo_entrega = metodoEntrega;
  }

  if (tipo === 'CUOTAS') {
    const cuotas = normalizeCuotas(creditoConfig?.cuotas);
    if (!cuotas.length) {
      throw new VentaValidationError('Debes indicar al menos una cuota para ventas a crédito.');
    }
    const totalCuotas = round(cuotas.reduce((acc, cuota) => acc + Number(cuota.monto || 0), 0), 2);
    if (Math.abs(totalCuotas - saldoFinanciadoMoneda) > 0.01) {
      throw new VentaValidationError('La suma de cuotas debe igualar el saldo financiado.');
    }
    return {
      ...normalizedBase,
      cantidad_cuotas: Math.max(1, Number(creditoConfig?.cantidad_cuotas) || cuotas.length || 1),
      cuotas
    };
  }

  const descripcion = creditoConfig?.descripcion && String(creditoConfig.descripcion).trim()
    ? String(creditoConfig.descripcion).trim().slice(0, 10)
    : undefined;
  if (descripcion) {
    normalizedBase.descripcion = descripcion;
  }

  const fechaVencimiento = creditoConfig?.fecha_vencimiento || fechaVencimientoDefault;
  if (fechaVencimiento) {
    normalizedBase.fecha_vencimiento = new Date(fechaVencimiento);
  }

  return normalizedBase;
}

function buildVentaCreditoState({
  condicionVenta,
  creditoInput,
  fechaVencimiento,
  moneda,
  tipoCambio,
  totalGs,
  totalMoneda
}) {
  const esCredito = condicionVenta === 'CREDITO';
  if (!esCredito) {
    return {
      esCredito: false,
      fechaVencimiento: null,
      saldoPendiente: null,
      creditoConfig: null
    };
  }

  const creditoBase = creditoInput || { tipo: 'PLAZO' };
  const creditoConfig = normalizeCreditoConfigForVenta(creditoBase, {
    moneda,
    tipoCambio,
    totalGs,
    totalMoneda,
    fechaVencimientoDefault: fechaVencimiento || creditoBase?.fecha_vencimiento || null
  });

  return {
    esCredito: true,
    fechaVencimiento: creditoConfig?.fecha_vencimiento || fechaVencimiento || null,
    saldoPendiente: Number(creditoConfig?.saldo_financiado_gs ?? totalGs ?? 0),
    creditoConfig
  };
}

function creditoConfigComparable(value) {
  return JSON.stringify(serialize(value || null));
}

const MAX_DECIMAL_VALUE = 10_000_000_000;
const IVA_DIVISOR = {
  0: null,
  5: 21,
  10: 11
};

const MAX_FACTURA_REINTENTOS = 5;
const MAX_NOTA_CREDITO_REINTENTOS = 5;

function numberToWordsEs(num) {
  const units = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
  const teens = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve'];
  const tens = ['', '', 'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  const hundreds = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  const toWordsBelowThousand = (n) => {
    if (n === 0) return '';
    if (n < 10) return units[n];
    if (n < 20) return teens[n - 10];
    if (n < 100) {
      const ten = Math.trunc(n / 10);
      const unit = n % 10;
      if (n === 20) return 'veinte';
      const suffix = unit ? ` y ${units[unit]}` : '';
      return `${tens[ten]}${suffix}`;
    }
    if (n === 100) return 'cien';
    const hundred = Math.trunc(n / 100);
    const remainder = n % 100;
    const rest = remainder ? ` ${toWordsBelowThousand(remainder)}` : '';
    return `${hundreds[hundred]}${rest}`;
  };

  const toWords = (n) => {
    if (n === 0) return 'cero';
    let result = '';
    const billions = Math.trunc(n / 1_000_000_000);
    const millions = Math.trunc((n % 1_000_000_000) / 1_000_000);
    const thousands = Math.trunc((n % 1_000_000) / 1000);
    const remainder = n % 1000;

    if (billions) {
      result += `${toWords(billions)} mil millones`;
    }
    if (millions) {
      result += `${result ? ' ' : ''}${millions === 1 ? 'un millon' : `${toWords(millions)} millones`}`;
    }
    if (thousands) {
      result += `${result ? ' ' : ''}${thousands === 1 ? 'mil' : `${toWordsBelowThousand(thousands)} mil`}`;
    }
    if (remainder) {
      result += `${result ? ' ' : ''}${toWordsBelowThousand(remainder)}`;
    }
    return result.trim();
  };

  return toWords(Math.trunc(Math.abs(num)));
}

function montoEnLetras(total, moneda) {
  const safeMonto = Number.isFinite(Number(total)) ? Math.abs(Number(total)) : 0;
  const entero = Math.trunc(safeMonto);
  const centavos = Math.round((safeMonto - entero) * 100);
  const monedaNombre = String(moneda || 'PYG').toUpperCase() === 'USD' ? 'dolares' : 'guaranies';
  const textoNumero = numberToWordsEs(entero);
  const textoCentavos = centavos.toString().padStart(2, '0');
  return `${textoNumero} ${monedaNombre} con ${textoCentavos}/100`;
}

function isUniqueNroFacturaError(error) {
  return (
    error?.code === 'P2002' &&
    Array.isArray(error?.meta?.target) &&
    error.meta.target.some((target) => typeof target === 'string' && target.includes('nro_factura'))
  );
}

function isUniqueNroNotaError(error) {
  return (
    error?.code === 'P2002' &&
    Array.isArray(error?.meta?.target) &&
    error.meta.target.some((target) => typeof target === 'string' && target.includes('nro_nota'))
  );
}

const dateParam = z.coerce.date({ invalid_type_error: 'Fecha inválida' });
const monthParam = z
  .string()
  .trim()
  .regex(/^[0-9]{4}-[0-9]{2}$/u, 'Formato de mes inválido (YYYY-MM)');

const listQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  estado: z.string().trim().optional(),
  iva_porcentaje: ivaSchema.optional(),
  fecha_desde: dateParam.optional(),
  fecha_hasta: dateParam.optional(),
  mes: monthParam.optional(),
  moneda: monedaFilterSchema,
  include_deleted: z.coerce.boolean().optional()
});

const ventaIdParams = z.object({
  id: z.string().uuid({ message: 'Identificador inválido' })
});

const cancelVentaSchema = z.object({
  motivo: z.string().trim().min(3).max(200).optional()
});

const EMPRESA_INFO = {
  nombre: empresaConfig?.nombre || 'TRIDENT INNOVA E.A.S',
  ruc: empresaConfig?.ruc || '0000000-0',
  direccion: empresaConfig?.direccion || 'San Ignacio - Misiones',
  telefono: empresaConfig?.telefono || '',
  email: empresaConfig?.email || ''
};

const REPORT_LOGO_PATH = path.join(__dirname, '..', 'public', 'img', 'logotridentgrande.png');

function startOfDay(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function endOfDay(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  date.setUTCHours(23, 59, 59, 999);
  return date;
}

function getMonthRange(month) {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const start = new Date(year, monthIndex, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 1);
  end.setHours(0, 0, 0, 0);
  return { start, end };
}

function buildVentaWhere(filters, sucursalId) {
  const where = {};

  if (!filters.include_deleted) {
    where.deleted_at = null;
  }

  if (filters.estado) {
    where.estado = { contains: filters.estado, mode: 'insensitive' };
  }

  if (filters.moneda) {
    where.moneda = filters.moneda;
  }

  if (filters.iva_porcentaje !== undefined && filters.iva_porcentaje !== null) {
    where.iva_porcentaje = Number(filters.iva_porcentaje);
  }

  const fechaCriteria = {};
  if (filters.mes) {
    const { start, end } = getMonthRange(filters.mes);
    fechaCriteria.gte = start;
    fechaCriteria.lt = end;
  } else {
    if (filters.fecha_desde) {
      fechaCriteria.gte = startOfDay(filters.fecha_desde);
    }
    if (filters.fecha_hasta) {
      fechaCriteria.lte = endOfDay(filters.fecha_hasta);
    }
  }
  if (Object.keys(fechaCriteria).length) {
    where.fecha = fechaCriteria;
  }

  if (filters.search) {
    const term = String(filters.search).trim();
    const isUuidTerm = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(term);
    where.OR = [
      ...(isUuidTerm ? [{ id: term }] : []),
      { estado: { contains: term, mode: 'insensitive' } },
      { cliente: { nombre_razon_social: { contains: term, mode: 'insensitive' } } },
      { cliente: { ruc: { contains: term, mode: 'insensitive' } } },
      { usuario: { nombre: { contains: term, mode: 'insensitive' } } },
      { usuario: { usuario: { contains: term, mode: 'insensitive' } } },
      { factura_electronica: { nro_factura: { contains: term, mode: 'insensitive' } } }
    ];
  }

  if (sucursalId) {
    where.sucursalId = sucursalId;
  }

  return where;
}

function normalizeIvaPorcentaje(value) {
  if (value === undefined || value === null) {
    return 10;
  }
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (parsed === 5) return 5;
  return 10;
}

function normalizeCurrency(value) {
  if (!value) return 'PYG';
  const upper = String(value).trim().toUpperCase();
  if (MONEDAS_PERMITIDAS.has(upper)) {
    return upper;
  }
  return 'PYG';
}

function isEffectiveCreditNote(nota) {
  if (!nota || nota.deleted_at) return false;
  return String(nota.estado || '').toUpperCase() !== 'RECHAZADO';
}

function hasEffectiveTotalCreditNote(venta) {
  const notas = Array.isArray(venta?.notas_credito) ? venta.notas_credito : [];
  return notas.some(
    (nota) => isEffectiveCreditNote(nota) && String(nota.tipo_ajuste || 'TOTAL').toUpperCase() === 'TOTAL'
  );
}

function getOperationalSaldoPendiente(venta) {
  if (hasEffectiveTotalCreditNote(venta)) {
    return 0;
  }
  const esCredito = venta?.es_credito === true || String(venta?.condicion_venta || '').toUpperCase() === 'CREDITO';
  if (!esCredito) {
    return 0;
  }
  return Number(venta?.saldo_pendiente ?? 0);
}

function normalizeCondicionVenta(value, creditoConfig) {
  const normalized = (value || '').toString().toUpperCase();
  if (normalized.includes('CREDITO') || normalized.includes('CRÉDITO')) return 'CREDITO';
  if (creditoConfig) return 'CREDITO';
  return 'CONTADO';
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor + Number.EPSILON) / factor;
}

function parseReciboSeq(numero) {
  if (!numero) return null;
  const digits = String(numero).replace(/\D/g, '');
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

async function buildReciboNumero(tx, sucursalId) {
  const ultimo = await tx.recibo.findFirst({
    where: {
      sucursalId,
      numero: { not: null }
    },
    orderBy: { numero: 'desc' },
    select: { numero: true }
  });
  const lastSeq = parseReciboSeq(ultimo?.numero);
  const next = (lastSeq || 0) + 1;
  return String(next).padStart(10, '0');
}

async function createInitialDeliveryReceipt(tx, {
  venta,
  creditoState,
  moneda,
  tipoCambio,
  usuarioId,
  clienteId,
  sucursalId
}) {
  const entregaMoneda = round(Number(creditoState?.creditoConfig?.entrega_inicial || 0), 4);
  const entregaGs = round(Number(creditoState?.creditoConfig?.entrega_inicial_gs || 0), 2);
  if (!(entregaMoneda > 0) || !(entregaGs > 0)) {
    return null;
  }

  const metodo = String(creditoState?.creditoConfig?.metodo_entrega || 'EFECTIVO').toUpperCase();
  const numero = await buildReciboNumero(tx, sucursalId);

  const recibo = await tx.recibo.create({
    data: {
      numero,
      clienteId: clienteId || null,
      usuarioId,
      sucursalId,
      total: entregaGs,
      total_moneda: entregaMoneda,
      moneda,
      tipo_cambio: moneda === 'USD' ? tipoCambio : null,
      metodo,
      observacion: `Entrega inicial aplicada a venta ${venta.id}`
    }
  });

  await tx.reciboDetalle.create({
    data: {
      reciboId: recibo.id,
      ventaId: venta.id,
      monto: entregaGs,
      monto_moneda: entregaMoneda,
      saldo_previo: round(Number(venta.total || 0), 2),
      saldo_posterior: round(Number(creditoState.saldoPendiente || 0), 2)
    }
  });

  return recibo;
}

function ensureWithinLimit(value, label) {
  if (!Number.isFinite(value)) {
    throw new VentaValidationError(`${label} debe ser un número válido.`);
  }
  if (Math.abs(value) > MAX_DECIMAL_VALUE) {
    throw new VentaValidationError(`${label} supera el máximo permitido.`);
  }
}

router.use(requireAuth, requireSucursal);

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const filters = parsed.data || {};
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: {
        cliente: true,
        usuario: true,
        factura_electronica: true,
        notas_credito: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' }
        },
        detalles: {
          include: {
            producto: true
          }
        }
      },
      orderBy: { fecha: 'desc' }
    });

    const ventaIds = ventas.map((venta) => venta.id).filter(Boolean);
    const recibosPorVentaId = new Map();
    if (ventaIds.length) {
      const recibosRelacionados = await prisma.recibo.findMany({
        where: {
          sucursalId: req.sucursalId,
          aplicaciones: {
            some: {
              ventaId: {
                in: ventaIds
              }
            }
          }
        },
        select: {
          id: true,
          numero: true,
          fecha: true,
          aplicaciones: {
            select: {
              ventaId: true
            }
          }
        },
        orderBy: { fecha: 'desc' }
      });

      recibosRelacionados.forEach((recibo) => {
        const ventaIdsAsociadas = Array.from(
          new Set(
            (Array.isArray(recibo.aplicaciones) ? recibo.aplicaciones : [])
              .map((aplicacion) => aplicacion?.ventaId)
              .filter(Boolean)
          )
        );

        ventaIdsAsociadas.forEach((ventaId) => {
          const existentes = recibosPorVentaId.get(ventaId) || [];
          if (!existentes.some((item) => item.id === recibo.id)) {
            existentes.push({
              id: recibo.id,
              numero: recibo.numero,
              fecha: recibo.fecha
            });
            recibosPorVentaId.set(ventaId, existentes);
          }
        });
      });
    }

    // Agregar campo pdf_url y exponer info de crédito (tipo, cuotas, etc.)
    const data = serialize(ventas).map((venta) => {
      let pdf_url = null;
      let pdf_path = venta.factura_electronica?.pdf_path || null;
      const recibos = recibosPorVentaId.get(venta.id) || [];
      if (venta.factura_electronica && venta.factura_electronica.pdf_path) {
        pdf_url = venta.factura_electronica.pdf_path;
        pdf_path = pdf_url;
      }

      // Extraer info de crédito: preferir el campo persistido en la venta
      let credito = null;
      if (venta.credito_config) {
        credito = venta.credito_config;
      } else if (venta.factura_electronica && venta.factura_electronica.respuesta_set && venta.factura_electronica.respuesta_set.credito) {
        credito = venta.factura_electronica.respuesta_set.credito;
      } else if (venta.credito) {
        credito = venta.credito;
      }
      if (!credito && venta.es_credito && venta.fecha_vencimiento) {
        credito = { tipo: 'PLAZO', fecha_vencimiento: venta.fecha_vencimiento };
      }
      return {
        ...venta,
        pdf_url,
        credito,
        recibos,
        saldo_pendiente: getOperationalSaldoPendiente(venta)
      };
    });
    const resumen = data.reduce(
      (acc, venta) => {
        const estado = (venta.estado || '').toUpperCase();
        const anulada = estado === 'ANULADA' || Boolean(venta.deleted_at);
        if (!anulada) {
          acc.total_pyg += Number(venta.total || 0);
          const currency = (venta.moneda || 'PYG').toUpperCase();
          if (currency === 'USD') {
            const usdAmount = Number(venta.total_moneda || 0);
            if (Number.isFinite(usdAmount)) {
              acc.total_usd += usdAmount;
            }
          }
        }
        return acc;
      },
      { total_pyg: 0, total_usd: 0 }
    );
    res.json({
      data,
      meta: {
        page: 1,
        pageSize: data.length,
        total: data.length,
        totalPages: 1,
        resumen
      },
      ventas: data,
      resumen
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron obtener las ventas.' });
  }
// ...existing code...
});

router.get('/:id/ticket/pdf', async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador inválido', detalles: parsedParams.error.flatten() });
  }

  try {
    const venta = await prisma.venta.findFirst({
      where: {
        id: parsedParams.data.id,
        sucursalId: req.sucursalId
      },
      include: TICKET_PDF_INCLUDE
    });

    if (!venta) {
      return res.status(404).json({ error: 'Venta no encontrada.' });
    }

    const ventaData = serialize(venta);
    if (String(ventaData.estado || '').toUpperCase() !== 'TICKET') {
      return res.status(400).json({ error: 'La venta indicada no corresponde a un ticket.' });
    }

    if (normalizeCurrency(ventaData.moneda) === 'USD' && !(Number(ventaData.tipo_cambio) > 0)) {
      return res.status(400).json({ error: 'El ticket en USD no tiene tipo de cambio válido.' });
    }

    const fileLabel = (ventaData.id || 'ticket').slice(0, 8).toUpperCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ticket-venta-${fileLabel}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    doc.pipe(res);
    renderVentaTicketPdf(doc, ventaData);
    doc.end();
  } catch (error) {
    console.error('[ventas] ticket pdf', error);
    res.status(500).json({ error: 'No se pudo generar el ticket en PDF.' });
  }
});

router.post('/:id/nota-credito', authorizeRoles('ADMIN'), async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador de venta inválido.' });
  }

  const parsedBody = createNotaCreditoSchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Datos inválidos para la nota de crédito.', detalles: parsedBody.error.flatten() });
  }

  const { id } = parsedParams.data;
  const { motivo, tipo_ajuste: tipoAjuste, detalles: detallesSolicitados } = parsedBody.data;

  try {
    const venta = await prisma.venta.findFirst({
      where: { id, sucursalId: req.sucursalId },
      include: {
        cliente: true,
        usuario: true,
        sucursal: true,
        detalles: { include: { producto: true } },
        factura_electronica: true,
        notas_credito: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' }
        }
      }
    });

    if (!venta) {
      return res.status(404).json({ error: 'No se encontró la venta solicitada.' });
    }
    if (venta.deleted_at || String(venta.estado || '').toUpperCase() === 'ANULADA') {
      return res.status(400).json({ error: 'No se puede emitir nota de crédito para una venta anulada.' });
    }
    if (!venta.factura_electronica?.id) {
      return res.status(400).json({ error: 'La venta no tiene factura electrónica asociada.' });
    }
    if (Array.isArray(venta.notas_credito) && venta.notas_credito.length) {
      return res.status(409).json({ error: 'La venta ya tiene una nota de crédito total emitida.' });
    }

    const cdcAsociado = extractFacturaCdc(venta.factura_electronica);
    if (!cdcAsociado) {
      return res.status(412).json({ error: 'La factura asociada no tiene CDC válido para emitir la nota de crédito.' });
    }

    const notaCreditoCalculada = buildNotaCreditoData(venta, {
      tipoAjuste,
      detallesSolicitados
    });

    const now = new Date();
    const timbradoSeleccionado = selectTimbradoParaVenta(venta, empresaConfig);
    let notaBase = null;
    let lastCreateError = null;

    for (let attempt = 0; attempt < MAX_NOTA_CREDITO_REINTENTOS && !notaBase; attempt += 1) {
      try {
        const secuencia = await resolveSecuenciaNotaCredito(prisma, timbradoSeleccionado, req.sucursalId);
        const nroNota = buildNumeroFactura(timbradoSeleccionado, secuencia);

        notaBase = await prisma.notaCreditoElectronica.create({
          data: {
            ventaId: venta.id,
            facturaElectronicaId: venta.factura_electronica.id,
            sucursalId: req.sucursalId,
            nro_nota: nroNota,
            timbrado: timbradoSeleccionado.numero || 'NO_TIMBRADO',
            establecimiento: timbradoSeleccionado.establecimiento || '001',
            punto_expedicion: timbradoSeleccionado.punto_expedicion || timbradoSeleccionado.punto || '001',
            secuencia,
            motivo,
            tipo_ajuste: notaCreditoCalculada.tipoAjuste,
            fecha_emision: now,
            moneda: normalizeCurrency(venta.moneda),
            tipo_cambio: venta.tipo_cambio || null,
            total: -Math.abs(notaCreditoCalculada.totalGs),
            total_moneda: notaCreditoCalculada.totalMoneda != null ? -Math.abs(notaCreditoCalculada.totalMoneda) : null,
            cdc: cdcAsociado,
            qr_data: cdcAsociado,
            estado: 'PENDIENTE',
            intentos: 1,
            ambiente: venta.factura_electronica.ambiente || 'PRUEBA',
            detalles: {
              create: notaCreditoCalculada.detalles.map((detalle) => ({
                detalleVentaId: detalle.detalleVentaId,
                productoId: detalle.productoId,
                descripcion: detalle.descripcion,
                codigo_producto: detalle.codigoProducto,
                cantidad: detalle.cantidad,
                precio_unitario: detalle.precioUnitarioGs,
                subtotal: detalle.subtotalGs,
                iva_porcentaje: detalle.ivaPorcentaje
              }))
            },
            respuesta_set: {
              motivo,
              tipo_ajuste: notaCreditoCalculada.tipoAjuste,
              factura_asociada: venta.factura_electronica.nro_factura,
              cdc_asociado: cdcAsociado,
              timestamp: now.toISOString()
            }
          }
        });
        lastCreateError = null;
      } catch (createError) {
        lastCreateError = createError;
        if (isUniqueNroNotaError(createError) && attempt < MAX_NOTA_CREDITO_REINTENTOS - 1) {
          continue;
        }
        throw createError;
      }
    }

    if (!notaBase) {
      throw lastCreateError || new Error('No se pudo generar la nota de crédito.');
    }

    let notaActualizada = notaBase;
    if (factpyConfig?.recordId) {
      try {
        const payload = buildFactPyCreditNotePayload(venta, venta.factura_electronica, notaBase, {
          motivo,
          cdcAsociado,
          detallesSeleccionados: notaCreditoCalculada.detalles
        });
        const respuestaFactpy = await emitirFactura({
          dataJson: payload,
          recordID: factpyConfig.recordId,
          baseUrl: factpyConfig.baseUrl,
          timeoutMs: factpyConfig.timeoutMs
        });

        notaActualizada = await prisma.notaCreditoElectronica.update({
          where: { id: notaBase.id },
          data: {
            respuesta_set: {
              motivo,
              tipo_ajuste: notaCreditoCalculada.tipoAjuste,
              receiptid: payload.receiptid,
              documentoAsociado: payload.documentoAsociado,
              factpy: respuestaFactpy,
              timestamp: new Date().toISOString()
            },
            cdc: respuestaFactpy?.cdc || notaBase.cdc,
            qr_data: respuestaFactpy?.cdc || notaBase.qr_data,
            xml_path: normalizeFactpyExternalUrl(respuestaFactpy?.xmlLink) || notaBase.xml_path,
            pdf_path: normalizeFactpyExternalUrl(respuestaFactpy?.kude) || notaBase.pdf_path,
            estado: respuestaFactpy?.status === false ? 'RECHAZADO' : 'ENVIADO'
          }
        });
      } catch (factpyError) {
        console.error('[FactPy][NotaCredito] Error al emitir', factpyError);
        notaActualizada = await prisma.notaCreditoElectronica.update({
          where: { id: notaBase.id },
          data: {
            estado: 'RECHAZADO',
            respuesta_set: {
              ...(notaBase.respuesta_set || {}),
              error: factpyError?.body || factpyError?.message || 'Error al emitir la nota de crédito.',
              timestamp: new Date().toISOString()
            }
          }
        });
        return res.status(502).json({
          error: 'No se pudo emitir la nota de crédito en FactPy.',
          nota_credito: serialize(notaActualizada)
        });
      }
    }

    if (String(notaActualizada.estado || '').toUpperCase() !== 'RECHAZADO') {
      const detalleVentaMap = new Map(
        (Array.isArray(venta.detalles) ? venta.detalles : []).map((detalle) => [detalle.id, detalle])
      );

      await prisma.$transaction(async (tx) => {
        for (const detalleNota of notaCreditoCalculada.detalles) {
          if (!detalleNota.productoId || !(Number(detalleNota.cantidad) > 0)) {
            continue;
          }

          const detalleVenta = detalleVentaMap.get(detalleNota.detalleVentaId);
          const producto = detalleVenta?.producto || await tx.producto.findUnique({ where: { id: detalleNota.productoId } });
          if (!producto) {
            continue;
          }

          await applyProductoStockDelta(tx, producto, req.sucursalId, Number(detalleNota.cantidad));
          await tx.movimientoStock.create({
            data: {
              productoId: detalleNota.productoId,
              tipo: 'ENTRADA',
              cantidad: Number(detalleNota.cantidad),
              motivo: `Nota de crédito ${notaActualizada.nro_nota || ''}: ${motivo}`.trim(),
              referencia_id: notaActualizada.id,
              referencia_tipo: 'NotaCreditoElectronica',
              usuario_id: venta.usuarioId
            }
          });
        }

        if (String(notaActualizada.tipo_ajuste || 'TOTAL').toUpperCase() === 'TOTAL') {
          await tx.venta.update({
            where: { id: venta.id },
            data: {
              saldo_pendiente: 0
            }
          });
        }
      });
    }

    return res.status(201).json({
      nota_credito: serialize(notaActualizada),
      pdf_url: notaActualizada.pdf_path || null
    });
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] nota de credito', error);
    return res.status(500).json({ error: 'No se pudo emitir la nota de crédito.' });
  }
});

router.post('/', validate(createVentaSchema), async (req, res) => {
  const payload = req.validatedBody;
  const ivaPorcentaje = normalizeIvaPorcentaje(payload.iva_porcentaje);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const detallesNormalizados = (Array.isArray(payload.detalles) ? payload.detalles : [])
        .map((detalle) => ({
          productoId: detalle.productoId,
          cantidad: Number(detalle.cantidad)
        }))
        .filter((detalle) => Boolean(detalle.productoId));

      if (!detallesNormalizados.length) {
        throw new VentaValidationError('Debes seleccionar al menos un producto.');
      }

      const monedaSeleccionada = normalizeCurrency(payload.moneda);
      let tipoCambioSeleccionado = null;
      if (monedaSeleccionada === 'USD') {
        const parsedTipoCambio = Number(payload.tipo_cambio);
        if (!Number.isFinite(parsedTipoCambio) || parsedTipoCambio <= 0) {
          throw new VentaValidationError('Ingresá un tipo de cambio válido para ventas en USD.');
        }
        tipoCambioSeleccionado = round(parsedTipoCambio, 4);
      }

      const productoIds = [...new Set(detallesNormalizados.map((detalle) => detalle.productoId))];
      const productos = await tx.producto.findMany({ where: { id: { in: productoIds } } });
      const productosMap = new Map(productos.map((producto) => [producto.id, producto]));
      const stockMap = await getProductoStockMap(tx, productoIds, req.sucursalId);
      const stockReservado = new Map();

      let subtotalAcumulado = 0;
      let subtotalAcumuladoMoneda = 0;
      const detallePayloads = [];

      for (const detalle of detallesNormalizados) {
        const producto = productosMap.get(detalle.productoId);
        if (!producto || producto.deleted_at) {
          throw new Error('PRODUCTO_NO_ENCONTRADO:' + detalle.productoId);
        }
        if (producto.activo === false) {
          throw new Error('PRODUCTO_INACTIVO:' + detalle.productoId);
        }

        const cantidad = Number(detalle.cantidad);
        if (!Number.isFinite(cantidad) || cantidad <= 0) {
          throw new VentaValidationError('La cantidad debe ser mayor a cero.');
        }

        const stockDisponible = resolveProductoStock(producto, req.sucursalId, stockMap);
        const reservado = stockReservado.get(detalle.productoId) || 0;
        if (stockDisponible < cantidad + reservado) {
          throw new Error('STOCK_INSUFICIENTE:' + detalle.productoId);
        }
        stockReservado.set(detalle.productoId, reservado + cantidad);

        const pricing = resolveProductSalePricing(producto, {
          targetCurrency: monedaSeleccionada,
          exchangeRate: tipoCambioSeleccionado
        });

        const precioUnitarioRedondeado = round(pricing.unitGs, 2);
        ensureWithinLimit(precioUnitarioRedondeado, 'Precio unitario');

        const subtotalDetalle = round(precioUnitarioRedondeado * cantidad, 2);
        ensureWithinLimit(subtotalDetalle, 'Subtotal de detalle');

        subtotalAcumulado = round(subtotalAcumulado + subtotalDetalle, 2);
        if (monedaSeleccionada === 'USD') {
          subtotalAcumuladoMoneda = round(subtotalAcumuladoMoneda + round(pricing.unitCurrency * cantidad, 2), 2);
        }

        detallePayloads.push({
          productoId: detalle.productoId,
          cantidad,
          precio_unitario: precioUnitarioRedondeado,
          subtotal: subtotalDetalle,
          moneda_precio_unitario: monedaSeleccionada,
          precio_unitario_moneda: round(pricing.unitCurrency, monedaSeleccionada === 'USD' ? 4 : 2),
          subtotal_moneda: round(pricing.unitCurrency * cantidad, monedaSeleccionada === 'USD' ? 4 : 2),
          tipo_cambio_aplicado: monedaSeleccionada === 'USD' ? tipoCambioSeleccionado : null
        });
      }

      ensureWithinLimit(subtotalAcumulado, 'Subtotal');

      let descuentoEntrada = Number(payload.descuento_total ?? 0);
      if (!Number.isFinite(descuentoEntrada) || descuentoEntrada < 0) {
        descuentoEntrada = 0;
      }
      descuentoEntrada = round(descuentoEntrada, 2);
      ensureWithinLimit(descuentoEntrada, 'Descuento total');

      const descuentoTotal = monedaSeleccionada === 'USD' && tipoCambioSeleccionado
        ? round(descuentoEntrada * tipoCambioSeleccionado, 2)
        : descuentoEntrada;
      const descuentoMoneda = monedaSeleccionada === 'USD' ? descuentoEntrada : null;

      if (descuentoTotal > subtotalAcumulado) {
        throw new VentaValidationError('El descuento no puede superar el subtotal.');
      }

      const baseGravada = round(subtotalAcumulado - descuentoTotal, 2);
      ensureWithinLimit(baseGravada, 'Total');

      const divisor = IVA_DIVISOR[ivaPorcentaje];
      const impuestoTotal = divisor && baseGravada > 0 ? round(baseGravada / divisor, 2) : 0;
      ensureWithinLimit(impuestoTotal, 'Impuesto total');

      const total = baseGravada;

      let totalEnMonedaSeleccionada = null;
      if (monedaSeleccionada === 'USD') {
        totalEnMonedaSeleccionada = total === 0
          ? 0
          : round(Math.max(subtotalAcumuladoMoneda - (descuentoMoneda || 0), 0), 2);
        ensureWithinLimit(totalEnMonedaSeleccionada, 'Total en moneda seleccionada');
      }

      const esTicket = String(payload.estado || '').toUpperCase() === 'TICKET';
      const condicionVenta = esTicket
        ? 'CONTADO'
        : normalizeCondicionVenta(payload.condicion_venta, payload.credito);
      const creditoState = buildVentaCreditoState({
        condicionVenta,
        creditoInput: esTicket ? null : payload.credito,
        fechaVencimiento: esTicket ? null : (payload.fecha_vencimiento || payload.credito?.fecha_vencimiento || null),
        moneda: monedaSeleccionada,
        tipoCambio: tipoCambioSeleccionado,
        totalGs: total,
        totalMoneda: totalEnMonedaSeleccionada
      });

      let clienteId = payload.clienteId || null;
      if (clienteId) {
        const cliente = await tx.cliente.findUnique({ where: { id: clienteId } });
        if (!cliente || cliente.deleted_at) {
          throw new VentaValidationError('El cliente no existe o fue eliminado.');
        }
      }

      const venta = await tx.venta.create({
        data: {
          usuarioId: payload.usuarioId,
          clienteId,
          sucursalId: req.sucursalId,
          subtotal: subtotalAcumulado,
          descuento_total: descuentoTotal,
          impuesto_total: impuestoTotal,
          total,
          estado: payload.estado || 'PENDIENTE',
          moneda: monedaSeleccionada,
          tipo_cambio: tipoCambioSeleccionado,
          total_moneda: totalEnMonedaSeleccionada,
          iva_porcentaje: ivaPorcentaje,
          condicion_venta: condicionVenta,
          es_credito: creditoState.esCredito,
          fecha_vencimiento: creditoState.fechaVencimiento || undefined,
          saldo_pendiente: creditoState.saldoPendiente,
          credito_config: creditoState.creditoConfig
        }
      });

      if (creditoState.esCredito && Number(creditoState.creditoConfig?.entrega_inicial_gs || 0) > 0) {
        await createInitialDeliveryReceipt(tx, {
          venta,
          creditoState,
          moneda: monedaSeleccionada,
          tipoCambio: tipoCambioSeleccionado,
          usuarioId: payload.usuarioId,
          clienteId,
          sucursalId: req.sucursalId
        });
      }

      for (const detalle of detallePayloads) {
        await tx.detalleVenta.create({
          data: {
            ventaId: venta.id,
            productoId: detalle.productoId,
            cantidad: detalle.cantidad,
            precio_unitario: detalle.precio_unitario,
            subtotal: detalle.subtotal,
            moneda_precio_unitario: detalle.moneda_precio_unitario,
            precio_unitario_moneda: detalle.precio_unitario_moneda,
            subtotal_moneda: detalle.subtotal_moneda,
            tipo_cambio_aplicado: detalle.tipo_cambio_aplicado
          }
        });

        const producto = productosMap.get(detalle.productoId);
        if (producto) {
          await applyProductoStockDelta(tx, producto, req.sucursalId, -detalle.cantidad);
          const stockActual = stockMap.get(detalle.productoId) || 0;
          stockMap.set(detalle.productoId, stockActual - detalle.cantidad);
        }

        await tx.movimientoStock.create({
          data: {
            productoId: detalle.productoId,
            tipo: 'SALIDA',
            cantidad: detalle.cantidad,
            motivo: payload.motivo || 'Venta',
            referencia_id: venta.id,
            referencia_tipo: 'Venta',
            almacen_id: payload.almacenId || null,
            usuario_id: payload.usuarioId
          }
        });
      }

      const full = await tx.venta.findFirst({
        where: { id: venta.id, sucursalId: req.sucursalId },
        include: {
          detalles: {
            include: {
              producto: true
            }
          },
          cliente: true,
          usuario: true,
          sucursal: true
        }
      });

      return full;
    });

    res.status(201).json(serialize(result));
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err && err.message && err.message.startsWith('STOCK_INSUFICIENTE')) {
      const pid = err.message.split(':')[1];
      return res.status(400).json({ error: `Stock insuficiente para producto ${pid}` });
    }
    if (err && err.message && err.message.startsWith('PRODUCTO_NO_ENCONTRADO')) {
      const pid = err.message.split(':')[1];
      return res.status(400).json({ error: `Producto no encontrado: ${pid}` });
    }
    if (err && err.message && err.message.startsWith('PRODUCTO_INACTIVO')) {
      const pid = err.message.split(':')[1];
      return res.status(400).json({ error: `Producto inactivo: ${pid}` });
    }

    console.error(err);
    res.status(500).json({ error: 'Error al crear venta' });
  }
});

// Nota: no implementamos update/delete complejos por ahora

router.post('/:id/facturar', authorizeRoles('ADMIN'), async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador de venta inválido.' });
  }

  const facturarParsed = facturarRequestSchema.safeParse(req.body || {});
  if (!facturarParsed.success) {
    return res.status(400).json({ error: 'Datos inválidos para facturar.', detalles: facturarParsed.error.flatten() });
  }

  const facturarInput = facturarParsed.data;

  const { id } = parsedParams.data;

  try {
    validateTimbradoConfig(empresaConfig.timbrado || {});
  } catch (timbradoError) {
    if (timbradoError instanceof FacturaDigitalError) {
      return res.status(412).json({ error: timbradoError.message, code: timbradoError.code });
    }
    console.error('[FacturaDigital] Error al validar el timbrado.', timbradoError);
    return res.status(500).json({ error: 'No se pudo validar la configuración del timbrado.' });
  }

  try {
    let venta = null;
    let factura = null;
    let lastError = null;
    let localPdfWebPath = null;

    for (let attempt = 0; attempt < MAX_FACTURA_REINTENTOS && !venta; attempt += 1) {
      try {
        const txResult = await prisma.$transaction(async (tx) => {
          const ventaActual = await tx.venta.findFirst({
            where: { id, sucursalId: req.sucursalId },
            include: {
              cliente: true,
              usuario: true,
              detalles: { include: { producto: true } },
              factura_electronica: true
            }
          });

          if (!ventaActual) {
            throw new VentaValidationError('No se encontró la venta solicitada.');
          }

          const monedaVenta = (ventaActual.moneda || 'PYG').toUpperCase();
          if (monedaVenta === 'USD') {
            const tipoCambioVenta = Number(ventaActual.tipo_cambio);
            if (!Number.isFinite(tipoCambioVenta) || tipoCambioVenta <= 0) {
              throw new VentaValidationError('La venta en USD no tiene tipo de cambio cargado. Corrigila antes de facturar.');
            }
          }

          const condicionVentaFacturacion = normalizeCondicionVenta(
            facturarInput.condicion_pago || ventaActual.condicion_venta,
            facturarInput.credito
          );
          const creditoStateFacturacion = buildVentaCreditoState({
            condicionVenta: condicionVentaFacturacion,
            creditoInput: facturarInput.credito || ventaActual.credito_config,
            fechaVencimiento:
              facturarInput.fecha_vencimiento ||
              facturarInput.credito?.fecha_vencimiento ||
              ventaActual.fecha_vencimiento ||
              ventaActual.credito_config?.fecha_vencimiento ||
              null,
            moneda: ventaActual.moneda,
            tipoCambio: ventaActual.tipo_cambio,
            totalGs: ventaActual.total,
            totalMoneda: ventaActual.total_moneda
          });
          const creditoConfigChanged =
            creditoConfigComparable(creditoStateFacturacion.creditoConfig) !== creditoConfigComparable(ventaActual.credito_config);

          if (
            condicionVentaFacturacion !== ventaActual.condicion_venta ||
            creditoStateFacturacion.esCredito !== ventaActual.es_credito ||
            String(creditoStateFacturacion.fechaVencimiento || '') !== String(ventaActual.fecha_vencimiento || '') ||
            (!creditoStateFacturacion.esCredito && ventaActual.saldo_pendiente) ||
            creditoConfigChanged ||
            (creditoStateFacturacion.esCredito &&
              Math.abs(Number(ventaActual.saldo_pendiente || 0) - Number(creditoStateFacturacion.saldoPendiente || 0)) > 0.01)
          ) {
            await tx.venta.update({
              where: { id: ventaActual.id },
              data: {
                condicion_venta: condicionVentaFacturacion,
                es_credito: creditoStateFacturacion.esCredito,
                fecha_vencimiento: creditoStateFacturacion.fechaVencimiento || undefined,
                saldo_pendiente: creditoStateFacturacion.esCredito ? creditoStateFacturacion.saldoPendiente : null,
                credito_config: creditoStateFacturacion.creditoConfig
              }
            });

            ventaActual.condicion_venta = condicionVentaFacturacion;
            ventaActual.es_credito = creditoStateFacturacion.esCredito;
            ventaActual.fecha_vencimiento = creditoStateFacturacion.fechaVencimiento;
            ventaActual.saldo_pendiente = creditoStateFacturacion.esCredito ? creditoStateFacturacion.saldoPendiente : null;
            ventaActual.credito_config = creditoStateFacturacion.creditoConfig;
          }

          if (ventaActual.deleted_at || (ventaActual.estado && ventaActual.estado.toUpperCase() === 'ANULADA')) {
            throw new VentaValidationError('No es posible generar una factura para una venta anulada.');
          }

          if (!Array.isArray(ventaActual.detalles) || !ventaActual.detalles.length) {
            throw new VentaValidationError('La venta no tiene detalles para facturar.');
          }

          const now = new Date();
          let facturaActual = ventaActual.factura_electronica;

          if (!facturaActual) {
            const timbradoSeleccionado = selectTimbradoParaVenta(ventaActual, empresaConfig);
            const secuenciaFactura = await resolveSecuenciaFactura(tx, timbradoSeleccionado, req.sucursalId);
            const numeroFactura = buildNumeroFactura(timbradoSeleccionado, secuenciaFactura);

            facturaActual = await tx.facturaElectronica.create({
              data: {
                id: randomUUID(),
                ventaId: ventaActual.id,
                sucursalId: req.sucursalId,
                nro_factura: numeroFactura,
                timbrado: timbradoSeleccionado.numero || 'NO_TIMBRADO',
                fecha_emision: now,
                estado: 'PAGADA',
                respuesta_set: {
                  mensaje: 'Factura generada y marcada como pagada en entorno local de prueba.',
                  timestamp: now.toISOString()
                },
                intentos: 1,
                ambiente: 'PRUEBA',
                qr_data: construirQrPlaceholder(ventaActual, numeroFactura)
              }
            });

            await tx.venta.update({
              where: { id: ventaActual.id },
              data: {
                factura_electronicaId: facturaActual.id,
                estado: ventaActual.estado === 'PENDIENTE' ? 'FACTURADO' : ventaActual.estado
              }
            });
          } else {
            const intentosPrevios = Number(facturaActual.intentos) || 0;
            facturaActual = await tx.facturaElectronica.update({
              where: { id: facturaActual.id },
              data: {
                intentos: { set: intentosPrevios + 1 },
                respuesta_set: {
                  mensaje: 'Factura reintentada (estado pagada) en entorno local de prueba.',
                  intento: intentosPrevios + 1,
                  timestamp: now.toISOString()
                },
                estado: 'PAGADA',
                updated_at: now
              }
            });
          }

          const ventaRefrescada = await tx.venta.findFirst({
            where: { id, sucursalId: req.sucursalId },
            include: {
              cliente: true,
              usuario: true,
              sucursal: true,
              detalles: { include: { producto: true } },
              factura_electronica: true
            }
          });

          return { venta: ventaRefrescada, factura: facturaActual };
        });

        venta = txResult.venta;
        factura = txResult.factura;
        lastError = null;
      } catch (err) {
        lastError = err;
        if (isUniqueNroFacturaError(err) && attempt < MAX_FACTURA_REINTENTOS - 1) {
          continue;
        }
        throw err;
      }
    }

    if (!venta || !factura) {
      throw lastError || new Error('No se pudo generar la factura electrónica.');
    }

    let facturaActualizada = factura;
    try {
      const files = await generarArchivosFactura(venta, factura);
      localPdfWebPath = files?.pdfWebPath || null;
      if (files?.pdfWebPath && files.pdfWebPath !== factura.pdf_path) {
        facturaActualizada = await prisma.facturaElectronica.update({
          where: { id: factura.id },
          data: {
            pdf_path: files.pdfWebPath,
            xml_path: files.xmlWebPath || factura.xml_path
          }
        });
        venta.factura_electronica = facturaActualizada;
      }
    } catch (assetError) {
      console.error('[Factura] No se pudo generar el PDF.', assetError);
    }

    if (factpyConfig?.recordId) {
      try {
        const factpyOptions = {
          condicion_pago: facturarInput.condicion_pago || venta?.condicion_venta,
          fecha_vencimiento:
            facturarInput.fecha_vencimiento || facturarInput.credito?.fecha_vencimiento || venta?.fecha_vencimiento,
          credito: facturarInput.credito || facturaActualizada?.respuesta_set?.credito || factura?.respuesta_set?.credito
        };

        const payload = buildFactPyPayload(venta, facturaActualizada, factpyOptions);
        const respuestaFactpy = await emitirFactura({
          dataJson: payload,
          recordID: factpyConfig.recordId,
          baseUrl: factpyConfig.baseUrl,
          timeoutMs: factpyConfig.timeoutMs
        });

        const estadoFactpy = respuestaFactpy?.status === false ? 'RECHAZADO' : 'ENVIADO';
        const mergedRespuesta = {
          receiptid: payload?.receiptid,
          factpy: respuestaFactpy,
          credito: payload?.credito || null,
          condicionPago: payload?.condicionPago,
          timestamp: new Date().toISOString()
        };

        const factpyXmlUrl = normalizeFactpyExternalUrl(respuestaFactpy?.xmlLink);
        const factpyPdfUrl = normalizeFactpyExternalUrl(respuestaFactpy?.kude);

        facturaActualizada = await prisma.facturaElectronica.update({
          where: { id: facturaActualizada.id },
          data: {
            respuesta_set: mergedRespuesta,
            qr_data: respuestaFactpy?.cdc || facturaActualizada.qr_data,
            xml_path: factpyXmlUrl || facturaActualizada.xml_path,
            pdf_path: factpyPdfUrl || facturaActualizada.pdf_path,
            estado: estadoFactpy
          }
        });

        venta.factura_electronica = facturaActualizada;
      } catch (factpyError) {
        console.error('[FactPy] Error al emitir', factpyError);
      }
    }

    const shouldSendSifen = process.env.NODE_ENV === 'test' || (SIFEN_ENABLED && hasSifenCert());
    if (shouldSendSifen) {
      try {
        const resultadoSifen = await procesarFacturaElectronica(venta);
        if (resultadoSifen?.factura) {
          facturaActualizada = resultadoSifen.factura;
          venta.factura_electronica = facturaActualizada;
        }
      } catch (sifenError) {
        console.error('[SIFEN] Error al procesar el documento electrónico.', sifenError);
      }
    }

    res.json({
      venta: serialize(venta),
      factura: serialize(facturaActualizada),
      factura_local_pdf_url: localPdfWebPath
    });
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar la factura electrónica.' });
  }
});

router.post('/:id/anular', authorizeRoles('ADMIN'), async (req, res) => {
  const parsedParams = ventaIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'Identificador de venta inválido.' });
  }

  const parsedBody = cancelVentaSchema.safeParse(req.body || {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Datos inválidos para anular la venta.' });
  }

  const { id } = parsedParams.data;
  const { motivo } = parsedBody.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const venta = await tx.venta.findFirst({
        where: { id, sucursalId: req.sucursalId },
        include: {
          detalles: true,
          factura_electronica: true,
          notas_credito: {
            where: { deleted_at: null },
            orderBy: { created_at: 'desc' }
          }
        }
      });

      if (!venta) {
        throw new VentaValidationError('No se encontró la venta solicitada.');
      }

      if (venta.deleted_at || (venta.estado && venta.estado.toUpperCase() === 'ANULADA')) {
        throw new VentaValidationError('La venta ya se encuentra anulada.');
      }

      if (Array.isArray(venta.notas_credito) && venta.notas_credito.length) {
        throw new VentaValidationError('La venta ya fue regularizada con nota de crédito.');
      }

      if (venta.factura_electronica?.id) {
        throw new VentaValidationError('La venta ya está facturada. Debes emitir una nota de crédito en lugar de anularla.');
      }

      const detalles = Array.isArray(venta.detalles) ? venta.detalles : [];
      for (const detalle of detalles) {
        const producto = await tx.producto.findUnique({ where: { id: detalle.productoId } });
        if (producto) {
          await applyProductoStockDelta(tx, producto, req.sucursalId, Number(detalle.cantidad));
        }

        await tx.movimientoStock.create({
          data: {
            productoId: detalle.productoId,
            tipo: 'ENTRADA',
            cantidad: Number(detalle.cantidad),
            motivo: motivo || 'Anulación de venta',
            referencia_id: venta.id,
            referencia_tipo: 'Venta',
            usuario_id: venta.usuarioId
          }
        });
      }

      const updated = await tx.venta.update({
        where: { id: venta.id },
        data: {
          estado: 'ANULADA',
          deleted_at: new Date()
        },
        include: {
          cliente: true,
          usuario: true,
          detalles: {
            include: {
              producto: true
            }
          }
        }
      });

      return updated;
    });

    res.json(serialize(result));
  } catch (err) {
    if (err instanceof VentaValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo anular la venta.' });
  }
});

router.get('/reporte/diario', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reporte-ventas-diario-${range.fileLabel}.pdf"`);

    const doc = new PDFDocument({ size: 'LEGAL', margin: 32, bufferPages: true, layout: 'landscape' });
    doc.pipe(res);
    renderDailySalesReport(doc, data, { range, filterChips });
    doc.end();
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte diario', error);
    res.status(500).json({ error: 'No se pudo generar el reporte diario.' });
  }
});

router.get('/reporte/diario/csv', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    const csvContent = buildDailyCsv(data);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-ventas-diario-${range.fileLabel}.csv"`);
    res.send(`\ufeff${csvContent}`);
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte diario csv', error);
    res.status(500).json({ error: 'No se pudo exportar el CSV diario.' });
  }
});

router.get('/reporte/diario/xlsx', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    const buffer = buildDailyXlsx(data, range, filterChips);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte-ventas-diario-${range.fileLabel}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte diario xlsx', error);
    res.status(500).json({ error: 'No se pudo exportar el XLSX diario.' });
  }
});

router.get('/reporte/margen', authorizeRoles('ADMIN'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Parámetros inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const { filters, range, filterChips } = prepareReportFilters(parsed.data);
    const where = buildVentaWhere(filters, req.sucursalId);
    const ventas = await prisma.venta.findMany({
      where,
      include: VENTAS_REPORT_INCLUDE,
      orderBy: { fecha: 'asc' }
    });

    const data = serialize(ventas);
    if (!data.length) {
      return res.status(404).json({ error: 'No se encontraron ventas para el rango seleccionado.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reporte-ventas-margen-${range.fileLabel}.pdf"`);

    const doc = new PDFDocument({ size: 'LEGAL', margin: 32, bufferPages: true, layout: 'landscape' });
    doc.pipe(res);
    renderMarginSalesReport(doc, data, { range, filterChips });
    doc.end();
  } catch (error) {
    if (error instanceof VentaValidationError) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ventas] reporte margen', error);
    res.status(500).json({ error: 'No se pudo generar el reporte de margen.' });
  }
});

module.exports = router;

function prepareReportFilters(filtersInput = {}) {
  const filters = { ...filtersInput };
  const range = resolveReportRange(filters);
  filters.fecha_desde = range.startDate;
  filters.fecha_hasta = range.endDate;
  delete filters.mes;
  return {
    filters,
    range,
    filterChips: describeReportFilters(filtersInput)
  };
}

function resolveReportRange(filters) {
  let startDate = filters?.fecha_desde ? startOfDay(filters.fecha_desde) : null;
  let endDate = filters?.fecha_hasta ? endOfDay(filters.fecha_hasta) : null;

  if (!startDate && !endDate) {
    const today = new Date();
    startDate = startOfDay(today);
    endDate = endOfDay(today);
  } else if (startDate && !endDate) {
    endDate = endOfDay(startDate);
  } else if (!startDate && endDate) {
    startDate = startOfDay(endDate);
  }

  if (startDate > endDate) {
    throw new VentaValidationError('La fecha inicial no puede ser posterior a la fecha final.');
  }

  const sameDay = startDate.getTime() === endDate.getTime();
  return {
    startDate,
    endDate,
    startLabel: formatIsoDateOnly(startDate),
    endLabel: formatIsoDateOnly(endDate),
    fileLabel: sameDay
      ? formatIsoDateOnly(startDate)
      : `${formatIsoDateOnly(startDate)}_${formatIsoDateOnly(endDate)}`
  };
}

function describeReportFilters(filters = {}) {
  const chips = [];
  if (filters.search) chips.push(`Búsqueda: ${filters.search}`);
  if (filters.estado) chips.push(`Estado contiene: ${filters.estado}`);
  if (filters.iva_porcentaje !== undefined && filters.iva_porcentaje !== null) {
    chips.push(`IVA: ${filters.iva_porcentaje}%`);
  }
  if (filters.moneda) chips.push(`Moneda: ${(filters.moneda || '').toUpperCase()}`);
  if (filters.include_deleted) chips.push('Incluye registros eliminados');
  return chips;
}

function renderDailySalesReport(doc, ventas, { range, filterChips }) {
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totals = calculateDailyTotals(ventas);
  const rows = buildDailyReportRows(ventas, totals);
  renderReportHeader(doc, 'Reporte diario de ventas', range, startX, usableWidth, filterChips);
  drawReportFilterTags(doc, filterChips, startX, usableWidth);
  drawReportSummaryChips(
    doc,
    [
      { label: 'Ventas registradas', value: formatIntegerValue(ventas.length) },
      { label: 'Subtotal', value: formatCurrencyPyG(totals.subtotal) },
      { label: 'IVA calculado', value: formatCurrencyPyG(totals.impuesto) },
      { label: 'Total periodo', value: formatCurrencyPyG(totals.total) }
    ],
    startX,
    usableWidth
  );
  const extraLines = [];
  if (totals.totalUsd > 0 || totals.impuestoUsd > 0) {
    const parts = [];
    if (totals.totalUsd > 0) parts.push(`Equivalente en USD: ${formatCurrencyUsd(totals.totalUsd)}`);
    if (totals.impuestoUsd > 0) parts.push(`IVA en USD: ${formatCurrencyUsd(totals.impuestoUsd)}`);
    extraLines.push(parts.join('   ·   '));
  }
  if (totals.iva5 > 0 || totals.iva10 > 0) {
    const ivaParts = [];
    ivaParts.push(`IVA 5%: ${formatCurrencyPyG(totals.iva5)}`);
    ivaParts.push(`IVA 10%: ${formatCurrencyPyG(totals.iva10)}`);
    if (totals.iva5Usd > 0 || totals.iva10Usd > 0) {
      const ivaUsdParts = [];
      if (totals.iva5Usd > 0) ivaUsdParts.push(`5% USD ${formatCurrencyUsd(totals.iva5Usd)}`);
      if (totals.iva10Usd > 0) ivaUsdParts.push(`10% USD ${formatCurrencyUsd(totals.iva10Usd)}`);
      ivaParts.push(`(${ivaUsdParts.join(' · ')})`);
    }
    extraLines.push(ivaParts.join('   ·   '));
  }
  if (totals.costo > 0 || totals.margen !== 0) {
    const margenParts = [];
    if (totals.costo > 0) margenParts.push(`Costo estimado: ${formatCurrencyPyG(totals.costo)}`);
    const margenTexto = `Margen: ${formatCurrencyPyG(totals.margen)} (${formatPercentValue(totals.margenPercent)})`;
    margenParts.push(margenTexto);
    extraLines.push(margenParts.join('   ·   '));
  }
  if (extraLines.length) {
    extraLines.forEach((line) => {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#475569')
        .text(line, startX, doc.y + 4);
      doc.moveDown(0.2);
    });
    doc.moveDown(0.2);
  }
  ensureMinimumSpacing(doc, 10);
  drawReportTable(
    doc,
    rows,
    buildDailyReportColumns(usableWidth),
    startX,
    usableWidth,
    {
      resolveRowFill: (row, index) => {
        if (row.isSummary) return '#0f172a';
        if (row.isCancelled) return '#fee2e2';
        return index % 2 === 0 ? '#ffffff' : '#f8fafc';
      },
      resolveFontColor: (row) => (row.isSummary ? '#ffffff' : '#0f172a')
    }
  );

  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#94a3b8')
    .text('Documento generado automáticamente por Trident Innova.', startX, doc.y, {
      width: usableWidth,
      align: 'center'
    });
}

function renderMarginSalesReport(doc, ventas, { range, filterChips }) {
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totals = calculateMarginTotals(ventas);
  const rows = buildMarginReportRows(ventas, totals);
  renderReportHeader(doc, 'Reporte de margen de ventas', range, startX, usableWidth, filterChips);
  drawReportFilterTags(doc, filterChips, startX, usableWidth);
  drawReportSummaryChips(
    doc,
    [
      { label: 'Ventas analizadas', value: formatIntegerValue(ventas.length) },
      { label: 'Total ventas', value: formatCurrencyPyG(totals.totalVenta) },
      { label: 'Costo estimado', value: formatCurrencyPyG(totals.costo) },
      { label: 'Margen promedio', value: formatPercentValue(totals.margenPercent) }
    ],
    startX,
    usableWidth
  );
  ensureMinimumSpacing(doc, 10);
  drawReportTable(
    doc,
    rows,
    buildMarginReportColumns(usableWidth),
    startX,
    usableWidth,
    {
      resolveRowFill: (row, index) => (row.isSummary ? '#0f172a' : index % 2 === 0 ? '#ffffff' : '#f8fafc'),
      resolveFontColor: (row) => (row.isSummary ? '#ffffff' : '#0f172a')
    }
  );

  doc.moveDown(0.6);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#94a3b8')
    .text('Documento generado automáticamente por Trident Innova.', startX, doc.y, {
      width: usableWidth,
      align: 'center'
    });
}

function renderReportHeader(doc, title, range, startX, usableWidth, filterChips = []) {
  const startLabel = formatRangeDateLabel(range.startDate);
  const endLabel = formatRangeDateLabel(range.endDate);
  const subtitle = startLabel === endLabel ? `Fecha: ${startLabel}` : `Rango: ${startLabel} – ${endLabel}`;

  const hasLogo = fs.existsSync(REPORT_LOGO_PATH);
  const logoHeight = 84;
  let cursorY = doc.page.margins.top;

  if (hasLogo) {
    try {
      doc.image(REPORT_LOGO_PATH, startX, cursorY - 6, { fit: [180, logoHeight], align: 'left' });
    } catch (logoError) {
      console.warn('[Reportes] No se pudo incrustar el logo.', logoError);
    }
  }

  const textBlockOffset = hasLogo ? 190 : 0;
  const textStartX = startX + textBlockOffset;
  const textWidth = usableWidth - textBlockOffset * 2;

  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#0f172a')
    .text(title, textStartX, cursorY, { width: textWidth, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#475569')
    .text(`${EMPRESA_INFO.nombre} · RUC ${EMPRESA_INFO.ruc}`, textStartX, doc.y + 6, {
      width: textWidth,
      align: 'center'
    });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#475569')
    .text(subtitle, textStartX, doc.y + 4, { width: textWidth, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#94a3b8')
    .text(`Generado: ${formatDateTimeLabel(new Date())}`, textStartX, doc.y + 6, {
      width: textWidth,
      align: 'center'
    });

  const filtersText = Array.isArray(filterChips) && filterChips.length ? filterChips.join(' | ') : 'Sin filtros';
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#64748b')
    .text(`Filtros: ${filtersText}`, textStartX, doc.y + 6, { width: textWidth, align: 'center' });

  doc.moveDown(2);
}

function drawReportFilterTags(doc, filterChips, startX, usableWidth) {
  if (!Array.isArray(filterChips) || !filterChips.length) {
    return;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#0f172a')
    .text('Filtros aplicados', startX, doc.y, { width: usableWidth });
  doc.moveDown(0.2);
  filterChips.forEach((chip) => {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#475569')
      .text(`• ${chip}`, startX, doc.y, { width: usableWidth });
  });
  doc.moveDown(0.5);
}

function drawReportSummaryChips(doc, items, startX, usableWidth) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#0f172a')
    .text('Resumen del periodo', startX, doc.y, { width: usableWidth });
  doc.moveDown(0.3);

  const visibleItems = items.slice(0, 4);
  const gap = 12;
  const chipWidth = (usableWidth - gap * (visibleItems.length - 1)) / visibleItems.length;
  const chipHeight = 56;
  const baseY = doc.y;

  visibleItems.forEach((item, index) => {
    const x = startX + index * (chipWidth + gap);
    doc.save();
    doc.roundedRect(x, baseY, chipWidth, chipHeight, 8).fill('#f8fafc');
    doc.restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#475569')
      .text(item.label, x + 10, baseY + 10, { width: chipWidth - 20 });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#0f172a')
      .text(String(item.value ?? '—'), x + 10, baseY + 26, { width: chipWidth - 20 });
  });

  doc.y = baseY + chipHeight + 8;

  if (items.length > visibleItems.length) {
    const remaining = items.slice(visibleItems.length);
    remaining.forEach((item) => {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#475569')
        .text(`${item.label}: ${item.value}`, startX, doc.y, { width: usableWidth });
    });
    doc.moveDown(0.4);
  }
}

function ensureMinimumSpacing(doc, amount) {
  const desired = Math.max(0, amount);
  if (doc.y - doc.page.margins.top < desired) {
    doc.moveDown(0.1);
  }
  doc.y = Math.max(doc.y, doc.page.margins.top + desired);
}

function drawReportTable(doc, rows, columns, startX, usableWidth, options = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#475569')
      .text('No se encontraron registros para el rango indicado.', startX, doc.y, { width: usableWidth });
    return;
  }

  const headerHeight = 24;
  const maxY = () => doc.page.height - doc.page.margins.bottom;

  const drawHeader = () => {
    const headerY = doc.y;
    doc.save();
    doc.rect(startX, headerY, usableWidth, headerHeight).fill('#f97316');
    doc.restore();
    let cursorX = startX;
    columns.forEach((col, columnIndex) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#ffffff')
        .text(col.label, cursorX + 6, headerY + 6, { width: col.width - 12, align: col.align || 'left' });
      cursorX += col.width;
      if (columnIndex < columns.length - 1) {
        doc
          .moveTo(cursorX, headerY)
          .lineTo(cursorX, headerY + headerHeight)
          .stroke('#1e293b');
      }
    });
    doc.y += headerHeight - 2;
  };

  drawHeader();

  rows.forEach((row, index) => {
    const rowHeight = measureReportRowHeight(doc, row, columns);
    if (doc.y + rowHeight > maxY()) {
      doc.addPage();
      drawHeader();
    }

    const fillColor = options.resolveRowFill ? options.resolveRowFill(row, index) : index % 2 === 0 ? '#ffffff' : '#f8fafc';
    const fontColor = options.resolveFontColor ? options.resolveFontColor(row, index) : '#0f172a';
    const fontName = row.isSummary ? 'Helvetica-Bold' : 'Helvetica';
    const rowY = doc.y;

    doc.save();
    doc.rect(startX, rowY, usableWidth, rowHeight).fill(fillColor);
    doc.restore();
    doc.rect(startX, rowY, usableWidth, rowHeight).stroke('#e2e8f0');

    let cursorX = startX;
    columns.forEach((col, columnIndex) => {
      const value = row[col.key] ?? '—';
      doc
        .font(fontName)
        .fontSize(col.key === 'estado' ? 8 : 9)
        .fillColor(fontColor)
        .text(value, cursorX + 6, rowY + 6, { width: col.width - 12, align: col.align || 'left' });
      cursorX += col.width;
      if (columnIndex < columns.length - 1) {
        doc
          .moveTo(cursorX, rowY)
          .lineTo(cursorX, rowY + rowHeight)
          .stroke('#e2e8f0');
      }
    });

    doc.y = rowY + rowHeight;
  });
}

function measureReportRowHeight(doc, row, columns) {
  let height = 20;
  doc.font('Helvetica').fontSize(9);
  columns.forEach((col) => {
    const value = row[col.key] ?? '—';
    const textHeight = doc.heightOfString(String(value), {
      width: Math.max(col.width - 12, 18),
      align: col.align || 'left'
    });
    height = Math.max(height, textHeight + 10);
  });
  return height;
}

function buildDailyReportColumns(usableWidth) {
  const definitions = [
    { key: 'fecha', label: 'Fecha', ratio: 0.075 },
    { key: 'factura', label: 'N° factura', ratio: 0.11 },
    { key: 'cliente', label: 'Cliente', ratio: 0.19 },
    { key: 'usuario', label: 'Usuario', ratio: 0.09 },
    { key: 'estado', label: 'Estado', ratio: 0.065 },
    { key: 'condicion', label: 'Condición', ratio: 0.05 },
    { key: 'subtotal', label: 'Subtotal', ratio: 0.13, align: 'right' },
    { key: 'descuento', label: 'Descuento', ratio: 0.08, align: 'right' },
    { key: 'iva', label: 'IVA', ratio: 0.09, align: 'right' },
    { key: 'total', label: 'Total', ratio: 0.1, align: 'right' },
    { key: 'items', label: 'Items', ratio: 0.02, align: 'center' }
  ];

  return definitions.map((column) => ({
    ...column,
    width: usableWidth * column.ratio
  }));
}

function buildDailyReportRows(ventas, totals) {
  const rows = ventas.map((venta) => {
    const estadoBase = (venta.estado || '').toUpperCase();
    const anulada = estadoBase === 'ANULADA' || Boolean(venta.deleted_at);
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    const condicion = condicionRaw.includes('CREDITO') ? 'Crédito' : 'Contado';
    return {
      fecha: formatDateForDisplay(venta.fecha || venta.created_at),
      factura: resolveInvoiceNumberForReport(venta),
      cliente: venta.cliente?.nombre_razon_social || 'Cliente eventual',
      usuario: venta.usuario?.nombre || venta.usuario?.usuario || '—',
      estado: anulada ? 'Anulada' : venta.estado || '—',
      condicion,
      subtotal: formatCurrencyPyG(venta.subtotal),
      descuento: formatCurrencyPyG(venta.descuento_total),
      iva: formatCurrencyPyG(venta.impuesto_total),
      total: formatCurrencyPyG(venta.total ?? venta.subtotal),
      items: formatIntegerValue(countVentaItems(venta)),
      isCancelled: anulada
    };
  });

  rows.push({
    fecha: 'Totales',
    factura: `(${ventas.length} ventas)`,
    cliente: '',
    usuario: '',
    estado: '',
    condicion: '',
    subtotal: formatCurrencyPyG(totals.subtotal),
    descuento: formatCurrencyPyG(totals.descuento),
    iva: formatCurrencyPyG(totals.impuesto),
    total: formatCurrencyPyG(totals.total),
    items: formatIntegerValue(totals.items),
    isSummary: true
  });

  return rows;
}

function calculateDailyTotals(ventas) {
  const result = ventas.reduce(
    (acc, venta) => {
      const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
      const costo = computeCostoVenta(venta);
      acc.subtotal += Number(venta.subtotal) || 0;
      acc.descuento += Number(venta.descuento_total) || 0;
      acc.impuesto += Number(venta.impuesto_total) || 0;
      acc.total += totalVenta;
      acc.items += countVentaItems(venta);
      acc.costo += costo;
      acc.margen += totalVenta - costo;
      const currency = (venta.moneda || 'PYG').toUpperCase();
      const ivaTotal = Number(venta.impuesto_total) || 0;
      const ivaRate = Number.isFinite(Number(venta.iva_porcentaje)) ? Number(venta.iva_porcentaje) : 10;
      if (ivaRate === 5) acc.iva5 += ivaTotal; else if (ivaRate === 10) acc.iva10 += ivaTotal;
      if (currency === 'USD') {
        const usdAmount = Number(venta.total_moneda) || 0;
        if (usdAmount > 0) {
          acc.totalUsd += usdAmount;
        }
        const tipoCambio = Number(venta.tipo_cambio) || 0;
        if (ivaTotal > 0 && tipoCambio > 0) {
          const ivaUsd = ivaTotal / tipoCambio;
          acc.impuestoUsd += ivaUsd;
          if (ivaRate === 5) acc.iva5Usd += ivaUsd; else if (ivaRate === 10) acc.iva10Usd += ivaUsd;
        }
      }
      return acc;
    },
    {
      subtotal: 0,
      descuento: 0,
      impuesto: 0,
      total: 0,
      items: 0,
      totalUsd: 0,
      impuestoUsd: 0,
      iva5: 0,
      iva10: 0,
      iva5Usd: 0,
      iva10Usd: 0,
      costo: 0,
      margen: 0
    }
  );

  result.margenPercent = result.total > 0 ? (result.margen / result.total) * 100 : 0;
  return result;
}

function buildDailyCsv(ventas) {
  const header = [
    'Fecha',
    'Nro factura',
    'Cliente',
    'Estado',
    'Condición',
    'Moneda',
    'Subtotal_PYG',
    'Descuento_PYG',
    'IVA_PYG',
    'Total_PYG',
    'Total_Moneda',
    'Tipo_cambio',
    'Costo_estimado_PYG',
    'Margen_PYG',
    'Margen_%',
    'Items'
  ];

  const totals = calculateDailyTotals(ventas);
  const rows = ventas.map((venta) => {
    const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
    const costo = computeCostoVenta(venta);
    const margen = totalVenta - costo;
    const margenPercent = totalVenta > 0 ? (margen / totalVenta) * 100 : 0;
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    return [
      formatIsoDateOnly(venta.fecha || venta.created_at),
      resolveInvoiceNumberForReport(venta),
      venta.cliente?.nombre_razon_social || 'Cliente eventual',
      venta.estado || '',
      condicionRaw,
      (venta.moneda || 'PYG').toUpperCase(),
      plainNumber(venta.subtotal),
      plainNumber(venta.descuento_total),
      plainNumber(venta.impuesto_total),
      plainNumber(totalVenta),
      plainNumber(venta.total_moneda),
      plainNumber(venta.tipo_cambio),
      plainNumber(costo),
      plainNumber(margen),
      plainPercent(margenPercent),
      plainNumber(countVentaItems(venta))
    ];
  });

  rows.push([
    'Totales',
    `${ventas.length} ventas`,
    '',
    '',
    '',
    '',
    plainNumber(totals.subtotal),
    plainNumber(totals.descuento),
    plainNumber(totals.impuesto),
    plainNumber(totals.total),
    plainNumber(totals.totalUsd),
    '',
    plainNumber(totals.costo),
    plainNumber(totals.margen),
    plainPercent(totals.margenPercent),
    plainNumber(totals.items)
  ]);

  const lines = [header, ...rows].map((line) => stringifyCsvRow(line));
  return lines.join('\n');
}

function buildDailyXlsx(ventas, range, filterChips = []) {
  const header = [
    'Fecha',
    'Nro factura',
    'Cliente',
    'Estado',
    'Condición',
    'Moneda',
    'Subtotal PYG',
    'Descuento PYG',
    'IVA PYG',
    'Total PYG',
    'Total Moneda',
    'Tipo cambio',
    'Costo estimado PYG',
    'Margen PYG',
    'Margen %',
    'Items'
  ];

  const totals = calculateDailyTotals(ventas);
  const rows = ventas.map((venta) => {
    const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
    const costo = computeCostoVenta(venta);
    const margen = totalVenta - costo;
    const margenPercent = totalVenta > 0 ? (margen / totalVenta) * 100 : 0;
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    return [
      formatIsoDateOnly(venta.fecha || venta.created_at),
      resolveInvoiceNumberForReport(venta),
      venta.cliente?.nombre_razon_social || 'Cliente eventual',
      venta.estado || '',
      condicionRaw,
      (venta.moneda || 'PYG').toUpperCase(),
      asNumberOrNull(venta.subtotal),
      asNumberOrNull(venta.descuento_total),
      asNumberOrNull(venta.impuesto_total),
      asNumberOrNull(totalVenta),
      asNumberOrNull(venta.total_moneda),
      asNumberOrNull(venta.tipo_cambio),
      asNumberOrNull(costo),
      asNumberOrNull(margen),
      asPercentNumber(margenPercent),
      asNumberOrNull(countVentaItems(venta))
    ];
  });

  rows.push([
    'Totales',
    `${ventas.length} ventas`,
    '',
    '',
    '',
    '',
    asNumberOrNull(totals.subtotal),
    asNumberOrNull(totals.descuento),
    asNumberOrNull(totals.impuesto),
    asNumberOrNull(totals.total),
    asNumberOrNull(totals.totalUsd),
    '',
    asNumberOrNull(totals.costo),
    asNumberOrNull(totals.margen),
    asPercentNumber(totals.margenPercent),
    asNumberOrNull(totals.items)
  ]);

  const metaRows = [
    ['Reporte diario de ventas'],
    [`Rango: ${formatRangeDateLabel(range.startDate)} – ${formatRangeDateLabel(range.endDate)}`],
    [`Generado: ${formatDateTimeLabel(new Date())}`],
    [`Filtros: ${Array.isArray(filterChips) && filterChips.length ? filterChips.join(' | ') : 'Sin filtros'}`],
    []
  ];

  const aoa = [...metaRows, header, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = header.map(() => ({ wch: 18 }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Diario');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function buildMarginReportColumns(usableWidth) {
  const definitions = [
    { key: 'fecha', label: 'Fecha', ratio: 0.1 },
    { key: 'factura', label: 'N° factura', ratio: 0.16 },
    { key: 'cliente', label: 'Cliente', ratio: 0.22 },
    { key: 'condicion', label: 'Condición', ratio: 0.08 },
    { key: 'total', label: 'Total venta', ratio: 0.14, align: 'right' },
    { key: 'costo', label: 'Costo estimado', ratio: 0.13, align: 'right' },
    { key: 'margen', label: 'Margen', ratio: 0.11, align: 'right' },
    { key: 'margenPorcentaje', label: 'Margen %', ratio: 0.06, align: 'right' }
  ];

  return definitions.map((column) => ({
    ...column,
    width: usableWidth * column.ratio
  }));
}

function buildMarginReportRows(ventas, totals) {
  const rows = ventas.map((venta) => {
    const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
    const costo = computeCostoVenta(venta);
    const margen = totalVenta - costo;
    const porcentaje = totalVenta > 0 ? (margen / totalVenta) * 100 : 0;
    const condicionRaw = String(venta.condicion_venta || venta.condicion || '').toUpperCase();
    const condicion = condicionRaw.includes('CREDITO') ? 'Crédito' : 'Contado';
    return {
      fecha: formatDateForDisplay(venta.fecha || venta.created_at),
      factura: resolveInvoiceNumberForReport(venta),
      cliente: venta.cliente?.nombre_razon_social || 'Cliente eventual',
      condicion,
      total: formatCurrencyPyG(totalVenta),
      costo: formatCurrencyPyG(costo),
      margen: formatCurrencyPyG(margen),
      margenPorcentaje: formatPercentValue(porcentaje)
    };
  });

  rows.push({
    fecha: 'Totales',
    factura: `(${ventas.length} ventas)`,
    cliente: '',
    condicion: '',
    total: formatCurrencyPyG(totals.totalVenta),
    costo: formatCurrencyPyG(totals.costo),
    margen: formatCurrencyPyG(totals.margen),
    margenPorcentaje: formatPercentValue(totals.margenPercent),
    isSummary: true
  });

  return rows;
}

function calculateMarginTotals(ventas) {
  const result = ventas.reduce(
    (acc, venta) => {
      const totalVenta = Number(venta.total ?? venta.subtotal) || 0;
      const costo = computeCostoVenta(venta);
      const margen = totalVenta - costo;
      acc.totalVenta += totalVenta;
      acc.costo += costo;
      acc.margen += margen;
      return acc;
    },
    { totalVenta: 0, costo: 0, margen: 0 }
  );

  result.margenPercent = result.totalVenta > 0 ? (result.margen / result.totalVenta) * 100 : 0;
  return result;
}

function computeCostoVenta(venta) {
  if (!Array.isArray(venta?.detalles)) return 0;
  return venta.detalles.reduce((acc, detalle) => acc + computeCostoDetalle(detalle), 0);
}

function computeCostoDetalle(detalle) {
  const cantidad = Number(detalle?.cantidad) || 0;
  if (!cantidad) return 0;
  const producto = detalle?.producto || {};
  let costoUnitario = Number(producto.precio_compra) || 0;
  if (!costoUnitario && producto.precio_compra_original && producto.tipo_cambio_precio_compra) {
    const original = Number(producto.precio_compra_original) || 0;
    const tipoCambio = Number(producto.tipo_cambio_precio_compra) || 0;
    if (original && tipoCambio) {
      costoUnitario = original * tipoCambio;
    }
  }
  return cantidad * costoUnitario;
}

function resolveInvoiceNumberForReport(venta) {
  if (venta?.factura_electronica?.nro_factura) return venta.factura_electronica.nro_factura;
  if (venta?.numero_factura) return venta.numero_factura;
  return venta?.id ? venta.id.slice(0, 8).toUpperCase() : '-';
}

function countVentaItems(venta) {
  if (!Array.isArray(venta?.detalles)) return 0;
  return venta.detalles.length;
}

function formatCurrencyPyG(value) {
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: 'PYG',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function formatCurrencyUsd(value) {
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
}

function formatPercentValue(value) {
  const numeric = Number(value) || 0;
  return `${numeric.toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function plainNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return '';
  return numeric.toString();
}

function asNumberOrNull(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return numeric;
}

function asPercentNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return Number(numeric.toFixed(2));
}

function plainPercent(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return '';
  return numeric.toFixed(2);
}

function stringifyCsvRow(values) {
  return values
    .map((value) => {
      const text = value === null || value === undefined ? '' : String(value);
      const escaped = text.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(',');
}

function formatIntegerValue(value) {
  return new Intl.NumberFormat('es-PY').format(Number(value) || 0);
}

function formatIsoDateOnly(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return value.toISOString().slice(0, 10);
}

function formatDateForDisplay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function formatRangeDateLabel(value) {
  const adjusted = adjustDateForRangeLabel(value);
  if (!adjusted) return '-';
  return formatDateForDisplay(adjusted);
}

function adjustDateForRangeLabel(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

function formatDateTimeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function generarNumeroFactura(venta, timbradoInput) {
  const timbrado = timbradoInput || selectTimbradoParaVenta(venta, empresaConfig);
  const establecimiento = (timbrado.establecimiento || '001').padStart(3, '0');
  const punto = (timbrado.punto_expedicion || timbrado.punto || '001').padStart(3, '0');
  const base = (venta?.id || venta || '').toString().replace(/-/g, '').toUpperCase();
  const correlativo = base.slice(0, 7).padEnd(7, '0');
  return `${establecimiento}-${punto}-${correlativo}`;
}

function parseSecuenciaFromNumero(nroFactura) {
  if (!nroFactura || typeof nroFactura !== 'string') return null;
  const parts = nroFactura.split('-');
  if (parts.length !== 3) return null;
  const correlativo = parts[2].replace(/[^0-9]/g, '');
  if (!correlativo) return null;
  const parsed = Number(correlativo);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveOverride(value) {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function getMinSecuenciaOverride(timbrado) {
  const est = (timbrado.establecimiento || '001').padStart(3, '0');
  const punto = (timbrado.punto_expedicion || timbrado.punto || '001').padStart(3, '0');
  const scopedKey = `FACTURA_MIN_SECUENCIA_${est}_${punto}`;
  const globalKey = 'FACTURA_MIN_SECUENCIA';
  const scoped = parsePositiveOverride(process.env[scopedKey]);
  const global = parsePositiveOverride(process.env[globalKey]);
  return Math.max(scoped, global);
}

async function resolveSecuenciaFactura(tx, timbrado, sucursalId) {
  const establecimiento = (timbrado.establecimiento || '001').padStart(3, '0');
  const puntoExpedicion = (timbrado.punto_expedicion || timbrado.punto || '001').padStart(3, '0');
  const nroFacturaPrefix = `${establecimiento}-${puntoExpedicion}-`;

  const whereDigital = {
    timbrado: timbrado.numero,
    establecimiento,
    punto_expedicion: puntoExpedicion
  };

  // nro_factura es único global y no incluye el timbrado, solo establecimiento, punto y secuencia.
  // Si cambia el timbrado pero se conserva el mismo prefijo, debemos continuar la secuencia existente.
  const whereElectronica = {
    nro_factura: {
      startsWith: nroFacturaPrefix
    }
  };

  const fetchMaxes = async (whereDigitalFilter, whereElectronicaFilter) => {
    const [ultimoDigital, ultimasElectronicas] = await Promise.all([
      tx.facturaDigital.findFirst({
        where: whereDigitalFilter,
        orderBy: { secuencia: 'desc' },
        select: { secuencia: true }
      }),
      tx.facturaElectronica.findMany({
        where: whereElectronicaFilter,
        select: { nro_factura: true },
        orderBy: { created_at: 'desc' },
        take: 25
      })
    ]);

    const maxSecuenciaElectronica = (ultimasElectronicas || []).reduce((max, item) => {
      const parsed = parseSecuenciaFromNumero(item.nro_factura);
      return Math.max(max, parsed || 0);
    }, 0);

    const maxSecuencia = Math.max(ultimoDigital?.secuencia || 0, maxSecuenciaElectronica);
    return maxSecuencia + 1;
  };

  const overrideMin = getMinSecuenciaOverride(timbrado);

  const scoped = await fetchMaxes(whereDigital, whereElectronica);
  return Math.max(scoped, overrideMin);
}

async function resolveSecuenciaNotaCredito(tx, timbrado, _sucursalId) {
  const establecimiento = (timbrado.establecimiento || '001').padStart(3, '0');
  const puntoExpedicion = (timbrado.punto_expedicion || timbrado.punto || '001').padStart(3, '0');
  const nroNotaPrefix = `${establecimiento}-${puntoExpedicion}-`;

  const [ultimaNotaDigital, ultimasNotasElectronicas] = await Promise.all([
    tx.notaCreditoElectronica.findFirst({
      where: {
        timbrado: timbrado.numero,
        establecimiento,
        punto_expedicion: puntoExpedicion,
        deleted_at: null
      },
      orderBy: { secuencia: 'desc' },
      select: { secuencia: true }
    }),
    tx.notaCreditoElectronica.findMany({
      where: {
        nro_nota: {
          startsWith: nroNotaPrefix
        },
        deleted_at: null
      },
      select: { nro_nota: true },
      orderBy: { created_at: 'desc' },
      take: 25
    })
  ]);

  const maxSecuenciaElectronica = (ultimasNotasElectronicas || []).reduce((max, item) => {
    const parsed = parseSecuenciaFromNumero(item.nro_nota);
    return Math.max(max, parsed || 0);
  }, 0);

  const nextSecuencia = Math.max(ultimaNotaDigital?.secuencia || 0, maxSecuenciaElectronica) + 1;
  return Math.max(nextSecuencia, getMinSecuenciaOverride(timbrado));
}

function toDateOnlyString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function deriveCreditoDescripcion(descripcion, fechaEmision, fechaVencimiento) {
  if (descripcion && descripcion.trim()) return descripcion.trim().slice(0, 10);
  if (fechaEmision && fechaVencimiento) {
    const diffMs = new Date(fechaVencimiento).getTime() - new Date(fechaEmision).getTime();
    const dias = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
    return `${dias} dias`.slice(0, 10);
  }
  return '30 dias';
}

function normalizeCuotas(cuotas) {
  if (!Array.isArray(cuotas)) return [];
  return cuotas
    .map((cuota, idx) => {
      const monto = round(Number(cuota?.monto) || 0, 2);
      const numero = Number(cuota?.numero) || idx + 1;
      const fechaVencimiento = toDateOnlyString(cuota?.fecha_vencimiento || cuota?.fechaVencimiento);
      if (!monto || !fechaVencimiento) return null;
      return { numero, monto, fechaVencimiento };
    })
    .filter(Boolean)
    .sort((a, b) => a.numero - b.numero);
}

function buildCreditoSection(venta, opciones, totalPago, fechaEmision) {
  const condicionVenta = normalizeCondicionVenta(opciones?.condicion_pago || venta?.condicion_venta, opciones?.credito);
  const esCredito = condicionVenta === 'CREDITO';

  if (!esCredito) {
    return {
      condicionVenta,
      condicionPago: 1,
      pagos: [
        {
          tipoPago: '1',
          monto: totalPago
        }
      ],
      credito: null
    };
  }

  const creditoConfig = opciones?.credito || venta?.credito_config || venta?.factura_electronica?.respuesta_set?.credito;
  const fechaVencimiento = opciones?.fecha_vencimiento || creditoConfig?.fecha_vencimiento || venta?.fecha_vencimiento;
  const entregaInicial = round(Number(creditoConfig?.entrega_inicial) || 0, 4);
  const saldoFinanciado = Number.isFinite(Number(creditoConfig?.saldo_financiado))
    ? round(Number(creditoConfig.saldo_financiado), 4)
    : round(Math.max(totalPago - entregaInicial, 0), 4);
  const pagos = entregaInicial > 0
    ? [
        {
          tipoPago: '1',
          monto: entregaInicial
        }
      ]
    : [];

  const cuotasNormalizadas = normalizeCuotas(creditoConfig?.cuotas);
  if (creditoConfig && (creditoConfig?.tipo === 'CUOTAS' || cuotasNormalizadas.length)) {
    const cuotasPayload = cuotasNormalizadas.length
      ? cuotasNormalizadas
      : [
          {
            numero: 1,
            monto: saldoFinanciado,
            fechaVencimiento: toDateOnlyString(fechaVencimiento) || toDateOnlyString(fechaEmision)
          }
        ];
    const cantidadCuota = cuotasPayload.length || creditoConfig.cantidad_cuotas || 1;

    return {
      condicionVenta,
      condicionPago: 2,
      pagos,
      credito: {
        condicionCredito: 2,
          cantidadCuota: cantidadCuota,
          cuotas: cuotasPayload.map((c, idx) => ({
            numero: Number(c.numero) || idx + 1,
            monto: round(Number(c.monto) || 0, 2),
            fechaVencimiento: c.fechaVencimiento
          }))
      }
    };
  }

  const descripcionRaw = deriveCreditoDescripcion(creditoConfig?.descripcion, fechaEmision, fechaVencimiento);
  const descripcion = descripcionRaw ? String(descripcionRaw).slice(0, 10) : '30 dias';

  return {
    condicionVenta,
    condicionPago: 2,
    pagos,
    credito: {
      condicionCredito: 1,
      descripcion
    }
  };
}

function buildFactPyPayload(venta, factura, opciones = {}) {
  if (!venta) {
    throw new Error('Venta requerida para FactPy');
  }
  if (venta.moneda && String(venta.moneda).toUpperCase() === 'USD' && (!venta.tipo_cambio || Number(venta.tipo_cambio) <= 0)) {
    throw new Error('Venta en USD sin tipo de cambio válido.');
  }
  const parseMonto = (value) => {
    if (typeof value === 'string') {
      const normalized = value.replace(/\./g, '').replace(/,/g, '.');
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : Number(value);
    }
    return Number(value);
  };

  const timbradoSeleccionado = selectTimbradoParaVenta(venta, empresaConfig);
  const numeroFactura = factura?.nro_factura || generarNumeroFactura(venta, timbradoSeleccionado);
  const secuencia = (numeroFactura.split('-').pop() || '0000001').replace(/[^0-9]/g, '').padStart(7, '0');
  const fecha = venta?.created_at ? new Date(venta.created_at) : new Date();
  const cliente = resolveClienteFiscal(venta?.cliente);
  const nombreCliente = cliente.nombre;
  const rucCliente = cliente.ruc;
  const direccionCliente = cliente.direccion;
  const correoCliente = cliente.correo;
  const moneda = (venta?.moneda || 'PYG').toUpperCase();
  const cambio = parseMonto(venta?.tipo_cambio) || 0;
  if (moneda === 'USD' && (!Number.isFinite(cambio) || cambio <= 0)) {
    throw new Error('Venta en USD sin tipo de cambio válido para FactPy/SIFEN');
  }
  const establecimiento = process.env.FACTPY_ESTABLECIMIENTO || timbradoSeleccionado.establecimiento || '001';
  const punto = process.env.FACTPY_PUNTO || timbradoSeleccionado.punto_expedicion || timbradoSeleccionado.punto || '001';
  const descuentoTotalGs = parseMonto(venta?.descuento_total) || 0;
  const descuentoTotal = (() => {
    if (moneda === 'USD') {
      if (cambio && cambio > 0) {
        return round(descuentoTotalGs / cambio, 4);
      }
      return 0;
    }
    return descuentoTotalGs;
  })();

  const random9 = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');

  const convertirMonto = (monto) => {
    const valor = parseMonto(monto) || 0;
    if (moneda === 'USD') {
      if (!cambio || cambio <= 0) return 0;
      return round(valor / cambio, 4);
    }
    return round(valor, 2);
  };

  const rawItems = Array.isArray(venta?.detalles)
    ? venta.detalles.map((detalle, idx) => {
        const cantidad = Number(detalle?.cantidad) || 1;
        const snapshot = getSaleDetailSnapshot(detalle, venta);
        const precioUnitarioGs = snapshot.unitGs || Number(detalle?.producto?.precio_venta) || 0;
        const precioUnitarioConvertido = convertirMonto(precioUnitarioGs);
        const precioUnitario = moneda === 'USD'
          ? (snapshot.unitCurrency ?? precioUnitarioConvertido ?? round(precioUnitarioGs, 4))
          : (snapshot.unitCurrency ?? round(precioUnitarioGs, 2));
        const precioTotalBruto = moneda === 'USD'
          ? round(snapshot.subtotalCurrency ?? (precioUnitario * cantidad), 4)
          : round(snapshot.subtotalCurrency ?? (precioUnitario * cantidad), 2);
        const ivaTasaRaw =
          detalle?.iva_porcentaje ?? detalle?.producto?.iva_porcentaje ?? venta?.iva_porcentaje;
        const ivaTasa = Number.isFinite(Number(ivaTasaRaw)) ? Number(ivaTasaRaw) : 10;
        const descripcion = detalle?.producto?.nombre || 'Item de venta';
        const codigo = detalle?.producto?.sku || detalle?.productoId || `ITEM-${idx + 1}`;
        return {
          descripcion,
          codigo,
          unidadMedida: 77,
          ivaTasa,
          ivaAfecta: ivaTasa === 0 ? 0 : 1,
          cantidad,
          precioUnitario,
          precioTotalBruto
        };
      })
    : [];

  const totalPagoBruto = round(rawItems.reduce((sum, item) => sum + (Number(item.precioTotalBruto) || 0), 0), 4);
  const descuentoAplicable = totalPagoBruto > 0 ? Math.min(descuentoTotal, totalPagoBruto) : 0;
  const decimals = moneda === 'USD' ? 4 : 2;
  const lastIndex = rawItems.length - 1;
  let descuentoAsignado = 0;

  const items = rawItems.map((item, idx) => {
    const bruto = Number(item.precioTotalBruto) || 0;
    const descuentoLinea = (() => {
      if (descuentoAplicable <= 0 || totalPagoBruto <= 0) return 0;
      if (idx === lastIndex) {
        return round(Math.max(descuentoAplicable - descuentoAsignado, 0), decimals);
      }
      const proporcional = round((descuentoAplicable * bruto) / totalPagoBruto, decimals);
      descuentoAsignado += proporcional;
      return proporcional;
    })();
    const descuentoUnitario = item.cantidad > 0
      ? Number((descuentoLinea / item.cantidad).toFixed(8))
      : 0;
    const precioTotal = round(Math.max(bruto - descuentoLinea, 0), decimals);
    const divisor = item.ivaTasa === 5 ? 1.05 : item.ivaTasa === 10 ? 1.1 : 1;
    const baseGravItem = Number(divisor ? (precioTotal / divisor).toFixed(8) : precioTotal.toFixed(8));
    const liqIvaItem = item.ivaTasa === 0 ? 0 : Number((precioTotal - baseGravItem).toFixed(8));

    return {
      descripcion: item.descripcion,
      codigo: item.codigo,
      unidadMedida: item.unidadMedida,
      ivaTasa: item.ivaTasa,
      ivaAfecta: item.ivaAfecta,
      cantidad: item.cantidad,
      descuento: descuentoUnitario,
      precioUnitario: item.precioUnitario,
      precioTotal,
      baseGravItem,
      liqIvaItem
    };
  });

  const totalPago = round(items.reduce((sum, item) => sum + (Number(item.precioTotal) || 0), 0), 4);

  const totalMoneda = moneda === 'USD'
    ? round(Number(venta?.total_moneda) || totalPago, 4)
    : round(Number(venta?.total) || totalPago, 2);

  const totalGs = moneda === 'USD'
    ? (() => {
        if (cambio && cambio > 0) return round(totalPago * cambio, 2);
        const totalGuardado = Number(venta?.total) || 0;
        if (totalGuardado > 0) return round(totalGuardado, 2);
        if (totalMoneda > 0 && cambio > 0) return round(totalMoneda * cambio, 2);
        return round(totalPago, 2);
      })()
    : totalMoneda;

  const credito = buildCreditoSection(venta, opciones, totalPago, fecha);

  return {
    fecha: fecha.toISOString().replace('T', ' ').slice(0, 19),
    establecimiento,
    punto,
    numero: secuencia,
    descripcion: factura?.id || venta?.id,
    tipoDocumento: 1,
    tipoEmision: 1,
    tipoTransaccion: 1,
    receiptid: venta.id,
    condicionPago: credito.condicionPago,
    moneda,
    cambio,
    cliente: {
      ruc: rucCliente,
      nombre: nombreCliente,
      direccion: direccionCliente,
      cpais: 'PRY',
      correo: correoCliente,
      numCasa: 0,
      diplomatico: false,
      dncp: 0
    },
    codigoSeguridadAleatorio: random9,
    items,
    pagos: credito.pagos,
    ...(credito.credito ? { credito: credito.credito } : {}),
    descuentoGlobal: 0,
    totalPago,
    totalGs,
    // mantenemos totalPagoGs para compatibilidad con integraciones previas
    totalPagoGs: totalGs,
    totalPagoMoneda: totalMoneda,
    totalRedondeo: 0
  };
}

function buildNotaCreditoData(venta, opciones = {}) {
  const tipoAjuste = String(opciones?.tipoAjuste || 'TOTAL').toUpperCase() === 'PARCIAL' ? 'PARCIAL' : 'TOTAL';
  const ventaDetalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  if (!ventaDetalles.length) {
    throw new VentaValidationError('La venta no tiene ítems para emitir una nota de crédito.');
  }

  const moneda = normalizeCurrency(venta?.moneda);
  const tipoCambio = Number(venta?.tipo_cambio) || 0;
  if (moneda === 'USD' && (!Number.isFinite(tipoCambio) || tipoCambio <= 0)) {
    throw new VentaValidationError('La venta en USD no tiene tipo de cambio válido para emitir la nota de crédito.');
  }

  const detallePorId = new Map(ventaDetalles.map((detalle) => [detalle.id, detalle]));
  const detallesSolicitados = Array.isArray(opciones?.detallesSolicitados) ? opciones.detallesSolicitados : [];
  const subtotalBrutoVentaGs = round(
    ventaDetalles.reduce((acc, detalle) => acc + Math.max(Number(detalle?.subtotal) || 0, 0), 0),
    2
  );
  const descuentoVentaGs = Math.max(Number(venta?.descuento_total) || 0, 0);
  const factorDescuento = subtotalBrutoVentaGs > 0
    ? Math.max(subtotalBrutoVentaGs - descuentoVentaGs, 0) / subtotalBrutoVentaGs
    : 1;

  const selecciones = tipoAjuste === 'PARCIAL'
    ? Array.from(
        detallesSolicitados.reduce((map, item) => {
          const detalleVentaId = item?.detalleVentaId;
          const cantidad = Number(item?.cantidad) || 0;
          map.set(detalleVentaId, (map.get(detalleVentaId) || 0) + cantidad);
          return map;
        }, new Map())
      ).map(([detalleVentaId, cantidad]) => ({ detalleVentaId, cantidad }))
    : ventaDetalles.map((detalle) => ({
        detalleVentaId: detalle.id,
        cantidad: Number(detalle.cantidad) || 0
      }));

  if (!selecciones.length) {
    throw new VentaValidationError('Debes seleccionar al menos un ítem para la nota de crédito.');
  }

  const detalles = selecciones.map((seleccion, idx) => {
    const original = detallePorId.get(seleccion.detalleVentaId);
    if (!original) {
      throw new VentaValidationError(`El ítem seleccionado #${idx + 1} no existe en la venta.`);
    }

    const cantidadOriginal = Number(original.cantidad) || 0;
    const cantidad = Number(seleccion.cantidad) || 0;
    if (!cantidadOriginal || cantidad <= 0 || cantidad > cantidadOriginal) {
      throw new VentaValidationError(`La cantidad para ${original?.producto?.nombre || 'el ítem seleccionado'} excede lo vendido.`);
    }

    const snapshot = getSaleDetailSnapshot(original, venta);
    const ratioCantidad = cantidadOriginal > 0 ? cantidad / cantidadOriginal : 0;
    const subtotalBrutoGs = round((snapshot.subtotalGs || 0) * ratioCantidad, 2);
    const subtotalGs = round(subtotalBrutoGs * factorDescuento, 2);
    if (subtotalGs <= 0) {
      throw new VentaValidationError(`El subtotal calculado para ${original?.producto?.nombre || 'el ítem seleccionado'} no es válido.`);
    }
    const precioUnitarioGs = round(subtotalGs / cantidad, 4);

    const subtotalBrutoMoneda = moneda === 'USD'
      ? round((snapshot.subtotalCurrency || 0) * ratioCantidad, 4)
      : round(((snapshot.subtotalCurrency ?? snapshot.subtotalGs) || 0) * ratioCantidad, 2);
    const subtotalMoneda = moneda === 'USD'
      ? round(subtotalBrutoMoneda * factorDescuento, 4)
      : round(subtotalBrutoMoneda * factorDescuento, 2);
    const precioUnitarioMoneda = moneda === 'USD'
      ? round(subtotalMoneda / cantidad, 4)
      : round(subtotalMoneda / cantidad, 2);

    return {
      detalleVentaId: original.id,
      productoId: original.productoId || null,
      descripcion: original?.producto?.nombre || `Ítem ${idx + 1}`,
      codigoProducto: original?.producto?.sku || original?.productoId || `ITEM-NC-${idx + 1}`,
      cantidad,
      precioUnitarioGs,
      subtotalGs,
      precioUnitarioMoneda,
      subtotalMoneda,
      ivaPorcentaje: Number.isFinite(Number(original?.iva_porcentaje ?? original?.producto?.iva_porcentaje ?? venta?.iva_porcentaje))
        ? Number(original?.iva_porcentaje ?? original?.producto?.iva_porcentaje ?? venta?.iva_porcentaje)
        : 10
    };
  });

  const totalGs = round(detalles.reduce((acc, detalle) => acc + Number(detalle.subtotalGs || 0), 0), 2);
  const totalMoneda = moneda === 'USD'
    ? round(detalles.reduce((acc, detalle) => acc + Number(detalle.subtotalMoneda || 0), 0), 4)
    : null;

  return {
    tipoAjuste,
    detalles,
    totalGs,
    totalMoneda
  };
}

function buildFactPyCreditNotePayload(venta, facturaOriginal, notaCredito, opciones = {}) {
  if (!venta || !facturaOriginal || !notaCredito) {
    throw new Error('Faltan datos para construir la nota de crédito de FactPy.');
  }

  const moneda = normalizeCurrency(venta.moneda);
  const cambio = Number(venta.tipo_cambio) || 0;
  if (moneda === 'USD' && (!Number.isFinite(cambio) || cambio <= 0)) {
    throw new Error('La nota de crédito en USD requiere tipo de cambio válido.');
  }

  const cliente = resolveClienteFiscal(venta?.cliente);
  const cdcAsociado = opciones.cdcAsociado || extractFacturaCdc(facturaOriginal);
  const fechaEmision = new Date(notaCredito.fecha_emision || Date.now());
  const detallesSeleccionados = Array.isArray(opciones.detallesSeleccionados) && opciones.detallesSeleccionados.length
    ? opciones.detallesSeleccionados
    : buildNotaCreditoData(venta, { tipoAjuste: notaCredito.tipo_ajuste }).detalles;
  const totalNotaGs = Math.abs(Number(notaCredito.total) || 0);
  const totalNotaMoneda = moneda === 'USD'
    ? Math.abs(Number(notaCredito.total_moneda) || 0)
    : totalNotaGs;
  const convertAmount = (amountGs) => {
    const numeric = Math.abs(Number(amountGs) || 0);
    if (moneda === 'USD') {
      return round(numeric / cambio, 4);
    }
    return round(numeric, 2);
  };

  const items = detallesSeleccionados.map((detalle, idx) => {
        const cantidad = Math.abs(Number(detalle.cantidad) || 0);
        const precioUnitario = moneda === 'USD'
          ? round(Math.abs(Number(detalle.precioUnitarioMoneda) || convertAmount(detalle.precioUnitarioGs)), 4)
          : round(Math.abs(Number(detalle.precioUnitarioGs) || 0), 2);
        const precioTotal = moneda === 'USD'
          ? -round(Math.abs(Number(detalle.subtotalMoneda) || (precioUnitario * cantidad)), 4)
          : -round(Math.abs(Number(detalle.subtotalGs) || (precioUnitario * cantidad)), 2);
        const ivaTasa = Number.isFinite(Number(detalle?.ivaPorcentaje)) ? Number(detalle.ivaPorcentaje) : 10;
        const divisor = ivaTasa === 5 ? 1.05 : ivaTasa === 10 ? 1.1 : 1;
        const baseGravItem = ivaTasa === 0 ? precioTotal : Number((precioTotal / divisor).toFixed(8));
        const liqIvaItem = ivaTasa === 0 ? 0 : Number((precioTotal - baseGravItem).toFixed(8));
        return {
          descripcion: detalle.descripcion || 'Item nota de crédito',
          codigo: detalle.codigoProducto || detalle.productoId || `ITEM-NC-${idx + 1}`,
          tipoIva: ivaTasa === 5 ? 'I.V.A. 5%' : ivaTasa === 10 ? 'I.V.A. 10%' : 'EXENTO',
          unidadMedida: 77,
          ivaTasa,
          ivaAfecta: ivaTasa === 0 ? 3 : 1,
          cantidad: -cantidad,
          precioUnitario,
          precioTotal,
          baseGravItem,
          liqIvaItem
        };
      });

  const creditoBase = buildCreditoSection(
    venta,
    {
      condicion_pago: venta?.condicion_venta,
      fecha_vencimiento: venta?.fecha_vencimiento,
      credito: venta?.credito_config || facturaOriginal?.respuesta_set?.credito || null
    },
    round(totalNotaMoneda, 4),
    fechaEmision
  );

  const pagos = Array.isArray(creditoBase?.pagos) && creditoBase.pagos.length
    ? creditoBase.pagos.map((pago) => ({
        ...pago,
        monto: -Math.abs(round(totalNotaMoneda, 4))
      }))
    : [
        {
          tipoPago: '1',
          monto: -round(totalNotaMoneda, 4)
        }
      ];

  const credito = creditoBase?.credito
    ? {
        ...creditoBase.credito,
        ...(Array.isArray(creditoBase.credito.cuotas)
          ? {
              cuotas: scaleCreditNoteCuotas(creditoBase.credito.cuotas, totalNotaMoneda)
            }
          : {})
      }
    : null;

  return {
    fecha: fechaEmision.toISOString().replace('T', ' ').slice(0, 19),
    documentoAsociado: {
      remision: false,
      tipoDocumentoAsoc: '1',
      cdcAsociado,
      establecimientoAsoc: '',
      puntoAsoc: '',
      numeroAsoc: '',
      tipoDocuemntoIm: '',
      fechaDocIm: '',
      timbradoAsoc: ''
    },
    establecimiento: notaCredito.establecimiento,
    punto: notaCredito.punto_expedicion,
    numero: String(notaCredito.secuencia).padStart(7, '0'),
    descripcion: opciones.motivo || notaCredito.motivo,
    tipoDocumento: 5,
    tipoEmision: 1,
    tipoTransaccion: 1,
    receiptid: `nc_${notaCredito.id}`,
    condicionPago: creditoBase?.condicionPago || 1,
    moneda,
    cambio,
    cliente: {
      ruc: cliente.ruc,
      nombre: cliente.nombre,
      direccion: cliente.direccion,
      cpais: 'PRY',
      correo: cliente.correo,
      numCasa: 0,
      diplomatico: false,
      dncp: 0
    },
    codigoSeguridadAleatorio: String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0'),
    items,
    pagos,
    ...(credito ? { credito } : {}),
    totalPago: -round(totalNotaMoneda, 4),
    totalPagoGs: -round(totalNotaGs, 2)
  };
}

function resolveClienteFiscal(cliente = {}) {
  const nombre = String(cliente?.nombre_razon_social || cliente?.nombre || '').trim() || 'Consumidor Final';
  const ruc = String(cliente?.ruc || '').trim() || '44444401-7';
  const direccion = String(cliente?.direccion || cliente?.direccion_facturacion || '').trim() || 'S/D';
  const correo = String(cliente?.correo || cliente?.email || '').trim();

  return {
    nombre,
    ruc,
    direccion,
    correo
  };
}

function scaleCreditNoteCuotas(cuotas = [], totalObjetivo) {
  if (!Array.isArray(cuotas) || !cuotas.length) return [];

  const totalBase = cuotas.reduce((acc, cuota) => acc + Math.abs(Number(cuota?.monto) || 0), 0);
  if (!totalBase || totalObjetivo <= 0) {
    return cuotas.map((cuota) => ({
      ...cuota,
      monto: 0
    }));
  }

  let acumulado = 0;
  return cuotas.map((cuota, index) => {
    const esUltima = index === cuotas.length - 1;
    const proporcion = Math.abs(Number(cuota?.monto) || 0) / totalBase;
    const monto = esUltima
      ? round(totalObjetivo - acumulado, 4)
      : round(totalObjetivo * proporcion, 4);
    acumulado = round(acumulado + monto, 4);
    return {
      ...cuota,
      monto: -Math.abs(monto)
    };
  });
}

function extractFacturaCdc(factura) {
  const candidates = [factura?.respuesta_set?.factpy?.cdc, factura?.respuesta_set?.cdc, factura?.qr_data];
  for (const candidate of candidates) {
    const normalized = String(candidate || '').replace(/\s+/g, '').trim();
    if (normalized && normalized.length >= 20) return normalized;
  }
  return null;
}

function normalizeFactpyExternalUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/iu.test(raw)) return `https://${raw}`;
  return raw;
}

function selectTimbradoParaVenta(venta, config) {
  const baseTimbrado = config?.timbrado || {};
  const overrides = Array.isArray(config?.timbradosPorSucursal) ? config.timbradosPorSucursal : [];
  if (!venta) return baseTimbrado;
  const sucursalId = venta.sucursalId || venta.sucursal?.id;
  const sucursalNombre = (venta.sucursal?.nombre || '').trim().toLowerCase();
  const match = overrides.find((item) => {
    if (item.sucursalId && sucursalId && item.sucursalId === sucursalId) return true;
    if (item.nombre && sucursalNombre && sucursalNombre === String(item.nombre).trim().toLowerCase()) return true;
    return false;
  });
  if (match) {
    return { ...baseTimbrado, ...match };
  }
  return baseTimbrado;
}

function construirQrPlaceholder(venta, nroFactura) {
  const total = Number(venta?.total) || 0;
  const fecha = new Date(venta?.created_at || Date.now()).toISOString();
  return JSON.stringify({
    factura: nroFactura,
    total,
    fecha,
    cliente: venta?.cliente?.ruc || 'S/D'
  });
}

async function buildFacturaQrImage(factura, venta) {
  const nroFactura = factura?.nro_factura || generarNumeroFactura(venta);
  const rawPayload = factura?.qr_data || construirQrPlaceholder(venta, nroFactura);
  const payloadString = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

  try {
    return await QRCode.toBuffer(payloadString || nroFactura, {
      width: 180,
      margin: 1,
      errorCorrectionLevel: 'M'
    });
  } catch (qrError) {
    console.error('[Factura] No se pudo generar el código QR.', qrError);
    return null;
  }
}

async function generarArchivosFactura(venta, factura) {
  if (!venta || !factura) return null;

  const storageDir = path.join(__dirname, '..', '..', 'storage');
  const facturaDir = path.join(storageDir, 'facturas');
  await fsPromises.mkdir(facturaDir, { recursive: true });

  const filenameSafe = (factura.nro_factura || factura.id || randomUUID()).replace(/[^a-zA-Z0-9-_]/gu, '_');
  const pdfFilename = `${filenameSafe}.pdf`;
  const xmlFilename = `${filenameSafe}.xml`;
  const pdfAbsolutePath = path.join(facturaDir, pdfFilename);
  const xmlAbsolutePath = path.join(facturaDir, xmlFilename);
  const pdfWebPath = `/storage/facturas/${pdfFilename}`;
  const xmlWebPath = `/storage/facturas/${xmlFilename}`;

  const qrBuffer = await buildFacturaQrImage(factura, venta);
  const doc = new PDFDocument({ size: 'A4', margin: 28 });
  const writeStream = fs.createWriteStream(pdfAbsolutePath);
  doc.pipe(writeStream);

  renderFacturaPdf(doc, venta, factura, qrBuffer);
  doc.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  try {
    const xmlPayload = buildFacturaXml(venta, factura);
    await fsPromises.writeFile(xmlAbsolutePath, xmlPayload, 'utf8');
  } catch (xmlError) {
    console.error('[Factura] No se pudo generar el XML de referencia.', xmlError);
  }

  return { pdfWebPath, xmlWebPath };
}

function renderFacturaPdf(doc, venta, factura, qrBuffer) {
  const logoPath = path.join(__dirname, '..', 'public', 'img', 'logo.png');
  const hasLogo = fs.existsSync(logoPath);
  const nroFactura = factura?.nro_factura || generarNumeroFactura(venta);
  const fechaEmision = factura?.fecha_emision || venta?.fecha || venta?.created_at || new Date();
  const margins = doc.page.margins;
  const contentWidth = doc.page.width - margins.left - margins.right;
  const startX = margins.left;
  let cursorY = margins.top;

  try {
    if (hasLogo) {
      doc.image(logoPath, startX + 16, cursorY + 12, { fit: [110, 60] });
    }
  } catch (logoError) {
    console.warn('[Factura] No se pudo incrustar el logo.', logoError);
  }

  doc.save();
  doc.roundedRect(startX, cursorY, contentWidth, 92, 8).stroke('#cbd5f5');
  doc.restore();

  const headerLeftX = hasLogo ? startX + 140 : startX + 18;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a').text(EMPRESA_INFO.nombre, headerLeftX, cursorY + 12, {
    width: contentWidth / 2 - 20
  });
  doc.font('Helvetica').fontSize(9).fillColor('#1f2937');
  doc.text(`RUC: ${EMPRESA_INFO.ruc}`, headerLeftX);
  doc.text(EMPRESA_INFO.direccion, headerLeftX);
  if (EMPRESA_INFO.telefono) doc.text(`Tel: ${EMPRESA_INFO.telefono}`, headerLeftX);
  if (EMPRESA_INFO.email) doc.text(`Email: ${EMPRESA_INFO.email}`, headerLeftX);

  const headerRightX = startX + contentWidth / 2;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a');
  doc.text('KuDE - Factura electrónica', headerRightX, cursorY + 14, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  doc.text(`Factura N° ${nroFactura}`, headerRightX, doc.y + 2, { width: contentWidth / 2 - 20, align: 'right' });
  doc.text(`Fecha: ${formatDatePrintable(fechaEmision)}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Timbrado: ${factura?.timbrado || 'No informado'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Estado: ${factura?.estado || '-'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Ambiente: ${factura?.ambiente || 'PRUEBA'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });
  doc.text(`Condición: ${venta?.condicion_venta || 'CONTADO'}`, headerRightX, doc.y, {
    width: contentWidth / 2 - 20,
    align: 'right'
  });

  cursorY += 108;

  const blockWidth = contentWidth / 2 - 8;
  const emisorRows = [
    { label: 'Contribuyente', value: EMPRESA_INFO.nombre },
    { label: 'RUC', value: EMPRESA_INFO.ruc },
    { label: 'Dirección', value: EMPRESA_INFO.direccion },
    { label: 'Teléfono', value: EMPRESA_INFO.telefono || '-' }
  ];
  const cliente = venta?.cliente || {};
  const clienteRows = [
    { label: 'Cliente', value: cliente.nombre_razon_social || 'Cliente eventual' },
    { label: 'RUC/CI', value: cliente.ruc || 'S/D' },
    { label: 'Teléfono', value: cliente.telefono || '-' },
    { label: 'Correo', value: cliente.correo || '-' }
  ];

  const emisorBottom = renderInfoBlock(doc, 'Datos del emisor', emisorRows, startX, cursorY, blockWidth);
  const clienteBottom = renderInfoBlock(doc, 'Datos del receptor', clienteRows, startX + blockWidth + 16, cursorY, blockWidth);
  cursorY = Math.max(emisorBottom, clienteBottom) + 16;

  cursorY = renderDetalleItems(doc, venta, startX, cursorY, contentWidth) + 16;

  const totals = computeInvoiceTotals(venta);
  const breakdown = computeIvaBreakdown(venta);
  const totalsWidth = contentWidth * 0.55;
  const qrWidth = contentWidth - totalsWidth - 16;
  const totalsBottom = renderTotalsBlock(doc, venta, totals, breakdown, startX, cursorY, totalsWidth);
  const qrBottom = renderQrPanel(doc, factura, qrBuffer, startX + totalsWidth + 16, cursorY, qrWidth);

  cursorY = Math.max(totalsBottom, qrBottom) + 18;
  doc.font('Helvetica').fontSize(8).fillColor('#4b5563');
  doc.text(
    'Documento generado electrónicamente por TRIDENT INNOVA E.A.S. Consulte la validez en https://ekuatia.set.gov.py/consultas',
    startX,
    cursorY,
    { width: contentWidth, align: 'center' }
  );
}

function renderVentaTicketPdf(doc, venta) {
  const printable = buildTicketPrintableData(venta);
  const margins = doc.page.margins;
  const pageWidth = doc.page.width - margins.left - margins.right;
  const pageHeight = doc.page.height - margins.top - margins.bottom;
  const startX = margins.left;
  const maxY = margins.top + pageHeight;
  let cursorY = margins.top;

  const hasLogo = fs.existsSync(REPORT_LOGO_PATH);
  if (hasLogo) {
    try {
      doc.image(REPORT_LOGO_PATH, startX + 6, cursorY + 6, { fit: [86, 86], align: 'left' });
    } catch (logoError) {
      console.warn('[Ticket] No se pudo incrustar el logo.', logoError);
    }
  }

  const headerBlockWidth = Math.min(360, pageWidth - 140);
  const headerTextX = startX + (pageWidth - headerBlockWidth) / 2;
  const headerTextWidth = headerBlockWidth;
  const badgeWidth = 120;
  const badgeX = headerTextX + (headerTextWidth - badgeWidth) / 2;
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text('Ticket de venta', headerTextX, cursorY + 4, {
    width: headerTextWidth,
    align: 'center'
  });
  doc.font('Helvetica').fontSize(10).fillColor('#374151');
  doc.text('Documento interno de venta contado', headerTextX, cursorY + 30, {
    width: headerTextWidth,
    align: 'center'
  });
  doc.text(`Ticket N° ${printable.ticketNumber}`, headerTextX, cursorY + 50, {
    width: headerTextWidth,
    align: 'center'
  });
  doc.roundedRect(badgeX, cursorY + 64, badgeWidth, 22, 11).fill('#fff1e6');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#c2410c').text(
    printable.primaryCurrency === 'USD' ? 'Venta en USD' : 'Venta en guaraníes',
    badgeX,
    cursorY + 71,
    { width: badgeWidth, align: 'center' }
  );
  doc.moveTo(startX, cursorY + 102).lineTo(startX + pageWidth, cursorY + 102).lineWidth(1).stroke('#e5e7eb');

  cursorY += 116;

  const blockGap = 16;
  const blockWidth = (pageWidth - blockGap) / 2;
  const infoPadding = 14;
  const cliente = venta?.cliente || {};
  const usuario = venta?.usuario || {};
  const sucursal = venta?.sucursal || {};

  const companyRows = [
    { label: 'Empresa', value: EMPRESA_INFO.nombre },
    { label: 'RUC', value: EMPRESA_INFO.ruc },
    { label: 'Sucursal', value: sucursal.nombre || 'Principal' },
    { label: 'Dirección', value: sucursal.direccion || EMPRESA_INFO.direccion }
  ];
  const saleRows = [
    { label: 'Fecha', value: formatDatePrintable(venta?.fecha || venta?.created_at) },
    { label: 'Moneda', value: printable.primaryCurrency },
    { label: 'Cambio', value: printable.exchangeRateSummary },
    { label: 'Vendedor', value: usuario.nombre || usuario.usuario || '-' }
  ];

  const infoBoxHeight = Math.max(
    measureTicketInfoCardHeight(doc, companyRows, blockWidth, { labelWidth: 82, padding: infoPadding }),
    measureTicketInfoCardHeight(doc, saleRows, blockWidth, { labelWidth: 82, padding: infoPadding })
  );

  renderTicketInfoCard(doc, 'Emisor', companyRows, startX, cursorY, blockWidth, infoBoxHeight, {
    labelWidth: 82,
    padding: infoPadding
  });
  renderTicketInfoCard(doc, 'Operación', saleRows, startX + blockWidth + blockGap, cursorY, blockWidth, infoBoxHeight, {
    labelWidth: 82,
    padding: infoPadding
  });

  cursorY += infoBoxHeight + 18;
  const clientRows = buildTicketClientRows(cliente, venta);
  const clientBoxHeight = measureTicketInfoCardHeight(doc, clientRows, pageWidth, {
    labelWidth: 88,
    padding: infoPadding,
    columns: 2,
    titleHeight: 24,
    minHeight: 84
  });
  renderTicketInfoCard(doc, 'Cliente', clientRows, startX, cursorY, pageWidth, clientBoxHeight, {
    labelWidth: 88,
    padding: infoPadding,
    columns: 2,
    titleHeight: 24,
    badgeWidth: 96
  });

  cursorY += clientBoxHeight + 22;
  const table = buildTicketPdfColumns(pageWidth);
  cursorY = drawTicketPdfHeaderRow(doc, table, startX, cursorY);

  printable.items.forEach((item) => {
    const rowHeight = 22;
    if (cursorY + rowHeight > maxY - 190) {
      doc.addPage();
      cursorY = margins.top;
      cursorY = drawTicketPdfHeaderRow(doc, table, startX, cursorY);
    }

    doc.rect(startX, cursorY, pageWidth, rowHeight).lineWidth(1).stroke('#e5e7eb');
    const row = {
      codigo: item.codigo,
      descripcion: item.descripcion,
      cantidad: formatNumberPrintable(item.cantidad),
      precio: formatCurrencyPrintable(item.precioUnitario, printable.primaryCurrency),
      subtotal: formatCurrencyPrintable(item.subtotal, printable.primaryCurrency),
      iva: item.ivaLabel
    };

    let cellX = startX;
    table.forEach((column) => {
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(row[column.key] || '-', cellX + 4, cursorY + 6, {
        width: column.width - 8,
        align: column.align
      });
      cellX += column.width;
    });

    cursorY += rowHeight;
  });

  cursorY += 18;
  const summaryWidth = pageWidth * 0.5;
  const sideWidth = pageWidth - summaryWidth - 18;
  const summaryBottom = renderTicketPdfSummary(doc, printable, startX, cursorY, summaryWidth);
  const sideBottom = renderTicketPdfMeta(doc, printable, startX + summaryWidth + 18, cursorY, sideWidth);
  cursorY = Math.max(summaryBottom, sideBottom) + 18;

  doc.font('Helvetica').fontSize(9).fillColor('#374151').text(
    `Total en letras: ${montoEnLetras(printable.primaryTotal, printable.primaryCurrency)}`,
    startX,
    cursorY,
    { width: pageWidth }
  );
  cursorY += 20;
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(
    'Este ticket respalda la venta realizada y no reemplaza una factura electrónica.',
    startX,
    cursorY,
    { width: pageWidth, align: 'center' }
  );
}

function buildTicketPrintableData(venta) {
  const primaryCurrency = normalizeCurrency(venta?.moneda);
  const exchangeRate = Number(venta?.tipo_cambio) || 0;
  const details = Array.isArray(venta?.detalles) ? venta.detalles : [];

  const items = details.map((detalle) => {
    const snapshot = getSaleDetailSnapshot(detalle, venta);
    const cantidad = Number(detalle?.cantidad) || 0;
    return {
      codigo: getDetalleCodigo(detalle),
      descripcion: detalle?.producto?.nombre || 'Producto',
      cantidad,
      precioUnitario: primaryCurrency === 'USD'
        ? round(snapshot.unitCurrency || 0, 4)
        : round(snapshot.unitCurrency || snapshot.unitGs || 0, 2),
      subtotal: primaryCurrency === 'USD'
        ? round(snapshot.subtotalCurrency || 0, 4)
        : round(snapshot.subtotalCurrency || snapshot.subtotalGs || 0, 2),
      ivaLabel: getTicketIvaLabel(getDetalleIvaPorcentaje(detalle, venta))
    };
  });

  const subtotalPrimary = round(items.reduce((acc, item) => acc + item.subtotal, 0), 2);
  const descuentoGs = Number(venta?.descuento_total) || 0;
  const descuentoPrimary = primaryCurrency === 'USD'
    ? round((exchangeRate > 0 ? descuentoGs / exchangeRate : 0), 4)
    : round(descuentoGs, 2);
  const storedPrimaryTotal = primaryCurrency === 'USD'
    ? Number(venta?.total_moneda)
    : Number(venta?.total);
  const primaryTotal = Number.isFinite(storedPrimaryTotal)
    ? round(storedPrimaryTotal, 2)
    : round(Math.max(subtotalPrimary - descuentoPrimary, 0), 2);
  const ivaPorcentaje = Number.isFinite(Number(venta?.iva_porcentaje)) ? Number(venta?.iva_porcentaje) : 10;
  const ivaDivisor = IVA_DIVISOR[ivaPorcentaje];
  const ivaPrimary = ivaDivisor && primaryTotal > 0 ? round(primaryTotal / ivaDivisor, 2) : 0;
  const totalGs = Number.isFinite(Number(venta?.total)) ? round(Number(venta.total), 2) : round(primaryTotal * exchangeRate, 2);
  const totalUsd = primaryCurrency === 'USD'
    ? primaryTotal
    : exchangeRate > 0
      ? round(totalGs / exchangeRate, 2)
      : null;

  return {
    ticketNumber: (venta?.id || 'ticket').slice(0, 8).toUpperCase(),
    primaryCurrency,
    primaryCurrencyLabel: primaryCurrency === 'USD' ? 'Dólares estadounidenses (USD)' : 'Guaraníes (PYG)',
    exchangeRate,
    exchangeRateLabel: exchangeRate > 0 ? formatExchangeRatePrintable(exchangeRate) : 'No aplica',
    exchangeRateSummary: exchangeRate > 0 ? `Gs ${formatExchangeRatePrintable(exchangeRate)}` : 'No aplica',
    items,
    subtotalPrimary,
    descuentoPrimary,
    ivaPrimary,
    primaryTotal,
    totalGs,
    totalUsd
  };
}

function buildTicketClientRows(cliente, venta) {
  const rows = [
    { label: 'Nombre', value: cliente?.nombre_razon_social || 'Cliente eventual' },
    { label: 'RUC/CI', value: cliente?.ruc || 'S/D' }
  ];

  if (cliente?.telefono) rows.push({ label: 'Teléfono', value: cliente.telefono });
  if (cliente?.correo) rows.push({ label: 'Correo', value: cliente.correo });
  if (cliente?.direccion) rows.push({ label: 'Dirección', value: cliente.direccion });

  return rows;
}

function measureSimpleInfoListHeight(doc, rows, width, options = {}) {
  const labelWidth = Number(options.labelWidth) || 92;
  const valueWidth = Math.max(width - labelWidth, 60);
  const rowGap = Number(options.rowGap) || 6;
  let totalHeight = 0;

  rows.forEach((row, index) => {
    const labelText = `${row.label || '-'}:`;
    const valueText = String(row.value || '-');
    doc.font('Helvetica-Bold').fontSize(9);
    const labelHeight = doc.heightOfString(labelText, { width: labelWidth });
    doc.font('Helvetica').fontSize(9);
    const valueHeight = doc.heightOfString(valueText, { width: valueWidth });
    totalHeight += Math.max(labelHeight, valueHeight);
    if (index < rows.length - 1) {
      totalHeight += rowGap;
    }
  });

  return totalHeight;
}

function measureTicketInfoCardHeight(doc, rows, width, options = {}) {
  const padding = Number(options.padding) || 14;
  const minHeight = Number(options.minHeight) || 94;
  const titleHeight = Number(options.titleHeight) || 24;
  const columns = Math.max(1, Number(options.columns) || 1);
  const availableWidth = width - padding * 2;
  const columnGap = Number(options.columnGap) || 18;

  let contentHeight = 0;
  if (columns === 1) {
    contentHeight = measureSimpleInfoListHeight(doc, rows, availableWidth, options);
  } else {
    const perColumnWidth = (availableWidth - columnGap * (columns - 1)) / columns;
    const groups = Array.from({ length: columns }, () => []);
    rows.forEach((row, index) => {
      groups[index % columns].push(row);
    });
    contentHeight = Math.max(
      ...groups.map((group) => measureSimpleInfoListHeight(doc, group, perColumnWidth, options)),
      0
    );
  }

  return Math.max(minHeight, contentHeight + padding * 2 + titleHeight);
}

function renderTicketInfoCard(doc, title, rows, x, y, width, height, options = {}) {
  const padding = Number(options.padding) || 14;
  const columns = Math.max(1, Number(options.columns) || 1);
  const titleHeight = Number(options.titleHeight) || 24;
  const badgeWidth = Number(options.badgeWidth) || 92;
  const columnGap = Number(options.columnGap) || 18;
  doc.roundedRect(x, y, width, height, 10).lineWidth(1).fillAndStroke('#fcfcfd', '#d1d5db');
  doc.roundedRect(x + 12, y + 10, badgeWidth, 18, 9).fill('#eef2ff');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1e3a8a').text(title, x + 12, y + 16, { width: badgeWidth, align: 'center' });

  const contentY = y + padding + titleHeight;
  const availableWidth = width - padding * 2;
  if (columns === 1) {
    renderSimpleInfoList(doc, rows, x + padding, contentY, availableWidth, options);
    return;
  }

  const perColumnWidth = (availableWidth - columnGap * (columns - 1)) / columns;
  const groups = Array.from({ length: columns }, () => []);
  rows.forEach((row, index) => {
    groups[index % columns].push(row);
  });

  groups.forEach((group, index) => {
    renderSimpleInfoList(doc, group, x + padding + index * (perColumnWidth + columnGap), contentY, perColumnWidth, options);
  });
}

function renderSimpleInfoList(doc, rows, x, y, width, options = {}) {
  const labelWidth = Number(options.labelWidth) || 92;
  const valueWidth = Math.max(width - labelWidth, 60);
  const rowGap = Number(options.rowGap) || 6;
  let cursor = y;
  rows.forEach((row) => {
    const labelText = `${row.label || '-'}:`;
    const valueText = String(row.value || '-');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151').text(labelText, x, cursor, {
      width: labelWidth,
      align: 'left'
    });
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(valueText, x + labelWidth, cursor, {
      width: valueWidth,
      align: 'left'
    });
    const rowHeight = Math.max(
      doc.heightOfString(labelText, { width: labelWidth }),
      doc.heightOfString(valueText, { width: valueWidth })
    );
    cursor += rowHeight + rowGap;
  });

  return cursor;
}

function buildTicketPdfColumns(availableWidth) {
  const fixedWidth = 72 + 48 + 92 + 104 + 64;
  return [
    { key: 'codigo', label: 'Código', width: 72, align: 'left' },
    { key: 'descripcion', label: 'Descripción', width: Math.max(160, availableWidth - fixedWidth), align: 'left' },
    { key: 'cantidad', label: 'Cant.', width: 48, align: 'right' },
    { key: 'precio', label: 'Precio unit.', width: 92, align: 'right' },
    { key: 'subtotal', label: 'Subtotal', width: 104, align: 'right' },
    { key: 'iva', label: 'IVA', width: 64, align: 'center' }
  ];
}

function drawTicketPdfHeaderRow(doc, columns, x, y) {
  const totalWidth = columns.reduce((acc, column) => acc + column.width, 0);
  doc.rect(x, y, totalWidth, 22).fill('#0f172a');
  let cursorX = x;
  columns.forEach((column) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text(column.label, cursorX + 4, y + 6, {
      width: column.width - 8,
      align: column.align
    });
    cursorX += column.width;
  });
  return y + 22;
}

function renderTicketPdfSummary(doc, printable, x, y, width) {
  doc.roundedRect(x, y, width, 126, 8).lineWidth(1).stroke('#d1d5db');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Resumen', x + 12, y + 12);

  let cursor = y + 34;
  cursor = renderKeyValueRow(doc, 'Subtotal', formatCurrencyPrintable(printable.subtotalPrimary, printable.primaryCurrency), x + 12, cursor, width - 24);
  cursor = renderKeyValueRow(doc, 'Descuento', formatCurrencyPrintable(printable.descuentoPrimary, printable.primaryCurrency), x + 12, cursor, width - 24);
  cursor = renderKeyValueRow(doc, 'IVA', formatCurrencyPrintable(printable.ivaPrimary, printable.primaryCurrency), x + 12, cursor, width - 24);
  cursor = renderKeyValueRow(
    doc,
    `Total (${printable.primaryCurrency})`,
    formatCurrencyPrintable(printable.primaryTotal, printable.primaryCurrency),
    x + 12,
    cursor,
    width - 24,
    { boldValue: true }
  );
  return cursor + 8;
}

function renderTicketPdfMeta(doc, printable, x, y, width) {
  doc.roundedRect(x, y, width, 126, 8).lineWidth(1).stroke('#d1d5db');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('Conversión y control', x + 12, y + 12);

  let cursor = y + 34;
  cursor = renderKeyValueRow(doc, 'Tipo de cambio', printable.exchangeRateLabel, x + 12, cursor, width - 24);
  cursor = renderKeyValueRow(doc, 'Total en guaraníes', formatCurrencyPrintable(printable.totalGs, 'PYG'), x + 12, cursor, width - 24);
  cursor = renderKeyValueRow(
    doc,
    'Total en dólares',
    printable.totalUsd === null ? 'No disponible' : formatCurrencyPrintable(printable.totalUsd, 'USD'),
    x + 12,
    cursor,
    width - 24
  );
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(
    'El detalle se muestra en la moneda original de la venta. Los importes convertidos se calculan usando el tipo de cambio registrado.',
    x + 12,
    cursor + 10,
    { width: width - 24, align: 'left' }
  );
  return cursor + 40;
}

function getTicketIvaLabel(ivaPorcentaje) {
  const parsed = Number(ivaPorcentaje);
  if (parsed === 5) return '5%';
  if (parsed === 10) return '10%';
  return 'Exento';
}

function renderInfoBlock(doc, title, rows, x, y, width) {
  const minHeight = 60;
  const estimatedHeight = Math.max(rows.length * 14 + 26, minHeight);
  doc.save();
  doc.roundedRect(x, y, width, estimatedHeight, 6).stroke('#e5e7eb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(title, x + 10, y + 8);
  let cursor = y + 24;
  rows.forEach((row) => {
    const value = row.value || '-';
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1f2937').text(`${row.label}:`, x + 10, cursor, { continued: true });
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(` ${value}`, { width: width - 20 });
    cursor += 14;
  });
  doc.restore();
  return y + estimatedHeight;
}

function renderDetalleItems(doc, venta, x, y, width) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const columns = buildDetalleColumns(width);
  const headerHeight = 22;

  doc.save();
  doc.rect(x, y, width, headerHeight).fill('#0f172a');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  let columnX = x;
  columns.forEach((col) => {
    doc.text(col.label, columnX + 4, y + 5, { width: col.width - 8, align: col.align });
    columnX += col.width;
  });
  doc.restore();

  let cursor = y + headerHeight;
  if (!detalles.length) {
    doc.rect(x, cursor, width, 26).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text('Sin detalles registrados', x + 10, cursor + 7);
    return cursor + 26;
  }

  detalles.forEach((detalle) => {
    const rowHeight = 20;
    doc.rect(x, cursor, width, rowHeight).stroke('#e5e7eb');
    const cantidad = Number(detalle.cantidad) || 0;
    const precio = Number(detalle.precio_unitario) || 0;
    const subtotal = Number(detalle.subtotal) || cantidad * precio;
    const ivaDetalle = getDetalleIvaPorcentaje(detalle, venta);
    const impuestoColumns = splitTaxColumns(subtotal, ivaDetalle);
    const row = {
      codigo: getDetalleCodigo(detalle),
      descripcion: detalle.producto?.nombre || 'Producto',
      cantidad: formatNumberPrintable(cantidad),
      precio: formatCurrencyPrintable(precio),
      exentas: formatCurrencyPrintable(impuestoColumns.exentas),
      grav5: formatCurrencyPrintable(impuestoColumns.gravado5),
      grav10: formatCurrencyPrintable(impuestoColumns.gravado10)
    };

    let cellX = x;
    columns.forEach((col) => {
      const value = row[col.key] || '-';
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(value, cellX + 4, cursor + 5, {
        width: col.width - 8,
        align: col.align
      });
      cellX += col.width;
    });

    cursor += rowHeight;
  });

  return cursor;
}

function buildDetalleColumns(availableWidth) {
  const baseColumns = [
    { key: 'codigo', label: 'Código', width: 70, align: 'left' },
    { key: 'descripcion', label: 'Descripción', width: 0, align: 'left' },
    { key: 'cantidad', label: 'Cant.', width: 45, align: 'right' },
    { key: 'precio', label: 'Precio Unit.', width: 70, align: 'right' },
    { key: 'exentas', label: 'Exentas', width: 60, align: 'right' },
    { key: 'grav5', label: 'Grav. 5%', width: 60, align: 'right' },
    { key: 'grav10', label: 'Grav. 10%', width: 60, align: 'right' }
  ];
  const usedWidth = baseColumns.filter((col) => col.width).reduce((acc, col) => acc + col.width, 0);
  baseColumns[1].width = Math.max(120, availableWidth - usedWidth);
  return baseColumns;
}

function renderTotalsBlock(doc, venta, totals, breakdown, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Liquidación del IVA', x, y);
  let cursor = y + 16;

  const columnWidths = [width * 0.45, width * 0.25, width * 0.3];
  const headerHeight = 18;
  doc.save();
  doc.rect(x, cursor, width, headerHeight).fill('#0f172a');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  doc.text('Concepto', x + 8, cursor + 4, { width: columnWidths[0] - 10 });
  doc.text('Gravado', x + columnWidths[0], cursor + 4, { width: columnWidths[1] - 8, align: 'right' });
  doc.text('IVA', x + columnWidths[0] + columnWidths[1], cursor + 4, { width: columnWidths[2] - 8, align: 'right' });
  doc.restore();

  cursor += headerHeight;
  const rows = [
    { label: 'Exentas', gravado: breakdown.exentas, iva: 0 },
    { label: 'Gravadas 5%', gravado: breakdown.gravado5, iva: breakdown.iva5 },
    { label: 'Gravadas 10%', gravado: breakdown.gravado10, iva: breakdown.iva10 }
  ];

  rows.forEach((row) => {
    doc.rect(x, cursor, width, 18).stroke('#e5e7eb');
    doc.font('Helvetica').fontSize(9).fillColor('#111827');
    doc.text(row.label, x + 8, cursor + 4, { width: columnWidths[0] - 10 });
    doc.text(formatCurrencyPrintable(row.gravado), x + columnWidths[0], cursor + 4, {
      width: columnWidths[1] - 8,
      align: 'right'
    });
    doc.text(formatCurrencyPrintable(row.iva), x + columnWidths[0] + columnWidths[1], cursor + 4, {
      width: columnWidths[2] - 8,
      align: 'right'
    });
    cursor += 18;
  });

  cursor += 16;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Totales del comprobante', x, cursor);
  cursor += 12;
  cursor = renderKeyValueRow(doc, 'Subtotal', formatCurrencyPrintable(totals.subtotal), x, cursor, width);
  cursor = renderKeyValueRow(doc, 'Descuento', formatCurrencyPrintable(totals.descuento), x, cursor, width);
  cursor = renderKeyValueRow(doc, 'IVA', formatCurrencyPrintable(totals.iva), x, cursor, width);
  cursor = renderKeyValueRow(doc, 'Total', formatCurrencyPrintable(totals.total), x, cursor, width, { boldValue: true });
  const totalEnLetras = montoEnLetras(totals.total, venta?.moneda || 'PYG');
  doc.font('Helvetica').fontSize(9).fillColor('#374151').text(`Total en letras: ${totalEnLetras}`, x, cursor + 4, {
    width,
    align: 'left'
  });
  cursor += 18;
  return cursor;
}

function renderKeyValueRow(doc, label, value, x, y, width, options = {}) {
  const leftWidth = width * 0.55;
  doc.font('Helvetica').fontSize(9).fillColor('#4b5563').text(label, x, y, { width: leftWidth });
  doc
    .font(options.boldValue ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(10)
    .fillColor('#111827')
    .text(value, x, y, { width, align: 'right' });
  return y + 14;
}

function computeInvoiceTotals(venta) {
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const subtotal = detalles.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);
  const descuento = Number(venta?.descuento_total) || 0;
  const total = Number(venta?.total) || Math.max(subtotal - descuento, 0);
  const ivaPorcentaje = Number.isFinite(Number(venta?.iva_porcentaje)) ? Number(venta?.iva_porcentaje) : 10;
  const divisor = IVA_DIVISOR[ivaPorcentaje];
  const iva = divisor && total > 0 ? total / divisor : 0;
  return { subtotal, descuento, total, iva };
}

function computeIvaBreakdown(venta) {
  const totals = computeInvoiceTotals(venta);
  const parsedIva = Number(venta?.iva_porcentaje);
  const ivaPorcentaje = Number.isFinite(parsedIva) ? parsedIva : 10;
  const breakdown = {
    exentas: 0,
    gravado5: 0,
    iva5: 0,
    gravado10: 0,
    iva10: 0
  };

  if (ivaPorcentaje === 5) {
    const iva = totals.total / (IVA_DIVISOR[5] || 21);
    breakdown.gravado5 = totals.total - iva;
    breakdown.iva5 = iva;
  } else if (ivaPorcentaje === 10) {
    const iva = totals.total / (IVA_DIVISOR[10] || 11);
    breakdown.gravado10 = totals.total - iva;
    breakdown.iva10 = iva;
  } else {
    breakdown.exentas = totals.total;
  }

  return breakdown;
}

function getDetalleIvaPorcentaje(detalle, venta) {
  if (typeof detalle?.iva_porcentaje === 'number') return detalle.iva_porcentaje;
  if (typeof detalle?.producto?.iva_porcentaje === 'number') return detalle.producto.iva_porcentaje;
  const parsed = Number(venta?.iva_porcentaje);
  return Number.isFinite(parsed) ? parsed : 10;
}

function splitTaxColumns(amount, ivaPorcentaje) {
  if (ivaPorcentaje === 5) {
    return { exentas: 0, gravado5: amount, gravado10: 0 };
  }
  if (ivaPorcentaje === 10) {
    return { exentas: 0, gravado5: 0, gravado10: amount };
  }
  return { exentas: amount, gravado5: 0, gravado10: 0 };
}

function getDetalleCodigo(detalle) {
  if (detalle.producto?.sku) return detalle.producto.sku;
  if (detalle.producto?.codigo_barra) return detalle.producto.codigo_barra;
  if (detalle.producto?.id) return detalle.producto.id.slice(0, 8).toUpperCase();
  return detalle.id ? detalle.id.slice(0, 8).toUpperCase() : '-';
}

function renderQrPanel(doc, factura, qrBuffer, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Código QR - SET', x, y);
  let cursor = y + 10;
  const qrSize = Math.min(width - 24, 160);
  const qrX = x + (width - qrSize) / 2;
  if (qrBuffer) {
    doc.image(qrBuffer, qrX, cursor, { fit: [qrSize, qrSize] });
  } else {
    doc.save();
    doc.rect(qrX, cursor, qrSize, qrSize).dash(3, { space: 3 }).stroke('#9ca3af');
    doc.undash();
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text('QR no disponible', qrX, cursor + qrSize / 2 - 6, {
      width: qrSize,
      align: 'center'
    });
    doc.restore();
  }

  cursor += qrSize + 10;
  doc.font('Helvetica').fontSize(8).fillColor('#111827');
  doc.text(`Número: ${factura?.nro_factura || '-'}`, x, cursor, { width });
  cursor += 12;
  doc.text(`Timbrado: ${factura?.timbrado || 'No informado'}`, x, cursor, { width });
  cursor += 12;
  doc.text(`Código seguridad: ${factura?.id || '-'}`, x, cursor, { width });
  cursor += 12;
  doc.text('Consulta: https://ekuatia.set.gov.py/consultas', x, cursor, { width });
  return cursor + 14;
}

function formatCurrencyPrintable(value, currency = 'PYG') {
  const number = Number(value) || 0;
  const resolvedCurrency = String(currency || 'PYG').toUpperCase() === 'USD' ? 'USD' : 'PYG';
  const fractionDigits = resolvedCurrency === 'USD' ? 2 : 0;
  return new Intl.NumberFormat('es-PY', {
    style: 'currency',
    currency: resolvedCurrency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(number);
}

function formatExchangeRatePrintable(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-PY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(number);
}

function formatNumberPrintable(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('es-PY', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(number);
}

function formatDatePrintable(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-PY', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function buildFacturaXml(venta, factura) {
  const totals = computeInvoiceTotals(venta);
  const detalles = Array.isArray(venta?.detalles) ? venta.detalles : [];
  const ivaPorcentaje = Number.isFinite(Number(venta?.iva_porcentaje)) ? Number(venta.iva_porcentaje) : 10;

  const lines = detalles
    .map((detalle, index) => {
      const producto = detalle.producto || {};
      const cantidad = Number(detalle.cantidad) || 0;
      const precio = Number(detalle.precio_unitario) || 0;
      const subtotal = Number(detalle.subtotal) || cantidad * precio;
      return `    <detalle numero="${index + 1}">
      <producto>${escapeXml(producto.nombre || 'Producto')}</producto>
      <sku>${escapeXml(producto.sku || '')}</sku>
      <cantidad>${cantidad}</cantidad>
      <precio_unitario>${precio.toFixed(2)}</precio_unitario>
      <subtotal>${subtotal.toFixed(2)}</subtotal>
    </detalle>`;
    })
    .join('\n');

  const cliente = venta?.cliente || {};
  const fechaIso = new Date(factura.fecha_emision || venta.created_at || new Date()).toISOString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<factura>
  <cabecera>
    <numero>${escapeXml(factura.nro_factura || '')}</numero>
    <fecha_emision>${fechaIso}</fecha_emision>
    <estado>${escapeXml(factura.estado || '')}</estado>
    <ruc_emisor>${escapeXml(EMPRESA_INFO.ruc)}</ruc_emisor>
    <nombre_emisor>${escapeXml(EMPRESA_INFO.nombre)}</nombre_emisor>
    <cliente>
      <nombre>${escapeXml(cliente.nombre_razon_social || 'Cliente eventual')}</nombre>
      <ruc>${escapeXml(cliente.ruc || 'S/D')}</ruc>
      <telefono>${escapeXml(cliente.telefono || '')}</telefono>
      <correo>${escapeXml(cliente.correo || '')}</correo>
    </cliente>
  </cabecera>
  <detalles>
${lines}
  </detalles>
  <totales>
    <subtotal>${totals.subtotal.toFixed(2)}</subtotal>
    <descuento>${totals.descuento.toFixed(2)}</descuento>
    <iva porcentaje="${ivaPorcentaje}">${totals.iva.toFixed(2)}</iva>
    <total>${totals.total.toFixed(2)}</total>
  </totales>
</factura>
`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
