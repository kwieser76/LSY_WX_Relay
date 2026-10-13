#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-natarchive.js
// The North Atlantic tracks of every day of the reporting week, both directions, read from the
// archive that scripts/capture-nat.js builds in a GitHub repository (twice a day, by GitHub Actions;
// see tools/nat-archive/README.md). The FAA page itself only ever shows the current sets, and the
// FAA ATCSCC advisories (fetch-faa.js) give only the eastbound entry points; this block has every
// track with its coordinates.
//
// Settings, config.json:
//   "natArchive": { "repo": "kwieser76/LSY_NAT_Track", "branch": "Redline-main", "visibility": "public" }
//   (this relay copy reads public archives only: no token)
// No natArchive (or an empty repo name): the snapshot says { configured: false } and the digest
// "NAT ARCHIVE: not set up yet" — exit 0, the run goes on.
//
// Reading: archive/YYYY/MM/index.json of the months around the window (one request each), then the
// capture files that hold a set valid in the window — the newest capture of each set wins, so a
// revised message replaces the first one. Public: raw.githubusercontent.com; private: the GitHub
// contents API (raw media type). Parsed with the parser of fetch-faa.js (parseNatMessage), so the
// run-day message and the archive read the same way.
//
// A set belongs to the UTC date its validity starts: eastbound (Gander, CZQX) valid D 01:00–08:00Z,
// westbound (Shanwick, EGGX) valid D 11:30–19:00Z. The FAA ATCSCC advisory of evening D-1 plans the
// eastbound set of date D.
//
//   node scripts/fetch-natarchive.js --from YYYY-MM-DD --to YYYY-MM-DD --week YYYY-Www
//   node scripts/fetch-natarchive.js --print-digest --week YYYY-Www
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./fetch-util.js');
const FAA = require('./fetch-faa.js');

const PAUSE_MS = 300;
const TIMEOUT_MS = 20000;
// "Tue 29 Sep" — spelled out here, not by toLocaleDateString, whose month names change with the ICU version ("Sept").
const fmtDay = d => { const x = new Date(d + 'T00:00:00Z');
  return 'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[x.getUTCMonth()]; };
const daysOf = (from, to) => { const out = []; for (let d = from; d <= to; d = U.addDays(d, 1)) out.push(d); return out; };

// ---- settings -----------------------------------------------------------------------------------
function settingsOf(cfg) {
  const a = (cfg && cfg.natArchive) || null;
  if (!a || !String(a.repo || '').trim()) return null;
  const repo = String(a.repo).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('config.json natArchive.repo must be "owner/name", got "' + a.repo + '"');
  const visibility = String(a.visibility || 'public').toLowerCase() === 'private' ? 'private' : 'public';
  return { repo, branch: String(a.branch || 'main').trim() || 'main', visibility, tokenFile: a.tokenFile || null };
}
// Private archives are not read by this relay copy (no token in a public repository).
function readToken() { throw new Error('the relay copy reads public NAT archives only'); }
function urlOf(s, rel) {
  return s.visibility === 'private'
    ? 'https://api.github.com/repos/' + s.repo + '/contents/archive/' + rel + '?ref=' + encodeURIComponent(s.branch)
    : 'https://raw.githubusercontent.com/' + s.repo + '/' + encodeURIComponent(s.branch) + '/archive/' + rel;
}
const monthsOf = (from, to) => { const out = []; daysOf(U.addDays(from, -1), to).forEach(d => { const m = d.slice(0, 4) + '/' + d.slice(5, 7); if (!out.includes(m)) out.push(m); }); return out; };

// ---- pure: index -> files to read; captures -> days ------------------------------------------------
// index entries: { file, capturedAt, sets: [{ icao, from, to, lastUpdated }] }, with month 'YYYY/MM'.
// Per set (icao + validity start) inside the window, the newest capture holding it.
function pickCaptures(indexes, from, to) {
  const best = {};
  (indexes || []).forEach(({ month, entries }) => (entries || []).forEach(e => (e.sets || []).forEach(st => {
    const d = String(st.from || '').slice(0, 10);
    if (!U.inRange(d, from, to)) return;
    const key = st.icao + '|' + st.from, rank = String(st.lastUpdated || '') + '|' + String(e.capturedAt || '');
    if (!best[key] || rank > best[key].rank) best[key] = { rank, rel: month + '/' + e.file, icao: st.icao, from: st.from };
  })));
  const files = {};
  Object.values(best).forEach(b => { (files[b.rel] = files[b.rel] || []).push(b.icao + '|' + b.from); });
  return files;          // { 'YYYY/MM/DD-HHMM.json': ['CZQX|2026-10-06T01:00:00Z', ...] }
}
const dirOf = icao => (icao === 'CZQX' ? 'eastbound' : icao === 'EGGX' ? 'westbound' : null);
// A track line's route -> coordinates and the named points at each end. `coords` is a string of
// "lat,lon" pairs separated by spaces (south and west negative), e.g. "53,-50 55,-40 56,-30 56,-20":
// the snapshot is written pretty-printed, one array element per line, and a week of number pairs
// would take ~50 KB instead of ~25. Decode: coords.split(' ').map(p => p.split(',').map(Number)).
// Entry/exit positions are in data/nat-fixes.json (Gander side; the Shanwick points are not in NASR).
function trackOf(tk) {
  const toks = String(tk.route || '').split(' ').filter(Boolean);
  const coords = [], named = [];
  let seenCoord = false;
  toks.forEach(t => { const c = FAA.parseCoord(t); if (c) { coords.push(Math.round(c.lat * 100) / 100 + ',' + c.lon); seenCoord = true; } else named.push({ t, after: seenCoord }); });
  const entry = named.find(n => !n.after), exit = named.find(n => n.after);
  return { letter: tk.letter, route: tk.route, coords: coords.join(' '), entry: entry ? entry.t : null, exit: exit ? exit.t : null, lat30: tk.lat30 };
}
// captures: [{ rel, capture: { capturedAt, parts } , want: ['ICAO|from'] }] -> { days, missingDays, lat50wSeen }
function buildDays(captures, from, to, fixes) {
  const sets = {};
  (captures || []).forEach(c => {
    const parsed = FAA.parseNatMessage((c.capture && c.capture.parts) || []);
    parsed.forEach(st => {
      const key = st.icao + '|' + st.from;
      if (c.want && !c.want.includes(key)) return;
      if (!st.tracks.length) return;
      sets[key] = { st, capturedAt: c.capture.capturedAt, file: c.rel };
    });
  });
  const days = {};
  const lat50wSeen = {};
  Object.values(sets).forEach(({ st, capturedAt, file }) => {
    const dir = dirOf(st.icao), date = String(st.from).slice(0, 10);
    if (!dir || !U.inRange(date, from, to)) return;
    const tracks = st.tracks.map(tk => trackOf(tk)).sort((a, b) => a.letter.localeCompare(b.letter));
    // The latitude at 50W each Gander-side point was used with (checks nat-fixes.json lat50w over time).
    tracks.forEach(t => {
      const at50 = t.coords.split(' ').map(p => p.split(',').map(Number)).find(c => c[1] === -50);
      const name = dir === 'eastbound' ? t.entry : t.exit, pos = name && fixes && fixes[name];
      if (at50 && pos && pos[1] <= -50 && pos[1] >= -60) lat50wSeen[name] = at50[0];
    });
    (days[date] = days[date] || { date })[dir] = { icao: st.icao, from: st.from, to: st.to, tmi: st.tmi, north: st.north, south: st.south,
      splits: st.splits, remarks: st.remarks, capturedAt, tracks };
  });
  const list = daysOf(from, to).map(d => days[d] || { date: d });
  const missingDays = list.filter(d => !d.eastbound || !d.westbound)
    .map(d => ({ date: d.date, missing: ['eastbound', 'westbound'].filter(k => !d[k]) }));
  return { days: list.filter(d => d.eastbound || d.westbound), missingDays, lat50wSeen };
}

// ---- fetch -------------------------------------------------------------------------------------
async function fetchNatArchive({ from, to }) {
  const t0 = Date.now(), notes = [];
  const s = settingsOf(U.readConfig());
  if (!s) return { configured: false, notes: ['config.json has no natArchive.repo'], summary: ['not set up (config.json natArchive missing) — snapshot says configured:false'] };
  const headers = s.visibility === 'private'
    ? { Authorization: 'Bearer ' + readToken(s.tokenFile), Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }
    : {};
  let requests = 0;
  const get = async (rel, opts) => {
    requests++;
    try { return await U.getText(urlOf(s, rel), Object.assign({ timeoutMs: TIMEOUT_MS, headers }, opts || {})); }
    finally { await U.sleep(PAUSE_MS); }
  };
  // Indexes of the months around the window; a month without captures answers 404.
  const indexes = [], absent = [];
  for (const m of monthsOf(from, to)) {
    try { indexes.push({ month: m, entries: JSON.parse(await get(m + '/index.json')) }); }
    catch (e) {
      if (/HTTP 404/.test(e.message)) { absent.push(m); continue; }
      throw new Error('archive index ' + m + ' unreadable — ' + e.message.replace(/^https?:\/\/\S+: /, ''));
    }
  }
  const files = pickCaptures(indexes, from, to);
  const captures = [];
  for (const rel of Object.keys(files).sort()) {
    try { captures.push({ rel, want: files[rel], capture: JSON.parse(await get(rel)) }); }
    catch (e) { notes.push('capture ' + rel + ' unreadable — ' + e.message.replace(/^https?:\/\/\S+: /, '')); }
  }
  let fixes = null;
  try { fixes = JSON.parse(fs.readFileSync(path.join(U.ROOT, 'data', 'nat-fixes.json'), 'utf8')).fixes; } catch (e) { notes.push('data/nat-fixes.json not read — entry/exit positions left out'); }
  const r = buildDays(captures, from, to, fixes);
  if (absent.length && !indexes.length) notes.push('no capture in the archive for ' + absent.join(', ') + ' yet');
  if (r.missingDays.length) notes.push('days without a full set: ' + r.missingDays.map(d => d.date.slice(5) + ' ' + d.missing.join('+')).join(', '));
  const seconds = Math.round((Date.now() - t0) / 1000);
  return Object.assign({ configured: true, coordsEncoding: 'tracks[].coords: "lat,lon" pairs separated by spaces, south/west negative', source: { repo: s.repo, branch: s.branch, visibility: s.visibility, page: 'https://github.com/' + s.repo,
                                                     faa: 'https://nms.aim.faa.gov/nat', capture: 'twice daily, 05:30Z and 17:00Z (GitHub Actions)' } },
    r, { requests, seconds, notes,
         summary: [from + ' .. ' + to + ' · ' + r.days.length + '/7 days with tracks · ' + captures.length + ' capture file(s) · ' + requests + ' requests · ' + seconds + ' s'] });
}

// ---- digest ------------------------------------------------------------------------------------
function setLine(x) {
  if (!x) return 'none';
  const l = x.tracks.map(t => t.letter);
  return x.tracks.length + ' tracks ' + l[0] + '–' + l[l.length - 1] + (x.north != null ? ', 30W ' + x.north + '–' + x.south + 'N' : '') +
    (x.splits && x.splits.length ? ', split ' + x.splits.join('; ') : '') + (x.tmi ? ' (TMI ' + x.tmi + ')' : '');
}
function digest(s) {
  const L = [], w = s.window || {};
  if (!s.configured) {
    L.push('NAT ARCHIVE: not set up yet — the daily capture of the full NAT track message (both directions) is not configured,');
    L.push('so only the FAA advisory list of eastbound entry points (US FLOW block) covers the week. Say nothing about');
    L.push('westbound tracks or track coordinates of past days.');
    return L.join('\n');
  }
  // Where the copies are kept is ours, not the reader's: the block names only the FAA source (review 2026-10-13, W41 cited
  // "archived copies in kwieser76/LSY_NAT_Track" as a source).
  L.push('NAT ARCHIVE: the North Atlantic track message of each day of ' + w.from + '–' + w.to + ' (FAA NAS NAT page, collected twice a day)');
  if (!s.days || !s.days.length) {
    L.push('  No capture covers this week yet (the archive starts later or the capture did not run). Use the US FLOW block for the eastbound');
    L.push('  entry points only; say nothing about westbound tracks or track coordinates of this week.');
    return L.join('\n');
  }
  L.push('  30W latitudes run north to south; a split is a gap of 4 degrees or more between neighbouring tracks. Eastbound = Gander set, valid 01–08Z; westbound = Shanwick set, 11:30–19Z.');
  s.days.forEach(d => L.push('  ' + fmtDay(d.date) + ' · eastbound ' + setLine(d.eastbound) + ' · westbound ' + setLine(d.westbound)));
  if (s.missingDays && s.missingDays.length) L.push('  MISSING: ' + s.missingDays.map(d => fmtDay(d.date) + ' ' + d.missing.join(' + ')).join(', ') + ' — say so; do not fill from memory.');
  const rem = [];
  s.days.forEach(d => ['eastbound', 'westbound'].forEach(k => ((d[k] && d[k].remarks) || []).forEach(r => { if (!rem.includes(r)) rem.push(r); })));
  if (rem.length) L.push('  Remarks in the messages: ' + rem.slice(0, 4).join(' | ').slice(0, 400));
  L.push('  CITE: ' + (s.source && s.source.faa) + ' as "FAA NAS NAT page (daily track messages)". Do not name where the copies are kept.');
  L.push('  HOW TO USE: report an unusually northern or southern system, splits and remarks (closed points, OCR, GNSS) where they matter for');
  L.push('  long-haul planning; a routine week needs one sentence. The dashboards draw the tracks from this block.');
  return L.join('\n');
}

module.exports = { settingsOf, readToken, urlOf, monthsOf, pickCaptures, trackOf, buildDays, fetchNatArchive, digest };
if (require.main === module) U.main('fetch-natarchive', 'natarchive', fetchNatArchive, digest);
