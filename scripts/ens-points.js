// ---------------------------------------------------------------------------
// ens-points.js
// Neutral sampling points for the ECMWF ENS hub probabilities of the public weather relay (2026-10-13, PO decision,
// ADR-001 Q3: hub risk under "Latest" computed in the page, the relay never carries the hub list).
//
// The relay publishes the ENS probability fields (gust >= 15 / 25 m/s, rain >= 20 mm in 24 h) only at the 0.25° grid
// points next to the airports of a NEUTRAL rule: every airport OurAirports (public domain) types as "large_airport" with
// scheduled service and a 4-letter ICAO code in Europe, North America and the Middle East. It is the rule of the public
// METAR archive (tools/wx-archive/build-airports.js select(); test-prefetch.js checks both pick the same airports). The
// published part holds grid indices and values only: no airport code, name or position.
// Per airport the grid points nearest to its position and to the four positions 0.05° north, south, east and west of it,
// so a hub whose position in the page differs a little from OurAirports' still finds its point. The page takes the
// nearest grid point of each of its hubs exactly as fetch-wxoutlook.js hubProbs does on Monday (nearestIndex), so the
// numbers are the Monday run's for the same ENS run.
//
//   neutralPositions(csvText)        → [[lat, lon], …] of the airports of the rule
//   gridPoints(field, positions, nearestIndex) → sorted unique grid indices
//   encodeIdx(idx) / decodeIdx(s)     → "first,delta,delta,…" (indices ascending)
//   sampleB64(field, idx)             → base64 of one byte per index: the value rounded (0–100), 255 = missing
// ---------------------------------------------------------------------------
'use strict';

const ME = new Set(['AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IR', 'IQ', 'IL', 'JO', 'LB', 'SY', 'YE', 'EG', 'TR', 'CY']);
const OFFSETS = [[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]];
const MISSING = 255;

// RFC 4180 CSV: quoted fields may hold commas and doubled quotes (as tools/wx-archive/build-airports.js).
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
// The neutral rule on parsed rows: { icao, lat, lon } of every airport it picks, sorted by ICAO, one per ICAO.
function selectRows(rows) {
  const h = rows[0] || [], ix = n => h.indexOf(n);
  const [iT, iS, iI, iC, iK, iLa, iLo] = ['type', 'scheduled_service', 'icao_code', 'continent', 'iso_country', 'latitude_deg', 'longitude_deg'].map(ix);
  const seen = new Map();
  rows.slice(1).forEach(r => {
    if (!(r[iT] === 'large_airport' && r[iS] === 'yes' && /^[A-Z]{4}$/.test(r[iI] || '') && (r[iC] === 'EU' || r[iC] === 'NA' || ME.has(r[iK])))) return;
    const lat = +r[iLa], lon = +r[iLo];
    if (!seen.has(r[iI]) && isFinite(lat) && isFinite(lon)) seen.set(r[iI], { icao: r[iI], lat, lon });
  });
  return [...seen.values()].sort((a, b) => (a.icao < b.icao ? -1 : 1));
}
function neutralPositions(csvText) { return selectRows(parseCsv(String(csvText || ''))).map(a => [a.lat, a.lon]); }

function gridPoints(g, positions, nearestIndex) {
  const set = new Set();
  (positions || []).forEach(([lat, lon]) => OFFSETS.forEach(([dl, dn]) => { const k = nearestIndex(g, lat + dl, lon + dn); if (k >= 0) set.add(k); }));
  return [...set].sort((a, b) => a - b);
}
function encodeIdx(idx) { return idx.map((k, i) => (i ? k - idx[i - 1] : k)).join(','); }
function decodeIdx(s) { let k = 0; return String(s || '').split(',').filter(Boolean).map((d, i) => (k = i ? k + +d : +d)); }
function sampleB64(g, idx) {
  const b = Buffer.alloc(idx.length);
  idx.forEach((k, i) => { const v = g.values[k]; b[i] = v == null || isNaN(v) ? MISSING : Math.max(0, Math.min(100, Math.round(v))); });
  return b.toString('base64');
}

module.exports = { ME, OFFSETS, MISSING, parseCsv, selectRows, neutralPositions, gridPoints, encodeIdx, decodeIdx, sampleB64 };
