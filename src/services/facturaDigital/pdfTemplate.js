const fs = require('fs');
const path = require('path');

function renderFacturaDigitalPdf(doc, context) {
  const {
    empresa,
    timbrado,
    factura,
    venta,
    detalles,
    totals,
    breakdown,
    qrBuffer
  } = context;
  const ventaAnulada = (venta?.estado || '').toUpperCase() === 'ANULADA';

  const margin = 32;
  const contentWidth = doc.page.width - margin * 2;
  let cursorY = margin;
  const logoPath = path.join(__dirname, '..', '..', 'public', 'img', 'logotridentgrande.png');
  const hasLogo = fs.existsSync(logoPath);

  const timbradoBoxWidth = 220;
  const timbradoBoxX = margin + contentWidth - timbradoBoxWidth;
  const timbradoBoxHeight = 110;

  if (hasLogo) {
    try {
      doc.image(logoPath, margin, cursorY, { fit: [120, 120] });
    } catch (err) {
      console.warn('[FacturaDigital] No se pudo cargar el logo.', err);
    }
  }

  const logoWidth = hasLogo ? 130 : 0;
  const headerLeftX = margin + logoWidth;
  const infoBlockWidth = Math.max(150, timbradoBoxX - headerLeftX - 20);

  doc.font('Helvetica-Bold').fontSize(16).text(empresa.nombre, headerLeftX, cursorY, { width: infoBlockWidth });
  doc.font('Helvetica').fontSize(9).fillColor('#111827');
  doc.moveDown(0.3);
  (empresa.sucursales || []).forEach((linea) => {
    doc.text(linea, headerLeftX, doc.y + 2, { width: infoBlockWidth });
  });

  doc.roundedRect(timbradoBoxX, cursorY, timbradoBoxWidth, timbradoBoxHeight, 6).stroke('#111827');
  doc.font('Helvetica-Bold').fontSize(10).text(`Nº DE TIMBRADO ${timbrado.numero || '-'}`, timbradoBoxX + 10, cursorY + 8);
  doc.font('Helvetica').fontSize(9);
  doc.text(`FECHA INICIO VIGENCIA ${timbrado.vigencia_inicio || '-'}`, timbradoBoxX + 10, doc.y + 4);
  doc.text(`FECHA FIN VIGENCIA ${timbrado.vigencia_fin || '-'}`, timbradoBoxX + 10, doc.y + 4);
  doc.text(`R.U.C. ${empresa.ruc || '-'}`, timbradoBoxX + 10, doc.y + 4);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(18).text('FACTURA', timbradoBoxX + 10, doc.y + 6);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#b91c1c');
  doc.text(factura.numero || '000-000-0000000', timbradoBoxX + 10, doc.y + 2);
  doc.fillColor('#111827');

  const infoBottom = doc.y;
  const logoBottom = hasLogo ? cursorY + 90 : cursorY;
  const timbradoBottom = cursorY + timbradoBoxHeight;
  const headerBottom = Math.max(infoBottom, logoBottom, timbradoBottom);
  cursorY = headerBottom + 30;

  cursorY = drawOperacionInfo(doc, factura, margin, cursorY, contentWidth);
  cursorY = drawClienteInfo(doc, venta, margin, cursorY + 8, contentWidth);
  cursorY = drawDetalleTabla(doc, venta, detalles, margin, cursorY + 12, contentWidth) + 10;
  cursorY = drawTotales(doc, totals, breakdown, factura, venta, margin, cursorY, contentWidth, qrBuffer);
  drawFooter(doc, empresa, timbrado, qrBuffer, margin, cursorY + 18, contentWidth);
  if (ventaAnulada) {
    drawAnuladoWatermark(doc);
  }
}

function drawOperacionInfo(doc, factura, x, y, width) {
  const columnas = [
    { label: 'FECHA', value: formatFecha(factura.fecha_emision), width: width * 0.3 },
    { label: 'CONDICIÓN DE VENTA', value: factura.condicion || 'CONTADO', width: width * 0.35 },
    { label: 'NOTA DE REMISIÓN Nº', value: factura.nota_remision || 'S/D', width: width * 0.35 }
  ];

  let currentX = x;
  columnas.forEach((col) => {
    doc.rect(currentX, y, col.width - 4, 32).stroke('#111827');
    doc.font('Helvetica-Bold').fontSize(9).text(col.label, currentX + 6, y + 6);
    doc.font('Helvetica').fontSize(11).text(col.value || '-', currentX + 6, y + 18);
    currentX += col.width;
  });

  return y + 40;
}

function drawClienteInfo(doc, venta, x, y, width) {
  const cliente = venta?.cliente || {};
  const rows = [
    { label: 'NOMBRE O RAZÓN SOCIAL', value: cliente.nombre_razon_social || 'Cliente eventual' },
    { label: 'R.U.C.', value: cliente.ruc || 'S/D' },
    { label: 'DIRECCIÓN', value: cliente.direccion || '-' }
  ];

  rows.forEach((row, index) => {
    const fieldHeight = index === 0 ? 30 : 24;
    doc.rect(x, y, width, fieldHeight).stroke('#111827');
    doc.font('Helvetica-Bold').fontSize(9).text(row.label, x + 6, y + 5);
    doc.font('Helvetica').fontSize(11).text(row.value || '-', x + 6, y + 14);
    y += fieldHeight;
  });

  return y;
}

function drawDetalleTabla(doc, venta, detalles, x, y, width) {
  const headerHeight = 24;
  const columns = [
    { key: 'cantidad', label: 'CANTIDAD', width: 70, align: 'center' },
    { key: 'descripcion', label: 'DESCRIPCIÓN', width: width - 340, align: 'left' },
    { key: 'precio_unitario', label: 'PRECIO UNITARIO', width: 90, align: 'right' },
    { key: 'exentas', label: 'EXENTAS', width: 60, align: 'right' },
    { key: 'gravado5', label: '5%', width: 60, align: 'right' },
    { key: 'gravado10', label: '10%', width: 60, align: 'right' }
  ];

  doc.rect(x, y, width, headerHeight).fill('#e5e7eb');
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9);
  let currentX = x;
  columns.forEach((col) => {
    doc.text(col.label, currentX + 4, y + 6, { width: col.width - 8, align: col.align });
    currentX += col.width;
  });
  doc.fillColor('#111827');
  doc.rect(x, y, width, headerHeight).stroke('#111827');

  let cursor = y + headerHeight;
  const prepared = prepareDetalleRows(detalles, venta, columns);
  const minRows = 8;
  const rowsToRender = Math.max(prepared.length, minRows);

  for (let index = 0; index < rowsToRender; index += 1) {
    const row = prepared[index] || {};
    doc.rect(x, cursor, width, 24).stroke('#bdbdbd');
    currentX = x;
    columns.forEach((col) => {
      const value = row[col.key] || '';
      doc.font('Helvetica').fontSize(9).text(value, currentX + 4, cursor + 6, {
        width: col.width - 8,
        align: col.align
      });
      currentX += col.width;
    });
    cursor += 24;
  }

  return cursor;
}

function prepareDetalleRows(detalles, venta, columns) {
  const rows = [];
  const safeDetalles = Array.isArray(detalles) ? detalles : [];
  safeDetalles.forEach((detalle) => {
    const cantidad = Number(detalle.cantidad) || 0;
    const precio = Number(detalle.precio_unitario) || 0;
    const subtotal = Number(detalle.subtotal) || cantidad * precio;
    const iva = resolveDetalleIva(detalle, venta);
    const impuesto = splitTax(subtotal, iva);
    rows.push({
      cantidad: formatNumber(cantidad),
      descripcion: detalle.producto?.nombre || detalle.descripcion || 'Producto',
      precio_unitario: formatCurrency(precio),
      exentas: formatCurrency(impuesto.exentas),
      gravado5: formatCurrency(impuesto.gravado5),
      gravado10: formatCurrency(impuesto.gravado10)
    });
  });
  return rows;
}

function drawTotales(doc, totals, breakdown, factura, venta, x, y, width, qrBuffer) {
  const tableWidth = width * 0.6;
  const qrPanelWidth = width - tableWidth - 16;
  const rowHeight = 22;
  const rows = [
    { label: 'SUBTOTAL', value: formatCurrency(totals.subtotal) },
    { label: 'DESCUENTO', value: formatCurrency(totals.descuento) },
    { label: 'TOTAL', value: formatCurrency(totals.total) },
    { label: 'TOTAL A PAGAR GS.', value: formatCurrency(totals.total) },
    {
      label: 'TOTAL A PAGAR U$S',
      value: formatCurrency(calcTotalUsd(totals.total, venta?.tipo_cambio, venta?.total_moneda), 'USD')
    }
  ];

  rows.forEach((row, index) => {
    doc.rect(x, y + index * rowHeight, tableWidth, rowHeight).stroke('#111827');
    doc.font('Helvetica-Bold').fontSize(9).text(row.label, x + 8, y + 6 + index * rowHeight);
    doc.font('Helvetica').fontSize(11).text(row.value, x + tableWidth - 150, y + 4 + index * rowHeight, {
      width: 140,
      align: 'right'
    });
  });

  const ivaBlockY = y + rows.length * rowHeight + 10;
  const totalIvaGs = breakdown.iva5 + breakdown.iva10;
  const totalIvaUsd = calcPartialUsd(totalIvaGs, totals.total, venta);
  const ivaRows = [
    { label: 'LIQUIDACIÓN DEL IVA (5%)', value: formatCurrency(breakdown.iva5) },
    { label: 'LIQUIDACIÓN DEL IVA (10%)', value: formatCurrency(breakdown.iva10) },
    { label: 'TOTAL IVA', value: formatCurrency(totalIvaGs) }
  ];
  if (totalIvaUsd > 0) {
    ivaRows.push({ label: 'TOTAL IVA U$S', value: formatCurrency(totalIvaUsd) });
  }
  ivaRows.forEach((row, index) => {
    doc.rect(x, ivaBlockY + index * rowHeight, tableWidth, rowHeight).stroke('#111827');
    doc.font('Helvetica-Bold').fontSize(9).text(row.label, x + 8, ivaBlockY + 6 + index * rowHeight);
    doc.font('Helvetica').fontSize(11).text(row.value, x + tableWidth - 150, ivaBlockY + 4 + index * rowHeight, {
      width: 140,
      align: 'right'
    });
  });

  drawQrPanel(doc, {
    x: x + tableWidth + 16,
    y,
    width: qrPanelWidth,
    factura,
    qrBuffer
  });

  return ivaBlockY + ivaRows.length * rowHeight;
}

function drawQrPanel(doc, { x, y, width, factura, qrBuffer }) {
  const height = 190;
  const padding = 12;
  doc.rect(x, y, width, height).dash(3, { space: 3 }).stroke('#9ca3af');
  doc.undash();
  doc.font('Helvetica-Bold').fontSize(10).text('Código de control / QR', x + padding, y + padding);
  const qrAvailableHeight = height - padding * 3 - 30; // reserva zona para textos inferiores
  if (qrBuffer) {
    const qrSize = Math.min(width - padding * 2, qrAvailableHeight);
    const qrTop = y + padding + 12;
    doc.image(qrBuffer, x + (width - qrSize) / 2, qrTop, { fit: [qrSize, qrSize] });
  } else {
    doc.font('Helvetica').fontSize(8).text('QR no disponible', x + padding, y + 60);
  }
  const textY = y + height - padding - 28;
  doc.font('Helvetica').fontSize(8).text(`Factura Nº ${factura.numero || '-'}`, x + padding, textY, {
    width: width - padding * 2
  });
  doc.text(`Control: ${factura.numero_control || '-'}`, x + padding, textY + 14, { width: width - padding * 2 });
}

function drawFooter(doc, empresa, timbrado, qrBuffer, x, y, width) {
  doc.font('Helvetica').fontSize(8).text(
    `Documento digital emitido por ${empresa.nombre}. Timbrado Nº ${timbrado.numero || '-'} válido hasta ${timbrado.vigencia_fin || '-'}.`,
    x,
    y,
    { width }
  );
  doc.text('Conserve este comprobante para fines tributarios (Ley 125/1991 y 2421/2004).', x, doc.y + 4, { width });
}

function drawAnuladoWatermark(doc) {
  const centerX = doc.page.width / 2;
  const centerY = doc.page.height / 2;
  doc.save();
  doc.rotate(-30, { origin: [centerX, centerY] });
  doc.font('Helvetica-Bold').fontSize(120);
  doc.fillColor('#b91c1c');
  doc.opacity(0.15);
  doc.text('ANULADO', centerX - 300, centerY - 60, {
    width: 600,
    align: 'center'
  });
  doc.restore();
  doc.opacity(1);
  doc.fillColor('#111827');
}

function resolveDetalleIva(detalle, venta) {
  if (typeof detalle?.iva_porcentaje === 'number') return detalle.iva_porcentaje;
  if (typeof detalle?.producto?.iva_porcentaje === 'number') return detalle.producto.iva_porcentaje;
  return Number(venta?.iva_porcentaje) || 10;
}

function splitTax(amount, iva) {
  if (iva === 5) {
    return { exentas: 0, gravado5: amount, gravado10: 0 };
  }
  if (iva === 10) {
    return { exentas: 0, gravado5: 0, gravado10: amount };
  }
  return { exentas: amount, gravado5: 0, gravado10: 0 };
}

function calcTotalUsd(total, tipoCambio, totalMoneda) {
  const original = Number(totalMoneda);
  if (Number.isFinite(original) && original > 0) {
    return original;
  }
  const cambio = Number(tipoCambio);
  if (!cambio || !Number.isFinite(cambio) || cambio === 0) return 0;
  return total / cambio;
}

function calcPartialUsd(amountPyG, totalPyG, venta) {
  if (!venta || (venta.moneda || 'PYG').toUpperCase() !== 'USD') {
    return 0;
  }
  const cambio = Number(venta.tipo_cambio);
  if (Number.isFinite(cambio) && cambio > 0) {
    return amountPyG / cambio;
  }
  const totalUsd = Number(venta.total_moneda);
  const totalBase = Number(totalPyG) || 0;
  if (totalUsd > 0 && totalBase > 0) {
    const ratio = amountPyG / totalBase;
    return totalUsd * ratio;
  }
  return 0;
}

function formatCurrency(value) {
  const amount = Number(value) || 0;
  return amount.toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNumber(value) {
  const amount = Number(value) || 0;
  return amount.toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatFecha(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('es-PY');
}

module.exports = { renderFacturaDigitalPdf };
