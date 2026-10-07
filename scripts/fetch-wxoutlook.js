#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-wxoutlook.js
// Reads the official weather outlooks for the week AHEAD before the research run and hands over a
// short "what to watch" block: the North Atlantic jet, model-derived convective potential over
// Europe and the US, flags for a list of hubs (empty in this relay copy), the US convective / extended / week-2
// hazard outlooks, tropical cyclones in every basin, and space weather.
//
// Why: weather is the dominant delay cause in both the EUROCONTROL and the FAA data the briefing
// already reports, but only after the fact. This block says what the coming week is likely to
// bring. It is forecast context, never an event: the prompt must not turn it into a Topic Card or
// give it an eventDate.
//
// Unlike every other pre-fetch, the period is the week from the run day (UTC) to six days later,
// not the reporting window. The snapshot stores it as `outlook: { from, to }` beside the usual
// `window`, and every product carries its own issue time. --backfill is refused: a forecast issued
// in the past cannot be re-fetched honestly.
//
// Sources — all anonymous, no key:
//   NOAA GFS 1° via the NOMADS grib filter, https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl
//     One request per forecast step (f012..f168, every 12 h) for one box 24–72N, 125W–45E with
//     u/v at 300, 250 and 200 hPa, CAPE, convective precipitation rate, gust, categorical snow and
//     visibility: about 140 KB per step (93 KB before 300/200 hPa were added), GRIB2 simple packing
//     (template 5.0), decoded here without dependencies.
//     NOMADS allows 120 hits/min per IP; this file paces at >1 s. A cycle not yet on the server
//     answers 403 "Request for Future Data" — the reason for the one-cycle fallback. The same steps
//     also give gfs.jetGrid, the wind of each outlook day on a 2° grid for the jet map at 250 hPa
//     (≈ FL340) and, in byLevel, 300 hPa (≈ FL300) and 200 hPa (≈ FL390) — no extra request; 25–71N
//     because the box stops at 72N; about 40 KB. The jet figures, ECMWF and the model comparison
//     stay at 250 hPa. The steps the day maps use (one per date) also carry HGT/ICAHT at the
//     tropopause, max-wind level, 0 °C isotherm and 850/700/500 hPa for gfs.levels (tropopause,
//     max-wind and freezing level as flight levels, same grid; about 43 KB) — no extra request,
//     about +320 KB on each of those 7 steps (measured 2026-10-06: NOMADS 1.9 → 4.2 MB).
//     Since round 4 (2026-10-06) the one box per step is the union of the three map frames, 4–72N 170W–82E
//     (Europe/NAT, North America 13–72N 170W–50W, Middle East 3–47N 14E–82E): no extra request, the same
//     grids cut per area (gfs.jetGrid.areas.na/me, gfs.levels.areas.na/me), and TMAX at 2 m for a heat flag at
//     the hubs, per map frame (`area` 'atl' | 'na' | 'me').
//     Since 2026-10-07 the CAPE / CPRAT of the same steps also give gfs.convGrid (and ECMWF's MUCAPE / tprate
//     ecmwf.convGrid): a convective-potential class per 2° cell and outlook day for all three frames, so the
//     week-ahead map has more than the jet after day 3 — no extra request, no extra bytes downloaded.
//   SPC polygons: each parsed SPC day also keeps its area as simplified rings (`poly`, `lower`) for the map.
//   NOAA NHC/CPHC  CurrentStorms.json and the Tropical Weather Outlook RSS (AT, EP, CP).
//   JTWC           jtwc.rss and the warning texts it links. The JTWC home page answers 403 to
//                  scripted clients; only the RSS and the product texts are read, nothing pretends
//                  to be a browser.
//   NOAA SPC       Day 1–3 categorical and Day 4–8 probabilistic outlooks (GeoJSON) + the Day 4–8 text.
//   NOAA WPC/CPC   api.weather.gov products PMD/EPD (days 3–7), PMD/THR (hazards, week 2), PMD/MRD (6–10/8–14).
//   NOAA SWPC      3-day forecast text and noaa-scales.json.
//   ECMWF open data https://data.ecmwf.int/forecasts — IFS HRES u/v 250 hPa at the GFS valid hours
//                  (the two models compared day by day), MUCAPE + precipitation rate at 18 UTC, and
//                  ENS probabilities (gust >= 15 / 25 m/s, rain >= 20 mm in 24 h) at the hubs. Per-step
//                  .index files, HTTP Range for the needed messages only, CCSDS unpacking in grib-aec.js
//                  (validated 2026-10-05 against GFS at the same analysis time: u250 RMS 1.5 m/s, r 0.997).
// NOAA/NWS content is public domain (https://www.weather.gov/disclaimer). JTWC is a US Navy
// product; no licence statement was found — US Government work. ECMWF open data is CC BY 4.0 under
// the ECMWF terms of use: the snapshot carries the attribution, the digest's CITE line repeats it.
//
// Measured 2026-10-05: 114 requests, 35.5 MB (34 MB of it ECMWF), about 21 s — GFS, ECMWF and the
// text products run side by side; peak memory about 230 MB.
// ---------------------------------------------------------------------------
'use strict';

const U = require('./fetch-util.js');
const AEC = require('./grib-aec.js');
const CX = require('./grib-complex.js');   // complex packing (5.2/5.3): the NOAA GFS archive on AWS, read by fetch-wxreview.js

const LABEL = 'model-derived (GFS), not an official risk category';
const NOMADS = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';
const NOMADS_PAUSE_MS = 1100;      // NOMADS: 120 hits/min per IP; one request a second is far inside it
const TEXT_PAUSE_MS = 300;
const GFS_STEPS = [12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168];
const GFS_LAG_H = 5;               // a cycle is tried once it is this old; f168 of the 1° file is out after ~4 h
// Time budget. Normal run: ~25 s. Past the soft deadline no new request is started, and a host that
// timed out once is not asked again, so even with hung hosts the fetcher ends near 100 s + one
// request (NOMADS 20 s, text 15 s, each with one retry) and writes what it has — well inside
// U.main's watchdog, which would write nothing.
const SOFT_DEADLINE_S = 100;
const NOMADS_TIMEOUT_MS = 20000, TEXT_TIMEOUT_MS = 15000;
// One box for every map frame (union of JET_GRID and AREA_JET_GRID below, top 72N as before): 4–72N 170W–82E.
const GFS_BOX = { top: 72, bottom: 4, left: -170, right: 82 };
const GFS_VARS = ['UGRD', 'VGRD', 'CAPE', 'CPRAT', 'GUST', 'CSNOW', 'VIS', 'TMAX'];
// 300 and 200 hPa only for the jet map's level choice (UGRD/VGRD are the only fields asked for that exist
// there); 250 hPa stays next to 'surface' and carries everything else. 2 m only for TMAX (the hub heat flag).
const GFS_LEVELS = ['2_m_above_ground', '300_mb', '200_mb', '250_mb', 'surface'];
// The flight-level map grids (tropopause, max-wind level, freezing level), asked for only on the steps
// the day grids use (levelSteps). The filter returns every var × level pair that exists, so u/v at
// these levels and HGT at 300/250/200 hPa come along too: 22 more messages, about +350 KB per such
// step. 850/700/500 hPa are there only to turn the freezing level into a pressure altitude.
const LEVEL_VARS = ['HGT', 'ICAHT'];
const LEVEL_LEVS = ['850_mb', '700_mb', '500_mb', 'tropopause', 'max_wind', '0C_isotherm'];

const REGIONS = {
  nat:    { name: 'North Atlantic (30–70N, 70W–0)', s: 30, n: 70, w: -70, e: 0 },
  europe: { name: 'Europe (35–72N, 25W–45E)', s: 35, n: 72, w: -25, e: 45 },
  us:     { name: 'United States (24–50N, 125W–66W)', s: 24, n: 50, w: -125, e: -66 },
};
const WESTERLY = { lat: 50, w: -50, e: -10 };
// Named parts of each box, only to say WHERE the convective grid points are; first match wins.
// Points in no area (open ocean, Mexico, North Africa) still count toward the box share.
const AREAS = {
  europe: [['British Isles', 49, 61, -11, 2], ['Benelux/Germany/Denmark', 47, 58, 2, 15], ['France', 42, 51, -5, 8], ['Iberia', 35, 44, -10, 4],
           ['Alps/Italy', 36, 48, 6, 19], ['Central/Eastern Europe', 45, 55, 15, 30], ['Balkans/Greece/Turkey', 35, 46, 19, 45], ['Nordic', 55, 72, 4, 32]],
  us: [['Northeast', 38, 48, -82, -66], ['Southeast/Florida', 24, 37, -92, -75], ['Texas/western Gulf', 24, 37, -107, -92],
       ['Midwest/Great Lakes', 37, 50, -104, -82], ['West', 30, 50, -125, -104]],
};
const areaOf = (list, lat, lon) => { const a = (list || []).find(([, s, n, w, e]) => lat >= s && lat <= n && lon >= w && lon <= e); return a ? a[0] : 'elsewhere in the box'; };
// Convective potential: the share of the region's grid points where CAPE and the 6-hour mean
// convective precipitation rate are both over the threshold, the larger of the day's two steps.
// heatC: a hub-day with a GFS 2 m maximum of 45 °C or more is flagged (dispatch / performance; PO may tune it).
const THRESHOLDS = { capeJkg: 500, convPrecipMmH: 0.5, moderatePct: 2, highPct: 6, gustKt: 25, visM: 1500, heatC: 45 };
const MS_TO_KT = 1.943844;

// The hub list: { code, icao, name, region, area, lat, lon } per airport. Empty in this relay copy, and the relay
// also passes hubs: [] — no airport-specific value is computed or published.
const HUBS = [];

// Map frames beyond Europe / North Atlantic ('atl', whose grids stay at the top level of every snapshot):
// the round-4 boxes (BUILD-R4.md), and the 2° jet / flight-level grid points cut for each from the same answers.
const MAP_AREAS = {
  na: { name: 'North America', s: 13, n: 72, w: -170, e: -50 },
  me: { name: 'Middle East', s: 3, n: 47, w: 14, e: 82 },
};
const AREA_JET_GRID = { na: { res: 2, lat0: 14, lon0: -170, latMax: 72, lonMax: -50 }, me: { res: 2, lat0: 4, lon0: 14, latMax: 46, lonMax: 82 } };

const PAGES = {
  gfs: 'https://www.nco.ncep.noaa.gov/pmb/products/gfs/',
  nhc: 'https://www.nhc.noaa.gov/gtwo.php',
  // jtwc.html answers 403 to scripted clients, so verify-sources.js would mark it dead; the feed answers 200.
  jtwc: 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',
  spc: 'https://www.spc.noaa.gov/products/outlook/',
  spc48: 'https://www.spc.noaa.gov/products/exper/day4-8/',
  wpc: 'https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=pmdepd',
  cpcThr: 'https://www.cpc.ncep.noaa.gov/products/predictions/threats/threats.php',
  cpcMrd: 'https://www.cpc.ncep.noaa.gov/products/predictions/610day/fxus06.html',
  swpc: 'https://www.swpc.noaa.gov/products/3-day-forecast',
  ecmwf: 'https://www.ecmwf.int/en/forecasts/datasets/open-data',
};
const URLS = {
  nhcStorms: 'https://www.nhc.noaa.gov/CurrentStorms.json',
  two: b => 'https://www.nhc.noaa.gov/xml/TWO' + b + '.xml',
  jtwc: 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',
  spcCat: d => 'https://www.spc.noaa.gov/products/outlook/day' + d + 'otlk_cat.lyr.geojson',
  spcProb: d => 'https://www.spc.noaa.gov/products/exper/day4-8/day' + d + 'prob.lyr.geojson',
  // SPC's own Day 4–8 page carries the same ACUS48 text in a <pre> block. Until 2026-10-06 this read
  // tgftp.nws.noaa.gov, which refused research requests with 403 that day — the host is left alone since.
  acus48: 'https://www.spc.noaa.gov/products/exper/day4-8/',
  pmd: loc => 'https://api.weather.gov/products/types/PMD/locations/' + loc + '/latest',
  swpc3day: 'https://services.swpc.noaa.gov/text/3-day-forecast.txt',
  swpcScales: 'https://services.swpc.noaa.gov/products/noaa-scales.json',
};
// ---- ECMWF open data (https://data.ecmwf.int/forecasts) ----------------------------------------
// One .index file (JSON lines: param, levelist, step, _offset, _length) per step; only the needed
// messages are fetched with HTTP Range. Every field is CCSDS-packed (template 5.42, grib-aec.js).
// Measured 2026-10-05: an index 40 KB in 0.2 s; u/v 250 hPa 0.72 + 0.76 MB, MUCAPE 0.88 MB,
// precipitation rate 0.61 MB, ENS probability fields 0.09–0.39 MB; a missing step answers 404.
const ECMWF = 'https://data.ecmwf.int/forecasts';
const ECMWF_LAG_H = 8;          // the 00Z files are complete around 07:40 UTC (12Z: 19:40); a 05:30 run gets yesterday's 12Z
const ECMWF_PARALLEL = 4;       // ECMWF caps its portal at 500 simultaneous connections; four is plenty
const ECMWF_TIMEOUT_MS = 30000;
const ECMWF_CONV_HOUR = 18;     // one convective snapshot a day: evening in Europe, early afternoon in the US
const ECMWF_LABEL = 'model-derived (ECMWF), not an official risk category';
const ECMWF_ENS = [['10fgg15', 'gust15Pct'], ['10fgg25', 'gust25Pct'], ['tpg20', 'tp20Pct']];   // gust >= 15 / 25 m/s, rain >= 20 mm in 24 h
const ENS_LIST_PCT = 30;        // hub probabilities are listed in the digest from this value up
const AGREE = { jetKt: 15, westerlyKt: 10 };
// The wording ECMWF's terms of use ask services built on its data to carry
// (https://apps.ecmwf.int/datasets/licences/general/), with the modification noted as CC BY requires.
const ECMWF_ATTRIBUTION = 'Contains ECMWF Open Data (CC BY 4.0): this service is based on data and products of the European Centre for ' +
  'Medium-Range Weather Forecasts (ECMWF), source www.ecmwf.int, licence https://creativecommons.org/licenses/by/4.0/. Values are derived ' +
  '(modified) by the relay. ECMWF does not accept any liability for errors or omissions in the data or for any loss arising from their use.';

const SOURCE_ORDER = ['gfs', 'ecmwf-jet', 'ecmwf-ens', 'ecmwf-conv', 'nhc-storms', 'nhc-two-at', 'nhc-two-ep', 'nhc-two-cp', 'jtwc', 'spc-d1', 'spc-d2', 'spc-d3', 'spc-d48',
                      'wpc-epd', 'cpc-thr', 'cpc-mrd', 'swpc-3day', 'swpc-scales'];

// ---- small helpers -------------------------------------------------------------------------
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const round1 = x => Math.round(x * 10) / 10;
const norm180 = lon => { let x = ((lon + 180) % 360 + 360) % 360 - 180; return x === -180 ? 180 : x; };
const unhtml = s => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => (deg == null || isNaN(deg)) ? null : COMPASS[Math.round(((+deg % 360) + 360) % 360 / 22.5) % 16];
const fmtLat = v => Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 1) + (v >= 0 ? 'N' : 'S');
const fmtLon = v => Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 1) + (v >= 0 ? 'E' : 'W');
const pos = (lat, lon) => (lat == null || lon == null) ? '' : fmtLat(lat) + ' ' + fmtLon(lon);
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const fmtDay = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtIssued = iso => { if (!iso) return '?'; const d = new Date(iso); if (isNaN(d)) return String(iso);
  return d.getUTCDate() + ' ' + d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + ' ' +
         String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0') + 'Z'; };

// A WMO "ddhhmm" or JTWC "dd/hhmmZ" stamp resolved against a reference time (the run): the latest
// such moment that is not more than a day after the reference.
function stampToIso(dd, hh, mm, refIso) {
  const ref = new Date(refIso || Date.now());
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - back, +dd, +hh, +mm));
    if (d.getUTCDate() === +dd && d - ref <= 86400000) return d.toISOString();
  }
  return null;
}

// ---- binary fetch -----------------------------------------------------------------------------
// fetch-util has text and JSON helpers only, and res.text() mangles binary. Until it offers a
// getBuffer, this mirrors getText — same declared UA, timeout, one retry, no retry on a plain 4xx —
// the way fetch-pru.js already reads its bzip2 files.
async function getBuffer(url, opts) {
  if (typeof U.getBuffer === 'function') return U.getBuffer(url, opts);
  const o = Object.assign({ timeoutMs: 30000, retries: 1 }, opts || {});
  let lastErr = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (attempt) await U.sleep(2000 * attempt);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': U.UA, Accept: 'application/octet-stream' } });
      if (!res.ok) {
        lastErr = 'HTTP ' + res.status;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        continue;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? 'timeout after ' + o.timeoutMs + 'ms' : String((e && e.message) || e);
    } finally { clearTimeout(t); }
  }
  throw new Error(url.replace(/\?.*$/, '') + ': ' + lastErr);
}

// One byte range of a large file (ECMWF: 140–700 MB per file). Anything but 206 with exactly the
// requested length is an error — a server that ignored the Range header must never start a 700 MB
// download, so the body is not read in that case.
async function getRange(url, offset, length, opts) {
  const o = Object.assign({ timeoutMs: ECMWF_TIMEOUT_MS, retries: 1 }, opts || {});
  const range = 'bytes=' + offset + '-' + (offset + length - 1);
  let lastErr = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (attempt) await U.sleep(2000 * attempt);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': U.UA, Accept: 'application/octet-stream', Range: range } });
      if (res.status !== 206) {
        ac.abort();
        lastErr = 'HTTP ' + res.status + (res.status === 200 ? ' (Range ignored; the whole file was not downloaded)' : '');
        if (res.status === 200 || (res.status >= 400 && res.status < 500 && res.status !== 429)) break;
        continue;
      }
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length !== length) { lastErr = 'got ' + b.length + ' of ' + length + ' bytes'; continue; }
      return b;
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? 'timeout after ' + o.timeoutMs + 'ms' : String((e && e.message) || e);
    } finally { clearTimeout(t); }
  }
  throw new Error(url + ' ' + range + ': ' + lastErr);
}

// Runs fn over items with at most n in flight.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ---- GRIB2: regular lat/lon (3.0), simple (5.0), complex (5.2/5.3) or CCSDS (5.42) packing, optional bitmap
// What the NOMADS filter returns for the 1° GFS. Anything else is refused by name rather than
// decoded wrongly. Signed GRIB2 integers are sign-and-magnitude, not two's complement.
const sm16 = (b, o) => { const v = b.readUInt16BE(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const sm32 = (b, o) => { const v = b.readUInt32BE(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };

function decodeGrib2(buf) {
  const out = [];
  let i = 0;
  while (i + 16 <= buf.length) {
    const at = buf.indexOf('GRIB', i);
    if (at < 0) break;
    if (buf[at + 7] !== 2) throw new Error('GRIB edition ' + buf[at + 7] + ' at byte ' + at + ' (only edition 2 is read)');
    const len = Number(buf.readBigUInt64BE(at + 8));
    if (len < 16 || at + len > buf.length) throw new Error('truncated GRIB2 message at byte ' + at);
    if (buf.toString('latin1', at + len - 4, at + len) !== '7777') throw new Error('GRIB2 message at byte ' + at + ' does not end in 7777');
    const m = { discipline: buf[at + 6] };
    let grid = null, pk = null, bitmap = null, p = at + 16;
    while (p < at + len - 4) {
      const L = buf.readUInt32BE(p), n = buf[p + 4];
      if (L < 5) throw new Error('bad section length at byte ' + p);
      if (n === 1) {
        m.refTime = new Date(Date.UTC(buf.readUInt16BE(p + 12), buf[p + 14] - 1, buf[p + 15], buf[p + 16], buf[p + 17], buf[p + 18])).toISOString();
      } else if (n === 3) {
        const tmpl = buf.readUInt16BE(p + 12);
        if (tmpl !== 0) throw new Error('grid template 3.' + tmpl + ' not supported');
        grid = { npts: buf.readUInt32BE(p + 6), ni: buf.readUInt32BE(p + 30), nj: buf.readUInt32BE(p + 34),
                 la1: sm32(buf, p + 46) / 1e6, lo1: sm32(buf, p + 50) / 1e6, la2: sm32(buf, p + 55) / 1e6, lo2: sm32(buf, p + 59) / 1e6,
                 di: buf.readUInt32BE(p + 63) / 1e6, dj: buf.readUInt32BE(p + 67) / 1e6, scan: buf[p + 71] };
        if (grid.scan & 0x20) throw new Error('grid scan mode 0x' + grid.scan.toString(16) + ' (j-consecutive) not supported');
      } else if (n === 4) {
        m.pdtn = buf.readUInt16BE(p + 7); m.cat = buf[p + 9]; m.num = buf[p + 10];
        m.surfType = buf[p + 22];
        const sf = buf[p + 23], sv = sm32(buf, p + 24);
        m.surfValue = (sf === 0 || sf === 255) ? sv : sv / Math.pow(10, sf);
      } else if (n === 5) {
        const tmpl = buf.readUInt16BE(p + 9);
        if (tmpl === 42) pk = Object.assign({ ccsds: true }, AEC.ccsdsParams(buf, p));            // ECMWF: CCSDS/AEC, see grib-aec.js
        else if (tmpl === 0) pk = { count: buf.readUInt32BE(p + 5), R: buf.readFloatBE(p + 11), E: sm16(buf, p + 15), D: sm16(buf, p + 17), bits: buf[p + 19] };
        else if (tmpl === 2 || tmpl === 3) pk = CX.complexParams(buf, p);                          // NOAA archive: complex packing, see grib-complex.js
        else throw new Error('data template 5.' + tmpl + ' not supported (simple, complex and CCSDS packing only)');
      } else if (n === 6) {
        const ind = buf[p + 5];
        if (ind === 0) bitmap = p + 6;
        else if (ind !== 255) throw new Error('bitmap indicator ' + ind + ' not supported');
      } else if (n === 7) {
        if (!grid || !pk) throw new Error('data section before grid / packing sections');
        const npts = grid.ni * grid.nj, vals = new Float32Array(npts).fill(NaN);
        const e2 = Math.pow(2, pk.E), d10 = Math.pow(10, -pk.D);
        const packed = pk.ccsds ? AEC.unpackCcsds(buf, p + 5, p + L, pk) : pk.complex ? CX.unpackComplex(buf, p + 5, p + L, pk) : null;
        let bit = (p + 5) * 8, k = 0;
        for (let idx = 0; idx < npts; idx++) {
          if (bitmap !== null && !((buf[bitmap + (idx >> 3)] >> (7 - (idx & 7))) & 1)) continue;
          if (packed) { if (k >= packed.length) throw new Error('GRIB2 bitmap marks more points than the CCSDS stream holds'); vals[idx] = packed[k++]; continue; }
          let x = 0;
          for (let b = 0; b < pk.bits; b++, bit++) x = x * 2 + ((buf[bit >> 3] >> (7 - (bit & 7))) & 1);
          vals[idx] = (pk.R + x * e2) * d10;
          k++;
        }
        if (k !== pk.count) throw new Error('GRIB2 value count ' + k + ' does not match the packing section (' + pk.count + ')');
        m.values = vals;
      }
      p += L;
    }
    if (!grid || !m.values) throw new Error('GRIB2 message at byte ' + at + ' has no grid or no data');
    out.push(Object.assign(m, grid));
    i = at + len;
  }
  return out;
}

// Grid geometry: scan bit 0x40 = rows run south to north, 0x80 = columns run east to west.
const gLat = (g, j) => g.la1 + j * g.dj * ((g.scan & 0x40) ? 1 : -1);
const gLon = (g, i) => norm180(g.lo1 + i * g.di * ((g.scan & 0x80) ? -1 : 1));
function nearestIndex(g, lat, lon) {
  const j = Math.round((lat - g.la1) / (g.dj * ((g.scan & 0x40) ? 1 : -1)));
  const dl = ((((g.scan & 0x80) ? g.lo1 - lon : lon - g.lo1) % 360) + 360) % 360;
  const i = Math.round(dl / g.di) % Math.round(360 / g.di);
  if (j < 0 || j >= g.nj || i < 0 || i >= g.ni) return -1;
  return j * g.ni + i;
}
function valueAt(g, lat, lon) { const k = g ? nearestIndex(g, lat, lon) : -1; return k < 0 ? null : (isNaN(g.values[k]) ? null : g.values[k]); }
function eachInRegion(g, r, fn) {
  for (let j = 0; j < g.nj; j++) {
    const lat = gLat(g, j); if (lat < r.s || lat > r.n) continue;
    for (let i = 0; i < g.ni; i++) { const lon = gLon(g, i); if (lon >= r.w && lon <= r.e) fn(j * g.ni + i, lat, lon); }
  }
}

// The fields this file asks for, picked by parameter, level and statistical processing.
function pickFields(msgs) {
  const f = {};
  for (const m of msgs) {
    if (m.discipline !== 0) continue;
    const k = m.cat + '.' + m.num, avg = m.pdtn === 8;
    if (k === '2.2' && m.surfType === 100 && m.surfValue === 25000) f.u250 = m;
    else if (k === '2.3' && m.surfType === 100 && m.surfValue === 25000) f.v250 = m;
    else if (k === '2.2' && m.surfType === 100 && m.surfValue === 30000) f.u300 = m;
    else if (k === '2.3' && m.surfType === 100 && m.surfValue === 30000) f.v300 = m;
    else if (k === '2.2' && m.surfType === 100 && m.surfValue === 20000) f.u200 = m;
    else if (k === '2.3' && m.surfType === 100 && m.surfValue === 20000) f.v200 = m;
    else if (k === '7.6' && m.surfType === 1) f.cape = m;
    else if (k === '1.37' || k === '1.196') { if (avg) f.cpAvg = m; else f.cpInst = m; }        // convective precipitation rate, kg m-2 s-1
    else if (k === '2.22' && m.surfType === 1) f.gust = m;
    else if (k === '1.195') { if (avg) f.snowAvg = m; else f.snowInst = m; }                   // categorical snow (NCEP local)
    else if (k === '19.0' && m.surfType === 1) f.vis = m;
    else if (k === '0.4' && m.surfType === 103) f.tmax = m;                                     // TMAX at 2 m, K (max over the 6 h before the step)
    // Flight-level grids: ICAHT (0.3.3) at the tropopause (surface type 7) and the max-wind level (6),
    // HGT (0.3.5) of the 0 °C isotherm (4) and of the 850 / 700 / 500 hPa surfaces.
    else if (k === '3.3' && m.surfType === 7) f.icahtTrop = m;
    else if (k === '3.3' && m.surfType === 6) f.icahtMaxw = m;
    else if (k === '3.5' && m.surfType === 4) f.hgt0c = m;
    else if (k === '3.5' && m.surfType === 100 && m.surfValue === 85000) f.hgt850 = m;
    else if (k === '3.5' && m.surfType === 100 && m.surfValue === 70000) f.hgt700 = m;
    else if (k === '3.5' && m.surfType === 100 && m.surfValue === 50000) f.hgt500 = m;
  }
  return f;
}

// ---- GFS reducers (pure) ----------------------------------------------------------------------
function natStep(f, region, westerly) {
  region = region || REGIONS.nat; westerly = westerly || WESTERLY;
  if (!f.u250 || !f.v250) return null;
  let best = { kt: -1, lat: null, lon: null };
  eachInRegion(f.u250, region, (k, lat, lon) => {
    const u = f.u250.values[k], v = f.v250.values[k];
    if (isNaN(u) || isNaN(v)) return;
    const kt = Math.hypot(u, v) * MS_TO_KT;
    if (kt > best.kt) best = { kt, lat, lon };
  });
  let sum = 0, n = 0;
  for (let lon = westerly.w; lon <= westerly.e; lon += f.u250.di) { const u = valueAt(f.u250, westerly.lat, lon); if (u != null) { sum += u; n++; } }
  return { jetKt: best.kt < 0 ? null : Math.round(best.kt), lat: best.lat, lon: best.lon, westerlyKt: n ? Math.round(sum / n * MS_TO_KT) : null };
}

function convStep(f, region, t, areas) {
  t = t || THRESHOLDS;
  const cp = f.cpAvg || f.cpInst;
  if (!f.cape || !cp) return null;
  let cells = 0, hits = 0, capeMax = -1, at = [null, null], cpMax = 0;
  const byArea = {};
  eachInRegion(f.cape, region, (k, lat, lon) => {
    const cape = f.cape.values[k], rate = valueAt(cp, lat, lon);
    if (isNaN(cape) || rate == null) return;
    cells++;
    const mmh = rate * 3600;
    if (cape >= t.capeJkg && mmh >= t.convPrecipMmH) { hits++; const a = areaOf(areas, lat, lon); byArea[a] = (byArea[a] || 0) + 1; }
    if (cape > capeMax) { capeMax = cape; at = [lat, lon]; }
    if (mmh > cpMax) cpMax = mmh;
  });
  return { cells, hits, sharePct: cells ? round1(100 * hits / cells) : 0, capeMax: Math.round(Math.max(capeMax, 0)), capeLat: at[0], capeLon: at[1],
           cpMaxMmH: round1(cpMax), byArea };
}
const levelFor = (sharePct, t) => { t = t || THRESHOLDS; return sharePct >= t.highPct ? 'high' : sharePct >= t.moderatePct ? 'moderate' : 'low'; };

function hubStep(f, hub) {
  const gust = valueAt(f.gust, hub.lat, hub.lon), vis = valueAt(f.vis, hub.lat, hub.lon);
  const si = valueAt(f.snowInst, hub.lat, hub.lon), sa = valueAt(f.snowAvg, hub.lat, hub.lon);
  const tx = valueAt(f.tmax, hub.lat, hub.lon);
  const out = { gustKt: gust == null ? null : Math.round(gust * MS_TO_KT), snow: (si != null && si >= 0.5) || (sa != null && sa >= 0.5),
                visM: vis == null ? null : Math.round(vis) };
  if (tx != null) out.tmaxC = Math.round(tx - 273.15);
  return out;
}

// ---- jet map grid (pure) ----------------------------------------------------------------------
// The 250 hPa wind speed for the dashboards' jet map: grid POINTS lat0 + j*res, lon0 + i*res, row-major
// south→north then west→east, integer knots capped at 255, one byte each, base64 — a JSON number
// array would be written one value per line by the pretty-printed snapshot (7 days ≈ 160 KB).
// Decode: b = atob(kt); kt[k] = b.charCodeAt(k). fetch-wxreview.js uses the same function for the
// analyses of the reporting week, so both maps share one shape. `max` is the strongest wind at the
// 1° points of the box (not only at the 2° points kept).
const JET_GRID = { res: 2, lat0: 25, lon0: -80, latMax: 75, lonMax: 40 };
function jetGridOf(u, v, box) {
  box = Object.assign({}, JET_GRID, box || {});
  if (!u || !v || !u.values || !v.values) return null;
  const sp = (lat, lon) => { const a = valueAt(u, lat, lon), b = valueAt(v, lat, lon); return a == null || b == null ? null : Math.hypot(a, b) * MS_TO_KT; };
  // Rows the source grid actually covers (the outlook's GFS box stops at 72N).
  const top = Math.min(box.latMax, Math.max(gLat(u, 0), gLat(u, u.nj - 1)));
  const nlat = Math.floor((top - box.lat0) / box.res) + 1, nlon = Math.floor((box.lonMax - box.lon0) / box.res) + 1;
  const bytes = Buffer.alloc(nlat * nlon);
  for (let j = 0; j < nlat; j++) for (let i = 0; i < nlon; i++) {
    const s = sp(box.lat0 + j * box.res, box.lon0 + i * box.res);
    bytes[j * nlon + i] = s == null ? 0 : Math.min(255, Math.round(s));
  }
  let max = null;
  eachInRegion(u, { s: box.lat0, n: top, w: box.lon0, e: box.lonMax }, (k, lat, lon) => {
    const a = u.values[k], b = v.values[k];
    if (isNaN(a) || isNaN(b)) return;
    const s = Math.hypot(a, b) * MS_TO_KT;
    if (!max || s > max.kt) max = { kt: s, lat, lon };
  });
  return { res: box.res, lat0: box.lat0, lon0: box.lon0, nlat, nlon, kt: bytes.toString('base64'),
           max: max ? { kt: Math.round(max.kt), lat: max.lat, lon: max.lon } : null };
}
// Steps (or analyses) -> the snapshot's jet object: one grid per date, the earliest hour of that date.
function jetDays(items, model, extra) {
  const byDate = {};
  (items || []).filter(x => x && x.grid).sort((a, b) => a.valid.localeCompare(b.valid)).forEach(x => { const d = x.valid.slice(0, 10); if (!byDate[d]) byDate[d] = x; });
  const list = Object.keys(byDate).sort().map(d => byDate[d]);
  if (!list.length) return null;
  const g0 = list[0].grid;
  return { res: g0.res, lat0: g0.lat0, lon0: g0.lon0, nlat: g0.nlat, nlon: g0.nlon, model, ...(extra || {}), encoding: 'base64-uint8',
           layout: 'grid points lat0+j*res, lon0+i*res; row-major south→north, west→east; integer knots 0–255',
           days: list.map(x => ({ date: x.valid.slice(0, 10), valid: x.valid, kt: x.grid.kt })),
           max: list.filter(x => x.grid.max).map(x => ({ date: x.valid.slice(0, 10), kt: x.grid.max.kt, lat: x.grid.max.lat, lon: x.grid.max.lon })) };
}

// The jet map at three levels of the NAT high-level airspace (FL290–FL410): 300 hPa ≈ FL300,
// 250 hPa ≈ FL340, 200 hPa ≈ FL390 (ICAO standard atmosphere). 250 hPa keeps the top-level fields
// of the jet object exactly as before; the other two go to byLevel, same grid and encoding.
const JET_LEVELS = ['300', '250', '200'];
const JET_FL = { '300': 'FL300', '250': 'FL340', '200': 'FL390' };
// The three grids of one decoded step / analysis (null where a level is not in the answer); box: another
// frame's grid points (AREA_JET_GRID), default the Europe/NAT grid.
const jetGridsOf = (f, box) => ({ '300': jetGridOf(f.u300, f.v300, box), '250': jetGridOf(f.u250, f.v250, box), '200': jetGridOf(f.u200, f.v200, box) });
// Per decoded step: the jet and (when asked) flight-level grids of every AREA_JET_GRID frame.
const areaGridsOf = (f, withLevels) => {
  const out = {};
  Object.keys(AREA_JET_GRID).forEach(a => { out[a] = { grids: jetGridsOf(f, AREA_JET_GRID[a]), levels: withLevels ? levelGridsOf(f, AREA_JET_GRID[a]) : null }; });
  return out;
};
// items: [{ valid, areas: areaGridsOf() }] -> { na: jetLevels(), me: … } (an area without any grid is left out).
function areaJetLevels(items, model, extra) {
  const out = {};
  Object.keys(AREA_JET_GRID).forEach(a => {
    const j = jetLevels((items || []).filter(x => x.areas && x.areas[a]).map(x => ({ valid: x.valid, grids: x.areas[a].grids })), model, extra);
    if (j) out[a] = j;
  });
  return Object.keys(out).length ? out : null;
}
// The same for the flight-level grids -> { na: levelDays(), me: … }.
function areaLevelDays(items, model, extra) {
  const out = {};
  Object.keys(AREA_JET_GRID).forEach(a => {
    const l = levelDays((items || []).filter(x => x.areas && x.areas[a] && x.areas[a].levels).map(x => ({ valid: x.valid, grids: x.areas[a].levels })), model, extra);
    if (l) out[a] = l;
  });
  return Object.keys(out).length ? out : null;
}
// items: [{ valid, grids: { '300', '250', '200' } }] -> jetDays() of 250 hPa plus levels / byLevel.
// The date's time is chosen once (earliest item with a 250 hPa grid), so all levels show the same moment.
function jetLevels(items, model, extra) {
  const base = jetDays((items || []).map(x => ({ valid: x.valid, grid: x.grids && x.grids['250'], grids: x.grids })), model, extra);
  if (!base) return null;
  const chosen = {};
  (items || []).filter(x => x && x.grids && x.grids['250']).sort((a, b) => a.valid.localeCompare(b.valid))
    .forEach(x => { const d = x.valid.slice(0, 10); if (!chosen[d]) chosen[d] = x; });
  const byLevel = {};
  JET_LEVELS.filter(lv => lv !== '250').forEach(lv => {
    const list = Object.keys(chosen).sort().map(d => chosen[d]).filter(x => x.grids[lv]);
    if (!list.length) return;
    byLevel[lv] = { days: list.map(x => ({ date: x.valid.slice(0, 10), valid: x.valid, kt: x.grids[lv].kt })),
                    max: list.filter(x => x.grids[lv].max).map(x => ({ date: x.valid.slice(0, 10), kt: x.grids[lv].max.kt, lat: x.grids[lv].max.lat, lon: x.grids[lv].max.lon })) };
  });
  return Object.assign(base, { levels: JET_LEVELS.filter(lv => lv === '250' || byLevel[lv]), byLevel });
}
// The strongest wind of the week at each level: [{ level, fl, kt, date, lat, lon }], 300 → 250 → 200.
function jetLevelMax(jet) {
  if (!jet) return [];
  const of = (lv, max) => { const m = (max || []).reduce((a, b) => (!a || b.kt > a.kt ? b : a), null); return m ? Object.assign({ level: lv, fl: JET_FL[lv] }, m) : null; };
  return (jet.levels || ['250']).map(lv => of(lv, lv === '250' ? jet.max : jet.byLevel && jet.byLevel[lv] && jet.byLevel[lv].max)).filter(Boolean);
}

// ---- flight-level grids: tropopause, max-wind level, freezing level (pure) ---------------------
// Same 2° grid points and base64 layout as the jet grid, one byte per point: value = flight level / 5
// (FL = v × 5), 0 = no value. fetch-wxreview.js uses the same functions for the analyses of the
// reporting week. The three fields, as GFS stores them:
//   trop  ICAHT at the tropopause: the ICAO standard-atmosphere height of the level's pressure, i.e.
//         its pressure altitude, so FL = metres / 30.48 with nothing else to convert.
//   maxw  ICAHT at the max-wind level (the height of the jet core where there is a jet).
//   frz   The 0 °C isotherm. GFS stores it only as a geopotential height (HGT, metres above sea level),
//         0 where the whole column is below freezing. A height is not a pressure altitude: in warm air
//         the pressure surfaces stand higher than in the standard atmosphere. The difference, the
//         D-value (GFS height minus standard-atmosphere height of the same pressure), is taken from the
//         850, 700 and 500 hPa surfaces at the point, interpolated linearly in height (held constant
//         below 850 and above 500 hPa) and subtracted: FL ≈ (z − D(z)) / 30.48. On 28 Sep 2026 00Z the
//         uncorrected heights differed from the corrected ones by −460 to +830 ft (10th–90th percentile
//         over 25–75N 80W–40E); the error left after the correction is not measured, hence "approximate".
//         A column below freezing, and anything below FL8, is stored as 1 ("at or near the surface").
const LEVEL_KEYS = ['trop', 'maxw', 'frz'];
const LEVEL_NAMES = { trop: 'tropopause', maxw: 'max-wind level', frz: 'freezing level' };
const LEVEL_LABEL = 'model-derived (GFS), not an official forecast';
const LEVEL_METHOD = {
  trop: 'GFS ICAHT at the tropopause (ICAO standard-atmosphere height, i.e. pressure altitude); FL = m / 30.48',
  maxw: 'GFS ICAHT at the max-wind level; FL = m / 30.48',
  frz: 'approximate: GFS geopotential height of the 0 °C isotherm minus the D-value (GFS minus standard-atmosphere height) of the 850/700/500 hPa surfaces, interpolated in height; FL = m / 30.48; 1 = at or near the surface (column below freezing, or below FL8)',
};
const LEVEL_NOTE = 'Map, GFS levels: tropopause, max-wind level and freezing level are model-derived (GFS), not an official forecast; the freezing level is approximate (height converted to flight level with the 850/700/500 hPa D-values)';
// Boxes of the digest summary (the same as the PIREP counts in fetch-wxreview.js).
const LEVEL_BOXES = { nat: { name: 'NAT', s: 40, n: 65, w: -60, e: -10 }, europe: { name: 'Europe', s: 35, n: 72, w: -15, e: 40 } };
const isaAltM = hPa => 44330.77 * (1 - Math.pow(hPa / 1013.25, 0.190263));     // ICAO standard atmosphere below 11 km
// Pressure altitude (m) of the geopotential height z (m), from the isobaric surfaces [{ z, hPa }] at the same point.
function pressureAltM(z, surfaces) {
  const s = (surfaces || []).filter(x => x && x.z != null && isFinite(x.z)).map(x => ({ z: x.z, d: x.z - isaAltM(x.hPa) })).sort((a, b) => a.z - b.z);
  if (!s.length) return z;
  let d = z <= s[0].z ? s[0].d : s[s.length - 1].d;
  if (z > s[0].z) for (let i = 0; i + 1 < s.length; i++) if (z <= s[i + 1].z) { d = s[i].d + (z - s[i].z) / (s[i + 1].z - s[i].z) * (s[i + 1].d - s[i].d); break; }
  return z - d;
}
const flByte = fl => (fl == null || !isFinite(fl)) ? 0 : Math.max(1, Math.min(255, Math.round(fl / 5)));
// One decoded step / analysis -> { res, lat0, lon0, nlat, nlon, trop, maxw, frz } (base64 each), or null
// when none of the three fields is in the answer. Rows: as far north as the source grid reaches.
function levelGridsOf(f, box) {
  box = Object.assign({}, JET_GRID, box || {});
  const ref = f && (f.icahtTrop || f.icahtMaxw || f.hgt0c);
  if (!ref || !ref.values) return null;
  const top = Math.min(box.latMax, Math.max(gLat(ref, 0), gLat(ref, ref.nj - 1)));
  const nlat = Math.floor((top - box.lat0) / box.res) + 1, nlon = Math.floor((box.lonMax - box.lon0) / box.res) + 1;
  const iso = [[f.hgt850, 850], [f.hgt700, 700], [f.hgt500, 500]].filter(([g]) => g && g.values);
  const icaht = g => (lat, lon) => { const m = valueAt(g, lat, lon); return m == null ? null : m / 30.48; };
  const flOf = {
    trop: f.icahtTrop ? icaht(f.icahtTrop) : null,
    maxw: f.icahtMaxw ? icaht(f.icahtMaxw) : null,
    frz: f.hgt0c ? (lat, lon) => {
      const z = valueAt(f.hgt0c, lat, lon);
      if (z == null) return null;
      if (z <= 0) return 0;                                         // whole column below 0 °C
      return pressureAltM(z, iso.map(([g, hPa]) => ({ z: valueAt(g, lat, lon), hPa }))) / 30.48;
    } : null,
  };
  const out = { res: box.res, lat0: box.lat0, lon0: box.lon0, nlat, nlon };
  LEVEL_KEYS.forEach(k => {
    if (!flOf[k]) return;
    const bytes = Buffer.alloc(nlat * nlon);
    for (let j = 0; j < nlat; j++) for (let i = 0; i < nlon; i++) bytes[j * nlon + i] = flByte(flOf[k](box.lat0 + j * box.res, box.lon0 + i * box.res));
    out[k] = bytes.toString('base64');
  });
  return out;
}
// items: [{ valid: ISO, grids: levelGridsOf() }] -> the snapshot's `levels`: one set per date (the
// earliest valid time of the date, as the jet map chooses) and each field's FL range over all days.
const validShort = iso => String(iso).slice(0, 16) + 'Z';          // 2026-09-28T00:00:00.000Z -> 2026-09-28T00:00Z
function levelDays(items, model, extra) {
  const byDate = {};
  (items || []).filter(x => x && x.grids).sort((a, b) => a.valid.localeCompare(b.valid)).forEach(x => { const d = x.valid.slice(0, 10); if (!byDate[d]) byDate[d] = x; });
  const list = Object.keys(byDate).sort().map(d => byDate[d]);
  if (!list.length) return null;
  const g0 = list[0].grids, ranges = {};
  LEVEL_KEYS.forEach(k => {
    let lo = 256, hi = 0;
    list.forEach(x => { if (x.grids[k]) for (const v of Buffer.from(x.grids[k], 'base64')) if (v) { if (v < lo) lo = v; if (v > hi) hi = v; } });
    if (hi) ranges[k] = [lo * 5, hi * 5];
  });
  return Object.assign({ model, res: g0.res, lat0: g0.lat0, lon0: g0.lon0, nlat: g0.nlat, nlon: g0.nlon }, extra || {}, {
    encoding: 'base64-uint8', layout: 'as jet; value = flight level / 5 (FL = v*5), 0 = missing; frz 1 = at or near the surface',
    label: LEVEL_LABEL, method: LEVEL_METHOD,
    days: list.map(x => { const d = { date: x.valid.slice(0, 10), valid: validShort(x.valid) }; LEVEL_KEYS.forEach(k => { if (x.grids[k]) d[k] = x.grids[k]; }); return d; }),
    ranges });
}
// The 10th, 50th and 90th percentile of each field over the grid points inside box { s, n, w, e }, all days: { trop: { p10, p50, p90, n } }.
function levelSummary(levels, box) {
  const out = {};
  if (!levels || !levels.days) return out;
  LEVEL_KEYS.forEach(k => {
    const vals = [];
    levels.days.forEach(d => {
      if (!d[k]) return;
      const b = Buffer.from(d[k], 'base64');
      for (let j = 0; j < levels.nlat; j++) {
        const lat = levels.lat0 + j * levels.res; if (lat < box.s || lat > box.n) continue;
        for (let i = 0; i < levels.nlon; i++) { const lon = levels.lon0 + i * levels.res; if (lon < box.w || lon > box.e) continue; const v = b[j * levels.nlon + i]; if (v) vals.push(v * 5); }
      }
    });
    if (!vals.length) return;
    vals.sort((a, b) => a - b);
    const q = p => vals[Math.round(p * (vals.length - 1))];
    out[k] = { p10: q(0.1), p50: q(0.5), p90: q(0.9), n: vals.length };
  });
  return out;
}
const flText = fl => fl <= 5 ? 'surface' : 'FL' + String(fl).padStart(3, '0');
// One digest line for the levels of either snapshot; `what` names the model times ('GFS analyses, 00Z').
function levelLine(levels, what) {
  if (!levels || !levels.days || !levels.days.length) return null;
  const part = (lv, b) => {
    const s = levelSummary(lv, b);
    const p = LEVEL_KEYS.filter(k => s[k]).map(k => LEVEL_NAMES[k] + ' ' + (s[k].p10 === s[k].p90 ? flText(s[k].p10) : flText(s[k].p10) + '–' + flText(s[k].p90)));
    return p.length ? b.name + ' ' + p.join(', ') : null;
  };
  // The other frames (levels.areas), each over its whole box.
  const parts = Object.values(LEVEL_BOXES).map(b => part(levels, b))
    .concat(Object.keys(MAP_AREAS).filter(a => levels.areas && levels.areas[a]).map(a => part(levels.areas[a], MAP_AREAS[a]))).filter(Boolean);
  if (!parts.length) return null;
  const n = levels.days.length;
  return 'FLIGHT LEVELS (' + what + ', ' + n + (n === 1 ? ' day' : ' days') + '; model-derived, not an official forecast; range = middle 80 % of the 2° grid points; freezing level approximate): ' +
    parts.join(' · ') + '.';
}
// One digest line for the jet of the other frames (jet.areas): the strongest wind at any of the three
// levels per area, with level, day and place. `what` names the model times.
function areaJetLine(jet, what) {
  const A = (jet && jet.areas) || {};
  const parts = Object.keys(MAP_AREAS).filter(a => A[a]).map(a => {
    const m = jetLevelMax(A[a]).reduce((x, y) => (!x || y.kt > x.kt ? y : x), null);
    return m ? MAP_AREAS[a].name + ' ' + m.kt + ' kt ' + m.fl + ' ' + wd(m.date) + ' ' + pos(m.lat, m.lon) : null;
  }).filter(Boolean);
  return parts.length ? 'JET, NORTH AMERICA / MIDDLE EAST (' + what + '; strongest wind at FL300/340/390 in each map frame): ' + parts.join(' · ') + '.' : null;
}
// The steps the day grids use: the earliest step of each valid date (as jetLevels chooses), only
// dates inside `range` { from, to } when given. Only these steps carry the flight-level fields.
function levelSteps(cycle, steps, range) {
  const t0 = Date.UTC(+cycle.date.slice(0, 4), +cycle.date.slice(4, 6) - 1, +cycle.date.slice(6, 8), +cycle.hh);
  const first = {};
  (steps || GFS_STEPS).forEach(s => {
    const d = new Date(t0 + s * 3600000).toISOString().slice(0, 10);
    if (range && !U.inRange(d, range.from, range.to)) return;
    if (first[d] == null || s < first[d]) first[d] = s;
  });
  return Object.values(first).sort((a, b) => a - b);
}

// ---- convective-potential map grid (pure) --------------------------------------------------------
// The fields convStep() already reads, kept per 2° cell for the week-ahead map (days 4–7 had only the jet).
// One byte per cell, the class of the strongest source point in it, same thresholds as the summaries:
//   0 none · 1 potential: CAPE ≥ capeJkg only · 2 likely: CAPE ≥ capeJkg and (convective) precipitation
//   ≥ convPrecipMmH at the same point · 255 no data (no source point with a value in the cell).
// Cells: the grid points of the jet map (JET_GRID / AREA_JET_GRID, so the layers line up), point c covering
// sources with c − res/2 ≤ lat, lon < c + res/2. Both models are sampled at the same 1° points (ECMWF's
// 0.25° field thinned to every 4th point), so a cell is never "busier" in one model only because it has
// 16× the points; atl stops at 71N like the GFS jet grid, so GFS and ECMWF grids have one shape.
// A day is the highest class of that date's steps (GFS: two 12-hourly steps; ECMWF: 18 UTC only).
const CONV_NODATA = 255;
const CONV_FRAMES = { atl: Object.assign({}, JET_GRID, { latMax: Math.min(JET_GRID.latMax, GFS_BOX.top) }), na: AREA_JET_GRID.na, me: AREA_JET_GRID.me };
const CONV_CLASSES = { 0: 'none', 1: 'potential: CAPE over the threshold, precipitation under it', 2: 'likely: CAPE and precipitation rate both over the threshold', 255: 'no data' };
const CONV_LOW_CONF_DAY = 4;     // outlook day (run day = 1) from which a model-derived layer says "low confidence"
const convClass = (cape, mmh, t) => { t = t || THRESHOLDS; return cape == null || isNaN(cape) ? null : cape < t.capeJkg ? 0 : (mmh != null && !isNaN(mmh) && mmh >= t.convPrecipMmH ? 2 : 1); };
const onLattice = (x, d) => Math.abs(x / d - Math.round(x / d)) < 1e-6;
// One decoded step -> { res, lat0, lon0, nlat, nlon, c } (c base64 uint8), or null without CAPE or rate.
// box: a CONV_FRAMES entry; sampleDeg: source points used (1 = the whole-degree points; 0 = all).
function convGridOf(f, box, t, sampleDeg) {
  t = t || THRESHOLDS; box = Object.assign({}, CONV_FRAMES.atl, box || {}); sampleDeg = sampleDeg == null ? 1 : sampleDeg;
  const cp = f && (f.cpAvg || f.cpInst);
  if (!f || !f.cape || !f.cape.values || !cp || !cp.values) return null;
  const g = f.cape, same = ['ni', 'nj', 'la1', 'lo1', 'di', 'dj', 'scan'].every(k => g[k] === cp[k]);
  const nlat = Math.floor((box.latMax - box.lat0) / box.res) + 1, nlon = Math.floor((box.lonMax - box.lon0) / box.res) + 1, h = box.res / 2;
  const bytes = Buffer.alloc(nlat * nlon, CONV_NODATA);
  eachInRegion(g, { s: box.lat0 - h, n: box.lat0 + (nlat - 1) * box.res + h, w: box.lon0 - h, e: box.lon0 + (nlon - 1) * box.res + h }, (k, lat, lon) => {
    if (sampleDeg && !(onLattice(lat, sampleDeg) && onLattice(lon, sampleDeg))) return;
    const j = Math.floor((lat - box.lat0 + h) / box.res + 1e-9), i = Math.floor((lon - box.lon0 + h) / box.res + 1e-9);
    if (j < 0 || j >= nlat || i < 0 || i >= nlon) return;            // the upper edge belongs to the next cell, outside the frame
    const r = same ? cp.values[k] : valueAt(cp, lat, lon);
    const c = convClass(g.values[k], r == null || isNaN(r) ? null : r * 3600, t);
    if (c == null) return;
    const q = j * nlon + i;
    if (bytes[q] === CONV_NODATA || c > bytes[q]) bytes[q] = c;
  });
  return { res: box.res, lat0: box.lat0, lon0: box.lon0, nlat, nlon, c: bytes.toString('base64') };
}
// Per decoded step: the grid of every map frame -> { atl, na, me }.
const convGridsOf = (f, t, sampleDeg) => { const out = {}; Object.keys(CONV_FRAMES).forEach(a => { out[a] = convGridOf(f, CONV_FRAMES[a], t, sampleDeg); }); return out; };
// Two grids of one shape (base64) -> the cell-wise higher class; "no data" gives way to any class.
function convMax(a, b) {
  if (!a) return b; if (!b) return a;
  const x = Buffer.from(a, 'base64'), y = Buffer.from(b, 'base64');
  if (x.length !== y.length) throw new Error('convMax: grids of different size');
  for (let k = 0; k < x.length; k++) if (x[k] === CONV_NODATA || (y[k] !== CONV_NODATA && y[k] > x[k])) x[k] = y[k];
  return x.toString('base64');
}
// items: [{ valid: ISO, grids: convGridsOf() }] -> the snapshot's convGrid: atl at the top level, areas.na/.me
// the same structure (as jetGrid). opts: { model, extra {}, outlookFrom: 'YYYY-MM-DD' (for lowConfidence), t }.
function convDays(items, opts) {
  opts = opts || {};
  const t = opts.t || THRESHOLDS;
  const one = frame => {
    const byDate = {};
    (items || []).filter(x => x && x.grids && x.grids[frame]).sort((a, b) => a.valid.localeCompare(b.valid))
      .forEach(x => { const d = x.valid.slice(0, 10); (byDate[d] || (byDate[d] = [])).push(x); });
    const dates = Object.keys(byDate).sort();
    if (!dates.length) return null;
    const g0 = byDate[dates[0]][0].grids[frame];
    const lowFrom = opts.outlookFrom ? U.addDays(opts.outlookFrom, CONV_LOW_CONF_DAY - 1) : null;
    return Object.assign({ model: opts.model || null }, opts.extra || {}, {
      res: g0.res, lat0: g0.lat0, lon0: g0.lon0, nlat: g0.nlat, nlon: g0.nlon, encoding: 'base64-uint8',
      layout: 'grid points lat0+j*res, lon0+i*res; row-major south→north, west→east; one byte per cell = class of the strongest 1° source point with lat, lon in [c − res/2, c + res/2)',
      classes: CONV_CLASSES, thresholds: { capeJkg: t.capeJkg, precipMmH: t.convPrecipMmH }, label: opts.label || LABEL,
      days: dates.map(d => {
        const xs = byDate[d], c = xs.reduce((acc, x) => convMax(acc, x.grids[frame].c), null), b = Buffer.from(c, 'base64');
        let potential = 0, likely = 0; for (const v of b) { if (v === 1) potential++; else if (v === 2) likely++; }
        const day = { date: d, valid: validShort(xs[0].valid), hours: xs.map(x => +x.valid.slice(11, 13)), c, potential, likely };
        if (lowFrom && d >= lowFrom) day.lowConfidence = true;
        return day;
      }) });
  };
  const top = one('atl');
  if (!top) return null;
  const areas = {};
  Object.keys(CONV_FRAMES).filter(a => a !== 'atl').forEach(a => { const x = one(a); if (x) areas[a] = x; });
  if (Object.keys(areas).length) top.areas = areas;
  return top;
}

// One step's reduction: everything later stages need, no grids.
function reduceStep(f, hubs) {
  const h = {};
  (hubs || HUBS).forEach(x => { h[x.code] = hubStep(f, x); });
  return { nat: natStep(f), europe: convStep(f, REGIONS.europe, null, AREAS.europe), us: convStep(f, REGIONS.us, null, AREAS.us), hubs: h };
}

// The steps' reductions folded into days of the outlook. `steps`: [{ step, valid (ISO), r: reduceStep() }].
function aggregateDays(steps, outlook, hubs, t) {
  t = t || THRESHOLDS; hubs = hubs || HUBS;
  const dates = [];
  for (let d = outlook.from; d <= outlook.to; d = U.addDays(d, 1)) dates.push(d);
  const byDate = {}; dates.forEach(d => { byDate[d] = []; });
  steps.forEach(s => { const d = s.valid.slice(0, 10); if (byDate[d]) byDate[d].push(s); });
  const nat = [], conv = { europe: [], us: [] };
  const hubDays = {}; hubs.forEach(h => { hubDays[h.code] = []; });
  dates.forEach(date => {
    const ss = byDate[date];
    if (!ss.length) return;
    const ns = ss.map(s => s.r.nat).filter(Boolean);
    if (ns.length) {
      const top = ns.reduce((a, b) => (b.jetKt > a.jetKt ? b : a));
      const w = ns.filter(x => x.westerlyKt != null);
      nat.push({ date, jetMaxKt: top.jetKt, lat: top.lat, lon: top.lon,
                 westerly50NKt: w.length ? Math.round(w.reduce((a, b) => a + b.westerlyKt, 0) / w.length) : null, steps: ns.length });
    }
    ['europe', 'us'].forEach(rk => {
      const cs = ss.map(s => s.r[rk]).filter(Boolean);
      if (!cs.length) return;
      const top = cs.reduce((a, b) => (b.sharePct > a.sharePct ? b : a));
      const capeTop = cs.reduce((a, b) => (b.capeMax > a.capeMax ? b : a));
      // Where: the named areas holding at least a fifth of the busiest step's convective points.
      const ba = top.byArea || {}, where = Object.keys(ba).filter(a => ba[a] >= Math.max(2, top.hits / 5)).sort((a, b) => ba[b] - ba[a]).slice(0, 3);
      conv[rk].push({ date, level: levelFor(top.sharePct, t), sharePct: top.sharePct, where, capeMax: capeTop.capeMax,
                      capeLat: capeTop.capeLat, capeLon: capeTop.capeLon, steps: cs.length });
    });
    hubs.forEach(h => {
      const xs = ss.map(s => s.r.hubs && s.r.hubs[h.code]).filter(Boolean);
      if (!xs.length) return;
      const gusts = xs.map(x => x.gustKt).filter(x => x != null), viss = xs.map(x => x.visM).filter(x => x != null);
      const day = { date, gustMaxKt: gusts.length ? Math.max(...gusts) : null, snow: xs.some(x => x.snow), visMinM: viss.length ? Math.min(...viss) : null, flags: [] };
      const txs = xs.map(x => x.tmaxC).filter(x => x != null);
      if (txs.length) day.tmaxC = Math.max(...txs);
      if (day.gustMaxKt != null && day.gustMaxKt > t.gustKt) day.flags.push('gust ' + day.gustMaxKt + ' kt');
      if (day.snow) day.flags.push('snow');
      if (day.visMinM != null && day.visMinM < t.visM) day.flags.push('vis ' + day.visMinM + ' m');
      if (day.tmaxC != null && t.heatC != null && day.tmaxC >= t.heatC) day.flags.push('heat ' + day.tmaxC + ' °C');
      hubDays[h.code].push(day);
    });
  });
  return { nat, convective: conv,
           hubs: hubs.map(h => Object.assign({ code: h.code, name: h.name, region: h.region }, h.area ? { area: h.area } : {}, { lat: h.lat, lon: h.lon, days: hubDays[h.code] })) };
}

// Newest cycle first that is at least GFS_LAG_H old, then the one before it.
function candidateCycles(nowIso, lagH) {
  const now = new Date(nowIso || Date.now()).getTime() - (lagH == null ? GFS_LAG_H : lagH) * 3600000;
  const c0 = Math.floor(now / (6 * 3600000)) * 6 * 3600000;
  return [c0, c0 - 6 * 3600000].map(ms => { const d = new Date(ms); const iso = d.toISOString();
    return { iso, date: iso.slice(0, 10).replace(/-/g, ''), hh: iso.slice(11, 13) }; });
}
// withLevels: also the flight-level fields (LEVEL_VARS × LEVEL_LEVS), for the steps levelSteps() names.
function gfsUrl(cycle, step, withLevels) {
  const q = ['dir=' + encodeURIComponent('/gfs.' + cycle.date + '/' + cycle.hh + '/atmos'),
             'file=gfs.t' + cycle.hh + 'z.pgrb2.1p00.f' + String(step).padStart(3, '0')]
    .concat(GFS_VARS.concat(withLevels ? LEVEL_VARS : []).map(v => 'var_' + v + '=on'),
            (withLevels ? LEVEL_LEVS : []).concat(GFS_LEVELS).map(l => 'lev_' + l + '=on'),
            ['subregion=', 'toplat=' + GFS_BOX.top, 'leftlon=' + GFS_BOX.left, 'rightlon=' + GFS_BOX.right, 'bottomlat=' + GFS_BOX.bottom]);
  return NOMADS + '?' + q.join('&');
}
const isGrib = b => Buffer.isBuffer(b) && b.length > 16 && b.toString('latin1', 0, 4) === 'GRIB';

// ---- ECMWF planning and reducers (pure) --------------------------------------------------------
// 00Z and 12Z only: the 06Z/18Z open-data runs stop at 90 h.
function ecmwfCycles(nowIso, lagH) {
  const now = new Date(nowIso || Date.now()).getTime() - (lagH == null ? ECMWF_LAG_H : lagH) * 3600000;
  const c0 = Math.floor(now / (12 * 3600000)) * 12 * 3600000;
  return [c0, c0 - 12 * 3600000].map(ms => { const iso = new Date(ms).toISOString();
    return { iso, date: iso.slice(0, 10).replace(/-/g, ''), hh: iso.slice(11, 13) }; });
}
const ecmwfStepOk = s => s >= 0 && s <= 240 && (s <= 144 ? s % 3 === 0 : s % 6 === 0);   // 3-hourly to 144 h, 6-hourly to 240 h
function ecmwfUrl(cycle, step, ext) {
  const base = ECMWF + '/' + cycle.date + '/' + cycle.hh + 'z/ifs/0p25/', stamp = cycle.date + cycle.hh + '0000';
  return step === 'ep' ? base + 'enfo/' + stamp + '-240h-enfo-ep.' + ext : base + 'oper/' + stamp + '-' + step + 'h-oper-fc.' + ext;
}
// What one cycle has to deliver for the outlook: jet steps at the GFS valid hours, one convective
// step a day, and the ENS 24-hour windows that start at 00 UTC of each outlook day.
function ecmwfPlan(cycle, outlook, jetHours, convHour) {
  const c = new Date(cycle.iso).getTime(), jet = [], conv = [], ens = [];
  for (let d = outlook.from; d <= outlook.to; d = U.addDays(d, 1)) {
    const d0 = new Date(d + 'T00:00:00Z').getTime(), stepAt = h => (d0 + h * 3600000 - c) / 3600000;
    jetHours.forEach(h => { const s = stepAt(h); if (ecmwfStepOk(s)) jet.push({ step: s, valid: new Date(d0 + h * 3600000).toISOString() }); });
    const sc = stepAt(convHour); if (ecmwfStepOk(sc)) conv.push({ step: sc, valid: new Date(d0 + convHour * 3600000).toISOString() });
    const s0 = stepAt(0); if (s0 >= 0 && s0 % 12 === 0 && s0 + 24 <= 240) ens.push({ date: d, range: s0 + '-' + (s0 + 24) });
  }
  return { jet, conv, ens };
}
const parseIndex = text => String(text).split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
const pickIndex = (entries, want) => entries.find(e => Object.keys(want).every(k => String(e[k]) === String(want[k]))) || null;
const rangeOf = e => 'bytes=' + e._offset + '-' + (e._offset + e._length - 1);

// Hub probabilities: { date: { key: { code: pct } } } -> [{ code, days: [{ date, gust15Pct, gust25Pct, tp20Pct }] }]
function hubProbTable(byDate, dates, hubs) {
  return (hubs || HUBS).map(h => ({ code: h.code, days: dates.map(date => {
    const r = { date };
    ECMWF_ENS.forEach(([, key]) => { const v = byDate[date] && byDate[date][key] ? byDate[date][key][h.code] : undefined; r[key] = v == null ? null : v; });
    return r; }) }));
}
function hubProbs(field, hubs) {
  const out = {};
  (hubs || HUBS).forEach(h => { const v = valueAt(field, h.lat, h.lon); out[h.code] = v == null ? null : Math.round(v); });
  return out;
}

// GFS against ECMWF, day by day: the strongest jet and the mean westerly at 50N.
function compareModels(gNat, eNat, agree) {
  agree = agree || AGREE;
  const e = {}; (eNat || []).forEach(d => { e[d.date] = d; });
  return (gNat || []).filter(d => e[d.date]).map(g => {
    const x = e[g.date], diff = x.jetMaxKt - g.jetMaxKt;
    const wdiff = x.westerly50NKt != null && g.westerly50NKt != null ? x.westerly50NKt - g.westerly50NKt : null;
    return { date: g.date, jetGfs: g.jetMaxKt, jetEcmwf: x.jetMaxKt, diffKt: diff, westerlyGfs: g.westerly50NKt, westerlyEcmwf: x.westerly50NKt,
             westerlyDiffKt: wdiff, agree: Math.abs(diff) <= agree.jetKt && (wdiff == null || Math.abs(wdiff) <= agree.westerlyKt) };
  });
}

// ---- NHC / CPHC -------------------------------------------------------------------------------
const NHC_BASIN = { al: 'Atlantic', ep: 'East Pacific', cp: 'Central Pacific' };
const NHC_CLASS = { TD: 'Tropical Depression', STD: 'Subtropical Depression', TS: 'Tropical Storm', STS: 'Subtropical Storm', HU: 'Hurricane',
  MH: 'Major Hurricane', PTC: 'Potential Tropical Cyclone', PC: 'Post-tropical Cyclone', TY: 'Typhoon', STY: 'Super Typhoon' };
const num = x => (x == null || x === '' || isNaN(+x)) ? null : +x;

function parseNhcStorms(json) {
  return ((json && json.activeStorms) || []).map(s => {
    const mph = num(s.movementSpeed);
    return { id: s.id, basin: NHC_BASIN[String(s.id || '').slice(0, 2)] || null, name: s.name, type: NHC_CLASS[s.classification] || s.classification,
      windKt: num(s.intensity), pressureMb: num(s.pressure), lat: num(s.latitudeNumeric), lon: num(s.longitudeNumeric),
      movementDir: num(s.movementDir), movementKt: mph == null ? null : Math.round(mph / 1.15078),   // NHC JSON gives mph
      updated: s.lastUpdate || null, advisoryUrl: (s.publicAdvisory && s.publicAdvisory.url) || null,
      forecastUrl: (s.forecastAdvisory && s.forecastAdvisory.url) || null };
  });
}

function rssItemText(xml) {
  const item = /<item>([\s\S]*?)<\/item>/.exec(xml);
  if (!item) return null;
  const d = /<description>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/description>/.exec(item[1]);
  const pub = /<pubDate>([^<]+)<\/pubDate>/.exec(item[1]);
  const link = /<link>([^<]+)<\/link>/.exec(item[1]);
  const text = d ? unhtml(d[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\r/g, '') : '';
  const iso = pub && !isNaN(new Date(pub[1])) ? new Date(pub[1]).toISOString() : null;
  return { text, issued: iso, link: link ? link[1].trim() : null };
}

// The Tropical Weather Outlook: areas with 48-hour and 7-day formation chances.
function parseTwo(xml, basin) {
  const it = rssItemText(xml);
  if (!it || !/Tropical Weather Outlook/i.test(it.text)) throw new Error('no Tropical Weather Outlook in the feed');
  const paras = it.text.split(/\n[ \t]*\n/).map(p => p.trim()).filter(Boolean);
  const areas = [];
  paras.forEach(p => {
    const c48 = /Formation chance through 48 hours\.*\s*(\w+)\.*\s*(\d+|near 0) percent/i.exec(p);
    const c7 = /Formation chance through 7 days\.*\s*(\w+)\.*\s*(\d+|near 0) percent/i.exec(p);
    if (!c48 && !c7) return;
    const lines = p.split('\n').map(l => l.trim());
    let title = lines[0].replace(/^\d+\.\s*/, '');
    let body = lines.slice(1).filter(l => !/^\*/.test(l)).join(' ');
    if (!/:$/.test(title)) { body = lines.filter(l => !/^\*/.test(l)).join(' '); title = clip(body.split(/\.\s/)[0], 90); }
    const pct = m => (m ? (/near 0/i.test(m[2]) ? 0 : +m[2]) : null);
    areas.push({ title: title.replace(/:$/, ''), chance48h: pct(c48), cat48h: c48 ? c48[1].toLowerCase() : null,
                 chance7d: pct(c7), cat7d: c7 ? c7[1].toLowerCase() : null, text: clip(body, 280) });
  });
  const active = paras.find(p => /^Active Systems:/i.test(p));
  return { basin, issued: it.issued, url: it.link, areas, active: active ? clip(active.replace(/^Active Systems:\s*/i, ''), 300) : null,
           none: !areas.length && /not expected|no tropical cyclones/i.test(it.text) };
}

// ---- JTWC ---------------------------------------------------------------------------------------
function parseJtwcRss(xml, refIso) {
  const systems = [], advisories = [];
  (xml.match(/<item>[\s\S]*?<\/item>/g) || []).forEach(item => {
    const title = unhtml(((/<title>([\s\S]*?)<\/title>/.exec(item) || [])[1] || '').trim());
    const desc = ((/<description>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/description>/.exec(item) || [])[1] || '');
    const region = title.replace(/^Current\s+/i, '').replace(/\s*Tropical Systems$/i, '').replace(/\*/g, '').trim();
    if (/Significant Tropical Weather Advisories/i.test(title)) {
      (desc.match(/<a[^>]+href=["']([^"']+web\.txt)["'][^>]*>([^<]+)<\/a>[\s\S]*?Issued at\s*(\d{2})\/(\d{2})(\d{2})Z/g) || []).forEach(chunk => {
        const m = /href=["']([^"']+)["'][^>]*>([^<]+)<\/a>[\s\S]*?Issued at\s*(\d{2})\/(\d{2})(\d{2})Z/.exec(chunk);
        advisories.push({ name: m[2].trim(), url: m[1], issued: stampToIso(m[3], m[4], m[5], refIso) });
      });
      return;
    }
    desc.split(/<p>/i).forEach(chunk => {
      const m = /<b>\s*([A-Za-z][A-Za-z -]*?)\s+(\d{1,2}[A-Z])\s*(?:\(([^)]*)\))?\s*Warning\s*#\s*(\d+)/.exec(chunk);
      if (!m) return;
      const iss = /Issued at\s*(\d{2})\/(\d{2})(\d{2})Z/.exec(chunk);
      const w = /href=['"]([^'"]+web\.txt)['"]/.exec(chunk);
      systems.push({ region, type: m[1].replace(/\s+/g, ' ').trim(), id: m[2], name: (m[3] || '').trim() || null, warning: +m[4],
                     issued: iss ? stampToIso(iss[1], iss[2], iss[3], refIso) : null, warningUrl: w ? w[1] : null });
    });
  });
  return { systems, advisories };
}

const ll = (a, b) => { const lat = parseFloat(a) * (/S$/i.test(a) ? -1 : 1), lon = parseFloat(b) * (/W$/i.test(b) ? -1 : 1); return [lat, lon]; };
function parseJtwcWarning(text) {
  const t = String(text).replace(/\r/g, '');
  const p = /WARNING POSITION:\s*\n?\s*(\d{6})Z\s*-+\s*NEAR\s+([\d.]+[NS])\s+([\d.]+[EW])/.exec(t);
  const mv = /MOVEMENT PAST SIX HOURS\s*-\s*(\d+)\s*DEGREES AT\s*(\d+)\s*KTS/.exec(t);
  const w = /MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT,\s*GUSTS\s*(\d+)\s*KT/.exec(t);
  const pr = /MINIMUM CENTRAL PRESSURE AT \d{6}Z IS\s*(\d+)\s*MB/.exec(t);
  const loc = /LOCATED APPROXIMATELY\s+([\s\S]+?),\s*HAS/.exec(t);
  const forecast = [];
  const re = /(\d+)\s*HRS,\s*VALID AT:\s*\n\s*(\d{6})Z\s*-+\s*([\d.]+[NS])\s+([\d.]+[EW])([\s\S]*?)(?=\n\s*-{3}|\nREMARKS:|$)/g;
  let f;
  while ((f = re.exec(t))) {
    const kt = /MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT/.exec(f[5]);
    const note = /(BECOMING EXTRATROPICAL|EXTRATROPICAL|DISSIPAT[A-Z ]+?(?:OVER (?:WATER|LAND))|DISSIPATED|OVER LAND)/.exec(f[5]);
    const [lat, lon] = ll(f[3], f[4]);
    forecast.push({ h: +f[1], lat, lon, windKt: kt ? +kt[1] : null, note: note ? note[1].toLowerCase() : null });
  }
  const [lat, lon] = p ? ll(p[2], p[3]) : [null, null];
  return { lat, lon, windKt: w ? +w[1] : null, gustKt: w ? +w[2] : null, pressureMb: pr ? +pr[1] : null,
           movementDir: mv ? +mv[1] : null, movementKt: mv ? +mv[2] : null,
           location: loc ? clip(loc[1].toLowerCase(), 120) : null, forecast: forecast.slice(0, 10) };
}

// ---- SPC ------------------------------------------------------------------------------------------
const SPC_CAT = { 2: 'TSTM', 3: 'MRGL', 4: 'SLGT', 5: 'ENH', 6: 'MDT', 8: 'HIGH' };
function rings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'GeometryCollection') return (geom.geometries || []).reduce((a, g) => a.concat(rings(g)), []);
  return [];
}
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolys = (polys, lat, lon) => polys.some(poly => poly.length && inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h)));
function ringKm2(ring) {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((a, c) => a + c[1], 0) / ring.length, kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  return Math.abs(s) / 2;
}
const polysKm2 = polys => polys.reduce((a, poly) => a + (poly.length ? ringKm2(poly[0]) - poly.slice(1).reduce((b, h) => b + ringKm2(h), 0) : 0), 0);
function bboxOf(polys) {
  let s = 90, n = -90, w = 180, e = -180;
  polys.forEach(poly => (poly[0] || []).forEach(([x, y]) => { s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); }));
  return s > n ? null : [round1(s), round1(w), round1(n), round1(e)];
}
const hubsIn = (polys, hubs) => (hubs || HUBS).filter(h => h.region === 'us' && inPolys(polys, h.lat, h.lon)).map(h => h.code);

// The drawn areas as map polygons: rings of [lat, lon] (GeoJSON order is [lon, lat]) rounded to 0.1°, not
// closed (the last point joins the first), simplified with Douglas–Peucker. Outer rings and holes are plain
// rings: draw them with the even-odd fill rule. One tolerance per day, doubled from 0.05° until the day's
// rings (all its features together) hold at most SPC_POLY_MAX points; a ring that shrinks below 3 points
// (smaller than about 0.1°) is dropped.
const SPC_POLY_MAX = 300;
function dpKeep(pts, tol) {          // open polyline [[x, y]] -> the points Douglas–Peucker keeps
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    let best = -1, at = -1;
    for (let k = a + 1; k < b; k++) {
      const [x, y] = pts[k];
      const d = L ? Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / L : Math.hypot(x - x1, y - y1);
      if (d > best) { best = d; at = k; }
    }
    if (best > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((p, k) => keep[k]);
}
// One GeoJSON ring -> [[lat, lon]] (simplified, rounded, no repeated points), [] when it collapses.
function simplifyRing(ring, tol) {
  let pts = (ring || []).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
  if (pts.length > 3) {                 // a closed ring: split at the point farthest from the first, simplify both halves
    let far = 1, fd = -1;
    pts.forEach((p, k) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = k; } });
    const a = dpKeep(pts.slice(0, far + 1), tol), b = dpKeep(pts.slice(far).concat([pts[0]]), tol);
    pts = a.concat(b.slice(1, -1));
  }
  const out = [];
  pts.forEach(([lon, lat]) => { const q = [round1(lat), round1(lon)], l = out[out.length - 1]; if (!l || l[0] !== q[0] || l[1] !== q[1]) out.push(q); });
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out.length >= 3 ? out : [];
}
// features: [{ dn, label, polys: rings() }] -> the same with `poly` (rings) under one shared point budget.
function spcPolys(features, maxPoints) {
  maxPoints = maxPoints || SPC_POLY_MAX;
  let out = [];
  for (let tol = 0.05; tol <= 6.4; tol *= 2) {
    out = features.map(f => ({ dn: f.dn, label: f.label, poly: f.polys.reduce((a, poly) => a.concat(poly.map(r => simplifyRing(r, tol))), []).filter(r => r.length) }));
    if (out.reduce((a, f) => a + f.poly.reduce((b, r) => b + r.length, 0), 0) <= maxPoints) break;
  }
  return out;
}
// The fields a parsed SPC day gains for the map: poly (the area bbox describes) and, when SPC drew more than one
// level that day, lower [{ dn, label, poly }] (the lower categories / probabilities, ascending). drawn: the features.
function spcMapFields(drawn, top, labelOf) {
  const feats = drawn.slice().sort((a, b) => a.properties.DN - b.properties.DN).map(f => ({ dn: f.properties.DN, label: labelOf(f), polys: rings(f.geometry) }));
  const p = spcPolys(feats), topIdx = feats.findIndex(f => f.dn === top.properties.DN);
  const out = { poly: p[topIdx].poly };
  const lower = p.filter((x, k) => k !== topIdx && x.poly.length);
  if (lower.length) out.lower = lower;
  return out;
}

// Day 1–3 categorical: the highest category drawn, where, and which listed US hubs it covers.
function parseSpcCat(geo, day, hubs) {
  const feats = (geo && geo.features) || [];
  const p0 = (feats[0] || {}).properties || {};
  const base = { day, issued: p0.ISSUE_ISO || null, valid: p0.VALID_ISO || null, expire: p0.EXPIRE_ISO || null };
  const drawn = feats.filter(f => rings(f.geometry).length && (f.properties || {}).DN >= 2);
  if (!drawn.length) return Object.assign(base, { max: null, maxName: 'no thunderstorm areas', areaKm2: 0, bbox: null, hubs: [] });
  const top = drawn.reduce((a, b) => (b.properties.DN > a.properties.DN ? b : a));
  const polys = rings(top.geometry);
  return Object.assign(base, { max: top.properties.LABEL || SPC_CAT[top.properties.DN] || null, maxName: top.properties.LABEL2 || null,
    dn: top.properties.DN, areaKm2: Math.round(polysKm2(polys) / 1000) * 1000, bbox: bboxOf(polys), hubs: hubsIn(polys, hubs) },
    spcMapFields(drawn, top, f => f.properties.LABEL || SPC_CAT[f.properties.DN] || String(f.properties.DN)));
}

// Day 4–8: a 15 % or 30 % area, or SPC's own label ("Potential Too Low", "Predictability Too Low").
function parseSpcProb(geo, day, hubs) {
  const feats = (geo && geo.features) || [];
  const p0 = (feats[0] || {}).properties || {};
  const base = { day, issued: p0.ISSUE_ISO || null, valid: p0.VALID_ISO || null, expire: p0.EXPIRE_ISO || null };
  const drawn = feats.filter(f => rings(f.geometry).length && (f.properties || {}).DN > 0);
  if (!drawn.length) return Object.assign(base, { probPct: null, label: p0.LABEL || 'no area', areaKm2: 0, bbox: null, hubs: [] });
  const top = drawn.reduce((a, b) => (b.properties.DN > a.properties.DN ? b : a));
  const polys = rings(top.geometry);
  return Object.assign(base, { probPct: top.properties.DN, label: top.properties.LABEL || (top.properties.DN + '%'),
    areaKm2: Math.round(polysKm2(polys) / 1000) * 1000, bbox: bboxOf(polys), hubs: hubsIn(polys, hubs) },
    spcMapFields(drawn, top, f => f.properties.LABEL || (f.properties.DN + '%')));
}

function parseAcus48(text, refIso) {
  const t = String(text).replace(/\r/g, '');
  const h = /ACUS48 KWNS (\d{2})(\d{2})(\d{2})/.exec(t);
  const v = /Valid\s+(\d{6}Z\s*-\s*\d{6}Z)/.exec(t);
  // The first sentence of each paragraph of the discussion: SPC writes one paragraph per period.
  const d = /\.\.\.DISCUSSION\.\.\.\s*([\s\S]*?)(?:\n\s*\.\.[A-Za-z ]+\.\.|$)/.exec(t);
  const paras = d ? d[1].split(/\n\s*\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
  const firsts = paras.map(x => clip((x.match(/^[\s\S]*?\.(?=\s|$)/) || [x])[0], 220));
  return { issued: h ? stampToIso(h[1], h[2], h[3], refIso) : null, valid: v ? v[1].replace(/\s+/g, ' ') : null, summary: clip(firsts.join(' '), 480) };
}

// ---- WPC / CPC (api.weather.gov product JSON) --------------------------------------------------
function parseWpcEpd(productText, issued) {
  const t = String(productText || '').replace(/\r/g, '');
  if (!/Extended Forecast Discussion/i.test(t)) throw new Error('not a WPC Extended Forecast Discussion');
  const v = /Valid\s+(12Z[^\n]+)/.exec(t);
  const head = t.split(/\.\.\.Guidance/i)[0];
  const headlines = [];
  const re = /\.\.\.([^.][\s\S]*?)\.\.\./g;
  let m;
  while ((m = re.exec(head))) { const s = m[1].replace(/\s+/g, ' ').trim(); if (s.length > 10 && !/Pattern Overview|Guidance/i.test(s)) headlines.push(s); }
  let summary = headlines.join(' · ');
  if (!summary) {
    const po = /\.\.\.Pattern Overview[^\n]*\.\.\.\s*([\s\S]*?)\n\s*\n/i.exec(t);
    summary = po ? po[1] : '';
  }
  return { issued: issued || null, valid: v ? v[1].trim() : null, headlines: headlines.slice(0, 6).map(s => clip(s, 200)), summary: clip(summary, 600) };
}

function parseCpcThr(productText, issued) {
  const t = String(productText || '').replace(/\r/g, '');
  if (!/US Hazards Outlook/i.test(t)) throw new Error('not a CPC US Hazards Outlook');
  const syn = /SYNOPSIS:\s*([\s\S]*?)\n\s*\n/.exec(t);
  const hz = /\nHAZARDS\s*\n([\s\S]*?)\n\s*DETAILED SUMMARY/.exec(t);
  const hazards = hz ? hz[1].split(/\n\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
  const kept = []; let len = 0;
  for (const h of hazards) { if (len + h.length > 600) break; kept.push(h); len += h.length + 3; }
  return { issued: issued || null, synopsis: syn ? clip(syn[1], 300) : null, hazards: kept, hazardsTotal: hazards.length };
}

function parseCpcMrd(productText, issued) {
  const t = String(productText || '').replace(/\r/g, '');
  if (!/6 to 10 and 8 to 14 day outlooks/i.test(t)) throw new Error('not a CPC 6-10/8-14 day discussion');
  const periods = [];
  [['6-10', '6-10 day'], ['8-14', '8-14 day']].forEach(([k, label]) => {
    const p = new RegExp(k + ' DAY OUTLOOK FOR ([A-Z]{3} \\d{1,2}\\s*-\\s*(?:[A-Z]{3} )?\\d{1,2} \\d{4})').exec(t);
    const c = new RegExp('FORECAST CONFIDENCE FOR THE ' + k + ' DAY PERIOD:\\s*([^,\\n]+(?:,\\s*\\d out of 5)?)').exec(t);
    if (p) periods.push({ period: label, dates: p[1].replace(/\s+/g, ' '), confidence: c ? c[1].trim() : null });
  });
  return { issued: issued || null, periods };
}

// ---- SWPC -------------------------------------------------------------------------------------
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function parseSwpc3day(text) {
  const t = String(text).replace(/\r/g, '');
  const is = /:Issued:\s*(\d{4}) (\w{3}) (\d{2}) (\d{2})(\d{2}) UTC/.exec(t);
  const issued = is ? new Date(Date.UTC(+is[1], MON[is[2]] - 1, +is[3], +is[4], +is[5])).toISOString() : null;
  const hdr = /NOAA Kp index breakdown\s+\w{3} \d{2}-\w{3} \d{2} (\d{4})\s*\n\s*\n\s*((?:\w{3} \d{2}\s*){3})\n/.exec(t);
  if (!hdr) throw new Error('no Kp breakdown table');
  const year = +hdr[1];
  const cols = hdr[2].trim().split(/\s{2,}/).map(s => s.trim());
  const lastMon = MON[cols[cols.length - 1].slice(0, 3)];
  const dates = cols.map(c => { const mo = MON[c.slice(0, 3)]; const y = mo > lastMon ? year - 1 : year;
    return y + '-' + String(mo).padStart(2, '0') + '-' + c.slice(4, 6); });
  const days = dates.map(date => ({ date, maxKp: null, g: null }));
  const after = t.slice(hdr.index + hdr[0].length);
  after.split('\n').filter(l => /^\d{2}-\d{2}UT/.test(l.trim())).slice(0, 8).forEach(l => {
    const cells = l.trim().replace(/^\d{2}-\d{2}UT\s*/, '').match(/[\d.]+(?:\s*\(G\d\))?/g) || [];
    cells.slice(0, days.length).forEach((c, i) => {
      const kp = parseFloat(c), g = /\((G\d)\)/.exec(c);
      if (days[i].maxKp == null || kp > days[i].maxKp) days[i].maxKp = kp;
      if (g && (!days[i].g || g[1] > days[i].g)) days[i].g = g[1];
    });
  });
  const rat = /A\. NOAA Geomagnetic[\s\S]*?Rationale:\s*([\s\S]*?)\n\s*\n/.exec(t);
  return { issued, days, rationale: rat ? clip(rat[1], 240) : null };
}

function parseSwpcScales(json) {
  if (!json || !json['0']) throw new Error('no current entry in noaa-scales.json');
  const sc = e => (e ? { R: 'R' + (e.R && e.R.Scale != null ? e.R.Scale : '?'), S: 'S' + (e.S && e.S.Scale != null ? e.S.Scale : '?'),
                          G: 'G' + (e.G && e.G.Scale != null ? e.G.Scale : '?') } : null);
  const c = json['0'];
  const observed = c.DateStamp && c.TimeStamp ? c.DateStamp + 'T' + c.TimeStamp + 'Z' : null;
  const forecast = ['1', '2', '3'].filter(k => json[k]).map(k => {
    const e = json[k];
    return { date: e.DateStamp, rMinorPct: num(e.R && e.R.MinorProb), rMajorPct: num(e.R && e.R.MajorProb), sPct: num(e.S && e.S.Prob),
             g: 'G' + (e.G && e.G.Scale != null ? e.G.Scale : '?') };
  });
  return { issued: observed, current: sc(c), yesterday: sc(json['-1']), forecast };
}

// ---- fetch ------------------------------------------------------------------------------------
// hubs (the public week-ahead relay, tools/wx-relay, passes []): the hub list every hub value is computed
// for — gfs.hubs, ecmwf.hubProb, spc.days[].hubs / spc.d48.days[].hubs. An empty list also skips the
// ECMWF ENS probability fields (they exist only to be sampled at the hubs; about 20 fewer requests) and
// leaves ecmwf.ens null. Absent = HUBS, unchanged.
async function fetchWxOutlook({ backfill, hubs }) {
  if (backfill) throw new Error('--backfill refused: a forecast issued in the past cannot be re-fetched honestly, and today\'s forecasts must not be filed under a past week');
  const t0 = Date.now(), nowIso = new Date().toISOString(), today = U.today();
  const outlook = { from: today, to: U.addDays(today, 6) };
  const sources = [], notes = [], hits = {}, bytes = {}, deadHosts = new Set();
  const late = () => (Date.now() - t0) / 1000 > SOFT_DEADLINE_S;
  // Every request goes through here: counted per host, refused past the deadline or once its host has timed out.
  async function req(url, fn) {
    const h = url.split('/')[2];
    if (deadHosts.has(h)) throw new Error('skipped — ' + h + ' did not answer earlier in this run');
    if (late()) throw new Error('skipped — time budget (' + SOFT_DEADLINE_S + ' s) used up');
    hits[h] = (hits[h] || 0) + 1;
    try { const r = await fn(); bytes[h] = (bytes[h] || 0) + ((r && r.length) || 0); return r; }
    catch (e) { if (/timeout/.test(String(e && e.message))) deadHosts.add(h); throw e; }
  }
  const out = { outlook, label: LABEL, thresholds: THRESHOLDS, pages: PAGES, sources, notes };

  async function run(key, name, url, fn) {
    const src = { key, name, url, ok: false, issued: null };
    sources.push(src);
    try { const r = await fn(); src.ok = true; src.issued = (r && r.issued) || null; return r; }
    catch (e) { src.error = clip(String((e && e.message) || e), 200); notes.push(name + ' unavailable — ' + src.error); return null; }
  }
  const text = url => req(url, async () => { const r = await U.getText(url, { timeoutMs: TEXT_TIMEOUT_MS }); await U.sleep(TEXT_PAUSE_MS); return r; });
  const json = async url => JSON.parse(await req(url, async () => { const r = await U.getText(url, { accept: 'application/json', timeoutMs: TEXT_TIMEOUT_MS }); await U.sleep(TEXT_PAUSE_MS); return r; }));
  const bin = url => req(url, async () => { try { return await getBuffer(url, { timeoutMs: NOMADS_TIMEOUT_MS }); } finally { await U.sleep(NOMADS_PAUSE_MS); } });

  // GFS: newest complete cycle, then the steps one by one.
  async function gfsChain() {
    out.gfs = await run('gfs', 'NOAA GFS 1° (NOMADS grib filter)', NOMADS, async () => {
      const cands = candidateCycles(nowIso);
      let cycle = null, last = null; const tried = [];
      for (const c of cands) {
        try { const b = await bin(gfsUrl(c, 168, levelSteps(c, GFS_STEPS, outlook).includes(168))); if (isGrib(b)) { cycle = c; last = b; break; } tried.push(c.iso + ': no GRIB in the answer'); }
        catch (e) { tried.push(c.iso.slice(0, 13) + 'Z: ' + String(e.message || e).replace(/^.*: /, '')); }
      }
      if (!cycle) throw new Error('no complete cycle (' + tried.join('; ') + ')');
      if (cycle !== cands[0]) notes.push('GFS: fell back to the ' + cycle.iso.slice(0, 13) + 'Z cycle (' + tried.join('; ') + ')');
      const steps = [], missing = [], lvSteps = levelSteps(cycle, GFS_STEPS, outlook);
      for (const step of GFS_STEPS) {
        try {
          const lv = lvSteps.includes(step);
          const b = step === 168 ? last : await bin(gfsUrl(cycle, step, lv));
          if (!isGrib(b)) throw new Error('no GRIB in the answer');
          const f = pickFields(decodeGrib2(b));
          const valid = new Date(new Date(cycle.iso).getTime() + step * 3600000).toISOString();
          steps.push({ step, valid, r: reduceStep(f, hubs), grids: jetGridsOf(f), levels: lv ? levelGridsOf(f) : null, areas: areaGridsOf(f, lv), conv: convGridsOf(f) });
        } catch (e) { missing.push('f' + step + ' (' + clip(String(e.message || e).replace(/^.*: /, ''), 60) + ')'); }
      }
      if (steps.length < GFS_STEPS.length / 2) throw new Error('only ' + steps.length + ' of ' + GFS_STEPS.length + ' steps read: ' + missing.join(', '));
      if (missing.length) notes.push('GFS: steps missing — ' + missing.join(', '));
      // The jet map grid of each outlook day (earliest step of the date), from the fields already decoded.
      const inOutlook = steps.filter(s => U.inRange(s.valid.slice(0, 10), outlook.from, outlook.to));
      const jetGrid = jetLevels(inOutlook, 'GFS forecast', { cycle: cycle.iso });
      // The flight-level grids of the same days and hours (the level steps are the jet map's steps).
      const levels = levelDays(inOutlook.filter(s => s.levels).map(s => ({ valid: s.valid, grids: s.levels })), 'GFS 1.0° forecast', { run: cycle.iso.slice(0, 13) + 'Z' });
      if (levels) notes.push(LEVEL_NOTE);
      else if (lvSteps.length) notes.push('GFS: no flight-level grid (tropopause, max wind, freezing level) in the answers');
      // The North America and Middle East frames: the same steps, cut from the same answers (no request).
      const aj = jetGrid && areaJetLevels(inOutlook, 'GFS forecast', { cycle: cycle.iso });
      if (aj) jetGrid.areas = aj;
      const al = levels && areaLevelDays(inOutlook.filter(s => s.levels), 'GFS 1.0° forecast', { run: cycle.iso.slice(0, 13) + 'Z' });
      if (al) levels.areas = al;
      // Convective potential per 2° cell and outlook day, all frames, from the same steps (CAPE / CPRAT were always in the answer).
      const convGrid = convDays(inOutlook.filter(s => s.conv).map(s => ({ valid: s.valid, grids: s.conv })),
        { model: 'GFS forecast', extra: { cycle: cycle.iso, fields: 'CAPE (surface-based) and convective precipitation rate (6 h mean before the step)' }, outlookFrom: outlook.from });
      return Object.assign({ issued: cycle.iso, cycle: cycle.iso, model: 'NOAA GFS 0.25° output on the 1° grid (pgrb2.1p00)', label: LABEL,
                             regions: REGIONS, areas: AREAS, westerly: WESTERLY, stepsRead: steps.map(s => s.step), stepsMissing: missing },
                           aggregateDays(steps, outlook, hubs), { jetGrid, levels, convGrid });
    });
  }

  async function textChain() {
    const storms = await run('nhc-storms', 'NHC active storms (CurrentStorms.json)', URLS.nhcStorms, async () =>
      { const st = parseNhcStorms(await json(URLS.nhcStorms)); const u = st.map(x => x.updated).filter(Boolean).sort();
        return { issued: u.length ? new Date(u[u.length - 1]).toISOString() : null, storms: st }; });
    const twos = [];
    for (const b of ['AT', 'EP', 'CP']) {
      const r = await run('nhc-two-' + b.toLowerCase(), (b === 'CP' ? 'CPHC' : 'NHC') + ' Tropical Weather Outlook ' + b, URLS.two(b),
        async () => parseTwo(await text(URLS.two(b)), b === 'AT' ? 'Atlantic' : b === 'EP' ? 'East Pacific' : 'Central Pacific'));
      if (r) twos.push(r);
    }
    out.nhc = { storms: storms ? storms.storms : [], outlooks: twos };
    out.jtwc = await run('jtwc', 'JTWC tropical cyclone warnings (RSS)', URLS.jtwc, async () => {
      const r = parseJtwcRss(await text(URLS.jtwc), nowIso);
      // NHC covers its own basins; JTWC adds the West Pacific, Indian Ocean and Southern Hemisphere.
      const nhcNames = new Set((out.nhc.storms || []).map(s => String(s.name || '').toUpperCase()));
      r.systems = r.systems.filter(s => !(s.name && nhcNames.has(s.name.toUpperCase()) && /Eastern Pacific|Central/i.test(s.region)));
      for (const s of r.systems.slice(0, 4)) {
        if (!s.warningUrl) continue;
        try { Object.assign(s, parseJtwcWarning(await text(s.warningUrl))); }
        catch (e) { notes.push('JTWC warning text for ' + s.id + ' unreadable — ' + clip(String(e.message || e), 100)); }
      }
      const times = r.systems.map(s => s.issued).filter(Boolean).sort();
      return Object.assign({ issued: times.length ? times[times.length - 1] : null }, r);
    });
    const spc = { days: [], d48: null };
    for (const d of [1, 2, 3]) {
      const r = await run('spc-d' + d, 'SPC Day ' + d + ' convective outlook (categorical)', URLS.spcCat(d), async () => parseSpcCat(await json(URLS.spcCat(d)), d, hubs));
      if (r) spc.days.push(r);
    }
    spc.d48 = await run('spc-d48', 'SPC Day 4–8 convective outlook', URLS.spcProb(4), async () => {
      const days = [];
      for (const d of [4, 5, 6, 7, 8]) days.push(parseSpcProb(await json(URLS.spcProb(d)), d, hubs));
      let txt = null;
      try { const page = await text(URLS.acus48), pre = page.match(/<pre>([\s\S]*?)<\/pre>/i); txt = parseAcus48(pre ? pre[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : page, nowIso); } catch (e) { notes.push('SPC Day 4–8 text unavailable — ' + clip(String(e.message || e), 100)); }
      return { issued: (days[0] && days[0].issued) || (txt && txt.issued) || null, valid: txt && txt.valid, summary: txt && txt.summary, textUrl: URLS.acus48, days };
    });
    out.spc = spc;
    const pmd = async loc => { const j = await json(URLS.pmd(loc)); return { t: j.productText, issued: j.issuanceTime ? new Date(j.issuanceTime).toISOString() : null }; };
    out.wpc = await run('wpc-epd', 'WPC Extended Forecast Discussion', URLS.pmd('EPD'), async () => { const p = await pmd('EPD'); return parseWpcEpd(p.t, p.issued); });
    out.cpc = {
      thr: await run('cpc-thr', 'CPC US Hazards Outlook (days 8–14)', URLS.pmd('THR'), async () => { const p = await pmd('THR'); return parseCpcThr(p.t, p.issued); }),
      mrd: await run('cpc-mrd', 'CPC 6–10 / 8–14 day outlook discussion', URLS.pmd('MRD'), async () => { const p = await pmd('MRD'); return parseCpcMrd(p.t, p.issued); }),
    };
    out.swpc = {
      threeDay: await run('swpc-3day', 'SWPC 3-day forecast', URLS.swpc3day, async () => parseSwpc3day(await text(URLS.swpc3day))),
      scales: await run('swpc-scales', 'SWPC NOAA scales', URLS.swpcScales, async () => parseSwpcScales(await json(URLS.swpcScales))),
    };
  }

  // ECMWF: the HRES jet first (the comparison with GFS), then the ENS probabilities, then HRES
  // convection — so a slow portal costs the least useful part. Each is its own source.
  async function ecmwfChain() {
    const shortErr = e => clip(String((e && e.message) || e).replace(/^.*: /, ''), 80);
    const is404 = e => /HTTP 404/.test(String(e && e.message));
    const ecText = url => req(url, () => U.getText(url, { timeoutMs: TEXT_TIMEOUT_MS }));
    const ecRange = (url, e) => req(url, () => getRange(url, e._offset, e._length, { timeoutMs: ECMWF_TIMEOUT_MS }));
    const jetHours = (h => [h % 12, h % 12 + 12])(+candidateCycles(nowIso)[0].hh);   // the hours the GFS steps fall on
    const cands = ecmwfCycles(nowIso), idx = {};
    const index = (cycle, step) => { const k = cycle.iso + '|' + step; return idx[k] || (idx[k] = ecText(ecmwfUrl(cycle, step, 'index')).then(parseIndex)); };
    async function pickCycle(lastOf, prefer) {
      const tried = [];
      for (const c of (prefer ? [prefer] : []).concat(cands.filter(x => !prefer || x.iso !== prefer.iso))) {
        const plan = ecmwfPlan(c, outlook, jetHours, ECMWF_CONV_HOUR), last = lastOf(plan);
        if (last == null) { tried.push(c.iso.slice(0, 13) + 'Z: nothing in the outlook'); continue; }
        try { await index(c, last); return { cycle: c, plan, tried }; }
        catch (e) { if (!is404(e)) throw e; tried.push(c.iso.slice(0, 13) + 'Z: not yet published'); }
      }
      throw new Error('no complete cycle (' + tried.join('; ') + ')');
    }
    async function oper(cycle, step, wants) {
      const entries = await index(cycle, step), f = {};
      for (const key of Object.keys(wants)) {
        const e = pickIndex(entries, wants[key]);
        if (!e) throw new Error(wants[key].param + ' not in the ' + step + 'h index');
        f[key] = decodeGrib2(await ecRange(ecmwfUrl(cycle, step, 'grib2'), e))[0];
      }
      return f;
    }
    async function hresSteps(cycle, list, wants, reduce) {
      const steps = [], missing = [];
      await pool(list, ECMWF_PARALLEL, async s => {
        try { steps.push({ step: s.step, valid: s.valid, r: reduce(await oper(cycle, s.step, wants)) }); }
        catch (e) { missing.push(s.step + 'h (' + shortErr(e) + ')'); }
      });
      if (steps.length < list.length / 2) throw new Error('only ' + steps.length + ' of ' + list.length + ' steps read: ' + missing.join(', '));
      steps.sort((a, b) => a.step - b.step);
      return { steps, missing };
    }
    const ec = {};
    ec.jet = await run('ecmwf-jet', 'ECMWF IFS HRES 250 hPa wind (open data)', ECMWF, async () => {
      const { cycle, plan, tried } = await pickCycle(p => (p.jet.length ? p.jet[p.jet.length - 1].step : null));
      if (cycle.iso !== cands[0].iso) notes.push('ECMWF: used the ' + cycle.iso.slice(0, 13) + 'Z cycle (' + tried.join('; ') + ')');
      const { steps, missing } = await hresSteps(cycle, plan.jet, { u250: { param: 'u', levelist: '250' }, v250: { param: 'v', levelist: '250' } },
        f => ({ nat: natStep(f), europe: null, us: null, hubs: {} }));
      if (missing.length) notes.push('ECMWF jet: steps missing — ' + missing.join(', '));
      return { issued: cycle.iso, cycleObj: cycle, nat: aggregateDays(steps, outlook, []).nat, stepsRead: steps.map(s => s.step), stepsMissing: missing };
    });
    if (Array.isArray(hubs) && !hubs.length) notes.push('ECMWF ENS hub probabilities not fetched: no hub list in this mode.');
    else ec.ens = await run('ecmwf-ens', 'ECMWF ENS probabilities (open data)', ECMWF, async () => {
      const tried = []; let cycle = null, entries = null;
      for (const c of (ec.jet ? [ec.jet.cycleObj] : []).concat(cands.filter(x => !ec.jet || x.iso !== ec.jet.cycleObj.iso))) {
        try { entries = await index(c, 'ep'); cycle = c; break; }
        catch (e) { if (!is404(e)) throw e; tried.push(c.iso.slice(0, 13) + 'Z: not yet published'); }
      }
      if (!cycle) throw new Error('no ENS probability file (' + tried.join('; ') + ')');
      const plan = ecmwfPlan(cycle, outlook, jetHours, ECMWF_CONV_HOUR), jobs = [], byDate = {}, missing = [];
      plan.ens.forEach(w => ECMWF_ENS.forEach(([param, key]) => jobs.push({ w, param, key })));
      await pool(jobs, ECMWF_PARALLEL, async j => {
        try {
          const e = pickIndex(entries, { param: j.param, step: j.w.range });
          if (!e) throw new Error('not in the index');
          const probs = hubProbs(decodeGrib2(await ecRange(ecmwfUrl(cycle, 'ep', 'grib2'), e))[0], hubs);   // only a field that arrived creates its day
          (byDate[j.w.date] || (byDate[j.w.date] = {}))[j.key] = probs;
        } catch (e) { missing.push(j.w.date + ' ' + j.param + ' (' + shortErr(e) + ')'); }
      });
      if (!Object.keys(byDate).length) throw new Error('no probability field read: ' + missing.join(', '));
      if (missing.length) notes.push('ECMWF ENS: fields missing — ' + missing.join(', '));
      return { issued: cycle.iso, cycle: cycle.iso, windows: plan.ens, hubProb: hubProbTable(byDate, plan.ens.map(w => w.date), hubs), missing };
    });
    ec.conv = await run('ecmwf-conv', 'ECMWF IFS HRES MUCAPE + precipitation rate (open data)', ECMWF, async () => {
      const { cycle, plan } = await pickCycle(p => (p.conv.length ? p.conv[p.conv.length - 1].step : null), ec.jet && ec.jet.cycleObj);
      const { steps, missing } = await hresSteps(cycle, plan.conv, { cape: { param: 'mucape' }, cpInst: { param: 'tprate' } },
        f => ({ nat: null, europe: convStep(f, REGIONS.europe, null, AREAS.europe), us: convStep(f, REGIONS.us, null, AREAS.us), hubs: {}, conv: convGridsOf(f) }));
      if (missing.length) notes.push('ECMWF convection: steps missing — ' + missing.join(', '));
      // The same map grid as gfs.convGrid, from the global fields already downloaded (no extra request).
      const convGrid = convDays(steps.filter(s => s.r.conv).map(s => ({ valid: s.valid, grids: s.r.conv })),
        { model: 'ECMWF IFS HRES forecast', extra: { cycle: cycle.iso, fields: 'MUCAPE and total precipitation rate (instantaneous), ' + ECMWF_CONV_HOUR + ' UTC; 0.25° field sampled at the 1° points' },
          outlookFrom: outlook.from, label: ECMWF_LABEL });
      return { issued: cycle.iso, cycle: cycle.iso, convective: aggregateDays(steps, outlook, []).convective, convGrid, stepsRead: steps.map(s => s.step), stepsMissing: missing };
    });
    if (!ec.jet && !ec.ens && !ec.conv) return;
    const main = ec.jet ? ec.jet.cycleObj.iso : ec.conv ? ec.conv.cycle : ec.ens.cycle;
    out.ecmwf = {
      cycle: main, issued: main, model: 'ECMWF IFS HRES 0.25° (deterministic) and ENS (51 members), open data', label: ECMWF_LABEL,
      attribution: ECMWF_ATTRIBUTION, licence: PAGES.ecmwf,
      jetHoursUtc: jetHours, nat: ec.jet ? ec.jet.nat : [],
      convectiveHourUtc: ECMWF_CONV_HOUR, convectiveFields: 'MUCAPE and total precipitation rate (instantaneous)', convective: ec.conv ? ec.conv.convective : null,
      convGrid: ec.conv ? ec.conv.convGrid : null,
      hubProb: ec.ens ? ec.ens.hubProb : [],
      ens: ec.ens ? { cycle: ec.ens.cycle, issued: ec.ens.issued, windows: ec.ens.windows, listedFromPct: ENS_LIST_PCT,
                      fields: { gust15Pct: 'P(10 m gust >= 15 m/s = 29 kt) in the 24 h from 00 UTC', gust25Pct: 'P(10 m gust >= 25 m/s = 49 kt)', tp20Pct: 'P(precipitation >= 20 mm in 24 h)' } } : null,
      stepsRead: { jet: ec.jet ? ec.jet.stepsRead : [], convective: ec.conv ? ec.conv.stepsRead : [] },
      stepsMissing: { jet: ec.jet ? ec.jet.stepsMissing : [], convective: ec.conv ? ec.conv.stepsMissing : [], ens: ec.ens ? ec.ens.missing : [] },
    };
  }

  await Promise.all([gfsChain(), textChain(), ecmwfChain().catch(e => { notes.push('ECMWF block failed — ' + clip(String((e && e.message) || e), 150)); })]);
  if (out.gfs && out.ecmwf && out.ecmwf.nat.length) {
    const sameHours = +String(out.gfs.cycle).slice(11, 13) % 12 === out.ecmwf.jetHoursUtc[0];
    out.compare = compareModels(out.gfs.nat, out.ecmwf.nat).map(c => Object.assign(c, { sameHours }));
  }
  sources.sort((a, b) => SOURCE_ORDER.indexOf(a.key) - SOURCE_ORDER.indexOf(b.key));
  if (!sources.some(s => s.ok)) throw new Error('every source failed (' + sources.length + '), first: ' + notes.slice(0, 2).join('; '));
  out.requests = hits;
  out.megabytes = {}; Object.keys(hits).forEach(h => { out.megabytes[h] = Math.round((bytes[h] || 0) / 1e4) / 100; });
  out.seconds = Math.round((Date.now() - t0) / 1000);
  const okN = sources.filter(s => s.ok).length, mb = Object.values(bytes).reduce((a, b) => a + b, 0) / 1e6;
  out.summary = ['outlook ' + outlook.from + ' .. ' + outlook.to + ' · ' + okN + '/' + sources.length + ' sources · ' +
                 Object.values(hits).reduce((a, b) => a + b, 0) + ' requests, ' + mb.toFixed(1) + ' MB (' +
                 Object.keys(hits).map(h => h + ' ' + hits[h] + '/' + out.megabytes[h] + ' MB').join(', ') + ') · ' + out.seconds + ' s'];
  return out;
}

// ---- digest -----------------------------------------------------------------------------------
const srcOf = (s, key) => (s.sources || []).find(x => x.key === key) || null;
const isOk = (s, key) => { const x = srcOf(s, key); return !!(x && x.ok); };

function digest(s) {
  const L = [], o = s.outlook || {};
  // Outlook days a model line has no figure for (steps cut by the time budget or missing on the server).
  const gap = ds => { const have = new Set((ds || []).map(d => d.date)), miss = [];
    for (let d = o.from; d && d <= o.to; d = U.addDays(d, 1)) if (!have.has(d)) miss.push(wd(d));
    return miss.length ? ' (no data for ' + miss.join(', ') + ')' : ''; };
  L.push('WEATHER OUTLOOK — the week ahead ' + o.from + '–' + o.to + ' (forecasts, not events)');
  L.push('Official NOAA/NWS and JTWC outlooks read before this run, plus figures computed from the GFS and ECMWF models, which are model-derived, not an official risk category.');
  const g = s.gfs;
  if (g && g.nat && g.nat.length) {
    L.push('NAT JET (GFS 250 hPa, max wind 30–70N 70W–0 · mean westerly at 50N 50W–10W): ' +
      g.nat.map(d => wd(d.date) + ' ' + d.jetMaxKt + ' kt ' + pos(d.lat, d.lon) + ' · ' + d.westerly50NKt + ' kt').join(' | ') + gap(g.nat));
    const lm = jetLevelMax(g.jetGrid);
    if (lm.length > 1) L.push('  jet by level (strongest in the outlook, 25–71N 80W–40E): ' + lm.map(m => m.fl + ' ' + m.kt + ' kt ' + wd(m.date)).join(' · ') + '.');
  }
  const aj = areaJetLine(g && g.jetGrid, 'GFS forecast');
  if (aj) L.push(aj);
  const lvLine = g && levelLine(g.levels, 'GFS forecast, run ' + ((g.levels && g.levels.run) || '?'));
  if (lvLine) L.push(lvLine);
  if (g && g.convective) {
    const t = s.thresholds || THRESHOLDS;
    L.push('CONVECTIVE POTENTIAL — ' + LABEL + ' (share of grid points with CAPE ≥ ' + t.capeJkg + ' J/kg and convective rain ≥ ' + t.convPrecipMmH +
           ' mm/h; moderate ≥ ' + t.moderatePct + ' %, high ≥ ' + t.highPct + ' %):');
    [['europe', 'Europe'], ['us', 'US']].forEach(([k, n]) => {
      const ds = g.convective[k] || [];
      if (ds.length) L.push('  ' + n + ': ' + ds.map(d => wd(d.date) + ' ' + d.level + (d.level !== 'low' ? ' (' + d.sharePct + ' %' +
        (d.where && d.where.length ? ', mostly ' + d.where.join(' + ') : '') + ')' : '')).join(' · ') +
        (() => { const m = ds.reduce((a, b) => (b.capeMax > a.capeMax ? b : a)); return ' — week CAPE max ' + m.capeMax + ' J/kg ' + pos(m.capeLat, m.capeLon) + ' (' + wd(m.date) + ')'; })() + gap(ds));
    });
  }
  if (g && g.hubs) {
    const t = s.thresholds || THRESHOLDS, hh = +String(g.cycle || '').slice(11, 13) || 0;
    const steps = [hh, (hh + 12) % 24].sort((a, b) => a - b).map(x => String(x).padStart(2, '0')).join('/');
    const byDay = {};
    g.hubs.forEach(h => h.days.forEach(d => {
      const e = byDay[d.date] || (byDay[d.date] = { gust: [], snow: [], vis: [], heat: [] });
      if (d.gustMaxKt != null && d.gustMaxKt > t.gustKt) e.gust.push(h.code + ' ' + d.gustMaxKt);
      if (d.snow) e.snow.push(h.code);
      if (d.visMinM != null && d.visMinM < t.visM) e.vis.push(h.code + ' ' + d.visMinM);
      if (d.tmaxC != null && t.heatC != null && d.tmaxC >= t.heatC) e.heat.push(h.code + ' ' + d.tmaxC);
    }));
    const fl = Object.keys(byDay).sort().map(d => { const e = byDay[d], p = [];
      if (e.gust.length) p.push('gust ' + e.gust.join(', ') + ' kt'); if (e.snow.length) p.push('snow ' + e.snow.join(', '));
      if (e.vis.length) p.push('vis ' + e.vis.join(', ') + ' m'); if (e.heat.length) p.push('heat ' + e.heat.join(', ') + ' °C');
      return p.length ? wd(d) + ' ' + p.join('; ') : null; }).filter(Boolean);
    L.push('HUB FLAGS (' + LABEL + '; ' + steps + ' UTC steps, nearest 1° grid point; gust > ' + t.gustKt + ' kt, snow, visibility < ' + t.visM +
           ' m — a 1° model gives only a coarse fog hint' + (t.heatC != null ? '; heat = 2 m maximum ≥ ' + t.heatC + ' °C' : '') + '): ' +
           (fl.length ? clip(fl.join(' | '), 900) : 'none of the ' + g.hubs.length + ' hubs flagged') + '.');
  }
  const ec = s.ecmwf;
  if (ec && ec.nat && ec.nat.length) {
    const cmp = s.compare || [], dis = cmp.filter(c => !c.agree);
    const agreeTxt = !cmp.length ? '' : ' — vs GFS (jet within ' + AGREE.jetKt + ' kt, westerly within ' + AGREE.westerlyKt + ' kt' + (cmp[0].sameHours ? ', same hours' : ', hours differ') + '): ' +
      (dis.length ? 'models agree on ' + (cmp.filter(c => c.agree).map(c => wd(c.date)).join(', ') || 'no day') + ', disagree on ' +
        dis.map(c => wd(c.date) + ' (jet ' + c.jetEcmwf + ' vs ' + c.jetGfs + ' kt, westerly ' + c.westerlyEcmwf + ' vs ' + c.westerlyGfs + ' kt)').join(', ') + ' — outlook uncertain there'
      : 'models agree on every day');
    L.push('ECMWF NAT JET (HRES 250 hPa, same box, ' + ec.jetHoursUtc.map(h => String(h).padStart(2, '0')).join('/') + ' UTC): ' +
      ec.nat.map(d => wd(d.date) + ' ' + d.jetMaxKt + ' kt ' + pos(d.lat, d.lon) + ' · ' + d.westerly50NKt + ' kt').join(' | ') + gap(ec.nat) + agreeTxt + '.');
  }
  if (ec && ec.convective) {
    const part = (k, n) => { const ds = ec.convective[k] || []; return ds.length ? n + ': ' + ds.map(d => wd(d.date) + ' ' + d.level +
      (d.level !== 'low' ? ' (' + d.sharePct + ' %' + (d.where && d.where.length ? ', mostly ' + d.where.join(' + ') : '') + ')' : '')).join(' · ') + gap(ds) : null; };
    L.push('ECMWF CONVECTIVE POTENTIAL — ' + ECMWF_LABEL + ' (MUCAPE ≥ ' + (s.thresholds || THRESHOLDS).capeJkg + ' J/kg and precipitation rate ≥ ' +
      (s.thresholds || THRESHOLDS).convPrecipMmH + ' mm/h at ' + ec.convectiveHourUtc + ' UTC, same levels): ' + [part('europe', 'Europe'), part('us', 'US')].filter(Boolean).join(' | ') + '.');
  }
  if (ec && ec.hubProb && ec.hubProb.length) {
    const lim = (ec.ens && ec.ens.listedFromPct) || ENS_LIST_PCT, NAMES = { gust15Pct: 'gust ≥ 29 kt', gust25Pct: 'gust ≥ 49 kt', tp20Pct: 'rain ≥ 20 mm' };
    const days = {};
    ec.hubProb.forEach(h => h.days.forEach(d => Object.keys(NAMES).forEach(k => { if (d[k] != null && d[k] >= lim) {
      const e = days[d.date] || (days[d.date] = {}); (e[k] || (e[k] = [])).push(h.code + ' ' + d[k]); } })));
    const txt = Object.keys(days).sort().map(d => wd(d) + ' ' + Object.keys(NAMES).filter(k => days[d][k]).map(k => NAMES[k] + ' ' + days[d][k].join(', ') + ' %').join('; '));
    L.push('ECMWF ENSEMBLE PROBABILITIES at the hubs (51 members, 24 h from 00 UTC, nearest 0.25° point; listed from ' + lim + ' %): ' +
      (txt.length ? clip(txt.join(' | '), 900) : 'no hub at ' + lim + ' % or more for gusts ≥ 29 kt, gusts ≥ 49 kt or rain ≥ 20 mm') + '.');
  }
  const spc = s.spc || {};
  const sp = [];
  (spc.days || []).forEach(d => sp.push('D' + d.day + (d.valid ? ' ' + wd(d.valid.slice(0, 10)) : '') + ' ' + (d.max || 'no thunder') +
    (d.max && d.max !== 'TSTM' && d.bbox ? ' ' + d.bbox[0] + '–' + d.bbox[2] + 'N ' + Math.abs(d.bbox[3]) + '–' + Math.abs(d.bbox[1]) + 'W' : '') +
    (d.hubs && d.hubs.length ? ' (' + d.hubs.join(', ') + ')' : '')));
  if (spc.d48) {
    const p = spc.d48.days.filter(d => d.probPct);
    sp.push('D4–8 ' + (p.length ? p.map(d => 'D' + d.day + ' ' + d.probPct + ' %' + (d.hubs.length ? ' (' + d.hubs.join(', ') + ')' : '')).join(', ') : (spc.d48.days[0] || {}).label || 'no area') +
            (spc.d48.summary ? ' — "' + spc.d48.summary + '"' : ''));
  }
  if (sp.length) L.push('SPC (official, US): ' + sp.join('; '));
  if (s.wpc) L.push('WPC days 3–7 (' + (s.wpc.valid || '') + '): ' + clip(s.wpc.summary, 300));
  const cpc = s.cpc || {};
  if (cpc.thr) L.push('CPC hazards week 2: ' + (cpc.thr.hazards.length ? clip(cpc.thr.hazards.join(' | '), 420) : 'none posted') +
    (cpc.mrd && cpc.mrd.periods.length ? ' · ' + cpc.mrd.periods.map(p => p.period + ' ' + p.dates + (p.confidence ? ' confidence ' + p.confidence : '')).join('; ') : ''));
  const n = s.nhc || {};
  const st = (n.storms || []).map(x => x.type + ' ' + x.name + ' (' + x.basin + ') ' + x.windKt + ' kt' + (x.pressureMb ? ' ' + x.pressureMb + ' hPa' : '') +
    ' ' + pos(x.lat, x.lon) + (x.movementKt != null ? ', ' + compass(x.movementDir) + ' ' + x.movementKt + ' kt' : ''));
  const ar = (n.outlooks || []).map(t => t.basin + ': ' + (t.areas.length ? t.areas.map(a => a.title + ' ' + (a.chance48h == null ? '?' : a.chance48h) + ' %/48 h, ' + (a.chance7d == null ? '?' : a.chance7d) + ' %/7 d').join('; ') : 'no formation expected'));
  if (isOk(s, 'nhc-storms') || (n.outlooks || []).length) L.push('TROPICS — NHC/CPHC: ' + (st.length ? st.join('; ') : 'no active storms') + '. Outlook ' + (ar.join(' · ') || 'unavailable') + '.');
  if (s.jtwc) {
    const js = s.jtwc.systems.map(x => x.type + ' ' + x.id + (x.name ? ' ' + x.name : '') + (x.windKt ? ' ' + x.windKt + ' kt' : '') + (x.pressureMb ? ' ' + x.pressureMb + ' hPa' : '') +
      (x.lat != null ? ' ' + pos(x.lat, x.lon) : '') + (x.movementKt != null ? ', ' + compass(x.movementDir) + ' ' + x.movementKt + ' kt' : '') +
      (() => { const et = (x.forecast || []).find(f => f.note); return et ? ', ' + et.note + ' by ' + et.h + ' h near ' + pos(et.lat, et.lon) : ''; })());
    L.push('TROPICS — JTWC (W Pacific, Indian Ocean, S Hemisphere): ' + (js.length ? js.join('; ') : 'no warnings in force') + '.');
  }
  const sw = s.swpc || {};
  if (sw.threeDay || sw.scales) {
    const parts = [];
    if (sw.scales) parts.push('now ' + sw.scales.current.R + ' ' + sw.scales.current.S + ' ' + sw.scales.current.G);
    if (sw.threeDay) parts.push('Kp max ' + sw.threeDay.days.map(d => wd(d.date) + ' ' + d.maxKp + (d.g ? ' (' + d.g + ')' : '')).join(', '));
    if (sw.scales && sw.scales.forecast.length) { const f = sw.scales.forecast;
      parts.push('radio blackout R1–R2 ' + Math.max(...f.map(x => x.rMinorPct || 0)) + ' %, R3+ ' + Math.max(...f.map(x => x.rMajorPct || 0)) + ' %, S1+ ' + Math.max(...f.map(x => x.sPct || 0)) + ' % per day at most'); }
    L.push('SPACE WEATHER (NOAA SWPC, HF/GNSS): ' + parts.join('; ') + '.');
  }
  const iss = k => { const x = srcOf(s, k); return x && x.ok && x.issued ? fmtIssued(x.issued) : null; };
  const il = [['GFS', 'gfs'], ['ECMWF HRES', 'ecmwf-jet'], ['ECMWF ENS', 'ecmwf-ens'], ['NHC AT', 'nhc-two-at'], ['JTWC', 'jtwc'], ['SPC D1', 'spc-d1'], ['SPC D4–8', 'spc-d48'], ['WPC', 'wpc-epd'],
              ['CPC THR', 'cpc-thr'], ['CPC 6–10', 'cpc-mrd'], ['SWPC', 'swpc-3day']].map(([a, k]) => iss(k) ? a + ' ' + iss(k) : null).filter(Boolean);
  L.push('ISSUED: ' + il.join(' · ') + '.');
  const bad = (s.sources || []).filter(x => !x.ok);
  L.push('UNAVAILABLE: ' + (bad.length ? bad.map(x => x.name + ' (' + String(x.error || '').replace(/^https?:\/\/\S+: /, '') + ')').join('; ') : 'none') + '.');
  L.push('CITE: GFS ' + PAGES.gfs + ' · NHC ' + PAGES.nhc + ' · JTWC ' + PAGES.jtwc + ' (or a system\'s warning text) · SPC ' + PAGES.spc + ' and ' + PAGES.spc48 + ' · WPC ' + PAGES.wpc +
         ' · CPC ' + PAGES.cpcThr + ' · SWPC ' + PAGES.swpc + (ec ? ' · ECMWF ' + PAGES.ecmwf + ' — "Contains ECMWF Open Data (CC BY 4.0); derived values computed by the relay"' : ''));
  L.push('');
  L.push('HOW TO USE THIS BLOCK');
  L.push('- Forecast context only: never a Topic Card, never an eventDate, never written as something that happened.');
  L.push('- Use it for what to watch this week — a "Watch" line in the cockpit / management snapshot, or the airspace and ops notes —');
  L.push('  and cite the official product page from the CITE line.');
  L.push('- Jet, convective-potential and hub figures come from the GFS and ECMWF models: call them model-derived, not an official risk');
  L.push('  category. Where GFS and ECMWF disagree, say the outlook is uncertain. ECMWF hub figures are ensemble probabilities: write');
  L.push('  "x % of the ECMWF ensemble", never "will". SPC, WPC, CPC, NHC, JTWC and SWPC wordings are official: quote, do not upgrade.');
  L.push('- A source marked unavailable is said to be unavailable; do not fill the gap from memory or a web search.');
  return L.join('\n');
}

module.exports = { LABEL, ECMWF_LABEL, ECMWF_ATTRIBUTION, AGREE, ENS_LIST_PCT, ecmwfCycles, ecmwfStepOk, ecmwfUrl, ecmwfPlan, parseIndex, pickIndex,
                   rangeOf, hubProbs, hubProbTable, compareModels, pool, THRESHOLDS, REGIONS, AREAS, HUBS, decodeGrib2, nearestIndex, valueAt, pickFields, natStep, convStep, levelFor, hubStep, reduceStep,
                   JET_GRID, JET_LEVELS, JET_FL, jetGridOf, jetGridsOf, jetDays, jetLevels, jetLevelMax, getBuffer, getRange,
                   LEVEL_VARS, LEVEL_LEVS, LEVEL_KEYS, LEVEL_LABEL, LEVEL_METHOD, LEVEL_NOTE, LEVEL_BOXES, isaAltM, pressureAltM, levelGridsOf, levelDays,
                   levelSummary, levelLine, levelSteps, GFS_STEPS,
                   aggregateDays, candidateCycles, gfsUrl, isGrib, parseNhcStorms, parseTwo, parseJtwcRss, parseJtwcWarning, parseSpcCat, parseSpcProb,
                   parseAcus48, parseWpcEpd, parseCpcThr, parseCpcMrd, parseSwpc3day, parseSwpcScales, stampToIso, digest,
                   MAP_AREAS, AREA_JET_GRID, GFS_BOX, areaGridsOf, areaJetLevels, areaLevelDays, areaJetLine, compactSnapshot, fetchWxOutlook, cli,
                   CONV_FRAMES, CONV_CLASSES, CONV_NODATA, CONV_LOW_CONF_DAY, convClass, convGridOf, convGridsOf, convMax, convDays,
                   SPC_POLY_MAX, dpKeep, simplifyRing, spcPolys, spcMapFields };

// ---- compact snapshot ----------------------------------------------------------------------------
// U.writeSnapshot writes pretty-printed JSON; the weather snapshots are mostly grid strings and long
// row lists, so they are rewritten without indentation after a successful run (W40 wxreview: −34 %).
// Same temporary-name-and-rename rule as fetch-util. A file that is already compact is left alone.
function compactSnapshot(dir, week) {
  const fs = require('fs'), p = require('path').join(U.ROOT, 'data', dir, 'week-' + week + '.json');
  let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  if (!/^\{\n/.test(txt)) return null;
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(JSON.parse(txt)));
  fs.renameSync(tmp, p);
  return fs.statSync(p).size;
}
// The command line: U.main (watchdog, --print-digest, write), then the compact rewrite. U.main exits the
// process itself on --print-digest and on failure, so the rewrite runs only after a written snapshot.
function cli() {
  const week = U.cli(process.argv).week;
  return U.main('fetch-wxoutlook', 'wxoutlook', fetchWxOutlook, digest).then(() => {
    const n = compactSnapshot('wxoutlook', week);
    if (n) console.log('fetch-wxoutlook: written compactly, ' + Math.round(n / 1024) + ' KB');
  });
}
if (require.main === module) cli();
