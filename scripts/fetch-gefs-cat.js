#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-gefs-cat.js
// Ensemble clear-air-turbulence (CAT) probability for days 3–7 of the week ahead, computed by us from
// the NOAA Global Ensemble Forecast System (GEFS v12, control + 30 perturbed members). The official
// WAFS SIGWX ends at +48 h and our model-derived CAT (fetch-sigwx-model.js) at +72 h, because one
// deterministic CAT polygon is not credible beyond that. Here every member is run through the same
// Ellrod TI1 "CAT potential" rule as fetch-sigwx-model.js, and each 2° cell gets the share of members
// that flag it: "x % of members", never a moderate/severe grade (PO decision 2026-10-07, BUILD-SPEC §4).
// Every snapshot and digest line says "MODEL-DERIVED · GEFS ENSEMBLE · NOT AN OFFICIAL SIGWX".
//
// Days: the 7 week-ahead dates of fetch-sigwx-model.js (12Z, from the latest complete GFS cycle, never a
// day of the reporting window); this file fills dates 3–7 of them. Leads from the GEFS cycle: 60–156 h
// for the 00Z run on a normal morning. Days 4–7 are flagged low confidence.
//
// Per member and day (pure functions below, Ellrod helpers in sigwx-diag.js, read-only):
//   TI1 = vertical wind shear × total deformation per 50-hPa layer, 300–250 and 250–200 hPa, smoothed once
//   (1-2-1); band 300 / 250 / 200 hPa (FL300 / FL340 / FL390) as in fetch-sigwx-model.js, except that the
//   0.5° GEFS "a" file has no 350 or 150 hPa: band 300 = the 300–250 layer only, band 200 = the 250–200
//   layer only, band 250 = the higher of both (exactly the deterministic rule). A member flags a 2° cell
//   when at least 5 of its 25 0.5° points reach 8 × 1e-7 s^-2 (fetch-sigwx-model.js CAT_FIXED[0], the
//   "CAT potential" class). Cell value = round(100 × flagging members / members read).
//   Layer depth: geopotential heights of the ensemble mean (geavg) for all members; their own winds. This
//   halves the download (heights are 40 % of the bytes). The snapshot's `check` measures what it costs
//   on the control member (own heights vs ensemble-mean heights). --member-heights reads every member's
//   own heights instead (about 245 MB a run).
//
// Source, anonymous, no key, NOAA/NWS public domain (https://www.weather.gov/disclaimer — derived data
// must not be presented as official or NOAA-endorsed; the snapshot says so):
//   AWS open data  https://noaa-gefs-pds.s3.amazonaws.com — gefs.YYYYMMDD/HH/atmos/pgrb2ap5/
//   <gec00|gep01..30|geavg>.tHHz.pgrb2a.0p50.fFFF (+ .idx). Per member and day: the .idx, then HTTP Range
//   for UGRD+VGRD at 300, 250, 200 hPa (three adjacent pairs = three ranges). Complex packing with
//   second-order spatial differencing (template 5.3), decoded by fetch-wxoutlook.js decodeGrib2 +
//   grib-complex.js (read-only). Cycle: the latest 00Z at least LAG_H old; else the 18Z before it, else
//   the 00Z a day earlier (the first request — the last member's .idx at the longest lead — decides).
//   At most PARALLEL files in flight; HTTP 403, 429 or 503 (S3 "SlowDown") stops the run's requests at
//   once (no retry), and the days with enough members are still written.
//
// Measured on W40 (2026-10-07): see the summary line and the build report (G-report.md).
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const U = require('./fetch-util.js');
const WX = require('./fetch-wxoutlook.js');      // decodeGrib2, pool (shared, read-only)
const D = require('./sigwx-diag.js');
const SM = require('./fetch-sigwx-model.js');   // AREAS, WORK, OG, BANDS, CAT_FIXED: the same frames and threshold

const NAME = 'fetch-gefs-cat', DIR = 'gefscat';
const LABEL = 'MODEL-DERIVED · GEFS ENSEMBLE · NOT AN OFFICIAL SIGWX';
const SOURCE = 'NOAA GEFS v12 0.5° (NCEP global ensemble: control + 30 perturbed members), forecasts';
const ATTRIBUTION = 'Derived by the LSY WX Relay from NOAA GEFS data (NOAA/NCEP, public domain). Not a NOAA/NWS product; not endorsed by NOAA.';
const DISCLAIMER = 'Model-derived ensemble probability computed by the LSY WX Relay from NOAA GEFS data. Not an official WAFS SIGWX chart or turbulence forecast, not issued or checked by a WAFC or any meteorological authority; not for flight planning or operational use. ' +
  'Each value is the share of the 31 GEFS members whose Ellrod TI1 index reaches the "CAT potential" threshold used by the model-derived SIGWX layer; it is the probability of a model index, not of turbulence, and not a turbulence grade. ' +
  'The index catches about 55–60 % of turbulence reports while also flagging 15–30 % of smooth air in comparable studies; it misses convective and mountain-wave turbulence. Days 4–7 are low confidence.';
const LICENCE = { name: 'Public domain (NOAA/NWS data)', url: 'https://www.weather.gov/disclaimer', note: 'Derived data must not be presented as official NOAA/NWS information or as endorsed by NOAA.' };
const PAGES = { gefs: 'https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gefs.php', aws: 'https://registry.opendata.aws/noaa-gefs/', disclaimer: 'https://www.weather.gov/disclaimer' };

const BUCKET = 'https://noaa-gefs-pds.s3.amazonaws.com';
const HOST = 'noaa-gefs-pds.s3.amazonaws.com';
const MEMBERS = ['gec00'].concat(Array.from({ length: 30 }, (_, i) => 'gep' + String(i + 1).padStart(2, '0')));
const MEAN = 'geavg';
const LEVELS = [300, 250, 200];                                 // hPa; the a file has no 350 / 150
const LAYERS = [[300, 250], [250, 200]];
const BAND_LAYERS = { '300': ['300-250'], '250': ['300-250', '250-200'], '200': ['250-200'] };
const BAND_NOTE = { '300': { fl: 'FL300', layers: '300–250 hPa (≈ FL300–340); the deterministic layer adds 350–300 hPa' },
                    '250': { fl: 'FL340', layers: '300–250 and 250–200 hPa (≈ FL300–390), as the deterministic layer' },
                    '200': { fl: 'FL390', layers: '250–200 hPa (≈ FL340–390); the deterministic layer adds 200–150 hPa' } };
const AREA_IDS = SM.AREA_IDS, AREAS = SM.AREAS, OG = SM.OG, WORK = SM.WORK, BANDS = SM.BANDS;
const THRESHOLD = SM.CAT_FIXED[0], MIN_PTS = 5, HALF = 1, GEFS_RES = 0.5, SMOOTH = 1;
const FIRST_DAY = 3, LAST_DAY = 7;                              // ahead dates 3..7 (1 = first ahead date)
const GFS_LAG_H = 5, LAG_H = 6, MIN_MEMBERS = 21, MISSING = 255;
const PARALLEL = 6, TIMEOUT_MS = 45000, SOFT_DEADLINE_S = 150;

const r1 = x => Math.round(x * 10) / 10;
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const fmtDay = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const pad = (n, w) => String(n).padStart(w || 2, '0');

// ---- plan ---------------------------------------------------------------------------------------
// GEFS cycles to try, newest first: the latest 00Z at least lagH old, the 18Z before it, the 00Z a day
// earlier. Backfill: the 00Z of the day after the window only (the bucket keeps every cycle).
function cycleCandidates(nowMs, lagH, backfillTo) {
  if (backfillTo) return [D.cycleOf(Date.parse(U.addDays(backfillTo, 1) + 'T00:00:00Z'))];
  const day = new Date(nowMs - (lagH == null ? LAG_H : lagH) * 36e5).toISOString().slice(0, 10);
  const c00 = Date.parse(day + 'T00:00:00Z');
  return [c00, c00 - 6 * 36e5, c00 - 24 * 36e5].map(ms => D.cycleOf(ms));
}
// The week-ahead dates exactly as fetch-sigwx-model.js plans them (12Z, never a window day), days
// FIRST_DAY..LAST_DAY, with leads from the GEFS cycle. gfsCycle: what fetch-sigwx-model would use.
function dayPlan(gfsCycle, to, gefsCycle) {
  return D.aheadPlan(gfsCycle, to, LAST_DAY, 72).map((p, k) => ({ day: k + 1, date: p.date, valid: p.date + 'T12:00Z' }))
    .filter(p => p.day >= FIRST_DAY)
    .map(p => Object.assign(p, { lead: Math.round((Date.parse(p.date + 'T12:00:00Z') - gefsCycle.ms) / 36e5) }));
}
// One GEFS 0.5° "a" file (pgrb2ap5) of a member, cycle and forecast hour.
const gefsFile = (bucket, c, member, fh) => bucket + '/gefs.' + c.date.replace(/-/g, '') + '/' + c.hh + '/atmos/pgrb2ap5/' + member + '.t' + c.hh + 'z.pgrb2a.0p50.f' + pad(fh, 3);

// .idx rows wanted: winds at the three levels, and/or heights.
const mbOf = l => { const m = /^(\d+) mb$/.exec(l); return m ? +m[1] : null; };
const idxWanted = (winds, heights) => r => LEVELS.includes(mbOf(r.lev)) && ((winds && (r.v === 'UGRD' || r.v === 'VGRD')) || (heights && r.v === 'HGT'));
const expectedKeys = (winds, heights) => {
  const k = []; LEVELS.forEach(p => { if (winds) k.push('UGRD:' + p, 'VGRD:' + p); if (heights) k.push('HGT:' + p); }); return k;
};
// Decoded messages -> work-grid fields { 'UGRD:250': grid, … }, the first message of each key.
function fieldsOf(msgs) {
  const f = {};
  for (const m of msgs) { const k = D.keyOf(m); if (k && !f[k]) f[k] = D.crop(m, WORK, GEFS_RES); }
  return f;
}

// ---- one member ----------------------------------------------------------------------------------
// f: winds (and heights) of one member; hgt: the heights to use (keys 'HGT:300' …), default f's own.
// Returns per area and band a Uint8Array over the output grid: 1 = the member flags the cell, 0 = not,
// MISSING = no finite point in the cell's block. null when a field is missing.
function memberFlags(f, hgt) {
  const g = Object.assign({}, f);
  LEVELS.forEach(p => { if (hgt && hgt['HGT:' + p]) g['HGT:' + p] = hgt['HGT:' + p]; });
  const dc = {}, layers = {};
  for (const [lo, hi] of LAYERS) {
    const L = D.layerTI1(g, lo, hi, dc);
    if (!L) return null;
    layers[lo + '-' + hi] = D.smooth(L.ti1, L.nlat, L.nlon, SMOOTH);
  }
  const grid = g['UGRD:250'], out = {};
  AREA_IDS.forEach(a => { out[a] = {}; });
  BANDS.forEach(b => {
    const ls = BAND_LAYERS[b].map(k => layers[k]);
    const band = ls.length > 1 ? D.maxOf(ls[0], ls[1]) : ls[0];
    AREA_IDS.forEach(a => {
      const stat = D.blockGrid(band, grid, OG[a], HALF, list => (list.length ? D.kthHighest(list, MIN_PTS) : NaN));
      out[a][b] = Uint8Array.from(stat, v => (isNaN(v) ? MISSING : v >= THRESHOLD ? 1 : 0));
    });
  });
  return out;
}
// Running tally of one day: per area and band the flagging members and the members with data per cell.
function newTally() {
  const t = { members: [] };
  AREA_IDS.forEach(a => { t[a] = {}; const n = OG[a].nlat * OG[a].nlon; BANDS.forEach(b => { t[a][b] = { hit: new Uint16Array(n), seen: new Uint16Array(n) }; }); });
  return t;
}
function addMember(t, member, flags) {
  t.members.push(member);
  AREA_IDS.forEach(a => BANDS.forEach(b => {
    const fl = flags[a][b], T = t[a][b];
    for (let k = 0; k < fl.length; k++) if (fl[k] !== MISSING) { T.seen[k]++; if (fl[k]) T.hit[k]++; }
  }));
}
// Percent of members per cell (0–100), MISSING where no member had data.
const probOf = T => Uint8Array.from(T.hit, (h, k) => (T.seen[k] ? Math.round(100 * h / T.seen[k]) : MISSING));
const probB64 = arr => Buffer.from(arr).toString('base64');
const probB64Decode = s => Array.from(Buffer.from(String(s || ''), 'base64'));
// Cells (all areas and bands) where two flag sets agree, of those with data in both.
function agreement(fa, fb) {
  let n = 0, same = 0, a1 = 0, b1 = 0;
  AREA_IDS.forEach(a => BANDS.forEach(b => {
    const x = fa[a][b], y = fb[a][b];
    for (let k = 0; k < x.length; k++) {
      if (x[k] === MISSING || y[k] === MISSING) continue;
      n++; if (x[k] === y[k]) same++; if (x[k]) a1++; if (y[k]) b1++;
    }
  }));
  return { cells: n, agreePct: n ? r1(100 * same / n) : null, flaggedOwn: a1, flaggedShared: b1 };
}

// ---- HTTP (S3) ----------------------------------------------------------------------------------
// GET (optionally one byte range). 403 / 429 / 503 are a stop signal for the host and never retried;
// 404 = file not there; a network error, timeout or other 5xx gets one retry after 1.5 s.
const STOP_STATUS = [403, 429, 503];
const isStop = status => STOP_STATUS.includes(status);
async function s3Get(url, range, st) {
  if (st.stopped) throw Object.assign(new Error('host stopped earlier in this run'), { stopped: true });
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await U.sleep(1500);
    if (st.stopped) throw Object.assign(new Error('host stopped earlier in this run'), { stopped: true });
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const headers = { 'User-Agent': U.UA, Accept: 'application/octet-stream' };
    if (range) headers.Range = 'bytes=' + range.offset + '-' + (range.offset + range.length - 1);
    try {
      st.requests++;
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers });
      st.status[res.status] = (st.status[res.status] || 0) + 1;
      if (isStop(res.status)) {
        ac.abort();
        if (!st.stopped) st.stopped = { status: res.status, path: url.replace(BUCKET, '') + (range ? ' ' + headers.Range : ''), at: new Date().toISOString() };
        throw Object.assign(new Error('HTTP ' + res.status), { stopped: true, status: res.status });
      }
      if (res.status === 404) { ac.abort(); throw Object.assign(new Error('HTTP 404'), { status: 404 }); }
      if (range ? res.status !== 206 : !res.ok) {
        ac.abort();
        lastErr = 'HTTP ' + res.status + (range && res.status === 200 ? ' (Range ignored; not downloaded)' : '');
        if (res.status < 500) break;
        continue;
      }
      const b = Buffer.from(await res.arrayBuffer());
      st.bytes += b.length;
      if (range && b.length !== range.length) { lastErr = 'got ' + b.length + ' of ' + range.length + ' bytes'; continue; }
      return b;
    } catch (e) {
      if (e.stopped || e.status === 404) throw e;
      lastErr = (e && e.name === 'AbortError') ? 'timeout after ' + TIMEOUT_MS + 'ms' : String((e && e.message) || e);
    } finally { clearTimeout(t); }
  }
  throw new Error(lastErr);
}

// ---- fetching -----------------------------------------------------------------------------------
async function fetchGefsCat({ to, backfill }) {
  const t0 = Date.now(), nowMs = Date.now(), notes = [];
  const memberHeights = U.cli(process.argv).has('--member-heights');
  const st = { requests: 0, bytes: 0, status: {}, stopped: null };
  const late = () => (Date.now() - t0) / 1000 > SOFT_DEADLINE_S;
  const idxCache = new Map();
  const idxOf = url => {
    if (!idxCache.has(url)) idxCache.set(url, s3Get(url + '.idx', null, st).then(b => D.parseIdx(b.toString('latin1'))));
    return idxCache.get(url);
  };
  // The messages `want` selects from one file: .idx, then one Range per run of adjacent messages.
  async function read(url, winds, heights) {
    const ranges = D.idxRanges(await idxOf(url), idxWanted(winds, heights));
    if (!ranges.length) throw new Error('inventory lists none of the fields');
    const parts = [];
    for (const r of ranges) parts.push(await s3Get(url, r, st));
    const f = fieldsOf(WX.decodeGrib2(Buffer.concat(parts)));
    const missing = expectedKeys(winds, heights).filter(k => !f[k]);
    if (missing.length) throw new Error('fields missing: ' + missing.join(', '));
    return f;
  }

  // Cycle: the last member's .idx at the longest lead must exist.
  const gfsCycle = backfill ? D.cycleOf(Date.parse(U.addDays(to, 1) + 'T00:00:00Z')) : D.latestCycle(nowMs, GFS_LAG_H);
  let cycle = null, plan = null;
  const tried = [];
  for (const c of cycleCandidates(nowMs, LAG_H, backfill ? to : null)) {
    const p = dayPlan(gfsCycle, to, c);
    if (!p.length || p.some(d => d.lead < 0 || d.lead > 240 || d.lead % 3)) { tried.push(D.cycleLabel(c) + ' (leads out of range)'); continue; }
    try { await idxOf(gefsFile(BUCKET, c, MEMBERS[MEMBERS.length - 1], p[p.length - 1].lead)); cycle = c; plan = p; break; }
    catch (e) { tried.push(D.cycleLabel(c) + ' (' + e.message + ')'); if (e.stopped) break; }
  }
  if (!cycle) throw new Error('no complete GEFS cycle on the bucket: ' + tried.join('; '));
  if (tried.length) notes.push('GEFS run ' + D.cycleLabel(cycle) + ' used; newer ones not complete on the bucket yet: ' + tried.join('; ') + '.');

  // Heights per day: ensemble mean (geavg), the control's own as the stand-in.
  const heightsCache = new Map(), check = [];
  const heightsOf = p => {
    if (!heightsCache.has(p.date)) heightsCache.set(p.date, (async () => {
      try { return { from: MEAN, f: await read(gefsFile(BUCKET, cycle, MEAN, p.lead), false, true) }; }
      catch (e) {
        if (e.stopped) throw e;
        notes.push(fmtDay(p.date) + ': ensemble-mean heights not read (' + e.message + '); the control member\'s heights stand in.');
        return { from: MEMBERS[0], f: await read(gefsFile(BUCKET, cycle, MEMBERS[0], p.lead), false, true) };
      }
    })());
    return heightsCache.get(p.date);
  };

  const tallies = {}, failed = [];
  plan.forEach(p => { tallies[p.date] = newTally(); });
  const jobs = [];
  plan.forEach(p => MEMBERS.forEach(m => jobs.push({ p, m })));
  await WX.pool(jobs, PARALLEL, async ({ p, m }) => {
    if (st.stopped) return;
    if (late()) { failed.push(m + ' ' + p.date + ' (time budget)'); return; }
    try {
      // The control reads its own heights too, for the check; with --member-heights every member does.
      const own = memberHeights || m === MEMBERS[0];
      const f = await read(gefsFile(BUCKET, cycle, m, p.lead), true, own);
      const H = memberHeights ? null : await heightsOf(p);
      const flags = memberFlags(f, H ? H.f : null);
      if (!flags) throw new Error('layer fields missing');
      addMember(tallies[p.date], m, flags);
      if (m === MEMBERS[0] && H && H.from === MEAN) check.push(Object.assign({ date: p.date }, agreement(memberFlags(f, null), flags)));
    } catch (e) { if (!e.stopped) failed.push(m + ' ' + p.date + ' (' + String(e.message || e).slice(0, 60) + ')'); }
  });
  if (st.stopped) notes.push(HOST + ' answered HTTP ' + st.stopped.status + ' (' + st.stopped.path + ') — no further request this run; days with fewer than ' + MIN_MEMBERS + ' members are left out.');

  // ---- assemble -----------------------------------------------------------------------------------
  const areas = {}, days = [], missingDays = [];
  AREA_IDS.forEach(a => { const A = AREAS[a]; areas[a] = Object.assign({ name: A.name, box: { s: A.s, n: A.n, w: A.w, e: A.e } }, OG[a], { days: [] }); });
  plan.forEach(p => {
    const T = tallies[p.date], n = T.members.length;
    if (n < MIN_MEMBERS) { missingDays.push(p.date); return; }
    const meta = { day: p.day, date: p.date, valid: p.valid, run: D.cycleLabel(cycle), lead: p.lead, members: n, lowConfidence: p.day >= 4 };
    days.push(Object.assign({}, meta, n < MEMBERS.length ? { membersMissing: MEMBERS.filter(m => !T.members.includes(m)) } : {}));
    AREA_IDS.forEach(a => {
      const bands = {}; let max = 0;
      BANDS.forEach(b => { const pr = probOf(T[a][b]); pr.forEach(v => { if (v !== MISSING && v > max) max = v; }); bands[b] = { prob: probB64(pr) }; });
      areas[a].days.push(Object.assign({}, meta, { bands, max }));
    });
  });
  if (!days.length) throw new Error('no day with at least ' + MIN_MEMBERS + ' GEFS members read' + (failed.length ? ': ' + failed.slice(0, 3).join('; ') : ''));
  if (failed.length) notes.push('GEFS member files not read: ' + failed.length + ' (' + failed.slice(0, 6).join(', ') + (failed.length > 6 ? ', …' : '') + '). Each day\'s percentages are of the members read (`members`).');
  if (missingDays.length) notes.push('No ensemble CAT probability for ' + missingDays.join(', ') + ' (fewer than ' + MIN_MEMBERS + ' members read): a gap in the data, not calm air.');
  notes.push('Days 4–7 are low confidence; the FL300 and FL390 bands use one 50-hPa layer each (the GEFS 0.5° file has no 350 / 150 hPa), so they can read lower than the deterministic layer would.');

  const mb = Math.round(st.bytes / 1048576 * 10) / 10;
  const out = {
    source: SOURCE, label: LABEL, disclaimer: DISCLAIMER, attribution: ATTRIBUTION, licence: LICENCE, pages: PAGES,
    model: 'GEFS v12 0.5° (pgrb2ap5)', members: MEMBERS.length, memberIds: 'gec00 (control), gep01–gep30',
    run: D.cycleLabel(cycle), runChoice: backfill ? 'backfill: 00Z cycle after the window' : 'latest 00Z at least ' + LAG_H + ' h old; else the 18Z before it; else the 00Z a day earlier',
    res: 2, areaOrder: AREA_IDS, encoding: 'base64-uint8',
    layout: 'per area: grid points lat0 + j*res, lon0 + i*res, row-major south→north, west→east (the points of the model SIGWX and jet grids); byte = % of members (0–100), 255 = missing; each point summarises the GEFS 0.5° points within ±1° (25 points)',
    bands: BAND_NOTE,
    cat: { index: 'Ellrod & Knapp TI1 = vertical wind shear × total deformation, per 50-hPa layer (300–250, 250–200 hPa), smoothed once (1-2-1)', units: '1e-7 s^-2',
           threshold: THRESHOLD, thresholdFrom: 'fetch-sigwx-model.js class 1 "CAT potential" (fixed calibration)',
           member: 'a member flags a cell when at least ' + MIN_PTS + ' of its 25 0.5° points reach the threshold (the deterministic cell rule)',
           value: 'percent of the members read that flag the cell', heights: memberHeights ? 'each member\'s own geopotential heights' : 'ensemble-mean (geavg) geopotential heights for the layer depth; each member\'s own winds',
           wording: '"x % of members"; never a moderate/severe grade', leadsH: plan.map(p => p.lead) },
    days, areas, missing: missingDays,
    check: { what: 'control member: CAT flags with its own heights vs the ensemble-mean heights all members use (cells × bands × areas)', days: check },
    requests: { [HOST]: st.requests }, httpStatus: st.status, megabytes: mb, notes,
  };
  out.seconds = Math.round((Date.now() - t0) / 1000);
  out.snapshotBytes = Buffer.byteLength(JSON.stringify(out));
  const agree = check.length ? r1(check.reduce((s, c) => s + c.agreePct, 0) / check.length) : null;
  out.summary = ['run ' + out.run + ' · ' + days.length + ' days (' + (days[0] ? days[0].date : '?') + ' .. ' + (days.length ? days[days.length - 1].date : '?') + ', +' + plan[0].lead + '..+' + plan[plan.length - 1].lead + ' h) × 3 frames × 3 bands · members ' +
                 days.map(d => d.members).join('/') + (failed.length ? ' · ' + failed.length + ' member files failed' : '') + ' · requests ' + st.requests + ' · ' + mb + ' MB · ' + out.seconds + ' s · snapshot ' +
                 Math.round(out.snapshotBytes / 1024) + ' KB compact' + (agree != null ? ' · control own vs mean heights: ' + agree + ' % of cells agree' : '')];
  return out;
}

// ---- digest -------------------------------------------------------------------------------------
// Per frame: the highest share and where/when/at which FL, and where the members agree most (the 10° ×
// 10° window with the most cells at >= 50 %, over all days and bands).
const AGREE_PCT = 50;
function areaLine(A, days) {
  if (!days.length) return 'no ensemble data';
  const n = A.nlat * A.nlon, counts = new Float64Array(n), perDay = {};
  let top = null;
  days.forEach(d => BANDS.forEach(b => {
    probB64Decode(d.bands[b].prob).forEach((v, k) => {
      if (v === MISSING) return;
      if (!top || v > top.v) top = { v, k, b, d };
      if (v >= AGREE_PCT) { counts[k]++; perDay[d.date] = (perDay[d.date] || 0) + 1; }
    });
  }));
  if (!top || top.v === 0) return 'no member flags CAT potential';
  const lat = A.lat0 + Math.floor(top.k / A.nlon) * A.res, lon = A.lon0 + (top.k % A.nlon) * A.res;
  const parts = ['highest ' + top.v + ' % of members near ' + D.fmtPos(lat, lon) + ' at ' + D.BAND_FL[top.b] + ' (' + wd(top.d.date) + ')'];
  const w = D.hotWindow(counts, A, 5);
  if (w.sum > 0) {
    const s = A.lat0 + w.j * A.res, e0 = A.lon0 + w.i * A.res;
    const busiest = Object.keys(perDay).sort((x, y) => perDay[y] - perDay[x] || x.localeCompare(y)).slice(0, 2).sort();
    parts.push('at least half the members agree mostly over ' + D.fmtBox(s, s + 4 * A.res, e0, e0 + 4 * A.res) + ' (most cells ' + busiest.map(wd).join(', ') + ')');
  } else parts.push('nowhere do half the members agree');
  return parts.join('; ');
}
function digest(s) {
  const L = [], days = s.days || [];
  if (!days.length) return '';
  L.push('ENSEMBLE CAT PROBABILITY, DAYS ' + days[0].day + '–' + days[days.length - 1].day + ' (' + s.label + '; computed by the LSY WX Relay from NOAA GEFS 0.5°, ' + s.members + ' members, run ' + s.run + ', ' +
         fmtDay(days[0].date) + ' – ' + fmtDay(days[days.length - 1].date) + ' 12Z): the share of members whose Ellrod index shows CAT POTENTIAL (TI1 ≥ ' + s.cat.threshold + ' × 1e-7 s⁻²) at FL300/340/390. ' +
         'Write it as "x % of members"; it is the probability of a model index, not a turbulence grade or forecast; days 4–7 low confidence; no convective or mountain-wave turbulence.');
  (s.areaOrder || Object.keys(s.areas || {})).forEach(a => L.push('  ' + s.areas[a].name + ': ' + areaLine(s.areas[a], s.areas[a].days || []) + '.'));
  if ((s.missing || []).length) L.push('GAPS: no ensemble CAT probability for ' + s.missing.join(', ') + ' — a gap in the data, not calm air.');
  L.push('CITE: ' + s.attribution + ' Model-derived; not an official WAFS SIGWX.');
  return L.join('\n');
}

// U.main writes pretty-printed; rewritten compactly like the other weather snapshots.
function rewriteCompact(week) {
  const p = path.join(U.ROOT, 'data', DIR, 'week-' + week + '.json');
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8')), tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, p);
    console.log(NAME + ': written compactly, ' + Math.round(fs.statSync(p).size / 1024) + ' KB');
  } catch (e) { /* nothing written by this run, or unreadable: leave it */ }
}

module.exports = { LABEL, ATTRIBUTION, DISCLAIMER, BUCKET, HOST, MEMBERS, LEVELS, BAND_LAYERS, THRESHOLD, MISSING, MIN_MEMBERS, OG,
                   cycleCandidates, dayPlan, gefsFile, idxWanted, expectedKeys, fieldsOf, memberFlags, newTally, addMember, probOf, probB64, probB64Decode,
                   agreement, isStop, areaLine, digest, fetchGefsCat };
if (require.main === module) {
  const c = U.cli(process.argv);
  U.main(NAME, DIR, fetchGefsCat, digest).then(() => { if (!c.has('--print-digest') && c.week) rewriteCompact(c.week); });
}
