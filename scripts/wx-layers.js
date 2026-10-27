// ---------------------------------------------------------------------------
// wx-layers.js
// The weather layer registry (ADR-001 phase 1, 2026-10-20): one producer and one parameter set per weather layer, for
// the Monday run (scripts/fetch-*.js) and the public relay (tools/wx-relay/relay.js, which runs a packaged copy of
// scripts/). Kurt's decision of 13 Oct: every weather layer comes from the same source in Briefing week, This week and
// Week ahead. The two callers may differ only in the window (the dates asked for), the cache and the privacy filter
// applied to the output (relay.js finishPart), never in the producer or its parameters.
//
// Per layer:
//   producer  where the layer is made (function names, for people: the code calls them directly)
//   version   raised by hand when the producer changes what it makes from the same answers
//   profile   the parameters both callers use; the fetchers read them from here (profile(id))
//   privacy   'public' (in the relay) | 'private' (Monday only, C2: international SIGMETs, pilot reports, hub METARs)
//   window    'week' (relay: Monday to now) | 'ext3' (relay: at least the last 3 days); ADR-001 Q2 kept 'week' for
//             lightning, radar, US SIGMETs and SPC reports
//   relay     the relay part that carries it (relay.js PARTS / SINCE keys), or null
//
// Every layer output carries stamp(id, effective) = { layer, version, params }: params is a short hash of the version,
// the profile and the `effective` constants the producer passes in (the grids and thresholds of its own module), so a
// relay running an older copy of a fetcher, or a local edit of a grid, gives a different stamp. The page and the tests
// compare stamps: the same stamp on a Monday snapshot and a relay part means the same producer with the same parameters.
// Leaf module: requires nothing of the project, so every fetcher can require it.
// ---------------------------------------------------------------------------
'use strict';

const crypto = require('crypto');

const LAYERS = {
  'sigwx-official': { producer: 'fetch-sigwx.js fetchSigwx / fetchSigwxObserved', version: 1, privacy: 'public', window: 'ext3', relay: ['sigwx', 'since.sigwx'],
    profile: { chartHourUtc: 12, choice: '06Z run +6 h first; stand-ins 00Z +12 h, previous 18Z +18 h, previous 12Z +24 h', finalWhen: '06Z +6 h chart, or two days old' } },
  'sigwx-model': { producer: 'fetch-sigwx-model.js fetchSigwxModel / fetchSigwxModelObserved', version: 1, privacy: 'public', window: 'ext3', relay: ['sigwxModel', 'since.sigwx'],
    // S8: the CAT calibration is pinned here, no longer read from config.json (the Monday run read it there, the relay
    // from its own copy; "percentile" in one of them would have drawn the same day differently).
    profile: { catCalibration: 'fixed', pastHourUtc: 12 } },
  'contrails': { producer: 'fetch-contrails.js fetchContrails / fetchContrailsObserved', version: 1, privacy: 'public', window: 'ext3', relay: ['contrails', 'since.contrails'],
    // 2026-10-21 (Kurt): Schmidt-Appleman criterion plus near-ice-saturation (RHi >= 0.95, GFS caps RH at 100 %) on the three
    // flight levels of ADR-001 Q1; classes to +72 h like CAT; a typical turbofan, no aircraft type.
    profile: { levels: ['300', '250', '200'], hourUtc: 12, criterion: 'SAC + RHi threshold',
               aircraft: { eta: 0.3, eiH2o: 1.23, qFuel: 43.13e6, cp: 1004, eps: 0.622, eSat: 'MK05' },
               thresholds: { rhiPersistent: 0.95, minPts: 5 }, leadMaxH: 72 } },
  'gfs-jet': { producer: 'fetch-wxreview.js readGfsDay → fetch-wxoutlook.js jetLevels (fetchWxReview jetChain, fetchGfsObserved)', version: 1, privacy: 'public', window: 'ext3', relay: ['since.gfs'],
    // ADR-001 Q1: FL300, FL340 and FL390 in every view.
    profile: { levels: ['300', '250', '200'], hourUtc: 0, cycle: '00Z analysis (f000), NOMADS, else the AWS archive' } },
  'gfs-levels': { producer: 'fetch-wxreview.js readGfsDay → fetch-wxoutlook.js levelDays', version: 1, privacy: 'public', window: 'ext3', relay: ['since.gfs'],
    profile: { hourUtc: 0, fields: ['tropopause', 'max-wind level', 'freezing level'] } },
  'us-convective': { producer: 'fetch-wxreview.js readIemUs + naConvectiveGrid (fetchWxReview, fetchUsObserved)', version: 1, privacy: 'public', window: 'week', relay: ['since.wxreview'],
    profile: { sampleStepH: 3, convFreshMin: 60, source: 'IEM SIGMET archive (KML), newest hourly issue only' } },
  'spc-reports': { producer: 'fetch-wxreview.js readSpcDays (fetchWxReview, fetchUsObserved)', version: 1, privacy: 'public', window: 'week', relay: ['since.wxreview'],
    profile: { dayDefinition: '12Z on the date to 11:59Z the next day, preliminary', file: '_rpts_filtered.csv' } },
  'sigmets-international': { producer: 'fetch-wxreview.js fetchWxReview awcChain', version: 1, privacy: 'private', window: 'week', relay: null,
    profile: { sampleStepH: 3, source: 'AWC isigmet' } },
  'pireps': { producer: 'fetch-wxreview.js fetchWxReview (AWC, IEM)', version: 1, privacy: 'private', window: 'week', relay: null, profile: {} },
  'hub-weather': { producer: 'fetch-wxreview.js aggregateMetars (Monday) / the page wxhEv (This week, from the archive)', version: 1, privacy: 'private', window: 'week', relay: null, profile: {} },
  'lightning': { producer: 'fetch-lightning.js fetchLightning', version: 1, privacy: 'public', window: 'week', relay: ['since.lightning'], profile: { frameEveryH: 1 } },
  'mrms': { producer: 'fetch-mrms.js fetchMrms', version: 1, privacy: 'public', window: 'week', relay: ['since.mrms'], profile: { fileEveryH: 1 } },
  'nat-days': { producer: 'fetch-natarchive.js fetchNatArchive', version: 1, privacy: 'public', window: 'ext3', relay: ['since.nat'], profile: { captures: '05:30Z and 17:00Z' } },
  'nat-message': { producer: 'nat-message.js fetchNatLive', version: 1, privacy: 'public', window: null, relay: ['nat'], profile: {} },
  'faa-restrictions': { producer: 'fetch-faa.js readAdvisories + programCauses + aggregateArtcc (fetchFaa artcc, fetchFaaObserved)', version: 1, privacy: 'public', window: 'ext3', relay: ['since.faa'],
    // S4: the one count rule behind the North America day bar in every view.
    profile: { countRule: 'airport program group = kind + airport + day; cause = the most frequent among its advisories; weather programs of a day = its groups with cause WEATHER',
               airport: 'the CTL ELEMENT of the detail page (Monday), else the list element token it points to', opsPlans: 'Monday only, "expected", never counted' } },
  'wxoutlook': { producer: 'fetch-wxoutlook.js fetchWxOutlook', version: 1, privacy: 'public', window: null, relay: ['wxoutlook'], profile: { stepsH: 12, lastStepH: 168 } },
  'gefscat': { producer: 'fetch-gefs-cat.js fetchGefsCat', version: 1, privacy: 'public', window: null, relay: ['gefscat'], profile: {} },
  'dust': { producer: 'fetch-dust.js fetchDust', version: 1, privacy: 'public', window: null, relay: ['dust'], profile: {} },
};

// JSON with sorted keys, so the hash does not depend on the order a module happened to build an object in.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function layer(id) { const L = LAYERS[id]; if (!L) throw new Error('wx-layers: unknown layer ' + id); return L; }
// A copy, so a caller cannot change the registry for the next one.
function profile(id) { return JSON.parse(JSON.stringify(layer(id).profile)); }
function stamp(id, effective) {
  const L = layer(id);
  return { layer: id, version: L.version, params: crypto.createHash('sha256').update(canon({ v: L.version, profile: L.profile, effective: effective || null })).digest('hex').slice(0, 12) };
}
// A stamp as relay.js validate and the page accept it.
function isStamp(s, id) {
  return !!(s && typeof s === 'object' && (id == null || s.layer === id) && LAYERS[s.layer] && Number.isInteger(s.version) && /^[0-9a-f]{12}$/.test(String(s.params)));
}
// The relay's "since" sub-parts on the window of at least 3 days: those whose layers all say 'ext3'.
function sinceExt() {
  const by = {};
  Object.keys(LAYERS).forEach(id => (LAYERS[id].relay || []).filter(r => r.startsWith('since.')).forEach(r => { (by[r.slice(6)] = by[r.slice(6)] || []).push(LAYERS[id].window); }));
  return Object.keys(by).filter(k => by[k].every(w => w === 'ext3')).sort();
}

module.exports = { LAYERS, canon, layer, profile, stamp, isStamp, sinceExt };
