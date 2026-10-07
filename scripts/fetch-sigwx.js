#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-sigwx.js
// The official WAFS significant-weather forecast (SIGWX, FL100–FL600) as a vector layer for the
// dashboards' weather maps and a short prompt block: one chart per day at 12Z for the reporting week,
// and the latest run's 12Z charts for the week ahead (official SIGWX ends 48 h after its run, so only
// the first two days of the week ahead are covered).
//
// Source — anonymous, no key: NOAA/NWS Aviation Weather Center, the GeoJSON behind its SIGWX page
//   https://aviationweather.gov/data/products/autosigwx/YYYYMMDD/YYYYMMDD_HH_FNN_sigwx_hi_<TYPE>.geojson
//   TYPE = TURB, CB, ICING, JET, TROP, VOLC, TC, RAD (one file per hazard; AWC page script
//   /assets/index-BpYlHsf-.js). Runs 00/06/12/18Z, leads F06–F48 every 3 h, FL100–FL600, whole globe;
//   files appear about 5 h 30 min after the run (Last-Modified 05:30:44Z for the 00Z run); 30 days kept
//   (7 Sep → 200, 6 Sep → 404 on 2026-10-06). It is AWC's copy of the harmonised multi-timestep WAFS
//   SIGWX that both World Area Forecast Centres produce automatically from the same blended grids.
//   The files carry hazard data only — no issue time, no valid time, NO ORIGINATOR, no licence — and
//   the path is not part of the documented AWC Data API (no schema; it can change without notice).
//
// What is fetched (8 files per chart, one request each, 1.1 s apart start to start like
// fetch-wxreview.js; AWC asks for at most 100 a minute):
//   past week  — one chart per day valid 12Z. First choice the 06Z run +6 h: the shortest lead the
//                product has for 12Z, so the closest to the weather that actually occurred, and the
//                chart that was current at 12Z (published about 11:30Z). If that run is missing (404)
//                the 00Z run +12 h, then the previous day's 18Z run +18 h and 12Z run +24 h stand in.
//   week ahead — the newest run published at fetch time (run + 5 h 30 min; one or two older runs if
//                it is not there yet), its 12Z charts within T+6…T+48 from today on: always two days.
//                Days 3–7 of the week ahead have no official SIGWX from any free source (report §"The
//                weekly briefing gets 30 days back but only 48 hours ahead").
//   Measured on W40 (2026-10-06): 73 requests (one 404 stand-in), 2.32 MB, 79 s; snapshot 254 KB compact.
//
// Processing: longitudes normalised (the tropopause file spans −540° to +533°), copies at ±360°
// tested, exact duplicates dropped (some turbulence polygons come twice), CB outlines (closed lines)
// treated as areas. Each feature is clipped to the box of the map areas it touches (na 13–72N
// 170W–50W, atl 25–75N 80W–40E — Europe and North Atlantic share it — and me 3–47N 14E–82E; a feature
// in two areas is clipped to the box around both, so no seam runs through a map), simplified
// (Douglas–Peucker 0.1°) and rounded to 0.1°. Base/top FL are kept ("XXX" = below the FL100 floor),
// jets keep their speed points (FL, kt), the tropopause its contour heights.
//
// "Worst day" per area (report §Q8): index = turbulence MOD + 3 × SEV + 0.5 × (icing MOD + 3 × SEV)
// + CB area (FRQ CB twice), in 1,000 km² inside the area's box, from the unsimplified shapes. A method
// demonstration, not a validated hazard measure; the weights are the research proposal.
//
// Licence and wording: no issuing centre is stated in the data, so none is claimed (issuer 'not stated
// in the GeoJSON'; never print KKCI/EGRR or "issued by WAFC Washington/London"). If WAFC Washington
// made it, it is US government work that NWS says "may be used without charge for any lawful purpose"
// (weather.gov/disclaimer): no endorsement implied, our rendering not presented as official NWS
// material. Label "OFFICIAL · WAFS SIGWX"; "not for flight planning or operational use".
//
// On HTTP 403 or 429 the run stops asking at once (no retry), keeps what it has and says so.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const U = require('./fetch-util.js');

const NAME = 'fetch-sigwx', DIR = 'sigwx';
const HOST = 'aviationweather.gov';
const BASE = 'https://aviationweather.gov/data/products/autosigwx/';
const PAGES = {
  product: 'https://aviationweather.gov/sigwx/',
  help: 'https://aviationweather.gov/sigwx/help.html',
  disclaimer: 'https://www.weather.gov/disclaimer',
};
const LABEL = 'OFFICIAL · WAFS SIGWX';
const ATTRIBUTION = 'Official WAFS SIGWX forecast (FL100–600), issued by the World Area Forecast System (ICAO WAFS), ' +
  'data published by NOAA/NWS Aviation Weather Center (aviationweather.gov). Rendering by the LSY WX Relay; not an official NWS product.';
const DISCLAIMER = 'For situational awareness only — not for flight planning or operational use. Crews and dispatch use the official WAFC charts and SIGMETs.';
const ISSUER = 'not stated in the GeoJSON';
const ISSUER_NOTE = 'The files name no issuing centre (no KKCI/EGRR field); both World Area Forecast Centres generate this product from the same blended grids. ' +
  'Do not print KKCI or EGRR or "issued by WAFC Washington/London" next to it.';

// Source file type → contract kind. The order is the request order: turbulence first, it also tells
// whether a chart exists at all.
const TYPES = [['TURB', 'CAT'], ['CB', 'CB'], ['ICING', 'ICE'], ['JET', 'JET'], ['TROP', 'TROP'], ['VOLC', 'VA'], ['TC', 'TC'], ['RAD', 'RAD']];
const KIND_OF = TYPES.reduce((o, [t, k]) => (o[t] = k, o), {});
// The map areas' boxes (BUILD-R4 data shapes; Europe and North Atlantic share the frame 'atl').
const BOXES = {
  na:  { latS: 13, latN: 72, lonW: -170, lonE: -50 },
  atl: { latS: 25, latN: 75, lonW: -80, lonE: 40 },
  me:  { latS: 3, latN: 47, lonW: 14, lonE: 82 },
};
const AREA_IDS = ['na', 'atl', 'me'];
const AREA_NAMES = { na: 'North America', atl: 'North Atlantic / Europe', me: 'Middle East' };
const RES = 0.1;                    // coordinate rounding, degrees
const SIMPLIFY_DEG = 0.1;           // Douglas–Peucker tolerance, degrees
const LATENCY_MIN = 330;            // files appear about 5 h 30 min after the run
const PAST_CHOICES = [[0, 6, 6], [0, 0, 12], [-1, 18, 18], [-1, 12, 24]];   // [run day offset, run hour, lead] → valid 12Z
const MAX_LEAD = 48, MIN_LEAD = 6;
const GAP_MS = 1100;                // start to start, as fetch-wxreview.js for this host
const TIMEOUT_MS = 20000;
const WATCHDOG_S = (U.MAX_SECONDS && U.MAX_SECONDS[NAME]) || 180;
const SOFT_DEADLINE_S = WATCHDOG_S - 30;
const SCORE_WEIGHTS = { turbSev: 3, ice: 0.5, iceSev: 3, cbFrq: 2 };
const R_KM = 6371.0, DEG = Math.PI / 180;

// ---- small helpers -------------------------------------------------------------------------
const pad2 = n => String(n).padStart(2, '0');
const ymdc = ymd => ymd.replace(/-/g, '');
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = d => wd(d) + ' ' + (+d.slice(8, 10)) + ' ' + MON[+d.slice(5, 7) - 1];     // 'Wed 30 Sep'
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };
const rnd = v => Math.round(v / RES) * RES;
const r1 = v => Math.round(v * 10) / 10;
const stamp = ms => new Date(ms).toISOString().slice(0, 13) + 'Z';          // '2026-10-05T12Z'
const runMs = (ymd, hour) => Date.parse(ymd + 'T' + pad2(hour) + ':00:00Z');
const flNum = v => { const n = parseInt(v, 10); return Number.isFinite(n) && /^\s*\d+\s*$/.test(String(v)) ? n : null; };

function fileUrl(runYmd, runHour, lead, type) {
  const d = ymdc(runYmd);
  return BASE + d + '/' + d + '_' + pad2(runHour) + '_F' + pad2(lead) + '_sigwx_hi_' + type + '.geojson';
}
// The charts that stand for 12Z of one past day, best first.
function pastCandidates(date) {
  return PAST_CHOICES.map(([off, hour, lead]) => ({ runDate: U.addDays(date, off), hour, lead, date }));
}
// Runs that may be the newest one published at nowMs, newest first.
function aheadRuns(nowMs, n) {
  const t = nowMs - LATENCY_MIN * 60000;
  let r = Math.floor(t / (6 * 3600000)) * 6 * 3600000;
  const out = [];
  for (let i = 0; i < (n || 3); i++, r -= 6 * 3600000) { const iso = new Date(r).toISOString(); out.push({ runDate: iso.slice(0, 10), hour: +iso.slice(11, 13) }); }
  return out;
}
// A run's charts valid 12Z on fromYmd or later, within T+6…T+48.
function aheadSlices(run, fromYmd) {
  const r0 = runMs(run.runDate, run.hour), out = [];
  for (let lead = MIN_LEAD; lead <= MAX_LEAD; lead += 3) {
    const v = new Date(r0 + lead * 3600000).toISOString();
    if (v.slice(11, 13) === '12' && v.slice(0, 10) >= fromYmd) out.push({ runDate: run.runDate, hour: run.hour, lead, date: v.slice(0, 10) });
  }
  return out;
}

// ---- geometry (lon/lat in, [lon, lat] pairs inside, [lat, lon] out) -------------------------------
const shiftPts = (pts, s) => s ? pts.map(p => [p[0] + s, p[1]]) : pts;
function normalise(pts) {
  if (!pts.length) return pts;
  const m = pts.reduce((a, p) => a + p[0], 0) / pts.length, k = Math.round(m / 360);
  return shiftPts(pts, -360 * k);
}
const inBox = (p, b) => p[0] >= b.lonW && p[0] <= b.lonE && p[1] >= b.latS && p[1] <= b.latN;
const unionBox = ids => ids.reduce((u, id) => { const b = BOXES[id]; return u ? { latS: Math.min(u.latS, b.latS), latN: Math.max(u.latN, b.latN), lonW: Math.min(u.lonW, b.lonW), lonE: Math.max(u.lonE, b.lonE) } : Object.assign({}, b); }, null);
// Sutherland–Hodgman against a lon/lat rectangle. ring: open ring of [lon, lat]. Returns an open ring.
function clipPolygon(ring, b) {
  let p = ring;
  const edges = [
    [q => q[0] >= b.lonW, (a, c) => [b.lonW, a[1] + (b.lonW - a[0]) / (c[0] - a[0]) * (c[1] - a[1])]],
    [q => q[0] <= b.lonE, (a, c) => [b.lonE, a[1] + (b.lonE - a[0]) / (c[0] - a[0]) * (c[1] - a[1])]],
    [q => q[1] >= b.latS, (a, c) => [a[0] + (b.latS - a[1]) / (c[1] - a[1]) * (c[0] - a[0]), b.latS]],
    [q => q[1] <= b.latN, (a, c) => [a[0] + (b.latN - a[1]) / (c[1] - a[1]) * (c[0] - a[0]), b.latN]],
  ];
  for (const [inside, inter] of edges) {
    if (!p.length) break;
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], c = p[i], ia = inside(a), ic = inside(c);
      if (ic) { if (!ia) out.push(inter(a, c)); out.push(c); }
      else if (ia) out.push(inter(a, c));
    }
    p = out;
  }
  return p.length >= 3 ? p : [];
}
// Liang–Barsky per segment; returns the pieces of the line inside the rectangle.
function clipSegment(a, c, b) {
  let t0 = 0, t1 = 1;
  const dx = c[0] - a[0], dy = c[1] - a[1];
  const tests = [[-dx, a[0] - b.lonW], [dx, b.lonE - a[0]], [-dy, a[1] - b.latS], [dy, b.latN - a[1]]];
  for (const [p, q] of tests) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return { a: t0 > 0 ? [a[0] + t0 * dx, a[1] + t0 * dy] : a, c: t1 < 1 ? [a[0] + t1 * dx, a[1] + t1 * dy] : c, cut: t1 < 1 };
}
function clipLine(line, b) {
  const parts = [];
  let cur = null;
  for (let i = 1; i < line.length; i++) {
    const s = clipSegment(line[i - 1], line[i], b);
    if (!s) { if (cur) { parts.push(cur); cur = null; } continue; }
    if (cur && cur[cur.length - 1] === s.a) cur.push(s.c);
    else { if (cur) parts.push(cur); cur = [s.a, s.c]; }
    if (s.cut) { parts.push(cur); cur = null; }
  }
  if (cur) parts.push(cur);
  return parts.filter(p => p.length >= 2);
}
// Douglas–Peucker, iterative. pts: [x, y] pairs; a closed ring is passed with its first point repeated.
function segDist(p, a, c) {
  const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, c] = stack.pop();
    let dmax = 0, idx = -1;
    for (let i = a + 1; i < c; i++) { const d = segDist(pts[i], pts[a], pts[c]); if (d > dmax) { dmax = d; idx = i; } }
    if (idx > 0 && dmax > eps) { keep[idx] = 1; stack.push([a, idx], [idx, c]); }
  }
  return pts.filter((p, i) => keep[i]);
}
// [lon, lat] → rounded [lat, lon], consecutive duplicates removed.
function toOut(pts, closed) {
  const out = [];
  pts.forEach(p => { const q = [r1(rnd(p[1])), r1(rnd(p[0]))]; const l = out[out.length - 1]; if (!l || l[0] !== q[0] || l[1] !== q[1]) out.push(q); });
  if (closed && out.length > 1) { const f = out[0], l = out[out.length - 1]; if (f[0] === l[0] && f[1] === l[1]) out.pop(); }
  return out;
}
// Equal-area (Lambert cylindrical) shoelace, km². ring: [lon, lat].
function ringAreaKm2(ring) {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length], c = ring[i];
    s += (a[0] * DEG * R_KM) * (Math.sin(c[1] * DEG) * R_KM) - (c[0] * DEG * R_KM) * (Math.sin(a[1] * DEG) * R_KM);
  }
  return Math.abs(s) / 2;
}
// Area of a normalised ring inside a box, the copies at ±360° included.
function areaInBox(ring, b) {
  return [-360, 0, 360].reduce((a, s) => a + ringAreaKm2(clipPolygon(shiftPts(ring, s), b)), 0);
}
const centroid = pts => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];

// ---- one layer file → raw features ----------------------------------------------------------------
// Raw feature: { kind, geom:'polygon'|'line'|'point', pts:[[lon,lat]…] normalised, base, top, sev, cov,
// name, xxx, fl, kt, jet:[[lon,lat,kt,fl]…] }. Exact duplicates are dropped.
function parseLayer(type, gj) {
  const kind = KIND_OF[type], out = [], seen = new Set();
  let dup = 0;
  ((gj && gj.features) || []).forEach(f => {
    const g = f && f.geometry, pr = (f && f.properties) || {};
    if (!g || !g.coordinates) return;
    const key = JSON.stringify([g.type, g.coordinates, pr]);
    if (seen.has(key)) { dup++; return; }
    seen.add(key);
    let rings = [], geom;
    if (g.type === 'Polygon') { rings = [g.coordinates[0]]; geom = 'polygon'; }
    else if (g.type === 'MultiPolygon') { rings = g.coordinates.map(p => p[0]); geom = 'polygon'; }
    else if (g.type === 'LineString') { rings = [g.coordinates]; geom = kind === 'CB' ? 'polygon' : 'line'; }   // CB outlines are closed lines
    else if (g.type === 'MultiLineString') { rings = g.coordinates; geom = kind === 'CB' ? 'polygon' : 'line'; }
    else if (g.type === 'Point') { rings = [[g.coordinates]]; geom = 'point'; }
    else return;
    rings.forEach(r => {
      let pts = (r || []).filter(p => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).map(p => [+p[0], +p[1]]);
      if (geom === 'polygon' && pts.length > 1) { const a = pts[0], z = pts[pts.length - 1]; if (a[0] === z[0] && a[1] === z[1]) pts.pop(); }
      if ((geom === 'polygon' && pts.length < 3) || (geom === 'line' && pts.length < 2) || !pts.length) return;
      // Normalise by whole turns; jet speed points move with their line.
      const m = pts.reduce((a, p) => a + p[0], 0) / pts.length, sh = -360 * Math.round(m / 360);
      const rf = { kind, geom, pts: shiftPts(pts, sh), base: null, top: null };
      if (kind === 'CAT' || kind === 'ICE' || kind === 'CB') {
        rf.base = flNum(pr.base); rf.top = flNum(pr.top);
        if (String(pr.base || '').trim().toUpperCase() === 'XXX') rf.xxx = true;
      }
      if (kind === 'CAT' || kind === 'ICE') rf.sev = /sev/i.test(pr.severity) ? 'SEV' : /mod/i.test(pr.severity) ? 'MOD' : (pr.severity ? String(pr.severity).toUpperCase() : null);
      if (kind === 'CB') rf.cov = pr.extent ? String(pr.extent).toUpperCase() : null;
      if (kind === 'TROP') { rf.fl = flNum(pr.height); rf.base = rf.top = rf.fl; }
      if (kind === 'VA' || kind === 'TC' || kind === 'RAD') rf.name = pr.name ? String(pr.name).trim() : null;
      if (kind === 'JET') {
        rf.jet = (Array.isArray(pr.fleche) ? pr.fleche : []).filter(q => q && Number.isFinite(+q.lon) && Number.isFinite(+q.lat))
          .map(q => [+q.lon + sh, +q.lat, Number.isFinite(+q.speed) ? +q.speed : null, flNum(q.height)]);
        const top = rf.jet.filter(q => q[2] != null).sort((a, c) => c[2] - a[2])[0];
        rf.kt = top ? top[2] : null; rf.fl = top ? top[3] : null;
        const fls = rf.jet.map(q => q[3]).filter(v => v != null);
        rf.base = fls.length ? Math.min(...fls) : null; rf.top = fls.length ? Math.max(...fls) : null;
      }
      out.push(rf);
    });
  });
  return { features: out, duplicates: dup };
}

// ---- raw features → contract features, clipped per area -------------------------------------------
// Which area boxes a raw feature reaches (copies at ±360° included).
function touchedAreas(rf) {
  return AREA_IDS.filter(id => [-360, 0, 360].some(s => {
    const p = shiftPts(rf.pts, s), b = BOXES[id];
    if (rf.geom === 'point') return inBox(p[0], b);
    if (rf.geom === 'polygon') return clipPolygon(p, b).length >= 3;
    return clipLine(p, b).length > 0;
  }));
}
function outFeature(rf, outPts, inAreas, jetPts) {
  const f = { kind: rf.kind, base: rf.base, top: rf.top };
  const props = { in: inAreas };
  if (rf.sev) props.sev = rf.sev;
  if (rf.cov) props.cov = rf.cov;
  if (rf.xxx) props.xxx = true;
  if (rf.name) props.name = rf.name;
  if (rf.kind === 'TROP') f.fl = rf.fl;
  if (rf.kind === 'JET') {
    const pts = (jetPts || []).map(q => [r1(rnd(q[1])), r1(rnd(q[0])), q[2], q[3]]);
    const top = pts.filter(q => q[2] != null).sort((a, c) => c[2] - a[2])[0];
    if (top) { f.fl = top[3]; f.kt = top[2]; const fls = pts.map(q => q[3]).filter(v => v != null); f.base = Math.min(...fls); f.top = Math.max(...fls); }
    else { f.fl = rf.fl; f.kt = rf.kt; props.whole = true; }
    props.pts = pts;
  }
  f.geom = { type: rf.geom, coords: outPts };
  f.props = props;
  return f;
}
function clipFeature(rf) {
  const areas = touchedAreas(rf);
  if (!areas.length) return [];
  const region = unionBox(areas), out = [];
  [-360, 0, 360].forEach(s => {
    const p = shiftPts(rf.pts, s);
    if (rf.geom === 'point') { if (inBox(p[0], region)) out.push(outFeature(rf, toOut(p), areas.filter(id => inBox(p[0], BOXES[id])))); return; }
    if (rf.geom === 'polygon') {
      const c = clipPolygon(p, region);
      if (c.length < 3) return;
      const pts = toOut(simplify(c.concat([c[0]]), SIMPLIFY_DEG), true);
      if (pts.length < 3) return;
      out.push(outFeature(rf, pts, areas.filter(id => clipPolygon(c, BOXES[id]).length >= 3)));
      return;
    }
    clipLine(p, region).forEach(part => {
      const pts = toOut(simplify(part, SIMPLIFY_DEG));
      if (pts.length < 2) return;
      let jp = null;
      if (rf.jet) {
        const js = rf.jet.map(q => [q[0] + s, q[1], q[2], q[3]]);
        jp = js.filter(q => inBox(q, region) && part.some(v => Math.abs(v[0] - q[0]) + Math.abs(v[1] - q[1]) < 0.5));
      }
      out.push(outFeature(rf, pts, areas.filter(id => clipLine(part, BOXES[id]).length > 0), jp));
    });
  });
  return out;
}

// ---- worst-day score (research report §Q8) ---------------------------------------------------------
function scoreArea(raw, box) {
  const s = { turbMod: 0, turbSev: 0, iceMod: 0, iceSev: 0, cb: 0, cbTopMax: 0 };
  raw.forEach(rf => {
    if (rf.geom !== 'polygon' || !['CAT', 'ICE', 'CB'].includes(rf.kind)) return;
    const a = areaInBox(rf.pts, box);
    if (a <= 0) return;
    if (rf.kind === 'CB') { s.cb += a * (rf.cov === 'FRQ' ? SCORE_WEIGHTS.cbFrq : 1); if (rf.top) s.cbTopMax = Math.max(s.cbTopMax, rf.top); return; }
    const k = (rf.kind === 'CAT' ? 'turb' : 'ice') + (rf.sev === 'SEV' ? 'Sev' : 'Mod');
    s[k] += a;
  });
  const index = s.turbMod + SCORE_WEIGHTS.turbSev * s.turbSev + SCORE_WEIGHTS.ice * (s.iceMod + SCORE_WEIGHTS.iceSev * s.iceSev) + s.cb;
  const k = v => Math.round(v / 1000);   // 1,000 km²
  return { turbMod: k(s.turbMod), turbSev: k(s.turbSev), iceMod: k(s.iceMod), iceSev: k(s.iceSev), cb: k(s.cb), cbTopMax: s.cbTopMax || null, index: k(index) };
}
// The highest index per area among the given charts; ties go to the larger severe-turbulence area.
function worstOf(charts) {
  const w = {};
  AREA_IDS.forEach(id => {
    const best = charts.filter(c => c.score && c.score[id]).sort((a, b) => (b.score[id].index - a.score[id].index) || (b.score[id].turbSev - a.score[id].turbSev) || a.date.localeCompare(b.date))[0];
    if (best) w[id] = { date: best.date, valid: best.valid, index: best.score[id].index, turbSev: best.score[id].turbSev, cbTopMax: best.score[id].cbTopMax };
  });
  return w;
}

// ---- one chart: raw files → day entry ---------------------------------------------------------------
// files: { TURB: geojson|null, … } (null = missing). Returns the contract entry plus counts and scores.
function buildChart(slice, files) {
  const raw = [], counts = {}, missing = [];
  let duplicates = 0;
  TYPES.forEach(([t]) => {
    if (!files[t]) { missing.push(t); return; }
    const p = parseLayer(t, files[t]);
    duplicates += p.duplicates;
    p.features.forEach(f => raw.push(f));
  });
  const features = [];
  raw.forEach(rf => clipFeature(rf).forEach(f => features.push(f)));
  features.forEach(f => { counts[f.kind] = (counts[f.kind] || 0) + 1; });
  const score = {};
  AREA_IDS.forEach(id => { score[id] = scoreArea(raw, BOXES[id]); });
  const r0 = runMs(slice.runDate, slice.hour);
  const day = { date: slice.date, run: stamp(r0), valid: stamp(r0 + slice.lead * 3600000), lead: slice.lead, features, counts, score };
  if (missing.length) day.missing = missing;
  if (duplicates) day.duplicates = duplicates;
  return day;
}

// ---- plain-words places ------------------------------------------------------------------------------
// [name, latS, latN, lonW, lonE]; the first box that holds the point wins, so small ones come first.
const PLACES = [
  // Europe and the North Atlantic
  ['the Bay of Biscay', 43.3, 48.0, -10.0, -1.2], ['the Alps', 45.5, 48.0, 5.5, 16.5], ['the Black Sea', 40.9, 47.0, 27.5, 42.0],
  ['southern France and the Gulf of Lion', 42.3, 45.0, 2.5, 7.6], ['Iberia', 35.5, 43.8, -10.0, 3.5], ['the western Mediterranean', 35.5, 43.8, 3.5, 9.5],
  ['Italy and the central Mediterranean', 33.5, 45.5, 9.5, 19.5], ['Greece and the Aegean', 34.0, 42.0, 19.5, 28.0], ['the eastern Mediterranean', 30.5, 36.5, 19.5, 36.0],
  ['the Adriatic and the Balkans', 42.0, 48.5, 13.0, 27.5], ['France', 42.3, 51.2, -1.2, 8.2], ['the British Isles', 49.5, 61.0, -11.0, 2.0],
  ['the North Sea', 51.0, 61.0, 2.0, 8.5], ['Germany and the Benelux', 47.0, 55.5, 2.0, 15.5], ['Scandinavia and the Baltic', 54.0, 71.0, 4.0, 32.0],
  ['Turkey', 36.0, 42.2, 26.0, 45.0], ['eastern Europe', 44.0, 60.0, 15.5, 40.0], ['western Russia', 47.0, 75.0, 32.0, 60.0],
  ['Iceland', 63.0, 67.0, -25.0, -13.0], ['south of Iceland', 55.0, 63.0, -32.0, -11.0], ['the Norwegian Sea', 61.0, 75.0, -13.0, 15.0],
  ['the Azores', 35.0, 42.0, -33.0, -22.0], ['the Atlantic off Portugal and Morocco', 25.0, 43.3, -22.0, -9.0], ['the eastern North Atlantic', 43.3, 55.0, -32.0, -9.0],
  ['Greenland', 59.0, 84.0, -75.0, -20.0], ['the Labrador Sea', 52.0, 63.0, -64.0, -45.0], ['off Newfoundland', 42.0, 52.0, -60.0, -45.0],
  ['the central North Atlantic', 25.0, 61.0, -50.0, -22.0], ['the Denmark Strait', 61.0, 72.0, -45.0, -20.0],
  // North America
  ['Hawaii', 17.0, 24.0, -162.0, -153.0], ['the Aleutians', 49.0, 55.0, -180.0, -160.0], ['the Bering Sea', 55.0, 66.0, -180.0, -162.0], ['the Gulf of Alaska', 50.0, 60.0, -155.0, -135.0],
  ['Alaska', 51.0, 72.0, -170.0, -130.0], ['the Bahamas', 21.0, 27.5, -80.0, -72.0], ['Florida', 24.5, 31.0, -87.5, -80.0],
  ['the Gulf of Mexico', 18.0, 30.5, -98.0, -81.0], ['the Caribbean', 9.0, 22.0, -88.0, -59.0], ['Central America', 7.0, 18.0, -93.0, -77.0],
  ['Mexico', 14.0, 32.7, -118.0, -86.0], ['California', 32.5, 42.0, -125.0, -114.0], ['British Columbia and the Pacific Northwest', 42.0, 60.0, -135.0, -114.0],
  ['the US Southwest', 31.0, 37.0, -114.0, -103.0], ['the Rockies', 37.0, 49.0, -114.0, -102.0], ['Texas', 25.8, 36.5, -106.6, -93.5],
  ['the Great Plains', 30.0, 49.0, -104.0, -94.0], ['the Great Lakes', 41.0, 49.0, -92.0, -76.0], ['the Midwest', 36.0, 49.0, -97.0, -80.5],
  ['the US Southeast', 25.0, 36.5, -94.0, -75.0], ['the US Northeast', 36.5, 47.5, -80.5, -66.5], ['the Canadian Maritimes', 43.0, 52.0, -67.0, -52.0],
  ['Quebec and Ontario', 45.0, 62.0, -95.0, -57.0], ['Hudson Bay', 51.0, 66.0, -95.0, -76.0], ['the Canadian Prairies', 49.0, 60.0, -120.0, -95.0],
  ['northern Canada', 60.0, 84.0, -141.0, -60.0], ['the North Pacific', 13.0, 55.0, -180.0, -117.0], ['off the US East Coast', 25.0, 42.0, -75.0, -60.0],
  ['the western North Atlantic', 13.0, 55.0, -80.0, -50.0],
  // Middle East
  ['the Persian Gulf', 23.5, 30.5, 47.5, 57.0], ['Yemen', 12.0, 16.5, 42.0, 54.0], ['Oman', 16.5, 26.5, 52.0, 60.0],
  ['the Red Sea', 13.0, 27.0, 33.0, 43.0], ['the Levant', 29.0, 37.5, 34.0, 38.8], ['Iraq', 29.0, 37.5, 38.8, 48.6], ['Egypt', 22.0, 31.7, 24.7, 36.9],
  ['Saudi Arabia', 16.0, 32.0, 36.0, 56.0], ['the Caucasus', 39.0, 44.0, 38.0, 50.0], ['the Caspian Sea', 36.5, 47.0, 46.5, 55.0],
  ['Iran', 25.0, 40.0, 44.0, 63.5], ['Afghanistan and Pakistan', 23.5, 38.5, 60.5, 77.0], ['Central Asia', 35.0, 47.0, 52.0, 82.0],
  ['the Arabian Sea', 5.0, 25.0, 55.0, 73.0], ['northern India', 20.0, 35.0, 68.0, 90.0], ['southern India and Sri Lanka', 3.0, 20.0, 73.0, 82.0],
  ['the Horn of Africa', 3.0, 15.0, 38.0, 52.0], ['north-east Africa', 3.0, 23.0, 14.0, 38.0], ['the Indian Ocean', 3.0, 12.0, 52.0, 82.0],
  ['North Africa', 15.0, 35.5, -17.0, 37.0],
];
const latLonText = (lat, lon) => Math.round(Math.abs(lat)) + (lat < 0 ? 'S ' : 'N ') + Math.round(Math.abs(lon)) + (lon < 0 ? 'W' : 'E');
function placeOf(lat, lon) {
  const p = PLACES.find(([, s, n, w, e]) => lat >= s && lat < n && lon >= w && lon < e);
  return p ? p[0] : 'near ' + latLonText(lat, lon);
}
// 'over the Bay of Biscay', but 'south of Iceland', 'off Newfoundland', 'near 50N 170W' as they are.
const overPlace = (lat, lon) => { const n = placeOf(lat, lon); return /^(off|near|south of|north of|east of|west of) /.test(n) ? n : 'over ' + n; };

// ---- digest -----------------------------------------------------------------------------------------
const flRange = f => f.base != null && f.top != null ? 'FL' + pad3(f.base) + '–' + pad3(f.top) : f.top != null ? 'up to FL' + pad3(f.top) : '';
function pad3(n) { return String(n).padStart(3, '0'); }
// Area of an output polygon (coords [lat, lon]) in km².
const featArea = f => ringAreaKm2(f.geom.coords.map(c => [c[1], c[0]]));
const featPlace = f => { const c = centroid(f.geom.coords); return overPlace(c[0], c[1]); };
// The map area a feature is told under: the box that holds its representative point (a jet's fastest
// point, an area's centroid), else the first area it touches. Where boxes overlap, west of 60W counts as
// North America and the Mediterranean/Turkey (west of 30E or north of 40N) as North Atlantic/Europe.
const AREA_ORDER = ['atl', 'na', 'me'];
const AREA_SHORT = { atl: 'NAT/Europe', na: 'North America', me: 'Middle East' };
const jetPoint = j => (j.props.pts || []).find(q => q[2] === j.kt) || j.geom.coords[Math.floor(j.geom.coords.length / 2)];
const repPoint = f => f.kind === 'JET' ? jetPoint(f) : f.geom.type === 'point' ? f.geom.coords[0] : centroid(f.geom.coords);
function homeArea(f) {
  const p = repPoint(f), q = [p[1], p[0]], ins = (f.props && f.props.in) || [];
  const hit = AREA_ORDER.filter(id => ins.includes(id) && inBox(q, BOXES[id]));
  if (hit.includes('atl') && hit.includes('na')) return q[0] < -60 ? 'na' : 'atl';
  if (hit.includes('atl') && hit.includes('me')) return q[0] < 30 || q[1] >= 40 ? 'atl' : 'me';
  return hit[0] || ins[0] || null;
}
// The main features of one chart in plain words, one segment per map area: the strongest jet, the
// worst turbulence (SEV, else MOD reaching FL250) and the highest CB top. Icing stays on the map.
function chartLine(day) {
  const fs_ = day.features || [], segs = [];
  const big = list => list.map(f => ({ f, a: featArea(f) })).sort((x, y) => y.a - x.a);
  AREA_ORDER.forEach(id => {
    const mine = fs_.filter(f => homeArea(f) === id), parts = [];
    const j = mine.filter(f => f.kind === 'JET' && f.kt != null).sort((a, b) => b.kt - a.kt)[0];
    if (j) { const at = jetPoint(j); parts.push('jet FL' + pad3(j.fl) + ' ' + j.kt + ' kt ' + overPlace(at[0], at[1])); }
    const turb = mine.filter(f => f.kind === 'CAT' && f.geom.type === 'polygon');
    const sev = big(turb.filter(f => f.props.sev === 'SEV')), mod = big(turb.filter(f => f.props.sev !== 'SEV' && (f.top == null || f.top >= 250)));
    if (sev.length) parts.push('SEV turbulence ' + flRange(sev[0].f) + ' ' + featPlace(sev[0].f) + (sev.length > 1 ? ' (+' + (sev.length - 1) + ')' : ''));
    else if (mod.length) parts.push('MOD turbulence ' + flRange(mod[0].f) + ' ' + featPlace(mod[0].f));
    const cbs = mine.filter(f => f.kind === 'CB' && f.top != null).sort((a, b) => b.top - a.top || featArea(b) - featArea(a));
    if (cbs.length) {
      const cov = cbs[0].props.cov && cbs[0].props.cov !== 'OCNL' ? cbs[0].props.cov + ' ' : '';
      parts.push(cov + 'CB tops FL' + pad3(cbs[0].top) + ' ' + featPlace(cbs[0]));
    }
    segs.push(AREA_SHORT[id] + ': ' + (parts.length ? parts.join(', ') : 'nothing in FL100–600'));
  });
  const named = k => [...new Set(fs_.filter(f => f.kind === k && f.props.name).map(f => f.props.name + ' (' + placeOf(f.geom.coords[0][0], f.geom.coords[0][1]) + ')'))];
  const tc = named('TC');
  if (tc.length) segs.push('tropical cyclone ' + tc.join(', '));
  const runH = day.run ? day.run.slice(11, 13) + 'Z +' + day.lead + ' h' : '';
  return fmtDay(day.date) + ' 12Z (' + runH + ') — ' + segs.join('; ') +
    (day.missing && day.missing.length ? ' [files missing: ' + day.missing.join(', ') + ' — no data, not calm]' : '') + '.';
}
function digest(s) {
  const L = [], w = s.window || {}, days = s.days || [], ahead = s.ahead || [], cov = s.aheadCover || {};
  L.push('OFFICIAL WAFS SIGWX (FL100–600; one chart per day valid 12Z, past days from the 06Z run +6 h, the shortest lead; per map area the strongest jet, ' +
    'the worst turbulence and the highest CB top — icing, tropopause and all other areas are on the map). ' + (s.disclaimer || DISCLAIMER));
  if (!days.length) L.push('Reporting week ' + (w.from || '') + '–' + (w.to || '') + ': no chart could be read.');
  days.forEach(d => L.push(chartLine(d)));
  // Volcano and radiation markers barely move: once for the whole fortnight, not on every line.
  const markers = k => [...new Set(days.concat(ahead).flatMap(d => (d.features || []).filter(f => f.kind === k && f.props.name)
    .map(f => f.props.name + ' (' + placeOf(f.geom.coords[0][0], f.geom.coords[0][1]) + ')')))];
  const va = markers('VA'), rad = markers('RAD');
  if (va.length || rad.length) L.push('Markers on the charts: ' + [va.length ? 'volcano ' + va.join(', ') : '', rad.length ? 'radiation ' + rad.join(', ') : ''].filter(Boolean).join('; ') + '.');
  const wo = s.worst || {};
  const wl = AREA_IDS.filter(id => wo[id]).map(id => AREA_NAMES[id] + ' ' + fmtDay(wo[id].date) + ' (index ' + wo[id].index + (wo[id].turbSev ? ', SEV turbulence ' + wo[id].turbSev : '') + ')');
  if (wl.length) L.push('Worst day by area (index = turbulence MOD + 3×SEV + ½ × icing (MOD + 3×SEV) + CB area, 1,000 km² in the map box): ' + wl.join('; ') + '.');
  if (ahead.length) {
    L.push('WEEK AHEAD (run ' + (cov.run || ahead[0].run) + ', forecast):');
    ahead.forEach(d => L.push(chartLine(d)));
  }
  L.push((cov.note || 'Week ahead: no official SIGWX chart could be read.') + ' Days without a chart have no official SIGWX — not calm.');
  (s.notes || []).slice(0, 3).forEach(n => L.push('Note: ' + n));
  L.push((s.attribution || ATTRIBUTION) + ' Issuing centre ' + (s.issuer || ISSUER) + '. ' + PAGES.product);
  return L.join('\n');
}

// ---- fetch ------------------------------------------------------------------------------------------
// One GET through fetch-util (project identity). No retry on 403/429; one retry on a timeout or 5xx.
async function getLayer(url, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await U.getText(url, { accept: 'application/geo+json, application/json', timeoutMs: timeoutMs || TIMEOUT_MS, retries: 0 });
      return { status: 200, text };
    } catch (e) {
      const m = String(e.message || e), st = /HTTP (\d{3})/.exec(m);
      const status = st ? +st[1] : 0;
      if (status && status < 500) return { status, error: m };
      if (attempt) return { status, error: m };
      await U.sleep(2000);
    }
  }
}

// aheadOnly (the public week-ahead relay, tools/wx-relay): skip the past week entirely, so only the
// newest run's ahead charts are requested (about 16 instead of about 73 requests). Absent = unchanged.
async function fetchSigwx({ from, to, nowMs, gapMs, asOf, aheadOnly }) {   // nowMs, gapMs: tests only
  const t0 = Date.now(), now = nowMs != null ? nowMs : (asOf ? Date.parse(asOf) : Date.now());
  const gap = gapMs != null ? gapMs : GAP_MS;
  const notes = [], requests = {}, status = {};
  let bytes = 0, stopped = null, lastStart = 0;
  const archiveFrom = U.addDays(new Date(now).toISOString().slice(0, 10), -29);
  async function get(url) {
    if (stopped) return { status: -1 };
    if ((Date.now() - t0) / 1000 > SOFT_DEADLINE_S) { stopped = 'time budget of ' + SOFT_DEADLINE_S + ' s used up'; return { status: -1 }; }
    const wait = lastStart + gap - Date.now();
    if (wait > 0) await U.sleep(wait);
    lastStart = Date.now();
    requests[HOST] = (requests[HOST] || 0) + 1;
    const r = await getLayer(url);
    status[r.status] = (status[r.status] || 0) + 1;
    if (r.status === 200) bytes += Buffer.byteLength(r.text);
    if (r.status === 403 || r.status === 429) {
      stopped = HOST + ' answered HTTP ' + r.status;
      notes.push('AWC: HTTP ' + r.status + ' on ' + url.replace(BASE, '…/autosigwx/') + ' — stopped asking at once (no retry); charts not yet read are missing');
    }
    return r;
  }
  // One chart: TURB first (does the chart exist?), then the other seven files.
  async function readChart(slice) {
    const files = {};
    for (const [t] of TYPES) {
      const r = await get(fileUrl(slice.runDate, slice.hour, slice.lead, t));
      if (r.status === -1) return null;
      if (r.status === 404 && t === 'TURB') return { absent: true };
      if (r.status !== 200) { files[t] = null; if (r.status !== 404) notes.push('AWC: ' + t + ' ' + slice.runDate + ' ' + pad2(slice.hour) + 'Z F' + pad2(slice.lead) + ' — ' + (r.error || 'HTTP ' + r.status)); continue; }
      try { files[t] = JSON.parse(r.text); } catch (e) { files[t] = null; notes.push('AWC: ' + t + ' ' + slice.runDate + ' ' + pad2(slice.hour) + 'Z F' + pad2(slice.lead) + ' is not JSON'); }
    }
    return { files };
  }

  // Past week: one chart per day, valid 12Z.
  const days = [], gaps = [];
  for (const date of (aheadOnly ? [] : daysOf(from, to))) {
    if (date < archiveFrom) { gaps.push(date + ' (older than the 30-day archive)'); continue; }
    let got = null;
    for (const c of pastCandidates(date)) {
      if (runMs(c.runDate, c.hour) + LATENCY_MIN * 60000 > now) continue;
      const r = await readChart(c);
      if (!r) break;
      if (r.absent) continue;
      got = buildChart(c, r.files);
      if (c.hour !== 6) notes.push(fmtDay(date) + ': 06Z run +6 h not on the server; used the ' + pad2(c.hour) + 'Z run +' + c.lead + ' h');
      break;
    }
    if (got) days.push(got); else gaps.push(date + (stopped ? ' (' + stopped + ')' : ' (no run found)'));
  }
  // Week ahead: the newest published run, its 12Z charts from today on.
  const aheadFrom = new Date(now).toISOString().slice(0, 10);
  const ahead = [];
  let aheadRun = null;
  for (const run of aheadRuns(now, 3)) {
    if (stopped) break;
    const slices = aheadSlices(run, aheadFrom);
    if (!slices.length) continue;
    const first = await readChart(slices[0]);
    if (!first) break;
    if (first.absent) { notes.push('week ahead: run ' + run.runDate + ' ' + pad2(run.hour) + 'Z not published yet; tried the one before'); continue; }
    aheadRun = run;
    ahead.push(buildChart(slices[0], first.files));
    for (const sl of slices.slice(1)) {
      const r = await readChart(sl);
      if (!r) break;
      if (r.absent) { notes.push('week ahead: ' + sl.date + ' 12Z (+' + sl.lead + ' h) missing on the server'); continue; }
      ahead.push(buildChart(sl, r.files));
    }
    break;
  }
  if (!days.length && !ahead.length) throw new Error(stopped ? stopped : 'no SIGWX chart found (' + Object.entries(status).map(([k, n]) => 'HTTP ' + k + ' ×' + n).join(', ') + ')');
  if (gaps.length) notes.push('no chart for ' + gaps.join(', ') + ' — no data, not calm');

  // Coverage of the week ahead: the run's T+48 is the end.
  let aheadCover;
  const weekAhead = daysOf(aheadFrom, U.addDays(aheadFrom, 6));
  if (aheadRun) {
    const r0 = runMs(aheadRun.runDate, aheadRun.hour), until = stamp(r0 + MAX_LEAD * 3600000);
    const covered = ahead.map(d => d.date), notCovered = weekAhead.filter(d => !covered.includes(d));
    aheadCover = { run: stamp(r0), until, days: covered, notCovered,
      note: 'Week ahead: official SIGWX from the ' + stamp(r0).slice(11) + ' run of ' + fmtDay(aheadRun.runDate) + ' reaches T+48 (' + fmtDay(until.slice(0, 10)) + ' ' + until.slice(11) + '); ' +
            'charts for ' + covered.map(fmtDay).join(' and ') + ' 12Z. ' + (notCovered.length ? fmtDay(notCovered[0]) + '–' + fmtDay(notCovered[notCovered.length - 1]) + ' (days ' + (weekAhead.indexOf(notCovered[0]) + 1) + '–7) are NOT covered: no official SIGWX beyond 48 h (use the model-derived layer, labelled as such).' : '') };
  } else {
    aheadCover = { run: null, until: null, days: [], notCovered: weekAhead, note: 'Week ahead: no official SIGWX chart could be read; days 1–7 are not covered.' };
    notes.push('week ahead: no run found');
  }
  const dupes = days.concat(ahead).reduce((a, d) => a + (d.duplicates || 0), 0);
  const out = {
    source: 'WAFS SIGWX (harmonised multi-timestep product, FL100–600) — NOAA/NWS Aviation Weather Center GeoJSON, ' + BASE + '…',
    label: LABEL, attribution: ATTRIBUTION, disclaimer: DISCLAIMER, issuer: ISSUER, issuerNote: ISSUER_NOTE, pages: PAGES,
    licence: 'If made by WAFC Washington: US government work, "may be used without charge for any lawful purpose" (' + PAGES.disclaimer + '); ' +
             'the originator is not stated in the files. No NOAA/NWS endorsement implied; no KKCI/EGRR codes or NOAA/NWS logos on our rendering.',
    product: { band: [100, 600], runs: ['00Z', '06Z', '12Z', '18Z'], leads: 'T+6 to T+48 every 3 h', archiveDays: 30, publishedAfterRun: '≈ 5 h 30 min',
               usable: 'a fixed-time chart is usable ±3 h around its valid time (WAFC guide)', url: BASE + 'YYYYMMDD/YYYYMMDD_HH_FNN_sigwx_hi_<TYPE>.geojson' },
    choice: 'past days: one chart valid 12Z, from the 06Z run +6 h (the shortest lead, so the closest to what happened, and the chart current at 12Z); ' +
            'stand-ins 00Z +12 h, previous 18Z +18 h, previous 12Z +24 h. Week ahead: newest published run, its 12Z charts within T+6…T+48.',
    areas: AREA_IDS, boxes: BOXES,
    format: 'features[]: { kind JET|TROP|CAT|ICE|CB|VA|TC|RAD, base, top (FL; null = not given — props.xxx = "XXX" in the source = below the FL100 floor), fl?, kt?, ' +
            'geom {type line|polygon|point, coords [[lat, lon], …] rounded to 0.1°; polygon rings open}, props {in: map areas touched, sev MOD|SEV, cov ISOL|OCNL|FRQ, name, ' +
            'pts (jets: [[lat, lon, kt, FL], …] speed points), whole (jet fl/kt describe the whole jet)} }. CAT = WAFS "turbulence" (clear-air, in-cloud and mountain-wave). ' +
            'JET base/top = lowest/highest core FL along the jet (not its depth). TROP fl = tropopause contour height. Clipped to the box of the areas touched, Douglas–Peucker ' + SIMPLIFY_DEG + '°.',
    scoring: { formula: 'turbulence MOD + 3 × SEV + 0.5 × (icing MOD + 3 × SEV) + CB area (FRQ × 2)', units: '1,000 km² inside the area box', weights: SCORE_WEIGHTS,
               note: 'research proposal, a method demonstration, not a validated hazard measure' },
    days, ahead, aheadCover, worst: worstOf(days), worstAhead: worstOf(ahead),
    requests, httpStatus: status, megabytes: Math.round(bytes / 10485.76) / 100, bytesRead: bytes, notes,
  };
  if (dupes) out.duplicatesDropped = dupes;
  if (aheadOnly) out.aheadOnly = true;
  out.seconds = Math.round((Date.now() - t0) / 1000);
  out.snapshotBytes = Buffer.byteLength(JSON.stringify(out));
  const nf = d => d.features.length;
  out.summary = [from + ' .. ' + to + ' · ' + days.length + ' past chart(s) (' + days.map(d => d.date.slice(5) + ' ' + d.run.slice(11) + '+' + d.lead).join(', ') + ') · ' +
                 ahead.length + ' ahead (' + (aheadCover.run || 'none') + ') · ' + days.concat(ahead).reduce((a, d) => a + nf(d), 0) + ' features · ' +
                 (requests[HOST] || 0) + ' requests, ' + out.megabytes + ' MB, ' + out.seconds + ' s · snapshot ' + Math.round(out.snapshotBytes / 1024) + ' KB'];
  return out;
}

// U.main writes the snapshot pretty-printed; coordinate arrays then take four lines a point. Rewritten
// compactly (same temporary-name-and-rename rule), as BUILD-R4 asks for weather snapshots.
function rewriteCompact(week) {
  const p = require('path').join(U.ROOT, 'data', DIR, 'week-' + week + '.json');
  try {
    const s = JSON.parse(fs.readFileSync(p, 'utf8')), tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, p);
    console.log(NAME + ': written compactly, ' + Math.round(fs.statSync(p).size / 1024) + ' KB');
  } catch (e) { /* nothing written by this run, or unreadable: leave it */ }
}

module.exports = { BASE, TYPES, BOXES, AREA_IDS, PLACES, PAGES, LABEL, ATTRIBUTION, DISCLAIMER, ISSUER,
                   fileUrl, pastCandidates, aheadRuns, aheadSlices, normalise, clipPolygon, clipLine, simplify, toOut, ringAreaKm2, areaInBox,
                   parseLayer, touchedAreas, clipFeature, scoreArea, worstOf, buildChart, placeOf, homeArea, chartLine, digest, fetchSigwx };
if (require.main === module) {
  const c = U.cli(process.argv);
  const asOf = c.argOf('--asof');
  U.main(NAME, DIR, o => fetchSigwx(Object.assign({}, o, asOf ? { asOf } : {})), digest).then(() => { if (!c.has('--print-digest') && c.week) rewriteCompact(c.week); });
}
