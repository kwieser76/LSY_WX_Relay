#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-contrails.js
// The "Contrails" weather layer (v1.12.0, Kurt's decisions of 21 Oct 2026, tools/research-2026-10-21-contrails/
// BUILD-CONTRACT.md): for the three map frames (North America, North Atlantic & Europe, Middle East) and the three
// flight levels of the jet and CAT layers (FL300 / FL340 / FL390 = 300 / 250 / 200 hPa), where a contrail can form
// behind a typical turbofan (Schmidt-Appleman criterion) and where the air is near ice saturation (relative humidity
// over ice at least 95 %), computed by us from NOAA GFS temperature and humidity. Every snapshot says
// "MODEL-DERIVED · NOT AN OFFICIAL PRODUCT". Map layer only: the written briefing says nothing about contrails
// (Kurt, 21 Oct), so run-briefing.sh logs the digest and never hands it to the prompt.
//
// Classes per 2° cell (physics in contrail-diag.js, 22 tests): 0 no contrail, 1 short-lived contrail possible (SAC met,
// drier), 2 persistent contrail possible (SAC met and RHi >= 0.95), 255 no data. A cell has class c when at least 5 of
// its 25 GFS 0.5° points reach c (the rule of the CAT layer). GFS never writes RH above 100 % over ice, so class 2
// means "near ice saturation", never ice supersaturation; "possible" is never a statement that a contrail forms.
//
// Days, all at 12Z:
//   past week   the GFS analysis (f000 of the 12Z cycle) of each day of the reporting window, kind 'analysis'; a day
//               whose 12Z analysis is not out yet (LAG_H 5 h) is a note, not a day.
//   week ahead  7 days from the latest complete GFS cycle at run time (sigwx-diag.js aheadPlan); classes only up to
//               +72 h, the lead beyond which model humidity is not reliable. Days beyond keep date/valid/run/lead/kind
//               and have no bands. --backfill uses the 00Z cycle of the day after the window (archive).
// Per file: TMP and RH at 300/250/200 hPa plus SPFH, the latter for the RH convention check on the 250 hPa field
// (contrail-diag.js rhConvention: over ice today, over water announced for a later GFS post-processor). A file whose
// convention cannot be told is a gap with a note, never a guess; the convention goes into the producer stamp, so a
// switch in GFS changes the stamp instead of silently drying the map.
//
// Sources, anonymous, no key, NOAA/NWS public domain (https://www.weather.gov/disclaimer — derived data must not be
// presented as official or NOAA-endorsed; the snapshot says so):
//   NOMADS grib filter 0.5°  https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p50.pl — one request per file for one
//               subregion covering all three frames (1–77N 172W–84E); used for cycles up to 8 days old, paced at 1.1 s.
//   AWS open data  https://noaa-gfs-bdp-pds.s3.amazonaws.com (the same files, kept for years): the .idx inventory, then
//               HTTP Range for exactly the needed messages. Used for older cycles and whenever NOMADS fails. 403/429
//               from either host stops asking it for the rest of the run.
// Frames, work grid and output grids are imported from fetch-sigwx-model.js (read-only), so the cells are the same as
// the CAT bands. Decoding reuses fetch-wxoutlook.js decodeGrib2, read-only.
//
// Measured on W42 (2026-10-21, run 00Z; 7 analyses + 3 forecast files with classes, 10 files): 16 requests (NOMADS 9,
// AWS 7: one analysis older than 8 days from the archive), 11.8 MB, 18 s, snapshot 57 KB compact. Ahead-only (the
// relay's parts.contrails): 3 NOMADS requests, 3.1 MB, 4 s, 21 KB. This week (two analyses): 2 requests, 2 s. RH
// convention 'ice' on every file (ratio about 1.0 on the 250 hPa field). Budget: well under the 180 s ceiling.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const U = require('./fetch-util.js');
const L = require('./wx-layers.js');        // the weather layer registry: producer stamp (ADR-001)
const WX = require('./fetch-wxoutlook.js');      // decodeGrib2, getBuffer, getRange, pool (shared, read-only)
const D = require('./sigwx-diag.js');            // cycles, plan, inventories, crop, RLE (pure, read-only)
const C = require('./contrail-diag.js');         // the physics and the GRIB bookkeeping (pure, read-only)
const SM = require('./fetch-sigwx-model.js');    // AREAS, AREA_IDS, WORK, OG, RES (read-only): the frames of the CAT layer

const NAME = 'fetch-contrails', DIR = 'contrails';
const LABEL = 'MODEL-DERIVED · NOT AN OFFICIAL PRODUCT';
const SOURCE = 'NOAA GFS 0.5° (NCEP): analyses (past week) and forecasts (week ahead)';
const SOURCE_OBS = 'NOAA GFS 0.5° (NCEP): analyses';
const ATTRIBUTION = 'Derived by the LSY WX Relay from NOAA GFS data (NOAA/NCEP, public domain). Not a NOAA/NWS product; not endorsed by NOAA.';
const DISCLAIMER = 'Model-derived contrail potential computed by the LSY WX Relay from NOAA GFS data. Not an official product; not issued or checked by any meteorological authority; not for flight planning or operational use. ' +
  'Each cell shows whether the Schmidt-Appleman criterion is met for a typical turbofan (overall efficiency 0.3, water emission index 1.23 kg per kg fuel, fuel energy 43.1 MJ per kg) at FL300, FL340 and FL390, and whether the air is near ice saturation (relative humidity over ice at least 95 %). ' +
  'GFS output never shows humidity above ice saturation, so "persistent contrail possible" means near-saturated air, not a contrail forecast. ' +
  'Weather models predict upper-level humidity much worse than temperature: published skill for ice supersaturation is low (equitable threat score about 0.1 to 0.2), and a level value stands for a layer about 1.2 to 1.5 km deep, so thin moist layers are missed or over-drawn. Classes are drawn up to 72 h ahead.';
const PAGES = { gfs: 'https://www.nco.ncep.noaa.gov/pmb/products/gfs/', nomads: 'https://nomads.ncep.noaa.gov/', aws: 'https://registry.opendata.aws/noaa-gfs-bdp-pds/', disclaimer: 'https://www.weather.gov/disclaimer' };

const NOMADS = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p50.pl';
const BUCKET = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
const HOST = { nomads: 'nomads.ncep.noaa.gov', aws: 'noaa-gfs-bdp-pds.s3.amazonaws.com' };

const { AREAS, AREA_IDS, WORK, OG, RES } = SM;
const HALF = 1, GFS_RES = 0.5;
const LEVELS = C.LEVELS, CONV_LEVEL = '250';                  // the convention check runs on the 250 hPa field
const LEAD_MAX_H = 72;
const NOMADS_MAX_AGE_H = 8 * 24, NOMADS_GAP_MS = 1100, AWS_PARALLEL = 4, LAG_H = 5;
// Below fetch-util's default ceiling of 180 s (no own MAX_SECONDS entry: fetch-util.js is part of the public relay).
const SOFT_DEADLINE_S = 140, TIMEOUT_MS = 45000;

const fmtDay = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };
const blockedErr = e => /HTTP (403|429)/.exec(String((e && e.message) || e));
const pct = x => (isFinite(x) ? Math.round(x * 100) : null);

// The network, behind one object so a test can stand in for it (test-contrails-fetcher.js).
const NET = {
  text: (url, o) => U.getText(url, o),
  buffer: (url, o) => WX.getBuffer(url, o),
  range: (url, offset, length, o) => WX.getRange(url, offset, length, o),
};

// ---- what each file must deliver ----------------------------------------------------------------
// TMP, RH and SPFH at the three levels (contrail-diag.js: nomadsSelection / idxWanted / expectedKeys with the
// convention check on). The same selection for every file, analysis or forecast.
const WITH_Q = true;
const nomadsUrlOf = job => { const sel = C.nomadsSelection(WITH_Q); return D.nomadsUrl(NOMADS, job.cycle, job.fh, sel.vars, sel.levs, WORK); };
// Decoded messages -> work-grid fields { 'TMP:250': grid, ... }, the first message of each key.
function fieldsOf(msgs) {
  const f = {};
  for (const m of msgs) { const k = C.keyOf(m); if (k && !f[k]) f[k] = D.crop(m, WORK, GFS_RES); }
  return f;
}

// ---- products of one file -----------------------------------------------------------------------
// The classes of one file per frame and level: { convention: { convention, ratio, n }, bands: { na: { '300': rle, … } },
// cov: { na: { '300': share of cells with class 2 } } }, or { error } when the RH convention cannot be told (a gap).
function productsOf(f, P) {
  P = P || C.PARAMS;
  const pConv = +CONV_LEVEL * 100;
  const conv = C.rhConvention(f['TMP:' + CONV_LEVEL], f['RH:' + CONV_LEVEL], f['SPFH:' + CONV_LEVEL], pConv, P);
  if (!conv.convention) return { error: 'RH convention of the file not recognised (ratio ' + conv.ratio + ' over ' + conv.n + ' cold points)', convention: conv };
  const bands = {}, cov = {};
  AREA_IDS.forEach(a => { bands[a] = {}; cov[a] = {}; });
  LEVELS.forEach(lev => {
    const pPa = +lev * 100, tmp = f['TMP:' + lev], rh = f['RH:' + lev];
    const cls = C.classField(tmp, C.rhiField(rh, tmp, conv.convention), pPa, P);
    AREA_IDS.forEach(a => {
      const cells = C.cellClasses(cls, tmp, OG[a], P.minPts, HALF);
      bands[a][lev] = D.rleEncode(Array.from(cells));
      cov[a][lev] = C.coverage(cells, 2);
    });
  });
  return { convention: conv, bands, cov };
}

// ---- the plan: one job per GFS file -------------------------------------------------------------
// aheadOnly (the public week-ahead relay): no analyses, only the forecast files; `past` keeps its keys with from/to
// null. pastOnly (the relay's This-week part, fetchContrailsObserved): analyses only, dates = the days to read instead
// of from..to. Forecast days beyond LEAD_MAX_H get no job: they keep their meta and have no bands.
function planJobs({ from, to, backfill, aheadOnly, pastOnly, dates, nowMs }) {
  const now = nowMs != null ? nowMs : Date.now(), notes = [], jobs = [];
  const pastDays = aheadOnly ? [] : (dates || daysOf(from, to));
  pastDays.forEach(d => {
    if (Date.parse(d + 'T12:00:00Z') + LAG_H * 36e5 > now) { notes.push('Past week: ' + d + ' 12Z analysis not yet published at run time.'); return; }
    jobs.push({ id: 'ana ' + d, date: d, kind: 'analysis', cycle: D.cycleOf(Date.parse(d + 'T12:00:00Z')), fh: 0 });
  });
  const run = backfill ? D.cycleOf(Date.parse(U.addDays(to, 1) + 'T00:00:00Z')) : D.latestCycle(now, LAG_H);
  const ahead = pastOnly ? [] : D.aheadPlan(run, to, 7, LEAD_MAX_H);
  ahead.forEach(p => { if (p.hazards) jobs.push({ id: 'fc ' + p.date, date: p.date, kind: 'forecast', cycle: run, fh: p.lead }); });
  return { from, to, backfill: !!backfill, aheadOnly: !!aheadOnly, pastOnly: !!pastOnly, pastDays, run, ahead, jobs, notes, nowMs: now };
}

// ---- assemble -----------------------------------------------------------------------------------
// results: { jobId: { job, source, convention, bands, cov } }; stats: { hits, bytes, via, failed, dead, nomadsErrors, forceAws, t0 }.
// One RH convention per snapshot (it is in the stamp): the one most files show; a file with another one is a gap with
// a note, so one stamp holds for the whole file and the relay's parts compare to it.
function conventionOf(results) {
  const n = {}; Object.values(results).forEach(r => { const c = r.convention.convention; n[c] = (n[c] || 0) + 1; });
  const list = Object.keys(n).sort((x, y) => n[y] - n[x] || x.localeCompare(y));
  return list[0] || null;
}
function assemble(plan, results, stats) {
  const notes = plan.notes.slice(), failed = stats.failed.slice(), hits = stats.hits, bytes = stats.bytes;
  if (!Object.keys(results).length) throw new Error('no GFS file read: ' + failed.slice(0, 3).join('; '));
  const rhConvention = conventionOf(results);
  const odd = Object.keys(results).filter(k => results[k].convention.convention !== rhConvention);
  odd.forEach(k => { failed.push(k + ' (RH convention ' + results[k].convention.convention + ', the other files ' + rhConvention + ')'); delete results[k]; });

  const dayPlan = [];
  plan.pastDays.forEach(d => dayPlan.push({ date: d, kind: 'analysis', id: 'ana ' + d }));
  plan.ahead.forEach(p => dayPlan.push({ date: p.date, kind: 'forecast', id: p.hazards ? 'fc ' + p.date : null, plan: p }));
  const areas = {}, missingDays = [];
  AREA_IDS.forEach(a => { const A = AREAS[a]; areas[a] = Object.assign({ name: A.name, box: { s: A.s, n: A.n, w: A.w, e: A.e } }, OG[a], { days: [] }); });
  let classDays = 0;
  dayPlan.forEach(dp => {
    const r = dp.id && results[dp.id], valid = dp.date + 'T12:00Z';
    if (dp.id && !r) { if (plan.jobs.some(j => j.id === dp.id)) missingDays.push(dp.date); return; }
    if (r) classDays++;
    AREA_IDS.forEach(a => {
      const day = r ? { date: dp.date, valid, run: D.cycleLabel(r.job.cycle), lead: r.job.fh, kind: dp.kind, bands: Object.fromEntries(LEVELS.map(l => [l, { ctr: r.bands[a][l] }])) }
                    : { date: dp.date, valid, run: D.cycleLabel(plan.run), lead: dp.plan.lead, kind: dp.kind };
      areas[a].days.push(day);
    });
  });
  if (failed.length) notes.push('GFS files not read: ' + failed.join(', ') + '. A missing day is a gap in the data, not a sky without contrails.');
  if (missingDays.length) notes.push('No contrail classes for ' + missingDays.join(', ') + ' (GFS file not read or its humidity convention not recognised).');
  if (stats.via.aws.length && !stats.forceAws) notes.push('Read from the NOAA GFS archive on AWS (NOMADS ' + (stats.dead[HOST.nomads] ? 'stopped' : 'no longer had them or failed') + '): ' + stats.via.aws.join(', ') + '.' + (stats.nomadsErrors.length ? ' NOMADS: ' + stats.nomadsErrors.join('; ') + '.' : ''));
  notes.push('Classes up to +' + LEAD_MAX_H + ' h only; beyond that the week-ahead days carry no bands. GFS never reports humidity above ice saturation: class 2 is near ice saturation, not ice supersaturation.');

  const classesTo = (plan.ahead.filter(p => p.hazards).pop() || {}).date || null;
  const mb = Math.round((bytes[HOST.nomads] + bytes[HOST.aws]) / 1048576 * 10) / 10;
  const out = {
    source: SOURCE, label: LABEL, disclaimer: DISCLAIMER, attribution: ATTRIBUTION, pages: PAGES,
    model: 'GFS 0.5°', res: RES, areaOrder: AREA_IDS,
    layout: 'per frame: grid points lat0 + j*res, lon0 + i*res, row-major south→north, west→east; each point summarises the GFS 0.5° points within ±1° (25 points)',
    encoding: { ctr: 'rle "v*n,v" of classes 0/1/2, 255 = no data' },
    bands: bandsMeta(),
    contrail: contrailMeta(rhConvention),
    past: plan.aheadOnly ? { from: null, to: null, hour: '12Z', kind: 'not fetched (ahead-only)' } : { from: plan.from, to: plan.to, hour: '12Z', kind: 'GFS analyses (f000)' },
    ahead: plan.pastOnly ? { run: null, from: null, to: null, classesTo: null, mode: null }
                         : { run: D.cycleLabel(plan.run), from: plan.ahead[0] ? plan.ahead[0].date : null, to: plan.ahead.length ? plan.ahead[plan.ahead.length - 1].date : null, classesTo,
                             mode: plan.backfill ? 'backfill: 00Z cycle after the window, from the archive' : 'latest complete cycle at run time' },
    areas,
    missing: missingDays,
    requests: hits, megabytes: mb, sources: { nomads: stats.via.nomads.length, aws: stats.via.aws.length },
    notes,
  };
  if (plan.aheadOnly) out.aheadOnly = true;
  if (plan.pastOnly) out.pastOnly = true;
  out.producer = stampOf(rhConvention);
  out.seconds = Math.round((Date.now() - stats.t0) / 1000);
  out.snapshotBytes = Buffer.byteLength(JSON.stringify(out));
  out.summary = [(plan.aheadOnly ? 'ahead only' : plan.from + ' .. ' + plan.to) + (plan.pastOnly ? '' : ' + ahead ' + (out.ahead.from || '?') + ' .. ' + (out.ahead.to || '?') + ' (run ' + out.ahead.run + ', classes to ' + (classesTo || '?') + ')') +
                 ' · ' + areas.atl.days.length + ' days × 3 frames, classes on ' + classDays + ' · files: ' + stats.via.nomads.length + ' NOMADS, ' + stats.via.aws.length + ' AWS archive' + (failed.length ? ', ' + failed.length + ' failed' : '') +
                 ' · requests NOMADS ' + hits[HOST.nomads] + ', AWS ' + hits[HOST.aws] + ' · ' + mb + ' MB · ' + out.seconds + ' s · snapshot ' + Math.round(out.snapshotBytes / 1024) + ' KB compact · RH over ' + rhConvention];
  return out;
}
const bandsMeta = () => Object.fromEntries(LEVELS.map(l => [l, { fl: C.LEVEL_FL[l], hPa: +l }]));
function contrailMeta(rhConvention) {
  return {
    criterion: 'Schmidt-Appleman criterion (Schumann 1996, as implemented in pycontrails): can a contrail form behind a typical turbofan',
    persistence: 'relative humidity over ice (RHi) at or above rhiPersistent; GFS never writes RHi above 100 %, so class 2 means near ice saturation, not ice supersaturation',
    params: Object.assign({}, C.PARAMS, { eps: Math.round(C.PARAMS.eps * 1000) / 1000 }),
    rhConvention,
    classes: { 0: 'no contrail', 1: 'short-lived contrail possible', 2: 'persistent contrail possible' },
    cell: 'class c when at least ' + C.PARAMS.minPts + ' of the 25 0.5° points reach class c; 255 when fewer than ' + C.PARAMS.minPts + ' points have data',
    leadMaxH: LEAD_MAX_H, wording: 'possible, never a forecast that a contrail will form; no warming or climate claim',
  };
}
// One stamp for the Monday snapshot, the relay's forecast days and This week's analyses (scripts/wx-layers.js); the
// detected RH convention is part of it.
const stampOf = rhConvention => L.stamp('contrails', { params: C.PARAMS, bands: LEVELS, res: RES, areas: AREAS, leadMaxH: LEAD_MAX_H, rhConvention });

// ---- fetching -----------------------------------------------------------------------------------
async function fetchContrails({ to, from, backfill, aheadOnly, pastOnly, dates, nowMs, softDeadlineS }) {
  const t0 = Date.now();
  const plan = planJobs({ from, to, backfill, aheadOnly, pastOnly, dates, nowMs });
  const forceAws = U.cli(process.argv).has('--archive-only');
  const deadline = softDeadlineS || SOFT_DEADLINE_S;
  const hits = { [HOST.nomads]: 0, [HOST.aws]: 0 }, bytes = { [HOST.nomads]: 0, [HOST.aws]: 0 }, dead = {};
  const nomadsErrors = [], notes = plan.notes;
  const late = () => (Date.now() - t0) / 1000 > deadline;

  // NOMADS: one request at a time, >= 1.1 s from start to start.
  let nomadsChain = Promise.resolve(), nomadsLast = 0;
  const nomadsGet = url => {
    const p = nomadsChain.then(async () => {
      const wait = nomadsLast + NOMADS_GAP_MS - Date.now(); if (wait > 0) await U.sleep(wait);
      nomadsLast = Date.now();
      if (dead[HOST.nomads] || late()) throw new Error('skipped');
      hits[HOST.nomads]++;
      return NET.buffer(url, { timeoutMs: TIMEOUT_MS, retries: 0 });
    });
    nomadsChain = p.catch(() => {});
    return p;
  };
  const kill = (host, e, what) => { if (!dead[host]) { dead[host] = true; notes.push(host + ' answered ' + blockedErr(e)[0] + ' (' + what + ') — not asked again this run.'); } };

  async function viaNomads(job) {
    const url = nomadsUrlOf(job);
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
    try { hits[HOST.aws]++; idx = await NET.text(file + '.idx', { retries: 0, timeoutMs: 20000 }); bytes[HOST.aws] += idx.length; }
    catch (e) { if (blockedErr(e)) kill(HOST.aws, e, job.id); throw e; }
    const ranges = D.idxRanges(D.parseIdx(idx), C.idxWanted(WITH_Q));
    if (!ranges.length) throw new Error('inventory lists none of the fields');
    const parts = [];
    for (const r of ranges) {
      if (dead[HOST.aws]) throw new Error('archive host stopped');
      try { hits[HOST.aws]++; const b = await NET.range(file, r.offset, r.length, { timeoutMs: TIMEOUT_MS, retries: 1 }); bytes[HOST.aws] += b.length; parts.push(b); }
      catch (e) { if (blockedErr(e)) kill(HOST.aws, e, job.id); throw e; }
    }
    return Buffer.concat(parts);
  }

  const results = {}, failed = [], via = { nomads: [], aws: [] };
  async function runJob(job) {
    if (late()) { failed.push(job.id + ' (time budget)'); return; }
    const ageH = (plan.nowMs - job.cycle.ms) / 36e5;
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
    const missing = C.expectedKeys(WITH_Q).filter(k => !f[k]);
    if (missing.length) { failed.push(job.id + ' (fields missing: ' + missing.slice(0, 4).join(', ') + ')'); return; }
    const r = productsOf(f);
    if (r.error) { failed.push(job.id + ' (' + r.error + ')'); return; }
    via[source].push(job.id);
    results[job.id] = { job, source, convention: r.convention, bands: r.bands, cov: r.cov };
  }
  // AWS-bound and NOMADS-bound jobs run side by side; at most AWS_PARALLEL jobs in flight.
  await WX.pool(plan.jobs, AWS_PARALLEL, runJob);
  return assemble(plan, results, { hits, bytes, via, failed, dead, nomadsErrors, forceAws, t0 });
}

// ---- digest (run log only) ----------------------------------------------------------------------
// One line per frame: the largest share of cells with class 2 per level and the day it fell on, over the days with
// classes; then the standing sentence on what GFS can and cannot show. run-briefing.sh writes this to the log and
// never into the prompt (map layer only, Kurt 21 Oct).
const covOf = rle => { let n = 0, m = 0; D.rleDecode(rle).forEach(v => { if (v === 255) return; n++; if (v === 2) m++; }); return n ? m / n : NaN; };
function areaLine(days) {
  const withBands = days.filter(d => d.bands);
  if (!withBands.length) return 'no classes (no GFS file read)';
  return LEVELS.map(l => {
    let best = null;
    withBands.forEach(d => { const c = covOf((d.bands[l] || {}).ctr || ''); if (isFinite(c) && (!best || c > best.c)) best = { c, d }; });
    if (!best) return C.LEVEL_FL[l] + ' no data';
    return C.LEVEL_FL[l] + ' up to ' + pct(best.c) + ' % of cells (' + fmtDay(best.d.date) + (best.d.kind === 'forecast' ? ', forecast +' + best.d.lead + ' h' : '') + ')';
  }).join(', ');
}
function digest(s) {
  const out = [];
  out.push('CONTRAILS (' + s.label + '; computed by the LSY WX Relay from NOAA GFS 0.5°, not a NOAA/NWS product, not for operational use; MAP LAYER ONLY, nothing of this goes into the written briefing): ' +
           'cells where a contrail can form behind a typical turbofan (Schmidt-Appleman) and the air is near ice saturation (RHi ≥ 95 %), "persistent contrail possible", at FL300/340/390.');
  const order = s.areaOrder || Object.keys(s.areas || {});
  const span = [];
  if (s.past && s.past.from) span.push('GFS analyses 12Z ' + fmtDay(s.past.from) + ' – ' + fmtDay(s.past.to));
  if (s.ahead && s.ahead.from) span.push('GFS run ' + s.ahead.run + ', classes to ' + (s.ahead.classesTo ? fmtDay(s.ahead.classesTo) : '+' + LEAD_MAX_H + ' h'));
  out.push('SHARE OF CELLS WITH "PERSISTENT CONTRAIL POSSIBLE", highest day per level (' + span.join('; ') + '):');
  order.forEach(a => out.push('  ' + s.areas[a].name + ': ' + areaLine(s.areas[a].days || []) + '.'));
  out.push('GFS never reports humidity above ice saturation, so these cells show near-saturated air, not ice supersaturation; "possible" is not a statement that a contrail forms. Classes are drawn up to +' + LEAD_MAX_H + ' h only.');
  if ((s.missing || []).length) out.push('GAPS: no contrail classes for ' + s.missing.join(', ') + ' — a gap in the data, not a sky without contrails.');
  out.push('CITE: ' + s.attribution + ' Model-derived; not an official product.');
  return out.join('\n');
}

// ---- This week (the public relay's since.contrails) ---------------------------------------------
// The classes of each day of This week from the GFS 12Z analysis, as for the briefing week. cache = { prev, next, info }
// as the relay's other incremental parts: a day is final when every frame has its three bands; a day missing a band
// is asked for again on the next run. The 12Z analysis is out about 17Z (LAG_H), so today usually joins on the last
// run of the day; until then the page uses the week-ahead forecast day of parts.contrails.
const OBS_CACHE_VERSION = 1;
const obsFinal = x => !!x && AREA_IDS.every(a => x[a] && x[a].bands && LEVELS.every(l => x[a].bands[l] && typeof x[a].bands[l].ctr === 'string'));
function readObsCache(prev, from, to) {
  if (!prev || prev.kind !== 'contrails' || prev.version !== OBS_CACHE_VERSION || !prev.days || typeof prev.days !== 'object') return { days: {}, dropped: prev ? 'cache of another kind or version, fresh start' : null };
  const days = {}; let dropped = 0;
  Object.keys(prev.days).forEach(d => { const x = prev.days[d]; if (d >= from && d <= to && x && AREA_IDS.every(a => x[a] && x[a].date === d)) days[d] = x; else dropped++; });
  return { days, dropped: dropped ? dropped + ' day(s) outside the window dropped' : null };
}
async function fetchContrailsObserved({ from, to, cache, nowMs, softDeadlineS }) {   // nowMs: tests only
  const t0 = Date.now(), now = nowMs != null ? nowMs : Date.now(), prev = cache ? readObsCache(cache.prev, from, to) : { days: {}, dropped: null };
  const out12 = d => Date.parse(d + 'T12:00:00Z') + LAG_H * 36e5 <= now;
  const all = daysOf(from, to), open = all.filter(d => !obsFinal(prev.days[d])), need = open.filter(out12), got = Object.assign({}, prev.days), notes = [];
  open.filter(d => !out12(d)).forEach(d => notes.push(d + ': the GFS 12Z analysis is not yet published (about 17Z).'));
  let r = null, fetched = 0;
  if (need.length) {
    try { r = await fetchContrails({ from, to, dates: need, pastOnly: true, nowMs: now, softDeadlineS }); }
    catch (e) { notes.push('Contrail classes not read: ' + String(e.message || e).slice(0, 160)); }
  }
  if (r) {
    fetched = Object.values(r.requests).reduce((a, n) => a + n, 0);
    const by = {}; AREA_IDS.forEach(a => r.areas[a].days.forEach(d => { (by[d.date] = by[d.date] || {})[a] = d; }));
    // a new read replaces the cached day only when it is at least as complete; the day remembers its RH convention
    Object.keys(by).forEach(d => { if (AREA_IDS.every(a => by[d][a]) && (obsFinal(by[d]) || !got[d])) { by[d].rhConvention = r.contrail.rhConvention; got[d] = by[d]; } });
    r.notes.filter(n => !/^(Classes up to|Past week: .* not yet published)/.test(n)).forEach(n => notes.push(n));
  }
  // One convention per part (it is in the stamp): the one most days carry; a cached day with another one is dropped
  // and asked for again next time.
  const convCount = {}; Object.keys(got).forEach(d => { const c = got[d].rhConvention || 'ice'; convCount[c] = (convCount[c] || 0) + 1; });
  const rhConvention = Object.keys(convCount).sort((x, y) => convCount[y] - convCount[x] || x.localeCompare(y))[0] || 'ice';
  Object.keys(got).forEach(d => { if ((got[d].rhConvention || 'ice') !== rhConvention) { notes.push(d + ': RH convention ' + got[d].rhConvention + ' differs from the other days (' + rhConvention + '); left out.'); delete got[d]; } });
  const dates = all.filter(d => got[d]), missing = all.filter(d => !got[d]);
  if (!dates.length) throw new Error(notes.join('; ') || 'no GFS analysis for ' + from + ' .. ' + to);
  const areas = {};
  AREA_IDS.forEach(a => { const A = AREAS[a]; areas[a] = Object.assign({ name: A.name, box: { s: A.s, n: A.n, w: A.w, e: A.e } }, OG[a], { days: dates.map(d => got[d][a]) }); });
  if (cache) {
    const keep = {}; dates.forEach(d => { keep[d] = got[d]; });
    cache.next = { kind: 'contrails', version: OBS_CACHE_VERSION, days: keep };
    cache.info = { reused: all.length - open.length, fetched, dropped: prev.dropped };
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  return { source: SOURCE_OBS, label: LABEL, disclaimer: DISCLAIMER, attribution: ATTRIBUTION, pages: PAGES,
           model: 'GFS 0.5°', res: RES, areaOrder: AREA_IDS,
           layout: 'per frame: grid points lat0 + j*res, lon0 + i*res, row-major south→north, west→east; each point summarises the GFS 0.5° points within ±1° (25 points)',
           encoding: { ctr: 'rle "v*n,v" of classes 0/1/2, 255 = no data' },
           bands: bandsMeta(), contrail: contrailMeta(rhConvention),
           past: { from, to, hour: '12Z', kind: 'GFS analyses (f000)' }, areas, missing,
           requests: r ? r.requests : {}, notes, seconds, producer: stampOf(rhConvention),
           summary: [from + ' .. ' + to + ' · ' + dates.length + ' day(s) (' + (all.length - open.length) + ' from the cache) · ' + fetched + ' requests · ' + seconds + ' s · RH over ' + rhConvention] };
}

// U.main writes the snapshot pretty-printed; rewritten compactly (temporary name and rename), as the other weather
// snapshots (BUILD-R4).
function rewriteCompact(week) {
  const p = path.join(U.ROOT, 'data', DIR, 'week-' + week + '.json');
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8')), tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, p);
    console.log(NAME + ': written compactly, ' + Math.round(fs.statSync(p).size / 1024) + ' KB');
  } catch (e) { /* nothing written by this run, or unreadable: leave it */ }
}

module.exports = { NAME, DIR, LABEL, ATTRIBUTION, DISCLAIMER, PAGES, LEVELS, LEAD_MAX_H, HOST, NET, WITH_Q,
                   nomadsUrlOf, fieldsOf, productsOf, planJobs, conventionOf, assemble, stampOf, contrailMeta, areaLine, digest,
                   fetchContrails, readObsCache, obsFinal, fetchContrailsObserved };
if (require.main === module) {
  const c = U.cli(process.argv);
  U.main(NAME, DIR, fetchContrails, digest).then(() => { if (!c.has('--print-digest') && c.week) rewriteCompact(c.week); });
}
