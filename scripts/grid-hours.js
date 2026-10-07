// ---------------------------------------------------------------------------
// grid-hours.js
// Shared by fetch-mrms.js (US radar storm hours) and fetch-eccc-lightning.js (Canadian lightning):
// a binary GET with the project's identity, the run-length text format of the weather grids, and the
// reduction "one 0/1 grid per sampled hour → hours per 0.5° cell per day" with the day's busiest cell and
// the week's busiest areas. Same formats as fetch-lightning.js (MTG, Europe), so the dashboards draw all
// three with one routine.
// ---------------------------------------------------------------------------
'use strict';

const U = require('./fetch-util.js');

// ---- small helpers ----------------------------------------------------------------------------
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = d => wd(d) + ' ' + (+d.slice(8, 10)) + ' ' + MON[+d.slice(5, 7) - 1];     // 'Wed 30 Sep'
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };
const latLon = (lat, lon) => Math.abs(lat) + (lat < 0 ? 'S ' : 'N ') + Math.abs(lon) + (lon < 0 ? 'W' : 'E');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const ymd = ms => new Date(ms).toISOString().slice(0, 10);

// Run-length text, the format of fetch-wxreview.js / fetch-lightning.js: "v" for one cell, "v*n" for n cells of value v.
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

// ---- one binary GET -------------------------------------------------------------------------------
// The project's User-Agent, a timeout, and one retry after 2 s for a network error, a timeout or a 5xx.
// Never a retry on a 4xx: a 403/429 must stop the host for the run, a 404 is a missing file.
async function getBin(url, opts) {
  const o = Object.assign({ timeoutMs: 30000, retries: 1, accept: '*/*' }, opts || {});
  let last = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (attempt) await U.sleep(2000);
    const ac = new AbortController(), t0 = Date.now();
    const t = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': U.UA, Accept: o.accept } });
      const buf = Buffer.from(await res.arrayBuffer());
      last = { status: res.status, buf, ms: Date.now() - t0, attempts: attempt + 1 };
      if (res.status >= 500) continue;
      return last;
    } catch (e) {
      last = { status: 0, error: (e && e.name === 'AbortError') ? 'timeout after ' + o.timeoutMs + ' ms' : String((e && e.message) || e), ms: Date.now() - t0, attempts: attempt + 1 };
    } finally { clearTimeout(t); }
  }
  return last;
}

// Request order: the hours spread over the day (00, 12, 06, 18, …), each for all days, so a run cut short
// by its time budget still samples every day alike instead of losing the last days.
const HOUR_ORDER = [0, 12, 6, 18, 3, 15, 9, 21, 1, 13, 7, 19, 4, 16, 10, 22, 2, 14, 8, 20, 5, 17, 11, 23];
function spread(frames, order) {
  const out = [];
  (order || HOUR_ORDER).forEach(h => frames.forEach(f => { if (f.hour === h) out.push(f); }));
  return out;
}

// Median / p90 / max of the request times.
function timing(ms, extra) {
  const q = ms.slice().sort((a, b) => a - b), at = p => q[Math.min(q.length - 1, Math.floor(p * q.length))];
  return q.length ? Object.assign({ medianMs: at(0.5), p90Ms: at(0.9), maxMs: q[q.length - 1] }, extra || {}) : null;
}

// ---- aggregation ----------------------------------------------------------------------------------
// frames: [{ date, hour, lit: Uint8Array | null (null = not read), empty?: bool }]; dates: the window's days;
// grid { res, lat0, lon0, nlat, nlon } (row-major south→north, west→east); cover: Uint8Array | null (0 = no data,
// forced to 0); areaOf(lat, lon) → plain-words name; field: the name of the per-day RLE ('grid' or 'hours').
function aggregateHours(frames, dates, grid, cover, areaOf, field) {
  const g = grid, N = g.nlat * g.nlon, key = field || 'grid';
  const cellCenter = k => [g.lat0 + (Math.floor(k / g.nlon) + 0.5) * g.res, g.lon0 + (k % g.nlon + 0.5) * g.res];
  const week = new Uint16Array(N);
  const days = dates.map(date => {
    const fr = frames.filter(f => f.date === date);
    const hours = new Map();                                     // hour → cells lit in any frame of that hour
    fr.forEach(f => { if (!f.lit) return; const h = hours.get(f.hour) || new Uint8Array(N); for (let k = 0; k < N; k++) if (f.lit[k]) h[k] = 1; hours.set(f.hour, h); });
    const v = new Uint8Array(N);
    hours.forEach(h => { for (let k = 0; k < N; k++) v[k] += h[k]; });
    if (cover) for (let k = 0; k < N; k++) if (!cover[k]) v[k] = 0;
    let max = 0, cells = 0, peakK = -1;
    for (let k = 0; k < N; k++) { week[k] += v[k]; if (v[k]) cells++; if (v[k] > max) { max = v[k]; peakK = k; } }
    const read = fr.filter(f => f.lit);
    const missingHours = [...new Set(fr.filter(f => !f.lit).map(f => f.hour))].filter(h => !hours.has(h)).sort((a, b) => a - b);
    const day = { date, samples: read.length, missing: fr.length - read.length, empty: read.filter(f => f.empty).length, max, cells };
    day[key] = rleEncode(v);
    if (missingHours.length) day.missingHours = missingHours;
    if (peakK >= 0) { const [la, lo] = cellCenter(peakK); day.peak = { lat: la, lon: lo, hours: max, area: areaOf(la, lo) }; }
    return { day, v };
  });
  const byArea = new Map();
  days.forEach(({ day, v }) => { for (let k = 0; k < N; k++) if (v[k]) {
    const [la, lo] = cellCenter(k), name = areaOf(la, lo);
    const a = byArea.get(name) || (byArea.set(name, { area: name, cellHours: 0, byDay: {} }), byArea.get(name));
    a.cellHours += v[k]; a.byDay[day.date] = (a.byDay[day.date] || 0) + v[k];
  } });
  const hotspots = [...byArea.values()].sort((a, b) => b.cellHours - a.cellHours || a.area.localeCompare(b.area)).slice(0, 6).map(a => {
    const pd = Object.entries(a.byDay).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    return { area: a.area, cellHours: a.cellHours, peakDate: pd[0], peakCellHours: pd[1] };
  });
  let weekMax = 0; for (let k = 0; k < N; k++) if (week[k] > weekMax) weekMax = week[k];
  const ds = days.map(x => x.day);
  return { days: ds, week: rleEncode(week), weekMax, max: Math.max(0, ...ds.map(d => d.max)), litCells: week.filter(v => v > 0).length, hotspots };
}

// A plain-words name from a list of boxes [name, latS, latN, lonW, lonE]; the first box that holds the point wins.
const areaNamer = boxes => (lat, lon) => {
  const a = boxes.find(([, s, n, w, e]) => lat >= s && lat < n && lon >= w && lon < e);
  return a ? a[0] : 'near ' + latLon(Math.round(lat), Math.round(lon));
};

// The coverage edge in words for the digest: per longitude, the southern- / northernmost covered latitude.
function coveredLatRange(cover, grid, lon) {
  const i = Math.floor((lon - grid.lon0) / grid.res);
  if (!cover || i < 0 || i >= grid.nlon) return null;
  let s = null, n = null;
  for (let j = 0; j < grid.nlat; j++) if (cover[j * grid.nlon + i]) { const lat = grid.lat0 + j * grid.res; if (s === null) s = lat; n = lat + grid.res; }
  return s === null ? null : [s, n];
}

module.exports = { wd, fmtDay, daysOf, latLon, clip, ymd, rleEncode, rleDecode, getBin, HOUR_ORDER, spread, timing,
                   aggregateHours, areaNamer, coveredLatRange };
