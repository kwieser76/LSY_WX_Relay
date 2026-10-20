#!/usr/bin/env node
// ---------------------------------------------------------------------------
// relay.js
// Fetches the WEEK-AHEAD aviation weather forecast data (public model and forecast products), today's North
// Atlantic track message and the observed weather of the current week so far, and writes one compact file,
// latest.json, for a weather map that offers a "refresh" button. Run by the GitHub Actions workflow
// (.github/workflows/wx-relay.yml) four times a day; node 20, no dependencies.
//
//   node relay.js [--out DIR] [--cache DIR] [--parts wxoutlook,sigwx,…,nat,since] [--deny-file FILE] [--allow-host HOST] [--blocked FILE]
//   node relay.js --check-blocked FILE      exit 1 while the stop note FILE holds an entry in force (the workflow's last step)
//
// Seven parts, run one after another (so two parts never hit the same server at the same time), each with
// its own time limit. A part that fails or runs out of time becomes null with its error in status; the
// others are still written. Only when every part failed, or the privacy check finds something, does the
// run exit 1 without writing — the published file then stays as it was.
//   wxoutlook   jets and flight levels, convective potential, GFS vs ECMWF, SPC/NHC/JTWC/WPC/CPC/SWPC
//               (scripts/fetch-wxoutlook.js with an empty hub list: no airport values at all)
//   sigwx       official WAFS SIGWX charts of the newest run, 12Z, up to T+48 (ahead charts only)
//   sigwxModel  model-derived SIGWX from GFS, the 7 days ahead (jets, tropopause; CAT and CB to +72 h)
//   gefscat     ensemble CAT probability from GEFS, days 3–7 ahead
//   dust        GEFS-Aerosols dust optical depth classes, 5 days (no airport values)
//   nat         today's North Atlantic track message (FAA NOTAM system, scripts/nat-message.js)
//   since       the observed weather of the current ISO week so far, Monday 00Z … now, in seven sub-parts:
//               wxreview  US convective SIGMETs (IEM archive) and SPC storm reports — nothing international,
//                         no pilot reports, no airport observations (scripts/fetch-wxreview.js fetchUsObserved)
//               lightning EUMETSAT MTG Lightning Imager, hours with lightning per 0.5° cell (Europe/NAT, Middle East)
//               mrms      NOAA MRMS radar storm hours (≥ 40 dBZ) and radar hail per 0.5° cell (US)
//               and, from 2026-10-12, over at least the last 3 days (on Monday from Saturday, on Tuesday from Sunday):
//               nat       the North Atlantic tracks of every day, both directions (public NAT archive LSY_NAT_Track,
//                         scripts/fetch-natarchive.js)
//               gfs       GFS 00Z analyses: jet at 300/250/200 hPa (FL300/340/390, all three since 2026-10-13) and the flight-level grids (tropopause, max-wind
//                         level, freezing level), three map frames (scripts/fetch-wxreview.js fetchGfsObserved)
//               faa       FAA Command Center weather restrictions per day and ARTCC, airports as positions only
//                         (scripts/fetch-faa.js fetchFaaObserved; positions from OurAirports)
//               and, from 2026-10-13, on the same window:
//               sigwx     SIGWX of every day at 12Z: { official, model } — the official WAFS chart (06Z run +6 h first,
//                         scripts/fetch-sigwx.js fetchSigwxObserved) and the model-derived picture from the GFS 12Z
//                         analysis (scripts/fetch-sigwx-model.js fetchSigwxModelObserved); each null when it failed
// window = today (UTC) … today + 6: the forecast days start on the day of the run; since.window = Monday … today;
// the window of nat, gfs, faa and sigwx (extWindowOf) = Monday … today, or today − 2 … today when that starts earlier, with
// weekFrom (the Monday) and beforeWeek (the days before it).
//
// Incremental: lightning (one frame per hour) and MRMS (one file per hour) are not downloaded again for hours an
// earlier run of the same week already read; the GFS analyses and the FAA advisory pages of the window are not read
// again either, nor the SIGWX charts of a day already read. --cache DIR holds lightning-<week>.json, mrms-<week>.json,
// gfs.json, faa.json and sigwx.json from the previous run
// (the workflow restores them from the data branch); a missing, corrupt or other-week cache means starting fresh. The
// updated caches are written to <out>/cache/ next to latest.json and published with it.
//
// Requests: every request goes through one wrapper that counts requests and bytes per part and host,
// and stops a host for the rest of the run after HTTP 403 or 429 (no retry, no other path). --deny-file
// names a file of hosts never to contact (first field of each line, "host · …"; re-read before every
// request); a 403/429 is appended to it. --allow-host exempts a host listed there.
// The stop note (2026-10-13): a 403/429 is also kept ACROSS runs. --blocked FILE (default <cache>/blocked.json, restored
// from the data branch) lists { host, status, at, until, path, part } per refusal; a host in force (BLOCK_HOURS after
// the refusal) is not contacted, and the run writes the entries still in force to <out>/cache/blocked.json, published
// with latest.json, so the next run respects them too. Until then a refusing host was asked again at the next run, four
// times a day. The workflow ends red while an entry is in force (--check-blocked), so a refusal is noticed.
//
// latest.json (schema "lsy-wx-relay/1"): { schema, generatedAt, relayRun {id, url}, window {from, to},
// parts {wxoutlook, sigwx, sigwxModel, gefscat, dust, nat, since} (each the same structure as the fetcher's
// weekly snapshot, or null; since = {window, wxreview, lightning, mrms}), status {<part>: {ok, error?, seconds,
// requests, megabytes, hosts}, 'since.wxreview' …}, attribution [], disclaimer }. See README.md. The 2026-10-12 sub-parts
// keep the schema name: a reader of lsy-wx-relay/1 that does not know them ignores them.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const SCHEMA = 'lsy-wx-relay/1';
const SCRIPTS = path.join(__dirname, 'scripts');
// The weather layer registry (scripts/wx-layers.js, 2026-10-20): the window rule of each part and the producer stamps.
// Next to relay.js in the packaged copy; in the project (tests) it is the project's own scripts/.
const LY = (() => { try { return require(path.join(SCRIPTS, 'wx-layers.js')); } catch (e) { return require(path.join(__dirname, '..', '..', 'scripts', 'wx-layers.js')); } })();
const PART_KEYS = ['wxoutlook', 'sigwx', 'sigwxModel', 'gefscat', 'dust', 'nat', 'since'];
const SINCE_KEYS = ['wxreview', 'lightning', 'mrms', 'nat', 'gfs', 'faa', 'sigwx'];
// The sub-parts on the window of at least MIN_DAYS days (extWindowOf): the registry's layers with window 'ext3'
// (nat, gfs, faa, sigwx; ADR-001 Q2 kept wxreview, lightning and mrms on Monday to now). And what faa must never carry.
const SINCE_EXT = SINCE_KEYS.filter(k => LY.sinceExt().includes(k));
// The producer stamp each part must carry ([path in the part, layer id]); null parts are not checked.
const STAMPS = {
  wxoutlook: [['producer', 'wxoutlook']], sigwx: [['producer', 'sigwx-official']], sigwxModel: [['producer', 'sigwx-model']],
  gefscat: [['producer', 'gefscat']], dust: [['producer', 'dust']], nat: [['producer', 'nat-message']],
  'since.wxreview': [['us.producer', 'us-convective'], ['spc.producer', 'spc-reports'], ['sigmetGrid.areas.na.producer', 'us-convective']],
  'since.lightning': [['producer', 'lightning']], 'since.mrms': [['producer', 'mrms']], 'since.nat': [['producer', 'nat-days']],
  'since.gfs': [['jet.producer', 'gfs-jet'], ['levels.producer', 'gfs-levels']], 'since.faa': [['producer', 'faa-restrictions']],
  'since.sigwx': [['official.producer', 'sigwx-official'], ['model.producer', 'sigwx-model']],
};
const MIN_DAYS = 3;
const FAA_PRIVATE = ['faa', 'icao', 'code', 'name', 'iata'];
const BLOCK_HOURS = 24;
const DISCLAIMER = 'MODEL AND FORECAST DATA, NOT FOR OPERATIONAL USE. Not a flight-planning, dispatch or pilot-briefing product and not an ' +
  'official meteorological service: for operations use the approved sources (WAFC charts via SADIS/WIFS, SIGMETs, national meteorological ' +
  'services). Model-derived layers are computed by this relay and are not official products; days 4–7 are low confidence. Every part carries ' +
  'its own model run and issue times. The observed weather of the current week (since) is sampled, reduced and incomplete for the hours ' +
  'not yet published; the North Atlantic track message is a copy for orientation only — use the current official message.';
const ATTRIBUTION = [
  'Contains ECMWF Open Data (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/): based on data and products of the European Centre for ' +
    'Medium-Range Weather Forecasts (ECMWF), www.ecmwf.int; values derived (modified) by this relay. ECMWF accepts no liability for errors or omissions.',
  'NOAA/NWS data (GFS, GEFS, GEFS-Aerosols, SPC, NHC/CPHC, WPC, CPC, SWPC; NOAA Open Data Dissemination on AWS): public domain ' +
    '(https://www.weather.gov/disclaimer). Reformatted and derived by this relay; not an official NOAA/NWS product, not endorsed by NOAA.',
  'Official WAFS SIGWX (FL100–600): GeoJSON published by the NOAA/NWS Aviation Weather Center (aviationweather.gov); the files name no ' +
    'issuing centre. Clipped and simplified by this relay; not an official chart.',
  'JTWC tropical cyclone warnings: US Navy Joint Typhoon Warning Center (US Government work).',
];
// Credit lines of the "since" sources and the NAT message, added to attribution when that data is in the file.
const ATTRIBUTION_SINCE = {
  lightning: year => 'Contains modified EUMETSAT Meteosat product ' + year + ' (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/): MTG Lightning ' +
    'Imager accumulated flash area (EUMETView), one frame per hour reduced to hours with lightning per 0.5° cell by this relay.',
  mrms: () => 'NOAA MRMS radar data via the NOAA Open Data Dissemination program (public, NOAA requests attribution): modified — reduced by this relay ' +
    'to hours ≥ 40 dBZ and daily radar-estimated hail per 0.5° cell; not original NOAA data.',
  wxreview: () => 'US convective SIGMETs: NOAA/NWS Aviation Weather Center, via the Iowa Environmental Mesonet SIGMET archive (Iowa State University, ' +
    'public domain). SPC storm reports: NOAA/NWS Storm Prediction Center, preliminary (public domain).',
  nat: () => 'North Atlantic track message: FAA NOTAM System (nms.aim.faa.gov, US Government work); the tracks are issued by Shanwick (EGGX) and Gander (CZQX).',
  natDays: page => 'North Atlantic tracks of the days so far: the FAA NOTAM System track messages (US Government work) as captured twice a day in ' + page + '.',
  faa: () => 'US weather restrictions: FAA Air Traffic Control System Command Center advisories (fly.faa.gov, US Government work, public domain); reduced ' +
    'by this relay to counts per day and ARTCC. Airport positions: OurAirports (public domain).',
};

// Part limits (s). The fetchers stop starting requests well before (soft deadlines 90–240 s); the sum plus 60 s is
// the whole run's limit (2265 s with the 2026-10-12 sub-parts), under the workflow's job timeout of 40 min.
const PARTS = {
  // 2026-10-13 (ADR-001 Q3): the ECMWF ENS hub probabilities as values at neutral grid points (scripts/ens-points.js: the
  // airports of the public METAR archive's rule, read from OurAirports each run, published as grid indices only); without
  // OurAirports the part runs as before, without them.
  wxoutlook: { limit: 240, run: async () => {
    let pts = null, note = null;
    try { pts = req('ens-points.js').neutralPositions(await req('fetch-util.js').getText(req('fetch-faa.js').OURAIRPORTS_CSV, { accept: 'text/csv', timeoutMs: 60000, retries: 1 })); }
    catch (e) { note = 'ECMWF ENS points: OurAirports not read (' + String(e.message || e).slice(0, 80) + '); hub probabilities left out'; }
    const s = await req('fetch-wxoutlook.js').fetchWxOutlook({ hubs: [], ensPoints: pts && pts.length > 100 ? pts : null });
    if (note) s.notes = (s.notes || []).concat([note]);
    return s;
  } },
  sigwx: { limit: 240, run: w => req('fetch-sigwx.js').fetchSigwx({ from: w.from, to: w.to, aheadOnly: true }) },
  sigwxModel: { limit: 240, run: w => req('fetch-sigwx-model.js').fetchSigwxModel({ from: w.prev, to: w.prev, aheadOnly: true }) },
  gefscat: { limit: 240, run: w => req('fetch-gefs-cat.js').fetchGefsCat({ to: w.prev }) },
  dust: { limit: 180, run: () => req('fetch-dust.js').fetchDust({ hubs: [] }) },
};
// The "since" sub-parts (incremental: see the cache option of fetch-lightning.js / fetch-mrms.js). Caps per run keep
// a run that starts without a cache (first run of a week, cache lost) inside the budget; the rest follows next run.
const SINCE = {
  wxreview: { limit: 120, run: sw => req('fetch-wxreview.js').fetchUsObserved({ from: sw.from, to: sw.to }) },
  lightning: { limit: 270, cache: true, run: (sw, cache) => req('fetch-lightning.js').fetchLightning({ from: sw.from, to: sw.to, cache, maxFrames: 170, softDeadlineS: 220 }) },
  mrms: { limit: 300, cache: true, run: (sw, cache) => req('fetch-mrms.js').fetchMrms({ from: sw.from, to: sw.to, cache, maxFiles: 110, softDeadlineS: 240 }) },
  // 2026-10-12, on extWindowOf(): a few small files; one analysis a day (cache: only new days); the FAA list of each day
  // plus the advisory pages not read before (cache, a soft deadline; one OurAirports download when an airport is new).
  // The caches of gfs and faa are not per week (cache/gfs.json, cache/faa.json): the window reaches into the last week.
  nat: { limit: 45, run: xw => req('fetch-natarchive.js').fetchNatArchive({ from: xw.from, to: xw.to }) },
  gfs: { limit: 120, cache: true, weekly: false, run: (xw, cache) => req('fetch-wxreview.js').fetchGfsObserved({ from: xw.from, to: xw.to, cache, softDeadlineS: 90 }) },
  faa: { limit: 150, cache: true, weekly: false, run: (xw, cache) => {
    const F = req('fetch-faa.js');
    return F.fetchFaaObserved({ from: xw.from, to: xw.to, cache, softDeadlineS: 110, positionsUrl: F.OURAIRPORTS_CSV });
  } },
  // 2026-10-13: SIGWX of each day, official and model side by side (two hosts: AWC, NOMADS/AWS). One cache file holds
  // both halves (cache/sigwx.json {kind, official, model}); a day read before is not read again (see the two fetchers).
  sigwx: { limit: 200, cache: true, weekly: false, run: (xw, cache) => fetchSigwxSince(xw, cache) },
};
async function fetchSigwxSince(xw, cache) {
  const prev = cache && cache.prev && cache.prev.kind === 'sigwxSince' ? cache.prev : {};
  const oc = { prev: prev.official || null }, mc = { prev: prev.model || null }, notes = [];
  const [o, m] = await Promise.all([
    req('fetch-sigwx.js').fetchSigwxObserved({ from: xw.from, to: xw.to, cache: oc }).catch(e => { notes.push('Official SIGWX: ' + String(e.message || e).slice(0, 200)); return null; }),
    req('fetch-sigwx-model.js').fetchSigwxModelObserved({ from: xw.from, to: xw.to, cache: mc }).catch(e => { notes.push('Model SIGWX: ' + String(e.message || e).slice(0, 200)); return null; }),
  ]);
  // a half that failed keeps its previous cache, so nothing already read is lost
  cache.next = { kind: 'sigwxSince', official: oc.next || prev.official || null, model: mc.next || prev.model || null };
  const ci = [oc.info, mc.info].filter(Boolean);
  cache.info = { reused: ci.reduce((a, x) => a + x.reused, 0), fetched: ci.reduce((a, x) => a + x.fetched, 0), dropped: ci.map(x => x.dropped).filter(Boolean).join('; ') || null };
  if (!o && !m) throw new Error(notes.join('; ') || 'no SIGWX read');
  [o, m].forEach(x => { if (x) { delete x.summary; x.notes = (x.notes || []).slice(); } });
  return { official: o, model: m, notes };
}
PARTS.nat = { limit: 60, run: async () => {
  const notes = [], live = await req('nat-message.js').fetchNatLive(notes);
  if (!live) throw new Error(notes.join('; ') || 'no track message');
  if (notes.length) live.notes = notes;
  return live;
} };
const ORDER = ['wxoutlook', 'sigwxModel', 'gefscat', 'dust', 'sigwx', 'nat', 'since'];
const req = f => require(path.join(SCRIPTS, f));

const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function windowOf(nowMs) {
  const from = new Date(nowMs).toISOString().slice(0, 10);
  return { from, to: addDays(from, 6), prev: addDays(from, -1) };
}
function isoWeekOf(ymd) {
  const d = new Date(ymd + 'T00:00:00Z'), day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  return y + '-W' + String(Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0');
}
// The observed window: Monday 00Z of the current ISO week (UTC) … today, as of the run.
function sinceWindowOf(nowMs) {
  const to = new Date(nowMs).toISOString().slice(0, 10), dow = new Date(to + 'T00:00:00Z').getUTCDay() || 7;
  return { from: addDays(to, 1 - dow), to, asOf: new Date(nowMs).toISOString(), week: isoWeekOf(to) };
}
// The window of the nat, gfs and faa sub-parts: the same week, but never fewer than the last MIN_DAYS days, so a file
// read on Monday or Tuesday is not almost empty. weekFrom = the Monday; beforeWeek = the days before it (or []).
function extWindowOf(sw) {
  const from = addDays(sw.to, 1 - MIN_DAYS) < sw.from ? addDays(sw.to, 1 - MIN_DAYS) : sw.from, beforeWeek = [];
  for (let d = from; d < sw.from; d = addDays(d, 1)) beforeWeek.push(d);
  return { from, to: sw.to, asOf: sw.asOf, week: sw.week, weekFrom: sw.from, beforeWeek };
}

// ---- request wrapper -----------------------------------------------------------------------------
const als = new AsyncLocalStorage();
function denyList(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() && !/^\s*#/.test(l))
      .map(l => l.split(' · ')[0].trim()).filter(h => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
  } catch (e) { return []; }
}
// The stop note: { blocked: [{ host, status, at, until, path, part }] }. Entries in force at nowMs; a missing or broken
// file is no note.
function readBlocked(file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j && j.blocked) ? j.blocked : []; } catch (e) { return []; } }
const inForce = (entries, nowMs) => (entries || []).filter(b => b && b.host && Date.parse(b.until || '') > nowMs);
function blockedNote(entries) {
  return { _comment: 'Stop note of the relay: a host that answered HTTP 403/429 is not contacted until "until". Delete an entry (or the file) ' +
    'on the data branch to ask again earlier.', blocked: entries };
}
// Every header value of a request, whatever form the caller used: init.headers as a Headers object, an array of
// pairs or a plain object (any case), and the headers of a Request passed as input (review 2026-10-13, L9).
function headerValues(input, init) {
  const out = [];
  const add = hd => {
    if (!hd) return;
    if (typeof hd.forEach === 'function' && typeof hd.get === 'function') hd.forEach((v, k) => out.push([String(k).toLowerCase(), String(v)]));
    else if (Array.isArray(hd)) hd.forEach(p => { if (p && p.length >= 2) out.push([String(p[0]).toLowerCase(), String(p[1])]); });
    else if (typeof hd === 'object') Object.keys(hd).forEach(k => out.push([k.toLowerCase(), String(hd[k])]));
  };
  if (input && typeof input === 'object' && input.headers) add(input.headers);
  if (init && init.headers) add(init.headers);
  return out;
}
const EMAIL_RE = /[^\s@()<>,;:"]+@[^\s@()<>,;:"]+\.[a-z]{2,}/i;

function installFetch(opts) {
  const o = Object.assign({ denyFile: null, allow: [], log: () => {}, blocked: [], nowMs: Date.now() }, opts || {});
  const orig = globalThis.fetch, stats = Object.create(null), stopped = Object.create(null), blocks = inForce(o.blocked, o.nowMs).map(b => Object.assign({}, b));
  const S = part => stats[part] || (stats[part] = { requests: 0, bytes: 0, hosts: Object.create(null) });
  const H = (part, host) => { const s = S(part); return s.hosts[host] || (s.hosts[host] = { requests: 0, bytes: 0, status: {}, refused: 0 }); };
  globalThis.fetch = async function relayFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const host = new URL(url).hostname, cx = als.getStore() || { part: 'other' };
    if (cx.dead) throw new Error('relay: part ' + cx.part + ' passed its time limit; request not sent');
    // Refusals carry "HTTP 403/429" in the message, so every fetcher's own stop rule ends its requests to that host.
    if (stopped[host]) { H(cx.part, host).refused++; throw new Error('relay: ' + host + ' answered HTTP ' + stopped[host].status + ' earlier in this run; not asked again'); }
    if (o.denyFile && !o.allow.includes(host) && denyList(o.denyFile).includes(host)) {
      H(cx.part, host).refused++;
      throw new Error('relay: ' + host + ' is on the deny list (HTTP 403 rule); not contacted');
    }
    const note = !o.allow.includes(host) && blocks.find(b => b.host === host);
    if (note) {
      H(cx.part, host).refused++;
      throw new Error('relay: ' + host + ' answered HTTP ' + note.status + ' at ' + String(note.at).slice(0, 16) + 'Z; stop note in force until ' + String(note.until).slice(0, 16) + 'Z; not contacted');
    }
    // The relay's own identity only: a request with an e-mail address in any header (the project's private one in its
    // User-Agent, above all) is not sent.
    const mail = headerValues(input, init).find(([, v]) => EMAIL_RE.test(v));
    if (mail) { H(cx.part, host).refused++; throw new Error('relay: request to ' + host + ' not sent — its ' + (mail[0] === 'user-agent' ? 'User-Agent' : mail[0] + ' header') + ' carries an e-mail address'); }
    const h = H(cx.part, host);
    h.requests++; S(cx.part).requests++;
    const res = await orig(input, init);
    h.status[res.status] = (h.status[res.status] || 0) + 1;
    if (res.status === 403 || res.status === 429) {
      const p = new URL(url).pathname;
      stopped[host] = { status: res.status, path: p, at: new Date().toISOString(), part: cx.part };
      blocks.push({ host, status: res.status, at: stopped[host].at, until: new Date(Date.parse(stopped[host].at) + BLOCK_HOURS * 3600000).toISOString(), path: p, part: cx.part });
      o.log('relay: ' + host + ' answered HTTP ' + res.status + ' on ' + p + ' — stopped for the rest of the run');
      if (o.denyFile) { try { fs.appendFileSync(o.denyFile, host + ' · ' + stopped[host].at.slice(0, 19) + 'Z · ' + p + ' · ' + res.status + ' · wx-relay (' + cx.part + ')\n'); } catch (e) { /* keep going */ } }
    }
    if (!res.body || [101, 204, 205, 304].includes(res.status)) return res;
    // Read the body here to count it (the caller's abort signal still applies), and hand back the same answer.
    const buf = await res.arrayBuffer();
    h.bytes += buf.byteLength; S(cx.part).bytes += buf.byteLength;
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { stats, stopped, blocks, restore: () => { globalThis.fetch = orig; } };
}

// ---- one part ------------------------------------------------------------------------------------
async function runPart(key, win, limitS, runFn) {
  const cx = { part: key, dead: false }, t0 = Date.now(), fn = runFn || (w => PARTS[key].run(w));
  let timer;
  try {
    const snap = await Promise.race([
      als.run(cx, () => Promise.resolve().then(() => fn(win))),
      new Promise((_, rej) => { timer = setTimeout(() => { cx.dead = true; rej(new Error('time limit of ' + limitS + ' s reached')); }, limitS * 1000); }),
    ]);
    if (!snap || typeof snap !== 'object') throw new Error('no data returned');
    return { snap, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } catch (e) {
    cx.dead = true;
    return { error: String((e && e.message) || e).replace(/https?:\/\/\S+?:\s/, '').slice(0, 300), seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } finally { clearTimeout(timer); }
}

// ---- post-processing (pure) ----------------------------------------------------------------------
// What U.main adds to a weekly snapshot, so a part reads like one; summary lines are console-only.
// Then everything airport-specific is emptied and the past is dropped. Returns the list of fields emptied.
function finishPart(key, s, win, generatedAt) {
  const emptied = [];
  delete s.summary;
  s.generatedAt = generatedAt;
  s.mode = 'relay';
  s.window = key.startsWith('since.') ? Object.assign({ from: win.from, to: win.to, week: win.week, asOf: win.asOf },
      win.weekFrom ? { weekFrom: win.weekFrom, beforeWeek: (win.beforeWeek || []).slice() } : {})
    : key === 'nat' ? { from: win.from, to: win.from, week: null } : { from: win.from, to: win.to, week: null };
  if (key === 'since.wxreview') {
    // Only the US convective SIGMETs and the SPC reports may be in it: everything international or airport-specific goes.
    ['sigmets', 'pireps', 'hubs', 'jet', 'levels'].forEach(k => { if (s[k] != null) { emptied.push('wxreview.' + k); } s[k] = null; });
    if (s.us) { if ((s.us.oceanic || []).length) emptied.push('wxreview.us.oceanic'); s.us.oceanic = []; s.us.pacificOceanic = 0; }
    const g = s.sigmetGrid;
    if (g) {
      if (Object.keys(g.hazards || {}).length || g.samples) { emptied.push('wxreview.sigmetGrid (international)'); g.hazards = {}; g.maxPct = {}; g.cells = {}; g.samples = 0; }
      (g.days || []).forEach(d => { if (Object.keys(d.hazards || {}).length || d.samples) emptied.push('wxreview.sigmetGrid.days ' + d.date); d.samples = 0; d.hazards = {};
        Object.keys(d.counts || {}).forEach(r => { if (r !== 'na') { emptied.push('wxreview.sigmetGrid.days counts.' + r); delete d.counts[r]; } }); });
      Object.keys(g.areas || {}).forEach(a => { if (a !== 'na') { emptied.push('wxreview.sigmetGrid.areas.' + a); delete g.areas[a]; } });
    }
  }
  if (key === 'since.nat') {
    // The 50W check of the project's fix table is not a map layer; without that table its note would only confuse.
    if (s.lat50wSeen !== undefined) delete s.lat50wSeen;
    s.notes = (s.notes || []).filter(n => !/nat-fixes\.json/.test(n));
  }
  if (key === 'since.sigwx') {
    // Only the days of the window; the model part holds analyses only (today's forecast stays in sigwxModel).
    const inW = d => d >= win.from && d <= win.to;
    if (s.official) { const n = (s.official.days || []).length; s.official.days = (s.official.days || []).filter(d => inW(d.date)); if (s.official.days.length !== n) emptied.push('sigwx.official.days outside the window'); }
    if (s.model) Object.keys(s.model.areas || {}).forEach(a => { const A = s.model.areas[a], n = (A.days || []).length;
      A.days = (A.days || []).filter(d => inW(d.date) && d.kind === 'analysis'); if (A.days.length !== n) emptied.push('sigwx.model.areas.' + a + '.days (outside the window or not an analysis)'); });
  }
  if (key === 'since.faa') {
    // Belt and braces: no airport code or name, no list of airports under a centre, no centre names.
    (s.airports || []).forEach((a, i) => FAA_PRIVATE.forEach(k => { if (a && k in a) { emptied.push('faa.airports[' + i + '].' + k); delete a[k]; } }));
    (s.days || []).forEach(d => Object.keys(d.centers || {}).forEach(c => { if (d.centers[c] && d.centers[c].airports) { emptied.push('faa.days ' + d.date + ' ' + c + '.airports'); delete d.centers[c].airports; } }));
    if (s.names) { emptied.push('faa.names'); delete s.names; }
  }
  const empty = (obj, k, label) => { if (obj && Array.isArray(obj[k])) { if (obj[k].length) emptied.push(label + ' (' + obj[k].length + ')'); obj[k] = []; } };
  if (key === 'wxoutlook') {
    empty(s.gfs, 'hubs', 'gfs.hubs');
    empty(s.ecmwf, 'hubProb', 'ecmwf.hubProb');
    ((s.spc && s.spc.days) || []).forEach((d, i) => empty(d, 'hubs', 'spc.days[' + i + '].hubs'));
    ((s.spc && s.spc.d48 && s.spc.d48.days) || []).forEach((d, i) => empty(d, 'hubs', 'spc.d48.days[' + i + '].hubs'));
  }
  if (key === 'dust') empty(s, 'hubs', 'dust.hubs');
  if (key === 'sigwx') {
    empty(s, 'days', 'sigwx.days (past charts)');
    if (s.worst && Object.keys(s.worst).length) { emptied.push('sigwx.worst'); s.worst = {}; }
  }
  if (key === 'sigwxModel') Object.keys(s.areas || {}).forEach(a => {
    const d = s.areas[a].days || [], f = d.filter(x => x.kind === 'forecast');
    if (f.length !== d.length) emptied.push('sigwxModel.areas.' + a + '.days (analysis ' + (d.length - f.length) + ')');
    s.areas[a].days = f;
  });
  // Belt and braces: no hubs/hubProb array with content anywhere in the part.
  (function walk(v, p) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, p + '[' + i + ']'));
    if (!v || typeof v !== 'object') return;
    Object.keys(v).forEach(k => { if ((k === 'hubs' || k === 'hubProb') && Array.isArray(v[k]) && v[k].length) { emptied.push(p + '.' + k + ' (' + v[k].length + ')'); v[k] = []; } else walk(v[k], p + '.' + k); });
  })(s, key);
  return emptied;
}

// The contract check: [problems]; warnings start with "warn:". An empty list = valid.
function validate(L) {
  const P = [], ymd = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (!L || L.schema !== SCHEMA) P.push('schema is not ' + SCHEMA);
  if (!L || isNaN(Date.parse(L.generatedAt))) P.push('generatedAt is not a time');
  if (!L || !L.relayRun || !('id' in L.relayRun) || !('url' in L.relayRun)) P.push('relayRun {id, url} missing');
  const w = (L && L.window) || {};
  if (!ymd(w.from) || !ymd(w.to) || addDays(w.from, 6) !== w.to) P.push('window must be 7 days, from … from + 6');
  const parts = (L && L.parts) || {}, st = (L && L.status) || {};
  PART_KEYS.forEach(k => {
    if (!(k in parts)) P.push('parts.' + k + ' missing (null when it failed)');
    const s = st[k];
    if (!s || typeof s.ok !== 'boolean' || typeof s.seconds !== 'number' || typeof s.requests !== 'number') P.push('status.' + k + ' needs ok, seconds, requests');
    else if (s.ok !== (parts[k] != null)) P.push('status.' + k + '.ok does not match parts.' + k);
    else if (!s.ok && !s.error) P.push('status.' + k + ' failed without an error text');
  });
  Object.keys(parts).forEach(k => { if (!PART_KEYS.includes(k)) P.push('unknown part ' + k); });
  if (!PART_KEYS.some(k => parts[k])) P.push('every part is null');
  const o = parts.wxoutlook;
  if (o) {
    if (!o.outlook || o.outlook.from !== w.from || o.outlook.to !== w.to) P.push('wxoutlook.outlook ≠ window');
    if (o.gfs && (o.gfs.hubs || []).length) P.push('wxoutlook.gfs.hubs not empty');
    if (o.ecmwf && (o.ecmwf.hubProb || []).length) P.push('wxoutlook.ecmwf.hubProb not empty');
    if (!o.gfs) P.push('warn: wxoutlook without GFS (' + ((o.sources || []).find(x => x.key === 'gfs') || {}).error + ')');
  }
  const sx = parts.sigwx;
  if (sx) {
    if ((sx.days || []).length) P.push('sigwx.days (past charts) not empty');
    if (!Array.isArray(sx.ahead) || !sx.aheadCover) P.push('sigwx.ahead / aheadCover missing');
    (sx.ahead || []).forEach(d => { if (d.date < w.from || d.date > w.to) P.push('sigwx ahead chart ' + d.date + ' outside the window'); });
  }
  const sm = parts.sigwxModel;
  if (sm) {
    ['na', 'atl', 'me'].forEach(a => { const A = sm.areas && sm.areas[a];
      if (!A || !Array.isArray(A.days)) P.push('sigwxModel.areas.' + a + ' missing');
      else A.days.forEach(d => { if (d.kind !== 'forecast') P.push('sigwxModel ' + a + ' ' + d.date + ' is not a forecast day'); if (d.date < w.from) P.push('sigwxModel ' + a + ' ' + d.date + ' before the window'); }); });
  }
  const gc = parts.gefscat;
  if (gc) {
    if (!Array.isArray(gc.days) || !gc.areas) P.push('gefscat days / areas missing');
    (gc.days || []).forEach(d => { if (d.date < w.from) P.push('gefscat ' + d.date + ' before the window'); });
  }
  const du = parts.dust;
  if (du) {
    if ((du.hubs || []).length) P.push('dust.hubs not empty');
    if (!Array.isArray(du.days) || du.res == null) P.push('dust days / grid missing');
    (du.days || []).forEach(d => { if (d.date < w.from || d.date > w.to) P.push('dust ' + d.date + ' outside the window'); });
  }
  const nt = parts.nat;
  if (nt && (!Array.isArray(nt.sets) || nt.sets.some(x => !Array.isArray(x.tracks)))) P.push('nat.sets / tracks missing');
  const si = parts.since;
  if (si) {
    const sw = si.window || {};
    if (!ymd(sw.from) || !ymd(sw.to) || sw.from > sw.to || new Date(sw.from + 'T00:00:00Z').getUTCDay() !== 1 || addDays(sw.from, 6) < sw.to || isNaN(Date.parse(sw.asOf)))
      P.push('since.window must run from a Monday to at most the Sunday after, with asOf');
    Object.keys(si).forEach(k => { if (k !== 'window' && !SINCE_KEYS.includes(k)) P.push('unknown since part ' + k); });
    const xw = ymd(sw.from) && ymd(sw.to) ? extWindowOf(sw) : { from: null, to: null, beforeWeek: [] };
    SINCE_KEYS.forEach(k => {
      if (!(k in si)) P.push('since.' + k + ' missing (null when it failed)');
      const s = st['since.' + k];
      if (!s || typeof s.ok !== 'boolean' || s.ok !== (si[k] != null)) P.push('status.since.' + k + ' missing or not matching');
      const x = si[k], ext = SINCE_EXT.includes(k), w0 = ext ? xw : sw;
      if (x && (!x.window || x.window.from !== w0.from || x.window.to !== w0.to)) P.push('since.' + k + '.window ≠ ' + (ext ? 'the window of at least ' + MIN_DAYS + ' days' : 'since.window'));
      else if (x && ext && (x.window.weekFrom !== sw.from || JSON.stringify(x.window.beforeWeek) !== JSON.stringify(xw.beforeWeek))) P.push('since.' + k + '.window weekFrom / beforeWeek wrong');
    });
    const inX = d => typeof d === 'string' && d >= xw.from && d <= xw.to;
    const nd = si.nat;
    if (nd && (!Array.isArray(nd.days) || nd.days.some(d => !inX(d.date) || ['eastbound', 'westbound'].some(k => d[k] && !Array.isArray(d[k].tracks)))))
      P.push('since.nat.days must be days of its window with tracks per direction');
    const gf = si.gfs;
    if (gf) {
      // 2026-10-13: the three jet levels of the weekly run (FL300/340/390), 250 hPa in days, the others in byLevel
      if (!gf.jet || !Array.isArray(gf.jet.days) || JSON.stringify(gf.jet.levels) !== '["300","250","200"]') P.push('since.gfs.jet must hold the 300, 250 and 200 hPa levels (FL300/340/390)');
      const lv = o => [o].concat(Object.values((o && o.byLevel) || {}));
      // every grid string of exactly nlat x nlon bytes, as the page checks it (wxRlSince3)
      const b64n = g => 4 * Math.ceil(g.nlat * g.nlon / 3), okB = (g, v) => v == null || (typeof v === 'string' && v.length === b64n(g));
      [gf.jet].concat(Object.values((gf.jet && gf.jet.areas) || {})).filter(Boolean).forEach(g => lv(g).forEach(o => ((o && o.days) || []).forEach(d => {
        if (!okB(g, d.kt)) P.push('since.gfs jet ' + d.date + ': grid of the wrong length'); })));
      [].concat(lv(gf.jet), [gf.levels]).forEach(o => ((o && o.days) || []).forEach(d => { if (!inX(d.date)) P.push('since.gfs ' + d.date + ' outside its window'); }));
    }
    const fa = si.faa;
    if (fa) {
      if (!Array.isArray(fa.days) || !Array.isArray(fa.airports)) P.push('since.faa days / airports missing');
      (fa.airports || []).forEach((a, i) => { if (!a || FAA_PRIVATE.some(k => k in a)) P.push('since.faa.airports[' + i + '] carries an airport code or name'); });
      (fa.days || []).forEach(d => { if (!inX(d.date)) P.push('since.faa ' + d.date + ' outside its window');
        if (Object.values(d.centers || {}).some(c => c && c.airports)) P.push('since.faa ' + d.date + ': a centre lists its airports'); });
      if (fa.names) P.push('since.faa.names must not be published');
    }
    const sx = si.sigwx;
    if (sx) {
      if (!sx.official && !sx.model) P.push('since.sigwx needs official or model');
      // the same rules as the page (wxRlSince3, 2026-10-13): a chart the relay publishes must not be dropped by the reader
      const ts = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d/.test(v), num = v => typeof v === 'number' && isFinite(v);
      if (sx.official && (!Array.isArray(sx.official.days) || sx.official.days.some(d => !inX(d.date) || !Array.isArray(d.features) || !ts(d.valid) || !num(d.lead)))) P.push('since.sigwx.official.days must be charts of its window with valid time and lead');
      if (sx.model) ['na', 'atl', 'me'].forEach(a => { const A = sx.model.areas && sx.model.areas[a];
        if (!A || !Array.isArray(A.days)) P.push('since.sigwx.model.areas.' + a + ' missing');
        else if (!(A.nlat > 0 && A.nlon > 0 && num(A.lat0) && num(A.lon0) && num(A.res))) P.push('since.sigwx.model.areas.' + a + ' grid missing');
        else A.days.forEach(d => { if (!inX(d.date) || d.kind !== 'analysis' || !ts(d.valid) || !Array.isArray(d.jets)) P.push('since.sigwx.model ' + a + ' ' + d.date + ' must be an analysis day of its window with valid time and jets'); }); });
    }
    if (!SINCE_KEYS.some(k => si[k])) P.push('since has no sub-part (null when all failed)');
    const r = si.wxreview;
    if (r) {
      ['sigmets', 'pireps', 'hubs', 'jet', 'levels'].forEach(k => { if (r[k] != null) P.push('since.wxreview.' + k + ' must be null (US convective + SPC only)'); });
      if (r.us && (r.us.oceanic || []).length) P.push('since.wxreview.us.oceanic must be empty');
      const g = r.sigmetGrid;
      if (g && (g.samples || Object.keys(g.hazards || {}).length || Object.keys(g.areas || {}).some(a => a !== 'na'))) P.push('since.wxreview.sigmetGrid may hold areas.na only');
    }
    const lt = si.lightning;
    if (lt && !/^Contains modified EUMETSAT Meteosat product \d{4}/.test(lt.attribution || '')) P.push('since.lightning attribution (EUMETSAT) missing');
    if (lt && !L.attribution.some(a => /^Contains modified EUMETSAT Meteosat product \d{4}/.test(a))) P.push('attribution: EUMETSAT credit line missing');
    if (si.mrms && !/NOAA MRMS/.test(si.mrms.attribution || '')) P.push('since.mrms attribution missing');
  }
  // Producer stamps (scripts/wx-layers.js, 2026-10-20): every layer in the file says which producer and parameters made it,
  // so the page and the tests can tell that This week and the Briefing week came from the same code. A sub-object that is
  // null (a source that failed) needs none.
  const getP = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  Object.keys(STAMPS).forEach(k => {
    const part = k.startsWith('since.') ? (parts.since || {})[k.slice(6)] : parts[k];
    if (!part) return;
    STAMPS[k].forEach(([p, id]) => {
      if (p.indexOf('.') >= 0 && getP(part, p.split('.').slice(0, -1).join('.')) == null) return;
      if (!LY.isStamp(getP(part, p), id)) P.push(k + '.' + p + ': producer stamp of layer ' + id + ' missing or malformed (scripts/wx-layers.js)');
    });
  });
  if (!Array.isArray(L && L.attribution) || !L.attribution.length || L.attribution.some(a => typeof a !== 'string')) P.push('attribution must be a list of strings');
  if (!L || typeof L.disclaimer !== 'string' || !/NOT FOR OPERATIONAL USE/.test(L.disclaimer)) P.push('disclaimer must say NOT FOR OPERATIONAL USE');
  return P;
}

// results: { <part>: r, 'since.<sub>': r } with r = { snap | error, seconds, requests, megabytes, hosts, emptied?, cache? };
// sinceWin: sinceWindowOf() of the run (needed when the since part ran).
function assemble(win, generatedAt, results, env, sinceWin) {
  const e = env || {};
  const runUrl = e.GITHUB_RUN_ID && e.GITHUB_REPOSITORY ? (e.GITHUB_SERVER_URL || 'https://github.com') + '/' + e.GITHUB_REPOSITORY + '/actions/runs/' + e.GITHUB_RUN_ID : null;
  const L = { schema: SCHEMA, generatedAt, relayRun: { id: e.GITHUB_RUN_ID || null, url: runUrl }, window: { from: win.from, to: win.to }, parts: {}, status: {},
              attribution: ATTRIBUTION.slice(), disclaimer: DISCLAIMER };
  const statusOf = r => Object.assign({ ok: !!r.snap }, r.snap ? {} : { error: r.error || 'failed' },
    { seconds: r.seconds || 0, requests: r.requests || 0, megabytes: r.megabytes || 0, hosts: r.hosts || {} },
    r.emptied && r.emptied.length ? { emptied: r.emptied } : {}, r.cache ? { cache: r.cache } : {});
  // since = its three sub-parts; null when none of them has data (or it was not run).
  const subs = SINCE_KEYS.map(k => results['since.' + k] || { error: 'not run' });
  if (subs.some(r => r.snap) && sinceWin) {
    results.since = { snap: { window: { from: sinceWin.from, to: sinceWin.to, asOf: sinceWin.asOf, week: sinceWin.week } } };
    SINCE_KEYS.forEach((k, i) => { results.since.snap[k] = subs[i].snap || null; });
  } else if (!results.since) results.since = { error: subs.map((r, i) => SINCE_KEYS[i] + ': ' + (r.error || 'failed')).join('; ') };
  const sum = f => Math.round(subs.reduce((a, r) => a + (r[f] || 0), 0) * 100) / 100;
  Object.assign(results.since, { seconds: sum('seconds'), requests: sum('requests'), megabytes: sum('megabytes') });
  PART_KEYS.forEach(k => {
    const r = results[k] || { error: 'not run' };
    L.parts[k] = r.snap || null;
    L.status[k] = statusOf(r);
  });
  SINCE_KEYS.forEach((k, i) => { L.status['since.' + k] = statusOf(subs[i]); });
  const si = L.parts.since;
  if (L.parts.nat) L.attribution.push(ATTRIBUTION_SINCE.nat());
  if (si && si.wxreview) L.attribution.push(ATTRIBUTION_SINCE.wxreview());
  if (si && si.lightning) L.attribution.push(ATTRIBUTION_SINCE.lightning((/product (\d{4})/.exec(si.lightning.attribution || '') || [])[1] || generatedAt.slice(0, 4)));
  if (si && si.mrms) L.attribution.push(ATTRIBUTION_SINCE.mrms());
  if (si && si.nat) L.attribution.push(ATTRIBUTION_SINCE.natDays((si.nat.source && si.nat.source.page) || 'a public archive'));
  if (si && si.faa) L.attribution.push(ATTRIBUTION_SINCE.faa());
  return L;
}

// ---- the incremental caches (lightning, mrms) ----------------------------------------------------
// Per week (lightning-<week>.json) or, for the parts whose window reaches into the last week, one file (gfs.json).
const cacheName = (kind, week) => kind + (week ? '-' + week : '') + '.json';
// { prev: object | null, note: string | null } — a missing file is a plain fresh start, an unreadable one says so.
function loadCache(dir, kind, week) {
  if (!dir) return { prev: null, note: null };
  const p = path.join(dir, cacheName(kind, week));
  if (!fs.existsSync(p)) return { prev: null, note: 'no cache for ' + (week || kind) + ' (fresh start)' };
  try { return { prev: JSON.parse(fs.readFileSync(p, 'utf8')), note: null }; } catch (e) { return { prev: null, note: 'cache unreadable (' + String(e.message).slice(0, 60) + '), fresh start' }; }
}

// ---- main ----------------------------------------------------------------------------------------
async function main(argv) {
  const a = argv.slice(2), arg = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  const outDir = path.resolve(arg('--out') || 'out');
  const only = arg('--parts') ? arg('--parts').split(',') : null;
  const allow = []; a.forEach((x, i) => { if (x === '--allow-host' && a[i + 1]) allow.push(a[i + 1]); });
  const log = s => console.log(s);
  const t0 = Date.now(), win = windowOf(t0), generatedAt = new Date(t0).toISOString();
  const budget = ORDER.filter(k => k !== 'since').reduce((s, k) => s + PARTS[k].limit, 0) + SINCE_KEYS.reduce((s, k) => s + SINCE[k].limit, 0) + 60;
  setTimeout(() => { log('relay: FAILED — whole run over ' + budget + ' s; nothing written'); process.exit(1); }, budget * 1000).unref();
  const sw = sinceWindowOf(t0), xw = extWindowOf(sw), cacheDir = arg('--cache') ? path.resolve(arg('--cache')) : null;
  log('relay: window ' + win.from + ' .. ' + win.to + ' · since ' + sw.from + ' .. ' + sw.asOf.slice(0, 16) + 'Z (' + sw.week + ')' +
      (xw.from !== sw.from ? ', ' + SINCE_EXT.join('/') + ' from ' + xw.from : '') + (only ? ' · parts ' + only.join(',') : ''));
  const blockedFile = arg('--blocked') ? path.resolve(arg('--blocked')) : cacheDir ? path.join(cacheDir, 'blocked.json') : null;
  const prevBlocks = blockedFile ? inForce(readBlocked(blockedFile), t0) : [];
  prevBlocks.forEach(b => log('relay: stop note — ' + b.host + ' answered HTTP ' + b.status + ' at ' + String(b.at).slice(0, 16) + 'Z, not contacted until ' + String(b.until).slice(0, 16) + 'Z'));
  const net = installFetch({ denyFile: arg('--deny-file'), allow, log, blocked: prevBlocks, nowMs: t0 });
  const results = {}, caches = {};
  const one = async (k, w, limit, fn, fin) => {
    const r = await runPart(k, w, limit, fn), s = net.stats[k] || { requests: 0, bytes: 0, hosts: {} };
    r.requests = s.requests; r.megabytes = Math.round(s.bytes / 1e4) / 100;
    r.hosts = Object.fromEntries(Object.entries(s.hosts).map(([h, x]) => [h, Object.assign({ requests: x.requests, megabytes: Math.round(x.bytes / 1e4) / 100, status: x.status }, x.refused ? { refused: x.refused } : {})]));
    // A part that never reached its host says so, not only what its fetcher made of the refusal.
    const refused = Object.keys(s.hosts).filter(h => s.hosts[h].refused && !s.hosts[h].requests);
    if (!r.snap && refused.length) r.error = 'not contacted by the relay: ' + refused.join(', ') + ' (deny list, or HTTP 403/429 earlier in this run) — ' + r.error;
    if (r.snap) r.emptied = finishPart(k, r.snap, fin, generatedAt);
    results[k] = r;
    log('relay: ' + k + ' ' + (r.snap ? 'ok' : 'FAILED (' + r.error + ')') + ' · ' + r.seconds + ' s · ' + r.requests + ' requests · ' + r.megabytes + ' MB' +
        (r.cache ? ' · cache: ' + r.cache.reused + ' reused, ' + r.cache.fetched + ' fetched' + (r.cache.dropped ? ' (' + r.cache.dropped + ')' : '') : '') +
        (r.emptied && r.emptied.length ? ' · emptied ' + r.emptied.join(', ') : ''));
    return r;
  };
  // --parts: a part name, "since" for all its sub-parts, or "since.<sub>" for single ones.
  for (const k of ORDER) {
    if (k !== 'since') { if (!only || only.includes(k)) await one(k, win, PARTS[k].limit, null, win); continue; }
    for (const sk of SINCE_KEYS) {
      if (only && !only.includes('since') && !only.includes('since.' + sk)) continue;
      const def = SINCE[sk], w = SINCE_EXT.includes(sk) ? xw : sw;
      if (!def.cache) { await one('since.' + sk, w, def.limit, x => def.run(x), w); continue; }
      const ck = def.weekly === false ? null : sw.week;
      const lc = loadCache(cacheDir, sk, ck), holder = { prev: lc.prev };
      const r = await one('since.' + sk, w, def.limit, x => def.run(x, holder), w);
      const info = holder.info || { reused: 0, fetched: r.requests, dropped: null };
      r.cache = { file: 'cache/' + cacheName(sk, ck), reused: info.reused, fetched: info.fetched, dropped: info.dropped || lc.note || null };
      // A failed run keeps the previous cache of the week (when it was one; gfs/faa: the previous file, pruned by the next
      // run that succeeds), so nothing already read is lost.
      caches[sk] = holder.next || (def.weekly === false ? lc.prev : (lc.prev && lc.prev.from === sw.from ? lc.prev : null));
    }
  }
  net.restore();
  // The stop note goes out on every path, also when nothing else is written (the workflow then publishes it alone).
  const putNote = () => {
    if (!net.blocks.length) return;
    fs.mkdirSync(path.join(outDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'cache', 'blocked.json'), JSON.stringify(blockedNote(net.blocks), null, 1) + '\n');
    log('relay: stop note → cache/blocked.json (' + net.blocks.map(b => b.host + ' HTTP ' + b.status + ' until ' + String(b.until).slice(0, 16) + 'Z').join(', ') + ')');
  };
  const L = assemble(win, generatedAt, results, process.env, sw);
  const problems = validate(L), errors = problems.filter(p => !/^warn:/.test(p));
  problems.forEach(p => log('relay: contract ' + (/^warn:/.test(p) ? '' : 'PROBLEM ') + p));
  const text = JSON.stringify(L);
  const PC = require(path.join(__dirname, 'privacy-check.js')), terms = PC.loadTerms();
  const found = PC.checkText('latest.json', text, terms).concat(PC.checkJson('latest.json', L));
  const bad = PC.report(found, 1, !!terms);
  log('relay: latest.json ' + Math.round(text.length / 1024) + ' KB · ' + Math.round((Date.now() - t0) / 1000) + ' s · ' +
      Object.values(results).reduce((s, r) => s + (r.requests || 0), 0) + ' requests · ' +
      Math.round(Object.values(results).reduce((s, r) => s + (r.megabytes || 0), 0) * 10) / 10 + ' MB');
  if (bad || errors.length) { putNote(); log('relay: FAILED — ' + (bad ? 'privacy check' : 'contract') + '; nothing written, the published file stays as it was'); return 1; }
  // The caches are published too (data branch): the same privacy check, built-in rules (they hold grids only).
  const cacheTexts = Object.entries(caches).filter(([, c]) => c).map(([k, c]) => [cacheName(k, SINCE[k].weekly === false ? null : sw.week), JSON.stringify(c)]);
  const cbad = PC.report([].concat(...cacheTexts.map(([n, t]) => PC.checkText('cache/' + n, t, terms))), cacheTexts.length, !!terms);
  if (cbad) { putNote(); log('relay: FAILED — privacy check of the caches; nothing written'); return 1; }
  fs.mkdirSync(outDir, { recursive: true });
  const put = (p, t) => { const tmp = p + '.tmp-' + process.pid; fs.writeFileSync(tmp, t); fs.renameSync(tmp, p); };
  const p = path.join(outDir, 'latest.json');
  put(p, text);
  if (cacheTexts.length) {
    fs.mkdirSync(path.join(outDir, 'cache'), { recursive: true });
    cacheTexts.forEach(([n, t]) => put(path.join(outDir, 'cache', n), t));
  }
  putNote();
  log('relay: → ' + p + ' (' + PART_KEYS.filter(k => L.parts[k]).length + '/' + PART_KEYS.length + ' parts)' +
      (cacheTexts.length ? ' + ' + cacheTexts.map(([n, t]) => 'cache/' + n + ' ' + Math.round(t.length / 1024) + ' KB').join(', ') : ''));
  return 0;
}

// --check-blocked FILE: 1 (with a GitHub error line per entry) while the stop note holds an entry in force, else 0.
function checkBlocked(file, nowMs) {
  const act = inForce(readBlocked(file), nowMs == null ? Date.now() : nowMs);
  act.forEach(b => console.log('::error title=WX relay::' + b.host + ' answered HTTP ' + b.status + ' at ' + String(b.at).slice(0, 16) + 'Z (' + (b.part || '?') +
    ') — not contacted until ' + String(b.until).slice(0, 16) + 'Z (cache/blocked.json on the data branch; delete the entry to ask again earlier)'));
  if (!act.length) console.log('relay: no stop note in force.');
  return act.length ? 1 : 0;
}

module.exports = { SCHEMA, PART_KEYS, SINCE_KEYS, SINCE_EXT, STAMPS, MIN_DAYS, BLOCK_HOURS, ATTRIBUTION, ATTRIBUTION_SINCE, DISCLAIMER, windowOf, sinceWindowOf, extWindowOf, isoWeekOf,
                   finishPart, validate, assemble, loadCache, cacheName, installFetch, denyList, readBlocked, inForce, blockedNote, headerValues, checkBlocked, main };
if (require.main === module && process.argv[2] === '--check-blocked') process.exit(checkBlocked(process.argv[3]));
if (require.main === module) {
  if (!fs.existsSync(path.join(SCRIPTS, 'fetch-util.js'))) {
    console.log('relay: scripts/ not found next to relay.js — run the packaged copy (node tools/wx-relay/package.js, then dist/relay.js).');
    process.exit(2);
  }
  main(process.argv).then(code => process.exit(code), e => { console.log('relay: FAILED — ' + ((e && e.stack) || e)); process.exit(1); });
}
