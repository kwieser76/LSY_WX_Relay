#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-wxreview.js
// Reads what the weather actually DID in the reporting week before the research run and hands over
// a short "weather week in review" block: the SIGMETs in force over Europe, the North Atlantic and
// the rest of the world (thunderstorms, severe turbulence and mountain waves, icing, volcanic ash,
// tropical cyclones), the weather at a list of hubs (empty in this relay copy), the US convective SIGMETs and
// the US storm reports.
//
// Why: EUROCONTROL and the FAA name weather as the main delay cause most weeks, but say little about
// what the weather was. This block gives the days, the places and the phenomena, so the briefing can
// explain the delay figures instead of only reporting them. It is the sibling of fetch-wxoutlook.js
// (the week ahead); this one is events, never forecasts.
//
// Sources — all anonymous, no key:
//   NOAA AWC Data API, international SIGMETs, https://aviationweather.gov/api/data/isigmet
//     Each call returns every SIGMET valid at the requested moment, worldwide, decoded (FIR, hazard,
//     qualifier, levels, validity, raw text). The reporting week is sampled every 3 h (Mon 00Z ..
//     Sun 21Z, 56 calls, at least 1.1 s apart; the API allows 100/min) and de-duplicated by the
//     SIGMET line ("LFRR SIGMET T01 VALID 280100/280400 LFPW-"), so corrections count once and
//     cancellations are left out. A SIGMET valid for less than 3 h between two samples can be
//     missed. The database keeps 30 days, hence the backfill limit.
//     Measured 2026-10-05 on W40: no SIGMET at all from the German, Swiss, Austrian, Benelux or
//     Czech FIRs in a month of samples, while France, Spain, the UK and Poland appear: a gap in
//     the feed, said so in the digest so that "none" is not read as calm weather.
//   Iowa Environmental Mesonet (IEM), Iowa State University:
//     METAR archive  https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py — one request for
//                    the hubs of fetch-wxoutlook.js (present weather, visibility, gusts).
//     SIGMET archive https://mesonet.agron.iastate.edu/cgi-bin/request/gis/sigmets.py — the US
//                    convective SIGMETs (reissued hourly, so a count is SIGMET-hours) and the US
//                    oceanic SIGMETs (the US oceanic FIRs of the Atlantic, the Gulf, the Caribbean and the Pacific).
//     IEM throttles to one request per second per IP; this file paces at 1.2 s.
//     "The materials found on this website are in the public domain" (mesonet.agron.iastate.edu/disclaimer.php).
//   NOAA SPC storm reports, https://www.spc.noaa.gov/climo/reports/YYMMDD_rpts_filtered.csv — one
//     file per convective day (12Z to 11:59Z next day), preliminary; wind in mph, hail in 1/100 in.
//   NOAA GFS analyses (f000, 00Z of each day) of the wind at 300, 250 and 200 hPa (≈ FL300, FL340,
//     FL390) and of the tropopause, max-wind level and 0 °C isotherm via the NOMADS grib filter, the
//     same service fetch-wxoutlook.js reads: one request per day, about 270 KB, box 25–75N 80W–40E.
//     NOMADS keeps about ten days of cycles. A day it no longer has is read from NOAA's open-data archive
//     of the same GFS files on AWS (noaa-gfs-bdp-pds, kept for years; "open to the public and can be used
//     as desired"): the .idx inventory, then HTTP Range for exactly the messages the NOMADS request asks
//     for, complex packing unpacked by grib-complex.js (cross-checked 2026-10-06: identical to NOMADS at
//     260 points). PO decision 2026-10-06, so a run later in the week still gets the whole week.
//   NOAA AWC Data API, pilot and aircraft reports, https://aviationweather.gov/api/data/pirep — one
//     call per day (inten=mod: moderate or worse) over the map frame 25–75N 80W–40E, after the SIGMET
//     samples on the same pacing. At most 400 reports per answer (W40: 34–98 a day). Callsigns
//     (AIREPs carry them in acType), aircraft types, stations and raw texts are dropped before the
//     snapshot is written. Airline AIREPs are third-party content: internal review only, like the SIGMETs.
// Map layers for the dashboards, all from data already read except the PIREPs: `sigmetGrid` (the share
// of the 3-hourly samples each 1° cell lay inside a SIGMET, per hazard, Europe + North Atlantic) with
// `sigmetGrid.days` (the same per day, plus the distinct SIGMETs in force that day), `jet` (the day's
// wind at 300 / 250 / 200 hPa on a 2° grid), `levels` (tropopause, max-wind and freezing level as
// flight levels on the jet's grid; reducer shared with fetch-wxoutlook.js) and `pireps` (one row per
// report and kind). Grids are compact strings, not number arrays: the snapshot is written
// pretty-printed, one array element per line, which would make them ~200 KB a week.
// NOAA/NWS content is public domain (https://www.weather.gov/disclaimer). The foreign SIGMETs in the
// AWC feed are ICAO/WMO operational messages of the issuing met services, used here for internal
// review only.
//
// Measured 2026-10-06 on W40: 79 requests (aviationweather.gov 63, IEM 2, SPC 7, NOMADS 7) in 72 s, see the
// summary line; of the 259 KB snapshot sigmetGrid 19.4 KB (13.5 KB of it per day), jet 49.6 KB, levels 46 KB,
// pireps 43 KB (399 rows; 19 KB if it were written without the pretty-printing).
//
// Round 4 (2026-10-06): two more map frames, North America (13–72N 170W–50W) and the Middle East (3–47N
// 14E–82E). The top-level grids stay the Europe/NAT ('atl') grids, byte for byte in shape; the new frames sit
// under `areas`: jet.areas.na/me and levels.areas.na/me (the same GFS answers, one wider NOMADS box 4–75N
// 170W–82E per day instead of 25–75N 80W–40E), sigmetGrid.areas.na/me with days (the same AWC samples; the NA
// grid adds the US convective SIGMETs in force at each sample moment, from the IEM archive now read as KML
// with polygons instead of CSV — the US oceanic ones come from AWC only), sigmets.regions.na/me and
// sigmetGrid.days[].counts.na/me (overlapping the old regions: FIR prefix and area box), DS (dust or sand
// storm) as a hazard key when the feed carries one, spc.reports (the storm reports as points), pireps.areas.na
// (IEM PIREP archive, ONE request a week instead of 28 AWC calls: rows of moderate-to-severe or worse, a 1°
// count grid per day of moderate), and more hubs (North America, Middle East; list in
// fetch-wxoutlook.js, empty in this relay copy) with the 2 m temperature, dust/sand and haze hours (heat, dust and haze flags for the
// NA/ME hubs; Europe's flags as before). The snapshot is written compactly (no indentation).
// IEM PIREP archive https://mesonet.agron.iastate.edu/cgi-bin/request/gis/pireps.py — "you must request 120
// days or less of data at one time if you do not filter the request" (its help page); public domain like the
// rest of IEM. US-format PIREPs only (no airline AIREPs); aircraft types and raw texts dropped as for AWC.
// ---------------------------------------------------------------------------
'use strict';

const U = require('./fetch-util.js');

const WX = require('./fetch-wxoutlook.js');      // GRIB2 decoder, binary GET, jet-grid reducer (shared with the outlook)

const AWC_URL = stamp => 'https://aviationweather.gov/api/data/isigmet?format=json&date=' + stamp;
const NOMADS = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';
// The GFS analysis (f000) of one 00Z cycle, u/v for the jet map box; levels in hPa (default 250 only).
// The run asks for 300, 250 and 200 hPa in the one request per day (FL300 / FL340 / FL390), and with
// withLevels also HGT/ICAHT at the tropopause, max-wind level, 0 °C isotherm and 850/700/500 hPa for
// the flight-level grids (same request; about 270 KB instead of 50 KB).
// One box around the grid points of every map frame (Europe/NAT, North America, Middle East): 4–75N 170W–82E.
const GFS_BOX = (() => { const gs = [WX.JET_GRID].concat(Object.values(WX.AREA_JET_GRID));
  return { top: Math.max(...gs.map(g => g.latMax)), bottom: Math.min(...gs.map(g => g.lat0)), left: Math.min(...gs.map(g => g.lon0)), right: Math.max(...gs.map(g => g.lonMax)) }; })();
const gfsAnalysisUrl = (ymd, levels, withLevels) => NOMADS + '?dir=' + encodeURIComponent('/gfs.' + ymd.replace(/-/g, '') + '/00/atmos') + '&file=gfs.t00z.pgrb2.1p00.f000' +
  '&var_UGRD=on&var_VGRD=on' + (withLevels ? WX.LEVEL_VARS.map(v => '&var_' + v + '=on').join('') + WX.LEVEL_LEVS.map(l => '&lev_' + l + '=on').join('') : '') +
  (levels || ['250']).map(l => '&lev_' + l + '_mb=on').join('') +
  '&subregion=&toplat=' + GFS_BOX.top + '&leftlon=' + GFS_BOX.left + '&rightlon=' + GFS_BOX.right + '&bottomlat=' + GFS_BOX.bottom;
// NOAA's GFS archive on AWS: the file of one 00Z analysis, and its inventory (one line per message,
// "n:offset:d=YYYYMMDDHH:VAR:LEVEL:anl:").
const GFS_ARCHIVE = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';
const gfsArchiveFile = ymd => GFS_ARCHIVE + '/gfs.' + ymd.replace(/-/g, '') + '/00/atmos/gfs.t00z.pgrb2.1p00.f000';
// The same messages the NOMADS request selects: every variable at every level it names.
function archiveWanted(levels) {
  const vars = ['UGRD', 'VGRD'].concat(WX.LEVEL_VARS);
  const levs = (levels || ['250']).map(l => l + ' mb').concat(WX.LEVEL_LEVS.map(l => l.replace(/_mb$/, ' mb').replace(/_/g, ' ')));
  return { vars: new Set(vars), levs: new Set(levs) };
}
// Byte ranges of the wanted messages, neighbours merged into one request. The last message of the
// file has no end offset in the inventory and is skipped (none of ours is last).
function archiveRanges(idxText, wanted) {
  const rows = String(idxText || '').trim().split('\n').map(l => l.split(':')).filter(r => r.length >= 5 && /^\d+$/.test(r[1]));
  const out = [];
  rows.forEach((r, i) => {
    if (!wanted.vars.has(r[3]) || !wanted.levs.has(r[4]) || i + 1 >= rows.length) return;
    const off = Number(r[1]), end = Number(rows[i + 1][1]);
    const last = out[out.length - 1];
    if (last && last.offset + last.length === off) last.length += end - off;
    else out.push({ offset: off, length: end - off });
  });
  return out;
}
// AWC pilot and aircraft reports (PIREP, AIREP), moderate or worse, one call per day over the map frame.
// bbox is "lat0,lon0,lat1,lon1" (OpenAPI aviationweather.gov/data/schema/openapi.yaml); `date` + `age`
// select by observation time (checked 2026-10-06: date 1 Oct 00Z, age 24 gave obs 30 Sep 03:04–23:52Z).
const PIREP_URL = 'https://aviationweather.gov/api/data/pirep';
const PIREP_BBOX = [25, -80, 75, 40];
const PIREP_CAP = 400;             // "Most endpoints return a maximum of 400 entries" (aviationweather.gov/data/api)
const pirepUrl = (day, bbox) => PIREP_URL + '?format=json&bbox=' + (bbox || PIREP_BBOX).join(',') + '&age=24&inten=mod&date=' + U.addDays(day, 1) + 'T00:00:00Z';
const IEM_METAR = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';
const IEM_SIGMET = 'https://mesonet.agron.iastate.edu/cgi-bin/request/gis/sigmets.py';
const IEM_PIREP = 'https://mesonet.agron.iastate.edu/cgi-bin/request/gis/pireps.py';
// The whole reporting week of US-format PIREPs in one request (W40: 4.35 MB, 26,470 rows, all ARTCCs).
const iemPirepUrl = (from, to) => IEM_PIREP + '?sts=' + from + 'T00:00:00Z&ets=' + U.addDays(to, 1) + 'T00:00:00Z&artcc=_ALL&fmt=csv';
const SPC_CSV = ymd => 'https://www.spc.noaa.gov/climo/reports/' + yymmdd(ymd) + '_rpts_filtered.csv';
const SPC_DAY_PAGE = ymd => 'https://www.spc.noaa.gov/climo/reports/' + yymmdd(ymd) + '_rpts.html';
const PAGES = {
  awc: 'https://aviationweather.gov/sigmet/',
  iemMetar: 'https://mesonet.agron.iastate.edu/request/download.phtml',
  iemSigmet: 'https://mesonet.agron.iastate.edu/request/gis/awc_sigmets.phtml',
  spc: 'https://www.spc.noaa.gov/climo/online/',
  gfs: 'https://nomads.ncep.noaa.gov/',
  pirep: 'https://aviationweather.gov/data/pirep/',
  iemPirep: 'https://mesonet.agron.iastate.edu/request/gis/pireps.php',
};

const AWC_DAYS_KEPT = 30;          // "up to the previous 30 days" (aviationweather.gov/data/api)
const SAMPLE_STEP_H = 3;
const GAP_MS = { 'aviationweather.gov': 1100, 'mesonet.agron.iastate.edu': 1200, 'www.spc.noaa.gov': 300, 'nomads.ncep.noaa.gov': 1100 };   // start to start
// Time budget. Normal run: about 100 s, all of it the AWC calls (56 SIGMET samples, then 7 PIREP
// days; the other sources run beside them). Past the soft deadline no new request starts, and a
// host that timed out twice (or answered 403/429 once) is not asked again, so the fetcher ends near
// 150 s + one request (AWC 15 s, IEM 30 s, each with one retry) and writes what it has — inside
// U.main's 240 s watchdog. The PIREPs come last, so a slow AWC costs them before any SIGMET sample.
const SOFT_DEADLINE_S = 150;
const TIMEOUT_MS = { awc: 15000, iem: 30000, iemPirep: 45000, spc: 15000, gfs: 20000 };
const DEAD_AFTER_TIMEOUTS = 2;

// FIR regions by ICAO designator. Europe is roughly the EUROCONTROL area (E*, L*, Kosovo, Ukraine,
// Belarus/Kaliningrad, Armenia, Georgia) plus the Canaries; the oceanic FIRs of the NAT region are
// listed by name and win over the prefix rules.
const NAT_FIRS = ['EGGX', 'CZQX', 'BIRD', 'BGGL', 'ENOB', 'LPPO', 'KZWY'];
const REGION_NAMES = { europe: 'Europe', nat: 'North Atlantic', americas: 'US/Americas', world: 'rest of world' };
function regionOf(fir) {
  const f = String(fir || '').toUpperCase();
  if (NAT_FIRS.includes(f)) return 'nat';
  if (/^(E|L|BK|UK|UM|UD|UG|GC)/.test(f)) return 'europe';
  if (/^(K|P|C|M|T|S)/.test(f)) return 'americas';
  return 'world';
}
// FIRs that never showed up in the AWC feed in a month of samples (measured 2026-10-05).
const CENTRAL_FIRS = [];        // the FIR list of the AWC path: empty in this relay copy
const HAZARD_ORDER = ['TS', 'TURB', 'ICE', 'VA', 'TC', 'DS'];
const LIST_CAP = 15;               // volcanoes / cyclones kept in the snapshot

// The map frames beyond Europe/NAT and which SIGMETs belong to them. A SIGMET counts for an area when its
// FIR is one of the area's (ICAO prefix) AND, if it has a polygon, the polygon reaches into the area box
// (so Oakland Oceanic SIGMETs over the west Pacific are not North American). Overlaps the four old
// regions on purpose (Turkey is Europe and Middle East; New York Oceanic is NAT and North America).
const AREA_FIRS = { na: /^(K|PA|PH|CZ|MM|MU|MK|MY|MD|MT|MH|MP|TJ|TN|TT)/, me: /^(O|LT|LC|LL|HE|UB|UG|UD|UT)/ };
const FIR_ALIAS = {};          // FIR aliases of the AWC path: empty in this relay copy
// FIRs checked for silence per area: none of their SIGMETs in any sample is a feed gap or a quiet week,
// never "calm". Canada: no CZxx SIGMET in the AWC feed in a month of samples (observed_hazards.md Q7).
// Middle East: nine FIRs silent in 65 samples Sep–Oct 2026 (middle-east/report.md).
const AREA_FIRS_CHECKED = { na: [], me: [] };   // the FIR lists of the AWC path: empty in this relay copy
const AREA_NAMES = { na: 'North America', me: 'Middle East' };

// The hubs of fetch-wxoutlook.js (one list for both fetchers), with the ICAO code the METAR archive is
// asked for and the aerodrome position (carried into hubs.stations so the dashboards' map needs no other
// file).
const HUBS = WX.HUBS;
// Hub-day flags: any thunderstorm, hail, snow or freezing hour; fog / low visibility for 2 h or more; a gust of 35 kt or more.
// North America and Middle East hubs also: heat (maximum ≥ heatC), dust or sand (any hour, it takes precedence over
// the low-visibility fog rule everywhere), haze or smoke with visibility under hazeVisM for hazeHours or more.
const HUB_T = { fogHours: 2, gustKt: 35, lowVisM: 1000, heatC: 45, hazeVisM: 3000, hazeHours: 3 };

// ---- small helpers -------------------------------------------------------------------------
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const yymmdd = ymd => ymd.slice(2, 4) + ymd.slice(5, 7) + ymd.slice(8, 10);
const wd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
// 'Wed 30 Sep' — month names fixed here: en-GB in newer ICU writes 'Sept'.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = d => wd(d) + ' ' + (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1];
const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s\-(/'])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const inc = (o, k, n) => { o[k] = (o[k] || 0) + (n == null ? 1 : n); return o; };
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };
const zeroDays = (from, to) => daysOf(from, to).reduce((o, d) => (o[d] = 0, o), {});
const sumObj = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
// Consecutive days as weekday ranges: ['2026-09-28','2026-09-29','2026-10-01'] -> 'Mon–Tue, Thu'.
function dayRanges(dates) {
  const ds = [...new Set(dates || [])].sort(), runs = [];
  ds.forEach(d => { const r = runs[runs.length - 1]; if (r && U.addDays(r[1], 1) === d) r[1] = d; else runs.push([d, d]); });
  return runs.map(([a, b]) => a === b ? wd(a) : wd(a) + '–' + wd(b)).join(', ');
}

// Minimal CSV reader: quoted fields, doubled quotes, newlines inside quotes (the IEM SIGMET text).
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const csvObjects = text => { const r = parseCsv(text); if (!r.length) return []; const h = r[0].map(x => x.trim());
  return r.slice(1).map(v => h.reduce((o, k, i) => (o[k] = v[i] == null ? '' : v[i], o), {})); };

// ---- AWC international SIGMETs --------------------------------------------------------------
// The sample moments of the window, every 3 h, minus those not yet past (the API answers "now" for them).
function samplesFor(from, to, nowMs, stepH) {
  const step = (stepH || SAMPLE_STEP_H) * 3600000, out = { planned: [], future: [] };
  for (let t = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T23:59:59Z'); t <= end; t += step) {
    (t <= (nowMs == null ? Date.now() : nowMs) - 600000 ? out.planned : out.future).push(new Date(t).toISOString());
  }
  return out;
}
const awcStamp = iso => iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + '_' + iso.slice(11, 13) + iso.slice(14, 16);
// The SIGMET line identifies a SIGMET across samples and corrections (CCA); a raw text without one keys on itself.
function sigmetKey(raw) {
  const lines = String(raw || '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.find(x => /\bSIGMET\b.*\bVALID\b/.test(x)) || lines.join(' ');
}
const isCancel = raw => /\bCNL\s+SIGMET\b/.test(String(raw || ''));
// The hazard of an AWC record, upper case. Heavy dust or sand storm SIGMETs (WMO HVY DS / HVY SS; none in
// 11,785 records of Sep–Oct 2026, middle-east/report.md) are folded into one key, DS — whether the feed
// names them in `hazard` or only in the raw text.
const DUST_HAZARDS = ['DS', 'SS', 'DU', 'SA', 'DUST', 'SAND', 'DUSTSTORM', 'SANDSTORM'];
function hazardOf(rec) {
  const hz = String((rec && rec.hazard) || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (DUST_HAZARDS.includes(hz)) return 'DS';
  if ((!hz || hz === 'OTHER') && /\bHVY\s+(DS|SS)\b/.test(String((rec && rec.rawSigmet) || ''))) return 'DS';
  return hz;
}
function firOf(rec) {
  const f = String(rec.firId || '');
  if (/^[A-Z]{4}/.test(f)) return f.slice(0, 4);
  const m = /^([A-Z]{4}) SIGMET\b/m.exec(String(rec.rawSigmet || ''));
  return m ? m[1] : (rec.icaoId || '????');
}
// "LFRR BREST" -> "Brest", "NEW YORK OCEANIC" -> "New York Oceanic", "UBBA BAKU" -> "Baku".
function firLabel(firName, fir) {
  const n = String(firName || '').trim().replace(/^[A-Z]{4}(\/[A-Z])?\s+/, '').replace(/\s+(FIR|UIR|FIR\/UIR)$/i, '');
  return n ? titleCase(n) : (fir || '?');
}
function volcanoName(qualifier, raw) {
  let n = String(qualifier || '').toUpperCase().replace(/^ERUPTION\s+/, '').replace(/^(MT|MOUNT)\.?\s+/, '').trim();
  if (!n || n === 'MT') {
    const m = /\b(?:MT|MOUNT)\.?\s+([A-Z][A-Z'()\- ]*?)\s+(?:PSN|LOC\b|AT\b|VA\b|ERUPTION|[NS]\d)/.exec(String(raw || '').replace(/\s+/g, ' '));
    n = m ? m[1].trim() : '';
  }
  return n ? titleCase(n) : 'Unnamed volcano';
}
function cycloneName(qualifier, raw) {
  // Words an issuer writes where the name belongs ("TC NEAR OBS AT 0900Z", seen on KZWY 29 Sep 2026).
  const GENERIC = /^(NEAR|NR|OBS|FCST|CENTRE|CENTER|PSN|AT|WI|MOV|TOP|FRQ|EMBD|CB)$/;
  let n = String(qualifier || '').toUpperCase().trim();
  if (GENERIC.test(n)) n = '';
  // The decoded qualifier can be cut at a hyphen (CHOI for CHOI-WAN): the raw text has the full name.
  const m = /\bTC\s+([A-Z][A-Z\-]+)/.exec(String(raw || ''));
  const full = m && !GENERIC.test(m[1]) ? m[1] : '';
  if (full && (!n || (full.startsWith(n) && full.length > n.length))) n = full;
  return n ? titleCase(n) : 'Unnamed cyclone';
}
// "KZWY SIGMET ECHO 3 VALID …" -> "ECHO", "RJJJ SIGMET E05 VALID …" -> "E", "MMEX SIGMET 4 …" -> null.
function seriesOf(key) { const m = /^([A-Z]{4}) SIGMET ([A-Z]+)\s*\d+\b/.exec(String(key || '')); return m ? m[1] + ' ' + m[2] : null; }
const qualOf = q => String(q || '').toUpperCase().replace(/\s+/g, ' ').trim() || 'unspecified';

// samples: [{ time: ISO, list: [AWC isigmet records] }] — only the samples that were read.
function aggregateSigmets(samples, window) {
  const { from, to } = window;
  const seen = new Map(); let cancelled = 0;
  const cancelKeys = new Set();
  (samples || []).forEach(sm => {
    const sday = String(sm.time).slice(0, 10);
    (sm.list || []).forEach(rec => {
      const raw = rec && rec.rawSigmet;
      if (!raw) return;
      const key = sigmetKey(raw);
      if (isCancel(raw)) { if (!cancelKeys.has(key)) { cancelKeys.add(key); cancelled++; } return; }
      let e = seen.get(key);
      if (!e) {
        const fir = firOf(rec);
        e = { fir, name: firLabel(rec.firName, fir), region: regionOf(fir), hazard: hazardOf(rec) || 'OTHER',
              qual: qualOf(rec.qualifier), qualifier: rec.qualifier || null, from: rec.validTimeFrom || null, to: rec.validTimeTo || null,
              raw: String(raw), series: seriesOf(key), days: new Set(), areas: areasOf(rec, fir) };
        seen.set(key, e);
      }
      if (U.inRange(sday, from, to)) e.days.add(sday);
    });
  });
  const regions = {};
  Object.keys(REGION_NAMES).forEach(r => { regions[r] = { total: 0, hazards: {}, tsByDay: zeroDays(from, to), hailTs: 0, _firs: {} }; });
  const vol = new Map(), tc = new Map(), firsSeen = new Set();
  const clampDay = (e) => { const d = e.from ? new Date(e.from * 1000).toISOString().slice(0, 10) : [...e.days].sort()[0];
    return !d ? from : d < from ? from : d > to ? to : d; };
  // Ash and cyclone names; a SIGMET without one borrows the name of its series (same FIR, same series letters).
  const bySeries = {};
  for (const e of seen.values()) {
    if (e.hazard !== 'VA' && e.hazard !== 'TC') continue;
    e.event = e.hazard === 'VA' ? volcanoName(e.qualifier, e.raw) : cycloneName(e.qualifier, e.raw);
    if (e.series && !/^Unnamed/.test(e.event)) bySeries[e.hazard + '|' + e.series] = e.event;
  }
  for (const e of seen.values()) if (e.event && /^Unnamed/.test(e.event) && e.series && bySeries[e.hazard + '|' + e.series]) e.event = bySeries[e.hazard + '|' + e.series];
  for (const e of seen.values()) {
    firsSeen.add(e.fir);
    const R = regions[e.region];
    R.total++;
    const H = R.hazards[e.hazard] || (R.hazards[e.hazard] = { n: 0, qual: {} });
    H.n++;
    if (!['VA', 'TC'].includes(e.hazard)) inc(H.qual, e.qual);
    const F = R._firs[e.hazard + '|' + e.fir] || (R._firs[e.hazard + '|' + e.fir] = { hazard: e.hazard, fir: e.fir, name: e.name, n: 0, qual: {} });
    F.n++; if (!['VA', 'TC'].includes(e.hazard)) inc(F.qual, e.qual);
    if (e.hazard === 'TS') { inc(R.tsByDay, clampDay(e)); if (/\bTSGR\b|\bGR\b/.test(e.raw)) R.hailTs++; }
    if (e.hazard === 'VA' || e.hazard === 'TC') {
      const nm = e.event;
      const m = e.hazard === 'VA' ? vol : tc;
      const g = m.get(nm) || (m.set(nm, { name: nm, n: 0, firs: [], regions: [], areas: [], days: new Set() }), m.get(nm));
      g.n++;
      if (!g.firs.some(f => f.fir === e.fir)) g.firs.push({ fir: e.fir, name: e.name });
      if (!g.regions.includes(e.region)) g.regions.push(e.region);
      e.areas.forEach(a => { if (!g.areas.includes(a)) g.areas.push(a); });
      (e.days.size ? [...e.days] : [clampDay(e)]).forEach(d => g.days.add(d));
    }
  }
  Object.entries(regions).forEach(([rk, R]) => {
    const firs = Object.values(R._firs);
    Object.entries(R.hazards).forEach(([hz, H]) => {
      H.topFirs = firs.filter(f => f.hazard === hz).sort((a, b) => b.n - a.n || a.fir.localeCompare(b.fir)).slice(0, rk === 'world' ? 3 : 5)
        .map(f => (['VA', 'TC'].includes(hz) ? { fir: f.fir, name: f.name, n: f.n } : { fir: f.fir, name: f.name, n: f.n, qual: f.qual }));
    });
    delete R._firs;
  });
  // North America / Middle East: the same figures over the SIGMETs of each area (overlapping the regions above).
  Object.keys(AREA_FIRS).forEach(a => {
    const R = regions[a] = { total: 0, hazards: {}, tsByDay: zeroDays(from, to), hailTs: 0 }, F = {};
    for (const e of seen.values()) {
      if (!e.areas.includes(a)) continue;
      const fir = FIR_ALIAS[e.fir] || e.fir;
      R.total++;
      const H = R.hazards[e.hazard] || (R.hazards[e.hazard] = { n: 0, qual: {} });
      H.n++;
      const f = F[e.hazard + '|' + fir] || (F[e.hazard + '|' + fir] = { hazard: e.hazard, fir, name: e.name, n: 0, qual: {} });
      f.n++;
      if (!['VA', 'TC'].includes(e.hazard)) { inc(H.qual, e.qual); inc(f.qual, e.qual); }
      if (e.hazard === 'TS') { inc(R.tsByDay, clampDay(e)); if (/\bTSGR\b|\bGR\b/.test(e.raw)) R.hailTs++; }
    }
    Object.entries(R.hazards).forEach(([hz, H]) => {
      H.topFirs = Object.values(F).filter(f => f.hazard === hz).sort((x, y) => y.n - x.n || x.fir.localeCompare(y.fir)).slice(0, 5)
        .map(f => (['VA', 'TC'].includes(hz) ? { fir: f.fir, name: f.name, n: f.n } : { fir: f.fir, name: f.name, n: f.n, qual: f.qual }));
    });
    const seenA = new Set([...firsSeen].map(f => FIR_ALIAS[f] || f));
    R.silent = AREA_FIRS_CHECKED[a].filter(([f]) => !seenA.has(f)).map(([fir, name]) => ({ fir, name }));
  });
  const prio = g => (g.regions.includes('europe') || g.regions.includes('nat') ? 0 : 1);
  const listOf = m => [...m.values()].map(g => ({ name: g.name, n: g.n, firs: g.firs, regions: g.regions, areas: g.areas, days: [...g.days].sort() }))
    .sort((a, b) => prio(a) - prio(b) || b.n - a.n || a.name.localeCompare(b.name));
  // Notable Europe / NAT SIGMETs, one per FIR and kind, raw text kept for citing.
  const examples = [], exKeys = new Set();
  for (const e of seen.values()) {
    if (examples.length >= 8) break;
    if (e.region !== 'europe' && e.region !== 'nat') continue;
    const kind = e.hazard === 'VA' || e.hazard === 'TC' ? e.hazard : e.hazard === 'TURB' && /MTW/.test(e.qual) ? 'TURB MTW'
      : e.hazard === 'TS' && (/SQL/.test(e.qual) || /\bTSGR\b/.test(e.raw)) ? 'TS ' + (/SQL/.test(e.qual) ? 'SQL' : 'GR') : null;
    if (!kind || exKeys.has(e.fir + kind)) continue;
    exKeys.add(e.fir + kind);
    examples.push({ fir: e.fir, name: e.name, region: e.region, kind, validFrom: e.from ? new Date(e.from * 1000).toISOString() : null,
                    validTo: e.to ? new Date(e.to * 1000).toISOString() : null, raw: clip(e.raw, 320) });
  }
  // A hazard the grid and the digest do not know, with its raw text, so a first dust storm or radioactive-cloud
  // SIGMET is seen rather than lost under OTHER (kept only when there is one).
  const unusual = [...seen.values()].filter(e => e.hazard !== 'OTHER' && !HAZARD_ORDER.includes(e.hazard)).slice(0, 5)
    .map(e => ({ fir: e.fir, name: e.name, hazard: e.hazard, raw: clip(e.raw, 240) }));
  return {
    unique: seen.size, cancelled, regions, ...(unusual.length ? { unusual } : {}),
    // Europe / NAT first, then by count; capped so a busy week cannot blow up the snapshot.
    volcanoCount: vol.size, volcanoes: listOf(vol).slice(0, LIST_CAP), cycloneCount: tc.size, cyclones: listOf(tc).slice(0, LIST_CAP),
    centralEurope: { checked: CENTRAL_FIRS.map(([f]) => f), seen: CENTRAL_FIRS.map(([f]) => f).filter(f => firsSeen.has(f)),
                     missing: CENTRAL_FIRS.filter(([f]) => !firsSeen.has(f)).map(([fir, name]) => ({ fir, name })) },
    examples,
  };
}

// ---- SIGMET frequency grid for the map --------------------------------------------------------
// For every 1° cell of Europe + North Atlantic, the share of the read samples at which the cell lay
// inside at least one SIGMET of a hazard: "how often was it warned here", not how severe. Cell (j, i)
// covers lat0 + j .. lat0 + j + 1 and lon0 + i .. lon0 + i + 1 and is tested at its centre. The
// region is geometric, so oceanic and neighbouring FIRs count wherever their areas reach; the
// central-European gap of the feed shows as empty cells, not calm weather.
const SIGMET_GRID = { res: 1, lat0: 25, lon0: -80, nlat: 50, nlon: 125 };    // 25–75N, 80W–45E
// The other frames' 1° grids: North America 13–72N 170W–50W, Middle East 3–47N 14E–82E (same encoding).
const AREA_SIGMET_GRID = { na: { res: 1, lat0: 13, lon0: -170, nlat: 59, nlon: 120 }, me: { res: 1, lat0: 3, lon0: 14, nlat: 44, nlon: 68 } };
// DS (dust or sand storm) only appears when the feed carries one; the daily counts keep the five old keys
// always and add DS only when it occurs, so old snapshots and new ones read alike.
const GRID_HAZARDS = ['TS', 'TURB', 'ICE', 'VA', 'TC', 'DS'];
const COUNT_HAZARDS = ['TS', 'TURB', 'ICE', 'VA', 'TC'];
// Run-length text of a number list: "v" for one cell, "v*n" for n cells of value v, comma-separated.
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
// The polygons of one AWC record as [[lon, lat], ...] rings: geom AREA (one ring), AREAS (a list of
// rings), others with a closed point list. A ring across the antimeridian is unwrapped so it cannot
// span the whole map in plain lon/lat.
function sigmetRings(rec) {
  const c = rec && rec.coords;
  if (!Array.isArray(c) || !c.length) return [];
  const lists = Array.isArray(c[0]) ? c : [c];
  return lists.map(l => (l || []).filter(p => p && isFinite(+p.lon) && isFinite(+p.lat)).map(p => [+p.lon, +p.lat])).filter(r => r.length >= 3).map(r => {
    const lo = r.map(p => p[0]);
    return Math.max(...lo) - Math.min(...lo) > 180 ? r.map(p => [p[0] < 0 ? p[0] + 360 : p[0], p[1]]) : r;
  });
}
// A ring's bounding box overlaps box { s, n, w, e } — directly or shifted by 360° (rings unwrapped across the antimeridian).
function ringTouches(r, b) {
  const xs = r.map(p => p[0]), ys = r.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (Math.max(...ys) < b.s || Math.min(...ys) > b.n) return false;
  return [0, -360, 360].some(d => x1 + d >= b.w && x0 + d <= b.e);
}
// The map areas (AREA_FIRS keys) a SIGMET belongs to: FIR prefix, and the polygon (if any) reaching into the area box.
function areasOf(rec, fir) {
  const f = String(fir || firOf(rec) || ''), rings = sigmetRings(rec);
  return Object.keys(AREA_FIRS).filter(a => AREA_FIRS[a].test(f) && (!rings.length || rings.some(r => ringTouches(r, WX.MAP_AREAS[a]))));
}
function insideRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// samples: [{ time, list: [AWC records] }] — only the samples that were read.
function sigmetGrid(samples, grid) {
  const G = Object.assign({}, SIGMET_GRID, grid || {}), N = G.nlat * G.nlon, counts = {};
  const n = (samples || []).length;
  (samples || []).forEach(sm => {
    const hit = {};
    (sm.list || []).forEach(rec => {
      if (!rec || isCancel(rec.rawSigmet)) return;
      const hz = hazardOf(rec);
      if (!GRID_HAZARDS.includes(hz)) return;
      // A ring unwrapped east of 180° is also tried one turn west, for grids that start west of the antimeridian (North America).
      sigmetRings(rec).reduce((all, r) => all.concat([r], r.some(p => p[0] > 180) ? [r.map(p => [p[0] - 360, p[1]])] : []), []).forEach(r => {
        const xs = r.map(p => p[0]), ys = r.map(p => p[1]);
        const i0 = Math.max(0, Math.floor((Math.min(...xs) - G.lon0) / G.res)), i1 = Math.min(G.nlon - 1, Math.floor((Math.max(...xs) - G.lon0) / G.res));
        const j0 = Math.max(0, Math.floor((Math.min(...ys) - G.lat0) / G.res)), j1 = Math.min(G.nlat - 1, Math.floor((Math.max(...ys) - G.lat0) / G.res));
        if (i0 > i1 || j0 > j1) return;
        const H = hit[hz] || (hit[hz] = new Set());
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = j * G.nlon + i;
          if (!H.has(k) && insideRing(G.lon0 + (i + 0.5) * G.res, G.lat0 + (j + 0.5) * G.res, r)) H.add(k);
        }
      });
    });
    Object.keys(hit).forEach(hz => { const C = counts[hz] || (counts[hz] = new Uint16Array(N)); hit[hz].forEach(k => { C[k]++; }); });
  });
  const hazards = {}, maxPct = {}, cells = {};
  GRID_HAZARDS.forEach(hz => {
    const C = counts[hz]; if (!C || !n) return;
    const pct = Array.from(C, v => Math.round(100 * v / n));
    const m = Math.max(...pct); if (!m) return;                         // all-zero hazards are left out
    hazards[hz] = rleEncode(pct); maxPct[hz] = m; cells[hz] = pct.filter(v => v > 0).length;
  });
  return { res: G.res, lat0: G.lat0, lon0: G.lon0, nlat: G.nlat, nlon: G.nlon, samples: n, encoding: 'rle',
           layout: 'cells; row-major south→north, west→east; value = % of samples inside a SIGMET of the hazard; tokens "v" or "v*n"',
           hazards, maxPct, cells };
}

// ---- SIGMETs per day: the map's day strip -------------------------------------------------------
// The same grid and encoding as sigmetGrid, one entry per day of the window: value = % of THAT day's
// samples (8 at 3-hourly sampling), and the distinct SIGMETs in force that day by FIR region (Europe,
// NAT; the same region rule as the week's counts, keyed on the SIGMET line, cancellations left out).
// A day without a sample read comes out with samples 0 and no hazard. No extra request.
function sigmetDays(samples, window, grid) {
  const byDay = {};
  daysOf(window.from, window.to).forEach(d => { byDay[d] = []; });
  (samples || []).forEach(sm => { const d = String(sm.time).slice(0, 10); if (byDay[d]) byDay[d].push(sm); });
  return Object.keys(byDay).sort().map(date => {
    const ss = byDay[date], counts = { europe: {}, nat: {} }, keys = { europe: new Set(), nat: new Set() };
    COUNT_HAZARDS.forEach(hz => { counts.europe[hz] = 0; counts.nat[hz] = 0; });
    ss.forEach(sm => (sm.list || []).forEach(rec => {
      const raw = rec && rec.rawSigmet;
      if (!raw || isCancel(raw)) return;
      const hz = hazardOf(rec), rg = regionOf(firOf(rec)), k = sigmetKey(raw);
      if (!counts[rg] || !GRID_HAZARDS.includes(hz) || keys[rg].has(k)) return;
      keys[rg].add(k); counts[rg][hz] = (counts[rg][hz] || 0) + 1;
    }));
    return { date, samples: ss.length, hazards: sigmetGrid(ss, grid).hazards, counts };
  });
}
// FIR groups that sent no SIGMET to the feed in the samples read (a gap in the AWC feed, measured
// 2026-10-05: never Germany, Benelux; Italy not in 10 samples). Only the groups still missing are named.
const FEED_GAPS = [['ED', 'German'], ['LI', 'Italian'], ['EH', 'Dutch'], ['EB', 'Belgian']];
function feedGaps(samples) {
  const seen = new Set();
  (samples || []).forEach(sm => (sm.list || []).forEach(rec => { if (rec && rec.rawSigmet) seen.add(firOf(rec).slice(0, 2)); }));
  return FEED_GAPS.filter(([p]) => !seen.has(p)).map(([prefix, name]) => ({ prefix, name }));
}
const gapNote = gaps => 'Map, SIGMETs: no SIGMET from the ' + gaps.map(g => g.name + ' (' + g.prefix + '*)').join(', ').replace(/, ([^,]*)$/, ' or $1') +
  ' FIRs in the AWC feed this week; empty there means no data, not calm weather';

// ---- SIGMET grids of the other map frames (North America, Middle East) -----------------------------
// Distinct SIGMETs of one area in force at the given samples, by hazard (five keys always, DS when present).
function areaCounts(samples, key) {
  const c = {}, keys = new Set();
  COUNT_HAZARDS.forEach(hz => { c[hz] = 0; });
  (samples || []).forEach(sm => (sm.list || []).forEach(rec => {
    const raw = rec && rec.rawSigmet;
    if (!raw || isCancel(raw)) return;
    const hz = hazardOf(rec), k = sigmetKey(raw);
    if (!GRID_HAZARDS.includes(hz) || keys.has(k) || !areasOf(rec).includes(key)) return;
    keys.add(k); c[hz] = (c[hz] || 0) + 1;
  }));
  return c;
}
// The area's week grid and its days, as sigmetGrid / sigmetDays for Europe/NAT. samples may carry extra
// records (the US convective SIGMETs for North America).
function areaSigmet(samples, window, key, sources) {
  const G = AREA_SIGMET_GRID[key], out = sigmetGrid(samples, G), byDay = {};
  daysOf(window.from, window.to).forEach(d => { byDay[d] = []; });
  (samples || []).forEach(sm => { const d = String(sm.time).slice(0, 10); if (byDay[d]) byDay[d].push(sm); });
  out.days = Object.keys(byDay).sort().map(date => ({ date, samples: byDay[date].length, hazards: sigmetGrid(byDay[date], G).hazards, counts: { [key]: areaCounts(byDay[date], key) } }));
  out.box = WX.MAP_AREAS[key];
  out.sources = sources;
  return out;
}

// ---- IEM SIGMET archive as KML (polygons) ---------------------------------------------------------
const unxml = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
// sigmets.py?format=kml -> rows with the CSV's columns (NAME, LABEL, TYPE, ISSUE, EXPIRE, PROD_ID, TEXT) plus
// rings [[lon, lat], …] from the placemark's polygons. aggregateIemSigmets reads these rows unchanged.
function parseIemKml(text) {
  return String(text || '').split('<Placemark').slice(1).map(p => {
    const row = { NAME: unxml((/<name>([\s\S]*?)<\/name>/.exec(p) || [])[1] || '') };
    ['LABEL', 'TYPE', 'ISSUE', 'EXPIRE', 'PROD_ID', 'TEXT'].forEach(k => {
      const m = new RegExp('<SimpleData name="' + k + '">([\\s\\S]*?)</SimpleData>').exec(p);
      row[k] = m ? unxml(m[1]) : '';
    });
    row.rings = [...p.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)]
      .map(m => m[1].trim().split(/\s+/).map(t => t.split(',').map(Number)).filter(c => isFinite(c[0]) && isFinite(c[1])).map(c => [c[0], c[1]])).filter(r => r.length >= 3);
    return row;
  });
}
// The US convective SIGMETs of the rows as AWC-like records with their validity, for the North America grid.
// Reissued every hour at H+55 for 2 h, so at a sample moment (H+00) only the newest issue (less than 60 min old,
// i.e. the H−0:05 batch) is taken — the batch of H−1:05, still formally valid, is its predecessor, not another storm.
const CONV_FRESH_MS = 60 * 60000;
function iemConvective(rows) {
  return (rows || []).filter(r => /CONVECTIVE SIGMET/.test(r.TEXT) && !/CONVECTIVE SIGMET\s*\.*\s*NONE/.test(r.TEXT) && !isCancel(r.TEXT) && (r.rings || []).length)
    .map(r => ({ issue: Date.parse(r.ISSUE), expire: Date.parse(r.EXPIRE),
                 rec: { hazard: 'TS', firId: 'KCNV', firName: 'US convective', rawSigmet: r.TEXT, coords: r.rings.map(g => g.map(([lon, lat]) => ({ lon, lat }))), src: 'iem' } }))
    .filter(c => isFinite(c.issue) && isFinite(c.expire));
}
// samples + the convective SIGMETs in force (and fresh) at each sample moment.
function withConvective(samples, conv) {
  return (samples || []).map(sm => { const t = Date.parse(sm.time);
    return { time: sm.time, list: (sm.list || []).concat((conv || []).filter(c => c.issue <= t && t < c.expire && t - c.issue < CONV_FRESH_MS).map(c => c.rec)) }; });
}

// ---- AWC pilot / aircraft reports, moderate or worse ---------------------------------------------
// One row per report and kind, as [t, lat, lon, fl, kind, sev, src]: t = observation time
// 'YYYY-MM-DDTHH:MMZ', lat/lon rounded to 0.1°, fl the aircraft's level in hundreds of feet (else the
// reported layer base, else null), kind T turbulence / I icing, sev 1 moderate, 2 moderate to severe
// (MOD-SEV, MOD-EXTM), 3 severe or worse (SEV, SEV-EXTM, EXTM, HVY icing), src P PIREP / A AIREP (or
// AMDAR). Everything else is dropped before the snapshot is written: callsign (AIREPs carry it in
// acType), aircraft type, reporting station, raw text. The raw text only serves, in memory, to drop
// a report that two daily calls both returned.
const PIREP_FIELDS = ['t', 'lat', 'lon', 'fl', 'kind', 'sev', 'src'];
const PIREP_SEV = { MOD: 1, 'MOD-SEV': 2, 'MOD-EXTM': 2, SEV: 3, 'SEV-EXTM': 3, EXTM: 3, HVY: 3 };
const pirepSev = s => PIREP_SEV[String(s || '').toUpperCase().trim()] || 0;
// The two counting boxes; they overlap between 15W and 10W.
const PIREP_BOXES = { nat: { s: 40, n: 65, w: -60, e: -10 }, europe: { s: 35, n: 72, w: -15, e: 40 } };
const PIREP_ATTRIBUTION = 'Pilot and aircraft reports via NOAA Aviation Weather Center; callsigns removed';
const round1 = x => Math.round(x * 10) / 10;
const posInt = x => (x === '' || x == null || !isFinite(+x) || +x <= 0) ? null : Math.round(+x);
// lists: [{ day, list: [AWC pirep JSON records] }] -> { rows, duplicates, outside } (outside = observed outside the window).
function pirepRows(lists, window) {
  const seen = new Set(), rows = [];
  let duplicates = 0, outside = 0;
  (lists || []).forEach(x => (x.list || []).forEach(r => {
    if (!r || !isFinite(+r.obsTime) || !isFinite(+r.lat) || !isFinite(+r.lon) || r.lat === null || r.lon === null) return;
    const key = r.obsTime + '|' + r.lat + '|' + r.lon + '|' + (r.rawOb || '');
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    const iso = new Date(+r.obsTime * 1000).toISOString();
    if (!U.inRange(iso.slice(0, 10), window.from, window.to)) { outside++; return; }
    const t = iso.slice(0, 16) + 'Z', lat = round1(+r.lat), lon = round1(+r.lon), fl = posInt(r.fltLvl);
    const src = /AIREP|AMDAR/i.test(String(r.pirepType || '')) ? 'A' : 'P';
    const tb = Math.max(pirepSev(r.tbInt1), pirepSev(r.tbInt2)), ic = Math.max(pirepSev(r.icgInt1), pirepSev(r.icgInt2));
    if (tb) rows.push([t, lat, lon, fl != null ? fl : posInt(r.tbBas1), 'T', tb, src]);
    if (ic) rows.push([t, lat, lon, fl != null ? fl : posInt(r.icgBas1), 'I', ic, src]);
  }));
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2] || a[4].localeCompare(b[4]));
  return { rows, duplicates, outside };
}
const inBox = (r, b) => r[1] >= b.s && r[1] <= b.n && r[2] >= b.w && r[2] <= b.e;
// { nat: { T: { mod, sev }, I: { mod, sev } }, europe: … }: mod = sev 1–2, sev = sev 3 (disjoint).
function pirepCounts(rows, boxes) {
  const out = {};
  Object.entries(boxes || PIREP_BOXES).forEach(([k, b]) => {
    const c = { T: { mod: 0, sev: 0 }, I: { mod: 0, sev: 0 } };
    (rows || []).forEach(r => { if (inBox(r, b) && c[r[4]]) c[r[4]][r[5] >= 3 ? 'sev' : 'mod']++; });
    out[k] = c;
  });
  return out;
}
// The snapshot's `pireps` block. meta: { calls, capped, missing }.
function pirepBlock(lists, window, meta) {
  meta = meta || {};
  const r = pirepRows(lists, window);
  return { source: 'NOAA Aviation Weather Center Data API, ' + PIREP_URL + ' (inten=mod, one call per day)', attribution: PIREP_ATTRIBUTION, page: PAGES.pirep,
           window: { from: window.from, to: window.to }, bbox: PIREP_BBOX, calls: meta.calls || 0, capped: meta.capped || [], missing: meta.missing || [],
           boxes: PIREP_BOXES, counts: pirepCounts(r.rows), duplicates: r.duplicates, fields: PIREP_FIELDS,
           codes: { kind: { T: 'turbulence', I: 'icing' }, sev: { 1: 'moderate', 2: 'moderate to severe', 3: 'severe or worse' }, src: { P: 'PIREP', A: 'AIREP' } },
           reports: r.rows };
}

// ---- North America: IEM PIREP archive, one request a week ----------------------------------------
// CSV columns VALID (YYYYMMDDHHMM UTC), URGENT, AIRCRAFT, REPORT, ICING, TURBULENCE, ATRCC, PRODUCT_ID, FL
// (feet), LAT, LON. The report text can hold commas, so the last seven columns are counted from the end.
// Intensity words as AWC decodes them (pirepSev); EXTRM is IEM's spelling of EXTM; LGT-MOD stays below moderate.
const NA_PIREP_GRID = AREA_SIGMET_GRID.na;
const NA_PIREP_BOXES = { na: { s: 13, n: 72, w: -170, e: -50 }, conus: { s: 24, n: 50, w: -125, e: -66 }, canada: { s: 49, n: 72, w: -141, e: -52 }, alaska: { s: 51, n: 72, w: -170, e: -130 } };
const PIREP_SEVERE_FROM = 2;          // moderate-to-severe or worse: dots; moderate: the count grid
const IEM_PIREP_ATTRIBUTION = 'Pilot reports (US PIREPs) via the Iowa Environmental Mesonet archive; aircraft types and texts removed';
function iemSev(s) {
  let m = 0;
  (String(s || '').toUpperCase().match(/\b(MOD-SEV|MOD-EXTRM|MOD-EXTM|SEV-EXTRM|SEV-EXTM|LGT-MOD|EXTRM|EXTM|MOD|SEV|HVY)\b/g) || [])
    .forEach(t => { m = Math.max(m, pirepSev(t.replace('EXTRM', 'EXTM'))); });
  return m;
}
// -> { rows: [t, lat, lon, fl, kind, sev, 'P'] inside box and window, duplicates, read }
function iemPirepRows(text, window, box) {
  const b = box || NA_PIREP_BOXES.na, seen = new Set(), rows = [];
  let duplicates = 0, read = 0;
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!i || !line.trim()) return;
    const p = line.split(','), n = p.length;
    if (n < 11 || !/^\d{12}$/.test(p[0])) return;
    read++;
    const lat = +p[n - 2], lon = +p[n - 1];
    if (!isFinite(lat) || !isFinite(lon) || p[n - 2] === '' || lat < b.s || lat > b.n || lon < b.w || lon > b.e) return;
    const v = p[0], day = v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
    if (!U.inRange(day, window.from, window.to)) return;
    const tb = iemSev(p[n - 6]), ic = iemSev(p[n - 7]);
    if (!tb && !ic) return;
    const key = v + '|' + p[n - 2] + '|' + p[n - 1] + '|' + p.slice(3, n - 7).join(',');
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    const t = day + 'T' + v.slice(8, 10) + ':' + v.slice(10, 12) + 'Z', ft = posInt(p[n - 3]), fl = ft == null ? null : Math.round(ft / 100);
    if (tb) rows.push([t, round1(lat), round1(lon), fl, 'T', tb, 'P']);
    if (ic) rows.push([t, round1(lat), round1(lon), fl, 'I', ic, 'P']);
  });
  rows.sort((a, b2) => a[0].localeCompare(b2[0]) || a[1] - b2[1] || a[2] - b2[2] || a[4].localeCompare(b2[4]));
  return { rows, duplicates, read };
}
// The `pireps.areas.na` block: counts per box (mod = sev 1–2, sev = 3, as pirepCounts), the rows from
// moderate-to-severe up as dots, and per day a 1° grid of how many reports had only moderate turbulence or icing.
function naPirepBlock(rows, window, meta) {
  meta = meta || {};
  const G = NA_PIREP_GRID, N = G.nlat * G.nlon, rkey = r => r[0] + '|' + r[1] + '|' + r[2] + '|' + r[3];
  const sevKeys = new Set(rows.filter(r => r[5] >= PIREP_SEVERE_FROM).map(rkey));
  let max = 0;
  const days = daysOf(window.from, window.to).map(date => {
    const g = new Uint16Array(N), seen = new Set();
    let n = 0;
    rows.forEach(r => {
      if (r[0].slice(0, 10) !== date || r[5] !== 1) return;
      const k = rkey(r);
      if (seen.has(k) || sevKeys.has(k)) return;
      seen.add(k);
      const j = Math.floor((r[1] - G.lat0) / G.res), i = Math.floor((r[2] - G.lon0) / G.res);
      if (j < 0 || j >= G.nlat || i < 0 || i >= G.nlon) return;
      g[j * G.nlon + i]++; n++;
    });
    const gm = Math.max(0, ...g); if (gm > max) max = gm;
    return { date, n, grid: rleEncode(Array.from(g)) };
  });
  return { source: 'Iowa Environmental Mesonet PIREP archive, ' + IEM_PIREP + ' (one request for the week)', attribution: IEM_PIREP_ATTRIBUTION, page: PAGES.iemPirep,
           window: { from: window.from, to: window.to }, bbox: [NA_PIREP_BOXES.na.s, NA_PIREP_BOXES.na.w, NA_PIREP_BOXES.na.n, NA_PIREP_BOXES.na.e], calls: meta.calls || 1,
           read: meta.read || 0, duplicates: meta.duplicates || 0, boxes: NA_PIREP_BOXES, counts: pirepCounts(rows, NA_PIREP_BOXES), fields: PIREP_FIELDS,
           codes: { kind: { T: 'turbulence', I: 'icing' }, sev: { 1: 'moderate', 2: 'moderate to severe', 3: 'severe or worse' }, src: { P: 'PIREP' } },
           severeFrom: PIREP_SEVERE_FROM, severe: rows.filter(r => r[5] >= PIREP_SEVERE_FROM),
           modGrid: { res: G.res, lat0: G.lat0, lon0: G.lon0, nlat: G.nlat, nlon: G.nlon, encoding: 'rle',
                      layout: 'cells; row-major south→north, west→east; value = reports with moderate (not worse) turbulence or icing that day; tokens "v" or "v*n"',
                      max, days } };
}

// ---- IEM METAR archive: hub weather ---------------------------------------------------------
function iemMetarUrl(from, to, hubs) {
  return IEM_METAR + '?' + (hubs || HUBS).map(h => 'station=' + h.icao).join('&') + '&data=wxcodes&data=vsby&data=gust&data=tmpf' +
    '&sts=' + from + 'T00:00:00Z&ets=' + U.addDays(to, 1) + 'T00:00:00Z&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3&report_type=4';
}
// Present-weather groups of one observation. Fog counts FG / FZFG only (BCFG, MIFG, PRFG and VCFG
// are patches or nearby) or a visibility under 1000 m — unless the hour reports dust or sand, which then
// explains the low visibility (1 Oct 2026: 600 m in blowing dust); snow leaves out drifting / blowing snow.
// The phenomena of one group, two letters each, without intensity, vicinity and descriptor: '+TSRAGR' -> ['RA', 'GR'], 'BLDU' -> ['DU'].
const wxCodes = tok => (String(tok || '').toUpperCase().replace(/^[+-]/, '').replace(/^VC/, '').replace(/^(MI|BC|PR|DR|BL|SH|TS|FZ)/, '').match(/[A-Z]{2}/g) || []);
// Dust or sand (DU, SA, DS, SS, PO) and haze or smoke (HZ, FU) in an observation's present weather.
function dustHaze(wxcodes) {
  const cs = String(wxcodes || '').split(/\s+/).filter(Boolean).reduce((a, t) => a.concat(wxCodes(t)), []);
  return { dust: cs.some(c => ['DU', 'SA', 'DS', 'SS', 'PO'].includes(c)), haze: cs.some(c => c === 'HZ' || c === 'FU') };
}
function wxFlags(wxcodes, visM) {
  const t = String(wxcodes || '').toUpperCase().split(/\s+/).filter(Boolean);
  return {
    ts: t.some(x => /TS/.test(x)),
    fog: t.some(x => /^[+-]?(FZ)?FG$/.test(x)) || (visM != null && visM < HUB_T.lowVisM && !dustHaze(wxcodes).dust),
    snow: t.some(x => /SN/.test(x) && !/^(DR|BL)SN$/.test(x)),
    fz: t.some(x => /FZ/.test(x)),
    hail: t.some(x => /GR|GS/.test(x)),
  };
}
// rows: IEM onlycomma rows {station, valid 'YYYY-MM-DD HH:MM' UTC, wxcodes, vsby (statute miles), gust (kt), tmpf (°F)}.
// Every hub-day also carries dust (hours with dust or sand), haze (hours with haze or smoke and visibility under
// HUB_T.hazeVisM) and tmaxC (highest temperature reported, °C); they are flagged only for the North America and
// Middle East hubs, so Europe's notable list reads as before.
function aggregateMetars(rows, window, hubs) {
  hubs = hubs || HUBS;
  const { from, to } = window, dates = daysOf(from, to);
  const byId = {};
  hubs.forEach(h => { byId[h.icao] = h; byId[h.icao.slice(1)] = byId[h.icao.slice(1)] || h; byId[h.code] = byId[h.code] || h; });
  const acc = {};
  hubs.forEach(h => { acc[h.code] = {}; dates.forEach(d => { acc[h.code][d] = { obs: 0, ts: new Set(), fog: new Set(), snow: new Set(), fz: new Set(), hail: new Set(), dust: new Set(), haze: new Set(), gust: null, vis: null, tmax: null }; }); });
  (rows || []).forEach(r => {
    const h = byId[String(r.station || '').trim().toUpperCase()];
    const v = String(r.valid || ''), d = v.slice(0, 10), hh = v.slice(11, 13);
    if (!h || !acc[h.code][d]) return;
    const a = acc[h.code][d];
    a.obs++;
    const vis = r.vsby === '' || r.vsby == null || isNaN(+r.vsby) ? null : Math.round(+r.vsby * 1609.344 / 50) * 50;
    const g = r.gust === '' || r.gust == null || isNaN(+r.gust) ? null : Math.round(+r.gust);
    const f = wxFlags(r.wxcodes, vis);
    ['ts', 'fog', 'snow', 'fz', 'hail'].forEach(k => { if (f[k]) a[k].add(hh); });
    const dh = dustHaze(r.wxcodes);
    if (dh.dust) a.dust.add(hh);
    if (dh.haze && vis != null && vis < HUB_T.hazeVisM) a.haze.add(hh);
    const tc = r.tmpf === '' || r.tmpf == null || isNaN(+r.tmpf) ? null : (+r.tmpf - 32) / 1.8;
    if (tc != null && (a.tmax == null || tc > a.tmax)) a.tmax = tc;
    if (g != null && (a.gust == null || g > a.gust)) a.gust = g;
    if (vis != null && (a.vis == null || vis < a.vis)) a.vis = vis;
  });
  const stations = hubs.map(h => {
    const days = dates.map(d => { const a = acc[h.code][d];
      return { date: d, obs: a.obs, ts: a.ts.size, fog: a.fog.size, snow: a.snow.size, fz: a.fz.size, hail: a.hail.size, gustMaxKt: a.gust, visMinM: a.vis,
               dust: a.dust.size, haze: a.haze.size, tmaxC: a.tmax == null ? null : Math.round(a.tmax) }; });
    const tot = k => days.reduce((s, x) => s + x[k], 0);
    const gs = days.map(x => x.gustMaxKt).filter(x => x != null), vs = days.map(x => x.visMinM).filter(x => x != null), ts = days.map(x => x.tmaxC).filter(x => x != null);
    return Object.assign({ code: h.code, icao: h.icao, name: h.name, region: h.region }, h.area ? { area: h.area } : {}, { lat: h.lat, lon: h.lon, obs: tot('obs'),
             week: { ts: tot('ts'), fog: tot('fog'), snow: tot('snow'), fz: tot('fz'), hail: tot('hail'),
                     gustMaxKt: gs.length ? Math.max(...gs) : null, visMinM: vs.length ? Math.min(...vs) : null,
                     dust: tot('dust'), haze: tot('haze'), tmaxC: ts.length ? Math.max(...ts) : null }, days });
  });
  const notable = [];
  stations.forEach(s => s.days.forEach(d => {
    const more = s.area === 'na' || s.area === 'me';
    const fl = [];
    if (d.ts) fl.push('thunderstorm ' + d.ts + ' h');
    if (d.hail) fl.push('hail ' + d.hail + ' h');
    if (d.fog >= HUB_T.fogHours) fl.push('fog/low vis ' + d.fog + ' h (min ' + d.visMinM + ' m)');
    if (d.snow) fl.push('snow ' + d.snow + ' h');
    if (d.fz) fl.push('freezing ' + d.fz + ' h');
    if (d.gustMaxKt != null && d.gustMaxKt >= HUB_T.gustKt) fl.push('gust ' + d.gustMaxKt + ' kt');
    if (more && d.dust) fl.push('dust/sand ' + d.dust + ' h');
    if (more && d.haze >= HUB_T.hazeHours) fl.push('haze ' + d.haze + ' h');
    if (more && d.tmaxC != null && d.tmaxC >= HUB_T.heatC) fl.push('heat ' + d.tmaxC + ' °C');
    if (fl.length) notable.push({ code: s.code, date: d.date, flags: fl });
  }));
  return { thresholds: HUB_T, stations, notable, missing: stations.filter(s => !s.obs).map(s => s.code) };
}

// ---- IEM SIGMET archive: US convective and oceanic ------------------------------------------
// KML since round 4: the same rows as the CSV plus the polygons (W40: 1.63 MB instead of 0.41 MB, one request either way).
function iemSigmetUrl(from, to) { return IEM_SIGMET + '?sts=' + from + 'T00:00Z&ets=' + U.addDays(to, 1) + 'T00:00Z&format=kml'; }
const CONV_REGION = { SIGE: 'East', SIGC: 'Central', SIGW: 'West' };
function oceanicHazard(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (/\bTC\b/.test(t)) return 'TC';
  if (/\bVA\b/.test(t)) return 'VA';
  if (/\b(FRQ|EMBD|OBSC|SQL|OCNL|ISOL)\s+TS/.test(t) || /\bTS\b/.test(t)) return 'TS';
  if (/SEV\s+TURB|\bMTW\b/.test(t)) return 'TURB';
  if (/SEV\s+ICE/.test(t)) return 'ICE';
  return 'OTHER';
}
// rows: IEM sigmets.py CSV {NAME, LABEL, TYPE, ISSUE, EXPIRE, PROD_ID, TEXT}.
function aggregateIemSigmets(rows, window) {
  const { from, to } = window;
  const conv = { total: 0, byDay: zeroDays(from, to), byRegion: { East: 0, Central: 0, West: 0 }, severeTs: 0, tornado: 0, hailMaxIn: null, gustMaxKt: null, peak: null };
  const oce = {};
  let pacific = 0;
  (rows || []).forEach(r => {
    const text = String(r.TEXT || ''), pid = String(r.PROD_ID || '').split('-'), day = String(r.ISSUE || '').slice(0, 10);
    if (!U.inRange(day, from, to) || isCancel(text)) return;
    if (/CONVECTIVE SIGMET/.test(text)) {
      if (/CONVECTIVE SIGMET\s*\.*\s*NONE/.test(text)) return;
      conv.total++; inc(conv.byDay, day);
      let rn = CONV_REGION[pid[3]] || null;                       // SIGE / SIGC / SIGW, else the label "27E"
      if (!rn) { const lm = /\d+([ECW])\b/.exec(String(r.LABEL || '')); if (lm) rn = CONV_REGION['SIG' + lm[1]]; }
      if (rn) conv.byRegion[rn]++;
      if (/SEV TS/.test(text)) conv.severeTs++;
      if (/TORNADO/.test(text)) conv.tornado++;
      const hm = /HAIL TO ([\d.]+) ?IN/.exec(text); if (hm && (conv.hailMaxIn == null || +hm[1] > conv.hailMaxIn)) conv.hailMaxIn = +hm[1];
      const gm = /WIND GUSTS TO (\d+) ?KT/.exec(text); if (gm && (conv.gustMaxKt == null || +gm[1] > conv.gustMaxKt)) conv.gustMaxKt = +gm[1];
      return;
    }
    const prefix = String(pid[2] || '').slice(0, 4);
    const m = /^\s*([A-Z][A-Z .]*?) FIR\b/m.exec(text);
    const fir = m ? titleCase(m[1].trim()) : 'Unknown FIR';
    if (/^WSP/.test(prefix) || /OAKLAND|ANCHORAGE/i.test(fir)) { pacific++; return; }
    const o = oce[fir] || (oce[fir] = { fir, total: 0, hazards: {}, byDay: zeroDays(from, to), peak: null });
    o.total++; inc(o.hazards, oceanicHazard(text)); inc(o.byDay, day);
  });
  const peakOf = byDay => { const e = Object.entries(byDay).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]; return e && e[1] ? { date: e[0], n: e[1] } : null; };
  conv.peak = peakOf(conv.byDay);
  const oceanic = Object.values(oce).map(o => Object.assign(o, { peak: peakOf(o.byDay) })).sort((a, b) => b.total - a.total);
  return { convective: conv, oceanic, pacificOceanic: pacific };
}

// ---- SPC storm reports ---------------------------------------------------------------------
// One _rpts_filtered.csv: three sections, each with its own header line (Time,F_Scale | Time,Speed | Time,Size).
function parseSpcCsv(text) {
  const out = { tornado: 0, wind: 0, hail: 0, hailMaxIn: null, windMaxMph: null, states: {} };
  let sec = null;
  String(text || '').split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const c = line.split(',');
    if (c[0] === 'Time') { sec = c[1] === 'F_Scale' ? 'tornado' : c[1] === 'Speed' ? 'wind' : c[1] === 'Size' ? 'hail' : null; return; }
    if (!sec || !/^\d{3,4}$/.test(c[0])) return;
    out[sec]++;
    if (c[4]) inc(out.states, c[4].trim());
    const v = +c[1];
    if (sec === 'hail' && !isNaN(v)) { const inch = Math.round(v) / 100; if (out.hailMaxIn == null || inch > out.hailMaxIn) out.hailMaxIn = inch; }
    if (sec === 'wind' && !isNaN(v) && (out.windMaxMph == null || v > out.windMaxMph)) out.windMaxMph = v;
  });
  return out;
}
// The reports of one day file as points [time 'YYYY-MM-DDTHH:MMZ', lat, lon, kind, magnitude]: kind T tornado
// (magnitude = EF rating, null when unrated/UNK), W wind (mph, null for UNK), H hail (inches). `date` is the
// convective day: report times from 12Z belong to it, earlier ones to the next calendar day (times are UTC).
function spcPoints(text, date) {
  const out = []; let sec = null;
  String(text || '').split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const c = line.split(',');
    if (c[0] === 'Time') { sec = c[1] === 'F_Scale' ? 'T' : c[1] === 'Speed' ? 'W' : c[1] === 'Size' ? 'H' : null; return; }
    if (!sec || !/^\d{3,4}$/.test(c[0])) return;
    const lat = +c[5], lon = +c[6];
    if (!isFinite(lat) || !isFinite(lon) || c[5] === '' || c[6] === '') return;
    const hm = c[0].padStart(4, '0'), d = +hm.slice(0, 2) < 12 ? U.addDays(date, 1) : date;
    const v = String(c[1] || '').trim().toUpperCase();
    const mag = sec === 'T' ? (/^E?F(\d)$/.test(v) ? +/(\d)$/.exec(v)[1] : null) : sec === 'W' ? (/^\d+$/.test(v) ? +v : null) : (/^\d+$/.test(v) ? Math.round(+v) / 100 : null);
    out.push([d + 'T' + hm.slice(0, 2) + ':' + hm.slice(2) + 'Z', Math.round(lat * 100) / 100, Math.round(lon * 100) / 100, sec, mag]);
  });
  return out;
}
function summarizeSpc(days) {
  const t = { tornado: 0, wind: 0, hail: 0, hailMaxIn: null, windMaxMph: null, states: {} };
  (days || []).forEach(d => {
    t.tornado += d.tornado; t.wind += d.wind; t.hail += d.hail;
    if (d.hailMaxIn != null && (t.hailMaxIn == null || d.hailMaxIn > t.hailMaxIn)) t.hailMaxIn = d.hailMaxIn;
    if (d.windMaxMph != null && (t.windMaxMph == null || d.windMaxMph > t.windMaxMph)) t.windMaxMph = d.windMaxMph;
    Object.entries(d.states || {}).forEach(([k, v]) => inc(t.states, k, v));
  });
  t.topStates = Object.entries(t.states).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([s, n]) => ({ state: s, n }));
  delete t.states;
  return t;
}

// ---- North America / Middle East layers from what was read ----------------------------------------
// read: the AWC samples; conv: iemConvective() of the IEM KML (null when that source failed); naPireps: naPirepBlock().
const NA_SOURCES = ['AWC international SIGMETs, 3-hourly samples (Mexico, Central America, Caribbean, US oceanic, Alaska)',
                    'IEM SIGMET archive: US convective SIGMETs in force at the same moments (newest hourly issue only); US oceanic SIGMETs from AWC only'];
function addAreaLayers(out, read, conv, naPireps, window, notes) {
  if (read && read.length && out.sigmetGrid) {
    out.sigmetGrid.areas = {
      na: areaSigmet(conv && conv.length ? withConvective(read, conv) : read, window, 'na', conv && conv.length ? NA_SOURCES : NA_SOURCES.slice(0, 1)),
      me: areaSigmet(read, window, 'me', ['AWC international SIGMETs, 3-hourly samples']),
    };
    (out.sigmetGrid.days || []).forEach(d => Object.keys(out.sigmetGrid.areas).forEach(a => {
      const x = out.sigmetGrid.areas[a].days.find(y => y.date === d.date);
      if (x && d.counts) d.counts[a] = x.counts[a];
    }));
    if (!conv || !conv.length) notes.push('Map, SIGMETs North America: no US convective SIGMETs from the IEM archive this week — the US mainland has no thunderstorm warnings on the map for lack of data, not calm weather');
    notes.push('Map, SIGMETs North America: US domestic turbulence and icing SIGMETs are in neither archive; the pilot-report layer shows reported turbulence instead');
  }
  const R = out.sigmets && out.sigmets.regions;
  Object.keys(AREA_FIRS).forEach(a => {
    const sl = R && R[a] && R[a].silent;
    if (sl && sl.length) notes.push('Map, SIGMETs ' + AREA_NAMES[a] + ': no SIGMET from ' + sl.map(f => f.name + ' ' + f.fir).join(', ') +
      ' in the AWC feed this week' + (a === 'na' ? ' (the IEM archive has US SIGMETs only)' : '') + '; empty there means no data or a quiet week, not calm weather');
  });
  if (naPireps) {
    out.pireps = out.pireps || {};
    (out.pireps.areas = out.pireps.areas || {}).na = naPireps;
    notes.push('Map, PIREPs North America: dots are reports of moderate-to-severe or worse turbulence or icing, shading counts moderate reports; ' +
               'reports follow traffic (few over Canada, Alaska and the Gulf), no report does not mean smooth air');
  }
}

// ---- fetch ------------------------------------------------------------------------------------
async function fetchWxReview({ from, to }) {
  const t0 = Date.now(), nowMs = Date.now();
  const oldestMs = nowMs - AWC_DAYS_KEPT * 86400000 + 3600000;
  if (Date.parse(from + 'T00:00:00Z') < oldestMs) {
    throw new Error('the AWC SIGMET database keeps ' + AWC_DAYS_KEPT + ' days; ' + from + ' is older than ' +
                    new Date(oldestMs).toISOString().slice(0, 10) + ' — the week would be incomplete');
  }
  const window = { from, to };
  const sources = [], notes = [], hits = {}, timeouts = {}, dead = new Map(), lastStart = {};
  const late = () => (Date.now() - t0) / 1000 > SOFT_DEADLINE_S;
  // Every request goes through here: counted and paced per host, refused past the deadline or once
  // its host has timed out twice or refused us (403/429) — never retried around a block.
  async function req(url, fn) {
    const h = url.split('/')[2];
    if (dead.has(h)) throw new Error('skipped — ' + dead.get(h));
    if (late()) throw new Error('skipped — time budget (' + SOFT_DEADLINE_S + ' s) used up');
    const wait = (lastStart[h] || 0) + (GAP_MS[h] || 500) - Date.now();
    if (wait > 0) await U.sleep(wait);
    lastStart[h] = Date.now();
    hits[h] = (hits[h] || 0) + 1;
    try { return await fn(); }
    catch (e) {
      const m = String((e && e.message) || e);
      if (/timeout/.test(m) && (timeouts[h] = (timeouts[h] || 0) + 1) >= DEAD_AFTER_TIMEOUTS) dead.set(h, h + ' timed out ' + timeouts[h] + ' times in this run');
      const blocked = /HTTP (403|429)\b/.exec(m);
      if (blocked) dead.set(h, h + ' answered ' + blocked[0] + ' — not asked again');
      throw e;
    }
  }
  const text = (url, ms) => req(url, () => U.getText(url, { timeoutMs: ms }));
  const out = { pages: PAGES, sources, notes };
  let awcRead = null, convRecs = null, naPireps = null;          // kept for the North America / Middle East layers

  async function run(key, name, url, page, fn) {
    const src = { key, name, url, page, ok: false };
    sources.push(src);
    try { const r = await fn(src); src.ok = true; return r; }
    catch (e) { src.error = clip(String((e && e.message) || e), 200); notes.push(name + ' unavailable — ' + src.error); return null; }
  }

  async function awcChain() {
    out.sigmets = await run('awc-isigmet', 'AWC international SIGMETs (3-hourly samples)', 'https://aviationweather.gov/api/data/isigmet', PAGES.awc, async src => {
      const plan = samplesFor(from, to, nowMs);
      const read = [], failed = [];
      for (const t of plan.planned) {
        try {
          const body = await text(AWC_URL(awcStamp(t)), TIMEOUT_MS.awc);
          const list = body.trim() ? JSON.parse(body) : [];          // 204 = no SIGMET valid at that moment
          if (!Array.isArray(list)) throw new Error('answer is not a list');
          read.push({ time: t, list });
        } catch (e) { failed.push(t.slice(5, 13).replace('T', ' ') + 'Z ' + clip(String(e.message || e).replace(/^https?:\/\/\S+: /, ''), 80)); }
      }
      src.samples = { planned: plan.planned.length, read: read.length, failed: failed.length, future: plan.future.length, stepHours: SAMPLE_STEP_H };
      if (!read.length) throw new Error('no sample read (' + failed.slice(0, 2).join('; ') + ')');
      if (failed.length) notes.push('AWC: ' + failed.length + ' of ' + plan.planned.length + ' SIGMET samples not read (' + failed.slice(0, 3).join('; ') + (failed.length > 3 ? '; …' : '') + ')');
      if (plan.future.length) notes.push('AWC: the window runs to ' + to + '; ' + plan.future.length + ' sample(s) still in the future were not read');
      if (read.length < plan.planned.length * 0.75) notes.push('AWC: SIGMET coverage partial — counts are low');
      // The map layer, from the same samples (no further request): the week, then each day.
      try { out.sigmetGrid = sigmetGrid(read); out.sigmetGrid.days = sigmetDays(read, window); } catch (e) { notes.push('SIGMET grid not built — ' + clip(String(e.message || e), 100)); }
      awcRead = read;
      const gaps = feedGaps(read);
      if (gaps.length) notes.push(gapNote(gaps));
      return Object.assign({ samples: src.samples }, aggregateSigmets(read, window));
    });
    // Pilot / aircraft reports after the SIGMET samples, on the same host and pacing.
    out.pireps = await run('awc-pirep', 'AWC pilot/aircraft reports, moderate or worse (one call per day)', PIREP_URL, PAGES.pirep, async src => {
      const lists = [], missing = [], capped = [], h = 'aviationweather.gov', before = hits[h] || 0;
      for (const d of daysOf(from, to)) {
        if (Date.parse(d + 'T00:00:00Z') > nowMs) { missing.push(d + ' (not started)'); continue; }
        try {
          const body = await text(pirepUrl(d), TIMEOUT_MS.awc);
          const list = body.trim() ? JSON.parse(body) : [];          // 204 = no report
          if (!Array.isArray(list)) throw new Error('answer is not a list');
          if (list.length >= PIREP_CAP) capped.push(d);
          lists.push({ day: d, list });
        } catch (e) { missing.push(d + ' (' + clip(String(e.message || e).replace(/^https?:\/\/\S+: /, ''), 60) + ')'); }
      }
      src.days = { planned: daysOf(from, to).length, read: lists.length };
      if (!lists.length) throw new Error('no day read: ' + missing.slice(0, 3).join(', '));
      if (missing.length) notes.push('PIREPs: days not read — ' + missing.join(', '));
      if (capped.length) notes.push('PIREPs: ' + capped.join(', ') + ' returned the API maximum of ' + PIREP_CAP + ' reports — those days are incomplete');
      if (nowMs < Date.parse(U.addDays(to, 1) + 'T00:00:00Z')) notes.push('PIREPs: the window runs to ' + to + ', which was not over at run time');
      notes.push('Map, PIREPs: dots show where crews reported moderate or worse turbulence or icing; no dot means nobody reported, not smooth air. ' +
                 'Most reports come from the US and a few airlines; callsigns and aircraft types removed');
      return pirepBlock(lists, window, { calls: (hits[h] || 0) - before, capped, missing });
    });
  }

  async function otherChain() {
    out.hubs = await run('iem-metar', 'IEM METAR archive (hubs)', IEM_METAR, PAGES.iemMetar, async () => {
      const rows = csvObjects(await text(iemMetarUrl(from, to), TIMEOUT_MS.iem));
      if (!rows.length || !('wxcodes' in rows[0])) throw new Error('no METAR rows in the answer');
      const r = aggregateMetars(rows, window);
      if (r.missing.length === HUBS.length) throw new Error('none of the ' + HUBS.length + ' hubs in the answer');
      if (r.missing.length) notes.push('IEM METAR: no observations for ' + r.missing.join(', '));
      return r;
    });
    out.us = await run('iem-sigmet', 'IEM SIGMET archive (US convective + oceanic)', IEM_SIGMET, PAGES.iemSigmet, async () => {
      const body = await text(iemSigmetUrl(from, to), TIMEOUT_MS.iem);
      if (!/<kml\b/.test(body.slice(0, 400))) throw new Error('no KML in the answer: ' + clip(body.slice(0, 120), 100));
      const rows = parseIemKml(body);
      const r = aggregateIemSigmets(rows, window);
      if (!r.convective.total && !r.oceanic.length) throw new Error('no SIGMET in ' + rows.length + ' rows — the archive answered empty for a whole week');
      convRecs = iemConvective(rows);
      return r;
    });
    // North American pilot reports: the IEM archive, one request for the week (AWC would need 28 calls: over 400 a day).
    naPireps = await run('iem-pirep', 'IEM PIREP archive (North America, one request)', IEM_PIREP, PAGES.iemPirep, async () => {
      const body = await text(iemPirepUrl(from, to), TIMEOUT_MS.iemPirep);
      if (!/^VALID,/.test(body)) throw new Error('unexpected answer: ' + clip(body.slice(0, 120), 100));
      const r = iemPirepRows(body, window);
      if (!r.read) throw new Error('no PIREP row in the answer');
      return naPirepBlock(r.rows, window, { calls: 1, read: r.read, duplicates: r.duplicates });
    });
    out.spc = await run('spc-reports', 'SPC storm reports (7 daily files)', 'https://www.spc.noaa.gov/climo/reports/', PAGES.spc, async () => {
      const days = [], missing = [], points = [];
      for (const d of daysOf(from, to)) {
        if (Date.parse(d + 'T12:00:00Z') > nowMs) { missing.push(d + ' (not started)'); continue; }
        try { const t = await text(SPC_CSV(d), TIMEOUT_MS.spc); days.push(Object.assign({ date: d, page: SPC_DAY_PAGE(d) }, parseSpcCsv(t))); points.push(...spcPoints(t, d)); }
        catch (e) { missing.push(d + ' (' + clip(String(e.message || e).replace(/^https?:\/\/\S+: /, ''), 60) + ')'); }
      }
      if (!days.length) throw new Error('no day file read: ' + missing.join(', '));
      if (missing.length) notes.push('SPC: day files not read — ' + missing.join(', '));
      if (nowMs < Date.parse(U.addDays(to, 1) + 'T12:00:00Z')) notes.push('SPC: the ' + to + ' file covers 12Z ' + to + ' to 12Z next day and is still incomplete at run time');
      days.forEach(d => { d.topStates = Object.entries(d.states).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([s, n]) => s + ' ' + n); delete d.states; });
      points.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
      return { dayDefinition: '12Z on the date to 11:59Z the next day, preliminary reports', days, missing, week: summarizeSpc(days),
               reportFields: ['t', 'lat', 'lon', 'kind', 'magnitude'], reportCodes: { T: 'tornado (EF rating, null = unrated)', W: 'wind (mph, null = unknown)', H: 'hail (inches)' },
               reports: points };
    });
  }

  // GFS analyses, 00Z of each day of the window: the jet map at 300/250/200 hPa and, from the same
  // request, the flight-level grids (tropopause, max-wind level, freezing level). NOMADS keeps about ten days.
  async function jetChain() {
    out.jet = await run('gfs-analysis', 'NOAA GFS analyses: jet and flight levels (NOMADS)', NOMADS, PAGES.gfs, async src => {
      const items = [], levelItems = [], missing = [], noLevels = [], archived = [];
      for (const d of daysOf(from, to)) {
        if (Date.parse(d + 'T04:00:00Z') > nowMs) { missing.push(d + ' (not yet published)'); continue; }
        try {
          let b = null, nomadsErr = null;
          try {
            const url = gfsAnalysisUrl(d, WX.JET_LEVELS, true);
            b = await req(url, () => WX.getBuffer(url, { timeoutMs: TIMEOUT_MS.gfs }));
            if (!(Buffer.isBuffer(b) && b.toString('latin1', 0, 4) === 'GRIB')) throw new Error('no GRIB in the answer (cycle no longer on the server?)');
          } catch (e) {
            // NOMADS no longer has the day (or is down): the same analysis from NOAA's archive on AWS.
            nomadsErr = e; b = null;
            try {
              const file = gfsArchiveFile(d);
              const idx = await req(file + '.idx', () => U.getText(file + '.idx', { retries: 0 }));
              const ranges = archiveRanges(idx, archiveWanted(WX.JET_LEVELS));
              if (!ranges.length) throw new Error('inventory lists none of the fields');
              const parts = [];
              for (const r of ranges) parts.push(await req(file, () => WX.getRange(file, r.offset, r.length, { timeoutMs: TIMEOUT_MS.gfs, retries: 1 })));
              b = Buffer.concat(parts);
              archived.push(d);
            } catch (e2) {
              throw new Error('NOMADS: ' + String(nomadsErr.message || nomadsErr).replace(/^https?:\/\/\S+: /, '') + '; archive: ' + String(e2.message || e2).replace(/^https?:\/\/\S+ /, ''));
            }
          }
          const f = WX.pickFields(WX.decodeGrib2(b));
          const grids = WX.jetGridsOf(f);
          if (!grids['250']) throw new Error('no 250 hPa u/v in the answer');
          const areas = WX.areaGridsOf(f, true);
          items.push({ valid: d + 'T00:00:00.000Z', grids, areas });
          const lv = WX.levelGridsOf(f);
          if (lv) levelItems.push({ valid: d + 'T00:00:00.000Z', grids: lv, areas }); else noLevels.push(d);
        } catch (e) { missing.push(d + ' (' + clip(String(e.message || e).replace(/^https?:\/\/\S+: /, ''), 60) + ')'); }
      }
      src.days = { planned: daysOf(from, to).length, read: items.length };
      if (archived.length) { src.archiveDays = archived; notes.push('GFS analyses of ' + archived.join(', ') + ' read from the NOAA GFS archive on AWS (NOMADS no longer had them).'); }
      if (!items.length) throw new Error('no analysis read: ' + missing.slice(0, 3).join(', '));
      if (missing.length) notes.push('GFS analyses not read — ' + missing.join(', '));
      if (noLevels.length) notes.push('GFS: no flight-level fields in the analyses of ' + noLevels.join(', '));
      out.levels = WX.levelDays(levelItems, 'GFS 1.0° analysis', { hourUtc: 0 });
      if (out.levels) {
        notes.push(WX.LEVEL_NOTE);
        const al = WX.areaLevelDays(levelItems, 'GFS 1.0° analysis', { hourUtc: 0 });
        if (al) out.levels.areas = al;
      }
      const jet = WX.jetLevels(items, 'GFS analysis', { hourUtc: 0, missing });
      const aj = jet && WX.areaJetLevels(items, 'GFS analysis', { hourUtc: 0 });
      if (aj) jet.areas = aj;
      return jet;
    });
  }

  await Promise.all([awcChain(), otherChain(), jetChain()]);
  if (!sources.some(s => s.ok)) throw new Error('every source failed (' + sources.length + '), first: ' + notes.slice(0, 2).join('; '));
  // North America and Middle East from the data already read (no request): SIGMET grids (+ US convective for NA),
  // their day counts into the Europe/NAT day strip, the NA pilot reports, the notes for silent FIRs.
  try { addAreaLayers(out, awcRead, convRecs, naPireps, window, notes); } catch (e) { notes.push('North America / Middle East SIGMET layers not built — ' + clip(String(e.message || e), 100)); }
  out.requests = hits;
  out.seconds = Math.round((Date.now() - t0) / 1000);
  const sg = out.sigmets;
  out.summary = [window.from + ' .. ' + window.to + ' · ' + sources.filter(s => s.ok).length + '/' + sources.length + ' sources · ' +
                 (sg ? sg.unique + ' SIGMETs (' + sg.regions.europe.total + ' Europe, ' + sg.regions.nat.total + ' NAT) from ' + sg.samples.read + '/' + sg.samples.planned + ' samples · ' : '') +
                 (out.sigmetGrid ? 'SIGMET grid ' + Object.keys(out.sigmetGrid.hazards).join('/') + (out.sigmetGrid.days ? ' + ' + out.sigmetGrid.days.length + ' days' : '') + ' · ' : '') +
                 (out.pireps && out.pireps.reports ? out.pireps.reports.length + ' PIREP rows from ' + out.pireps.calls + ' calls' + (out.pireps.capped.length ? ' (capped ' + out.pireps.capped.join(', ') + ')' : '') + ' · ' : '') +
                 (naPireps ? 'NA PIREPs ' + naPireps.severe.length + ' severe rows + moderate grid · ' : '') +
                 (out.sigmetGrid && out.sigmetGrid.areas ? 'area grids ' + Object.keys(out.sigmetGrid.areas).join('/') + ' · ' : '') +
                 (out.jet ? 'jet ' + out.jet.days.length + ' analyses × ' + (out.jet.levels || ['250']).length + ' levels · ' : '') +
                 (out.levels ? 'flight levels ' + out.levels.days.length + ' days · ' : '') +
                 sumObj(hits) + ' requests (' + Object.keys(hits).map(h => h + ' ' + hits[h]).join(', ') + ') · ' + out.seconds + ' s'];
  return out;
}

// ---- US convective SIGMETs and SPC storm reports only (the public relay's "this week so far") ------------
// The same requests, parsers and North America map layer as fetchWxReview, without anything international or
// airport-specific: no AWC SIGMET samples, no PIREPs/AIREPs, no METARs, no hubs, no GFS. The result keeps the weekly
// structure so the same renderer draws it: sigmets, pireps, hubs, jet and levels are null; us.oceanic is [] and
// us.pacificOceanic 0 (only the convective SIGMETs are kept); sigmetGrid has no samples for Europe/NAT (top level, and
// its days carry counts.na only) and areas.na = the US convective SIGMETs in force at the 3-hourly sample moments of
// the window, as in the weekly North America grid without its AWC part. IEM: one request; SPC: one file per day.
//   fetchUsObserved({ from, to })   nowMs, gapMs: tests only
const US_ONLY_NOTE = 'US convective SIGMETs and SPC storm reports only: no international, oceanic, Canadian or Mexican SIGMETs, no pilot reports, ' +
  'no airport observations in this file. Outside the US mainland the SIGMET layer has no data (not calm weather)';
async function fetchUsObserved({ from, to, nowMs: nowArg, gapMs }) {
  const t0 = Date.now(), nowMs = nowArg == null ? Date.now() : nowArg, window = { from, to };
  const sources = [], notes = [], hits = {}, dead = new Map(), lastStart = {};
  // Paced per host as fetchWxReview does; a host that answered 403/429 is not asked again.
  async function text(url, ms) {
    const h = url.split('/')[2];
    if (dead.has(h)) throw new Error('skipped — ' + dead.get(h));
    const wait = (lastStart[h] || 0) + (gapMs != null ? gapMs : (GAP_MS[h] || 500)) - Date.now();
    if (wait > 0) await U.sleep(wait);
    lastStart[h] = Date.now();
    hits[h] = (hits[h] || 0) + 1;
    try { return await U.getText(url, { timeoutMs: ms }); }
    catch (e) { const b = /HTTP (403|429)\b/.exec(String((e && e.message) || e)); if (b) dead.set(h, h + ' answered ' + b[0] + ' — not asked again'); throw e; }
  }
  async function run(key, name, url, page, fn) {
    const src = { key, name, url, page, ok: false };
    sources.push(src);
    try { const r = await fn(src); src.ok = true; return r; }
    catch (e) { src.error = clip(String((e && e.message) || e), 200); notes.push(name + ' unavailable — ' + src.error); return null; }
  }
  const out = { pages: { iemSigmet: PAGES.iemSigmet, spc: PAGES.spc }, sources, notes, scope: 'us-only',
                hubs: null, sigmets: null, pireps: null, jet: null, levels: null };
  let conv = null;
  out.us = await run('iem-sigmet', 'IEM SIGMET archive (US convective SIGMETs)', IEM_SIGMET, PAGES.iemSigmet, async () => {
    const body = await text(iemSigmetUrl(from, to), TIMEOUT_MS.iem);
    if (!/<kml\b/.test(body.slice(0, 400))) throw new Error('no KML in the answer: ' + clip(body.slice(0, 120), 100));
    const rows = parseIemKml(body), r = aggregateIemSigmets(rows, window);
    conv = iemConvective(rows);
    r.oceanic = []; r.pacificOceanic = 0;
    return r;
  });
  out.spc = await run('spc-reports', 'SPC storm reports (one file per day)', 'https://www.spc.noaa.gov/climo/reports/', PAGES.spc, async () => {
    const days = [], missing = [], points = [];
    for (const d of daysOf(from, to)) {
      if (Date.parse(d + 'T12:00:00Z') > nowMs) { missing.push(d + ' (not started)'); continue; }
      try { const t = await text(SPC_CSV(d), TIMEOUT_MS.spc); days.push(Object.assign({ date: d, page: SPC_DAY_PAGE(d) }, parseSpcCsv(t))); points.push(...spcPoints(t, d)); }
      catch (e) { missing.push(d + ' (' + clip(String(e.message || e).replace(/^https?:\/\/\S+: /, ''), 60) + ')'); }
    }
    if (!days.length) throw new Error('no day file read: ' + missing.join(', '));
    if (missing.some(m => !/not started/.test(m))) notes.push('SPC: day files not read — ' + missing.join(', '));
    if (nowMs < Date.parse(U.addDays(to, 1) + 'T12:00:00Z')) notes.push('SPC: the ' + days[days.length - 1].date + ' file covers 12Z that day to 12Z the next and is still incomplete at run time');
    days.forEach(d => { d.topStates = Object.entries(d.states).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([st, n]) => st + ' ' + n); delete d.states; });
    points.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    return { dayDefinition: '12Z on the date to 11:59Z the next day, preliminary reports', days, missing, week: summarizeSpc(days),
             reportFields: ['t', 'lat', 'lon', 'kind', 'magnitude'], reportCodes: { T: 'tornado (EF rating, null = unrated)', W: 'wind (mph, null = unknown)', H: 'hail (inches)' },
             reports: points };
  });
  if (!sources.some(x => x.ok)) throw new Error('every source failed: ' + notes.slice(0, 2).join('; '));
  // The North America SIGMET grid at the 3-hourly sample moments the weekly file uses, from the IEM rows only.
  if (conv) {
    const moments = samplesFor(from, to, nowMs).planned.map(t => ({ time: t, list: [] }));
    out.sigmetGrid = sigmetGrid([]);
    out.sigmetGrid.days = sigmetDays([], window).map(d => ({ date: d.date, samples: 0, hazards: {}, counts: {} }));
    out.sigmetGrid.areas = { na: areaSigmet(withConvective(moments, conv), window, 'na', NA_SOURCES.slice(1)) };
    out.sigmetGrid.days.forEach(d => { const x = out.sigmetGrid.areas.na.days.find(y => y.date === d.date); if (x) d.counts.na = x.counts.na; });
  } else out.sigmetGrid = null;
  notes.push(US_ONLY_NOTE);
  out.requests = hits;
  out.seconds = Math.round((Date.now() - t0) / 1000);
  const cv = out.us && out.us.convective;
  out.summary = [from + ' .. ' + to + ' · ' + sources.filter(x => x.ok).length + '/' + sources.length + ' sources · ' + (cv ? cv.total + ' US convective SIGMETs · ' : '') +
                 (out.spc ? out.spc.reports.length + ' SPC reports · ' : '') + sumObj(hits) + ' requests · ' + out.seconds + ' s'];
  return out;
}

// ---- digest -----------------------------------------------------------------------------------
const srcOf = (s, key) => (s.sources || []).find(x => x.key === key) || null;
const dayLine = byDay => Object.keys(byDay || {}).sort().map(d => wd(d) + ' ' + byDay[d]).join(' · ');
const qualLine = q => Object.entries(q || {}).filter(([k]) => k !== 'unspecified').sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', ');
function hazLine(R) {
  const ks = Object.keys(R.hazards || {}).sort((a, b) => (HAZARD_ORDER.indexOf(a) + 1 || 99) - (HAZARD_ORDER.indexOf(b) + 1 || 99));
  return ks.length ? ks.map(k => { const H = R.hazards[k], q = qualLine(H.qual); return k + ' ' + H.n + (q ? ' (' + q + ')' : ''); }).join(' · ') : 'none';
}
const topLine = (H, n) => ((H && H.topFirs) || []).slice(0, n || 5).map(f => f.name + ' ' + f.fir + ' ' + f.n +
  (f.qual && f.qual['SEV MTW'] ? ' (MTW ' + f.qual['SEV MTW'] + ')' : '')).join(', ');
const firList = fs => (fs || []).map(f => f.name + ' ' + f.fir).join(', ');
// "SIGMETs BY DAY …": distinct SIGMETs in force per day, Europe | NAT, and each region's busiest day.
function sigmetDayLine(days) {
  if (!days || !days.length) return null;
  const per = 24 / SAMPLE_STEP_H;
  const tot = (d, rg) => sumObj(d.counts && d.counts[rg]);
  const hz = c => Object.entries(c || {}).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', ');
  const busiest = rg => { const d = days.slice().sort((a, b) => tot(b, rg) - tot(a, rg) || a.date.localeCompare(b.date))[0];
    return d && tot(d, rg) ? fmtDay(d.date) + ' (' + hz(d.counts[rg]) + ')' : 'none'; };
  return 'SIGMETs BY DAY (distinct SIGMETs in force that day, Europe | NAT): ' +
    days.map(d => wd(d.date) + ' ' + tot(d, 'europe') + ' | ' + tot(d, 'nat') + (d.samples < per ? ' (' + d.samples + '/' + per + ' samples)' : '')).join(' · ') +
    ' — busiest: Europe ' + busiest('europe') + ', NAT ' + busiest('nat') + '.';
}
// "PIREPs …": reports per box and kind, the busiest day over NAT + Europe, the caveat.
function pirepLine(p) {
  if (!p || !p.counts) return null;
  const rs = p.reports || [], B = p.boxes || PIREP_BOXES;
  const kinds = c => { const T = c.T.mod + c.T.sev, I = c.I.mod + c.I.sev;
    return T + ' turbulence' + (c.T.sev ? ' (' + c.T.sev + ' severe)' : '') + ', ' + I + ' icing' + (c.I.sev ? ' (' + c.I.sev + ' severe)' : ''); };
  // A T and an I row of one report share time, place, level and source (two aircraft at the same minute
  // and place but different levels stay two reports; a report without an aircraft level whose two
  // layers have different bases counts twice — rare).
  const reportKey = r => r[0] + '|' + r[1] + '|' + r[2] + '|' + r[3] + '|' + r[6];
  const byDay = {}, seen = new Set();
  rs.filter(r => inBox(r, B.nat) || inBox(r, B.europe)).forEach(r => { const k = reportKey(r); if (!seen.has(k)) { seen.add(k); inc(byDay, r[0].slice(0, 10)); } });
  const top = Object.entries(byDay).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const all = new Set(rs.map(reportKey)).size;
  return 'PIREPs/AIREPs, moderate or worse (AWC; crew reports, callsigns removed): NAT (40–65N 60–10W) ' + kinds(p.counts.nat) +
    ' · Europe (35–72N 15W–40E) ' + kinds(p.counts.europe) + (top ? ' · busiest day ' + fmtDay(top[0]) + ' (' + top[1] + ' reports over NAT + Europe)' : '') +
    ' · ' + all + ' reports in the whole map frame (25–75N 80W–40E)' + ((p.capped || []).length ? ' · INCOMPLETE (API maximum reached): ' + p.capped.join(', ') : '') +
    '. Counts show who reports, not where it was rough; no report does not mean smooth air.';
}

// "NORTH AMERICA … / MIDDLE EAST …": an area's SIGMETs (overlapping the regions above), top FIRs, silent FIRs.
function areaSigmetLine(a, R) {
  if (!R) return null;
  const tops = Object.keys(R.hazards || {}).sort((x, y) => (HAZARD_ORDER.indexOf(x) + 1 || 99) - (HAZARD_ORDER.indexOf(y) + 1 || 99)).slice(0, 3)
    .map(k => k + ' ' + topLine(R.hazards[k], 4)).filter(t => !/ $/.test(t));
  const sl = R.silent || [];
  return (a === 'na' ? 'NORTH AMERICA (' + R.total + ' AWC international SIGMETs — Mexico, Caribbean, US oceanic, Alaska; US mainland in the US CONVECTIVE line): '
                     : 'MIDDLE EAST (' + R.total + ' SIGMETs; Turkey and Cyprus also count under Europe): ') + hazLine(R) +
    (R.hazards.TS && a === 'me' ? ' — TS by day: ' + dayLine(R.tsByDay) : '') + (tops.length ? ' — FIRs: ' + tops.join('; ') : '') +
    (sl.length ? ' — NO SIGMET received from ' + sl.map(f => f.fir).join(' ') + ' (feed gap or quiet week, not calm)' : '') + '.';
}
// "PIREPs NORTH AMERICA …": the IEM block's counts per box, busiest day, dots.
function naPirepLine(p) {
  if (!p || !p.counts) return null;
  const c = p.counts, B = { conus: 'CONUS', canada: 'Canada', alaska: 'Alaska' };
  const part = x => { const T = x.T.mod + x.T.sev, I = x.I.mod + x.I.sev; return T + ' turbulence' + (x.T.sev ? ' (' + x.T.sev + ' severe)' : '') + ', ' + I + ' icing' + (x.I.sev ? ' (' + x.I.sev + ' severe)' : ''); };
  const top = (p.modGrid && p.modGrid.days || []).slice().sort((a, b) => b.n - a.n || a.date.localeCompare(b.date))[0];
  return 'PIREPs NORTH AMERICA (IEM archive of US pilot reports, moderate or worse, one request): ' + part(c.na) + ' — ' +
    Object.keys(B).filter(k => c[k]).map(k => B[k] + ' ' + (c[k].T.mod + c[k].T.sev + c[k].I.mod + c[k].I.sev)).join(' · ') +
    (top && top.n ? ' · most moderate reports ' + fmtDay(top.date) + ' (' + top.n + ')' : '') + ' · ' + (p.severe || []).length + ' rows moderate-to-severe or worse (map dots)' +
    '. Reports follow traffic; no report does not mean smooth air.';
}
// "MIDDLE EAST HUBS …": heat, dust/sand, haze, thunderstorm, fog per hub-day.
function meHubLine(hb) {
  const st = (hb.stations || []).filter(x => x.area === 'me');
  if (!st.length) return null;
  const T = hb.thresholds || HUB_T;
  const list = (k, ok, fmt) => st.map(x => ({ x, ds: x.days.filter(d => ok(d[k])) })).filter(y => y.ds.length).map(y => y.x.code + ' ' + y.ds.map(d => wd(d.date) + ' ' + fmt(d)).join(' '));
  const heat = list('tmaxC', v => v != null && v >= T.heatC, d => d.tmaxC);
  const dust = list('dust', v => v > 0, d => d.dust + 'h' + (d.visMinM != null && d.visMinM < 5000 ? ' (' + d.visMinM + ' m)' : ''));
  const haze = list('haze', v => v >= T.hazeHours, d => d.haze + 'h');
  const ts = list('ts', v => v > 0, d => d.ts + 'h'), fog = list('fog', v => v >= T.fogHours, d => d.fog + 'h');
  const hot = st.filter(x => x.week && x.week.tmaxC != null).sort((a, b) => b.week.tmaxC - a.week.tmaxC)[0];
  const none = st.filter(x => !x.obs).map(x => x.code);
  return 'MIDDLE EAST HUBS (METARs; heat = maximum ≥ ' + T.heatC + ' °C, haze = haze/smoke below ' + (T.hazeVisM / 1000) + ' km for ' + T.hazeHours + ' h+): heat — ' +
    (heat.length ? clip(heat.join(' · '), 160) : 'none') + (hot ? ' (hottest ' + hot.code + ' ' + hot.week.tmaxC + ' °C)' : '') + '; dust/sand — ' + (dust.length ? clip(dust.join(' · '), 240) : 'none') +
    '; haze — ' + (haze.length ? clip(haze.join(' · '), 140) : 'none') + '; thunderstorm — ' + (ts.length ? clip(ts.join(' · '), 120) : 'none') + '; fog — ' + (fog.length ? fog.join(' · ') : 'none') +
    (none.length ? ' · no METARs: ' + none.join(' ') : '') + '.';
}

function digest(s) {
  const L = [], w = s.window || {};
  L.push("WEATHER REVIEW — what the reporting week's weather was (" + w.from + '–' + w.to + '), events not forecasts');
  const sg = s.sigmets;
  if (sg) {
    L.push('SIGMETs in force at ' + sg.samples.read + ' of ' + sg.samples.planned + ' three-hourly samples (AWC international feed): ' + sg.unique +
           ' distinct SIGMETs worldwide' + (sg.cancelled ? ', ' + sg.cancelled + ' cancellations left out' : '') + '. Counts by FIR region; TS days by validity start.');
    const eu = sg.regions.europe, nat = sg.regions.nat;
    L.push('EUROPE (' + eu.total + '): ' + hazLine(eu) + (eu.hailTs ? ' · TS with hail ' + eu.hailTs : '') + '.');
    if (eu.hazards.TS) L.push('  TS by day: ' + dayLine(eu.tsByDay) + ' — top FIRs: ' + topLine(eu.hazards.TS) + '.');
    const other = ['TURB', 'ICE'].filter(k => eu.hazards[k]).map(k => k + ': ' + topLine(eu.hazards[k], 4));
    if (other.length) L.push('  ' + other.join(' · ') + '.');
    const ce = sg.centralEurope || { missing: [] };
    if (ce.missing.length) L.push('  GAP: no SIGMET at all in the feed from ' + ce.missing.map(f => f.fir).join(' ') + ' (' + clip(ce.missing.map(f => f.name).join(', '), 120) +
      ') — a feed gap, not calm weather; there use the hub METARs below and the EUROCONTROL delay causes.');
    L.push('NORTH ATLANTIC (' + nat.total + '): ' + hazLine(nat) + (nat.hazards.TS ? ' — TS by day: ' + dayLine(nat.tsByDay) : '') +
           ' — FIRs: ' + (Object.values(nat.hazards).length ? Object.entries(nat.hazards).map(([k, H]) => k + ' ' + topLine(H, 3)).join('; ') : 'none') + '.');
    const sdl = sigmetDayLine(s.sigmetGrid && s.sigmetGrid.days);
    if (sdl) L.push(sdl);
    ['na', 'me'].forEach(a => { const al = areaSigmetLine(a, sg.regions[a]); if (al) L.push(al); });
    const vEN = sg.volcanoes.filter(v => v.regions.includes('europe') || v.regions.includes('nat')), vRest = sg.volcanoes.filter(v => !vEN.includes(v));
    const vMore = (sg.volcanoCount || sg.volcanoes.length) - vEN.length - Math.min(vRest.length, 8);
    L.push('VOLCANIC ASH (VA SIGMETs): Europe/NAT — ' + (vEN.length ? vEN.map(v => v.name + ': ' + firList(v.firs) + ', ' + dayRanges(v.days) + ' (' + v.n + ')').join('; ') : 'none') +
           '. Elsewhere — ' + (vRest.length ? vRest.slice(0, 8).map(v => v.name + ' (' + v.firs.map(f => f.fir).join('/') + ')').join(', ') + (vMore > 0 ? ' and ' + vMore + ' more' : '') : 'none') + '.');
    L.push('TROPICAL CYCLONES (TC SIGMETs): ' + (sg.cyclones.length ? clip(sg.cyclones.map(c => c.name + ((c.regions.includes('nat') || c.regions.includes('europe')) ? ' [NAT/Europe]' : '') +
           ' — ' + c.firs.map(f => f.name + ' ' + f.fir).join(', ') + ', ' + dayRanges(c.days)).join('; '), 420) : 'none in force at any sample') + '.');
  }
  const pl = pirepLine(s.pireps);
  if (pl) L.push(pl);
  const npl = naPirepLine(s.pireps && s.pireps.areas && s.pireps.areas.na);
  if (npl) L.push(npl);
  const jt = s.jet;
  if (jt && jt.max && jt.max.length) {
    L.push('NAT JET (GFS 250 hPa analyses, ' + String(jt.hourUtc == null ? 0 : jt.hourUtc).padStart(2, '0') + 'Z; strongest wind in 25–75N 80W–40E): ' +
           jt.max.map(m => wd(m.date) + ' ' + m.kt + ' kt ' + Math.abs(m.lat) + (m.lat < 0 ? 'S ' : 'N ') + Math.abs(m.lon) + (m.lon < 0 ? 'W' : 'E')).join(' · ') + '.');
    const lm = WX.jetLevelMax(jt);
    if (lm.length > 1) L.push('  week max by level (300/250/200 hPa): ' + lm.map(m => m.fl + ' ' + m.kt + ' kt ' + wd(m.date)).join(' · ') + '.');
  }
  const ajl = WX.areaJetLine(jt, 'GFS analyses, 00Z');
  if (ajl) L.push(ajl);
  const lv = WX.levelLine(s.levels, 'GFS analyses, ' + String(s.levels && s.levels.hourUtc != null ? s.levels.hourUtc : 0).padStart(2, '0') + 'Z');
  if (lv) L.push(lv);
  const hb0 = s.hubs, hb = hb0 && Object.assign({}, hb0, { stations: (hb0.stations || []).filter(x => x.area !== 'me'), notable: (hb0.notable || []).filter(n => !(hb0.stations || []).some(x => x.code === n.code && x.area === 'me')) });
  if (hb) {
    const T = hb.thresholds || HUB_T;
    const cat = (k, min) => hb.stations.map(st => ({ st, days: st.days.filter(d => d[k] >= (min || 1)) })).filter(x => x.days.length)
      .sort((a, b) => b.days.reduce((s, d) => s + d[k], 0) - a.days.reduce((s, d) => s + d[k], 0))
      .map(x => x.st.code + ' ' + x.days.map(d => wd(d.date) + ' ' + d[k]).join(' '));
    const gusts = hb.stations.map(st => ({ st, days: st.days.filter(d => d.gustMaxKt != null && d.gustMaxKt >= T.gustKt) })).filter(x => x.days.length)
      .map(x => x.st.code + ' ' + x.days.map(d => wd(d.date) + ' ' + d.gustMaxKt).join(' '));
    const fog = cat('fog', T.fogHours), ts = cat('ts'), hail = cat('hail'), snow = cat('snow'), fz = cat('fz');
    L.push('HUB WEATHER (METARs, hours per day; fog = FG or visibility < ' + T.lowVisM + ' m, listed from ' + T.fogHours + ' h): fog/low vis — ' +
           (fog.length ? clip(fog.join(' · '), 300) : 'none') + '.');
    L.push('  thunderstorm (incl. VCTS) — ' + (ts.length ? clip(ts.join(' · '), 200) : 'none') + '; hail — ' + (hail.length ? hail.join(' · ') : 'none') +
           '; snow — ' + (snow.length ? clip(snow.join(' · '), 120) : 'none') + '; freezing — ' + (fz.length ? clip(fz.join(' · '), 120) : 'none') +
           '; gusts ≥ ' + T.gustKt + ' kt — ' + (gusts.length ? clip(gusts.join(' · '), 160) : 'none') + '.');
    const flagged = new Set((hb.notable || []).map(n => n.code));
    const quiet = hb.stations.filter(st => st.obs && !flagged.has(st.code)).map(st => st.code);
    const naX = hb.stations.filter(st => st.area === 'na').map(st => ({ st, ds: st.days.filter(d => (d.tmaxC != null && d.tmaxC >= T.heatC) || d.dust) })).filter(x => x.ds.length)
      .map(x => x.st.code + ' ' + x.ds.map(d => wd(d.date) + (d.tmaxC >= T.heatC ? ' ' + d.tmaxC + ' °C' : '') + (d.dust ? ' dust ' + d.dust + 'h' : '')).join(' '));
    if (naX.length) L.push('  North America heat ≥ ' + T.heatC + ' °C / dust — ' + clip(naX.join(' · '), 160) + '.');
    const meCodes = new Set((hb0.stations || []).filter(x => x.area === 'me').map(x => x.code));
    const miss = (hb.missing || []).filter(c => !meCodes.has(c));
    L.push('  no flag all week: ' + (quiet.length ? quiet.join(' ') : 'none') + (miss.length ? ' · no METARs: ' + miss.join(' ') : '') + '.');
    const mh = meHubLine(hb0);
    if (mh) L.push(mh);
  }
  const us = s.us;
  if (us) {
    const c = us.convective;
    L.push('US CONVECTIVE SIGMETs (IEM; reissued hourly, so these are SIGMET-hours): ' + c.total + ' — ' + dayLine(c.byDay) +
           (c.peak ? ' (peak ' + wd(c.peak.date) + ')' : '') + '; East ' + c.byRegion.East + ' · Central ' + c.byRegion.Central + ' · West ' + c.byRegion.West +
           '; severe TS ' + c.severeTs + ', tornado mentions ' + c.tornado + (c.hailMaxIn != null ? ', hail to ' + c.hailMaxIn + ' in' : '') +
           (c.gustMaxKt != null ? ', gusts to ' + c.gustMaxKt + ' kt' : '') + '.');
    if (us.oceanic.length) L.push('US OCEANIC SIGMETs (IEM, Atlantic/Gulf/Caribbean): ' + us.oceanic.map(o => o.fir + ' ' + o.total + ' (' +
      Object.entries(o.hazards).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(', ') + (o.peak ? '; peak ' + wd(o.peak.date) + ' ' + o.peak.n : '') + ')').join(' · ') +
      (us.pacificOceanic ? ' · Pacific oceanic ' + us.pacificOceanic : '') + '.');
  }
  const sp = s.spc;
  if (sp) {
    const wk = sp.week;
    L.push('SPC STORM REPORTS (US, preliminary; day = 12Z to 12Z; T tornado, W wind, H hail): ' + sp.days.map(d => wd(d.date) + ' T' + d.tornado + ' W' + d.wind + ' H' + d.hail).join(' · ') +
           ' — week ' + wk.tornado + ' tornado, ' + wk.wind + ' wind, ' + wk.hail + ' hail' + (wk.hailMaxIn != null ? ' (max ' + wk.hailMaxIn + ' in)' : '') +
           (wk.windMaxMph != null ? ', gusts to ' + wk.windMaxMph + ' mph' : '') + (wk.topStates.length ? '; most in ' + wk.topStates.slice(0, 3).map(x => x.state + ' ' + x.n).join(', ') : '') +
           (sp.reports ? '; ' + sp.reports.length + ' located reports on the map' : '') + '.');
  }
  const ok = (s.sources || []).filter(x => x.ok).map(x => x.key === 'awc-isigmet' && x.samples ? 'AWC ' + x.samples.read + '/' + x.samples.planned + ' samples'
    : x.key === 'iem-metar' ? 'IEM METAR' : x.key === 'iem-sigmet' ? 'IEM SIGMET' : x.key === 'spc-reports' ? 'SPC ' + (sp ? sp.days.length : '?') + ' days'
    : x.key === 'gfs-analysis' ? 'GFS ' + (s.jet ? s.jet.days.length : '?') + ' analyses'
    : x.key === 'awc-pirep' && x.days ? 'AWC PIREPs ' + x.days.read + '/' + x.days.planned + ' days' : x.key === 'iem-pirep' ? 'IEM PIREPs (North America)' : x.name);
  const bad = (s.sources || []).filter(x => !x.ok);
  // The standing "Map, …" caveats are for the dashboard legend; the lines above already say them.
  const runNotes = (s.notes || []).filter(n => !/unavailable —/.test(n) && !/^Map, /.test(n));
  L.push('READ: ' + (ok.join(' · ') || 'nothing') + '. UNAVAILABLE: ' + (bad.length ? bad.map(x => x.name + ' (' + String(x.error || '').replace(/^https?:\/\/\S+: /, '') + ')').join('; ') : 'none') +
         (runNotes.length ? '. NOTES: ' + clip(runNotes.join(' | '), 240) : '') + '.');
  const firstSpc = sp && sp.days.length ? sp.days[0].page : null;
  L.push('CITE: SIGMETs ' + PAGES.awc + ' (AWC) · hub METARs ' + PAGES.iemMetar + ' (IEM) · US SIGMET archive ' + PAGES.iemSigmet + ' · storm reports ' + PAGES.spc +
         (firstSpc ? ' (day pages like ' + firstSpc + ')' : '') + (s.pireps && s.pireps.reports ? ' · pilot reports ' + PAGES.pirep + ' (AWC)' : '') +
         (s.pireps && s.pireps.areas && s.pireps.areas.na ? ' · North American pilot reports ' + PAGES.iemPirep + ' (IEM)' : ''));
  L.push('');
  L.push('HOW TO USE THIS BLOCK');
  L.push('- Observed events of the reporting week: use them to explain the delay figures in the EUROCONTROL and US FLOW blocks (which days, where,');
  L.push('  what) and cite the source page from the CITE line. Never present them as a forecast.');
  L.push('- A single SIGMET is not news. A pattern (many TS SIGMETs over one area on the days with weather delays) or an unusual hazard');
  L.push('  (volcanic ash, a hurricane on a NAT route, severe mountain-wave turbulence) can be.');
  L.push('- Counts are SIGMETs in force at 3-hourly samples: how often a hazard was warned, not how big it was; short-lived ones can be missed.');
  L.push('- A FIR on the GAP line sends no SIGMETs to this feed: say nothing about its weather from SIGMETs. A source marked unavailable is said to');
  L.push('  be unavailable; do not fill the gap from memory or a web search.');
  if (s.pireps || s.levels) {
    L.push('- PIREP counts show where crews reported, not where it was rough: never write "no turbulence" for an area without reports.');
    L.push('  Flight levels are model-derived from GFS analyses: call them that, never an official forecast or chart.');
  }
  return L.join('\n');
}

module.exports = { NAT_FIRS, CENTRAL_FIRS, HUBS, HUB_T, REGION_NAMES, PAGES, SIGMET_GRID, GRID_HAZARDS, regionOf, parseCsv, csvObjects, samplesFor, awcStamp, sigmetKey, seriesOf, isCancel, firOf,
                   rleEncode, rleDecode, sigmetRings, sigmetGrid, gfsAnalysisUrl, gfsArchiveFile, archiveWanted, archiveRanges,
                   sigmetDays, feedGaps, gapNote, sigmetDayLine, PIREP_BBOX, PIREP_CAP, PIREP_BOXES, PIREP_FIELDS, PIREP_ATTRIBUTION, pirepUrl, pirepSev,
                   pirepRows, pirepCounts, pirepBlock, pirepLine,
                   firLabel, volcanoName, cycloneName, aggregateSigmets, iemMetarUrl, wxFlags, aggregateMetars, iemSigmetUrl, oceanicHazard,
                   aggregateIemSigmets, parseSpcCsv, summarizeSpc, dayRanges, digest,
                   AREA_FIRS, AREA_SIGMET_GRID, COUNT_HAZARDS, FIR_ALIAS, GFS_BOX, hazardOf, ringTouches, areasOf, areaCounts, areaSigmet, parseIemKml, iemConvective,
                   withConvective, iemPirepUrl, iemSev, iemPirepRows, naPirepBlock, NA_PIREP_BOXES, spcPoints, wxCodes, dustHaze, addAreaLayers,
                   areaSigmetLine, naPirepLine, meHubLine, fetchWxReview, cli, fetchUsObserved, US_ONLY_NOTE };
// The command line: U.main, then the snapshot rewritten without indentation (see compactSnapshot in fetch-wxoutlook.js).
function cli() {
  const week = U.cli(process.argv).week;
  return U.main('fetch-wxreview', 'wxreview', fetchWxReview, digest).then(() => {
    const n = WX.compactSnapshot('wxreview', week);
    if (n) console.log('fetch-wxreview: written compactly, ' + Math.round(n / 1024) + ' KB');
  });
}
if (require.main === module) cli();
