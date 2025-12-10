#!/usr/bin/env node
/*
 * Convierte el XLSX oficial de e-Kuatia (códigos geográficos) a un JSON utilizable
 * dentro de la aplicación. Ejecutar con `node scripts/import-sifen-codigos.js`.
 */
const path = require('path');
const fs = require('fs/promises');
const XLSX = require('xlsx');

const INPUT_FILE = path.join(
  __dirname,
  '..',
  'docs',
  'sifen',
  'CÓDIGO DE REFERENCIA GEOGRAFICA_NOVIEMBRE 2025.xlsx'
);
const OUTPUT_FILE = path.join(__dirname, '..', 'docs', 'sifen', 'codigos-geograficos.json');

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function detectHeaderRow(rows) {
  return rows.findIndex((row) =>
    row.some((cell) => typeof cell === 'string' && cell.toLowerCase().includes('departamento'))
  );
}

function parseRows(rows, headerIndex) {
  const data = [];
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const [departamentoCodigo, departamento, distritoCodigo, distrito, ciudadCodigo, ciudad, barrioCodigo, barrio] = row;
    if (!departamentoCodigo && !departamento && !distrito && !ciudad) {
      continue;
    }
    data.push({
      departamentoCodigo: normalize(departamentoCodigo),
      departamento: normalize(departamento),
      distritoCodigo: normalize(distritoCodigo),
      distrito: normalize(distrito),
      ciudadCodigo: normalize(ciudadCodigo),
      ciudad: normalize(ciudad),
      barrioCodigo: normalize(barrioCodigo),
      barrio: normalize(barrio)
    });
  }
  return data;
}

async function main() {
  console.log('[sifen] Leyendo', INPUT_FILE);
  const workbook = XLSX.readFile(INPUT_FILE, { cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const headerIndex = detectHeaderRow(rows);

  if (headerIndex === -1) {
    throw new Error('No se encontró la fila de cabecera con las columnas esperadas.');
  }

  const data = parseRows(rows, headerIndex);
  if (!data.length) {
    throw new Error('No se pudo leer ningún código geográfico.');
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify({
    actualizado: new Date().toISOString(),
    total: data.length,
    items: data
  }, null, 2));

  console.log(`[sifen] Catálogo exportado (${data.length} filas) -> ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error('[sifen] Error al convertir el catálogo:', error.message);
  process.exitCode = 1;
});
