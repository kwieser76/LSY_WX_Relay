#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-dust.js
// The week-ahead dust forecast for the Middle East map: NOAA's GEFS-Aerosols control run, dust aerosol
// optical depth at 550 nm, read for the five days it reaches (to +120 h) and reduced to the daily
// maximum class per 0.5° cell over 3–47N, 14–82E, plus the same per Middle East hub.
//
// Why: dust and sand haze is the Gulf's weather risk most weeks of the year, and nothing else in the
// briefing forecasts it. NOAA's product is public domain and needs no account; CAMS needs a token
// (CC BY 4.0 but a queued API), national met services forbid reuse, NASA GEOS-FP is research-only.
//
// Source: the NOAA open-data mirror on AWS (registry.opendata.aws/noaa-gefs: "open to the public and
// can be used as desired"), noaa-gefs-pds/gefs.YYYYMMDD/CC/chem/pgrb2ap25/gefs.chem.tCCz.a2d_0p25.fFFF.grib2,
// one .idx per step and ONE HTTP Range per step for the AOTK "Dust dry" 550 nm message (~362 KB, complex
// packing, read by fetch-wxoutlook.js's decoder). 4 steps a day (00/06/12/18Z valid), 5 days: 20 index
// requests + 20 ranges, ~7.3 MB. Measured 2026-10-06 (research): index 0.35 s, field 0.81 s.
//
// Successor: NOAA PNS 26-07 proposes replacing GEFS-Aerosols with GCAFS v1 (00 and 12 UTC only, same
// pgrb2ap25 product names; the path may change). The fetcher therefore asks for 00Z/12Z cycles only and
// reports a missing run as missing — it never fills the gap from another model.
// Model-derived column dust, not surface visibility, and not for operational use.
// ---------------------------------------------------------------------------
'use strict';

const U = require('./fetch-util.js');
const WX = require('./fetch-wxoutlook.js');   // decodeGrib2, getBuffer, getRange, nearestIndex, pool (pure helpers)

const HOST = 'https://noaa-gefs-pds.s3.amazonaws.com';
const fileUrl = (c, step) => HOST + '/gefs.' + c.date + '/' + c.hh + '/chem/pgrb2ap25/gefs.chem.t' + c.hh + 'z.a2d_0p25.f' + String(step).padStart(3, '0') + '.grib2';
const MODEL = 'NOAA GEFS-Aerosols';
const VAR = 'Dust aerosol optical depth at 550 nm (AOTK, aerosol=Dust dry), column';
const ATTRIBUTION = 'Dust forecast: NOAA GEFS-Aerosols (NCEP), via the NOAA Open Data Dissemination program on AWS — public domain. ' +
  'Reduced to daily maximum classes by the relay; model-derived, not an official forecast.';
const LAG_H = 5;                 // a 00Z run is complete on the mirror by about 04:30 UTC; an earlier run is the fallback
const MAX_STEP = 120;
const HOURS = [0, 6, 12, 18];
const DAYS = 5;
const PARALLEL = 4;
const GRID = { res: 0.5, lat0: 3, lon0: 14, nlat: 88, nlon: 136 };              // 3–47N, 14–82E (the build contract's ME box)
// The same global field also covers the other map frames at no extra download: the Saharan plume over the
// eastern Atlantic and the Caribbean. Measured on the 7 Oct 2026 field: ~180 B (atl) and ~7 B (na) per day.
// The visible Middle East view (research: Istanbul to Aden, Cairo to Mashhad). The digest names the peak inside
// it as well, because the box's south-west corner holds the Bodélé depression, the Sahara's strongest dust source.
const CORE = { s: 12, n: 42, w: 28, e: 62 };
const EXTRA = { atl: { res: 0.5, lat0: 25, lon0: -80, nlat: 100, nlon: 240 }, na: { res: 0.5, lat0: 13, lon0: -170, nlat: 118, nlon: 240 } };
// AOD class edges: 0 < 0.25 · 1 light 0.25–0.5 · 2 moderate 0.5–1 · 3 heavy 1–2 · 4 very heavy ≥ 2
const EDGES = [0.25, 0.5, 1, 2];
const CLASSES = [{ v: 0, label: 'none or trace', max: 0.25 }, { v: 1, label: 'light dust haze', min: 0.25, max: 0.5 },
  { v: 2, label: 'moderate dust', min: 0.5, max: 1 }, { v: 3, label: 'heavy dust', min: 1, max: 2 }, { v: 4, label: 'very heavy dust', min: 2 }];
const classOf = v => (v == null || isNaN(v)) ? 0 : v < EDGES[0] ? 0 : v < EDGES[1] ? 1 : v < EDGES[2] ? 2 : v < EDGES[3] ? 3 : 4;
// The hub list ([icao, lat, lon] per airport). Empty in this relay copy, and the relay also passes hubs: [].
const HUBS = [];

// Run-length text, the format of the other map grids: "v" for one cell, "v*n" for n cells of value v.
function rleEncode(a) {
  const out = [];
  for (let k = 0; k < a.length;) { let n = 1; while (k + n < a.length && a[k + n] === a[k]) n++; out.push(n > 1 ? a[k] + '*' + n : String(a[k])); k += n; }
  return out.join(',');
}

// Newest 00Z/12Z cycle that is at least LAG_H old, then the two before it.
function dustCycles(nowIso) {
  const now = new Date(nowIso || Date.now()).getTime() - LAG_H * 3600000;
  const c0 = Math.floor(now / (12 * 3600000)) * 12 * 3600000;
  return [0, 1, 2].map(k => { const iso = new Date(c0 - k * 12 * 3600000).toISOString();
    return { iso, date: iso.slice(0, 10).replace(/-/g, ''), hh: iso.slice(11, 13), label: iso.slice(0, 10) + 'T' + iso.slice(11, 13) + 'Z' }; });
}
// The steps for `days` calendar days from `fromDay`, valid at HOURS, that this cycle reaches.
function dustSteps(cycle, fromDay, days) {
  const c = Date.parse(cycle.iso), out = [];
  for (let d = 0; d < days; d++) {
    const date = U.addDays(fromDay, d);
    HOURS.forEach(h => { const step = (Date.parse(date + 'T' + String(h).padStart(2, '0') + ':00:00Z') - c) / 3600000;
      if (step >= 0 && step <= MAX_STEP && step % 3 === 0) out.push({ date, hour: h, step }); });
  }
  return out;
}
// The dust 550 nm AOD message in a .idx: its byte offset and length (to the next message).
function pickDust(idxText) {
  const lines = String(idxText || '').split('\n').filter(Boolean).map(l => l.split(':'));
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k], s = l.join(':');
    if (l[3] === 'AOTK' && /aerosol=Dust dry/.test(s) && /aerosol_wavelength >=5\.45e-07,<=5\.65e-07/.test(s)) {
      const off = +l[1], next = lines[k + 1] ? +lines[k + 1][1] : NaN;
      if (!isFinite(off) || !isFinite(next) || next <= off) return null;
      return { offset: off, length: next - off };
    }
  }
  return null;
}
// Max of the 2x2 source points (0.25°) in each 0.5° cell of the box. `at(lat, lon)` -> value or null.
function boxMax(at, g) {
  const v = new Float32Array(g.nlat * g.nlon).fill(NaN);
  for (let j = 0; j < g.nlat; j++) for (let i = 0; i < g.nlon; i++) {
    let m = NaN;
    for (const dy of [0, 0.25]) for (const dx of [0, 0.25]) { const x = at(g.lat0 + j * g.res + dy, g.lon0 + i * g.res + dx); if (x != null && !(x <= m)) m = x; }
    v[j * g.nlon + i] = m;
  }
  return v;
}
// Daily maxima over the steps of each day -> the snapshot's days[] (classes RLE, max AOD, where, class counts).
function reduceDays(stepFields, g, core) {
  const byDay = {};
  stepFields.forEach(s => { const d = byDay[s.date] = byDay[s.date] || { date: s.date, valid: [], max: null };
    d.valid.push(String(s.hour).padStart(2, '0') + 'Z');
    if (!d.max) d.max = Float32Array.from(s.values); else for (let k = 0; k < s.values.length; k++) if (s.values[k] > d.max[k] || isNaN(d.max[k])) d.max[k] = s.values[k]; });
  return Object.keys(byDay).sort().map(date => {
    const d = byDay[date], cls = Array.from(d.max, classOf), cells = [0, 0, 0, 0, 0];
    let mx = -1, at = null, cm = -1, cat = null;
    const pos = k => [Math.round((g.lat0 + (Math.floor(k / g.nlon) + 0.5) * g.res) * 10) / 10, Math.round((g.lon0 + (k % g.nlon + 0.5) * g.res) * 10) / 10];
    cls.forEach((c, k) => { cells[c]++; if (d.max[k] > mx) { mx = d.max[k]; at = k; }
      if (core && d.max[k] > cm) { const p = pos(k); if (p[0] >= core.s && p[0] <= core.n && p[1] >= core.w && p[1] <= core.e) { cm = d.max[k]; cat = k; } } });
    const out = { date, valid: d.valid, grid: rleEncode(cls), maxAod: Math.round(mx * 100) / 100, maxAt: at == null ? null : pos(at), cells };
    if (core) { out.coreAod = cat == null ? null : Math.round(cm * 100) / 100; out.coreAt = cat == null ? null : pos(cat); }
    return out;
  });
}
const R = Math.PI / 180;
const km = (a, b, c, d) => 6371 * Math.acos(Math.min(1, Math.sin(a * R) * Math.sin(c * R) + Math.cos(a * R) * Math.cos(c * R) * Math.cos((d - b) * R)));
function nearHub(lat, lon) {
  let best = null;
  HUBS.forEach(h => { const d = km(lat, lon, h[1], h[2]); if (!best || d < best.km) best = { icao: h[0], km: Math.round(d) }; });
  return best && best.km <= 400 ? best : null;
}
const fmtPos = (lat, lon) => Math.abs(lat) + (lat < 0 ? 'S ' : 'N ') + Math.abs(lon) + (lon < 0 ? 'W' : 'E');

// hubs (the public week-ahead relay, tools/wx-relay, passes []): the [icao, lat, lon] list the hub values
// are read for. An empty list leaves hubs [] in the snapshot. Absent = HUBS, unchanged.
async function fetchDust({ backfill, hubs }) {
  if (backfill) throw new Error('--backfill is not supported: a forecast is only worth what it said before the week it covers');
  const HUB_LIST = Array.isArray(hubs) ? hubs : HUBS;
  const t0 = Date.now(), notes = [], req = { n: 0, bytes: 0 };
  const fromDay = U.today();
  let cycle = null, idx0 = null;
  for (const c of dustCycles()) {
    const steps = dustSteps(c, fromDay, DAYS);
    const last = steps[steps.length - 1];
    try { req.n++; idx0 = await U.getText(fileUrl(c, last.step) + '.idx', { accept: 'text/plain', retries: 0 }); cycle = c; break; }
    catch (e) {
      // 403/429 means stop asking this host (build rule), not "try an older run".
      if (/HTTP (403|429)/.test(e.message)) throw new Error('NOAA mirror answered ' + /HTTP (403|429)/.exec(e.message)[1] + ' — stopped asking');
      notes.push('run ' + c.label + ' not (yet) on the NOAA mirror: ' + e.message.replace(/^.*: /, ''));
    }
  }
  if (!cycle) throw new Error('no GEFS-Aerosols run found on the NOAA mirror (' + dustCycles().map(c => c.label).join(', ') +
    '). If NOAA has switched to GCAFS (PNS 26-07), the path changed — update fileUrl');
  const steps = dustSteps(cycle, fromDay, DAYS), fields = [], hubVals = {};
  await WX.pool(steps, PARALLEL, async (s, k) => {
    const url = fileUrl(cycle, s.step);
    try {
      let idx = (k === steps.length - 1 && idx0) ? idx0 : null;
      if (!idx) { req.n++; idx = await U.getText(url + '.idx', { accept: 'text/plain' }); }
      const r = pickDust(idx);
      if (!r) { notes.push('f' + s.step + ': no dust 550 nm message in the index'); return; }
      req.n++;
      const buf = await WX.getRange(url, r.offset, r.length, { timeoutMs: 30000 });
      req.bytes += buf.length;
      const g = WX.decodeGrib2(buf)[0];
      const at = (lat, lon) => { const i = WX.nearestIndex(g, lat, lon); return i < 0 || isNaN(g.values[i]) ? null : g.values[i]; };
      fields.push({ date: s.date, hour: s.hour, values: boxMax(at, GRID), extra: Object.keys(EXTRA).reduce((o, a) => { o[a] = boxMax(at, EXTRA[a]); return o; }, {}) });
      HUB_LIST.forEach(h => { const v = at(Math.round(h[1] * 4) / 4, Math.round(h[2] * 4) / 4); const o = hubVals[h[0]] = hubVals[h[0]] || {};
        if (v != null && !(o[s.date] >= v)) o[s.date] = v; });
    } catch (e) { notes.push('f' + s.step + ' (' + s.date + ' ' + String(s.hour).padStart(2, '0') + 'Z): ' + e.message.replace(/^https?:\/\/\S+\s*/, '')); }
  });
  if (!fields.length) throw new Error('no dust field could be read from run ' + cycle.label);
  fields.sort((a, b) => (a.date + a.hour < b.date + b.hour ? -1 : 1));
  const days = reduceDays(fields, GRID, CORE);
  days.forEach(d => { if (d.valid.length < HOURS.length) notes.push(d.date + ': ' + d.valid.length + ' of ' + HOURS.length + ' time steps (' + d.valid.join(', ') + ') — the daily maximum may be low'); });
  const dates = days.map(d => d.date);
  const areas = {};
  Object.keys(EXTRA).forEach(a => { const G = EXTRA[a];
    areas[a] = { res: G.res, lat0: G.lat0, lon0: G.lon0, nlat: G.nlat, nlon: G.nlon,
                 days: reduceDays(fields.map(f => ({ date: f.date, hour: f.hour, values: f.extra[a] })), G) }; });
  const hubRows = HUB_LIST.map(h => ({ icao: h[0], lat: h[1], lon: h[2],
    aod: dates.map(d => (hubVals[h[0]] || {})[d] == null ? null : Math.round(hubVals[h[0]][d] * 100) / 100),
    cls: dates.map(d => classOf((hubVals[h[0]] || {})[d])) }));
  notes.push('No dust forecast for days 6–7: GEFS-Aerosols runs to 120 h.');
  notes.push('NOAA plans to replace GEFS-Aerosols with GCAFS v1 (PNS 26-07: 00 and 12 UTC runs, 5 days, same pgrb2ap25 product names; the path may change). A missing run is reported here, never filled from another model.');
  notes.push('Dust optical depth is the whole air column, not surface visibility; model-derived, not for operational use.');
  const worst = days.slice().sort((a, b) => b.maxAod - a.maxAod)[0];
  return {
    model: MODEL, source: HOST + '/ (noaa-gefs-pds, chem/pgrb2ap25)', page: 'https://registry.opendata.aws/noaa-gefs/',
    run: cycle.label, var: VAR, units: '1 (dimensionless optical depth)',
    res: GRID.res, lat0: GRID.lat0, lon0: GRID.lon0, nlat: GRID.nlat, nlon: GRID.nlon, encoding: 'rle',
    layout: 'row-major, south→north rows, west→east columns; cell value = class of the day\'s maximum over the 00/06/12/18Z steps and the 2x2 0.25° points in the cell',
    classes: CLASSES, outlook: { from: dates[0], to: dates[dates.length - 1] },
    days, hubs: hubRows, areas, attribution: ATTRIBUTION,
    licence: { text: 'NOAA data, public domain: "open to the public and can be used as desired" (AWS Registry of Open Data).', url: 'https://registry.opendata.aws/noaa-gefs/' },
    notes, requests: { 'noaa-gefs-pds.s3.amazonaws.com': req.n }, megabytes: Math.round(req.bytes / 1e5) / 10, seconds: Math.round((Date.now() - t0) / 100) / 10,
    summary: ['run ' + cycle.label + ': ' + days.length + ' days (' + fields.length + '/' + steps.length + ' steps), peak AOD ' + (worst ? worst.maxAod + ' on ' + worst.date : '—') +
      ' · ' + req.n + ' requests, ' + Math.round(req.bytes / 1e5) / 10 + ' MB'],
  };
}

// ---- digest --------------------------------------------------------------------------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDay = d => WD[new Date(d + 'T00:00:00Z').getUTCDay()] + ' ' + (+d.slice(8, 10)) + ' ' + MON[+d.slice(5, 7) - 1];
function digest(s) {
  const L = [], days = s.days || [];
  L.push('DUST FORECAST (' + s.model + ', run ' + s.run + ', ' + days.length + ' days) — Middle East 3–47N 14–82E, model-derived dust optical depth (550 nm, whole column)');
  L.push('Credit: ' + s.attribution);
  L.push('Classes: <0.25 none · 0.25–0.5 light haze · 0.5–1 moderate · 1–2 heavy · ≥2 very heavy (daily maximum over 00/06/12/18Z).');
  days.forEach((d, k) => {
    const nb = d.maxAt ? nearHub(d.maxAt[0], d.maxAt[1]) : null;
    const hubs = (s.hubs || []).filter(h => h.cls[k] >= 2).map(h => h.icao + ' ' + CLASSES[h.cls[k]].label.replace(' dust', '') + ' (' + h.aod[k] + ')');
    const nc = d.coreAt ? nearHub(d.coreAt[0], d.coreAt[1]) : null;
    L.push('  ' + fmtDay(d.date) + ': peak in 12–42N 28–62E ' + (d.coreAod != null ? d.coreAod + ' at ' + fmtPos(d.coreAt[0], d.coreAt[1]) + (nc ? ' (' + nc.km + ' km from ' + nc.icao + ')' : '') : '—') +
      ' · box peak ' + d.maxAod + (d.maxAt ? ' at ' + fmtPos(d.maxAt[0], d.maxAt[1]) + (nb ? ' (' + nb.km + ' km from ' + nb.icao + ')' : '') : '') +
      ' · cells moderate or worse: ' + (d.cells[2] + d.cells[3] + d.cells[4]) + ' · hubs moderate or worse: ' + (hubs.join(', ') || 'none'));
  });
  if (s.notes && s.notes.length) L.push('NOTES: ' + s.notes.join(' '));
  L.push('HOW TO USE THIS BLOCK');
  L.push('- Week-ahead context for Gulf and Middle East operations: name a hub only where it reaches moderate or worse, and say "model-derived dust');
  L.push('  forecast (NOAA GEFS-Aerosols)". Optical depth is not visibility: write "dust haze likely", never a visibility figure. Days 6–7 have no dust forecast.');
  return L.join('\n');
}

module.exports = { HOST, fileUrl, GRID, CORE, EXTRA, EDGES, CLASSES, HUBS, classOf, rleEncode, dustCycles, dustSteps, pickDust, boxMax, reduceDays, nearHub, fetchDust, digest };
if (require.main === module) U.main('fetch-dust', 'dust', fetchDust, digest);
