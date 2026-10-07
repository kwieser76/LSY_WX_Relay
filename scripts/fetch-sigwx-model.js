#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-sigwx-model.js
// A model-derived "SIGWX-style" picture for the three map frames (North America, North Atlantic &
// Europe, Middle East), computed by us from NOAA GFS: jet cores, tropopause, clear-air turbulence
// (CAT) potential at FL300 / FL340 / FL390, and CB areas with tops. It fills the days the official
// WAFS SIGWX does not reach (fetch-sigwx.js: 48 h ahead at most) and is the alternative view.
// Every snapshot and digest line says "MODEL-DERIVED · NOT AN OFFICIAL SIGWX"; CAT is a "potential",
// never a moderate/severe grade (PO decision 2026-10-06, BUILD-R4 §5).
//
// Days, all at 12Z:
//   past week   the GFS analysis (f000 of the 12Z cycle) of each day of the reporting window; the CB of
//               the day from the 6-h forecast of the 06Z cycle (convective rain averaged 06–12Z).
//   week ahead  7 days from the latest complete GFS cycle at run time (the first 12Z after it, never a
//               day of the reporting window). Jets and tropopause on all 7 days; CAT and CB only up to
//               +72 h, the lead time beyond which a model hazard area looks precise but is not.
//               --backfill uses the 00Z cycle of the day after the window instead, read from the archive.
//
// Elements (pure functions in sigwx-diag.js; method and literature in the round-4 sigwx-model report):
//   jets        axes through the speed maxima of the GFS max-wind level, >= 80 kt; per piece inside a
//               frame: speed and FL at the maximum, ICAO depth (FL of the 80-kt wind below and above the
//               core, from u/v at 500–100 hPa) for cores >= 120 kt; path simplified, 0.1°.
//   trop        GFS ICAHT at the tropopause (pressure altitude) as FL, median of each 2° cell.
//   CAT         Ellrod & Knapp TI1 = vertical wind shear x deformation per 50-hPa layer (350–150 hPa,
//               shear from GFS heights), smoothed once; band 300 / 250 / 200 hPa = the higher of the two
//               layers meeting at that level. Two classes. Default thresholds 8 and 12 x 1e-7 s^-2
//               ("fixed"); the option "percentile" (config.json sigwxModel.catCalibration or
//               --cat-calibration percentile) uses the top 5 % / 2 % of each band and frame over the
//               snapshot's days instead — documented for later, when a GFS climatology replaces the
//               literature thresholds (which disagree by a factor of six, see the report).
//   CB          NCEP's WAFS CB recipe (UPP CLDRAD.f): cover from the convective precipitation rate
//               (Slingo-type table, capped at 0.8), only where the convective cloud top is above
//               400 hPa and the cloud deeper than 300 hPa; top FL from the cloud-top pressure.
// Output: one 2° grid per frame (same points as the jet/levels grids), each 2° cell summarising the 25
// GFS 0.5° points within ±1°: CAT class c when at least 5 of them (a fifth of the cell) reach class c;
// CB extent likewise (the 5th-highest cover, tenths); tropopause the median; CB top the highest.
//
// Sources, anonymous, no key, NOAA/NWS public domain (https://www.weather.gov/disclaimer — derived
// data must not be presented as official or NOAA-endorsed; the snapshot says so):
//   NOMADS grib filter 0.5°  https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p50.pl — one request per
//               file for one subregion covering all three frames (1–77N 172W–84E), simple packing;
//               used for cycles up to 8 days old, paced at 1.1 s (NOMADS: 120 hits/min).
//   AWS open data  https://noaa-gfs-bdp-pds.s3.amazonaws.com (the same GFS files, kept for years): the
//               .idx inventory, then HTTP Range for exactly the needed messages (complex packing,
//               grib-complex.js). Used for older cycles and whenever NOMADS fails. 403/429 from either
//               host stops asking it for the rest of the run.
// Decoding reuses fetch-wxoutlook.js decodeGrib2 (simple / complex packing), read-only.
//
// Measured on W40 (2026-10-06): see the summary line and the build report; budget <= 3 min, <= 300 KB.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const U = require('./fetch-util.js');
const WX = require('./fetch-wxoutlook.js');      // decodeGrib2, getBuffer, getRange (shared, read-only)
const D = require('./sigwx-diag.js');

const NAME = 'fetch-sigwx-model', DIR = 'sigwx-model';
const LABEL = 'MODEL-DERIVED · NOT AN OFFICIAL SIGWX';
const SOURCE = 'NOAA GFS 0.5° (NCEP): analyses (past week) and forecasts (week ahead)';
const ATTRIBUTION = 'Derived by the LSY WX Relay from NOAA GFS data (NOAA/NCEP, public domain). Not a NOAA/NWS product; not endorsed by NOAA.';
const DISCLAIMER = 'Model-derived significant-weather picture computed by the LSY WX Relay from NOAA GFS data. Not an official WAFS SIGWX chart, not issued or checked by a WAFC or any meteorological authority; not for flight planning or operational use. ' +
  'CAT potential is the Ellrod TI1 index, which in comparable studies catches about 55–60 % of turbulence reports while also flagging 15–30 % of smooth air (AUC about 0.70–0.77); it misses convective and mountain-wave turbulence and is not a turbulence grade. ' +
  'CB areas follow the NCEP WAFS CB recipe from GFS convective rain; jets come from the GFS max-wind level. Symbols after ICAO Annex 3 / WMO-No. 49 Vol. II.';
const PAGES = { gfs: 'https://www.nco.ncep.noaa.gov/pmb/products/gfs/', nomads: 'https://nomads.ncep.noaa.gov/', aws: 'https://registry.opendata.aws/noaa-gfs-bdp-pds/', disclaimer: 'https://www.weather.gov/disclaimer' };

const NOMADS = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p50.pl';
const BUCKET = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
const HOST = { nomads: 'nomads.ncep.noaa.gov', aws: 'noaa-gfs-bdp-pds.s3.amazonaws.com' };

// Frames, west to east (boxes of the basemap frames, BUILD-R4). The 0.5° work grid is their union plus a
// 2° margin, so derivatives and the ±1° blocks at the frame edges have data.
const AREAS = {
  na: { name: 'North America', s: 13, n: 72, w: -170, e: -50 },
  atl: { name: 'North Atlantic & Europe', s: 25, n: 75, w: -80, e: 40 },
  me: { name: 'Middle East', s: 3, n: 47, w: 14, e: 82 },
};
const AREA_IDS = ['na', 'atl', 'me'];
const WORK = { s: 1, n: 77, w: -172, e: 84 };
const RES = 2, HALF = 1, MIN_PTS = 5, GFS_RES = 0.5;
const PROFILE = [500, 400, 350, 300, 250, 200, 150, 100];      // hPa: jet depth (FL180–FL530)
const CAT_LEVELS = [350, 300, 250, 200, 150];                   // hPa: the four 50-hPa layers
const BANDS = ['300', '250', '200'];
const CAT_FIXED = [8, 12];                                      // 1e-7 s^-2
const CAT_PCT = [0.95, 0.98];                                   // percentile option: top 5 % / 2 %
const HAZARD_MAX_H = 72;
const JET_MIN_KT = 80, JET_DEPTH_KT = 120, JET_MIN_KM = 900, JET_PIECE_KM = 400, JET_MAX = 8, JET_TOL = 0.3;
const NOMADS_MAX_AGE_H = 8 * 24, NOMADS_GAP_MS = 1100, AWS_PARALLEL = 4, LAG_H = 5;
const SOFT_DEADLINE_S = 150, TIMEOUT_MS = 45000;

const r1 = x => Math.round(x * 10) / 10;
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const fmtDay = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };
const blockedErr = e => /HTTP (403|429)/.exec(String((e && e.message) || e));

// ---- what each file must deliver ----------------------------------------------------------------
// need: { prof: jets + tropopause (u/v profile, max wind, ICAHT), cat: + HGT 350–150 hPa, cb: CB fields }
function nomadsSelection(need) {
  const vars = [], levs = [];
  if (need.prof) { vars.push('UGRD', 'VGRD', 'ICAHT'); levs.push(...PROFILE.map(p => p + '_mb'), 'max_wind', 'tropopause'); }
  if (need.cat) { vars.push('HGT'); CAT_LEVELS.forEach(p => { if (!levs.includes(p + '_mb')) levs.push(p + '_mb'); }); }
  if (need.cb) { vars.push('CPRAT', 'PRES'); levs.push('surface', 'convective_cloud_top_level', 'convective_cloud_bottom_level'); }
  return { vars, levs };
}
function idxWanted(need) {
  const mb = l => { const m = /^(\d+) mb$/.exec(l); return m ? +m[1] : null; };
  return r => {
    if (need.prof) {
      if ((r.v === 'UGRD' || r.v === 'VGRD') && (PROFILE.includes(mb(r.lev)) || r.lev === 'max wind')) return true;
      if (r.v === 'ICAHT' && (r.lev === 'max wind' || r.lev === 'tropopause')) return true;
    }
    if (need.cat && r.v === 'HGT' && CAT_LEVELS.includes(mb(r.lev))) return true;
    if (need.cb) {
      if (r.v === 'CPRAT' && r.lev === 'surface' && /ave/.test(r.desc)) return true;
      if (r.v === 'PRES' && /^convective cloud (top|bottom) level$/.test(r.lev)) return true;
    }
    return false;
  };
}
function expectedKeys(need) {
  const k = [];
  if (need.prof) { PROFILE.forEach(p => k.push('UGRD:' + p, 'VGRD:' + p)); k.push('UGRD:maxw', 'VGRD:maxw', 'ICAHT:maxw', 'ICAHT:trop'); }
  if (need.cat) CAT_LEVELS.forEach(p => k.push('HGT:' + p));
  if (need.cb) k.push('CPRAT:avg', 'PRES:convtop', 'PRES:convbot');
  return k;
}
// Decoded messages -> work-grid fields { key: grid }, the first message of each key.
function fieldsOf(msgs) {
  const f = {};
  for (const m of msgs) { const k = D.keyOf(m); if (k && !f[k]) f[k] = D.crop(m, WORK, GFS_RES); }
  return f;
}

// ---- products of one file -----------------------------------------------------------------------
const OG = Object.fromEntries(AREA_IDS.map(a => [a, D.outGrid(AREAS[a], RES)]));

// Jets on the work grid, then cut per frame: [{ fl, kt, depth, at, path }] strongest first.
function jetsOf(f) {
  const uM = f['UGRD:maxw'], vM = f['VGRD:maxw'], hM = f['ICAHT:maxw'];
  if (!uM || !vM || !hM) return null;
  const g = uM, n = g.v.length, spd = new Float64Array(n);
  for (let k = 0; k < n; k++) spd[k] = Math.hypot(uM.v[k], vM.v[k]) * D.KT;
  const axes = D.jetAxes(uM.v, vM.v, D.smooth(spd, g.nlat, g.nlon, 1), g, { minKt: JET_MIN_KT, minKm: JET_MIN_KM });
  const out = {};
  AREA_IDS.forEach(a => {
    const list = [];
    axes.forEach(ax => {
      const full = ax.map(p => [p.lat, p.lon, D.sample(spd, g, p.lat, p.lon)]);
      D.clipPath(full, AREAS[a]).forEach(piece => {
        if (piece.length < 2 || D.pathKm(piece) < JET_PIECE_KM) return;
        const top = piece.reduce((m, p) => (p[2] > m[2] ? p : m), piece[0]);
        const kt = Math.round(top[2]);
        if (!(kt >= JET_MIN_KT)) return;
        const fl = Math.round(D.sample(hM.v, g, top[0], top[1]) * D.FT / 100 / 10) * 10;
        let depth = null;
        if (kt >= JET_DEPTH_KT) {
          const prof = PROFILE.map(p => ({ fl: D.flOf(p), kt: Math.hypot(D.sample(f['UGRD:' + p].v, g, top[0], top[1]), D.sample(f['VGRD:' + p].v, g, top[0], top[1])) * D.KT }));
          const dp = D.jetDepth(prof, fl, JET_MIN_KT);
          depth = [dp.below == null ? null : Math.round(dp.below / 10) * 10, dp.above == null ? null : Math.round(dp.above / 10) * 10];
        }
        list.push({ fl: isFinite(fl) ? fl : null, kt, depth, at: [r1(top[0]), r1(top[1])],
                    path: D.simplifyPath(piece, JET_TOL).map(p => [r1(p[0]), r1(p[1]), Math.round(p[2])]) });
      });
    });
    out[a] = list.sort((x, y) => y.kt - x.kt).slice(0, JET_MAX);
  });
  return out;
}
// Tropopause FL per frame (median of each 2° cell), base64 FL/5.
function tropOf(f) {
  const t = f['ICAHT:trop']; if (!t) return null;
  const fl = Float64Array.from(t.v, m => m * D.FT / 100);
  return Object.fromEntries(AREA_IDS.map(a => [a, D.flB64(D.blockGrid(fl, t, OG[a], HALF, D.median))]));
}
// CAT: per frame and band the block statistic (5th-highest smoothed TI1 of the 25 points), classified
// later when the thresholds are known (fixed, or percentiles over all days).
function catOf(f) {
  const dc = {}, layers = {};
  for (let i = 0; i + 1 < CAT_LEVELS.length; i++) {
    const L = D.layerTI1(f, CAT_LEVELS[i], CAT_LEVELS[i + 1], dc);
    if (!L) return null;
    layers[CAT_LEVELS[i] + '-' + CAT_LEVELS[i + 1]] = D.smooth(L.ti1, L.nlat, L.nlon, 1);
  }
  const g = f['UGRD:250'], out = {};
  AREA_IDS.forEach(a => { out[a] = {}; });
  BANDS.forEach(b => {
    const [l1, l2] = D.BAND_LAYERS[b].map(([lo, hi]) => layers[lo + '-' + hi]);
    const band = D.maxOf(l1, l2);
    AREA_IDS.forEach(a => { out[a][b] = Float32Array.from(D.blockGrid(band, g, OG[a], HALF, list => D.kthHighest(list, MIN_PTS))); });
  });
  return out;
}
// CB per frame: extent = 5th-highest cover of the cell in tenths (RLE), top = highest CB top FL (b64).
function cbOf(f) {
  const rate = f['CPRAT:avg'], top = f['PRES:convtop'], bot = f['PRES:convbot'];
  if (!rate || !top || !bot) return null;
  const c = D.cbFields(rate.v, top.v, bot.v), out = {};
  AREA_IDS.forEach(a => {
    const ext = D.blockGrid(c.ext, rate, OG[a], HALF, list => Math.max(0, D.kthHighest(list, MIN_PTS)));
    const tenths = Array.from(ext, x => Math.round(x * 10));
    const tops = D.blockGrid(c.fl, rate, OG[a], HALF, list => (list.length ? Math.max(...list) : NaN));
    out[a] = { extent: D.rleEncode(tenths), topFL: D.flB64(Array.from(tops, (t, k) => (tenths[k] > 0 ? t : NaN))),
               maxTop: Math.max(0, ...Array.from(tops, (t, k) => (tenths[k] >= 5 && isFinite(t) ? t : 0))) };
  });
  return out;
}

// ---- fetching -----------------------------------------------------------------------------------
// aheadOnly (the public week-ahead relay, tools/wx-relay): no past-week analyses at all — only the
// week-ahead forecast files are requested, and areas.*.days hold kind 'forecast' only; `past` keeps its
// keys with from/to null. The ahead days are the 7 dates after `to` (pass the day before the first one
// wanted). Absent = unchanged.
async function fetchSigwxModel({ to, from, backfill, aheadOnly }) {
  const t0 = Date.now(), nowMs = Date.now(), notes = [];
  const cfg = (U.readConfig().sigwxModel) || {};
  const cliCal = U.cli(process.argv).argOf('--cat-calibration');
  const calibration = (cliCal || cfg.catCalibration) === 'percentile' ? 'percentile' : 'fixed';
  const forceAws = U.cli(process.argv).has('--archive-only');
  const hits = { [HOST.nomads]: 0, [HOST.aws]: 0 }, bytes = { [HOST.nomads]: 0, [HOST.aws]: 0 }, dead = {};
  const nomadsErrors = [];
  const late = () => (Date.now() - t0) / 1000 > SOFT_DEADLINE_S;

  // The plan: one job per GFS file.
  const jobs = [];
  (aheadOnly ? [] : daysOf(from, to)).forEach(d => {
    if (Date.parse(d + 'T12:00:00Z') + LAG_H * 36e5 > nowMs) { notes.push('Past week: ' + d + ' 12Z analysis not yet published at run time.'); return; }
    jobs.push({ id: 'ana ' + d, date: d, kind: 'analysis', cycle: D.cycleOf(Date.parse(d + 'T12:00:00Z')), fh: 0, need: { prof: true, cat: true } });
    jobs.push({ id: 'cb ' + d, date: d, kind: 'analysis', cycle: D.cycleOf(Date.parse(d + 'T06:00:00Z')), fh: 6, need: { cb: true } });
  });
  const run = backfill ? D.cycleOf(Date.parse(U.addDays(to, 1) + 'T00:00:00Z')) : D.latestCycle(nowMs, LAG_H);
  const ahead = D.aheadPlan(run, to, 7, HAZARD_MAX_H);
  ahead.forEach(p => {
    const cbInFile = p.hazards && p.lead >= 6;
    jobs.push({ id: 'fc ' + p.date, date: p.date, kind: 'forecast', cycle: run, fh: p.lead, need: { prof: true, cat: p.hazards, cb: cbInFile } });
    if (p.hazards && !cbInFile) jobs.push({ id: 'cb ' + p.date, date: p.date, kind: 'forecast', cycle: D.cycleOf(Date.parse(p.date + 'T06:00:00Z')), fh: 6, need: { cb: true } });
  });

  // NOMADS: one request at a time, >= 1.1 s from start to start.
  let nomadsChain = Promise.resolve(), nomadsLast = 0;
  const nomadsGet = url => {
    const p = nomadsChain.then(async () => {
      const wait = nomadsLast + NOMADS_GAP_MS - Date.now(); if (wait > 0) await U.sleep(wait);
      nomadsLast = Date.now();
      if (dead[HOST.nomads] || late()) throw new Error('skipped');
      hits[HOST.nomads]++;
      return WX.getBuffer(url, { timeoutMs: TIMEOUT_MS, retries: 0 });
    });
    nomadsChain = p.catch(() => {});
    return p;
  };
  const kill = (host, e, what) => { if (!dead[host]) { dead[host] = true; notes.push(host + ' answered ' + blockedErr(e)[0] + ' (' + what + ') — not asked again this run.'); } };

  async function viaNomads(job) {
    const sel = nomadsSelection(job.need);
    const url = D.nomadsUrl(NOMADS, job.cycle, job.fh, sel.vars, sel.levs, WORK);
    try {
      const b = await nomadsGet(url);
      bytes[HOST.nomads] += b.length;
      if (b.toString('latin1', 0, 4) !== 'GRIB') throw new Error('no GRIB in the answer');
      return b;
    } catch (e) {
      if (blockedErr(e)) kill(HOST.nomads, e, job.id);
      else if (!/^skipped$/.test(e.message)) nomadsErrors.push(job.id + ': ' + String(e.message || e).replace(/^https?:\/\/\S+: /, '').slice(0, 50));
      return null;
    }
  }
  async function viaAws(job) {
    if (dead[HOST.aws]) throw new Error('archive host stopped earlier in this run');
    const file = D.awsFile(BUCKET, job.cycle, job.fh);
    let idx;
    try { hits[HOST.aws]++; idx = await U.getText(file + '.idx', { retries: 0, timeoutMs: 20000 }); bytes[HOST.aws] += idx.length; }
    catch (e) { if (blockedErr(e)) kill(HOST.aws, e, job.id); throw e; }
    const ranges = D.idxRanges(D.parseIdx(idx), idxWanted(job.need));
    if (!ranges.length) throw new Error('inventory lists none of the fields');
    const parts = [];
    for (const r of ranges) {
      if (dead[HOST.aws]) throw new Error('archive host stopped');
      try { hits[HOST.aws]++; const b = await WX.getRange(file, r.offset, r.length, { timeoutMs: TIMEOUT_MS, retries: 1 }); bytes[HOST.aws] += b.length; parts.push(b); }
      catch (e) { if (blockedErr(e)) kill(HOST.aws, e, job.id); throw e; }
    }
    return Buffer.concat(parts);
  }

  const results = {}, failed = [], via = { nomads: [], aws: [] };
  async function runJob(job) {
    if (late()) { failed.push(job.id + ' (time budget)'); return; }
    const ageH = (nowMs - job.cycle.ms) / 36e5;
    let buf = null, source = 'nomads';
    if (!forceAws && !dead[HOST.nomads] && ageH <= NOMADS_MAX_AGE_H) buf = await viaNomads(job);
    if (!buf) {
      source = 'aws';
      try { buf = await viaAws(job); }
      catch (e) { failed.push(job.id + ' (' + String(e.message || e).replace(/^https?:\/\/\S+:? /, '').slice(0, 80) + ')'); return; }
    }
    let f;
    try { f = fieldsOf(WX.decodeGrib2(buf)); }
    catch (e) { failed.push(job.id + ' (decode: ' + String(e.message || e).slice(0, 60) + ')'); return; }
    const missing = expectedKeys(job.need).filter(k => !f[k]);
    if (missing.length) { failed.push(job.id + ' (fields missing: ' + missing.slice(0, 4).join(', ') + ')'); return; }
    via[source].push(job.id);
    const r = { job, source };
    if (job.need.prof) { r.jets = jetsOf(f); r.trop = tropOf(f); }
    if (job.need.cat) r.cat = catOf(f);
    if (job.need.cb) r.cb = cbOf(f);
    results[job.id] = r;
  }
  // AWS-bound and NOMADS-bound jobs run side by side; at most AWS_PARALLEL jobs in flight.
  await WX.pool(jobs, AWS_PARALLEL, runJob);

  // ---- assemble -----------------------------------------------------------------------------------
  const catDays = Object.values(results).filter(r => r.cat);
  const thresholds = {};
  AREA_IDS.forEach(a => {
    thresholds[a] = {};
    BANDS.forEach(b => {
      if (calibration === 'fixed') { thresholds[a][b] = CAT_FIXED.slice(); return; }
      const pool = []; catDays.forEach(r => pool.push(...r.cat[a][b]));
      const t = CAT_PCT.map(q => r1(D.percentile(pool, q)));
      thresholds[a][b] = t.every(isFinite) ? t : CAT_FIXED.slice();
    });
  });
  const classesOf = (stat, thr) => D.rleEncode(Array.from(stat, v => (v >= thr[1] ? 2 : v >= thr[0] ? 1 : 0)));

  const dayPlan = [];
  (aheadOnly ? [] : daysOf(from, to)).forEach(d => dayPlan.push({ date: d, kind: 'analysis', prof: 'ana ' + d, cb: 'cb ' + d }));
  ahead.forEach(p => dayPlan.push({ date: p.date, kind: 'forecast', prof: 'fc ' + p.date, cb: p.hazards ? (p.lead >= 6 ? 'fc ' + p.date : 'cb ' + p.date) : null, plan: p }));
  const areas = {}, missingDays = [];
  AREA_IDS.forEach(a => { const A = AREAS[a]; areas[a] = Object.assign({ name: A.name, box: { s: A.s, n: A.n, w: A.w, e: A.e } }, OG[a], { days: [] }); });
  dayPlan.forEach(dp => {
    const P = results[dp.prof], C = dp.cb && results[dp.cb];
    if (!P) { missingDays.push(dp.date); return; }
    const j = P.job, valid = dp.date + 'T12:00Z';
    AREA_IDS.forEach(a => {
      const day = { date: dp.date, valid, run: D.cycleLabel(j.cycle), lead: j.fh, kind: dp.kind };
      if (P.cat) day.bands = Object.fromEntries(BANDS.map(b => [b, { cat: classesOf(P.cat[a][b], thresholds[a][b]) }]));
      day.jets = (P.jets && P.jets[a]) || [];
      if (P.trop) day.trop = P.trop[a];
      if (C && C.cb) day.cb = { extent: C.cb[a].extent, topFL: C.cb[a].topFL, run: D.cycleLabel(C.job.cycle), lead: C.job.fh };
      areas[a].days.push(day);
    });
  });
  if (!Object.keys(results).some(k => results[k].job.need.prof)) throw new Error('no GFS file read: ' + failed.slice(0, 3).join('; '));
  if (failed.length) notes.push('GFS files not read: ' + failed.join(', ') + '. A missing day is a gap in the data, not calm weather.');
  if (missingDays.length) notes.push('No model SIGWX for ' + missingDays.join(', ') + ' (GFS file not read).');
  if (via.aws.length && !forceAws) notes.push('Read from the NOAA GFS archive on AWS (NOMADS ' + (dead[HOST.nomads] ? 'stopped' : 'no longer had them or failed') + '): ' + via.aws.join(', ') + '.' + (nomadsErrors.length ? ' NOMADS: ' + nomadsErrors.join('; ') + '.' : ''));
  notes.push('CAT, CB: up to +' + HAZARD_MAX_H + ' h only; beyond that the week-ahead days carry jets and tropopause only.');
  const cbDays = dayPlan.filter(dp => dp.cb && results[dp.cb] && results[dp.cb].cb).length;

  const mb = Math.round((bytes[HOST.nomads] + bytes[HOST.aws]) / 1048576 * 10) / 10;
  const out = {
    source: SOURCE, label: LABEL, disclaimer: DISCLAIMER, attribution: ATTRIBUTION, pages: PAGES,
    model: 'GFS 0.5°', res: RES, areaOrder: AREA_IDS,
    layout: 'per frame: grid points lat0 + j*res, lon0 + i*res, row-major south→north, west→east; each point summarises the GFS 0.5° points within ±1° (25 points)',
    encoding: { cat: 'rle "v*n,v" of classes 0/1/2', trop: 'base64, one byte per point, FL = v*5, 0 = missing', cbExtent: 'rle of CB cover in tenths 0–8 (the 5th-highest of the 25 points)', cbTopFL: 'base64 FL/5 of the highest CB top in the cell, 0 = none', jets: 'path [[lat, lon, kt], …] in flow order (arrow at the end), 0.1°' },
    bands: { '300': { fl: 'FL300', layers: '350–300 and 300–250 hPa (≈ FL265–340)' }, '250': { fl: 'FL340', layers: '300–250 and 250–200 hPa (≈ FL300–390)' }, '200': { fl: 'FL390', layers: '250–200 and 200–150 hPa (≈ FL340–445)' } },
    cat: { index: 'Ellrod & Knapp TI1 = vertical wind shear × total deformation, per 50-hPa layer, smoothed once (1-2-1); band = the higher of its two layers', units: '1e-7 s^-2',
           calibration, thresholds, classes: { 1: 'CAT potential', 2: 'higher CAT potential' }, cell: 'class c when at least 5 of the 25 0.5° points reach its threshold',
           option: 'calibration "percentile" (config.json sigwxModel.catCalibration or --cat-calibration percentile): class thresholds = 95th / 98th percentile of the cell values of each band and frame over all days with CAT in this snapshot, i.e. the top 5 % / 2 %',
           leadMaxH: HAZARD_MAX_H, wording: 'potential, never a moderate/severe grade' },
    cb: { method: 'NCEP UPP CLDRAD.f WAFS CB: cover = f(ln convective precipitation rate), capped at 0.8; kept where the convective cloud top is above 400 hPa and the cloud deeper than 300 hPa; top FL = pressure altitude of the cloud top',
          time: 'past days: 6-h forecast of the 06Z cycle (rain averaged 06–12Z); ahead: the 12Z step (rain averaged over the 6 h before)', draw: 'extent ≥ 5 ≈ OCNL (WAFC guidance: cover 0.5)', leadMaxH: HAZARD_MAX_H },
    jets: { method: 'axes through the speed maxima of the GFS max-wind level, ≥ ' + JET_MIN_KT + ' kt, ≥ ' + JET_MIN_KM + ' km; FL and kt at the maximum of each piece inside the frame; strongest ' + JET_MAX + ' per frame and day',
            depth: '[base, top] FL of the ' + JET_MIN_KT + '-kt wind below and above the core (ICAO), only for cores ≥ ' + JET_DEPTH_KT + ' kt, from u/v at 500–100 hPa; null = beyond FL180 / FL530 or no depth shown', limitation: 'one max-wind level per GFS column: a polar and a subtropical jet above the same point merge' },
    trop: { method: 'GFS ICAHT at the tropopause (pressure altitude) as FL, median of the cell' },
    past: aheadOnly ? { from: null, to: null, hour: '12Z', kind: 'not fetched (ahead-only)' } : { from, to, hour: '12Z', kind: 'GFS analyses (f000)' },
    ahead: { run: D.cycleLabel(run), from: ahead[0] && ahead[0].date, to: ahead.length ? ahead[ahead.length - 1].date : null, hazardsTo: (ahead.filter(p => p.hazards).pop() || {}).date || null, mode: backfill ? 'backfill: 00Z cycle after the window, from the archive' : 'latest complete cycle at run time' },
    areas,
    missing: missingDays,
    requests: hits, megabytes: mb, sources: { nomads: via.nomads.length, aws: via.aws.length },
    notes,
  };
  if (aheadOnly) out.aheadOnly = true;
  out.seconds = Math.round((Date.now() - t0) / 1000);
  out.snapshotBytes = Buffer.byteLength(JSON.stringify(out));
  const nDays = areas.atl.days.length;
  out.summary = [from + ' .. ' + to + ' + ahead ' + (out.ahead.from || '?') + ' .. ' + (out.ahead.to || '?') + ' (run ' + out.ahead.run + ') · ' + nDays + ' days × 3 frames, CAT on ' + catDays.length + ', CB on ' + cbDays +
                 ' · files: ' + via.nomads.length + ' NOMADS, ' + via.aws.length + ' AWS archive' + (failed.length ? ', ' + failed.length + ' failed' : '') +
                 ' · requests NOMADS ' + hits[HOST.nomads] + ', AWS ' + hits[HOST.aws] + ' · ' + mb + ' MB · ' + out.seconds + ' s · snapshot ' + Math.round(out.snapshotBytes / 1024) + ' KB compact · CAT ' + calibration];
  return out;
}

// ---- digest -------------------------------------------------------------------------------------
// One line per frame for the past week and one for the week ahead: strongest jet, where CAT potential
// concentrated (the 10° x 10° window with the most flagged cells over all bands and days). CB stays on
// the map: in the Middle East frame its strongest cells are the African ITCZ, not news for a briefing.
function areaLine(A, days) {
  if (!days.length) return 'no model data';
  const og = A, parts = [];
  let best = null;
  days.forEach(d => (d.jets || []).forEach(j => { if (!best || j.kt > best.j.kt) best = { j, d }; }));
  parts.push(best ? 'strongest jet ' + best.j.kt + ' kt' + (best.j.fl ? ' FL' + best.j.fl : '') + ' near ' + D.fmtPos(best.j.at[0], best.j.at[1]) + ' (' + wd(best.d.date) + ')' : 'no jet ≥ 80 kt');
  const catDays = days.filter(d => d.bands);
  if (catDays.length) {
    const n = og.nlat * og.nlon, counts = new Float64Array(n), byBand = {}, byDay = {};
    catDays.forEach(d => BANDS.forEach(b => { const c = D.rleDecode(d.bands[b].cat); c.forEach((v, k) => { if (v) counts[k] += v; }); }));
    const w = D.hotWindow(counts, og, 5);
    if (w.sum > 0) {
      const inWin = k => { const j = Math.floor(k / og.nlon), i = k % og.nlon; return j >= w.j && j < w.j + 5 && i >= w.i && i < w.i + 5; };
      catDays.forEach(d => BANDS.forEach(b => { const c = D.rleDecode(d.bands[b].cat); let s = 0; c.forEach((v, k) => { if (v && inWin(k)) s += v; }); byBand[b] = (byBand[b] || 0) + s; byDay[d.date] = (byDay[d.date] || 0) + s; }));
      const band = Object.keys(byBand).sort((x, y) => byBand[y] - byBand[x])[0];
      const topDays = Object.keys(byDay).filter(d => byDay[d] > 0).sort((x, y) => byDay[y] - byDay[x] || x.localeCompare(y)).slice(0, 2).sort();
      const s = og.lat0 + w.j * og.res, e0 = og.lon0 + w.i * og.res;
      parts.push('CAT potential mostly ' + D.fmtBox(s, s + 4 * og.res, e0, e0 + 4 * og.res) + ' at ' + D.BAND_FL[band] + ' (' + topDays.map(wd).join(', ') + ')');
    } else parts.push('no CAT potential cells');
  }
  return parts.join('; ');
}
function digest(s) {
  const L = [];
  L.push('SIGWX (' + s.label + '; computed by the LSY WX Relay from NOAA GFS 0.5°, not a NOAA/NWS product, not for operational use): jet cores ≥ 80 kt, tropopause, clear-air turbulence (CAT) POTENTIAL (Ellrod TI1, ' +
         (s.cat && s.cat.calibration === 'percentile' ? 'top 5 % / 2 % of each frame' : 'fixed 8/12 × 1e-7 s⁻²') + ') at FL300/340/390, CB areas with tops. "Potential" is not a turbulence grade; no convective or mountain-wave turbulence.');
  const order = s.areaOrder || Object.keys(s.areas || {});
  const past = a => (s.areas[a].days || []).filter(d => d.kind === 'analysis');
  const fut = a => (s.areas[a].days || []).filter(d => d.kind === 'forecast');
  if (!s.past || s.past.from) {   // an ahead-only snapshot (relay) has no past week
    L.push('PAST WEEK (GFS analyses 12Z, ' + fmtDay(s.past.from) + ' – ' + fmtDay(s.past.to) + '):');
    order.forEach(a => L.push('  ' + s.areas[a].name + ': ' + areaLine(s.areas[a], past(a)) + '.'));
  }
  if (s.ahead && s.ahead.from) {
    L.push('WEEK AHEAD (GFS run ' + s.ahead.run + ', ' + fmtDay(s.ahead.from) + ' – ' + fmtDay(s.ahead.to) + '; CAT and CB to ' + (s.ahead.hazardsTo ? fmtDay(s.ahead.hazardsTo) : '+72 h') + ' only):');
    order.forEach(a => L.push('  ' + s.areas[a].name + ': ' + areaLine(s.areas[a], fut(a)) + '.'));
  }
  if ((s.missing || []).length) L.push('GAPS: no model SIGWX for ' + s.missing.join(', ') + ' — a gap in the data, not calm weather.');
  L.push('CITE: ' + s.attribution + ' Model-derived; not an official WAFS SIGWX.');
  return L.join('\n');
}

// U.main writes the snapshot pretty-printed; the jet paths would then take four lines a point.
// Rewritten compactly (temporary name and rename), as BUILD-R4 asks for weather snapshots.
function rewriteCompact(week) {
  const p = path.join(U.ROOT, 'data', DIR, 'week-' + week + '.json');
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8')), tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, p);
    console.log(NAME + ': written compactly, ' + Math.round(fs.statSync(p).size / 1024) + ' KB');
  } catch (e) { /* nothing written by this run, or unreadable: leave it */ }
}

module.exports = { LABEL, ATTRIBUTION, DISCLAIMER, AREAS, AREA_IDS, WORK, RES, PROFILE, CAT_LEVELS, BANDS, CAT_FIXED, OG,
                   nomadsSelection, idxWanted, expectedKeys, fieldsOf, jetsOf, tropOf, catOf, cbOf, areaLine, digest, fetchSigwxModel };
if (require.main === module) {
  const c = U.cli(process.argv);
  U.main(NAME, DIR, fetchSigwxModel, digest).then(() => { if (!c.has('--print-digest') && c.week) rewriteCompact(c.week); });
}
