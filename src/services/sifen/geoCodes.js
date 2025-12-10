const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', '..', '..', 'docs', 'sifen', 'codigos-geograficos.json');

let cache = null;

function loadData() {
  if (cache) return cache;
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  cache = {
    actualizado: parsed.actualizado,
    total: parsed.total,
    items: Array.isArray(parsed.items) ? parsed.items : []
  };
  return cache;
}

function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .normalize('NFD')
    .replace(/[^\w\s]/g, '')
    .toUpperCase()
    .trim();
}

function findByCodes({ departamentoCodigo, distritoCodigo, ciudadCodigo, barrioCodigo } = {}) {
  const { items } = loadData();
  return items.find((row) => {
    if (departamentoCodigo && row.departamentoCodigo !== String(departamentoCodigo)) return false;
    if (distritoCodigo && row.distritoCodigo !== String(distritoCodigo)) return false;
    if (ciudadCodigo && row.ciudadCodigo !== String(ciudadCodigo)) return false;
    if (barrioCodigo && row.barrioCodigo !== String(barrioCodigo)) return false;
    return true;
  });
}

function findByNames({ departamento, distrito, ciudad } = {}) {
  const { items } = loadData();
  const targetDepartamento = normalizeText(departamento);
  const targetDistrito = normalizeText(distrito);
  const targetCiudad = normalizeText(ciudad);

  return items.find((row) => {
    if (targetDepartamento && normalizeText(row.departamento) !== targetDepartamento) {
      return false;
    }
    if (targetDistrito && normalizeText(row.distrito) !== targetDistrito) {
      return false;
    }
    if (targetCiudad && normalizeText(row.ciudad) !== targetCiudad) {
      return false;
    }
    return true;
  });
}

function searchUbicaciones(term, { limit = 20 } = {}) {
  const normTerm = normalizeText(term);
  if (!normTerm) return [];
  const { items } = loadData();
  const results = [];
  for (const row of items) {
    const concat = [row.departamento, row.distrito, row.ciudad, row.barrio].map(normalizeText).join(' ');
    if (concat.includes(normTerm)) {
      results.push(row);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function resolveUbicacion({ cliente, fallback } = {}) {
  const byCodes = findByCodes({
    departamentoCodigo: cliente?.departamentoCodigo,
    distritoCodigo: cliente?.distritoCodigo,
    ciudadCodigo: cliente?.ciudadCodigo,
    barrioCodigo: cliente?.barrioCodigo
  });
  if (byCodes) return byCodes;

  const byNames = findByNames({
    departamento: cliente?.departamento,
    distrito: cliente?.distrito,
    ciudad: cliente?.ciudad
  });
  if (byNames) return byNames;

  return fallback || null;
}

module.exports = {
  loadData,
  findByCodes,
  findByNames,
  searchUbicaciones,
  resolveUbicacion
};
