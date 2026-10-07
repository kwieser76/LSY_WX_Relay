'use strict';
// ---------------------------------------------------------------------------
// sigwx-diag.js
// Pure functions behind fetch-sigwx-model.js: no network, no files. Unit-tested in test-prefetch.js.
//
// What they compute, all from NOAA GFS pressure-level fields on a regular lat/lon grid:
//   - clear-air turbulence (CAT) potential: Ellrod & Knapp (1992) TI1 = vertical wind shear x total
//     deformation, per 50-hPa layer, in 1e-7 s^-2;
//   - jet axes: lines along the wind through the speed maxima of the GFS max-wind level (>= 80 kt),
//     their flight level, speed and the ICAO depth (FL of the 80-kt wind below and above the core);
//   - CB extent and top: the NCEP post-processor's WAFS CB recipe (UPP CLDRAD.f): cover from the
//     convective precipitation rate (table below, capped at 0.8), kept only where the convective
//     cloud top lies above 400 hPa and the cloud is more than 300 hPa deep;
//   - the 2-degree output grids (classes per block of 0.5-degree points), RLE / base64 encoders,
//     path simplification and clipping, the GFS cycle plan, .idx parsing and the NOMADS filter URL.
//
// Grids: { v: Float32Array|Float64Array, nlat, nlon, d, s, w } row-major south -> north, west -> east,
// lat(j) = s + j*d, lon(i) = w + i*d. Paths: [[lat, lon, kt], ...] in flow order.
// ---------------------------------------------------------------------------

const RE = 6371000, G = 9.80665, KT = 1.943844, FT = 3.28084, DEG = Math.PI / 180;

// ---- ICAO standard atmosphere -------------------------------------------------------------------
// Pressure (hPa) -> pressure altitude (ft); FL = ft / 100. Above 11 km the isothermal layer.
function isaFt(p) {
  const m = p >= 226.32 ? 44330.77 * (1 - Math.pow(p / 1013.25, 0.190263)) : 11000 + 6341.62 * Math.log(226.32 / p);
  return m * FT;
}
const flOf = p => Math.round(isaFt(p) / 100);

// ---- kinematics ---------------------------------------------------------------------------------
// Centred differences on the lat/lon grid; the edge rows/columns are NaN.
function grads(g) {
  const { v, nlat, nlon, d, s } = g, n = nlat * nlon;
  const dx = new Float64Array(n).fill(NaN), dy = new Float64Array(n).fill(NaN);
  const dyM = 2 * RE * d * DEG;
  for (let j = 1; j < nlat - 1; j++) {
    const dxM = 2 * RE * Math.max(Math.cos((s + j * d) * DEG), 0.01) * d * DEG;
    for (let i = 1; i < nlon - 1; i++) {
      const k = j * nlon + i;
      dx[k] = (v[k + 1] - v[k - 1]) / dxM;
      dy[k] = (v[k + nlon] - v[k - nlon]) / dyM;
    }
  }
  return { dx, dy };
}
// Total deformation DEF = sqrt(DST^2 + DSH^2), DST = du/dx - dv/dy, DSH = dv/dx + du/dy.
function deformation(u, v) {
  const U = grads(u), V = grads(v), n = u.v.length, def = new Float64Array(n);
  for (let k = 0; k < n; k++) { const dst = U.dx[k] - V.dy[k], dsh = V.dx[k] + U.dy[k]; def[k] = Math.sqrt(dst * dst + dsh * dsh); }
  return def;
}
// Ellrod TI1 of the layer between pLo (higher pressure, lower altitude) and pHi, in 1e-7 s^-2:
// VWS = |V(pHi) - V(pLo)| / (Z(pHi) - Z(pLo)), DEF = mean of the two levels. f: fields keyed
// 'UGRD:250', 'VGRD:250', 'HGT:250'. defCache (optional) keeps a level's DEF for the next layer.
function layerTI1(f, pLo, pHi, defCache) {
  const uL = f['UGRD:' + pLo], vL = f['VGRD:' + pLo], zL = f['HGT:' + pLo], uH = f['UGRD:' + pHi], vH = f['VGRD:' + pHi], zH = f['HGT:' + pHi];
  if (!uL || !vL || !zL || !uH || !vH || !zH) return null;
  const dc = defCache || {}, defOf = p => dc[p] || (dc[p] = deformation(f['UGRD:' + p], f['VGRD:' + p]));
  const dL = defOf(pLo), dH = defOf(pHi), n = uL.v.length, ti1 = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const du = uH.v[k] - uL.v[k], dv = vH.v[k] - vL.v[k], dz = zH.v[k] - zL.v[k];
    ti1[k] = dz > 0 ? Math.sqrt(du * du + dv * dv) / dz * (dL[k] + dH[k]) / 2 * 1e7 : NaN;
  }
  return { ti1, nlat: uL.nlat, nlon: uL.nlon, d: uL.d, s: uL.s, w: uL.w, flLo: flOf(pLo), flHi: flOf(pHi) };
}
// The band at pressure level p (300, 250, 200 hPa = FL300, FL340, FL390) is the higher TI1 of the two
// 50-hPa layers that meet at p: the band covers the air from the level below to the level above.
const BAND_LAYERS = { '300': [[350, 300], [300, 250]], '250': [[300, 250], [250, 200]], '200': [[250, 200], [200, 150]] };
const BAND_FL = { '300': 'FL300', '250': 'FL340', '200': 'FL390' };
function maxOf(a, b) {
  const n = a.length, out = new Float64Array(n);
  for (let k = 0; k < n; k++) { const x = a[k], y = b[k]; out[k] = isFinite(x) ? (isFinite(y) ? Math.max(x, y) : x) : y; }
  return out;
}

// 1-2-1 filter in both directions (NaN-aware), `passes` times.
function smooth(arr, nlat, nlon, passes) {
  let a = Float64Array.from(arr);
  for (let p = 0; p < (passes || 0); p++) {
    const b = new Float64Array(a.length);
    for (let j = 0; j < nlat; j++) for (let i = 0; i < nlon; i++) {
      let s = 0, w = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= nlat) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if (ii < 0 || ii >= nlon) continue;
          const x = a[jj * nlon + ii]; if (!isFinite(x)) continue;
          const wt = (dj ? 1 : 2) * (di ? 1 : 2); s += x * wt; w += wt;
        }
      }
      b[j * nlon + i] = w ? s / w : NaN;
    }
    a = b;
  }
  return a;
}

// Bilinear value of arr (on grid g) at (lat, lon); NaN outside.
function sample(arr, g, lat, lon) {
  const y = (lat - g.s) / g.d, x = (lon - g.w) / g.d, j = Math.floor(y), i = Math.floor(x);
  if (j < 0 || i < 0 || j >= g.nlat || i >= g.nlon) return NaN;
  if (j === g.nlat - 1 || i === g.nlon - 1) return arr[Math.min(j, g.nlat - 1) * g.nlon + Math.min(i, g.nlon - 1)];
  const fy = y - j, fx = x - i, k = j * g.nlon + i;
  return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fy) + (arr[k + g.nlon] * (1 - fx) + arr[k + g.nlon + 1] * fx) * fy;
}

// ---- jet axes -----------------------------------------------------------------------------------
// A grid point is an axis point when its speed is >= minKt and not lower than the speed one grid step
// to either side normal to the wind. Axes are traced from the strongest unused point downstream and
// upstream (one grid step along the wind, nearest axis point within `reach` grid units; axis points
// next to the path are absorbed, so parallel duplicates do not start new lines). Lines shorter than
// minKm are dropped. u, v in m/s (the max-wind level), spdKt (usually smoothed) for the test.
// Returns lines of { lat, lon, s } in flow order. Limitation: GFS stores one max-wind level per
// column, so a polar and a subtropical jet above the same point merge into the faster one.
function jetAxes(u, v, spdKt, g, opt) {
  const o = Object.assign({ minKt: 80, reach: 1.6, absorb: 1.2, minKm: 900 }, opt || {});
  const NI = g.nlon, NJ = g.nlat;
  const at = (arr, x, y) => {
    const i = Math.floor(x), j = Math.floor(y); if (i < 0 || j < 0 || i >= NI - 1 || j >= NJ - 1) return NaN;
    const fx = x - i, fy = y - j, k = j * NI + i;
    return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fy) + (arr[k + NI] * (1 - fx) + arr[k + NI + 1] * fx) * fy;
  };
  const dirAt = (x, y) => {
    const uu = at(u, x, y), vv = at(v, x, y), c = Math.cos((g.s + y * g.d) * DEG);
    const dx = uu / Math.max(c, 0.2), L = Math.hypot(dx, vv) || 1; return [dx / L, vv / L];
  };
  const cand = new Map();
  for (let j = 1; j < NJ - 1; j++) for (let i = 1; i < NI - 1; i++) {
    const k = j * NI + i, s = spdKt[k]; if (!(s >= o.minKt)) continue;
    const [tx, ty] = dirAt(i, j), nx = -ty, ny = tx;
    const s1 = at(spdKt, i + nx, j + ny), s2 = at(spdKt, i - nx, j - ny);
    if (!(s < s1) && !(s < s2)) cand.set(k, { i, j, s });
  }
  const used = new Set(), lines = [];
  const near = (x, y, r) => {
    const out = [];
    for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++) for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
      if (j < 0 || i < 0 || j >= NJ || i >= NI) continue;
      const k = j * NI + i; if (!cand.has(k)) continue;
      const d = Math.hypot(i - x, j - y); if (d <= r) out.push({ k, d });
    }
    return out;
  };
  const absorb = (x, y) => near(x, y, o.absorb).forEach(q => used.add(q.k));
  const trace = (start, sign) => {
    const path = []; let cur = start, guard = 0;
    while (guard++ < 5000) {
      const [tx, ty] = dirAt(cur.i, cur.j), px = cur.i + sign * tx, py = cur.j + sign * ty;
      const nb = near(px, py, o.reach).filter(q => !used.has(q.k)).sort((a, b) => a.d - b.d)[0];
      if (!nb) break;
      const p = cand.get(nb.k); used.add(nb.k); absorb(p.i, p.j); path.push(p); cur = p;
    }
    return path;
  };
  [...cand.entries()].sort((a, b) => b[1].s - a[1].s).forEach(([k, p]) => {
    if (used.has(k)) return;
    used.add(k); absorb(p.i, p.j);
    const line = trace(p, -1).reverse().concat([p], trace(p, 1)).map(q => ({ lat: g.s + q.j * g.d, lon: g.w + q.i * g.d, s: q.s }));
    if (pathKm(line.map(q => [q.lat, q.lon])) >= o.minKm) lines.push(line);
  });
  return lines;
}

// Great-circle-ish length (equirectangular, fine at these steps) of [[lat, lon, ...], ...] in km.
function pathKm(path) {
  let km = 0;
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1], b = path[n], la = (a[0] + b[0]) / 2;
    km += Math.hypot((b[1] - a[1]) * Math.cos(la * DEG), b[0] - a[0]) * 111.2;
  }
  return km;
}

// ICAO jet depth: the FL of the minKt isotach below and above the core, from a vertical wind profile
// [{ fl, kt }] sorted by fl (linear in FL). null where the profile does not get below minKt.
function jetDepth(profile, coreFl, minKt) {
  minKt = minKt || 80;
  let below = null, above = null;
  for (let i = profile.length - 1; i > 0; i--) {
    const a = profile[i - 1], b = profile[i];
    if (b.fl > coreFl) continue;
    if (a.kt < minKt && b.kt >= minKt) { below = Math.round(a.fl + (minKt - a.kt) / (b.kt - a.kt) * (b.fl - a.fl)); break; }
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i], b = profile[i + 1];
    if (a.fl < coreFl) continue;
    if (a.kt >= minKt && b.kt < minKt) { above = Math.round(a.fl + (a.kt - minKt) / (a.kt - b.kt) * (b.fl - a.fl)); break; }
  }
  return { below, above };
}

// Douglas-Peucker on [[lat, lon, ...], ...] (x = lon * cos(lat), y = lat, tolerance in degrees);
// the point with the highest kt (index 2) is always kept, so the jet maximum survives.
function simplifyPath(path, tol) {
  if (path.length <= 2) return path.slice();
  let kmax = 0; path.forEach((p, k) => { if ((p[2] || 0) > (path[kmax][2] || 0)) kmax = k; });
  const keep = new Uint8Array(path.length); keep[0] = keep[path.length - 1] = keep[kmax] = 1;
  const xy = p => [p[1] * Math.cos(p[0] * DEG), p[0]];
  const dp = (a, b) => {
    if (b - a < 2) return;
    const A = xy(path[a]), B = xy(path[b]), L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    let best = -1, dmax = 0;
    for (let k = a + 1; k < b; k++) {
      const P = xy(path[k]);
      const d = L ? Math.abs((B[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (B[1] - A[1])) / L : Math.hypot(P[0] - A[0], P[1] - A[1]);
      if (d > dmax) { dmax = d; best = k; }
    }
    if (dmax > tol) { keep[best] = 1; dp(a, best); dp(best, b); }
  };
  const marks = [0, kmax, path.length - 1].filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => a - b);
  for (let n = 1; n < marks.length; n++) dp(marks[n - 1], marks[n]);
  return path.filter((_, k) => keep[k]);
}

// The pieces of a path inside box { s, n, w, e } (consecutive inside points; a piece keeps the
// crossing point interpolated on the box edge at both ends so lines reach the frame).
function clipPath(path, box) {
  const inside = p => p[0] >= box.s && p[0] <= box.n && p[1] >= box.w && p[1] <= box.e;
  const edge = (a, b) => {           // point on the segment a->b where it crosses the box (a inside, b outside)
    let t = 1;
    const lim = (x0, x1, lo, hi) => { if (x1 < lo) t = Math.min(t, (lo - x0) / (x1 - x0)); if (x1 > hi) t = Math.min(t, (hi - x0) / (x1 - x0)); };
    lim(a[0], b[0], box.s, box.n); lim(a[1], b[1], box.w, box.e);
    return a.map((x, i) => (typeof x === 'number' && typeof b[i] === 'number') ? x + (b[i] - x) * t : x);
  };
  const out = []; let cur = null;
  for (let k = 0; k < path.length; k++) {
    const p = path[k];
    if (inside(p)) {
      if (!cur) { cur = []; if (k > 0) cur.push(edge(p, path[k - 1])); }
      cur.push(p);
    } else if (cur) { cur.push(edge(path[k - 1], p)); out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

// ---- CB (NCEP UPP CLDRAD.f, "CB for WAFS") ----------------------------------------------------------
// Cover from the convective precipitation rate CPR (kg m-2 s-1), linear in ln(CPR) between these
// breakpoints (CPR in 1e-6 kg m-2 s-1), capped at 0.8. 0.5 ≈ the SIGWX "OCNL" coverage.
const CB_CPR = [1.6, 3.6, 8.1, 18.5, 39.0, 89.0, 197, 440, 984], CB_COV = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
function cbCover(rate) {
  const c = rate * 1e6;
  if (!(c > CB_CPR[0])) return 0;
  for (let i = 1; i < CB_CPR.length; i++) if (c <= CB_CPR[i]) return CB_COV[i - 1] + (CB_COV[i] - CB_COV[i - 1]) * Math.log(c / CB_CPR[i - 1]) / Math.log(CB_CPR[i] / CB_CPR[i - 1]);
  return 0.8;
}
// Per grid point: cover (0..0.8) and top FL where top < 400 hPa and depth > 300 hPa, else 0 / NaN.
// rate in kg m-2 s-1, top and bottom pressure in Pa.
function cbFields(rate, top, bot) {
  const n = rate.length, ext = new Float64Array(n), fl = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    const pt = top[k] / 100, pb = bot[k] / 100;
    if (!(pt > 0 && pb > 0) || !(pt < 400 && pb - pt > 300)) continue;
    const c = cbCover(rate[k]); if (!(c > 0)) continue;
    ext[k] = c; fl[k] = flOf(pt);
  }
  return { ext, fl };
}

// ---- 2-degree output grids ------------------------------------------------------------------------
// Output points lat0 + j*res, lon0 + i*res for box { s, n, w, e }.
function outGrid(box, res) {
  return { res, lat0: box.s, lon0: box.w, nlat: Math.floor((box.n - box.s) / res + 1e-9) + 1, nlon: Math.floor((box.e - box.w) / res + 1e-9) + 1 };
}
// The values of arr (grid g) within +-half degrees of (lat, lon): the block of one output cell.
function block(arr, g, lat, lon, half) {
  const out = [], r = Math.round(half / g.d), j0 = Math.round((lat - g.s) / g.d), i0 = Math.round((lon - g.w) / g.d);
  for (let j = j0 - r; j <= j0 + r; j++) {
    if (j < 0 || j >= g.nlat) continue;
    for (let i = i0 - r; i <= i0 + r; i++) { if (i < 0 || i >= g.nlon) continue; const x = arr[j * g.nlon + i]; if (isFinite(x)) out.push(x); }
  }
  return out;
}
// The k-th highest value of a list (k = 1: maximum); -Infinity when the list is shorter.
function kthHighest(list, k) {
  if (list.length < k) return -Infinity;
  return list.slice().sort((a, b) => b - a)[k - 1];
}
// Classes 0/1/2 on the output grid: a cell is class c when at least `minPts` points of its block reach
// thresholds[c-1] (minPts 5 of the 25 0.5-degree points = a fifth of the cell).
function classGrid(arr, g, og, thresholds, minPts, half) {
  const out = new Uint8Array(og.nlat * og.nlon);
  for (let j = 0; j < og.nlat; j++) for (let i = 0; i < og.nlon; i++) {
    const v = kthHighest(block(arr, g, og.lat0 + j * og.res, og.lon0 + i * og.res, half), minPts);
    out[j * og.nlon + i] = v >= thresholds[1] ? 2 : v >= thresholds[0] ? 1 : 0;
  }
  return out;
}
// Any statistic of the block on the output grid: fn(list) -> number (NaN = missing).
function blockGrid(arr, g, og, half, fn) {
  const out = new Float64Array(og.nlat * og.nlon);
  for (let j = 0; j < og.nlat; j++) for (let i = 0; i < og.nlon; i++) out[j * og.nlon + i] = fn(block(arr, g, og.lat0 + j * og.res, og.lon0 + i * og.res, half));
  return out;
}
const median = list => { if (!list.length) return NaN; const s = list.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Percentile (0..1) of a numeric list, nearest rank on the sorted finite values; NaN when empty.
function percentile(list, q) {
  const s = list.filter(x => isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : NaN;
}

// ---- encoders (same formats as the other weather snapshots) ----------------------------------------
// RLE "v*n,v,v*n" row-major (as fetch-wxreview.js / fetch-lightning.js).
function rleEncode(arr) {
  const out = [];
  for (let k = 0; k < arr.length;) { let n = 1; while (k + n < arr.length && arr[k + n] === arr[k]) n++; out.push(n > 1 ? arr[k] + '*' + n : String(arr[k])); k += n; }
  return out.join(',');
}
function rleDecode(str) {
  const out = [];
  String(str || '').split(',').forEach(t => { if (!t) return; const p = t.split('*'), v = +p[0]; for (let n = p[1] ? +p[1] : 1; n > 0; n--) out.push(v); });
  return out;
}
// Flight levels -> base64 of one byte per point, value = FL / 5 (0 = missing), as levels.trop in
// fetch-wxoutlook.js / fetch-wxreview.js.
function flB64(fls) {
  const b = Buffer.alloc(fls.length);
  for (let k = 0; k < fls.length; k++) { const fl = fls[k]; b[k] = (fl == null || !isFinite(fl) || fl <= 0) ? 0 : Math.max(1, Math.min(255, Math.round(fl / 5))); }
  return b.toString('base64');
}
const flB64Decode = s => Array.from(Buffer.from(String(s || ''), 'base64')).map(v => v * 5);

// ---- GFS cycles, files, inventories -------------------------------------------------------------
const pad = (n, w) => String(n).padStart(w || 2, '0');
const cycleOf = ms => { const d = new Date(Math.floor(ms / 216e5) * 216e5); return { date: d.toISOString().slice(0, 10), hh: pad(d.getUTCHours()), ms: d.getTime() }; };
// The latest cycle whose files can be expected complete: lagH hours after its start.
const latestCycle = (nowMs, lagH) => cycleOf(nowMs - (lagH == null ? 5 : lagH) * 36e5);
const cycleLabel = c => c.date + 'T' + c.hh + 'Z';
// Week-ahead plan: 7 dates at 12Z from the first 12Z at or after the cycle, never on or before
// `after` (the last day of the reporting week). lead = hours from the cycle.
function aheadPlan(cycle, after, days, catMaxH) {
  const out = [];
  let t = Date.parse(cycle.date + 'T12:00:00Z');
  if (t < cycle.ms) t += 864e5;
  if (after) while (new Date(t).toISOString().slice(0, 10) <= after) t += 864e5;
  for (let n = 0; n < (days || 7); n++, t += 864e5) {
    const lead = Math.round((t - cycle.ms) / 36e5);
    out.push({ date: new Date(t).toISOString().slice(0, 10), valid: new Date(t).toISOString().slice(0, 13) + ':00Z', lead, hazards: lead <= (catMaxH == null ? 72 : catMaxH) });
  }
  return out;
}
// AWS open-data bucket file of one cycle and forecast hour (0.5-degree pgrb2).
const awsFile = (bucket, c, fh) => bucket + '/gfs.' + c.date.replace(/-/g, '') + '/' + c.hh + '/atmos/gfs.t' + c.hh + 'z.pgrb2.0p50.f' + pad(fh, 3);
// NOMADS grib filter (0.5 degree; the filter serves the pgrb2full files = pgrb2 + pgrb2b).
function nomadsUrl(base, c, fh, vars, levs, box) {
  return base + '?dir=' + encodeURIComponent('/gfs.' + c.date.replace(/-/g, '') + '/' + c.hh + '/atmos') + '&file=gfs.t' + c.hh + 'z.pgrb2full.0p50.f' + pad(fh, 3) +
    vars.map(v => '&var_' + v + '=on').join('') + levs.map(l => '&lev_' + l + '=on').join('') +
    '&subregion=&toplat=' + box.n + '&leftlon=' + box.w + '&rightlon=' + box.e + '&bottomlat=' + box.s;
}
// .idx inventory ("n:offset:d=YYYYMMDDHH:VAR:LEVEL:DESC:") -> rows with byte length (last row: NaN).
function parseIdx(text) {
  const rows = String(text || '').trim().split('\n').map(l => l.split(':')).filter(r => r.length >= 6 && /^\d+$/.test(r[1]));
  return rows.map((r, i) => ({ n: +r[0], off: +r[1], v: r[3], lev: r[4], desc: r[5], len: i + 1 < rows.length ? +rows[i + 1][1] - +r[1] : NaN }));
}
// Byte ranges of the rows `want(row)` accepts, neighbours merged; also the wanted keys not found.
function idxRanges(rows, want) {
  const out = [];
  rows.forEach(r => {
    if (!want(r) || !isFinite(r.len)) return;
    const last = out[out.length - 1];
    if (last && last.offset + last.length === r.off) last.length += r.len; else out.push({ offset: r.off, length: r.len });
  });
  return out;
}

// GRIB2 message (as decoded by fetch-wxoutlook.js decodeGrib2) -> field key: 'UGRD:250', 'HGT:300',
// 'UGRD:maxw', 'ICAHT:maxw', 'ICAHT:trop', 'PRES:convtop', 'PRES:convbot', 'CPRAT:avg'; null otherwise.
const PARAM = { '2.2': 'UGRD', '2.3': 'VGRD', '3.5': 'HGT', '3.3': 'ICAHT', '3.0': 'PRES' };
function keyOf(m) {
  if (m.discipline !== 0) return null;
  if (m.cat === 1 && (m.num === 37 || m.num === 196) && m.surfType === 1) return m.pdtn === 8 ? 'CPRAT:avg' : null;
  const p = PARAM[m.cat + '.' + m.num]; if (!p) return null;
  if (m.surfType === 100) return p + ':' + Math.round(m.surfValue / 100);
  if (m.surfType === 7) return p + ':trop';
  if (m.surfType === 6) return p + ':maxw';
  if (m.surfType === 243) return p + ':convtop';
  if (m.surfType === 242) return p + ':convbot';
  return null;
}
// Crop a decoded regular lat/lon message (global or a filter subregion) to box { s, n, w, e } at
// spacing d (must be a multiple of the message's). Points the message does not cover are NaN.
function crop(m, box, d) {
  d = d || m.dj;
  const nlat = Math.round((box.n - box.s) / d) + 1, nlon = Math.round((box.e - box.w) / d) + 1, out = new Float32Array(nlat * nlon);
  const sn = (m.scan & 0x40) ? 1 : -1, we = (m.scan & 0x80) ? -1 : 1, global = m.ni * m.di >= 359.9;
  for (let j = 0; j < nlat; j++) {
    const lat = box.s + j * d, jj = Math.round((lat - m.la1) / (m.dj * sn));
    for (let i = 0; i < nlon; i++) {
      const lon = box.w + i * d, dl = ((((lon - m.lo1) * we) % 360) + 360) % 360;
      let ii = Math.round(dl / m.di); if (global) ii %= m.ni;
      out[j * nlon + i] = (jj < 0 || jj >= m.nj || ii < 0 || ii >= m.ni) ? NaN : m.values[jj * m.ni + ii];
    }
  }
  return { v: out, nlat, nlon, d, s: box.s, w: box.w };
}

// ---- digest helpers --------------------------------------------------------------------------------
// The size x size window of an output grid with the highest sum of counts[] (row-major): { j, i, sum }.
function hotWindow(counts, og, size) {
  let best = { j: 0, i: 0, sum: 0 };
  for (let j = 0; j + size <= og.nlat; j++) for (let i = 0; i + size <= og.nlon; i++) {
    let s = 0; for (let a = 0; a < size; a++) for (let b = 0; b < size; b++) s += counts[(j + a) * og.nlon + i + b];
    if (s > best.sum) best = { j, i, sum: s };
  }
  return best;
}
const fmtLat = v => Math.abs(v) + (v >= 0 ? 'N' : 'S');
const fmtLon = v => Math.abs(v) + (v > 0 ? 'E' : v < 0 ? 'W' : '');
// "45–55N 40–30W", "25–35N 45–55E", "45–55N 10W–5E" (south–north, west–east).
function fmtBox(s, n, w, e) {
  const la = (s < 0) === (n < 0) ? Math.abs(s) + '–' + fmtLat(n) : fmtLat(s) + '–' + fmtLat(n);
  const lo = (w < 0 && e < 0) || (w > 0 && e > 0) ? Math.abs(w) + '–' + fmtLon(e) : fmtLon(w) + '–' + fmtLon(e);
  return la + ' ' + lo;
}
const fmtPos = (lat, lon) => fmtLat(Math.round(lat)) + ' ' + fmtLon(Math.round(lon));

module.exports = { RE, G, KT, FT, isaFt, flOf, grads, deformation, layerTI1, BAND_LAYERS, BAND_FL, maxOf, smooth, sample,
                   jetAxes, pathKm, jetDepth, simplifyPath, clipPath, CB_CPR, CB_COV, cbCover, cbFields,
                   outGrid, block, kthHighest, classGrid, blockGrid, median, percentile, rleEncode, rleDecode, flB64, flB64Decode,
                   cycleOf, latestCycle, cycleLabel, aheadPlan, awsFile, nomadsUrl, parseIdx, idxRanges, keyOf, crop,
                   hotWindow, fmtLat, fmtLon, fmtBox, fmtPos };
