#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-lightning.js
// Reads where lightning was seen from space in the reporting week and hands over a map layer for
// the dashboards' weather module and a two-line prompt block: per day and per 0.5° cell over Europe,
// the Mediterranean and the eastern North Atlantic, the number of hours in which the EUMETSAT MTG
// Lightning Imager saw lightning.
//
// Why: a SIGMET says a thunderstorm was WARNED; lightning says it HAPPENED. The two side by side
// show readers that the TS layer is not a model guess, and lightning also covers the central
// European FIRs that send no SIGMETs to the AWC feed (see fetch-wxreview.js, "GAP").
//
// Source — anonymous, no key: EUMETView WMS, https://view.eumetsat.int/geoserver/wms
//   layer mtg_fd:li_afa "LI Accumulated Flash Area - MTG-I - 0 degree", default style mtg_li_afa.
//   GetCapabilities (2026-10-06): time dimension 2025-05-30T15:00Z/now/PT5M, nearestValue=1; layer
//   extent 70S–70N, 70W–70E. Each frame is a 5-minute accumulation ("The LI-AFA 5-minute accumulation
//   is derived from the LI AFA half-minute product", EUMETSAT classroom, "Interpreting LI AFA").
//   The server does not add frames up, so the week is sampled: ONE 5-minute frame per hour (HH:30Z),
//   168 GetMaps a week — about 1/12 of the time. A cell's value is "hours in which the sampled frame
//   showed lightning there", a measure of how long and where storms were active, not a flash count
//   (the PNG is pre-coloured; only lightning yes/no per pixel is reliable).
//   Frame: EPSG:4326, 25–75N 80W–40E, 1200 × 500 px = 0.1° per pixel, 5 × 5 pixels per 0.5° cell; a cell
//   is lit when any of its pixels is not fully transparent. Measured 2026-10-06 on one busy frame:
//   against a 0.05° request the 0.1° frame finds the same cells within ±8 % (the server smooths when
//   it scales down, so a lone flash can be lost and a storm edge can spill into the next cell);
//   0.25° frames smeared storms into ~15 % extra cells.
//   Frames go out one at a time, 300 ms apart after each answer, in a spread order of the hours
//   (00, 12, 06, 18, 03, 15 … Z, each for all seven days), so a run cut short by the time budget
//   still samples every day alike and evenly instead of losing the last days.
//   A frame the archive lacks is answered with the nearest one (nearestValue=1, no warning header):
//   a non-empty image identical to one already read is therefore counted as missing, not as lightning.
//   On HTTP 403 or 429 the run stops asking at once, keeps what it has and marks the rest missing.
//
// Coverage: the MTG-I1 Lightning Imager (0°E) does not see the whole Earth disk. In this frame it
// misses the Atlantic west of about 26–40°W (west of 28°W at 50N, 36°W at 35N), Greenland, Labrador
// and the sea east of Florida; the layer itself stops at 70N and 70W. The mask below is computed from
// the satellite geometry with an edge fitted to real frames (see LI_BAND_V); outside it the
// dashboards draw grey: no data, never "no lightning".
//
// Licence: EUMETSAT Data Policy (EUM/C/85/16/DOC/xx, PDF 2025-02): "All SEVIRI, FCI, IRS and LI
// Derived Products" are Core data, "Free and Unrestricted basis under a CC-BY-4.0 licence"; users
// must attribute "[Contains modified] EUMETSAT [Meteosat/Metop] [data/product] [Year]". The
// attribution travels in the snapshot and the digest and must sit next to the map.
//
// Measured 2026-10-06 on W40 (three runs): median 343–529 ms per frame, p90 ~1.3 s, now and then an HTTP 500
// or a 10 s timeout; 168 requests in 170 s with a 300 s watchdog (163 frames read). With the default
// 180 s watchdog the soft deadline (155 s) stops after 123–147 frames. Snapshot 30 KB.
//
// Middle East (round 4, 2026-10-06): the hourly frame now covers 3–75N 80W–70E (1500 × 720 px, same 0.1°
// pixels, same pixel grid) and is cut into two grids: the Europe/NAT grid as before (top-level fields; checked on
// 1 Oct 10:30Z: 0 of 600,000 pixels differ from the old 1200 × 500 request) and `areas.me`, 0.5° cells over
// 3–47N 14E–82E. Same 168 requests a week, no extra one. East of 70E the WMS layer has no data (its extent
// ends there), so those cells are outside the coverage mask; the imager's own view reaches the whole ME box west
// of that (lightning seen out to 68E on 4 Oct 18:30Z; in the W40 run lit cells reached 69.75E, 215 of them east of 60E).
// Measured on W40, 2026-10-06 ~15:40Z: the server answered slowly at that hour (median 1.3 s for the 1500 × 720 frame
// AND for the old 1200 × 500 one — the size makes no difference, side by side 0.4–1.2 s each), so the 275 s soft
// deadline stopped the run after 130 requests (123 frames read). In the morning runs the median was 0.34–0.53 s.
// ME grid ≈ 39 KB on W40 (late-season Sahel storms in the south of the box).
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');
const U = require('./fetch-util.js');
const PNG = require('./png-lite.js');

const WMS = 'https://view.eumetsat.int/geoserver/wms';
const LAYER = 'mtg_fd:li_afa';
const HOST = 'view.eumetsat.int';
const PAGES = {
  viewer: 'https://view.eumetsat.int/',
  policy: 'https://www-cdn.eumetsat.int/files/2025-02/45173%20-%20Data_Policy%281442019%20V1%29.pdf',
  licence: 'https://creativecommons.org/licenses/by/4.0/',
};
const ARCHIVE_FROM = '2025-05-30T15:00:00Z';   // first frame of the time dimension
const LAYER_EXTENT = { latS: -70, latN: 70, lonW: -70, lonE: 70 };

// 0.5° cells, 25–75N 80W–40E, same corner and row order as the SIGMET grid of fetch-wxreview.js.
const GRID = { res: 0.5, lat0: 25, lon0: -80, nlat: 100, nlon: 240 };
const PX_PER_CELL = 5;                         // 0.1° per pixel → 1200 × 500 px
// The Middle East frame's grid (BUILD-R4.md box), and the one request box that holds both grids at 0.1° per pixel.
const GRID_ME = { res: 0.5, lat0: 3, lon0: 14, nlat: 88, nlon: 136 };
const FRAME = { latS: 3, lonW: -80, latN: 75, lonE: 70, pxPerDeg: 10 };
const ALPHA_MIN = 1;                           // "not fully transparent"
const FRAME_MINUTES = [30];                    // one frame per hour, mid-hour
const PAUSE_MS = 300;                          // after each answer, before the next request
const TIMEOUT_MS = 10000;                     // the server renders a frame in 0.1–2 s
// U.main's watchdog stops a fetcher at MAX_SECONDS (default 180 s) and then writes nothing. Past this
// soft deadline — the watchdog minus one request timeout and a margin — no new frame is asked for,
// so the file is written with what was read and the rest is marked missing. Measured 2026-10-06:
// 0.1–2.1 s per frame plus the 300 ms pause, so 168 frames need 2–6 min depending on the server.
const WATCHDOG_S = (U.MAX_SECONDS && U.MAX_SECONDS['fetch-lightning']) || 180;
const SOFT_DEADLINE_S = WATCHDOG_S - 25;
const DEAD_AFTER_TIMEOUTS = 3;
const DEAD_AFTER_FAILURES = 8;                 // in a row
const LATENCY_MIN = 30;                        // frames younger than this are not asked for yet

// ---- small helpers -------------------------------------------------------------------------
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = d => wd(d) + ' ' + (+d.slice(8, 10)) + ' ' + MON[+d.slice(5, 7) - 1];     // 'Wed 30 Sep' on every Node/ICU
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };
const latLon = (lat, lon) => Math.abs(lat) + (lat < 0 ? 'S ' : 'N ') + Math.abs(lon) + (lon < 0 ? 'W' : 'E');
const attributionFor = year => 'Contains modified EUMETSAT Meteosat product ' + year + ' (CC BY 4.0)';

// Run-length text, the same format as fetch-wxreview.js: "v" for one cell, "v*n" for n cells of value v.
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

// ---- the WMS request ------------------------------------------------------------------------
const frameBox = g => ({ latS: g.lat0, lonW: g.lon0, latN: g.lat0 + g.nlat * g.res, lonE: g.lon0 + g.nlon * g.res });
function frameUrl(timeIso, grid, pxPerCell) {
  const g = grid || GRID, p = pxPerCell || PX_PER_CELL, b = frameBox(g);
  return boxUrl(timeIso, b, g.nlon * p, g.nlat * p);
}
// WMS 1.3.0 + EPSG:4326: axis order lat,lon.
const boxUrl = (timeIso, b, width, height) => WMS + '?service=WMS&version=1.3.0&request=GetMap&layers=' + LAYER + '&styles=&crs=EPSG:4326' +
  '&bbox=' + [b.latS, b.lonW, b.latN, b.lonE].join(',') + '&width=' + width + '&height=' + height +
  '&format=image/png&transparent=true&time=' + timeIso.replace(/\.\d{3}Z$/, 'Z');
// The request of the run: FRAME at 0.1° per pixel (1500 × 720 px).
const frameSize = f => ({ width: Math.round((f.lonE - f.lonW) * f.pxPerDeg), height: Math.round((f.latN - f.latS) * f.pxPerDeg) });
const unionUrl = timeIso => { const z = frameSize(FRAME); return boxUrl(timeIso, FRAME, z.width, z.height); };
// The frames of the window: one per hour at FRAME_MINUTES, in request order (HOUR_ORDER, all days per hour).
const HOUR_ORDER = [0, 12, 6, 18, 3, 15, 9, 21, 1, 13, 7, 19, 4, 16, 10, 22, 2, 14, 8, 20, 5, 17, 11, 23];
function plannedFrames(from, to, nowMs, minutes) {
  const mins = minutes || FRAME_MINUTES, now = nowMs == null ? Date.now() : nowMs;
  const all = [], future = [];
  for (const d of daysOf(from, to)) for (let h = 0; h < 24; h++) for (const m of mins) {
    const t = Date.parse(d + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00Z');
    const f = { time: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), date: d, hour: h };
    (t <= now - LATENCY_MIN * 60000 ? all : future).push(f);
  }
  const order = [];
  HOUR_ORDER.forEach(h => all.forEach(f => { if (f.hour === h) order.push(f); }));
  return { planned: order, future };
}
// One binary GET with the project's identity, no retry: a 403/429 must stop the run, not be repeated.
async function getPng(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': U.UA, Accept: 'image/png' } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type') || '', buf };
  } catch (e) {
    return { status: 0, error: (e && e.name === 'AbortError') ? 'timeout after ' + (timeoutMs || TIMEOUT_MS) + 'ms' : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

// ---- geometry: which cells the Lightning Imager can see -------------------------------------------
// Scan angles (degrees, x east, y north) of a point as seen from a geostationary satellite over 0°E;
// spherical Earth, which is plenty for a 0.5° mask.
const RE = 6371.0, RS = 42164.0, DEG = Math.PI / 180;
function scanAngles(lat, lon, subLon) {
  const p = lat * DEG, l = (lon - (subLon || 0)) * DEG;
  const dx = RE * Math.cos(p) * Math.cos(l) - RS, dy = RE * Math.cos(p) * Math.sin(l), dz = RE * Math.sin(p);
  return [Math.atan2(dy, -dx) / DEG, Math.atan2(dz, Math.hypot(dx, dy)) / DEG];
}
// Great-circle distance from the sub-satellite point below which the point is on the visible disk (81.3°).
const onDisk = (lat, lon, subLon) => Math.cos(lat * DEG) * Math.cos((lon - (subLon || 0)) * DEG) > RE / RS;
// The Lightning Imager's field of view, as the data show it: the visible disk cut by a band
// |v| <= 7.15°, where v = (y - x) / √2 is the scan angle along the NW–SE diagonal. EUMETSAT's
// pre-launch figure "LI coverage – full disk view" (EUM/RSP/VWG/17/922333, slide 13: four 1170 × 1000-
// pixel detectors in a pinwheel) did not fit the real frames — it left out lightning over the
// Caucasus, South America and the Arabian Sea and claimed the area east of Florida, where W40 had
// frequent-thunderstorm SIGMETs but not one lit pixel. The band was fitted on 2026-10-06 to 11,357 lit
// pixels (four full-extent frames of 1–4 Oct 2026 plus W40): none lies outside it, the largest |v|
// seen was 7.15°; of 77 SIGMET cells with thunderstorms in >= 20 % of W40's samples but no lightning,
// one lies inside (Black Sea). In this frame it greys the Atlantic west of about 26–36°W, Greenland,
// Labrador and the sea east of Florida. Cells where lightning is seen anyway join the mask (fetchLightning).
const LI_BAND_V = 7.15;
// Middle East grid areas at the frame's tropical edge, named after the Middle East proper in the digest.
const ME_EDGE_AREAS = ['the Sahara and the Sahel', 'the Horn of Africa', 'India', 'the Arabian Sea'];
function liCovered(lat, lon) {
  const E = LAYER_EXTENT;
  if (lat < E.latS || lat > E.latN || lon < E.lonW || lon > E.lonE || !onDisk(lat, lon)) return false;
  const [x, y] = scanAngles(lat, lon);
  return Math.abs((y - x) / Math.SQRT2) <= LI_BAND_V;
}
// 1 = cell centre inside the LI field of view and the layer extent, 0 = no data there.
function coverageMask(grid) {
  const g = grid || GRID, m = new Uint8Array(g.nlat * g.nlon);
  for (let j = 0; j < g.nlat; j++) for (let i = 0; i < g.nlon; i++) m[j * g.nlon + i] = liCovered(g.lat0 + (j + 0.5) * g.res, g.lon0 + (i + 0.5) * g.res) ? 1 : 0;
  return m;
}

// ---- one frame → lit cells ---------------------------------------------------------------------
// png: { width, height, rgba } covering frameBox(grid) — or `box` { latS, lonW, latN, lonE } when the image is
// larger than the grid — rows north→south as images are. Returns a Uint8Array over the grid (row-major
// south→north, west→east), 1 where any pixel is not transparent.
function litCells(png, grid, alphaMin, box) {
  const g = grid || GRID, b = box || frameBox(g), a0 = alphaMin || ALPHA_MIN, out = new Uint8Array(g.nlat * g.nlon);
  const dLat = (b.latN - b.latS) / png.height, dLon = (b.lonE - b.lonW) / png.width;
  for (let y = 0; y < png.height; y++) {
    const j = Math.floor((b.latN - (y + 0.5) * dLat - g.lat0) / g.res);
    if (j < 0 || j >= g.nlat) continue;
    for (let x = 0; x < png.width; x++) {
      if (png.rgba[(y * png.width + x) * 4 + 3] < a0) continue;
      const i = Math.floor((b.lonW + (x + 0.5) * dLon - g.lon0) / g.res);
      if (i >= 0 && i < g.nlon) out[j * g.nlon + i] = 1;
    }
  }
  return out;
}

// ---- where: a plain-words name for a cell -------------------------------------------------------
// [name, latS, latN, lonW, lonE]; the first box that holds the point wins, so the small ones come first.
const AREAS = [
  ['the Bay of Biscay', 43.3, 48.0, -10.0, -1.2],
  ['the Alps', 45.5, 48.0, 5.5, 16.5],
  ['the Black Sea', 42.2, 47.0, 27.5, 42.0],
  ['Turkey', 36.0, 42.2, 26.0, 40.0],
  ['the Adriatic and the Balkans', 42.0, 48.5, 13.0, 27.5],
  ['southern France and the Gulf of Lion', 42.3, 45.0, 2.5, 7.6],
  ['Iberia and the western Mediterranean', 35.5, 43.8, -10.0, 9.5],
  ['Italy and the central Mediterranean', 33.5, 45.5, 9.5, 19.5],
  ['Greece and the Aegean', 34.0, 42.0, 19.5, 28.0],
  ['the eastern Mediterranean', 30.0, 36.0, 19.5, 37.0],
  ['France', 42.3, 51.2, -1.2, 8.2],
  ['the British Isles', 49.5, 61.0, -11.0, 2.0],
  ['Germany and the Benelux', 47.0, 55.5, 2.0, 15.5],
  ['Scandinavia and the Baltic', 54.0, 71.0, 4.0, 32.0],
  ['eastern Europe', 44.0, 60.0, 15.5, 40.0],
  ['North Africa', 25.0, 35.5, -17.0, 37.0],
  ['the Middle East', 25.0, 37.0, 37.0, 40.0],
  ['the Azores', 35.0, 42.0, -33.0, -22.0],
  ['the Atlantic off Portugal and Morocco', 25.0, 43.3, -22.0, -9.0],
  ['the eastern North Atlantic', 43.3, 61.0, -30.0, -9.0],
  ['Iceland and the Norwegian Sea', 61.0, 75.0, -30.0, 4.0],
  ['the central North Atlantic', 25.0, 61.0, -50.0, -22.0],
  ['Greenland and the Labrador Sea', 55.0, 75.0, -80.0, -30.0],
  ['off Newfoundland', 42.0, 55.0, -65.0, -50.0],
  ['off the US East Coast', 25.0, 42.0, -80.0, -60.0],
  ['the western North Atlantic', 25.0, 55.0, -80.0, -50.0],
  ['the Barents Sea', 71.0, 75.0, 4.0, 40.0],
  // Middle East grid only: every box below lies east of 40E or south of 25N, outside the Europe/NAT grid, so the
  // names above (and the Europe digest) are unchanged.
  ['the Caucasus', 38.5, 44.5, 40.0, 50.5],
  ['the Caspian Sea', 36.5, 47.0, 46.5, 55.0],
  ['Iraq and Kuwait', 29.0, 37.5, 40.0, 48.5],
  ['the Gulf', 23.0, 30.5, 48.5, 57.0],
  ['Iran', 30.5, 40.0, 44.0, 63.5],
  ['southern Iran', 25.0, 30.5, 57.0, 63.5],
  ['Central Asia', 35.0, 47.0, 52.0, 82.0],
  ['Afghanistan and Pakistan', 23.0, 38.0, 60.0, 75.5],
  ['the Arabian Peninsula', 12.5, 32.0, 34.5, 60.0],
  ['Egypt, Sudan and the Red Sea', 12.0, 31.5, 24.0, 43.0],
  ['the Arabian Sea', 3.0, 25.0, 50.0, 75.0],
  ['India', 3.0, 35.0, 66.0, 82.0],
  ['the Horn of Africa', 3.0, 12.5, 32.0, 52.0],
  ['the Sahara and the Sahel', 3.0, 25.0, 14.0, 32.0],
];
function areaOf(lat, lon) {
  const a = AREAS.find(([, s, n, w, e]) => lat >= s && lat < n && lon >= w && lon < e);
  return a ? a[0] : 'near ' + latLon(Math.round(lat), Math.round(lon));
}

// ---- aggregation ---------------------------------------------------------------------------------
// frames: [{ date, hour, lit: Uint8Array | null (null = not read), empty: bool }], dates: the window's days.
function aggregate(frames, dates, grid, cover) {
  const g = grid || GRID, N = g.nlat * g.nlon;
  const cellCenter = k => [g.lat0 + (Math.floor(k / g.nlon) + 0.5) * g.res, g.lon0 + (k % g.nlon + 0.5) * g.res];
  const week = new Uint16Array(N);
  const days = dates.map(date => {
    const fr = frames.filter(f => f.date === date);
    const hours = new Map();                                     // hour -> Uint8Array of lit cells (any frame of the hour)
    fr.forEach(f => { if (!f.lit) return; const h = hours.get(f.hour) || new Uint8Array(N); for (let k = 0; k < N; k++) if (f.lit[k]) h[k] = 1; hours.set(f.hour, h); });
    const v = new Uint8Array(N);
    hours.forEach(h => { for (let k = 0; k < N; k++) v[k] += h[k]; });
    if (cover) for (let k = 0; k < N; k++) if (!cover[k]) v[k] = 0;   // nothing outside the field of view
    let max = 0, cells = 0, peakK = -1;
    for (let k = 0; k < N; k++) { week[k] += v[k]; if (v[k]) cells++; if (v[k] > max) { max = v[k]; peakK = k; } }
    const read = fr.filter(f => f.lit);
    const missingHours = [...new Set(fr.filter(f => !f.lit).map(f => f.hour))].filter(h => !hours.has(h)).sort((a, b) => a - b);
    const day = { date, samples: read.length, missing: fr.length - read.length, empty: read.filter(f => f.empty).length, max, cells, grid: rleEncode(v) };
    if (missingHours.length) day.missingHours = missingHours;
    if (peakK >= 0) { const [la, lo] = cellCenter(peakK); day.peak = { lat: la, lon: lo, hours: max, area: areaOf(la, lo) }; }
    return { day, v };
  });
  // Areas by cell-hours over the week, each with its busiest day.
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

// ---- incremental runs (the public relay) ----------------------------------------------------------
// A run of the relay reads the same week again and again (four times a day). With the `cache` option the
// frames already read in an earlier run of the week are taken from the cache instead of being asked for
// again; only new hours (and frames that failed before) go out. The cache is a plain JSON object:
//   { kind: 'lightning', version, params, from, frames: { 'YYYY-MM-DDTHH:30Z': { lit, litMe (RLE text),
//     empty, emptyMe, sha1 } }, misses: { 'YYYY-MM-DDTHH:30Z': n } }
// params pins the grids and the frame request: a cache written with other ones is dropped, so is one of another
// week (from) or one that does not decode. The result is the same as one run reading every frame now.
const CACHE_VERSION = 1;
const MISS_TRIES = 3;                          // a frame that failed this often in earlier runs is not asked for again
const cacheParams = () => JSON.stringify({ GRID, GRID_ME, FRAME, ALPHA_MIN, FRAME_MINUTES });
// The usable frames of a cache, or { dropped: reason }.
function readCache(c, from) {
  if (c == null) return { frames: new Map(), misses: {}, dropped: null };
  const fresh = why => ({ frames: new Map(), misses: {}, dropped: why });
  if (typeof c !== 'object' || c.kind !== 'lightning' || c.version !== CACHE_VERSION) return fresh('not a lightning cache of version ' + CACHE_VERSION);
  if (c.params !== cacheParams()) return fresh('written with other grid or frame settings');
  if (c.from !== from) return fresh('of another week (' + c.from + ')');
  const frames = new Map(), N = GRID.nlat * GRID.nlon, NM = GRID_ME.nlat * GRID_ME.nlon;
  for (const [time, x] of Object.entries(c.frames || {})) {
    const lit = rleDecode(x && x.lit), litMe = rleDecode(x && x.litMe);
    if (lit.length !== N || litMe.length !== NM || !/^[0-9a-f]{40}$/.test(String(x.sha1))) return fresh('frame ' + time + ' does not decode');
    frames.set(time, { lit: Uint8Array.from(lit), litMe: Uint8Array.from(litMe), empty: !!x.empty, emptyMe: !!x.emptyMe, sha1: x.sha1 });
  }
  const misses = {};
  Object.entries(c.misses || {}).forEach(([t, n]) => { if (Number.isInteger(n) && n > 0) misses[t] = n; });
  return { frames, misses, dropped: null };
}
function writeCache(from, frames, misses) {
  const out = { kind: 'lightning', version: CACHE_VERSION, params: cacheParams(), from, frames: {}, misses };
  frames.forEach(f => { if (f.lit) out.frames[f.time] = { lit: rleEncode(f.lit), litMe: rleEncode(f.litMe), empty: !!f.empty, emptyMe: !!f.emptyMe, sha1: f.sha1 }; });
  return out;
}

// ---- fetch ------------------------------------------------------------------------------------
// Options beyond the window, all absent in the weekly run (which then behaves exactly as before):
//   pauseMs, nowMs  tests only
//   cache           { prev: <cache object or null> } — incremental mode: frames in prev are not asked for again;
//                   on return cache.next holds the new cache and cache.info { reused, fetched, dropped }
//   maxFrames       at most this many requests in this run (the rest stays missing for a later run)
//   softDeadlineS   instead of the watchdog-derived SOFT_DEADLINE_S
async function fetchLightning({ from, to, pauseMs, nowMs: nowArg, cache, maxFrames, softDeadlineS }) {
  const t0 = Date.now(), nowMs = nowArg == null ? Date.now() : nowArg;
  const softS = softDeadlineS != null ? softDeadlineS : SOFT_DEADLINE_S, maxReq = maxFrames != null ? maxFrames : Infinity;
  const C = cache ? readCache(cache.prev, from) : null;
  if (Date.parse(from + 'T00:00:00Z') < Date.parse(ARCHIVE_FROM)) throw new Error('the EUMETView li_afa archive starts ' + ARCHIVE_FROM.slice(0, 10) + '; ' + from + ' is older');
  const notes = [], hits = {}, dates = daysOf(from, to);
  const plan = plannedFrames(from, to, nowMs);
  if (!plan.planned.length) throw new Error('no frame of the window is old enough to be in the archive yet');
  const frames = [], seen = new Map();
  let stopped = null, timeouts = 0, failRun = 0, errors = 0, dup = 0, reused = 0;
  const failed = new Set();                    // incremental mode: frames asked for in this run and not read
  // Incremental mode: the cached frames first (their images count for the "same image" check), in plan order.
  if (C) plan.planned.forEach(f => { const x = C.frames.get(f.time); if (x) { seen.set(x.sha1, f.time); } });
  const ms = [];
  const reasons = {};
  const miss = (f, why) => { frames.push(Object.assign({}, f, { lit: null })); reasons[why] = (reasons[why] || 0) + 1; };
  for (const f of plan.planned) {
    if (C) {
      const x = C.frames.get(f.time);
      if (x) { frames.push(Object.assign({}, f, { lit: x.lit, empty: x.empty, litMe: x.litMe, emptyMe: x.emptyMe, sha1: x.sha1 })); reused++; continue; }
      if ((C.misses[f.time] || 0) >= MISS_TRIES) { miss(f, 'failed in ' + MISS_TRIES + ' earlier runs, not asked again'); continue; }
      if (!stopped && (hits[HOST] || 0) >= maxReq) stopped = 'request cap of ' + maxReq + ' for this run reached (the rest follows in a later run)';
    }
    if (stopped) { miss(f, 'not asked — ' + stopped); continue; }
    if ((Date.now() - t0) / 1000 > softS) { stopped = 'time budget of ' + softS + ' s used up'; miss(f, 'not asked — ' + stopped); continue; }
    hits[HOST] = (hits[HOST] || 0) + 1;
    const tq = Date.now();
    const r = await getPng(unionUrl(f.time));
    ms.push(Date.now() - tq);
    if (r.status === 403 || r.status === 429) {
      stopped = HOST + ' answered HTTP ' + r.status + ' at ' + f.time + ' — no further request this run';
      notes.push('EUMETView: HTTP ' + r.status + ' at frame ' + f.time + '; stopped asking at once (no retry), kept the ' + frames.filter(x => x.lit).length + ' frames already read');
      miss(f, 'HTTP ' + r.status);
      continue;
    }
    let why = null;
    if (!r.status) { why = r.error; if (/timeout/.test(r.error) && ++timeouts >= DEAD_AFTER_TIMEOUTS) stopped = HOST + ' timed out ' + timeouts + ' times'; }
    else if (r.status !== 200) why = 'HTTP ' + r.status;
    else if (!PNG.isPng(r.buf)) why = 'no PNG in the answer (' + clip(r.buf.toString('utf8', 0, 300).replace(/<[^>]+>/g, ' '), 90) + ')';
    if (!why) {
      try {
        const png = PNG.decode(r.buf);
        const lit = litCells(png, GRID, ALPHA_MIN, FRAME), litMe = litCells(png, GRID_ME, ALPHA_MIN, FRAME);
        const anyAtl = lit.some(v => v), anyMe = litMe.some(v => v);
        const h = crypto.createHash('sha1').update(r.buf).digest('hex');
        if ((anyAtl || anyMe) && seen.has(h)) { dup++; why = 'same image as ' + seen.get(h) + ' (the server\'s nearest-time stand-in)'; }
        else { seen.set(h, f.time); frames.push(Object.assign({}, f, { lit, empty: !anyAtl, litMe, emptyMe: !anyMe }, C ? { sha1: h } : {})); failRun = 0; }
      } catch (e) { why = 'PNG not decoded — ' + clip(e.message, 80); }
    }
    if (why) {
      // Incremental mode: a failure of this very frame (archive lacks it, HTTP 4xx, no or broken PNG) counts towards
      // MISS_TRIES; a timeout, a 5xx or a network error is the server's state and is simply tried again next run.
      if (C && /^(same image|HTTP 4|no PNG|PNG not decoded)/.test(why)) failed.add(f.time);
      errors++; miss(f, why.replace(/ at \S+$/, '').replace(/same image as \S+/, 'same image as an earlier frame'));
      if (++failRun >= DEAD_AFTER_FAILURES && !stopped) stopped = failRun + ' frames in a row failed (last: ' + clip(why, 60) + ')';
    }
    if (hits[HOST] % 42 === 0) console.log('fetch-lightning: ' + hits[HOST] + ' frames asked, ' + Math.round((Date.now() - t0) / 1000) + ' s');
    await U.sleep(pauseMs != null ? pauseMs : PAUSE_MS);
  }
  plan.future.forEach(f => miss(f, 'not yet in the archive at run time'));
  if (C) {
    // Frames asked for in this run and not read count as a miss; a later run asks again until MISS_TRIES.
    const misses = {}, ok = new Set(frames.filter(f => f.lit).map(f => f.time));
    plan.planned.forEach(f => { const n = ok.has(f.time) ? 0 : (C.misses[f.time] || 0) + (failed.has(f.time) ? 1 : 0); if (n) misses[f.time] = n; });
    cache.next = writeCache(from, frames, misses);
    cache.info = { reused, fetched: hits[HOST] || 0, dropped: C.dropped };
  }
  const read = frames.filter(f => f.lit);
  if (!read.length) throw new Error('no frame read (' + Object.entries(reasons).map(([k, n]) => k + ' ×' + n).slice(0, 2).join('; ') + ')');
  const missing = frames.length - read.length;
  if (missing) notes.push('EUMETView: ' + missing + ' of ' + frames.length + ' hourly frames missing — ' + Object.entries(reasons).map(([k, n]) => clip(k, 110) + ' ×' + n).join('; '));
  if (dup) notes.push('EUMETView: ' + dup + ' frame(s) came back identical to an earlier one — the archive lacks them and the server sent its nearest frame; counted as missing');
  const empty = read.filter(f => f.empty).length;
  if (empty > read.length / 4) notes.push('EUMETView: ' + empty + ' of ' + read.length + ' frames showed no lightning anywhere in the box — unusual for the season, check the source');
  if (read.length < frames.length * 0.75) notes.push('lightning coverage partial — hours are undercounted');

  // Lightning seen in a cell proves the cell is covered: the fitted edge is approximate, so such
  // cells join the mask (and are counted, to show where the fit is off).
  const cover = coverageMask(GRID);
  let added = 0;
  read.forEach(f => { for (let k = 0; k < cover.length; k++) if (f.lit[k] && !cover[k]) { cover[k] = 1; added++; } });
  if (added) notes.push('coverage: ' + added + ' cell(s) outside the modelled LI field of view showed lightning and were added to the covered area');
  const agg = aggregate(frames, dates, GRID, cover);
  // The Middle East grid from the same frames: its own coverage mask (nothing east of the layer's 70E edge).
  const coverMe = coverageMask(GRID_ME);
  let addedMe = 0;
  read.forEach(f => { for (let k = 0; k < coverMe.length; k++) if (f.litMe[k] && !coverMe[k]) { coverMe[k] = 1; addedMe++; } });
  const aggMe = aggregate(frames.map(f => Object.assign({}, f, { lit: f.lit ? f.litMe : null, empty: f.emptyMe })), dates, GRID_ME, coverMe);
  const coveredMe = coverMe.reduce((a, b) => a + b, 0);
  const year = new Date(nowMs).getUTCFullYear();
  const out = {
    source: 'EUMETSAT MTG Lightning Imager (li_afa) via EUMETView WMS',
    attribution: attributionFor(year),
    licence: { name: 'CC BY 4.0', url: PAGES.licence, policy: PAGES.policy,
               note: 'EUMETSAT Data Policy: LI derived products are Core data, free and unrestricted under CC BY 4.0; attribution required' },
    pages: PAGES,
    layer: LAYER, wms: WMS,
    sampling: 'one 5-minute frame per hour (HH:30Z) — about 1/12 of the time; a value counts the hours whose sampled frame showed lightning in the cell',
    frame: Object.assign({ bbox: [FRAME.latS, FRAME.lonW, FRAME.latN, FRAME.lonE] }, frameSize(FRAME),
             { crs: 'EPSG:4326', minutes: FRAME_MINUTES, accumulationMin: 5, litIf: 'any pixel of the cell with alpha ≥ ' + ALPHA_MIN,
               cutInto: 'the Europe/NAT grid (top level, 25–75N 80W–40E) and areas.me (3–47N 14E–82E), 5 × 5 px per 0.5° cell' }),
    res: GRID.res, lat0: GRID.lat0, lon0: GRID.lon0, nlat: GRID.nlat, nlon: GRID.nlon, encoding: 'rle',
    layout: 'cells; row-major south→north, west→east; value = hours with lightning that day (0–24); tokens "v" or "v*n"',
    coverage: rleEncode(cover),
    coverageNote: '1 = inside the MTG-I1 Lightning Imager field of view (satellite geometry, edge fitted to real frames, approximate to about 1° along the edge) and the layer extent 70S–70N 70W–70E, plus any cell where lightning was seen; 0 = no data, draw grey, never "no lightning"',
    days: agg.days, week: agg.week, max: agg.max, weekMax: agg.weekMax, litCells: agg.litCells, hotspots: agg.hotspots,
    frames: { planned: frames.length, read: read.length, missing, empty }, coverageAdded: added,
    // Middle East: same structure as the top-level grid, same frames (missing / samples per day as above).
    areas: { me: { res: GRID_ME.res, lat0: GRID_ME.lat0, lon0: GRID_ME.lon0, nlat: GRID_ME.nlat, nlon: GRID_ME.nlon, encoding: 'rle',
                   layout: 'cells; row-major south→north, west→east; value = hours with lightning that day (0–24); tokens "v" or "v*n"',
                   coverage: rleEncode(coverMe),
                   coverageNote: '1 = inside the MTG-I1 Lightning Imager field of view and the layer extent (east edge 70E), plus any cell where lightning was seen; ' +
                                 '0 = no data (east of 70E, beyond the imager), draw grey, never "no lightning"',
                   coveredShare: Math.round(1000 * coveredMe / coverMe.length) / 1000,
                   days: aggMe.days, week: aggMe.week, max: aggMe.max, weekMax: aggMe.weekMax, litCells: aggMe.litCells, hotspots: aggMe.hotspots, coverageAdded: addedMe } },
    requests: hits, notes,
    timing: (() => { const q = ms.slice().sort((a, b) => a - b), at = p => q[Math.min(q.length - 1, Math.floor(p * q.length))];
      return q.length ? { medianMs: at(0.5), p90Ms: at(0.9), maxMs: q[q.length - 1], pauseMs: PAUSE_MS, softDeadlineS: softS } : null; })(),
  };
  if (C) { out.frames.future = plan.future.length; out.incremental = cache.info; }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  const top = agg.hotspots[0];
  out.summary = [from + ' .. ' + to + ' · ' + read.length + '/' + frames.length + ' frames · ' + agg.litCells + ' cells with lightning · max ' + agg.max + ' h/day, ' + agg.weekMax + ' h/week' +
                 (top ? ' · most over ' + top.area + ' (peak ' + top.peakDate + ')' : '') + ' · Middle East ' + aggMe.litCells + ' cells' +
                 (aggMe.hotspots[0] ? ', most over ' + aggMe.hotspots[0].area : '') + ' · ' + (hits[HOST] || 0) + ' requests (median ' + (out.timing ? out.timing.medianMs : '?') + ' ms) · ' + out.seconds + ' s'];
  return out;
}

// ---- digest -----------------------------------------------------------------------------------
// The longitude where the covered area ends towards the west on a latitude row (cells counted from the
// east edge of the frame while covered), rounded to whole degrees; null when the row is not covered.
function westEdge(s, lat) {
  const cov = rleDecode(s.coverage), j = Math.floor((lat - s.lat0) / s.res);
  if (!cov.length || j < 0 || j >= s.nlat) return null;
  let i = s.nlon - 1;
  if (!cov[j * s.nlon + i]) return null;
  while (i > 0 && cov[j * s.nlon + i - 1]) i--;
  return Math.round(s.lon0 + i * s.res);
}
const lonText = lon => Math.abs(lon) + (lon < 0 ? 'W' : 'E');
function digest(s) {
  const w = s.window || {}, fr = s.frames || {}, hs = s.hotspots || [];
  const span = w.from && w.to ? fmtDay(w.from).replace(/^\w+ /, '') + '–' + fmtDay(w.to).replace(/^\w+ /, '') : 'the reporting week';
  const peakDay = (s.days || []).reduce((a, d) => (d.peak && (!a || d.peak.hours > a.peak.hours) ? d : a), null);
  let l1 = 'SATELLITE LIGHTNING (EUMETSAT MTG Lightning Imager, Europe + eastern Atlantic, ' + span + '; ' + (s.sampling || 'sampled frames').replace(/ —.*$/, '') + '): ';
  if (!hs.length) l1 += 'no lightning seen in the sampled frames inside the covered area.';
  else {
    l1 += 'most thunderstorm hours over ' + hs[0].area + ' on ' + fmtDay(hs[0].peakDate);
    const more = hs.slice(1, 3).map(h => h.area + ' (' + fmtDay(h.peakDate) + ')');
    if (more.length) l1 += '; also ' + more.join(' and ');
    if (peakDay) l1 += '. Longest in one 0.5° cell: lightning in ' + peakDay.peak.hours + ' of ' + peakDay.samples + ' sampled hours near ' +
      latLon(Math.round(peakDay.peak.lat * 10) / 10, Math.round(peakDay.peak.lon * 10) / 10) + ' (' + peakDay.peak.area + ') on ' + fmtDay(peakDay.date);
    l1 += '.';
  }
  const gaps = (s.days || []).filter(d => d.missing).map(d => wd(d.date) + ' ' + d.missing);
  const e50 = s.coverage ? westEdge(s, 50.25) : null, e35 = s.coverage ? westEdge(s, 35.25) : null;
  const l2 = 'Not covered (no data, not calm): ' + (e50 != null && e35 != null && e50 > s.lon0 ? 'the Atlantic west of about ' + lonText(e50) + ' at 50N and ' + lonText(e35) + ' at 35N, Greenland, ' : 'the north-western Atlantic, ') +
    'north of 70N. ' +
    (fr.planned ? fr.read + ' of ' + fr.planned + ' hourly frames read' + (gaps.length ? ' (missing: ' + gaps.join(', ') + ')' : '') + '. ' : '') +
    (s.attribution || attributionFor(new Date().getUTCFullYear())) + '; ' + PAGES.viewer;
  const me = s.areas && s.areas.me, out = [l1, l2];
  if (me) {
    // The tropical edge of the frame (Sahel, Horn of Africa, India) is named apart, so the Middle East itself leads.
    const all = me.hotspots || [], mh = all.filter(h => !ME_EDGE_AREAS.includes(h.area)), edge = all.filter(h => ME_EDGE_AREAS.includes(h.area));
    out.push('SATELLITE LIGHTNING, MIDDLE EAST (same frames, 3–47N 14–70E; east of 70E no data): ' + (!all.length ? 'no lightning seen in the sampled frames.' :
      (mh.length ? 'most thunderstorm hours over ' + mh[0].area + ' on ' + fmtDay(mh[0].peakDate) + (mh.length > 1 ? '; also ' + mh.slice(1, 3).map(h => h.area + ' (' + fmtDay(h.peakDate) + ')').join(' and ') : '') : 'little lightning outside the tropical edge') +
      (edge.length ? '; at the tropical edge of the frame ' + edge.map(h => h.area).join(', ') : '') + '.'));
  }
  return out.join('\n');
}

module.exports = { WMS, LAYER, GRID, GRID_ME, FRAME, frameSize, unionUrl, boxUrl, PX_PER_CELL, FRAME_MINUTES, HOUR_ORDER, LI_BAND_V, LAYER_EXTENT, AREAS, PAGES,
                   rleEncode, rleDecode, westEdge, frameUrl, plannedFrames, scanAngles, onDisk, liCovered, coverageMask, litCells, areaOf, aggregate,
                   attributionFor, fetchLightning, digest, CACHE_VERSION, readCache, writeCache };
if (require.main === module) U.main('fetch-lightning', 'lightning', fetchLightning, digest);
