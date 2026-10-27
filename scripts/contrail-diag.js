'use strict';
// ---------------------------------------------------------------------------
// contrail-diag.js
// Pure functions behind the contrail layer (fetch-contrails.js, to be built from Tue 27 Oct 2026 after the W43
// freeze; research and Kurt's decisions of 21 Oct in tools/research-2026-10-21-contrails/report.md). No network,
// no files. Unit-tested in test-prefetch.js. Nothing on the Monday path requires this file until the fetcher exists.
//
// What they compute, from NOAA GFS temperature (TMP) and relative humidity (RH) on the pressure levels
// 300 / 250 / 200 hPa (FL300 / FL340 / FL390, the bands of the jet and CAT layers):
//   - the Schmidt-Appleman criterion (SAC): can a contrail form behind a typical turbofan? Equations of
//     Schumann 1996 as implemented in pycontrails (Apache 2.0): mixing-line slope G, threshold temperature
//     T_LM (Schumann eq. 31 polynomial) and the critical relative humidity over water;
//   - persistence: relative humidity over ice (RHi). GFS writes RH over ice at these levels and caps it at
//     100 % (verified on the 2026-10-20 00Z analysis), so the "persistent contrail possible" class uses the
//     registry threshold rhiPersistent (0.95, "near ice saturation"), never a true supersaturation test;
//   - the RH convention self-check: from specific humidity (SPFH) and temperature the code tells whether the
//     file's RH is over ice (today) or over water (announced for a later GFS post-processor), so a switch
//     changes the stamp and never silently dries the map;
//   - classes 0 (SAC not met) / 1 (SAC met, drier) / 2 (SAC met and RHi >= threshold) / 255 (no data) per
//     0.5-degree point, and the 2-degree cell rule of the CAT layer: a cell has class c when at least minPts
//     (5) of its 25 points reach c.
// Saturation vapour pressures: Murphy and Koop 2005 (Q. J. R. Meteorol. Soc. 131), over liquid water and over
// ice, Pa, T in K. Grids as in sigwx-diag.js: { v, nlat, nlon, d, s, w }, row-major south -> north.
// ---------------------------------------------------------------------------

const D = require('./sigwx-diag.js');      // outGrid, block, kthHighest, rleEncode (pure, read-only)

// The parameters of the layer profile (scripts/wx-layers.js 'contrails', once the entry exists). A typical
// turbofan, no specific aircraft type: eta 0.3 (pycontrails default, Geraedts et al. 2024), EI_H2O 1.23 kg/kg and
// Q 43.13 MJ/kg (pycontrails JetA), c_p 1004 J/(kg K), eps = R_d / R_v.
const PARAMS = { eta: 0.3, eiH2o: 1.23, qFuel: 43.13e6, cp: 1004, eps: 287.05 / 461.51, eSat: 'MK05', rhiPersistent: 0.95, minPts: 5 };
const LEVELS = ['300', '250', '200'];                // hPa, as the bands of the jet and CAT layers
const LEVEL_FL = { '300': 'FL300', '250': 'FL340', '200': 'FL390' };
const NO_DATA = 255;
const T0 = 273.15;

// ---- saturation vapour pressure (Murphy and Koop 2005), Pa, T in K -------------------------------------
function eSatWater(T) {
  return Math.exp(54.842763 - 6763.22 / T - 4.21 * Math.log(T) + 0.000367 * T +
    Math.tanh(0.0415 * (T - 218.8)) * (53.878 - 1331.22 / T - 9.44523 * Math.log(T) + 0.014025 * T));
}
function eSatIce(T) {
  return Math.exp(9.550426 - 5723.265 / T + 3.53068 * Math.log(T) - 0.00728332 * T);
}

// ---- Schmidt-Appleman criterion -----------------------------------------------------------------------
// Slope of the mixing line in the (T, e) plane, Pa/K; p in Pa.
function gSlope(p, P) { P = P || PARAMS; return P.eiH2o * P.cp * p / (P.eps * P.qFuel * (1 - P.eta)); }
// Threshold temperature (K): the warmest ambient temperature at which a contrail can form at 100 % RH over water
// (Schumann 1996 eq. 31, as pycontrails T_sat_liquid).
function tLM(G) { const l = Math.log(G - 0.053); return T0 - 46.46 + 9.43 * l + 0.72 * l * l; }
// Critical relative humidity over water (0..1) for a contrail at temperature T (K); Infinity above T_LM.
function rhCritical(T, G, Tlm) {
  if (T > Tlm) return Infinity;
  return Math.min(1, Math.max(0, (G * (T - Tlm) + eSatWater(Tlm)) / eSatWater(T)));
}
// Does a contrail form? T in K, rhW = relative humidity over water (0..1), p in Pa.
function sac(T, rhW, p, P) { const G = gSlope(p, P); return rhW > rhCritical(T, G, tLM(G)); }

// ---- humidity conversions -----------------------------------------------------------------------------
const rhiFromQ = (q, p, T, P) => q * p / ((P || PARAMS).eps * eSatIce(T));        // specific humidity kg/kg, p Pa
const rhWaterFromQ = (q, p, T, P) => q * p / ((P || PARAMS).eps * eSatWater(T));
const rhiFromRhWater = (rhW, T) => rhW * eSatWater(T) / eSatIce(T);
const rhWaterFromRhi = (rhi, T) => rhi * eSatIce(T) / eSatWater(T);

// The file's RH convention from one level's TMP, RH (per cent) and SPFH fields (same grid): the median over cold
// points (T < 233 K, RH > 5 %) of RH_file / RHi(q, T). About 1.0 = over ice (GFS today). A file written over water
// gives e_i(T) / e_w(T), about 0.55 to 0.7 at cruise temperatures (RH over water is BELOW RHi there, because water
// holds more vapour than ice). Returns { convention: 'ice' | 'water' | null, ratio, n }; null when too few points or
// an odd ratio (then a gap, never a guess).
function rhConvention(tmp, rh, spfh, pPa, P) {
  const r = [];
  const n = Math.min(tmp.v.length, rh.v.length, spfh.v.length);
  for (let k = 0; k < n; k++) {
    const T = tmp.v[k], h = rh.v[k], q = spfh.v[k];
    if (!(T < 233) || !(h > 5) || !(q > 0)) continue;
    const rhi = rhiFromQ(q, pPa, T, P); if (rhi > 0) r.push(h / 100 / rhi);
  }
  if (r.length < 100) return { convention: null, ratio: NaN, n: r.length };
  const ratio = D.median(r);
  return { convention: ratio > 0.9 && ratio < 1.1 ? 'ice' : ratio > 0.5 && ratio < 0.75 ? 'water' : null, ratio: Math.round(ratio * 1000) / 1000, n: r.length };
}
// RHi (0..1) per point from the file's RH (per cent) under the detected convention.
function rhiField(rh, tmp, convention) {
  const out = new Float32Array(rh.v.length);
  for (let k = 0; k < out.length; k++) {
    const h = rh.v[k] / 100, T = tmp.v[k];
    out[k] = !isFinite(h) || !isFinite(T) ? NaN : convention === 'water' ? rhiFromRhWater(h, T) : h;
  }
  return out;
}

// ---- classes ------------------------------------------------------------------------------------------
// One point: 0 SAC not met, 1 SAC met and RHi below the threshold, 2 SAC met and RHi >= threshold, 255 no data.
function classify(T, rhi, pPa, P) {
  P = P || PARAMS;
  if (!isFinite(T) || !isFinite(rhi)) return NO_DATA;
  if (!sac(T, rhWaterFromRhi(rhi, T), pPa, P)) return 0;
  return rhi >= P.rhiPersistent ? 2 : 1;
}
// The class of every point of a level: tmp (K) and rhi (0..1) on the same grid, pPa the level pressure.
function classField(tmp, rhi, pPa, P) {
  const out = new Uint8Array(tmp.v.length);
  for (let k = 0; k < out.length; k++) out[k] = classify(tmp.v[k], rhi[k], pPa, P);
  return out;
}
// 2-degree cells: class c when at least minPts of the block's points reach c (the 5th-highest class of the 25);
// 255 when fewer than minPts points have data.
function cellClasses(cls, g, og, minPts, half) {
  const out = new Uint8Array(og.nlat * og.nlon);
  for (let j = 0; j < og.nlat; j++) for (let i = 0; i < og.nlon; i++) {
    const list = D.block(cls, g, og.lat0 + j * og.res, og.lon0 + i * og.res, half).filter(c => c !== NO_DATA);
    out[j * og.nlon + i] = list.length < minPts ? NO_DATA : D.kthHighest(list, minPts);
  }
  return out;
}
// Share of cells (0..1) at or above class c, no-data cells excluded; NaN when every cell is no data.
function coverage(cells, c) {
  let n = 0, m = 0;
  for (let k = 0; k < cells.length; k++) { if (cells[k] === NO_DATA) continue; n++; if (cells[k] >= c) m++; }
  return n ? m / n : NaN;
}

// ---- GRIB bookkeeping (the same shapes as sigwx-diag.js keyOf / idxWanted) ------------------------------
// Decoded GRIB2 message (fetch-wxoutlook.js decodeGrib2) -> 'TMP:250', 'RH:250', 'SPFH:250'; null otherwise.
const PARAM = { '0.0': 'TMP', '1.1': 'RH', '1.0': 'SPFH' };
function keyOf(m) {
  if (m.discipline !== 0 || m.surfType !== 100) return null;
  const p = PARAM[m.cat + '.' + m.num]; if (!p) return null;
  const lev = String(Math.round(m.surfValue / 100));
  return LEVELS.includes(lev) ? p + ':' + lev : null;
}
// .idx rows (sigwx-diag.js parseIdx) wanted: TMP and RH at the three levels, SPFH too when withQ.
function idxWanted(withQ) {
  return r => {
    const m = /^(\d+) mb$/.exec(r.lev); if (!m || !LEVELS.includes(m[1])) return false;
    return r.v === 'TMP' || r.v === 'RH' || (withQ && r.v === 'SPFH');
  };
}
// NOMADS grib filter selection for the same fields.
function nomadsSelection(withQ) {
  return { vars: withQ ? ['TMP', 'RH', 'SPFH'] : ['TMP', 'RH'], levs: LEVELS.map(l => l + '_mb') };
}
function expectedKeys(withQ) {
  const k = [];
  LEVELS.forEach(l => { k.push('TMP:' + l, 'RH:' + l); if (withQ) k.push('SPFH:' + l); });
  return k;
}

module.exports = { PARAMS, LEVELS, LEVEL_FL, NO_DATA, eSatWater, eSatIce, gSlope, tLM, rhCritical, sac,
                   rhiFromQ, rhWaterFromQ, rhiFromRhWater, rhWaterFromRhi, rhConvention, rhiField,
                   classify, classField, cellClasses, coverage, PARAM, keyOf, idxWanted, nomadsSelection, expectedKeys };
