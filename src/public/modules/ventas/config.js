import { request, buildQuery, urlWithSession } from '../common/api.js';
import { formatCurrency, formatDate } from '../common/format.js';
import { confirmDialog, createDeferredDocumentWindow, infoDialog, openUrlInNewTab, promptDialog } from '../common/dialogs.js';

const IVA_OPTIONS = [
  { value: '10', label: 'IVA 10%' },
  { value: '5', label: 'IVA 5%' }
];

const MONEDA_OPTIONS = [
  { value: 'PYG', label: 'Guaraníes (PYG)' },
  { value: 'USD', label: 'Dólares (USD)' }
];

const ventasState = {
  lastList: [],
  lastFilters: {},
  lastResumen: null,
  currentPage: 1
};

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function ceilAmount(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.ceil(((Number(value) || 0) * factor) - Number.EPSILON) / factor;
}

function lockBodyScroll() {
  if (typeof document === 'undefined') return () => {};
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  return () => {
    document.body.style.overflow = previousOverflow;
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeRecibos(recibos) {
  if (!Array.isArray(recibos)) return [];
  return Array.from(
    new Map(
      recibos
        .filter((recibo) => recibo?.id)
        .map((recibo) => [recibo.id, recibo])
    ).values()
  );
}

async function resolveVentaRecibos(venta) {
  const recibos = normalizeRecibos(venta?.recibos);
  if (recibos.length || !venta?.id) {
    return recibos;
  }

  try {
    const query = buildQuery({ ventaId: venta.id });
    const endpoint = query ? `/recibos?${query}` : '/recibos';
    const response = await request(endpoint);
    const fetched = Array.isArray(response)
      ? response
      : Array.isArray(response?.data)
        ? response.data
        : [];
    const normalized = normalizeRecibos(fetched);
    if (normalized.length) {
      ventasState.lastList = ventasState.lastList.map((item) => (
        item?.id === venta.id
          ? { ...item, recibos: normalized }
          : item
      ));
    }
    return normalized;
  } catch (error) {
    console.error('[Ventas] No se pudieron resolver los recibos asociados.', error);
    return recibos;
  }
}

function renderRecibosBundleHtml(venta, recibos) {
  const links = recibos
    .map((recibo, index) => {
      const href = urlWithSession(`/recibos/${encodeURIComponent(recibo.id)}/pdf`);
      const numero = escapeHtml(recibo.numero || `Recibo ${index + 1}`);
      const fecha = recibo.fecha ? ` · ${escapeHtml(formatDate(recibo.fecha))}` : '';
      return `<a class="venta-doc-link" href="${href}" target="_blank" rel="noopener noreferrer">${numero}${fecha}</a>`;
    })
    .join('');

  return `<!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>Recibos relacionados</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; font-family: 'Segoe UI', sans-serif; }
          .card { width: min(100% - 32px, 640px); padding: 28px; border-radius: 20px; background: linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(8, 15, 28, 0.96)); border: 1px solid rgba(148, 163, 184, 0.24); box-shadow: 0 24px 50px rgba(2, 6, 23, 0.45); }
          h1 { margin: 0 0 10px; font-size: 1.25rem; }
          p { margin: 0 0 18px; color: #94a3b8; line-height: 1.55; }
          .links { display: grid; gap: 12px; }
          .venta-doc-link { display: inline-flex; align-items: center; justify-content: center; min-height: 46px; padding: 0.8rem 1.1rem; border-radius: 14px; background: rgba(249, 115, 22, 0.12); border: 1px solid rgba(249, 115, 22, 0.35); color: #fed7aa; text-decoration: none; font-weight: 700; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Recibos relacionados</h1>
          <p>Venta ${escapeHtml(venta?.factura_electronica?.nro_factura || venta?.id || '')}. Abrí cada recibo desde esta lista.</p>
          <div class="links">${links}</div>
        </div>
      </body>
    </html>`;
}

function normalizeDateString(input) {
  if (!input) return null;
  if (typeof input === 'string' && DATE_ONLY_REGEX.test(input)) {
    return input;
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatMonedaLabel(value) {
  if (!value) return '';
  const upper = String(value).toUpperCase();
  if (upper === 'USD') return 'Dólares (USD)';
  return 'Guaraníes (PYG)';
}

function renderTotalAmount(venta) {
  const base = formatCurrency(venta?.total, 'PYG');
  const currency = (venta?.moneda || 'PYG').toUpperCase();
  const usdAmount = Number(venta?.total_moneda || 0);
  if (currency === 'USD' && Number.isFinite(usdAmount) && usdAmount > 0) {
    return `<div class="table-amount"><span>${base}</span><div class="table-sub">${formatCurrency(usdAmount, 'USD')}</div></div>`;
  }
  return base;
}

function getPrimaryNotaCredito(venta) {
  const notas = Array.isArray(venta?.notas_credito) ? venta.notas_credito : [];
  return notas.length ? notas[0] : null;
}

function getNotaCreditoLabel(nota) {
  const estado = String(nota?.estado || '').toUpperCase();
  const prefix = String(nota?.tipo_ajuste || 'TOTAL').toUpperCase() === 'PARCIAL' ? 'NC parcial' : 'NC total';
  if (estado === 'RECHAZADO') return `${prefix} rechazada`;
  if (estado === 'ENVIADO' || estado === 'ACEPTADO' || estado === 'PAGADA') return `${prefix} emitida`;
  return `${prefix} pendiente`;
}

function hasEffectiveTotalCreditNote(venta) {
  const nota = getPrimaryNotaCredito(venta);
  if (!nota) return false;
  const estado = String(nota.estado || '').toUpperCase();
  if (estado === 'RECHAZADO') return false;
  return String(nota.tipo_ajuste || 'TOTAL').toUpperCase() === 'TOTAL';
}

function getOperationalSaldoPendiente(venta) {
  if (hasEffectiveTotalCreditNote(venta)) {
    return 0;
  }
  return Number(venta?.saldo_pendiente ?? 0);
}

function renderNotaCreditoBadge(venta) {
  const nota = getPrimaryNotaCredito(venta);
  if (!nota) return '';
  const estado = String(nota.estado || '').toUpperCase();
  if (estado === 'RECHAZADO') {
    return `<span class="badge error">${escapeHtml(getNotaCreditoLabel(nota))}</span>`;
  }
  if (estado === 'ENVIADO' || estado === 'ACEPTADO' || estado === 'PAGADA') {
    return `<span class="badge warn">${escapeHtml(getNotaCreditoLabel(nota))}</span>`;
  }
  return `<span class="badge muted">${escapeHtml(getNotaCreditoLabel(nota))}</span>`;
}

let ventasResumenNode = null;

function ensureVentasResumenNode() {
  if (ventasResumenNode && ventasResumenNode.isConnected) return ventasResumenNode;
  const listCard = document.querySelector('.list-card');
  if (!listCard) return null;
  const node = document.createElement('section');
  node.id = 'ventas-resumen-card';
  node.className = 'ventas-resumen-card';
  listCard.prepend(node);
  ventasResumenNode = node;
  return node;
}

function clearVentasResumenNode() {
  if (ventasResumenNode && ventasResumenNode.parentNode) {
    ventasResumenNode.parentNode.removeChild(ventasResumenNode);
  }
  ventasResumenNode = null;
}

function renderVentasResumenCard(resumen, totalRegistros = 0) {
  const node = ensureVentasResumenNode();
  if (!node) return;
  if (!resumen) {
    node.innerHTML = '<p class="muted">Consultá las ventas para ver el resumen.</p>';
    return;
  }

  const totalPyg = formatCurrency(resumen.total_pyg || 0, 'PYG');
  const totalUsd = formatCurrency(resumen.total_usd || 0, 'USD');

  node.innerHTML = `
    <div class="ventas-resumen-card__header">
      <h3>Resumen de ventas</h3>
      <span>${totalRegistros} registros</span>
    </div>
    <div class="ventas-resumen-card__grid">
      <div>
        <span>Ventas en guaraníes</span>
        <strong>${totalPyg}</strong>
      </div>
      <div>
        <span>Ventas en dólares</span>
        <strong>${totalUsd}</strong>
      </div>
    </div>
  `;
}

function datesBetween(start, end) {
  const out = [];
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function resolveDateRange(filters, showMessage) {
  let start = null;
  let end = null;

  if (filters && filters.fecha_desde) {
    if (!DATE_ONLY_REGEX.test(filters.fecha_desde)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha desde del reporte.', 'error');
      return null;
    }
    start = filters.fecha_desde;
  }
  if (filters && filters.fecha_hasta) {
    if (!DATE_ONLY_REGEX.test(filters.fecha_hasta)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha hasta del reporte.', 'error');
      return null;
    }
    end = filters.fecha_hasta;
  }

  if (!start && !end) {
    const suggestion = new Date().toISOString().slice(0, 10);
    const input = typeof window !== 'undefined'
      ? await promptDialog({
        title: 'Fecha del reporte',
        description: 'Ingresá la fecha base del reporte en formato YYYY-MM-DD.',
        field: {
          name: 'fecha',
          label: 'Fecha',
          type: 'date',
          initialValue: suggestion
        },
        confirmLabel: 'Usar fecha',
        validate: (value) => (DATE_ONLY_REGEX.test(value) ? '' : 'Usa el formato YYYY-MM-DD para la fecha del reporte.')
      })
      : null;
    if (!input) {
      return null;
    }
    if (!DATE_ONLY_REGEX.test(input)) {
      showMessage('Usa el formato YYYY-MM-DD para la fecha del reporte.', 'error');
      return null;
    }
    start = input;
    end = input;
  }

  if (start && !end) end = start;
  if (!start && end) start = end;

  if (start > end) {
    showMessage('La fecha "Desde" debe ser anterior o igual a la fecha "Hasta".', 'error');
    return null;
  }

  const rangeList = datesBetween(start, end);
  return {
    start,
    end,
    rangeList,
    rangeSet: new Set(rangeList),
    label: start === end ? start : `${start} → ${end}`
  };
}

function filterVentasByRange(rangeInfo) {
  const targetDates = rangeInfo?.rangeSet;
  if (!targetDates || !(targetDates instanceof Set)) return [];
  return ventasState.lastList.filter((venta) => targetDates.has(normalizeDateString(venta.fecha || venta.created_at)));
}

function openReportPdf(type, filters, rangeInfo, showMessage) {
  const query = buildQuery({
    search: filters?.search,
    iva_porcentaje: filters?.iva_porcentaje,
    moneda: filters?.moneda,
    include_deleted: filters?.include_deleted ? 'true' : undefined,
    fecha_desde: rangeInfo.start,
    fecha_hasta: rangeInfo.end
  });
  const rawUrl = query ? `/ventas/reporte/${type}?${query}` : `/ventas/reporte/${type}`;
  const url = urlWithSession(rawUrl);
  const win = openUrlInNewTab(url, {
    blockedTitle: 'No se pudo abrir el reporte',
    blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF del reporte.'
  });
  if (!win) {
    showMessage('No se pudo abrir la ventana del reporte. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
}

function downloadReportXlsx(filters, rangeInfo, showMessage) {
  const query = buildQuery({
    search: filters?.search,
    iva_porcentaje: filters?.iva_porcentaje,
    moneda: filters?.moneda,
    include_deleted: filters?.include_deleted ? 'true' : undefined,
    fecha_desde: rangeInfo.start,
    fecha_hasta: rangeInfo.end
  });
  const rawUrl = query ? `/ventas/reporte/diario/xlsx?${query}` : '/ventas/reporte/diario/xlsx';
  const url = urlWithSession(rawUrl);
  const win = openUrlInNewTab(url, {
    blockedTitle: 'No se pudo iniciar la descarga',
    blockedDescription: 'Desbloquea las ventanas emergentes para descargar el Excel del reporte.'
  });
  if (!win) {
    showMessage('No se pudo iniciar la descarga del Excel. Revisá el bloqueador de ventanas emergentes.', 'error');
  }
}

function openNotaCreditoDialog({ venta }) {
  return new Promise((resolve) => {
    const detallesVenta = Array.isArray(venta?.detalles) ? venta.detalles : [];
    const moneda = (venta?.moneda || 'PYG').toUpperCase();
    const tipoCambio = Number(venta?.tipo_cambio || 0);

    const restoreBodyScroll = lockBodyScroll();

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.style.display = 'grid';
    overlay.style.placeItems = 'center';
    overlay.style.padding = '20px 16px';
    overlay.style.overflowY = 'auto';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.style.background = '#0f172a';
    modal.style.color = '#e2e8f0';
    modal.style.padding = '20px';
    modal.style.borderRadius = '10px';
    modal.style.width = 'min(760px, calc(100vw - 32px))';
    modal.style.maxHeight = 'calc(100vh - 40px)';
    modal.style.overflowY = 'auto';
    modal.style.overscrollBehavior = 'contain';
    modal.style.boxShadow = '0 10px 30px rgba(0,0,0,0.4)';

    const title = document.createElement('h3');
    title.textContent = 'Emitir nota de crédito';
    title.style.margin = '0 0 12px 0';
    modal.appendChild(title);

    const resume = document.createElement('div');
    resume.style.fontSize = '13px';
    resume.style.color = '#cbd5e1';
    resume.style.marginBottom = '12px';
    const totalVenta = formatCurrency(venta?.total || 0, 'PYG');
    const totalMoneda = moneda === 'USD' && Number(venta?.total_moneda || 0) > 0
      ? ` · ${formatCurrency(venta.total_moneda, 'USD')}`
      : '';
    resume.textContent = `Factura ${venta?.factura_electronica?.nro_factura || 'sin número'} · Total ${totalVenta}${totalMoneda}`;
    modal.appendChild(resume);

    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Tipo de ajuste';
    const modeSelect = document.createElement('select');
    modeSelect.innerHTML = '<option value="TOTAL">Total</option><option value="PARCIAL">Parcial por ítems</option>';
    modeSelect.style.width = '100%';
    modeSelect.style.margin = '6px 0 12px 0';
    modeSelect.style.padding = '10px';
    modeSelect.style.borderRadius = '8px';
    modeSelect.style.border = '1px solid #334155';
    modeSelect.style.background = '#020617';
    modeSelect.style.color = '#e2e8f0';
    modal.appendChild(modeLabel);
    modal.appendChild(modeSelect);

    const motivoLabel = document.createElement('label');
    motivoLabel.textContent = 'Motivo';
    const motivoInput = document.createElement('textarea');
    motivoInput.value = `Ajuste de la factura ${venta?.factura_electronica?.nro_factura || ''}`.trim();
    motivoInput.rows = 3;
    motivoInput.style.width = '100%';
    motivoInput.style.margin = '6px 0 12px 0';
    motivoInput.style.padding = '10px';
    motivoInput.style.borderRadius = '8px';
    motivoInput.style.border = '1px solid #334155';
    motivoInput.style.background = '#020617';
    motivoInput.style.color = '#e2e8f0';
    modal.appendChild(motivoLabel);
    modal.appendChild(motivoInput);

    const errorNode = document.createElement('p');
    errorNode.style.margin = '0 0 12px 0';
    errorNode.style.color = '#fca5a5';
    errorNode.style.fontSize = '13px';
    errorNode.style.display = 'none';
    modal.appendChild(errorNode);

    const partialWrap = document.createElement('div');
    partialWrap.style.display = 'none';
    partialWrap.style.marginBottom = '16px';
    partialWrap.innerHTML = '<strong>Ítems a acreditar</strong>';

    const info = document.createElement('div');
    info.style.fontSize = '12px';
    info.style.color = '#94a3b8';
    info.style.margin = '6px 0 10px 0';
    info.textContent = 'Marcá los ítems y la cantidad exacta a descontar.';
    partialWrap.appendChild(info);

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.innerHTML = '<thead><tr><th></th><th>Producto</th><th>Vendida</th><th>Acreditar</th><th>Subtotal</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');
    const rows = detallesVenta.map((detalle, idx) => {
      const tr = document.createElement('tr');
      const maxQty = Number(detalle?.cantidad || 0);
      const priceUnit = maxQty > 0 ? Number(detalle?.precio_unitario || Number(detalle?.subtotal || 0) / maxQty) : 0;
      const checkboxCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkboxCell.appendChild(checkbox);
      const qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.min = '0';
      qtyInput.max = String(maxQty);
      qtyInput.step = '1';
      qtyInput.value = '0';
      qtyInput.style.width = '90px';
      qtyInput.style.padding = '6px';
      qtyInput.style.borderRadius = '6px';
      qtyInput.style.border = '1px solid #334155';
      qtyInput.style.background = '#020617';
      qtyInput.style.color = '#e2e8f0';

      const subtotalCell = document.createElement('td');
      const updateRowSubtotal = () => {
        const qty = Math.max(0, Math.min(maxQty, Number(qtyInput.value) || 0));
        subtotalCell.textContent = formatCurrency(round(priceUnit * qty, 2), 'PYG');
      };

      checkbox.addEventListener('change', () => {
        if (checkbox.checked && Number(qtyInput.value) <= 0) {
          qtyInput.value = '1';
        }
        if (!checkbox.checked) {
          qtyInput.value = '0';
        }
        updateRowSubtotal();
        updateSummary();
      });

      qtyInput.addEventListener('input', () => {
        const qty = Math.max(0, Math.min(maxQty, Number(qtyInput.value) || 0));
        qtyInput.value = String(qty);
        checkbox.checked = qty > 0;
        updateRowSubtotal();
        updateSummary();
      });

      const nameCell = document.createElement('td');
      nameCell.textContent = detalle?.producto?.nombre || `Ítem ${idx + 1}`;
      const soldCell = document.createElement('td');
      soldCell.textContent = String(maxQty);
      const qtyCell = document.createElement('td');
      qtyCell.appendChild(qtyInput);
      tr.appendChild(checkboxCell);
      tr.appendChild(nameCell);
      tr.appendChild(soldCell);
      tr.appendChild(qtyCell);
      tr.appendChild(subtotalCell);
      tbody.appendChild(tr);
      updateRowSubtotal();
      return { detalle, checkbox, qtyInput, priceUnit };
    });
    partialWrap.appendChild(table);

    const summary = document.createElement('div');
    summary.style.marginTop = '10px';
    summary.style.fontSize = '13px';
    summary.style.color = '#cbd5e1';
    partialWrap.appendChild(summary);

    function updateSummary() {
      const totalGs = round(
        rows.reduce((acc, row) => acc + round((Number(row.qtyInput.value) || 0) * row.priceUnit, 2), 0),
        2
      );
      if (moneda === 'USD' && tipoCambio > 0) {
        summary.textContent = `Total parcial: ${formatCurrency(totalGs, 'PYG')} · ${formatCurrency(round(totalGs / tipoCambio, 2), 'USD')}`;
      } else {
        summary.textContent = `Total parcial: ${formatCurrency(totalGs, 'PYG')}`;
      }
    }
    updateSummary();
    modal.appendChild(partialWrap);

    modeSelect.addEventListener('change', () => {
      partialWrap.style.display = modeSelect.value === 'PARCIAL' ? 'block' : 'none';
    });

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '10px';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancelar';
    btnCancel.style.padding = '8px 12px';
    btnCancel.style.border = 'none';
    btnCancel.style.borderRadius = '6px';
    btnCancel.style.background = '#334155';
    btnCancel.style.color = '#e2e8f0';
    const btnOk = document.createElement('button');
    btnOk.textContent = 'Emitir';
    btnOk.style.padding = '8px 12px';
    btnOk.style.border = 'none';
    btnOk.style.borderRadius = '6px';
    btnOk.style.background = '#f59e0b';
    btnOk.style.color = '#020617';
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    actions.style.position = 'sticky';
    actions.style.bottom = '0';
    actions.style.paddingTop = '12px';
    actions.style.background = 'linear-gradient(180deg, rgba(15,23,42,0), rgba(15,23,42,1) 30%)';
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (result) => {
      restoreBodyScroll();
      document.body.removeChild(overlay);
      resolve(result);
    };

    btnCancel.addEventListener('click', () => close(null));
    btnOk.addEventListener('click', () => {
      const motivo = String(motivoInput.value || '').trim();
      if (motivo.length < 5) {
        errorNode.textContent = 'El motivo debe tener al menos 5 caracteres.';
        errorNode.style.display = 'block';
        return;
      }

      if (modeSelect.value === 'PARCIAL') {
        const detalles = rows
          .map((row) => ({
            detalleVentaId: row.detalle.id,
            cantidad: Number(row.qtyInput.value) || 0
          }))
          .filter((row) => row.cantidad > 0);
        if (!detalles.length) {
          errorNode.textContent = 'Seleccioná al menos un ítem para la nota parcial.';
          errorNode.style.display = 'block';
          return;
        }
        close({ motivo, tipo_ajuste: 'PARCIAL', detalles });
        return;
      }

      errorNode.style.display = 'none';
      close({ motivo, tipo_ajuste: 'TOTAL' });
    });
  });
}

// Adecuación: ahora acepta un objeto venta para soportar cuotas
function openCobroDialog({ saldo, monedaVenta, tipoCambioVenta, venta }) {
  return new Promise((resolve) => {
    const esVentaUsd = (monedaVenta || '').toUpperCase() === 'USD';
    const saldoGs = round(Number(saldo) || 0, 2);
    const saldoMoneda = esVentaUsd && tipoCambioVenta > 0
      ? round(saldoGs / Number(tipoCambioVenta), 2)
      : saldoGs;
    const monedaVentaNormalizada = (monedaVenta || 'PYG').toUpperCase();

    const restoreBodyScroll = lockBodyScroll();

    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.style.display = 'grid';
    overlay.style.placeItems = 'center';
    overlay.style.padding = '20px 16px';
    overlay.style.overflowY = 'auto';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.style.background = '#0f172a';
    modal.style.color = '#e2e8f0';
    modal.style.padding = '20px';
    modal.style.borderRadius = '10px';
    modal.style.width = 'min(760px, calc(100vw - 32px))';
    modal.style.maxHeight = 'calc(100vh - 40px)';
    modal.style.overflowY = 'auto';
    modal.style.overscrollBehavior = 'contain';
    modal.style.boxShadow = '0 10px 30px rgba(0,0,0,0.4)';

    const title = document.createElement('h3');
    title.textContent = 'Cobrar venta';
    title.style.margin = '0 0 12px 0';
    modal.appendChild(title);

    const resumenSaldo = document.createElement('div');
    resumenSaldo.style.fontSize = '13px';
    resumenSaldo.style.color = '#cbd5e1';
    resumenSaldo.style.marginBottom = '12px';
    modal.appendChild(resumenSaldo);

    // Si la venta es a cuotas, mostrar detalle de cuotas pendientes
    let cuotasSeleccionadas = [];
    let cuotasPendientes = [];
    let cuotasInfoNode = null;
    if (venta && venta.credito && venta.credito.tipo === 'CUOTAS' && Array.isArray(venta.credito.cuotas)) {
      cuotasPendientes = venta.credito.cuotas.filter((c) => !c.pagada);
      cuotasInfoNode = document.createElement('div');
      cuotasInfoNode.style.marginBottom = '16px';
      cuotasInfoNode.innerHTML = `<strong>Cuotas pendientes:</strong>`;
      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.marginTop = '6px';
      table.innerHTML = `<thead><tr><th></th><th>N°</th><th>Monto</th><th>Vence</th><th>Estado</th></tr></thead><tbody></tbody>`;
      const tbody = table.querySelector('tbody');
      cuotasPendientes.forEach((cuota, idx) => {
        const tr = document.createElement('tr');
        const tdCheck = document.createElement('td');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = false;
        check.addEventListener('change', () => {
          if (check.checked) {
            cuotasSeleccionadas.push(cuota.numero);
          } else {
            cuotasSeleccionadas = cuotasSeleccionadas.filter((n) => n !== cuota.numero);
          }
          updateMontoSugerido();
        });
        tdCheck.appendChild(check);
        tr.appendChild(tdCheck);
        const montoCuota = esVentaUsd ? formatCurrency(cuota.monto, 'USD') : formatCurrency(cuota.monto, 'PYG');
        tr.innerHTML += `<td>${cuota.numero}</td><td>${montoCuota}</td><td>${formatDate(cuota.fecha_vencimiento)}</td><td>${cuota.pagada ? 'Pagada' : 'Pendiente'}</td>`;
        tr.children[0].replaceWith(tdCheck);
        tbody.appendChild(tr);
      });
      cuotasInfoNode.appendChild(table);
      modal.appendChild(cuotasInfoNode);
    }

    // Contenedor de pago único (no multi-pago para cuotas)
    const pagoContainer = document.createElement('div');
    pagoContainer.className = 'caja-dialog__form';
    modal.appendChild(pagoContainer);

    const appendDialogField = (labelText, control) => {
      const field = document.createElement('label');
      field.className = 'caja-dialog__field';

      const caption = document.createElement('span');
      caption.textContent = labelText;
      field.appendChild(caption);
      field.appendChild(control);
      pagoContainer.appendChild(field);
      return field;
    };

    // Moneda
    const monedaSelect = document.createElement('select');
    ['PYG', 'USD'].forEach((val) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val === 'USD' ? 'USD' : 'PYG';
      if ((monedaVenta || 'PYG') === val) opt.selected = true;
      monedaSelect.appendChild(opt);
    });
    appendDialogField('Moneda', monedaSelect);

    // Tipo de cambio (solo USD)
    const cambioInput = document.createElement('input');
    cambioInput.type = 'number';
    cambioInput.step = '0.0001';
    cambioInput.min = '0';
    cambioInput.value = tipoCambioVenta > 0 ? tipoCambioVenta : '';
    const cambioField = appendDialogField('Tipo cambio', cambioInput);
    if ((monedaVenta || 'PYG') !== 'USD') {
      cambioField.style.display = 'none';
    }
    monedaSelect.addEventListener('change', (e) => {
      if (e.target.value === 'USD') {
        cambioField.style.display = '';
      } else {
        cambioField.style.display = 'none';
      }
      updateMontoSugerido();
    });
    cambioInput.addEventListener('input', () => {
      updateMontoSugerido();
    });

    // Monto sugerido
    const montoInput = document.createElement('input');
    montoInput.type = 'number';
    montoInput.step = '0.01';
    montoInput.min = '0';
    montoInput.value = esVentaUsd ? saldoMoneda : saldoGs;
    appendDialogField('Monto', montoInput);

    // Método
    const metodoSelect = document.createElement('select');
    ['efectivo', 'transferencia', 'tarjeta'].forEach((val) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
      metodoSelect.appendChild(opt);
    });
    appendDialogField('Método', metodoSelect);

    const errorNode = document.createElement('p');
    errorNode.style.margin = '0';
    errorNode.style.color = '#fca5a5';
    errorNode.style.fontSize = '13px';
    errorNode.style.display = 'none';
    modal.appendChild(errorNode);

    function getTipoCambioCobro() {
      const value = Number(cambioInput.value);
      return Number.isFinite(value) && value > 0 ? value : 0;
    }

    function convertSaleAmountToSelectedCurrency(amount) {
      const numericAmount = round(Number(amount) || 0, 2);
      if (monedaSelect.value === monedaVentaNormalizada) {
        return numericAmount;
      }

      const tipoCambioCobro = getTipoCambioCobro();
      if (!tipoCambioCobro) {
        return null;
      }

      if (monedaVentaNormalizada === 'PYG' && monedaSelect.value === 'USD') {
        return ceilAmount(numericAmount / tipoCambioCobro, 2);
      }

      if (monedaVentaNormalizada === 'USD' && monedaSelect.value === 'PYG') {
        return round(numericAmount * tipoCambioCobro, 2);
      }

      return numericAmount;
    }

    function updateResumenSaldo() {
      const tipoCambioCobro = getTipoCambioCobro();
      if (monedaSelect.value === 'USD') {
        const saldoUsd = monedaVentaNormalizada === 'USD'
          ? saldoMoneda
          : (tipoCambioCobro ? ceilAmount(saldoGs / tipoCambioCobro, 2) : null);
        if (saldoUsd === null) {
          resumenSaldo.textContent = `Saldo pendiente: ${formatCurrency(saldoGs, 'PYG')} · completá el tipo de cambio para cobrar en USD.`;
          return;
        }
        resumenSaldo.textContent = `Saldo pendiente: ${formatCurrency(saldoUsd, 'USD')} · ${formatCurrency(saldoGs, 'PYG')} (tc ${tipoCambioCobro || tipoCambioVenta || 0})`;
        return;
      }

      if (monedaVentaNormalizada === 'USD' && tipoCambioCobro) {
        resumenSaldo.textContent = `Saldo pendiente: ${formatCurrency(saldoGs, 'PYG')} · ${formatCurrency(saldoMoneda, 'USD')} (tc ${tipoCambioCobro})`;
        return;
      }

      resumenSaldo.textContent = `Saldo pendiente: ${formatCurrency(saldoGs, 'PYG')}`;
    }

    // Función para actualizar el monto sugerido según cuotas seleccionadas
    function updateMontoSugerido() {
      if (cuotasPendientes.length && cuotasSeleccionadas.length) {
        const total = cuotasPendientes
          .filter((c) => cuotasSeleccionadas.includes(c.numero))
          .reduce((acc, c) => acc + Number(c.monto || 0), 0);
        const convertedTotal = convertSaleAmountToSelectedCurrency(total);
        montoInput.value = convertedTotal === null ? '' : round(convertedTotal, 2);
        updateResumenSaldo();
        return;
      }

      const convertedSaldo = convertSaleAmountToSelectedCurrency(monedaVentaNormalizada === 'USD' ? saldoMoneda : saldoGs);
      montoInput.value = convertedSaldo === null ? '' : convertedSaldo;
      updateResumenSaldo();
    }

    updateMontoSugerido();

    // Acciones
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '10px';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancelar';
    btnCancel.style.padding = '8px 12px';
    btnCancel.style.border = 'none';
    btnCancel.style.borderRadius = '6px';
    btnCancel.style.background = '#334155';
    btnCancel.style.color = '#e2e8f0';
    const btnOk = document.createElement('button');
    btnOk.textContent = 'Aceptar';
    btnOk.style.padding = '8px 12px';
    btnOk.style.border = 'none';
    btnOk.style.borderRadius = '6px';
    btnOk.style.background = '#16a34a';
    btnOk.style.color = '#e2e8f0';
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    actions.style.position = 'sticky';
    actions.style.bottom = '0';
    actions.style.paddingTop = '12px';
    actions.style.background = 'linear-gradient(180deg, rgba(15,23,42,0), rgba(15,23,42,1) 30%)';
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    btnCancel.addEventListener('click', () => {
      restoreBodyScroll();
      document.body.removeChild(overlay);
      resolve(null);
    });
    btnOk.addEventListener('click', () => {
      // Validar monto y cuotas seleccionadas
      let pagos = [];
      if (cuotasPendientes.length) {
        if (!cuotasSeleccionadas.length) {
          errorNode.textContent = 'Seleccioná al menos una cuota a pagar.';
          errorNode.style.display = 'block';
          return;
        }
        const esUsd = monedaSelect.value === 'USD';
        const total = cuotasPendientes
          .filter((c) => cuotasSeleccionadas.includes(c.numero))
          .reduce((acc, c) => acc + Number(c.monto || 0), 0);
        const totalEsperado = convertSaleAmountToSelectedCurrency(total);
        if (totalEsperado === null) {
          errorNode.textContent = 'Ingresá un tipo de cambio válido para cobrar en USD.';
          errorNode.style.display = 'block';
          return;
        }
        let monto = Number(montoInput.value);
        if (esUsd) {
          if (Math.abs(monto - totalEsperado) > 1) {
            errorNode.textContent = 'El monto en USD debe coincidir con la suma de las cuotas seleccionadas.';
            errorNode.style.display = 'block';
            return;
          }
        } else {
          if (Math.abs(monto - totalEsperado) > 1) {
            errorNode.textContent = 'El monto debe coincidir con el total de las cuotas seleccionadas.';
            errorNode.style.display = 'block';
            return;
          }
        }
        pagos = [{
          monedaCobro: esUsd ? 'USD' : 'PYG',
          tipoCambio: esUsd ? Number(cambioInput.value) : undefined,
          monto,
          metodo: metodoSelect.value,
          cuotas: cuotasSeleccionadas.slice() // Enviar las cuotas seleccionadas
        }];
      } else {
        const esUsd = monedaSelect.value === 'USD';
        if (esUsd && !getTipoCambioCobro()) {
          errorNode.textContent = 'Ingresá un tipo de cambio válido para cobrar en USD.';
          errorNode.style.display = 'block';
          return;
        }
        pagos = [{
          monedaCobro: monedaSelect.value,
          tipoCambio: esUsd ? getTipoCambioCobro() : undefined,
          monto: Number(montoInput.value),
          metodo: metodoSelect.value,
          cuotas: []
        }];
      }
      errorNode.style.display = 'none';
      restoreBodyScroll();
      document.body.removeChild(overlay);
      resolve({ pagos });
    });
  });
}

async function printDailyReport(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para generar el reporte.', 'info');
    return;
  }
  const rangeInfo = await resolveDateRange(filters, showMessage);
  if (!rangeInfo) return;
  const { label } = rangeInfo;
  const ventas = filterVentasByRange(rangeInfo);
  if (!ventas.length) {
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }
  openReportPdf('diario', filters || {}, rangeInfo, showMessage);
}

async function downloadDailyXlsx(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para exportar.', 'info');
    return;
  }
  const rangeInfo = await resolveDateRange(filters, showMessage);
  if (!rangeInfo) return;
  const { label } = rangeInfo;
  const ventas = filterVentasByRange(rangeInfo);
  if (!ventas.length) {
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }
  downloadReportXlsx(filters || {}, rangeInfo, showMessage);
}

async function printMarginReport(filters, showMessage) {
  if (!ventasState.lastList.length) {
    showMessage('No hay ventas cargadas para generar el reporte.', 'info');
    return;
  }

  const rangeInfo = await resolveDateRange(filters, showMessage);
  if (!rangeInfo) return;
  const { label } = rangeInfo;
  const ventas = filterVentasByRange(rangeInfo);
  if (!ventas.length) {
    showMessage(`No se encontraron ventas para ${label}.`, 'info');
    return;
  }
  openReportPdf('margen', filters || {}, rangeInfo, showMessage);
}


export const ventasModule = {
  key: 'ventas',
  label: 'Ventas',
  labelSingular: 'Venta',
  singular: 'Venta',
  singularLower: 'venta',
  endpoint: '/ventas',
  pageSize: 10,
  supportsPagination: true,
  supportsEdit: false,
  supportsDelete: false,
  supportsForm: false,
  searchPlaceholder: 'Buscar por cliente, usuario, ID o estado',
  filters: [
    {
      name: 'iva_porcentaje',
      label: 'IVA',
      type: 'select',
      options: IVA_OPTIONS
    },
    {
      name: 'moneda',
      label: 'Moneda',
      type: 'select',
      options: MONEDA_OPTIONS
    },
    {
      name: 'fecha_desde',
      label: 'Desde',
      type: 'date'
    },
    {
      name: 'fecha_hasta',
      label: 'Hasta',
      type: 'date'
    }
  ],
  moduleActions: [
    { action: 'print-daily', label: 'Reporte diario', className: 'btn ghost small' },
    { action: 'print-margin', label: 'Reporte margen', className: 'btn ghost small' },
    { action: 'download-daily-xlsx', label: 'Exportar XLSX', className: 'btn ghost small' }
  ],
  rowActions: [
    {
      action: 'facturar',
      label: 'Facturar',
      className: 'btn secondary small',
      shouldRender: ({ item }) => {
        if (!item || item.deleted_at) return false;
        const estado = String(item.estado || '').toUpperCase();
        const yaFacturada = Boolean(item.factura_electronica?.id);
        // Ocultar si es contado (no crédito) y no tiene factura electrónica (es ticket)
        const rawCond = String(item.condicion_venta || item.condicion || '');
        const isCredito = rawCond.toUpperCase().includes('CREDITO') || item.es_credito;
        if (!isCredito && !yaFacturada) return false;
        return estado !== 'ANULADA' && estado !== 'FACTURADO' && !yaFacturada;
      },
      isDisabled: ({ item }) => {
        if (!item) return true;
        const estado = String(item.estado || '').toUpperCase();
        if (estado === 'ANULADA') return true;
        if (item.factura_electronica?.id) return true;
        return false;
      }
    },
    {
      action: 'anular',
      label: 'Anular',
      className: 'btn danger small',
      shouldRender: ({ item }) => {
        if (!item || item.deleted_at) return false;
        if (item.factura_electronica?.id) return false;
        return !getPrimaryNotaCredito(item);
      },
      isDisabled: ({ item }) => {
        if (!item) return true;
        if (item.estado && item.estado.toUpperCase() === 'ANULADA') return true;
        if (item.factura_electronica?.id) return true;
        return Boolean(getPrimaryNotaCredito(item));
      }
    },
    {
      action: 'nota_credito',
      label: 'Nota crédito',
      className: 'btn ghost small',
      shouldRender: ({ item }) => {
        if (!item || item.deleted_at) return false;
        const estado = String(item.estado || '').toUpperCase();
        if (estado === 'ANULADA' || estado === 'TICKET') return false;
        if (!item.factura_electronica?.id) return false;
        return !Array.isArray(item.notas_credito) || !item.notas_credito.length;
      },
      isDisabled: ({ item }) => !item || !item.factura_electronica?.id
    },
    {
      action: 'cobrar',
      label: 'Cobrar',
      className: 'btn primary small',
      shouldRender: ({ item }) => {
        const saldo = getOperationalSaldoPendiente(item);
        return !item?.deleted_at && saldo > 0;
      },
      isDisabled: ({ item }) => {
        const saldo = getOperationalSaldoPendiente(item);
        return !item || saldo <= 0;
      }
    }
  ],
  rowActionHandlers: {
    async facturar({ id, showMessage, reload }) {
      const confirmed = await confirmDialog({
        title: 'Generar factura',
        description: '¿Generar la factura para esta venta?',
        confirmLabel: 'Generar',
        cancelLabel: 'Cancelar'
      });
      if (!confirmed) return;
      try {
        await request(`/ventas/${id}/facturar`, { method: 'POST' });
        showMessage('Factura generada correctamente.', 'success');
        await reload({ preserveScroll: true });
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo generar la factura.', 'error');
      }
    },
    async anular({ id, item, showMessage, reload }) {
      if (item.deleted_at) {
        showMessage('Esta venta ya fue anulada.', 'info');
        return;
      }
      if (getPrimaryNotaCredito(item)) {
        showMessage('Esta venta ya fue regularizada con nota de crédito.', 'info');
        return;
      }
      if (item.factura_electronica?.id) {
        showMessage('Las ventas facturadas no se anulan desde aquí. Debes emitir una nota de crédito.', 'warn');
        return;
      }
      const confirmation = await confirmDialog({
        title: 'Anular venta',
        description: '¿Anular esta venta? Se repondrá el stock de los productos.',
        confirmLabel: 'Anular venta',
        cancelLabel: 'Cancelar',
        danger: true
      });
      if (!confirmation) return;
      try {
        await request(`/ventas/${id}/anular`, { method: 'POST' });
        showMessage('Venta anulada correctamente.', 'success');
        await reload({ preserveScroll: true });
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo anular la venta.', 'error');
      }
    },
    async nota_credito({ id, item, showMessage, reload }) {
      if (!item?.factura_electronica?.id) {
        showMessage('La venta no tiene factura electrónica asociada.', 'warn');
        return;
      }
      if (Array.isArray(item.notas_credito) && item.notas_credito.length) {
        showMessage('La venta ya tiene una nota de crédito emitida.', 'info');
        return;
      }

      const dialogResult = await openNotaCreditoDialog({ venta: item });
      if (!dialogResult) return;

      const motivoLimpio = String(dialogResult.motivo || '').trim();
      if (motivoLimpio.length < 5) {
        showMessage('El motivo debe tener al menos 5 caracteres.', 'warn');
        return;
      }

      const confirmed = await confirmDialog({
        title: 'Emitir nota de crédito',
        description: dialogResult.tipo_ajuste === 'PARCIAL'
          ? 'Se emitirá una nota de crédito parcial para los ítems seleccionados. ¿Deseas continuar?'
          : 'Se emitirá una nota de crédito total para esta venta. Esta operación no debe repetirse. ¿Deseas continuar?',
        confirmLabel: 'Emitir',
        cancelLabel: 'Cancelar',
        danger: dialogResult.tipo_ajuste !== 'PARCIAL'
      });
      if (!confirmed) return;

      const pendingNoteWindow = createDeferredDocumentWindow({
        pendingTitle: 'Generando nota de crédito...',
        pendingDescription: 'La nota de crédito se está emitiendo. Esta pestaña mostrará el PDF apenas esté listo.',
        blockedTitle: 'No se pudo abrir la nota de crédito',
        blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF de la nota de crédito.'
      });

      try {
        const response = await request(`/ventas/${id}/nota-credito`, {
          method: 'POST',
          body: dialogResult.tipo_ajuste === 'PARCIAL'
            ? { motivo: motivoLimpio, tipo_ajuste: 'PARCIAL', detalles: dialogResult.detalles }
            : { motivo: motivoLimpio, tipo_ajuste: 'TOTAL' }
        });
        showMessage('Nota de crédito emitida correctamente.', 'success');
        const pdfUrl = response?.pdf_url;
        if (pdfUrl) {
          const finalUrl = /^https?:\/\//i.test(pdfUrl) ? pdfUrl : urlWithSession(pdfUrl);
          const opened = pendingNoteWindow.navigate(finalUrl);
          if (!opened) {
            showMessage('La nota fue emitida. Desbloquea ventanas emergentes para ver el PDF.', 'warn');
          }
        } else {
          pendingNoteWindow.close();
        }
        await reload({ preserveScroll: true });
      } catch (error) {
        pendingNoteWindow.close();
        console.error(error);
        showMessage(error.message || 'No se pudo emitir la nota de crédito.', 'error');
      }
    },
    async cobrar({ item, showMessage, reload }) {
      if (!item) return;
      const saldo = getOperationalSaldoPendiente(item);
      if (!Number.isFinite(saldo) || saldo <= 0) {
        showMessage('Esta venta no tiene saldo pendiente.', 'info');
        return;
      }
      const dialogResult = await openCobroDialog({
        saldo,
        monedaVenta: (item.moneda || 'PYG').toUpperCase(),
        tipoCambioVenta: Number(item.tipo_cambio) || 0,
        venta: item
      });

      if (!dialogResult || !Array.isArray(dialogResult.pagos) || !dialogResult.pagos.length) return;

      const pendingReceiptWindows = dialogResult.pagos.map(() =>
        createDeferredDocumentWindow({
          pendingTitle: 'Generando recibo...',
          pendingDescription: 'El recibo se está preparando. Esta pestaña mostrará el PDF apenas esté listo.',
          blockedTitle: 'No se pudo abrir el recibo',
          blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF del recibo.'
        })
      );

      try {
        const payload = {
          clienteId: item.clienteId,
          pagos: dialogResult.pagos.map((pago) => ({
            metodo: (pago.metodo || 'efectivo').trim(),
            moneda: pago.monedaCobro || 'PYG',
            tipo_cambio: pago.monedaCobro === 'USD' ? pago.tipoCambio : undefined,
            ventas: [
              {
                ventaId: item.id,
                monto: pago.monto,
                cuotas: Array.isArray(pago.cuotas) ? pago.cuotas : [] // Enviar cuotas seleccionadas
              }
            ]
          }))
        };

        const reciboResponse = await request('/recibos', { method: 'POST', body: payload });
        const recibos = Array.isArray(reciboResponse?.recibos)
          ? reciboResponse.recibos
          : reciboResponse && reciboResponse.id
          ? [reciboResponse]
          : [];

        if (!recibos.length) {
          showMessage('No se pudo registrar el recibo.', 'error');
          return;
        }

        showMessage('Recibo registrado correctamente.', 'success');
        recibos.forEach((rec, index) => {
          if (rec?.id) {
            const pdfUrl = urlWithSession(`/recibos/${rec.id}/pdf`);
            const opened = pendingReceiptWindows[index]?.navigate(pdfUrl)
              ?? Boolean(openUrlInNewTab(pdfUrl, {
                blockedTitle: 'No se pudo abrir el recibo',
                blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF del recibo.'
              }));
            if (!opened) {
              showMessage('Recibo generado. Desbloquea ventanas emergentes para ver el PDF.', 'warn');
            }
          }
        });

        pendingReceiptWindows.slice(recibos.length).forEach((entry) => entry.close());

        await reload({ preserveScroll: true });
      } catch (error) {
        pendingReceiptWindows.forEach((entry) => entry.close());
        console.error(error);
        showMessage(error.message || 'No se pudo registrar el recibo.', 'error');
      }
    }
  },
  moduleActionHandlers: {
    'print-daily': async ({ filters, showMessage }) => printDailyReport(filters, showMessage),
    'print-margin': async ({ filters, showMessage }) => printMarginReport(filters, showMessage),
    'download-daily-xlsx': async ({ filters, showMessage }) => downloadDailyXlsx(filters, showMessage)
  },
  hooks: {
    afterModuleChange: () => renderVentasResumenCard(ventasState.lastResumen, ventasState.lastList.length),
    beforeModuleChange: () => clearVentasResumenNode()
  },
  columns: [
    {
      header: 'Fecha',
      render: (item) => formatDate(item.fecha)
    },
    {
      header: 'Cliente',
      render: (item) => item.cliente?.nombre_razon_social || 'Cliente eventual'
    },
    {
      header: 'Usuario',
      render: (item) => item.usuario?.nombre || item.usuarioId || '-'
    },
    {
      header: 'Estado',
      render: (item) => {
        if (item.deleted_at || (item.estado && item.estado.toUpperCase() === 'ANULADA')) {
          return '<span class="badge error">Anulada</span>';
        }
        const estadoBase = `<span class="badge ok">${escapeHtml(item.estado || '-')}</span>`;
        const notaBadge = renderNotaCreditoBadge(item);
        return notaBadge ? `<div>${estadoBase} ${notaBadge}</div>` : estadoBase;
      }
    },
    {
      header: 'Condición',
      render: (item) => {
        const raw = String(item.condicion_venta || item.condicion || '');
        const isCredito = raw.toUpperCase().includes('CREDITO') || item.es_credito;
        if (!isCredito) {
          return '<span class="badge ok">Contado</span>';
        }

        const credito = item.credito || {};
        let resumen = '';
        let tooltip = '';
        const monedaVenta = String(item.moneda || 'PYG').toUpperCase() === 'USD' ? 'USD' : 'PYG';
        if (credito.tipo === 'CUOTAS') {
          const n = credito.cantidad_cuotas || (Array.isArray(credito.cuotas) ? credito.cuotas.length : null);
          let pagadas = 0;
          let vencidas = 0;
          const hoy = new Date();
          if (Array.isArray(credito.cuotas)) {
            pagadas = credito.cuotas.filter(c => c.pagada || c.estado === 'PAGADA').length;
            vencidas = credito.cuotas.filter(c => !c.pagada && new Date(c.fecha_vencimiento) < hoy).length;
            tooltip = credito.cuotas.map(c => `#${c.numero}: ${formatCurrency(c.monto, monedaVenta)} - ${formatDate(c.fecha_vencimiento)}${c.pagada ? ' (Pagada)' : (new Date(c.fecha_vencimiento) < hoy ? ' (Vencida)' : '')}`).join('\n');
          }
          resumen = `Cuotas: ${n || '-'} (${pagadas}/${n || '-'} pagadas)`;
          if (vencidas > 0) {
            resumen += ` <span class='badge error' title='Cuotas vencidas'>${vencidas} vencida${vencidas > 1 ? 's' : ''}</span>`;
          }
        } else if (credito.tipo === 'PLAZO' || item.fecha_vencimiento) {
          resumen = `Plazo: ${formatDate(credito.fecha_vencimiento || item.fecha_vencimiento)}`;
        }
        const saldo = getOperationalSaldoPendiente(item);
        if (saldo > 0) {
          if (monedaVenta === 'USD') {
            const tipoCambio = Number(item.tipo_cambio || 0);
            const saldoUsd = tipoCambio > 0 ? round(saldo / tipoCambio, 2) : 0;
            resumen += ` · Saldo: ${formatCurrency(saldoUsd, 'USD')}`;
            resumen += ` · ${formatCurrency(saldo, 'PYG')}`;
          } else {
            resumen += ` · Saldo: ${formatCurrency(saldo, 'PYG')}`;
          }
        }

        return `<div><span class="badge warn" title="${escapeHtml(tooltip)}">Crédito</span> <span title="${escapeHtml(tooltip)}">${resumen}</span></div>`;
      }
    },
    {
      header: 'IVA',
      render: (item) => `${item.iva_porcentaje || 10}%`
    },
    {
      header: 'Subtotal',
      render: (item) => formatCurrency(item.subtotal, 'PYG')
    },
    {
      header: 'Descuento',
      render: (item) => (item.descuento_total ? formatCurrency(item.descuento_total, 'PYG') : '-')
    },
    {
      header: 'IVA calculado',
      render: (item) => formatCurrency(item.impuesto_total || 0, 'PYG')
    },
    {
      header: 'Total',
      render: (item) => renderTotalAmount(item)
    },
    {
      header: 'Saldo pendiente',
      render: (item) => {
        const saldo = getOperationalSaldoPendiente(item);
        if (saldo > 0) {
          return `<span class="badge warn">${formatCurrency(saldo, 'PYG')}</span>`;
        }
        return '<span class="badge ok">0</span>';
      }
    },
    {
      header: 'Items',
      render: (item) => `${Array.isArray(item.detalles) ? item.detalles.length : 0}`
    },
    {
      header: 'Factura electronica',
      render: (item) => {
        const isAnulada = item.deleted_at || (item.estado && item.estado.toUpperCase() === 'ANULADA');
        if (isAnulada) {
          return '<span class="badge error">Anulada</span>';
        }
        const notaCredito = Array.isArray(item.notas_credito) ? item.notas_credito[0] : null;
        const esTicket = String(item.estado || '').toUpperCase() === 'TICKET';
        const factura = item.factura_electronica;
        if (esTicket) {
          return `<button type="button" class="btn ghost small" data-docs-id="${item.id}" data-docs-type="ticket">Ver ticket</button>`;
        }
        if (factura?.id && factura?.pdf_path) {
          const facturaButton = `<button type="button" class="btn ghost small" data-docs-id="${item.id}" data-docs-type="factura">Ver factura</button>`;
          const notaButton = notaCredito?.pdf_path
            ? ` <button type="button" class="btn ghost small" data-docs-id="${item.id}" data-docs-type="nota_credito">Ver NC</button>`
            : notaCredito?.id
              ? ` <span class="badge ${String(notaCredito.estado || '').toUpperCase() === 'RECHAZADO' ? 'error' : 'warn'}">${escapeHtml(getNotaCreditoLabel(notaCredito))}</span>`
              : '';
          return `${facturaButton}${notaButton}`;
        }
        if (notaCredito?.pdf_path) {
          return `<button type="button" class="btn ghost small" data-docs-id="${item.id}" data-docs-type="nota_credito">Ver NC</button>`;
        }
        return '<span class="badge muted">Pendiente</span>';
      }
    }
  ],
  async fetchList({ filters, page, pageSize }) {
    const safeFilters = { ...filters };
    if (!safeFilters.fecha_desde && !safeFilters.fecha_hasta) {
      const today = todayIso();
      safeFilters.fecha_desde = today;
      safeFilters.fecha_hasta = today;
    }

    ventasState.lastFilters = { ...safeFilters };
    const query = buildQuery({
      search: safeFilters.search,
      iva_porcentaje: safeFilters.iva_porcentaje,
      moneda: safeFilters.moneda,
      fecha_desde: safeFilters.fecha_desde,
      fecha_hasta: safeFilters.fecha_hasta,
      include_deleted: safeFilters.include_deleted ? 'true' : undefined
    });
    const endpoint = query ? `${this.endpoint}?${query}` : this.endpoint;
    const response = await request(endpoint);
    const data = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.ventas)
        ? response.ventas
        : Array.isArray(response)
          ? response
          : [];
    const sorted = data.slice().sort((a, b) => new Date(b.fecha || b.created_at || 0) - new Date(a.fecha || a.created_at || 0));
    ventasState.lastList = sorted;
    ventasState.lastResumen = response?.meta?.resumen || response?.resumen || null;
    const currentPage = Number(page ?? filters?.page) || 1;
    const currentPageSize = Number(pageSize ?? filters?.pageSize) || this.pageSize || 10;
    ventasState.currentPage = currentPage;
    const total = sorted.length;
    const totalPages = Math.max(1, Math.ceil(total / currentPageSize));
    const startIndex = (currentPage - 1) * currentPageSize;
    const paged = sorted.slice(startIndex, startIndex + currentPageSize);

    renderVentasResumenCard(ventasState.lastResumen, total);
    return {
      data: paged,
      meta: {
        page: currentPage,
        pageSize: currentPageSize,
        total,
        totalPages
      }
    };
  }
};

// Permite abrir factura electronica y recibos asociados a la venta
if (typeof window !== 'undefined') {
  window.__openDocsVenta = async function openDocsVenta(ventaId, tipo) {
    if (!ventaId) return;
    const venta = ventasState.lastList.find((v) => v.id === ventaId);
    if (!venta) return;

    if (tipo === 'factura' && venta.factura_electronica?.id) {
      const factura = venta.factura_electronica;
      const recibosEnMemoria = normalizeRecibos(venta.recibos);
      const pdfPath = factura?.pdf_path;
      const pendingFacturaWindow = createDeferredDocumentWindow({
        pendingTitle: 'Abriendo factura...',
        pendingDescription: 'Estamos preparando la factura electrónica.',
        blockedTitle: 'No se pudo abrir la factura',
        blockedDescription: 'Desbloquea las ventanas emergentes para ver el PDF de la factura.'
      });
      const pendingReceiptWindow = createDeferredDocumentWindow({
        pendingTitle: recibosEnMemoria.length > 1 ? 'Abriendo recibos relacionados...' : 'Abriendo recibo...',
        pendingDescription: recibosEnMemoria.length > 1
          ? 'Estamos preparando la lista de recibos asociados a esta venta.'
          : 'Estamos preparando el recibo relacionado.',
        blockedTitle: 'No se pudieron abrir los recibos relacionados',
        blockedDescription: 'Desbloquea las ventanas emergentes para ver los recibos relacionados.'
      });
      if (pdfPath && /^https?:\/\//i.test(pdfPath)) {
        pendingFacturaWindow.navigate(pdfPath);
      } else {
        const facturaUrl = pdfPath
          ? urlWithSession(pdfPath)
          : null;
        if (!facturaUrl) {
          pendingFacturaWindow.close();
          pendingReceiptWindow.close();
          infoDialog({
            title: 'Factura sin PDF',
            description: 'No se encontró un PDF de factura disponible.'
          });
          return;
        }
        pendingFacturaWindow.navigate(facturaUrl);
      }

      if (recibosEnMemoria.length) {
        if (recibosEnMemoria.length === 1) {
          pendingReceiptWindow.navigate(urlWithSession(`/recibos/${encodeURIComponent(recibosEnMemoria[0].id)}/pdf`));
          return;
        }
        pendingReceiptWindow.writeHtml(renderRecibosBundleHtml(venta, recibosEnMemoria));
        return;
      }

      const recibosAsociados = await resolveVentaRecibos(venta);
      if (!recibosAsociados.length) {
        pendingReceiptWindow.close();
        return;
      }
      if (recibosAsociados.length === 1) {
        pendingReceiptWindow.navigate(urlWithSession(`/recibos/${encodeURIComponent(recibosAsociados[0].id)}/pdf`));
        return;
      }
      const rendered = pendingReceiptWindow.writeHtml(renderRecibosBundleHtml(venta, recibosAsociados));
      if (!rendered) {
        pendingReceiptWindow.close();
        openUrlInNewTab(urlWithSession(`/recibos/${encodeURIComponent(recibosAsociados[0].id)}/pdf`), {
          blockedTitle: 'No se pudo abrir el recibo',
          blockedDescription: 'Desbloquea ventanas emergentes para ver el PDF del recibo.'
        });
      }
      return;
    }
    if (tipo === 'ticket') {
      const ticketUrl = urlWithSession(`/ventas/${encodeURIComponent(venta.id)}/ticket/pdf`);
      openUrlInNewTab(ticketUrl, {
        blockedTitle: 'No se pudo abrir el ticket',
        blockedDescription: 'Desbloquea ventanas emergentes para ver el ticket.'
      });
      return;
    }
    if (tipo === 'nota_credito') {
      const notaCredito = Array.isArray(venta.notas_credito) ? venta.notas_credito[0] : null;
      const pdfPath = notaCredito?.pdf_path;
      if (!pdfPath) {
        infoDialog({
          title: 'Nota de crédito sin PDF',
          description: 'La nota de crédito no tiene PDF disponible todavía.'
        });
        return;
      }
      const finalUrl = /^https?:\/\//i.test(pdfPath) ? pdfPath : urlWithSession(pdfPath);
      openUrlInNewTab(finalUrl, {
        blockedTitle: 'No se pudo abrir la nota de crédito',
        blockedDescription: 'Desbloquea ventanas emergentes para ver el PDF de la nota de crédito.'
      });
      return;
    }
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.matches('button[data-docs-id]')) {
      event.preventDefault();
      const ventaId = target.getAttribute('data-docs-id');
      const tipo = target.getAttribute('data-docs-type');
      window.__openDocsVenta(ventaId, tipo);
    }
  });
}
