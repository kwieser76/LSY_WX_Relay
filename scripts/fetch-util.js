// ---------------------------------------------------------------------------
// fetch-util.js
// Shared plumbing for the pre-run fetchers fetch-czib.js, fetch-security.js and fetch-fuel.js:
// one declared identity, a timeout, one retry, the date helpers, and the snapshot / digest
// conventions they all follow. fetch-regulatory.js and fetch-eurocontrol.js predate this file and
// carry their own copies; they work and are left alone.
//
// The conventions, so a fourth fetcher does not have to rediscover them:
//   node scripts/fetch-X.js --from YYYY-MM-DD --to YYYY-MM-DD --week YYYY-Www [--backfill]
//   node scripts/fetch-X.js --print-digest --week YYYY-Www     (no network)
//   writes data/<dir>/week-<WEEK>.json; prints nothing on --print-digest when that file is missing,
//   so a stale block can never be handed to a run dressed as a fresh one.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// The relay's declared identity (several government hosts refuse a bare or absent UA).
const UA = 'LSY-WX-Relay/1.0 (+https://github.com/kwieser76/LSY_WX_Relay)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, opts) {
  const o = Object.assign({ accept: '*/*', timeoutMs: 25000, retries: 1, method: 'GET', body: null, headers: {} }, opts || {});
  let lastErr = null, lastStatus = null, lastRetryAfter = null;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), o.timeoutMs);
    try {
      const res = await fetch(url, { method: o.method, body: o.body, signal: ac.signal, redirect: 'follow',
        headers: Object.assign({ 'User-Agent': UA, Accept: o.accept }, o.headers) });
      if (!res.ok) {
        lastErr = 'HTTP ' + res.status;
        lastStatus = res.status;
        lastRetryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
        // A 4xx will not get better on a retry — and 403/429 mean "leave this host alone" (PO rule;
        // until 2026-10-07 a 429 was retried after 2 s).
        if (res.status >= 400 && res.status < 500) break;
        continue;
      }
      return await res.text();
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? 'timeout after ' + o.timeoutMs + 'ms' : String((e && e.message) || e);
    } finally { clearTimeout(t); }
  }
  // status and Retry-After travel with the error: a caller that honours a rate limit needs both
  // (fetch-linkedin.js waits as long as LinkedIn asks before its one later attempt).
  throw Object.assign(new Error(url.replace(/\?.*$/, '') + ': ' + lastErr), { status: lastStatus, retryAfter: lastRetryAfter });
}
async function getJSON(url, opts) {
  return JSON.parse(await getText(url, Object.assign({ accept: 'application/json' }, opts || {})));
}

// ---- dates (all plain YYYY-MM-DD strings, computed in UTC) ------------------
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoWeekOf(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  return y + '-W' + String(Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0');
}
const today = () => new Date().toISOString().slice(0, 10);
const inRange = (d, from, to) => !!d && d >= from && d <= to;

// ---- CLI and files ---------------------------------------------------------
function cli(argv) {
  const a = argv.slice(2);
  const argOf = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  return { argOf, has: n => a.includes(n), from: argOf('--from'), to: argOf('--to'), week: argOf('--week') };
}
function snapshotPath(dir, week) { return path.join(ROOT, 'data', dir, 'week-' + week + '.json'); }
function readSnapshot(dir, week) {
  try { return JSON.parse(fs.readFileSync(snapshotPath(dir, week), 'utf8')); } catch (e) { return null; }
}
// Written to a temporary name and renamed into place: a run killed mid-write must leave either the
// old file or the new one, never half of one that the dashboards then fail to parse.
function writeSnapshot(dir, week, obj) {
  const p = snapshotPath(dir, week);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
  return path.relative(ROOT, p);
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) { return {}; }
}

// The whole entry point of a fetcher, so the three behave identically: --print-digest reads the
// week's file and prints, a fetch writes the file, and a failure exits 1 with nothing written.
// A hard ceiling on one fetcher's wall-clock time. Every request already has its own timeout, but a
// slow source answering just inside each one — NVD with three retries on five products — could still
// hold the Monday run for many minutes. Past the ceiling the fetcher gives up, writes nothing, and the
// run carries on with the fallback text.
const MAX_SECONDS = { 'fetch-security': 300, 'fetch-faa': 600, 'fetch-linkedin': 420, 'fetch-wxoutlook': 300, 'fetch-wxreview': 300, 'fetch-lightning': 420, 'fetch-hiring': 420, 'fetch-mrms': 420, 'fetch-eccc-lightning': 300, 'fetch-dust': 240, 'fetch-sigwx': 240, 'fetch-sigwx-model': 300, 'fetch-gefs-cat': 240 };
async function main(name, dir, fetchFn, digestFn) {
  const c = cli(process.argv);
  if (!c.has('--print-digest')) {
    const limit = MAX_SECONDS[name] || 180;
    setTimeout(() => { console.log(name + ': FAILED — gave up after ' + limit + ' s. Nothing written.'); process.exit(1); }, limit * 1000).unref();
  }
  if (c.has('--print-digest')) {
    const s = readSnapshot(dir, c.week);
    if (s && s.window && s.window.week === c.week) process.stdout.write(digestFn(s) + '\n');
    process.exit(0);
  }
  if (!c.from || !c.to || !c.week) {
    console.log(name + ': --from, --to and --week are required. Nothing fetched.');
    process.exit(0);
  }
  let snap;
  try {
    snap = await fetchFn({ from: c.from, to: c.to, week: c.week, backfill: c.has('--backfill') });
  } catch (e) {
    console.log(name + ': FAILED — ' + e.message + '. Nothing written.');
    process.exit(1);
  }
  snap.generatedAt = new Date().toISOString();
  snap.mode = c.has('--backfill') ? 'backfill' : 'live';
  snap.window = { from: c.from, to: c.to, week: c.week };
  (snap.summary || []).forEach(l => console.log(name + ': ' + l));
  (snap.notes || []).forEach(n => console.log(name + ': NOTE — ' + n));
  delete snap.summary;
  console.log(name + ': → ' + writeSnapshot(dir, c.week, snap));
}

module.exports = { ROOT, UA, sleep, getText, getJSON, addDays, isoWeekOf, today, inRange, cli,
                   readSnapshot, writeSnapshot, readConfig, main, MAX_SECONDS };
