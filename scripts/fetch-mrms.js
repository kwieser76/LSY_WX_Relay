#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-mrms.js
// US radar storm hours for the North America weather map: per day and per 0.5° cell over the MRMS
// CONUS domain (20–55N, 130W–60W), the number of hours in which the radar composite reached 40 dBZ,
// plus the day's largest radar-estimated hail. Written to data/mrms/week-<WEEK>.json, bundled as
// window.LSY_MRMS; --print-digest gives the run prompt two lines.
//
// Why radar and not lightning: no free US lightning source may be redistributed. The MRMS lightning
// grids on the same bucket (NLDN_CG_*) are Vaisala NLDN data under a NOAA contract — NOAA: "Lightning
// data is restricted in that it cannot be made available to anyone outside of NOAA" — so they are NOT
// used here. GOES GLM is licence-clean but HDF5 and 12–14 GB a week. Hours with ≥ 40 dBZ mark heavy-rain
// and thunderstorm cores; they stand in for "where thunderstorms were" (round-4 research, lightning_radar_canada.md).
//
// Source — anonymous, no key: the NOAA Open Data Dissemination (NODD) bucket noaa-mrms-pds on AWS,
//   https://noaa-mrms-pds.s3.amazonaws.com/CONUS/<product>/<YYYYMMDD>/MRMS_<product>_<YYYYMMDD>-<HHMMSS>.grib2.gz
//   File names are deterministic, so the fetcher never lists the bucket.
//   - CREF_1HR_MAX_00.50: the maximum composite reflectivity of the hour ENDING at the time stamp
//     (hourly, 0.01°, 7000 × 3500, about 2.6 MB). Every hour of the week is read: 168 files, nothing
//     sampled — each file already holds the maximum over its whole hour.
//   - MESH_Max_1440min_00.50: the largest Maximum Estimated Size of Hail of the 24 h ending at the stamp;
//     the 00:00Z file of day D+1 covers the UTC day D (7 files, about 0.5 MB each). Its "no coverage"
//     code (−3) also gives the radar coverage mask: CREF itself uses −99 for "no echo" AND "no radar",
//     so the mask cannot come from the storm field. (Checked 2026-10-06: MESH ≥ −1 agrees with the
//     24-h radar quality index ≥ 0 in 6,511 of 6,512 cells.)
//   Both fields are GRIB2 with PNG packing (template 5.41), decoded by grib-png.js as a stream, so the
//   49 MB raster of a file is never held whole (about 85 MB RSS in total).
//   Requests go out one at a time, PAUSE_MS after each answer; the next file downloads while the current
//   one is decoded. MESH first (small, carries the coverage), then CREF in a spread order of the hours
//   (00, 12, 06, 18 … Z, each for all days), so a run cut short by the time budget still covers every day
//   alike. On HTTP 403 or 429 the run stops asking at once and keeps what it has; a 404 is a missing file.
//
// Licence: NODD — "NOAA data disseminated through NODD are open to the public and can be used as desired
// ... NOAA requests attribution ... If you modify NOAA data, you may not state or imply that it is original,
// unaltered NOAA data." (https://raw.githubusercontent.com/awslabs/open-data-registry/main/datasets/noaa-mrms-pds.yaml).
// The attribution travels in the snapshot and the digest and must sit next to the map.
// ---------------------------------------------------------------------------
'use strict';

const zlib = require('zlib');
const U = require('./fetch-util.js');
const GP = require('./grib-png.js');
const H = require('./grid-hours.js');

const BUCKET = 'https://noaa-mrms-pds.s3.amazonaws.com';
const HOST = 'noaa-mrms-pds.s3.amazonaws.com';
const CREF = 'CREF_1HR_MAX_00.50';
const MESH = 'MESH_Max_1440min_00.50';
const PAGES = {
  registry: 'https://registry.opendata.aws/noaa-mrms-pds/',
  licence: 'https://raw.githubusercontent.com/awslabs/open-data-registry/main/datasets/noaa-mrms-pds.yaml',
  product: 'https://vlab.noaa.gov/web/wdtd/-/composite-reflectivity',
  nodd: 'https://www.noaa.gov/information-technology/open-data-dissemination',
};
const ATTRIBUTION = 'Source: NOAA MRMS radar data via the NOAA Open Data Dissemination program; modified — aggregated by the LSY WX Relay to hours ≥ 40 dBZ and daily hail per 0.5° cell, not original NOAA data';

// 0.5° cells over the MRMS CONUS domain; 50 × 50 MRMS pixels per cell (pixel centres 20.005–54.995N, 129.995–60.005W).
const GRID = { res: 0.5, lat0: 20, lon0: -130, nlat: 70, nlon: 140 };
const MRMS_SHAPE = { ni: 7000, nj: 3500 };
const DBZ = 40;                       // "strong storm echo": heavy rain / thunderstorm core
const MIN_PIXELS = 4;                // a cell counts in an hour with ≥ 4 pixels (≈ 4 km²) ≥ 40 dBZ: single speckles do not
const CLUTTER_SHARE = 0.5;            // a pixel ≥ 40 dBZ in half the hours of the week or more is a fixed echo, not weather
const HAIL_MIN_MM = 25;               // radar-estimated hail shown from 25 mm (1 in, the US severe-hail size); MESH tends to run
                                      // high: W40 had MESH up to ~100 mm on 7 days but one SPC hail report (1 in)
const COVER_SHARE = 0.5;              // a cell has radar coverage when at least half of its pixels have
const NO_COVER_BELOW = -2;            // MESH: −3 = no radar coverage, −1 = covered, no hail (values ≥ 0 = hail size mm)
const PAUSE_MS = 250;                 // after each answer, before the next request
const TIMEOUT_MS = 45000;             // 2.6 MB from S3 us-east-1: 0.6–2.5 s measured
const LATENCY_MIN = 20;               // MRMS files appear a few minutes after the hour
// U.main's watchdog writes nothing past MAX_SECONDS; past this soft deadline no new file is asked for, so
// the snapshot is written with what was read and the rest is marked missing.
const WATCHDOG_S = (U.MAX_SECONDS && U.MAX_SECONDS['fetch-mrms']) || 180;
const SOFT_DEADLINE_S = WATCHDOG_S - 45;
const DEAD_AFTER_FAILURES = 8;        // in a row

// ---- where: plain-words names for US cells; the first box that holds the point wins --------------------
const AREAS = [
  ['the Florida peninsula', 24.5, 29.75, -83.0, -79.75],
  ['the Bahamas and Cuba', 20.0, 27.5, -85.0, -72.0],
  ['the Gulf of Mexico', 20.0, 28.75, -97.25, -82.75],
  ['the Gulf Coast', 28.75, 32.0, -97.5, -81.0],
  ['northern Mexico', 20.0, 26.0, -106.0, -97.25],
  ['northern Mexico', 20.0, 28.5, -112.0, -99.5],
  ['the Southeast (Georgia, the Carolinas)', 32.0, 36.75, -86.0, -75.0],
  ['the Mid-Atlantic', 36.75, 41.25, -80.5, -73.0],
  ['New England', 41.25, 47.5, -73.75, -66.75],
  ['the Northeast', 40.0, 45.25, -80.5, -73.75],
  ['the Ohio Valley', 36.0, 41.5, -91.0, -80.5],
  ['the Great Lakes', 41.5, 49.0, -92.5, -76.0],
  ['the Upper Midwest', 40.5, 49.5, -97.0, -92.5],
  ['the Lower Mississippi Valley', 29.0, 36.0, -94.5, -86.0],
  ['the Southern Plains (Texas, Oklahoma)', 25.5, 37.0, -106.75, -94.5],
  ['the Central Plains', 37.0, 43.0, -104.0, -91.0],
  ['the Northern Plains', 43.0, 49.0, -104.5, -97.0],
  ['the Rockies', 37.0, 49.0, -114.0, -104.0],
  ['the Desert Southwest', 31.25, 37.0, -115.0, -103.0],
  ['California and the Great Basin', 32.0, 42.0, -125.0, -114.0],
  ['the Pacific Northwest', 42.0, 49.0, -125.0, -114.0],
  ['the Atlantic off the East Coast', 25.0, 45.0, -81.0, -60.0],
  ['the Pacific off the West Coast', 20.0, 50.0, -130.0, -117.0],
  ['southern Canada', 49.0, 55.0, -130.0, -60.0],
];
const areaOf = H.areaNamer(AREAS);

// ---- files ----------------------------------------------------------------------------------------
const stampOf = ms => { const s = new Date(ms).toISOString(); return { day: s.slice(0, 10).replace(/-/g, ''), hms: s.slice(11, 19).replace(/:/g, '') }; };
function fileUrl(product, ms) {
  const s = stampOf(ms);
  return BUCKET + '/CONUS/' + product + '/' + s.day + '/MRMS_' + product + '_' + s.day + '-' + s.hms + '.grib2.gz';
}
// The files of the window. CREF: the hour h of day D is the file stamped D h+1:00Z (hour-ending), so day D
// reads D 01Z … D+1 00Z. MESH: day D is the 24-h maximum stamped D+1 00:00Z. Files younger than LATENCY_MIN
// are not asked for (future).
function plannedFiles(from, to, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs, ready = t => t <= now - LATENCY_MIN * 60000;
  const cref = [], mesh = [], future = [];
  for (const d of H.daysOf(from, to)) {
    const d0 = Date.parse(d + 'T00:00:00Z');
    const m = { kind: 'mesh', date: d, hour: null, stamp: d0 + 86400000 };
    (ready(m.stamp) ? mesh : future).push(m);
    for (let h = 0; h < 24; h++) {
      const f = { kind: 'cref', date: d, hour: h, stamp: d0 + (h + 1) * 3600000 };
      (ready(f.stamp) ? cref : future).push(f);
    }
  }
  return { planned: mesh.concat(H.spread(cref)), future };
}

// ---- one field → cells -----------------------------------------------------------------------------
const norm180 = x => ((x + 540) % 360) - 180;
// For every GRIB column / row the output cell column / row (−1 outside the grid).
function cellIndex(gr, G) {
  const g = G || GRID, colCell = new Int32Array(gr.ni), rowCell = new Int32Array(gr.nj);
  for (let i = 0; i < gr.ni; i++) {
    const I = Math.floor((norm180(gr.lo1 + i * gr.di * ((gr.scan & 0x80) ? -1 : 1)) - g.lon0) / g.res);
    colCell[i] = I >= 0 && I < g.nlon ? I : -1;
  }
  for (let j = 0; j < gr.nj; j++) {
    const J = Math.floor((gr.la1 + j * gr.dj * ((gr.scan & 0x40) ? 1 : -1) - g.lat0) / g.res);
    rowCell[j] = J >= 0 && J < g.nlat ? J : -1;
  }
  return { colCell, rowCell };
}
// Calls visit(cellIndex, X, pixelIndex) for every pixel inside the grid; resolves when the field is read.
async function eachPixel(m, G, visit) {
  if (m.bitmap !== null) throw new Error('GRIB2 bitmap with PNG packing is not supported here');
  const g = G || GRID, { colCell, rowCell } = cellIndex(m.grid, g);
  if (!m.png) {                                   // constant field: no image
    const x = 0;
    for (let j = 0; j < m.grid.nj; j++) if (rowCell[j] >= 0) for (let i = 0; i < m.grid.ni; i++) if (colCell[i] >= 0) visit(rowCell[j] * g.nlon + colCell[i], x, j * m.grid.ni + i);
    return;
  }
  const W = m.image.width, sb = m.image.sampleBits;
  await GP.streamRows(m.png, (j, row) => {
    const J = rowCell[j];
    if (J < 0) return;
    const base = J * g.nlon, p0 = j * W;
    if (sb === 16) { for (let i = 0, o = 0; i < W; i++, o += 2) { const I = colCell[i]; if (I >= 0) visit(base + I, (row[o] << 8) | row[o + 1], p0 + i); } }
    else for (let i = 0; i < W; i++) { const I = colCell[i]; if (I >= 0) visit(base + I, GP.sampleAt(row, i, sb), p0 + i); }
  });
}
// CREF: per cell the number of pixels ≥ DBZ; pixHours (optional, one byte per MRMS pixel) counts for every
// pixel the hours in which it was ≥ DBZ, to find fixed echoes at the end of the week.
async function stormCells(m, G, dbz, pixHours) {
  const g = G || GRID, thr = GP.packedAtLeast(m.pk, dbz == null ? DBZ : dbz), counts = new Uint16Array(g.nlat * g.nlon);
  await eachPixel(m, g, pixHours
    ? (k, x, p) => { if (x >= thr) { counts[k]++; if (pixHours[p] < 255) pixHours[p]++; } }
    : (k, x) => { if (x >= thr) counts[k]++; });
  return { counts };
}
// Fixed echoes (ground clutter, e.g. 3 pixels in the Cascades near 48.8N 121.8W that were ≥ 40 dBZ in every
// hour of W40): pixels ≥ DBZ in at least CLUTTER_SHARE of the hours read. Returns per cell how many there are,
// or null when fewer than 24 hours were read (too few to tell a fixed echo from a long storm).
function clutterPerCell(pixHours, hoursRead, gr, G) {
  const g = G || GRID, out = new Uint16Array(g.nlat * g.nlon);
  if (!pixHours || hoursRead < 24) return null;
  const { colCell, rowCell } = cellIndex(gr, g), need = Math.ceil(CLUTTER_SHARE * hoursRead);
  let pixels = 0;
  for (let p = 0; p < pixHours.length; p++) if (pixHours[p] >= need) {
    const J = rowCell[Math.floor(p / gr.ni)], I = colCell[p % gr.ni];
    if (J >= 0 && I >= 0) { out[J * g.nlon + I]++; pixels++; }
  }
  return { perCell: out, pixels, cells: out.filter(v => v).length };
}
// One hour's 0/1 cells: at least MIN_PIXELS pixels ≥ DBZ after taking the cell's fixed-echo pixels off.
function litCells(counts, clutter, minPx) {
  const n = minPx == null ? MIN_PIXELS : minPx, lit = new Uint8Array(counts.length);
  let any = false;
  for (let k = 0; k < counts.length; k++) if (counts[k] - (clutter ? clutter[k] : 0) >= n) { lit[k] = 1; any = true; }
  return { lit, any };
}
// MESH: per cell the hail size (mm) reached by at least MIN_PIXELS pixels (so one stray pixel does not set it),
// and whether at least COVER_SHARE of its pixels have radar coverage.
async function hailCells(m, G, minPx) {
  const g = G || GRID, N = g.nlat * g.nlon, K = minPx || MIN_PIXELS, top = new Int32Array(N * K).fill(-1), covered = new Uint32Array(N), total = new Uint32Array(N);
  const thrCover = GP.packedAtLeast(m.pk, NO_COVER_BELOW);
  await eachPixel(m, g, (k, x) => {
    total[k]++; if (x >= thrCover) covered[k]++;
    const b = k * K;
    if (x > top[b + K - 1]) { let q = K - 1; while (q > 0 && x > top[b + q - 1]) { top[b + q] = top[b + q - 1]; q--; } top[b + q] = x; }
  });
  const mm = new Uint8Array(N), cover = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (total[k] && covered[k] >= COVER_SHARE * total[k]) cover[k] = 1;
    const x = top[k * K + K - 1];
    if (x >= 0) { const v = GP.valueOf(m.pk, x); if (v >= HAIL_MIN_MM) mm[k] = Math.min(255, Math.round(v)); }
  }
  return { mm, cover };
}
// Reads a downloaded file: gunzip, sections, a sanity check of the grid.
function openField(buf) {
  const b = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const m = GP.readMessage(b);
  if (m.grid.ni !== MRMS_SHAPE.ni || m.grid.nj !== MRMS_SHAPE.nj) throw new Error('unexpected grid ' + m.grid.ni + '×' + m.grid.nj + ' (expected the 0.01° CONUS grid 7000×3500)');
  return m;
}

// ---- incremental runs (the public relay) ----------------------------------------------------------
// The relay reads the current week four times a day. With the `cache` option an hour (or a day's hail file)
// read in an earlier run of the week is taken from the cache, not downloaded again. The cache keeps per CREF
// file the pixel counts per cell (before the fixed-echo filter), per MESH file the hail and coverage cells, and
// the per-pixel hour counter of the fixed-echo filter (deflated), so the result is the same as one run reading
// every file now. A JSON object:
//   { kind: 'mrms', version, params, from, grid {ni, nj, la1, lo1, di, dj, scan}, cref { '<stamp ISO>': counts RLE },
//     mesh { 'YYYY-MM-DD': { mm, cover } }, pixHours (base64 of raw deflate), misses { '<kind>|<stamp ISO>': n } }
// A cache of another week (from), with other settings (params) or one that does not decode is dropped.
const CACHE_VERSION = 1;
const MISS_TRIES = 3;                          // a file that failed this often in earlier runs is not asked for again
const cacheParams = () => JSON.stringify({ GRID, MRMS_SHAPE, CREF, MESH, DBZ, MIN_PIXELS, HAIL_MIN_MM, COVER_SHARE, NO_COVER_BELOW });
const fileKey = f => f.kind + '|' + new Date(f.stamp).toISOString().slice(0, 16) + 'Z';
function readCache(c, from) {
  const fresh = why => ({ cref: new Map(), mesh: new Map(), pixHours: null, grid: null, misses: {}, dropped: why });
  if (c == null) return fresh(null);
  if (typeof c !== 'object' || c.kind !== 'mrms' || c.version !== CACHE_VERSION) return fresh('not an MRMS cache of version ' + CACHE_VERSION);
  if (c.params !== cacheParams()) return fresh('written with other grid or threshold settings');
  if (c.from !== from) return fresh('of another week (' + c.from + ')');
  const N = GRID.nlat * GRID.nlon, cref = new Map(), mesh = new Map();
  try {
    for (const [k, v] of Object.entries(c.cref || {})) {
      const a = H.rleDecode(v);
      if (a.length !== N) return fresh('hour ' + k + ' does not decode');
      cref.set(k, Uint16Array.from(a));
    }
    for (const [d, v] of Object.entries(c.mesh || {})) {
      const mm = H.rleDecode(v && v.mm), cover = H.rleDecode(v && v.cover);
      if (mm.length !== N || cover.length !== N) return fresh('hail day ' + d + ' does not decode');
      mesh.set(d, { mm: Uint8Array.from(mm), cover: Uint8Array.from(cover) });
    }
    let pixHours = null, grid = null;
    if (cref.size) {
      const g = c.grid || {};
      if (g.ni !== MRMS_SHAPE.ni || g.nj !== MRMS_SHAPE.nj || ![g.la1, g.lo1, g.di, g.dj, g.scan].every(Number.isFinite)) return fresh('grid missing');
      pixHours = new Uint8Array(zlib.inflateRawSync(Buffer.from(String(c.pixHours || ''), 'base64')));
      if (pixHours.length !== MRMS_SHAPE.ni * MRMS_SHAPE.nj) return fresh('fixed-echo counter does not decode');
      grid = { ni: g.ni, nj: g.nj, la1: g.la1, lo1: g.lo1, di: g.di, dj: g.dj, scan: g.scan };
    }
    const misses = {};
    Object.entries(c.misses || {}).forEach(([k, n]) => { if (Number.isInteger(n) && n > 0) misses[k] = n; });
    return { cref, mesh, pixHours, grid, misses, dropped: null };
  } catch (e) { return fresh('unreadable (' + H.clip(e.message, 60) + ')'); }
}

// ---- fetch ------------------------------------------------------------------------------------
// Options beyond the window, all absent in the weekly run (which then behaves exactly as before):
//   pauseMs, nowMs  tests only
//   cache           { prev: <cache object or null> } — incremental mode: files in prev are not downloaded again;
//                   on return cache.next holds the new cache and cache.info { reused, fetched, dropped }
//   maxFiles        at most this many downloads in this run (the rest stays missing for a later run)
//   softDeadlineS   instead of the watchdog-derived SOFT_DEADLINE_S
async function fetchMrms({ from, to, pauseMs, nowMs: nowArg, cache, maxFiles, softDeadlineS }) {
  const t0 = Date.now(), nowMs = nowArg == null ? Date.now() : nowArg, pause = pauseMs != null ? pauseMs : PAUSE_MS;
  const softS = softDeadlineS != null ? softDeadlineS : SOFT_DEADLINE_S, maxReq = maxFiles != null ? maxFiles : Infinity;
  const notes = [], dates = H.daysOf(from, to), plan = plannedFiles(from, to, nowMs);
  if (!plan.planned.length) throw new Error('no file of the window is old enough to be on the bucket yet');
  let C = cache ? readCache(cache.prev, from) : null;
  if (C && C.cref.size) {
    // Every cached hour must be one this run plans, or the fixed-echo counter would hold hours the week does not.
    const keys = new Set(plan.planned.map(fileKey));
    const stray = [...C.cref.keys()].find(k => !keys.has(k));
    if (stray) C = readCache(null, from), C.dropped = 'hour ' + stray + ' is not in this window';
  }
  const frames = [], hail = new Map(), reasons = {}, ms = [];
  let hits = 0, bytes = 0, stopped = null, failRun = 0, decodeMs = 0, crefGrid = C && C.grid, reused = 0;
  const pixHours = C && C.pixHours ? C.pixHours : new Uint8Array(MRMS_SHAPE.ni * MRMS_SHAPE.nj);
  const failed = new Set();                    // incremental mode: files asked for in this run whose failure is the file's own
  const miss = (f, why) => { if (f.kind === 'cref') frames.push({ date: f.date, hour: f.hour, lit: null }); reasons[f.kind + ': ' + why] = (reasons[f.kind + ': ' + why] || 0) + 1; };
  // Incremental mode: a file read in an earlier run joins as if read now.
  const takeCached = f => {
    const k = fileKey(f);
    if (f.kind === 'cref' && C.cref.has(k)) { frames.push({ date: f.date, hour: f.hour, counts: C.cref.get(k), lit: null, key: k }); reused++; return true; }
    if (f.kind === 'mesh' && C.mesh.has(f.date)) { hail.set(f.date, C.mesh.get(f.date)); reused++; return true; }
    if ((C.misses[k] || 0) >= MISS_TRIES) { miss(f, 'failed in ' + MISS_TRIES + ' earlier runs, not asked again'); return true; }
    return false;
  };
  let idx = 0;
  const nextFile = () => {
    while (idx < plan.planned.length) {
      const f = plan.planned[idx++];
      if (C) {
        if (takeCached(f)) continue;
        if (!stopped && hits >= maxReq) stopped = 'download cap of ' + maxReq + ' files for this run reached (the rest follows in a later run)';
      }
      if (!stopped && (Date.now() - t0) / 1000 > softS) stopped = 'time budget of ' + softS + ' s used up';
      if (stopped) { miss(f, 'not asked — ' + stopped); continue; }
      return f;
    }
    return null;
  };
  const download = f => { hits++; return H.getBin(fileUrl(f.kind === 'cref' ? CREF : MESH, f.stamp), { timeoutMs: TIMEOUT_MS }).then(r => ({ f, r })); };
  let first = nextFile(), pending = first ? download(first) : null;
  while (pending) {
    const { f, r } = await pending;
    ms.push(r.ms);
    if (r.buf) bytes += r.buf.length;
    let why = null;
    if (r.status === 403 || r.status === 429) {
      stopped = HOST + ' answered HTTP ' + r.status + ' — no further request this run';
      notes.push('MRMS: HTTP ' + r.status + ' at ' + fileUrl(f.kind === 'cref' ? CREF : MESH, f.stamp).replace(BUCKET, '') + '; stopped asking at once (no retry), kept the files already read');
      why = 'HTTP ' + r.status;
    } else if (!r.status) why = r.error;
    else if (r.status === 404) why = 'not on the bucket (HTTP 404)';
    else if (r.status !== 200) why = 'HTTP ' + r.status;
    // Ask for the next file now, so it downloads while this one is decoded (still one request at a time).
    const nf = stopped ? null : nextFile();
    pending = nf ? U.sleep(pause).then(() => download(nf)) : null;
    if (!why) {
      const td = Date.now();
      try {
        const m = openField(r.buf);
        if (f.kind === 'cref') {
          const s = await stormCells(m, GRID, DBZ, pixHours);
          frames.push(Object.assign({ date: f.date, hour: f.hour, counts: s.counts, lit: null }, C ? { key: fileKey(f) } : {}));
          crefGrid = crefGrid || m.grid;
        } else hail.set(f.date, await hailCells(m));
        failRun = 0;
      } catch (e) { why = 'not decoded — ' + H.clip(e.message, 90); }
      decodeMs += Date.now() - td;
    }
    if (why) {
      if (C && /^(not on the bucket|not decoded)/.test(why)) failed.add(fileKey(f));
      miss(f, why);
      if (++failRun >= DEAD_AFTER_FAILURES && !stopped) stopped = failRun + ' files in a row failed (last: ' + H.clip(why, 60) + ')';
    }
    if (hits % 42 === 0) console.log('fetch-mrms: ' + hits + ' files asked, ' + Math.round(bytes / 1e6) + ' MB, ' + Math.round((Date.now() - t0) / 1000) + ' s');
  }
  while (idx < plan.planned.length) { const f = plan.planned[idx++]; if (C && takeCached(f)) continue; miss(f, 'not asked — ' + (stopped || 'stopped')); }
  plan.future.forEach(f => miss(f, 'not yet on the bucket at run time'));
  if (C) {
    // The new cache, before the counts are turned into hours below.
    const next = { kind: 'mrms', version: CACHE_VERSION, params: cacheParams(), from, grid: null, cref: {}, mesh: {}, pixHours: null, misses: {} };
    frames.forEach(f => { if (f.counts) next.cref[f.key] = H.rleEncode(f.counts); });
    hail.forEach((h, d) => { next.mesh[d] = { mm: H.rleEncode(h.mm), cover: H.rleEncode(h.cover) }; });
    if (crefGrid && Object.keys(next.cref).length) {
      next.grid = { ni: crefGrid.ni, nj: crefGrid.nj, la1: crefGrid.la1, lo1: crefGrid.lo1, di: crefGrid.di, dj: crefGrid.dj, scan: crefGrid.scan };
      next.pixHours = zlib.deflateRawSync(pixHours, { level: 9 }).toString('base64');
    }
    const ok = new Set(Object.keys(next.cref).concat([...hail.keys()].map(d => fileKey({ kind: 'mesh', stamp: Date.parse(d + 'T00:00:00Z') + 86400000 }))));
    plan.planned.forEach(f => { const k = fileKey(f), n = ok.has(k) ? 0 : (C.misses[k] || 0) + (failed.has(k) ? 1 : 0); if (n) next.misses[k] = n; });
    cache.next = next;
    cache.info = { reused, fetched: hits, dropped: C.dropped };
    frames.forEach(f => { delete f.key; });
  }

  // Fixed echoes off, then each hour's cells.
  const clutter = crefGrid ? clutterPerCell(pixHours, frames.filter(f => f.counts).length, crefGrid) : null;
  frames.forEach(f => { if (f.counts) { const r = litCells(f.counts, clutter && clutter.perCell); f.lit = r.lit; f.empty = !r.any; delete f.counts; } });
  if (clutter && clutter.pixels) notes.push('clutter: ' + clutter.pixels + ' fixed-echo pixel(s) (≥ ' + DBZ + ' dBZ in at least half of the hours read) in ' + clutter.cells + ' cell(s) left out');
  else if (!clutter) notes.push('clutter: fewer than 24 hours read, fixed echoes not filtered');
  const read = frames.filter(f => f.lit);
  if (!read.length) throw new Error('no CREF file read (' + Object.entries(reasons).map(([k, n]) => k + ' ×' + n).slice(0, 2).join('; ') + ')');
  const missing = frames.length - read.length;
  const missText = Object.entries(reasons).map(([k, n]) => H.clip(k, 110) + ' ×' + n).join('; ');
  if (missing || hail.size < dates.length) notes.push('MRMS: ' + missing + ' of ' + frames.length + ' hourly files and ' + (dates.length - hail.size) + ' of ' + dates.length + ' daily hail files missing' + (missText ? ' — ' + missText : ''));
  if (read.length < frames.length * 0.75) notes.push('radar coverage of the week partial — storm hours are undercounted');

  // Coverage: union of the daily MESH masks; a cell where a storm was seen is covered in any case.
  let cover = null, added = 0, partialCells = 0;
  if (hail.size) {
    const N = GRID.nlat * GRID.nlon, seen = new Uint8Array(N);
    cover = new Uint8Array(N);
    hail.forEach(h => { for (let k = 0; k < N; k++) if (h.cover[k]) { cover[k] = 1; seen[k]++; } });
    for (let k = 0; k < N; k++) if (cover[k] && seen[k] < hail.size) partialCells++;
    read.forEach(f => { for (let k = 0; k < N; k++) if (f.lit[k] && !cover[k]) { cover[k] = 1; added++; } });
    if (partialCells) notes.push('coverage: ' + partialCells + ' cell(s) had radar coverage on some days only (radar outages) — storm hours there may be undercounted');
  } else notes.push('coverage mask unavailable (no daily hail file read): grey cannot be told apart from calm on this map');
  const agg = H.aggregateHours(frames, dates, GRID, cover, areaOf, 'hours');
  // Hail per day: largest radar-estimated size (mm) per cell from HAIL_MIN_MM, 0 below; absent on a day without file.
  let hailMax = 0, hailDays = 0, hailPeak = null;
  agg.days.forEach(d => {
    const h = hail.get(d.date);
    if (!h) return;
    let max = 0, cells = 0, pk = -1;
    for (let k = 0; k < h.mm.length; k++) if (h.mm[k]) { cells++; if (h.mm[k] > max) { max = h.mm[k]; pk = k; } }
    d.hail = H.rleEncode(h.mm); d.hailCells = cells; d.hailMax = max;
    if (pk >= 0) {
      const la = GRID.lat0 + (Math.floor(pk / GRID.nlon) + 0.5) * GRID.res, lo = GRID.lon0 + (pk % GRID.nlon + 0.5) * GRID.res;
      d.hailPeak = { lat: la, lon: lo, mm: max, area: areaOf(la, lo) };
      hailDays++;
      if (max > hailMax) { hailMax = max; hailPeak = Object.assign({ date: d.date }, d.hailPeak); }
    }
  });

  const out = {
    source: 'NOAA MRMS (Multi-Radar/Multi-Sensor) on the NOAA Open Data Dissemination bucket noaa-mrms-pds (AWS)',
    attribution: ATTRIBUTION,
    licence: { name: 'NOAA open data (NODD)', url: PAGES.licence,
               note: '"open to the public and can be used as desired"; NOAA requests attribution; modified data must not be presented as original NOAA data' },
    disclaimer: 'Not for operational use. Radar storm hours stand in for lightning; ≥ 40 dBZ marks heavy-rain and thunderstorm cores, not every such echo is a thunderstorm.',
    pages: PAGES,
    product: 'CREF_1HR_MAX ≥ 40 dBZ',
    products: { storms: CREF, hail: MESH },
    sampling: 'every hour of the week: each CREF_1HR_MAX file holds the maximum composite reflectivity of the hour ending at its time stamp, so nothing between samples is lost',
    hailProduct: 'MESH_Max_1440min: radar-estimated maximum hail size of the UTC day (mm), per cell the size reached by at least ' + MIN_PIXELS + ' pixels; shown from ' + HAIL_MIN_MM + ' mm. An estimate that tends to run high, not hail reports',
    hailMinMm: HAIL_MIN_MM, dbz: DBZ,
    res: GRID.res, lat0: GRID.lat0, lon0: GRID.lon0, nlat: GRID.nlat, nlon: GRID.nlon, encoding: 'rle',
    layout: 'cells; row-major south→north, west→east; days[].hours = hours of that UTC day with at least ' + MIN_PIXELS + ' pixels (≈ ' + MIN_PIXELS + ' km²) ≥ 40 dBZ in the cell, fixed echoes left out (0–24); days[].hail = radar-estimated hail mm (0 below ' + HAIL_MIN_MM + ' mm); tokens "v" or "v*n"',
    coverage: cover ? H.rleEncode(cover) : null,
    coverageNote: '1 = radar coverage (MRMS MESH "no coverage" code −3 on fewer than half the cell\'s pixels on at least one day of the week), plus any cell where ≥ 40 dBZ was seen; 0 = no radar data: draw grey, never "no storms". Outside the grid (north of 55N, south of 20N, west of 130W, east of 60W) there is no MRMS data at all.',
    days: agg.days, week: agg.week, max: agg.max, weekMax: agg.weekMax, litCells: agg.litCells, hotspots: agg.hotspots,
    minPixels: MIN_PIXELS, clutterShare: CLUTTER_SHARE, clutterPixels: clutter ? clutter.pixels : null,
    hailMax, hailDays, hailPeak,
    files: { planned: frames.length, read: read.length, missing, empty: read.filter(f => f.empty).length, hailPlanned: dates.length, hailRead: hail.size },
    coverageAdded: added,
    requests: { [HOST]: hits }, megabytes: Math.round(bytes / 1e5) / 10,
    timing: H.timing(ms, { pauseMs: pause, decodeMs: Math.round(decodeMs / Math.max(1, read.length + hail.size)), softDeadlineS: softS }),
    notes,
  };
  if (C) { out.files.future = plan.future.filter(f => f.kind === 'cref').length; out.incremental = cache.info; }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  const top = agg.hotspots[0];
  out.summary = [from + ' .. ' + to + ' · ' + read.length + '/' + frames.length + ' hourly files, ' + hail.size + '/' + dates.length + ' hail files · ' + agg.litCells + ' cells with ≥ ' + DBZ + ' dBZ · max ' +
                 agg.max + ' h/day, ' + agg.weekMax + ' h/week' + (top ? ' · most over ' + top.area + ' (peak ' + top.peakDate + ')' : '') + (hailMax ? ' · hail up to ' + hailMax + ' mm' : '') +
                 ' · ' + hits + ' requests, ' + out.megabytes + ' MB · ' + out.seconds + ' s'];
  return out;
}

// ---- digest -----------------------------------------------------------------------------------
const ll = (lat, lon) => H.latLon(Math.round(lat * 100) / 100, Math.round(lon * 100) / 100);
function digest(s) {
  const w = s.window || {}, fl = s.files || {}, hs = s.hotspots || [];
  const span = w.from && w.to ? H.fmtDay(w.from).replace(/^\w+ /, '') + '–' + H.fmtDay(w.to).replace(/^\w+ /, '') : 'the reporting week';
  const peakDay = (s.days || []).reduce((a, d) => (d.peak && (!a || d.peak.hours > a.peak.hours) ? d : a), null);
  let l1 = 'US RADAR STORM HOURS (NOAA MRMS, hourly maximum radar reflectivity ≥ ' + (s.dbz || DBZ) + ' dBZ per 0.5° cell, ' + span + '; ' +
           (fl.planned ? fl.read + ' of ' + fl.planned + ' hours read' : 'hourly files') + '): ';
  if (!hs.length) l1 += 'no strong storm echo inside the radar coverage.';
  else {
    l1 += 'most storm hours over ' + hs[0].area + ' on ' + H.fmtDay(hs[0].peakDate);
    const more = hs.slice(1, 3).map(h => h.area + ' (' + H.fmtDay(h.peakDate) + ')');
    if (more.length) l1 += '; also ' + more.join(' and ');
    if (peakDay) l1 += '. Longest in one cell: ' + peakDay.peak.hours + ' of ' + peakDay.samples + ' hours near ' + ll(peakDay.peak.lat, peakDay.peak.lon) + ' (' + peakDay.peak.area + ') on ' + H.fmtDay(peakDay.date);
    l1 += '.';
  }
  if (s.hailPeak) l1 += ' Radar hail estimate (MESH, tends to run high; not hail reports) of ' + (s.hailMinMm || HAIL_MIN_MM) + ' mm or more on ' + s.hailDays + ' day' + (s.hailDays === 1 ? '' : 's') + ', largest about ' + s.hailMax + ' mm near ' +
    ll(s.hailPeak.lat, s.hailPeak.lon) + ' (' + s.hailPeak.area + ') on ' + H.fmtDay(s.hailPeak.date) + '.';
  else if (fl.hailRead) l1 += ' No radar hail estimate of ' + (s.hailMinMm || HAIL_MIN_MM) + ' mm or more.';
  const gaps = (s.days || []).filter(d => d.missing).map(d => H.wd(d.date) + ' ' + d.missing);
  const l2 = 'Radar storm hours stand in for lightning, which has no redistributable free US source; ≥ 40 dBZ marks heavy-rain and thunderstorm cores. ' +
    'No radar data (grey, not calm): the sea beyond about 200 km from the coasts, most of Mexico and the Caribbean, Canada north of about 50–55N' +
    (gaps.length ? '; hours missing: ' + gaps.join(', ') : '') + '. ' + (s.attribution || ATTRIBUTION) + '. Not for operational use.';
  return [l1, l2].join('\n');
}

module.exports = { BUCKET, CREF, MESH, GRID, DBZ, MIN_PIXELS, CLUTTER_SHARE, HAIL_MIN_MM, AREAS, areaOf, fileUrl, plannedFiles, cellIndex, stormCells, clutterPerCell, litCells, hailCells, openField, fetchMrms, digest,
                   CACHE_VERSION, readCache, fileKey };
if (require.main === module) U.main('fetch-mrms', 'mrms', fetchMrms, digest);
