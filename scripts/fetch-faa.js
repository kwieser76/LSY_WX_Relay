#!/usr/bin/env node
// ---------------------------------------------------------------------------
// fetch-faa.js
// Reads the FAA Command Center's advisories for the reporting week before the research run and
// hands over the US flow-management picture: ground stops and ground delay programs per airport
// with their cause and delay, events that hit several airports at once, oceanic route closures,
// staffing triggers from the daily Operations Plan, volcanic-ash bulletins — and, from the second
// week on, the previous week's biggest US event if the previous briefing did not mention it.
// Feeds the "US flow management" card / section of both dashboards and a prompt block.
//
// Since 2026-10-05 also the weather and the North Atlantic (weather is the
// most frequent cause of delay on both sides of the Atlantic):
//   - weather by day: the WEATHER programs plus the weather lines of the Operations Plan's
//     TERMINAL and EN ROUTE CONSTRAINTS (first and last plan of each day);
//   - the eastbound North Atlantic tracks of every day, from the NATOTS_RQD advisory: track letters,
//     ocean entry points, entry points closed, notes. The database keeps 14 days, so this is the
//     only free NAT history we use (the Wayback Machine copies were ruled out: research use only);
//   - the full NAT track message of the run day from the FAA NOTAM system's NAT page
//     (nms.aim.faa.gov/datanat/nat.json): every track with its coordinates, the latitude at 30W,
//     split systems, the TMI and the operational remarks. Current only, no history.
//
// Why: the US flow picture next to the weather: what the Command Center restricted, where and why.
//
// Source: the ATCSCC Advisories Database, https://www.fly.faa.gov/adv/advAdvisoryForm — anonymous,
// US government work (public domain). One GET per day lists every advisory (number, control
// element, title, link); each ground stop and ground delay program advisory carries structured
// "KEY: value" lines, among them IMPACTING CONDITION (cause / sub-cause) and the delays. The
// database keeps the current day and the 14 before it, so a Monday run always has the whole week
// and a backfill reaches back two weeks at most. Measured 2026-10-03 on W39: 845 advisories, 114
// ground-stop and 59 ground-delay-program advisories. www.faa.gov itself refuses scripted clients
// (403); fly.faa.gov does not, and nothing here pretends to be a browser.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const U = require('./fetch-util.js');
const L = require('./wx-layers.js');        // the weather layer registry: producer stamp of the restrictions layer

const HOST = 'https://www.fly.faa.gov';
const FORM = HOST + '/adv/advAdvisoryForm';
const QUERY = 'whichAdvisories=ATCSCC&advisoryCategory=All&airflow=true&_airflow=on&ctop=true&_ctop=on&gStop=true&_gStop=on' +
              '&gDelay=true&_gDelay=on&route=true&_route=on&other=true&_other=on';
const PAUSE_MS = 400;   // polite pacing: about 200 requests a week, roughly two minutes

// Display names, and the words an earlier briefing would have used if it mentioned the airport.
const AIRPORTS = {};          // display names of the airports: empty in this relay copy

// ---- parsing -----------------------------------------------------------------
function classify(title) {
  const s = String(title || '').toUpperCase();
  if (/VOLCANIC ACTIVITY BULLETIN/.test(s)) return 'volcanic';
  if (/OPERATIONS PLAN/.test(s)) return 'opsPlan';
  if (/GROUND STOP|\bGS CNX\b/.test(s)) return /CANCEL|CNX/.test(s) ? 'gsCancel' : 'gs';
  if (/GROUND DELAY PROGRAM|\bGDP\b/.test(s)) return /PROPOSED/.test(s) ? 'gdpProposed' : (/CNX|CANCEL/.test(s) ? 'gdpCancel' : 'gdp');
  if (/AIRSPACE FLOW PROGRAM|\bAFP\b/.test(s)) return /CNX|CANCEL/.test(s) ? 'afpCancel' : 'afp';
  if (/\bCTOP\b/.test(s)) return 'ctop';
  // "OCEANIC ROUTE CLOSURE" and, seen 2026-10-04, "ATLANTIC ROUTE CLOSURE_RQD": both are closures of
  // West Atlantic routes (WATRS, New York / Miami Oceanic), not of the North Atlantic tracks.
  if (/(OCEANIC|ATLANTIC) ROUTE CLOSURE/.test(s)) return 'oceanic';
  if (/NATOTS/.test(s)) return 'nat';
  if (/\bSWAP/.test(s)) return 'swap';
  if (/ROUTE|_RQD|_RMD|PLAYBOOK|\bFCA\b|CDRS|CAPPING|TUNNEL/.test(s)) return 'route';
  if (/ARRIVAL DELAYS|DEPARTURE DELAYS|SCHEDULING DELAYS|DIVERSION RECOVERY/.test(s)) return 'delayInfo';
  return 'other';
}

const unhtml = s => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');

function parseList(html) {
  const rows = [];
  (html.match(/<tr[\s\S]*?<\/tr>/g) || []).forEach(tr => {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(c => unhtml(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    const link = /href="(\/adv\/adv_otherdis\?[^"]+)"/.exec(tr);
    if (cells.length >= 5 && /^\d+$/.test(cells[0])) {
      rows.push({ n: parseInt(cells[0], 10), element: cells[1], date: cells[2], title: cells[3], sent: cells[4],
                  link: link ? HOST + unhtml(link[1]) : null, kind: classify(cells[3]) });
    }
  });
  return rows;
}

// The advisory body: everything from "ATCSCC ADVZY" to the page footer, tags stripped.
function adviceText(html) {
  let t = unhtml(String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '\n'));
  const a = t.indexOf('ATCSCC ADVZY'); if (a >= 0) t = t.slice(a);
  const b = t.indexOf('FAA.gov Home'); if (b > 0) t = t.slice(0, b);
  return t.split('\n').map(l => l.trim()).filter((l, i, arr) => l || (arr[i - 1] || '').trim()).join('\n').trim();
}
const field = (t, key) => { const m = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(t); return m ? m[1].trim() : null; };

function parseProgram(t) {
  const cond = field(t, 'IMPACTING CONDITION') || '';
  const [main, sub] = cond.split('/').map(x => (x || '').trim().toUpperCase());
  const gs = /NEW TOTAL, MAXIMUM, AVERAGE DELAYS:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(t);
  const num = k => { const v = field(t, k); return v && /^\d+/.test(v) ? parseInt(v, 10) : null; };
  let comment = field(t, 'COMMENTS') || '';
  if (/^EFFECTIVE TIME/.test(comment)) comment = '';
  return {
    airport: (field(t, 'CTL ELEMENT') || '').toUpperCase(),
    condition: cond.toUpperCase(),
    category: sub === 'SECURITY' ? 'SECURITY' : (main || 'UNSPECIFIED'),
    maxDelay: gs ? parseInt(gs[2], 10) : num('MAXIMUM DELAY'),
    avgDelay: gs ? parseInt(gs[3], 10) : num('AVERAGE DELAY'),
    totalDelay: gs ? parseInt(gs[1], 10) : null,
    rate: num('PROGRAM RATE'),
    comment,
    // round 4: the program's window and element type, for the hours of the ARTCC block
    period: field(t, 'GROUND STOP PERIOD') || field(t, 'CUMULATIVE PROGRAM PERIOD') || field(t, 'PROGRAM PERIOD'),
    elementType: (field(t, 'ELEMENT TYPE') || '').toUpperCase() || null,
  };
}

// "ZNY ADVISES THAT L452 / L454 ARE CLOSED DUE TO THUNDERSTORMS." -> routes + reason
function parseOceanic(t) {
  const m = /ADVISES THAT\s+([\s\S]+?)\s+(?:IS|ARE)\s+CLOSED\s+DUE TO\s+([^.\n]+)/i.exec(t);
  return m ? { routes: m[1].replace(/\s+/g, ' ').trim(), reason: m[2].trim().toLowerCase() } : null;
}

// The Operations Plan: the narrative paragraph, the STAFFING TRIGGER(S) block, and the TERMINAL and
// EN ROUTE CONSTRAINTS ("AAA/BBB - LOW CEILINGS", "ZNY/ZDC - THUNDERSTORMS").
const WX_WORDS = /THUNDER|TSTM|CEILING|VIS\b|VISIBILITY|FOG|WIND|SNOW|ICE|ICING|FREEZING|RAIN|TURB|HURRICANE|TROPICAL|STORM|LOW CIG|WX\b|WEATHER/;
function parseOpsPlan(t) {
  const lines = t.split('\n');
  const narr = []; let inNarr = false, staffing = [], inStaff = false;
  const sections = {}; let cur = null;
  for (const l of lines) {
    if (/^_{10,}$/.test(l)) { inNarr = !inNarr && !narr.length; cur = null; continue; }
    if (inNarr) { if (l) narr.push(l); continue; }
    if (/^STAFFING TRIGGER\(S\):/.test(l)) { inStaff = true; continue; }
    if (inStaff) { if (!l || /^[A-Z /()-]+:$/.test(l)) { inStaff = false; } else { staffing.push(l); continue; } }
    const h = /^([A-Z][A-Z /()&]+):$/.exec(l);
    if (h) { cur = sections[h[1].trim()] = []; continue; }
    if (!l) { cur = null; continue; }
    if (cur) cur.push(l);
  }
  const s = staffing.join(' ').trim();
  // "AAA/BBB - THUNDERSTORMS" → { where: ['AAA','BBB'], what: 'THUNDERSTORMS' }; NONE and non-weather
  // lines (runway maintenance, RCAG outages) are dropped here — they are not weather.
  const constraints = key => (sections[key] || []).map(x => /^([A-Z0-9/]+)\s+-\s+(.+)$/.exec(x)).filter(Boolean)
    .map(m => ({ where: m[1].split('/').filter(Boolean), what: m[2].trim().toUpperCase() }))
    .filter(c => WX_WORDS.test(c.what));
  return { narrative: narr.join(' ').replace(/\s+/g, ' ').trim(), staffing: /^NONE$/i.test(s) ? '' : s,
           terminalWx: constraints('TERMINAL CONSTRAINTS'), enrouteWx: constraints('EN ROUTE CONSTRAINTS') };
}

// ---- North Atlantic ------------------------------------------------------------
// The NATOTS_RQD advisory: the eastbound tracks for one evening, as the US routings to each ocean
// entry point ("TRACK  T  AAA.LBSTA8.LBSTA..TOPPS.N569B.TUDEP.NATT" → T enters at TUDEP). Eastbound
// tracks are lettered from the north, Z the southernmost, so the order of the letters is the order
// of the entry points from north to south. No coordinates: those are in the NAT message below.
function parseNatAdvisory(t) {
  const per = /NORTH ATLANTIC ADVISORY FOR\s+(\d\d\/\d\d\/\d{4})\s+(\d{4})Z\s+TO\s+(\d\d\/\d\d\/\d{4})\s+(\d{4})Z/i.exec(t);
  const tracks = [], seen = {};
  let m; const re = /^TRACK\s+([A-Z])\s+(\S+)\s*$/gm;
  while ((m = re.exec(t))) {
    if (seen[m[1]]) continue;
    seen[m[1]] = 1;
    // Usually "…TUDEP.NATT"; the southernmost tracks leave via a domestic fix ("…JENYY..DOVEY").
    const e = new RegExp('\\.([A-Z]{5})\\.NAT' + m[1] + '$').exec(m[2]) || /([A-Z]{5})$/.exec(m[2]);
    tracks.push({ letter: m[1], entry: e ? e[1] : null });
  }
  tracks.sort((a, b) => (a.letter < b.letter ? -1 : 1));
  // "TALGO & BOBTU ARE UNAVAILABLE", "BOBTU INTERSECTION IS NOT AVAILABLE". Whole words only, and not
  // the words around them ("AS PER NOTAM, TALGO & …").
  const unavailable = [], NOT_FIX = /^(NOTAM|TRACK|ROUTE|FLOWS|POINT|AREAS|LEVEL)$/;
  const ru = /\b((?:[A-Z]{5}\s*(?:&|AND|,)\s*)*[A-Z]{5})(?:\s+INTERSECTION)?\s+(?:IS|ARE)\s+(?:UNAVAILABLE|NOT AVAILABLE|CLOSED)/g;
  while ((m = ru.exec(t))) (m[1].match(/\b[A-Z]{5}\b/g) || []).forEach(w => { if (!NOT_FIX.test(w) && unavailable.indexOf(w) < 0) unavailable.push(w); });
  const bul = /NAT OPS BULLETIN\s+([0-9]{4}[-_][0-9]{3}(?:\s+REV\s+\d+)?)/i.exec(t);
  // The paragraphs between the standard opening and "TODAYS TRACKS": what is different today.
  const body = (t.split(/TODAYS TRACKS:/)[0] || '').split(/\n\s*\n/).map(x => x.replace(/\s+/g, ' ').trim())
    .filter(x => x && !/^(RAW TEXT|EVENT TIME|ATCSCC ADVZY|NORTH ATLANTIC ADVISORY FOR|ALL AIRCRAFT TRANSITING)/.test(x));
  const iso = (d, hm) => d.slice(6, 10) + '-' + d.slice(0, 2) + '-' + d.slice(3, 5) + 'T' + hm.slice(0, 2) + ':' + hm.slice(2) + 'Z';
  return { from: per ? iso(per[1], per[2]) : null, to: per ? iso(per[3], per[4]) : null, tracks, unavailable,
           bulletin: bul ? bul[1].replace(/\s+/g, ' ').toUpperCase() : null, notes: body.slice(0, 5).map(x => x.length <= 420 ? x : x.slice(0, 420).replace(/\s+\S*$/, '') + ' …') };
}

// The NAT track message (nat.json) and its parser live in nat-message.js, shared with the public weather relay.
const { parseCoord, parseNatMessage, fetchNatLive } = require('./nat-message.js');

// Causes that make up the ordinary US week, the way weather and capacity make up ATFM delay in
// Europe. They are counted, never escalated: the first W40 test flagged two volume clusters as
// "missed last week" beside the real miss, and a correction list full of busy days buries the one
// that matters. Everything else — equipment, staffing, security, other — is an event.
const ROUTINE = new Set(['WEATHER', 'VOLUME', 'RWY-TAXI']);

// ---- fetch -------------------------------------------------------------------
let REQUESTS = 0;
let pauseNow = PAUSE_MS;   // fetchFaa's pauseMs (tests only)
async function get(url) { REQUESTS++; const t = await U.getText(url, { accept: 'text/html', timeoutMs: 30000, retries: 2 }); await U.sleep(pauseNow); return t; }

// The names an earlier briefing would have used for an airport: empty in this relay copy.
const ALIASES = {};
function mentioned(blob, airport) {
  if (new RegExp('\\b' + airport + '\\b').test(blob)) return true;
  const names = ALIASES[airport] || (AIRPORTS[airport] ? [AIRPORTS[airport]] : []);
  return names.some(n => blob.indexOf(n) > -1);
}

// ---- weather traffic restrictions per ARTCC and airport (round 4, 2026-10-06) ------------------
// For the North America weather map: per day and per Air Route Traffic Control Center (ARTCC) the
// weather-caused ground stops, ground delay programs, airspace flow programs, reroutes / flow-
// constrained areas, SWAP statements and route closures; per airport the same with its ARTCC, its
// position and the program hours. What the Command Center ISSUED ("happened") is kept apart from what
// the day's Operations Plans listed as thunderstorm constraints ("expected"): in W40 Kansas City was
// listed on five days and had no restriction at all.
// Extra requests on top of the program pages: one detail page per weather-relevant reroute name and
// day (only the detail page carries REASON), one per Gulf route closure group and day, and every
// airspace flow program — about 50 a week. They run last, under a soft deadline, so a slow day costs
// the reroute reasons, never the US flow block.
// Canada: NAV CANADA publishes no reusable delay or flow data (its terms allow personal,
// non-commercial use only), so Canadian FIRs are "no public data", never "no restrictions".
const ARTCC_IDS = ['ZAB', 'ZAU', 'ZBW', 'ZDC', 'ZDV', 'ZFW', 'ZHU', 'ZID', 'ZJX', 'ZKC', 'ZLA', 'ZLC', 'ZMA', 'ZME', 'ZMP', 'ZNY', 'ZOA', 'ZOB', 'ZSE', 'ZTL'];
const ARTCC_OCONUS = ['ZAN', 'ZHN', 'ZSU'];   // the centres outside the lower 48: covered by the same database
const ARTCC_NAMES = {};       // the centres' names: empty in this relay copy
// TRACONs that Operations Plans name instead of airports -> parent ARTCC.
const TRACONS = { A80: 'ZTL', A90: 'ZBW', C90: 'ZAU', D01: 'ZDV', D10: 'ZFW', D21: 'ZOB', F11: 'ZJX', I90: 'ZHU', K90: 'ZBW', L30: 'ZLA', M03: 'ZME',
  M98: 'ZMP', N90: 'ZNY', NCT: 'ZOA', P31: 'ZJX', P50: 'ZAB', P80: 'ZSE', PCT: 'ZDC', R90: 'ZMP', S46: 'ZSE', S56: 'ZLC', SCT: 'ZLA', T75: 'ZKC', U90: 'ZAB', Y90: 'ZBW' };
const CANADA_NOTE = 'NAV CANADA publishes no reusable delay or flow data (terms: personal, non-commercial use only). Canadian FIRs are "no public data", ' +
  'not "no restrictions"; programs the FAA itself issues for Canadian airports appear under airports with their FIR code.';
const WX_CLOSURE = /THUNDER|TSTM|WEATHER|\bWX\b|CONVECT|TURB|STORM|HURRICANE|TROPICAL|ICING/i;
const TS_WORDS = /THUNDER|TSTM|CONVECT/;

// Airport positions ("LID lat lon ARTCC [ICAO]" per airport): empty in this relay copy, which places the airports with
// OurAirports at run time (fetchFaaObserved, positionsUrl).
const AIRPORT_TABLE = '';
let POS = null;
function airportPos(code) {
  if (!POS) {
    POS = {};
    AIRPORT_TABLE.split('|').forEach(x => { const p = x.split(' ');
      POS[p[0]] = { lat: +p[1], lon: +p[2], artcc: p[3], icao: p[4] || (/^C[A-Z]{3}$/.test(p[0]) ? p[0] : (/^[A-Z]{3}$/.test(p[0]) ? 'K' + p[0] : p[0])) }; });
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(U.ROOT, 'tools', 'maps', 'src', 'airports-curated.json'), 'utf8')).airports || [];
      cur.forEach(a => { if (!a || !isFinite(+a.lat) || !isFinite(+a.lon) || !a.icao) return;
        const lid = /^K[A-Z]{3}$/.test(a.icao) ? a.icao.slice(1) : (/^C[A-Z]{3}$/.test(a.icao) ? a.icao : (a.iata || a.icao));
        const t = POS[lid] || {};
        POS[lid] = { lat: Math.round(a.lat * 100) / 100, lon: Math.round(a.lon * 100) / 100, artcc: t.artcc || null, icao: a.icao, name: a.name }; });
    } catch (e) { /* the table alone */ }
  }
  return POS[code] || null;
}

// "dd" + "hhmm" of an advisory issued on `day` -> epoch ms. The day of the month may belong to the next
// month (an advisory of 30 Sep valid to "010400") or, for a cumulative program period, the one before.
function advTime(day, dd, hhmm) {
  const d0 = new Date(day + 'T00:00:00Z'), D = parseInt(dd, 10);
  let m = d0.getUTCMonth();
  if (D < d0.getUTCDate() - 15) m++; else if (D > d0.getUTCDate() + 15) m--;
  return Date.UTC(d0.getUTCFullYear(), m, D, parseInt(hhmm.slice(0, 2), 10), parseInt(hhmm.slice(2, 4), 10));
}
// "01/1952Z - 01/2130Z" (GROUND STOP PERIOD, CUMULATIVE PROGRAM PERIOD) -> [start, end] ms, or null.
function parsePeriod(day, s) {
  const m = /(\d{2})\/(\d{4})Z?\s*-\s*(\d{2})\/(\d{4})Z?/.exec(String(s || ''));
  if (!m) return null;
  const a = advTime(day, m[1], m[2]), b = advTime(day, m[3], m[4]);
  return b > a ? [a, b] : null;
}
// The list's "sent" column, "10/01/26 21:18" (UTC) -> epoch ms.
function sentTime(s) {
  const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(String(s || ''));
  return m ? Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5]) : null;
}
// A reroute or flow-constrained area as the list title gives it:
// "ATCSCC ADVZY 152 DCC 10/01/26 ROUTE RQD /FL NAME: IAH_DOOBI_NORTH_PARTIAL CONSTRAINED AREA: ZHU VALID: ETD 011830 TO 020000"
// "… FCA RQD NAME: FCA007:DEN_GCK_2_PARTIAL CONSTRAINED AREA: ZDV VALID: FCA ENTRY TIME FROM 012200 TO 020200"
function parseRerouteTitle(title) {
  const m = /\b(ROUTE|FCA)\s+(RQD|RMD|FYI|PLN)\b[\s\S]*?\bNAME:\s*(\S+)\s+CONSTRAINED AREA:\s*([\s\S]+?)\s+VALID:\s*[A-Z ]*?(\d{6})\s+TO\s+(\d{6})/
    .exec(String(title || '').toUpperCase());
  if (!m) return null;
  const areas = Array.from(new Set(m[4].match(/\b(?:Z[A-Z]{2}|CZ[A-Z])\b/g) || []));
  return { type: m[1], action: m[2], name: m[3].replace(/^FCA[A-Z0-9]*:/, ''), areas, from: m[5], to: m[6] };
}
// The detail page: REASON is only there ("WEATHER", "OTHER", "VOLUME" …).
function parseReroute(t) {
  const areas = Array.from(new Set((field(t, 'CONSTRAINED AREA') || '').toUpperCase().match(/\b(?:Z[A-Z]{2}|CZ[A-Z])\b/g) || []));
  const reason = (field(t, 'REASON') || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return { name: (field(t, 'NAME') || '').toUpperCase(), areas, reason: reason || null };
}
// Gulf / West Atlantic route closures: which ARTCC, which routes, and whether the cause is weather.
function parseClosure(t) {
  const o = parseOceanic(t);
  const fac = ((field(t, 'CONSTRAINED FACILITIES') || '').toUpperCase().match(/\bZ[A-Z]{2}\b/g) || []);
  const adv = /\b(Z[A-Z]{2})\s+ADVISES THAT/i.exec(t);
  const facilities = Array.from(new Set(fac.concat(adv ? [adv[1].toUpperCase()] : [])));
  return { facilities, routes: o ? o.routes : null, reason: o ? o.reason : null, wx: !!(o && WX_CLOSURE.test(o.reason)) };
}
// One program's advisories and cancellations (same kind, same element) in time order -> the separate
// stops / programs with their effective window. An advisory sent while the current window runs, or
// whose period touches it, revises or extends it (the newest end wins); one sent after it ended opens a
// new one; a cancellation ends the window at the minute it was sent.
//   events: [{ t (sent, ms), cancel: bool, period: [a, b] | null, day }]
function programWindows(events) {
  const ev = events.filter(e => e.t != null).sort((x, y) => x.t - y.t || (x.cancel ? 1 : 0) - (y.cancel ? 1 : 0));
  const out = []; let cur = null;
  const close = () => { if (cur) out.push(cur); cur = null; };
  ev.forEach(e => {
    if (e.cancel) {
      if (cur && (cur.end == null || e.t < cur.end)) { cur.end = cur.start != null ? Math.max(cur.start, e.t) : null; cur.cancelled = true; }
      close(); return;
    }
    const p = e.period;
    const goesOn = cur && (cur.end == null ? cur.days[cur.days.length - 1] === e.day : (e.t <= cur.end || (p && p[0] <= cur.end + 60000)));
    if (goesOn) {
      if (p && cur.start != null) { cur.start = Math.min(cur.start, p[0]); cur.end = p[1]; } else { cur.start = null; cur.end = null; }
      if (cur.days.indexOf(e.day) < 0) cur.days.push(e.day);
    } else { close(); cur = { start: p ? p[0] : null, end: p ? p[1] : null, days: [e.day] }; }
  });
  close();
  return out;
}
// The part of a window that belongs to each of its days: everything up to the next day on which an
// advisory revised it belongs to the earlier day, so nothing is counted twice and nothing is lost.
function windowPortions(w) {
  if (w.start == null || w.end == null) return w.days.map(d => ({ day: d, ms: null }));
  const days = w.days.slice().sort();
  return days.map((d, k) => {
    const a = k ? Math.max(w.start, Date.parse(d + 'T00:00:00Z')) : w.start;
    const b = k + 1 < days.length ? Math.min(w.end, Date.parse(days[k + 1] + 'T00:00:00Z')) : w.end;
    return { day: d, iv: b > a ? [a, b] : null };
  });
}
const unionMs = ivs => { let tot = 0, cur = null;
  ivs.filter(Boolean).slice().sort((a, b) => a[0] - b[0]).forEach(([a, b]) => { if (!cur || a > cur[1]) { if (cur) tot += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); });
  return cur ? tot + cur[1] - cur[0] : tot; };
const hours1 = ms => Math.round(ms / 360000) / 10;

// Reroutes / FCAs issued as required or recommended, grouped by day and name (the versions of one
// reroute: amendments, extensions). Newest advisory first — its detail page is the one fetched.
function rerouteGroups(rows) {
  const g = {};
  rows.filter(r => r.kind === 'route').forEach(r => {
    const x = parseRerouteTitle(r.title);
    if (!x || (x.action !== 'RQD' && x.action !== 'RMD')) return;
    const k = r.day + '|' + x.name;
    const e = g[k] || (g[k] = { key: k, day: r.day, name: x.name, areas: [], windows: [], rows: [] });
    x.areas.forEach(a => { if (e.areas.indexOf(a) < 0) e.areas.push(a); });
    const a = advTime(r.day, x.from.slice(0, 2), x.from.slice(2)), b = advTime(r.day, x.to.slice(0, 2), x.to.slice(2));
    if (b > a) e.windows.push([a, b]);
    e.rows.push(r);
  });
  return Object.values(g).map(e => { e.rows.sort((p, q) => q.n - p.n); return e; });
}
// Gulf route closures by day and list element, newest first (oceanic closures are read anyway).
function closureGroups(rows) {
  const g = {};
  rows.filter(r => r.kind === 'route' && /GULF ROUTE CLOSURE/.test(r.title) && r.link).forEach(r => {
    const k = r.day + '|' + r.element; (g[k] = g[k] || { key: k, day: r.day, rows: [] }).rows.push(r); });
  return Object.values(g).map(e => { e.rows.sort((p, q) => q.n - p.n); return e; });
}
const centerOfElement = el => { const m = /\/(Z[A-Z]{2}|CZ[A-Z])$/.exec(String(el || '')); return m ? m[1] : null; };

// The pure part: list rows + parsed details -> the artcc block. Inputs:
//   dates          window days that were read
//   rows           list rows ({ day, n, kind, element, title, sent })
//   advs           [{ kind: 'gs'|'gdp'|'afp', code, center?, day, t, period, category }] one per program advisory
//   catOf          { 'gs|SAT|2026-10-01': 'WEATHER' } — the program groups' cause as the snapshot decides it
//   reasons        { 'day|NAME': 'WEATHER' | 'OTHER' … } from the reroute detail pages (missing = unverified)
//   closures       [{ day, facilities, wx }]
//   wxPlan         { day: { terminal: { what: [where] }, enroute: { … } } }  (Operations Plans)
function aggregateArtcc(inp) {
  const { dates, rows } = inp, advs = inp.advs || [], catOf = inp.catOf || {}, reasons = inp.reasons || {}, wxPlan = inp.wxPlan || {};
  const pos = inp.pos || airportPos;
  const ALL = ARTCC_IDS.concat(ARTCC_OCONUS), isC = c => ALL.indexOf(c) >= 0;
  const inWin = d => dates.indexOf(d) >= 0;
  // airport -> ARTCC from the list's control elements ("SAT/ZHU", "AAA BBB/ZLA", "CCC AND SATS/ZNY")
  const a2c = {};
  rows.forEach(r => { const m = /^(.+)\/(Z[A-Z]{2}|CZ[A-Z])$/.exec(r.element || ''); if (!m) return;
    (m[1].match(/\b[A-Z0-9]{3,4}\b/g) || []).forEach(a => { if (!/^(DCC|AND|SATS|ALL)$/.test(a) && !a2c[a]) a2c[a] = m[2]; }); });
  const centerOf = a => a2c[a] || TRACONS[a] || ((pos(a) || {}).artcc) || (isC(a) ? a : null);
  const C = {};
  const cell = (d, c) => { const x = C[d] || (C[d] = {}); return x[c] || (x[c] = { wx: 0, programs: 0, gs: 0, gdp: 0, afp: 0, reroutes: 0, swap: false,
    closure: false, airports: [], wins: [], unverified: 0 }); };
  const AP = {};
  const apDay = (a, d) => { const x = AP[a] || (AP[a] = {}); return x[d] || (x[d] = { gs: 0, gdp: 0, afp: 0, other: 0, ivs: [], untimed: false }); };

  // -- programs: group causes, windows, hours --
  const afpCat = {}, afpCenter = {};
  advs.filter(a => a.kind === 'afp').forEach(a => { const k = 'afp|' + a.code + '|' + a.day, c = afpCat[k] || (afpCat[k] = {});
    c[a.category] = (c[a.category] || 0) + 1; if (a.center) afpCenter[a.code] = a.center; });
  const cat = k => catOf[k] || (afpCat[k] ? Object.keys(afpCat[k]).sort((x, y) => afpCat[k][y] - afpCat[k][x])[0] : null);
  const groups = {};
  advs.forEach(a => { if (inWin(a.day)) groups[a.kind + '|' + a.code + '|' + a.day] = a; });
  Object.keys(groups).forEach(k => {
    const [kind, code, day] = k.split('|'), wx = cat(k) === 'WEATHER';
    if (kind === 'afp') { const c = afpCenter[code]; if (wx && c && isC(c)) cell(day, c).programs++; return; }
    if (!wx) { apDay(code, day).other++; return; }
    const c = centerOf(code); if (c && isC(c)) { const x = cell(day, c); x.programs++; if (x.airports.indexOf(code) < 0) x.airports.push(code); }
  });
  const ev = {};
  advs.forEach(a => { (ev[a.kind + '|' + a.code] = ev[a.kind + '|' + a.code] || []).push({ t: a.t, period: a.period, day: a.day }); });
  const CANCEL = { gsCancel: 'gs', gdpCancel: 'gdp', afpCancel: 'afp' };
  rows.filter(r => CANCEL[r.kind]).forEach(r => { const code = String(r.element || '').split('/')[0].trim(), k = CANCEL[r.kind] + '|' + code;
    if (ev[k]) ev[k].push({ t: sentTime(r.sent), cancel: true, day: r.day }); });
  Object.keys(ev).forEach(k => {
    const [kind, code] = k.split('|');
    programWindows(ev[k]).forEach(w => windowPortions(w).forEach(p => {
      if (!inWin(p.day) || cat(kind + '|' + code + '|' + p.day) !== 'WEATHER') return;
      if (kind === 'afp') { const c = afpCenter[code]; if (c && isC(c)) cell(p.day, c).afp++; return; }
      const x = apDay(code, p.day); x[kind]++;
      if (p.ms === null) x.untimed = true; else if (p.iv) x.ivs.push(p.iv);
      const c = centerOf(code); if (c && isC(c)) cell(p.day, c)[kind]++;
    }));
  });

  // -- reroutes / FCAs, SWAP statements, route closures --
  rerouteGroups(rows).forEach(g => {
    if (!inWin(g.day)) return;
    const r = reasons[g.key], wx = r ? /^WEATHER/.test(r) : null, d0 = Date.parse(g.day + 'T00:00:00Z');
    g.areas.filter(isC).forEach(c => { const x = cell(g.day, c);
      if (wx) { x.reroutes++; g.windows.forEach(w => { if (w[1] > d0) x.wins.push([Math.max(w[0], d0), w[1]]); }); } else if (wx === null) x.unverified++; });
  });
  rows.filter(r => r.kind === 'swap' && !/CNX|CANCEL/.test(r.title) && inWin(r.day)).forEach(r => {
    const cs = (String(r.title).match(/\bZ[A-Z]{2}\b/g) || []).concat(centerOfElement(r.element) || []);
    cs.filter(isC).forEach(c => { cell(r.day, c).swap = true; });
  });
  (inp.closures || []).forEach(x => { if (x.wx && inWin(x.day)) x.facilities.filter(isC).forEach(c => { cell(x.day, c).closure = true; }); });

  // -- expected: thunderstorms in the day's Operations Plans (first and last plan) --
  const expected = {};
  dates.forEach(d => {
    const w = wxPlan[d], ec = [], ea = [];
    const addC = c => { if (c && isC(c) && ec.indexOf(c) < 0) ec.push(c); };
    if (w) {
      Object.keys(w.enroute || {}).filter(k => TS_WORDS.test(k)).forEach(k => w.enroute[k].forEach(x => addC(isC(x) ? x : centerOf(x))));
      Object.keys(w.terminal || {}).filter(k => TS_WORDS.test(k)).forEach(k => w.terminal[k].forEach(x => {
        if (isC(x)) return addC(x);
        if (!TRACONS[x] && ea.indexOf(x) < 0) ea.push(x);
        addC(centerOf(x)); }));
    }
    expected[d] = { centers: ec.sort(), airports: ea.sort() };
  });

  // -- assemble --
  const days = dates.map(d => {
    const centers = {}; let reroutes = 0, programs = 0; const apts = new Set();
    Object.keys(C[d] || {}).sort().forEach(c => {
      const x = C[d][c];
      x.wx = x.programs + x.reroutes + (x.swap ? 1 : 0) + (x.closure ? 1 : 0);
      if (!x.wx && !x.unverified) return;
      const o = { wx: x.wx, programs: x.programs, gs: x.gs, gdp: x.gdp, afp: x.afp, reroutes: x.reroutes, swap: x.swap, closure: x.closure };
      if (x.wins.length) o.rerouteHours = hours1(unionMs(x.wins));
      if (x.airports.length) o.airports = x.airports.sort();
      if (x.unverified) o.unverified = x.unverified;
      centers[c] = o; reroutes += x.reroutes; programs += x.programs; x.airports.forEach(a => apts.add(a));
    });
    return { date: d, centers, expected: expected[d],
      totals: { centers: Object.keys(centers).filter(c => centers[c].wx > 0 && ARTCC_IDS.indexOf(c) >= 0).length, programs, airports: apts.size, reroutes } };
  });
  const week = {};
  ALL.forEach(c => {
    const w = { days: 0, programs: 0, gs: 0, gdp: 0, afp: 0, reroutes: 0, rerouteHours: 0, swapDays: 0, closureDays: 0, expectedDays: 0, expectedOnlyDays: 0 };
    days.forEach(d => { const x = d.centers[c], e = d.expected.centers.indexOf(c) >= 0, hit = !!(x && x.wx > 0);
      if (hit) { w.days++; w.programs += x.programs; w.gs += x.gs; w.gdp += x.gdp; w.afp += x.afp; w.reroutes += x.reroutes;
        w.rerouteHours += x.rerouteHours || 0; w.swapDays += x.swap ? 1 : 0; w.closureDays += x.closure ? 1 : 0; }
      if (e) { w.expectedDays++; if (!hit) w.expectedOnlyDays++; } });
    w.rerouteHours = Math.round(w.rerouteHours * 10) / 10;
    week[c] = w;
  });
  const missingPos = [];
  const airports = Object.keys(AP).map(code => {
    const p = pos(code), out = { icao: (p && p.icao) || code, faa: code, artcc: centerOf(code), lat: p ? p.lat : null, lon: p ? p.lon : null, wxDays: 0, hours: 0, days: {} };
    if (p && p.name) out.name = p.name; else if (AIRPORTS[code]) out.name = AIRPORTS[code];
    if (!p) missingPos.push(code);
    let untimed = false;
    Object.keys(AP[code]).filter(inWin).sort().forEach(d => {
      const x = AP[code][d], wx = x.gs + x.gdp + x.afp > 0;
      const h = wx ? (x.untimed ? null : hours1(unionMs(x.ivs))) : null;
      out.days[d] = { gs: x.gs, gdp: x.gdp, afp: x.afp, wx, hours: h };
      if (x.other) out.days[d].other = x.other;
      if (wx) { out.wxDays++; if (h == null) untimed = true; else out.hours += h; }
    });
    out.hours = untimed && !out.hours ? null : Math.round(out.hours * 10) / 10;
    return out;
  }).filter(a => Object.keys(a.days).length)
    .sort((a, b) => b.wxDays - a.wxDays || (b.hours || 0) - (a.hours || 0) || (a.faa < b.faa ? -1 : 1));
  const notes = [];
  if (missingPos.length) notes.push('no position for ' + missingPos.join(', ') + ' — not in the airport table');
  const unv = days.reduce((n, d) => n + Object.keys(d.centers).reduce((m, c) => m + (d.centers[c].unverified || 0), 0), 0);
  if (unv) notes.push(unv + ' reroute/FCA–ARTCC-day(s) with no REASON read (detail page not fetched or unreadable): counted as unverified, not as weather');
  return { ids: ARTCC_IDS.slice(), oconus: ARTCC_OCONUS.slice(), names: ARTCC_NAMES, days, week, airports, canada: 'no public data', canadaNote: CANADA_NOTE, notes };
}

// ---- one advisory reader for the Monday run and the relay (ADR-001 S4, 2026-10-20) --------------------------------
// fetchFaa (Monday) and fetchFaaObserved (relay) read the program, closure, reroute and airspace-flow pages through
// readAdvisories and count weather programs with programCauses. They differ only in detail(): the Monday run reads
// every page (programs and oceanic closures must be read, the rest within its time budget); the relay reads from its
// cache first and stops at its soft deadline. Each page is reduced to what the ARTCC layer needs and holds no airport
// code (the relay publishes its cache): programs { c: cause, p: period, a: index of the CTL ELEMENT among the list
// element's tokens (absent = first, -1 = not among them) }, closures { f: [ARTCC], wx, n: 1 = a closure was read },
// reroutes { r: 'WEATHER' | 'OTHER' | null }, airspace flow programs { c, p, z: ARTCC }.
const causeWord = s => (/^[A-Z][A-Z-]{1,19}$/.test(String(s || '')) ? String(s) : 'OTHER');
const elementTokens = el => (String(el || '').split('/')[0].match(/\b[A-Z0-9]{3,4}\b/g) || []);
function reduceProgram(r, p) {
  const i = p.airport ? elementTokens(r.element).indexOf(p.airport) : 0;
  return Object.assign({ c: causeWord(p.category), p: parsePeriod(r.day, p.period) }, i > 0 ? { a: i } : {}, i < 0 ? { a: -1 } : {});
}
// The airport a program controls, one rule: the detail page's CTL ELEMENT when the caller kept it (ctl, Monday only:
// the relay never holds a code it cannot cache), else the token the reduced page points to, else the list element.
// The two differ only when the CTL ELEMENT is not in the list element (one airport's element controlling a neighbour).
function programCode(r, x, ctl) {
  if (ctl) return ctl;
  const tk = elementTokens(r.element), first = String(r.element || '').split('/')[0].trim();
  return x && x.a > 0 && tk[x.a] ? tk[x.a] : (x && x.a === -1 ? first : (tk[0] || first));
}
const reduceClosure = t => { const cx = parseClosure(t); return { f: cx.facilities.filter(z => /^(Z[A-Z]{2}|CZ[A-Z])$/.test(z)), wx: cx.wx, n: cx.reason ? 1 : 0 }; };
const reasonWord = s => (s ? (/^WEATHER/.test(s) ? 'WEATHER' : 'OTHER') : null);
// rows: the list rows of the window. detail(r, reduce, phase) -> the reduced page or null (not read); phase is
// 'program' | 'oceanic' | 'reroute' | 'closure' | 'afp'. o.keepCodes: keep each program's CTL ELEMENT in memory (Monday);
// o.onProgram(r, p, code): the full parse of a freshly read program page; o.onOceanic(r, text): an oceanic page's text.
async function readAdvisories(rows, detail, o) {
  o = o || {};
  const advs = [], programs = [], closures = [], reasons = {}, afps = [], ctlOf = {};
  for (const r of rows.filter(x => (x.kind === 'gs' || x.kind === 'gdp') && x.link)) {
    const x = await detail(r, t => { const p = parseProgram(t);
      if (o.keepCodes) ctlOf[r.day + '#' + r.n] = p.airport || null;
      if (o.onProgram) o.onProgram(r, p, programCode(r, reduceProgram(r, p), o.keepCodes ? p.airport : null));
      return reduceProgram(r, p); }, 'program');
    if (!x) continue;
    const code = programCode(r, x, ctlOf[r.day + '#' + r.n]);
    advs.push({ kind: r.kind, code, day: r.day, t: sentTime(r.sent), period: x.p, category: x.c });
    programs.push({ x, code, key: r.kind + '|' + code + '|' + r.day });
  }
  const addClosure = (r, x) => { const f = x.f.slice(); if (!f.length && centerOfElement(r.element)) f.push(centerOfElement(r.element)); closures.push({ day: r.day, facilities: f, wx: x.wx }); };
  for (const r of rows.filter(x => x.kind === 'oceanic' && x.link)) {
    const x = await detail(r, t => { if (o.onOceanic) o.onOceanic(r, t); return reduceClosure(t); }, 'oceanic');
    if (x && x.n) addClosure(r, x);
  }
  // Reroutes / FCAs: the newest two versions of each, until one names its REASON; a page not read tries the next.
  for (const g of rerouteGroups(rows)) {
    if (!g.areas.some(a => ARTCC_IDS.indexOf(a) >= 0 || ARTCC_OCONUS.indexOf(a) >= 0)) continue;   // Canadian-only FCAs: no use
    for (const r of g.rows.filter(x => x.link).slice(0, 2)) {
      const x = await detail(r, t => ({ r: reasonWord(parseReroute(t).reason) }), 'reroute');
      if (x && x.r) { reasons[g.key] = x.r; break; }
    }
  }
  for (const g of closureGroups(rows)) {
    for (const r of g.rows.slice(0, 2)) { const x = await detail(r, reduceClosure, 'closure'); if (x && x.n) { addClosure(r, x); break; } }
  }
  for (const r of rows.filter(x => x.kind === 'afp' && x.link && !/PROPOSED/.test(x.title))) {
    const x = await detail(r, t => { const p = parseProgram(t);
      return { c: causeWord(p.category), p: parsePeriod(r.day, p.period), z: centerOfElement(r.element) || ((t.match(/\b(Z[A-Z]{2})\b/) || [])[1]) || null }; }, 'afp');
    if (x) afps.push({ kind: 'afp', code: String(r.element || '').split('/')[0].trim() || 'AFP' + r.n, center: x.z, day: r.day, t: sentTime(r.sent), period: x.p, category: x.c });
  }
  return { advs, programs, closures, reasons, afps };
}
// The one count rule: an airport program group is kind + airport + day; its cause is the most frequent among its
// advisories; the weather programs of a day are its groups with the cause WEATHER. Both views' North America day bar.
const faaStamp = () => L.stamp('faa-restrictions', { ids: ARTCC_IDS, oconus: ARTCC_OCONUS });
function programCauses(advs) {
  const cats = {};
  (advs || []).filter(a => a.kind === 'gs' || a.kind === 'gdp').forEach(a => { const k = a.kind + '|' + a.code + '|' + a.day, c = cats[k] || (cats[k] = {}); c[a.category] = (c[a.category] || 0) + 1; });
  const catOf = {}, wxByDay = {};
  Object.keys(cats).forEach(k => { catOf[k] = Object.keys(cats[k]).sort((a, b) => cats[k][b] - cats[k][a])[0];
    if (catOf[k] === 'WEATHER') { const d = k.split('|')[2]; wxByDay[d] = (wxByDay[d] || 0) + 1; } });
  return { catOf, wxByDay };
}

// The digest lines for the prompt: plain, short, the numbers a manager would quote.
function artccLines(a) {
  if (!a || !a.days || !a.days.length) return [];
  const L = [], n = a.days.length, nm = c => ARTCC_NAMES[c] || c, pl = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
  const hit = a.ids.filter(c => a.week[c] && a.week[c].days > 0);
  L.push('US WEATHER TRAFFIC RESTRICTIONS PER ARTCC — what the FAA Command Center issued for weather (ground stops, delay programs, airspace flow');
  L.push('programs, reroutes, SWAP, route closures), per en-route centre and day. Restrictions, not delay minutes; not a forecast.');
  const worst = a.days.slice().sort((x, y) => y.totals.programs - x.totals.programs || y.totals.centers - x.totals.centers)[0];
  const lead = hit.slice().sort((x, y) => a.week[y].days - a.week[x].days || a.week[y].programs - a.week[x].programs).slice(0, 3)
    .map(c => nm(c) + ' (' + c + ') ' + (a.week[c].days === n ? 'every day' : a.week[c].days + ' day' + (a.week[c].days > 1 ? 's' : '')));
  L.push('Weather traffic restrictions: ' + hit.length + ' of ' + a.ids.length + ' ARTCCs on ≥1 day' +
    (worst && worst.totals.programs ? '; worst day ' + fmtDay(worst.date) + ', ' + pl(worst.totals.programs, 'program') + ' at ' + pl(worst.totals.airports, 'airport') : '') +
    (lead.length ? '; ' + lead.join(', ') : '') + '.');
  const ap = (a.airports || []).filter(x => x.wxDays).slice(0, 6);
  if (ap.length) L.push('Airports with weather programs: ' + ap.map(x => x.faa + ' ' + x.wxDays + ' day' + (x.wxDays > 1 ? 's' : '') + (x.hours ? ' (' + x.hours + ' h)' : '')).join(', ') +
    (a.airports.filter(x => x.wxDays).length > ap.length ? ', … ' + a.airports.filter(x => x.wxDays).length + ' in all' : '') + '.');
  const exp = a.ids.filter(c => a.week[c].expectedOnlyDays >= 2).sort((x, y) => a.week[y].expectedOnlyDays - a.week[x].expectedOnlyDays).slice(0, 3);
  if (exp.length) L.push('Expected, not issued: the Operations Plans listed thunderstorms for ' + exp.map(c => nm(c) + ' on ' + a.week[c].expectedOnlyDays + ' days').join(', ') +
    ' without any weather restriction there — keep "listed" apart from "restricted".');
  L.push('Canada: no public data (NAV CANADA terms forbid reuse) — that is not the same as no restrictions.');
  return L;
}

//   fetchFaa({ from, to, week })   nowMs, pauseMs: tests only (the golden tests, scripts/golden/)
async function fetchFaa({ from, to, week, nowMs, pauseMs }) {
  const t0 = Date.now(); REQUESTS = 0; pauseNow = pauseMs != null ? pauseMs : PAUSE_MS;
  const today = nowMs == null ? U.today() : new Date(nowMs).toISOString().slice(0, 10), oldest = U.addDays(today, -14);
  if (from < oldest) throw new Error('the advisories database keeps 14 days; ' + from + ' is older than ' + oldest + ' — the week would be incomplete');
  const notes = [], rows = [], days = [];
  for (let d = from; d <= to && d <= today; d = U.addDays(d, 1)) {
    const list = parseList(await get(HOST + '/adv/adv_list?date=' + d + '&' + QUERY));
    // The Command Center issues dozens of advisories a day. An empty past day means the page
    // changed, not that the US had a quiet day.
    if (!list.length && d < today) throw new Error('no advisories parsed for ' + d + ' — the list page changed');
    days.push({ date: d, advisories: list.length });
    list.forEach(r => { r.day = d; rows.push(r); });
  }
  if (to > today) notes.push('the window runs to ' + to + '; advisories are read up to today, ' + today);

  // Details: every ground stop and ground delay program advisory and every oceanic closure (both must be read: an
  // unreadable page fails the snapshot), then reroute reasons, Gulf closures and airspace flow programs within the time
  // budget (what is left counts as unverified) — one reader with the relay (readAdvisories). Then the Operations Plans.
  const softS = (U.MAX_SECONDS['fetch-faa'] || 480) - 90, deadline = t0 + softS * 1000;
  const programs = {}, oceanic = [], exNotes = [], exReq = { reroute: 0, closure: 0, afp: 0, skipped: 0 };
  const EXTRA_NOTE = { reroute: r => 'reroute ' + ((parseRerouteTitle(r.title) || {}).name || r.n) + ' of ' + r.day, closure: r => 'Gulf route closure of ' + r.day,
                       afp: r => 'airspace flow program ' + r.n + ' of ' + r.day };
  const detail = async (r, reduce, phase) => {
    if (phase === 'program' || phase === 'oceanic') return reduce(adviceText(await get(r.link)));
    if (Date.now() > deadline) { exReq.skipped++; return null; }
    try { const x = reduce(adviceText(await get(r.link))); exReq[phase]++; return x; }
    catch (e) { exNotes.push(EXTRA_NOTE[phase](r) + ' unreadable: ' + e.message); return null; }
  };
  const rd = await readAdvisories(rows, detail, { keepCodes: true,
    onProgram: (r, p, airport) => {
      const k = r.kind + '|' + airport + '|' + r.day;
      const g = programs[k] || (programs[k] = { type: r.kind === 'gs' ? 'GS' : 'GDP', airport, date: r.day, advisories: 0,
        categories: {}, conditions: [], maxDelay: 0, avgDelay: 0, totalDelay: 0, comments: [], url: r.link });
      g.advisories++;
      g.categories[p.category] = (g.categories[p.category] || 0) + 1;
      if (p.condition && g.conditions.indexOf(p.condition) < 0) g.conditions.push(p.condition);
      g.maxDelay = Math.max(g.maxDelay, p.maxDelay || 0); g.avgDelay = Math.max(g.avgDelay, p.avgDelay || 0);
      g.totalDelay = Math.max(g.totalDelay, p.totalDelay || 0);
      if (p.comment && g.comments.length < 6 && g.comments.indexOf(p.comment) < 0) g.comments.push(p.comment);
    },
    onOceanic: (r, ot) => { const o = parseOceanic(ot);
      if (o && !oceanic.some(x => x.date === r.day && x.routes === o.routes && x.reason === o.reason)) oceanic.push(Object.assign({ date: r.day, facility: r.element }, o)); } });
  if (exReq.skipped) exNotes.push('time budget reached: ' + exReq.skipped + ' reroute/closure/AFP detail page(s) not read — their reasons count as unverified');
  const advs = rd.advs, causes = programCauses(advs);
  const progs = Object.values(programs).map(g => Object.assign(g, {
    category: Object.keys(g.categories).sort((a, b) => g.categories[b] - g.categories[a])[0] || 'UNSPECIFIED',
    name: AIRPORTS[g.airport] || g.airport }));
  if (rows.some(x => x.kind === 'gs' || x.kind === 'gdp') && !progs.length) throw new Error('ground stop / delay program pages parsed to nothing — the advisory page changed');
  if (progs.length && progs.every(g => g.category === 'UNSPECIFIED')) notes.push('no IMPACTING CONDITION parsed on any program — causes are missing');

  // The first plan of a day is the plan for the day, the last one how it ended: both are read for
  // their weather constraints; the last one also for staffing and the narrative, as before.
  const staffing = []; let outlook = null; const wxPlan = {};
  const lastPlan = {}, firstPlan = {};
  rows.filter(x => x.kind === 'opsPlan' && x.link).forEach(r => {
    if (!lastPlan[r.day] || r.n > lastPlan[r.day].n) lastPlan[r.day] = r;
    if (!firstPlan[r.day] || r.n < firstPlan[r.day].n) firstPlan[r.day] = r;
  });
  const addWx = (day, op) => { const w = wxPlan[day] || (wxPlan[day] = { terminal: {}, enroute: {} });
    op.terminalWx.forEach(c => { const k = c.what.slice(0, 60); w.terminal[k] = Array.from(new Set((w.terminal[k] || []).concat(c.where))); });
    op.enrouteWx.forEach(c => { const k = c.what.slice(0, 60); w.enroute[k] = Array.from(new Set((w.enroute[k] || []).concat(c.where))); }); };
  for (const day of Object.keys(lastPlan).sort()) {
    const op = parseOpsPlan(adviceText(await get(lastPlan[day].link)));
    addWx(day, op);
    if (op.staffing) staffing.push({ date: day, text: op.staffing.replace(/\s+/g, ' ').slice(0, 300) });
    outlook = { date: day, narrative: op.narrative.slice(0, 600), url: lastPlan[day].link };
    if (firstPlan[day] && firstPlan[day].n !== lastPlan[day].n) {
      try { addWx(day, parseOpsPlan(adviceText(await get(firstPlan[day].link)))); }
      catch (e) { notes.push('first Operations Plan of ' + day + ' unreadable: ' + e.message); }
    }
  }

  // ---- North Atlantic: the eastbound tracks of each day, and the run day's full message ----
  const natEast = [];
  const natRows = {}; rows.filter(x => x.kind === 'nat' && x.link).forEach(r => { if (!natRows[r.day] || r.n > natRows[r.day].n) natRows[r.day] = r; });
  for (const day of Object.keys(natRows).sort()) {
    try {
      const a = parseNatAdvisory(adviceText(await get(natRows[day].link)));
      if (a.tracks.length) natEast.push(Object.assign({ date: day, url: natRows[day].link }, a));
      else notes.push('NAT advisory of ' + day + ' parsed to no tracks');
    } catch (e) { notes.push('NAT advisory of ' + day + ' unreadable: ' + e.message); }
  }
  const natLive = await fetchNatLive(notes);

  // ---- weather by day: WEATHER programs + the plans' weather constraints ----
  const wxDays = [];
  for (let d = from; d <= to && d <= today; d = U.addDays(d, 1)) {
    const wp = progs.filter(g => g.date === d && g.category === 'WEATHER');
    const w = wxPlan[d] || { terminal: {}, enroute: {} };
    wxDays.push({ date: d, programs: causes.wxByDay[d] || 0, airports: Array.from(new Set(wp.map(g => g.airport))),
      conditions: Array.from(new Set([].concat.apply([], wp.map(g => g.conditions)))).filter(c => /^WEATHER/.test(c)).slice(0, 6),
      maxDelay: wp.reduce((m, g) => Math.max(m, g.maxDelay), 0),
      terminal: Object.keys(w.terminal).map(k => ({ what: k, where: w.terminal[k] })),
      enroute: Object.keys(w.enroute).map(k => ({ what: k, where: w.enroute[k] })) });
  }

  // ---- weather traffic restrictions per ARTCC and airport (round 4) ----
  let artcc = null;
  try {
    artcc = aggregateArtcc({ dates: days.map(d => d.date), rows, advs: advs.concat(rd.afps), catOf: causes.catOf, reasons: rd.reasons,
      closures: rd.closures, wxPlan });
    artcc.notes = exNotes.concat(artcc.notes);
    artcc = Object.assign({ source: 'FAA ATCSCC Advisories Database', url: FORM, licence: 'US Government work, public domain (17 U.S.C. § 105)',
      attribution: 'Source: FAA Air Traffic Control System Command Center advisories (public domain). Not for operational use.',
      positions: 'OurAirports airports.csv (public domain), via the project airport list and the table in fetch-faa.js' }, artcc,
      { requests: Object.assign({ extra: exReq.reroute + exReq.closure + exReq.afp }, exReq), producer: faaStamp() });
  } catch (e) { notes.push('ARTCC weather block failed: ' + e.message); }

  // ---- aggregates ----
  const count = k => rows.filter(r => r.kind === k).length;
  const byCategory = {}; progs.forEach(g => { byCategory[g.category] = (byCategory[g.category] || 0) + 1; });
  const ap = {};
  progs.forEach(g => { const a = ap[g.airport] || (ap[g.airport] = { airport: g.airport, name: g.name, programs: 0, gs: 0, gdp: 0, categories: {}, maxDelay: 0 });
    a.programs++; a[g.type === 'GS' ? 'gs' : 'gdp']++; a.categories[g.category] = (a.categories[g.category] || 0) + 1; a.maxDelay = Math.max(a.maxDelay, g.maxDelay); });
  // An event: one cause, one day, three or more airports. Weather does this routinely; an
  // equipment, staffing or security event that does it is the kind of thing that was missed in W39.
  const cl = {};
  progs.forEach(g => { const k = g.date + '|' + g.category; const c = cl[k] || (cl[k] = { date: g.date, category: g.category, airports: [], programs: 0, maxDelay: 0, conditions: [], comments: [] });
    if (c.airports.indexOf(g.airport) < 0) c.airports.push(g.airport); c.programs++; c.maxDelay = Math.max(c.maxDelay, g.maxDelay);
    g.conditions.forEach(x => { if (c.conditions.indexOf(x) < 0) c.conditions.push(x); });
    g.comments.forEach(x => { if (c.comments.indexOf(x) < 0) c.comments.push(x); }); });
  // Lead with the comment that explains the cause. In W39 the first comment on the New York outage
  // was "revised due to rate improvement"; the one that said what happened was "airspace
  // sterilization to initiate equipment restart".
  const CAUSE_WORDS = { EQUIPMENT: /EQUIP|OUTAGE|RADAR|STERILI|RESTART|FAILURE|POWER|FREQ/i, STAFFING: /STAFF/i,
    SECURITY: /SECUR|VIP|EVACU|THREAT/i, WEATHER: /THUNDER|WIND|CEILING|FOG|SNOW|STORM|VIS/i, VOLUME: /VOLUME|DEMAND/i, 'RWY-TAXI': /RWY|RUNWAY|CONSTRUCT|TAXI/i };
  Object.values(cl).forEach(c => { const re = CAUSE_WORDS[c.category];
    c.comments.sort((a, b) => (re && re.test(b) ? 1 : 0) - (re && re.test(a) ? 1 : 0)); c.comments = c.comments.slice(0, 3); });
  const severity = c => (ROUTINE.has(c.category) ? 0 : 1) * 100000 + c.airports.length * 1000 + c.maxDelay;
  const clusters = Object.values(cl).filter(c => c.airports.length >= 3).sort((a, b) => severity(b) - severity(a));
  const volcanoes = {}; rows.filter(r => r.kind === 'volcanic').forEach(r => { const n = (/BULLETIN\s*-\s*(.+)$/i.exec(r.title) || [, 'unnamed'])[1].trim(); volcanoes[n] = (volcanoes[n] || 0) + 1; });

  // ---- did last week's briefing miss last week's biggest US event? ----
  const prevWeek = U.isoWeekOf(U.addDays(from, -7));
  const prevSnap = U.readSnapshot('faa', prevWeek);
  let prevBlob = null; try { prevBlob = fs.readFileSync(path.join(U.ROOT, 'data', 'week-' + prevWeek + '.json'), 'utf8'); } catch (e) { /* none */ }
  const prevWeekMissed = [];
  if (prevSnap && prevBlob) {
    const cands = (prevSnap.clusters || []).filter(c => !ROUTINE.has(c.category))
      .concat((prevSnap.largest || []).filter(g => g.maxDelay >= 600 && !ROUTINE.has(g.category)).map(g => ({ date: g.date, category: g.category, airports: [g.airport], maxDelay: g.maxDelay, conditions: g.conditions, comments: g.comments })));
    cands.forEach(c => {
      if (c.airports.some(a => mentioned(prevBlob, a))) return;
      if (prevWeekMissed.some(m => m.date === c.date && m.category === c.category)) return;
      prevWeekMissed.push({ week: prevWeek, date: c.date, category: c.category, airports: c.airports, maxDelay: c.maxDelay,
                            conditions: c.conditions, comments: c.comments });
    });
  } else if (!prevSnap) notes.push('no ' + prevWeek + ' snapshot — the missed-last-week check needs one and starts next week');

  const largest = progs.slice().sort((a, b) => b.maxDelay - a.maxDelay).slice(0, 10);
  return {
    source: { name: 'FAA ATCSCC: Advisories Database', url: FORM },
    days, airports: AIRPORTS,
    totals: { advisories: rows.length, gs: count('gs'), gsCancel: count('gsCancel'), gdp: count('gdp'), gdpProposed: count('gdpProposed'),
              gdpCancel: count('gdpCancel'), afp: count('afp'), ctop: count('ctop'), route: count('route'), swap: count('swap'),
              oceanic: count('oceanic'), nat: count('nat'), opsPlan: count('opsPlan'), volcanic: count('volcanic') },
    programs: { gsAirportDays: progs.filter(g => g.type === 'GS').length, gdpAirportDays: progs.filter(g => g.type === 'GDP').length, byCategory },
    byAirport: Object.values(ap).sort((a, b) => b.programs - a.programs || b.maxDelay - a.maxDelay).slice(0, 12),
    largest, clusters: clusters.slice(0, 8), oceanic: oceanic.slice(0, 20), volcanoes, staffing, outlook,
    weather: { days: wxDays, programs: progs.filter(g => g.category === 'WEATHER').length },
    nat: { eastbound: natEast, live: natLive },
    artcc: artcc ? Object.assign(artcc, { run: { requests: REQUESTS + 1, seconds: Math.round((Date.now() - t0) / 1000) } }) : null,
    prevWeekMissed, notes,
    summary: [rows.length + ' advisories · ' + progs.filter(g => g.type === 'GS').length + ' ground-stop and ' + progs.filter(g => g.type === 'GDP').length +
              ' delay-program airport-days · ' + clusters.length + ' multi-airport event(s)' + (prevWeekMissed.length ? ' · ' + prevWeekMissed.length + ' missed last week' : ''),
              'ARTCC weather: ' + (artcc ? artcc.ids.filter(c => artcc.week[c].days).length + ' of ' + artcc.ids.length + ' ARTCCs on ≥1 day, ' +
                artcc.airports.filter(a => a.wxDays).length + ' airports, ' + artcc.requests.extra + ' extra pages' : 'unavailable') +
                ' · ' + (REQUESTS + 1) + ' requests in ' + Math.round((Date.now() - t0) / 1000) + ' s',
              'NAT: eastbound tracks on ' + natEast.length + ' day(s)' + (natLive ? ' · run-day message: ' + natLive.sets.map(x => x.direction + ' ' + x.tracks.length + ' tracks' + (x.tmi ? ' TMI ' + x.tmi : '')).join(', ') : ' · run-day message unavailable')],
  };
}

// ---- the public weather relay: weather restrictions of the days so far (2026-10-12) -----------------------------
// For the relay's "This week" map (tools/wx-relay): the ARTCC layer of the weekly snapshot (aggregateArtcc, the same
// requests and parsers) for a window of days up to today, read four times a day. The public file must not carry a list
// of airport codes, so the result keeps per day and ARTCC the restriction counts, and per airport only its position,
// ARTCC and weather-program counts and hours — no code, no name. Positions: the airport table above (empty in the
// relay's copy), else OurAirports' airports.csv (public domain), downloaded only when an airport is not placed yet and
// held in memory. Not read: Operations Plans ("expected"), NAT advisories, delays and comments, the previous week.
// Incremental: cache.prev { kind: 'faa', version, adv: { 'YYYY-MM-DD#<n>': … } } holds what the detail page of each
// advisory already read said (an issued advisory does not change): ground stops / delay programs { c: cause, p: [from,
// to] ms | null, a: index of the control element in the list's element (absent = first), q: [lat, lon] | 0 (no
// position) }, reroutes { r: 'WEATHER' | 'OTHER' | null }, closures { f: [ARTCC], wx, n: 1 = a closure was read },
// airspace flow programs { c, p, z: ARTCC }. Keys are day + advisory number and no value holds an airport code, so the
// cache can be published. The list page of each day is read every run (one request a day). Past the soft deadline no
// detail page is requested: those days are marked incomplete and the next run goes on from the cache.
//   fetchFaaObserved({ from, to, cache, softDeadlineS, nowMs, pauseMs, positionsUrl })   nowMs, pauseMs: tests only
const FAA_CACHE_VERSION = 1;
const OURAIRPORTS_CSV = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RELAY_CANADA_NOTE = 'NAV CANADA publishes no reusable delay or flow data (terms: personal, non-commercial use only). Canadian FIRs are "no public data", not "no restrictions".';

// OurAirports airports.csv -> { code: { lat, lon } } for the wanted codes: ICAO ident first, then the FAA identifier
// (local_code) of the US and its territories, then the IATA code; a larger airport wins a tie. Positions to 0.01°.
function ourAirportsPositions(csv, wanted) {
  const want = new Set(wanted || []), best = {};
  if (!want.size) return {};
  const split = l => { const r = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { r.push(cur); cur = ''; } else cur += ch; }
    r.push(cur.replace(/\r$/, '')); return r; };
  const lines = String(csv || '').split('\n'), h = split(lines[0] || ''), I = {};
  ['ident', 'type', 'latitude_deg', 'longitude_deg', 'iso_country', 'iata_code', 'local_code'].forEach(k => { I[k] = h.indexOf(k); });
  if (Object.values(I).some(i => i < 0)) throw new Error('OurAirports airports.csv: the header changed');
  const SIZE = { large_airport: 3, medium_airport: 2, small_airport: 1 }, US = /^(US|PR|VI|GU|AS|MP)$/;
  for (let n = 1; n < lines.length; n++) {
    const l = lines[n];
    if (!l) continue;
    const r = split(l), lat = +r[I.latitude_deg], lon = +r[I.longitude_deg];
    if (!isFinite(lat) || !isFinite(lon) || r[I.type] === 'closed') continue;
    const cand = [[r[I.ident], 3]].concat(US.test(r[I.iso_country]) ? [[r[I.local_code], 2]] : [], [[r[I.iata_code], 1]]);
    cand.forEach(([code, how]) => {
      if (!code || !want.has(code)) return;
      const rank = how * 10 + (SIZE[r[I.type]] || 0);
      if (!best[code] || rank > best[code].rank) best[code] = { rank, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
    });
  }
  const out = {};
  Object.keys(best).forEach(c => { out[c] = { lat: best[c].lat, lon: best[c].lon }; });
  return out;
}
function readFaaCache(c) {
  const fresh = why => ({ adv: {}, dropped: why });
  if (c == null) return fresh(null);
  if (typeof c !== 'object' || c.kind !== 'faa' || c.version !== FAA_CACHE_VERSION) return fresh('not an FAA cache of version ' + FAA_CACHE_VERSION);
  const adv = {};
  for (const [k, v] of Object.entries(c.adv || {})) {
    if (!/^\d{4}-\d\d-\d\d#\d+$/.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) return fresh('entry ' + k + ' unreadable');
    adv[k] = v;
  }
  return { adv, dropped: null };
}

async function fetchFaaObserved({ from, to, cache, softDeadlineS, nowMs: nowArg, pauseMs, positionsUrl }) {
  const t0 = Date.now(), nowMs = nowArg == null ? Date.now() : nowArg, today = new Date(nowMs).toISOString().slice(0, 10);
  const softS = softDeadlineS != null ? softDeadlineS : 120, pause = pauseMs != null ? pauseMs : PAUSE_MS;
  const late = () => Date.now() - t0 > softS * 1000;
  if (from < U.addDays(today, -14)) throw new Error('the advisories database keeps 14 days; ' + from + ' is older than ' + U.addDays(today, -14));
  const dates = []; for (let d = from; d <= to && d <= today; d = U.addDays(d, 1)) dates.push(d);
  if (!dates.length) throw new Error('no day of ' + from + ' .. ' + to + ' has started');
  const prev = cache ? readFaaCache(cache.prev) : { adv: {}, dropped: null };
  const A = {}, notes = [], rows = [], incomplete = new Set(), n = { lists: 0, details: 0, reused: 0, skipped: 0, positions: 0 };
  let blocked = null;
  // One request: counted, paced; after 403/429 nothing more is sent to the host (the relay's wrapper also stops it).
  const getP = async url => {
    if (blocked) throw new Error(blocked);
    try { const t = await U.getText(url, { accept: 'text/html', timeoutMs: 30000, retries: 2 }); await U.sleep(pause); return t; }
    catch (e) { const b = /HTTP (403|429)\b/.exec(String((e && e.message) || e)); if (b) blocked = 'www.fly.faa.gov answered ' + b[0] + ' — not asked again'; throw e; }
  };
  const msg = e => String((e && e.message) || e).replace(/^https?:\/\/\S+: /, '');
  // The list of each day, newest first (today matters most when the time budget runs short).
  for (const d of dates.slice().reverse()) {
    try {
      const list = parseList(await getP(HOST + '/adv/adv_list?date=' + d + '&' + QUERY)); n.lists++;
      if (!list.length && d < today) { incomplete.add(d); notes.push('no advisories parsed for ' + d + ' — the list page may have changed'); }
      list.forEach(r => { r.day = d; rows.push(r); });
    } catch (e) { incomplete.add(d); notes.push('advisory list of ' + d + ' not read: ' + msg(e)); }
  }
  if (!n.lists) throw new Error('no advisory list read: ' + notes.slice(0, 2).join('; '));
  rows.sort((a, b) => (a.day === b.day ? a.n - b.n : (a.day < b.day ? 1 : -1)));
  // A detail page: from the cache, else read and reduced to what the layer needs (nothing past the soft deadline).
  const detail = async (r, reduce) => {          // the phase (third argument) does not matter here: every page is cached
    const k = r.day + '#' + r.n;
    if (A[k]) return A[k];
    if (prev.adv[k]) { n.reused++; return (A[k] = prev.adv[k]); }
    if (blocked || late()) { n.skipped++; incomplete.add(r.day); return null; }
    try { const t = adviceText(await getP(r.link)); n.details++; return (A[k] = reduce(t)); }
    catch (e) { incomplete.add(r.day); if (notes.length < 12) notes.push('advisory ' + r.n + ' of ' + r.day + ' unreadable: ' + msg(e)); return null; }
  };
  const rd = await readAdvisories(rows, detail);
  const advs = rd.advs, gsRows = rd.programs, afps = rd.afps;
  if (n.skipped) notes.push('time budget reached: ' + n.skipped + ' advisory page(s) not read yet — the next run reads them; those days are marked incomplete');
  if (blocked) notes.push(blocked);
  const { catOf, wxByDay: wxProg } = programCauses(advs);
  // Positions: the table, then what an advisory of the same airport already resolved, then OurAirports (one download).
  // Only airports with a weather program are drawn, so only they are looked up; q: 0 = looked up, no position.
  const posOf = {}, noPos = new Set();
  gsRows.forEach(({ code }) => { const p = airportPos(code); if (p && isFinite(p.lat) && isFinite(p.lon)) posOf[code] = { lat: p.lat, lon: p.lon, artcc: p.artcc || null }; });
  gsRows.forEach(({ x, code }) => { if (posOf[code]) return; if (Array.isArray(x.q)) posOf[code] = { lat: x.q[0], lon: x.q[1], artcc: null }; else if (x.q === 0) noPos.add(code); });
  const need = Array.from(new Set(gsRows.filter(z => !posOf[z.code] && !noPos.has(z.code) && catOf[z.key] === 'WEATHER').map(z => z.code)));
  if (need.length && positionsUrl && !late()) {
    try { const P = ourAirportsPositions(await U.getText(positionsUrl, { accept: 'text/csv', timeoutMs: 60000, retries: 1 }), need); n.positions++;
      need.forEach(c => { if (P[c]) posOf[c] = { lat: P[c].lat, lon: P[c].lon, artcc: null }; else noPos.add(c); }); }
    catch (e) { notes.push('airport positions not read (OurAirports): ' + msg(e)); }
  } else if (need.length && !positionsUrl) need.forEach(c => noPos.add(c));
  gsRows.forEach(({ x, code }) => { if (posOf[code]) x.q = [posOf[code].lat, posOf[code].lon]; else if (noPos.has(code)) x.q = 0; });
  const art = aggregateArtcc({ dates, rows, advs: advs.concat(afps), catOf, reasons: rd.reasons, closures: rd.closures, wxPlan: {}, pos: c => posOf[c] || null });
  // The public shape: no airport code or name anywhere.
  const complete = d => d < today && !incomplete.has(d);
  const days = art.days.map(d => { const centers = {};
    Object.keys(d.centers).forEach(c => { const o = Object.assign({}, d.centers[c]); delete o.airports; centers[c] = o; });
    return { date: d.date, complete: complete(d.date), programs: wxProg[d.date] || 0, centers, totals: d.totals }; });
  let unplaced = 0;
  const airports = art.airports.filter(a => a.wxDays > 0).filter(a => (a.lat == null || a.lon == null ? (unplaced++, false) : true)).map(a => {
    const dd = {}; Object.keys(a.days).forEach(d => { const x = a.days[d]; if (x.wx) dd[d] = { gs: x.gs, gdp: x.gdp, afp: x.afp, wx: true, hours: x.hours }; });
    return { lat: a.lat, lon: a.lon, artcc: a.artcc || null, wxDays: a.wxDays, hours: a.hours, days: dd }; });
  if (unplaced) notes.push(unplaced + ' airport(s) with weather programs have no position and are not in the list');
  const unv = days.reduce((m, d) => m + Object.keys(d.centers).reduce((k, c) => k + (d.centers[c].unverified || 0), 0), 0);
  if (unv) notes.push(unv + ' reroute/FCA–ARTCC-day(s) with no REASON read yet: counted as unverified, not as weather');
  if (cache) {
    const adv = {};
    Object.keys(prev.adv).concat(Object.keys(A)).forEach(k => { if (U.inRange(k.slice(0, 10), from, to)) adv[k] = A[k] || prev.adv[k]; });
    cache.next = { kind: 'faa', version: FAA_CACHE_VERSION, adv };
    cache.info = { reused: n.reused, fetched: n.lists + n.details + n.positions, dropped: prev.dropped };
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  return { source: { name: 'FAA ATCSCC: Advisories Database', url: FORM }, licence: 'US Government work, public domain (17 U.S.C. § 105)',
    attribution: 'Source: FAA Air Traffic Control System Command Center advisories (public domain). Not for operational use.',
    positions: positionsUrl ? 'OurAirports airports.csv (public domain), ' + positionsUrl : 'the airport table in fetch-faa.js',
    scope: 'weather restrictions only: per day and ARTCC, and per airport its position (no airport codes or names)',
    ids: ARTCC_IDS.slice(), oconus: ARTCC_OCONUS.slice(), canada: 'no public data', canadaNote: RELAY_CANADA_NOTE,
    days, airports, weather: { days: days.map(d => ({ date: d.date, programs: d.programs })) }, notes, producer: faaStamp(),
    requests: n, seconds, summary: [from + ' .. ' + to + ' · ' + rows.length + ' advisories · ' + Object.values(wxProg).reduce((a, b) => a + b, 0) + ' weather programs · ' +
      airports.length + ' airports placed · ' + (n.lists + n.details + n.positions) + ' requests (' + n.reused + ' pages from the cache) · ' + seconds + ' s'] };
}

// ---- digest ------------------------------------------------------------------
const CAT = { WEATHER: 'weather', EQUIPMENT: 'equipment outage', 'RWY-TAXI': 'runway/taxiway', VOLUME: 'volume', STAFFING: 'ATC staffing', SECURITY: 'security', OTHER: 'other', UNSPECIFIED: 'unspecified' };
const fmtDay = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hm = m => (m >= 120 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : m + ' min');

function digest(s) {
  const L = [], A = s.airports || AIRPORTS, an = a => a + (A[a] ? ' (' + A[a] + ')' : '');
  const t = s.totals, p = s.programs;
  L.push('US FLOW MANAGEMENT — FAA Command Center advisories for ' + s.window.from + ' .. ' + s.window.to + ', read before this run (a retrieval, not a judgement)');
  L.push('');
  L.push(t.advisories + ' advisories. Ground stops at ' + p.gsAirportDays + ' airport-days, ground delay programs at ' + p.gdpAirportDays +
         ' (counted per airport and day, so extensions and revisions do not inflate them).');
  L.push('Programs by cause: ' + Object.keys(p.byCategory).sort((a, b) => p.byCategory[b] - p.byCategory[a]).map(c => p.byCategory[c] + ' ' + (CAT[c] || c.toLowerCase())).join(', ') + '.');
  if (s.clusters.length) {
    L.push('');
    L.push('EVENTS — one cause, one day, three or more airports (equipment, staffing, security first; weather, volume, construction after):');
    s.clusters.forEach(c => L.push('  ' + fmtDay(c.date) + '  ' + (CAT[c.category] || c.category) + ' at ' + c.airports.join(', ') +
      ' — ' + c.programs + ' programs, longest delay ' + hm(c.maxDelay) + (c.comments.length ? ' — "' + c.comments[0].toLowerCase() + '"' : '')));
  }
  L.push('');
  L.push('LONGEST DELAYS:');
  s.largest.slice(0, 6).forEach(g => L.push('  ' + fmtDay(g.date) + '  ' + g.type.padEnd(3) + ' ' + an(g.airport).padEnd(26) + ' ' + (g.conditions[0] || g.category).toLowerCase().padEnd(26) +
    ' max ' + hm(g.maxDelay) + (g.avgDelay ? ', average ' + g.avgDelay + ' min' : '')));
  L.push('MOST AFFECTED AIRPORTS: ' + s.byAirport.slice(0, 8).map(a => a.airport + ' ' + a.programs).join(', ') + ' (program-days).');
  if (s.oceanic.length) L.push('WEST ATLANTIC ROUTE CLOSURES (WATRS/Caribbean routes under New York or Miami Oceanic — NOT the North Atlantic tracks): ' +
    t.oceanic + ' advisories — ' + s.oceanic.slice(0, 5).map(o => fmtDay(o.date) + ' ' + o.routes + ' (' + o.reason + ')').join('; ') + '.');
  const wx = (s.weather && s.weather.days) || [];
  if (wx.length) {
    L.push('');
    L.push('US WEATHER BY DAY — weather programs, and the weather constraints in the day\'s Operations Plans:');
    wx.forEach(d => {
      const parts = [];
      if (d.programs) parts.push(d.programs + ' weather program(s) at ' + d.airports.join(', ') + (d.conditions.length ? ' (' + d.conditions.slice(0, 3).map(x => x.toLowerCase()).join('; ') + ')' : '') + (d.maxDelay ? ', up to ' + hm(d.maxDelay) : ''));
      d.terminal.slice(0, 3).forEach(c => parts.push('airports ' + c.where.join('/') + ': ' + c.what.toLowerCase()));
      d.enroute.slice(0, 2).forEach(c => parts.push('en route ' + c.where.join('/') + ': ' + c.what.toLowerCase()));
      L.push('  ' + fmtDay(d.date) + '  ' + (parts.length ? parts.join(' · ') : 'no weather constraint reported'));
    });
  }
  if (s.artcc) { const al = artccLines(s.artcc); if (al.length) { L.push(''); al.forEach(l => L.push(l)); } }
  const nat = s.nat || {};
  if ((nat.eastbound && nat.eastbound.length) || (nat.live && nat.live.sets && nat.live.sets.length)) {
    L.push('');
    L.push('NORTH ATLANTIC TRACKS (organised track system)');
    (nat.eastbound || []).forEach(e => L.push('  ' + fmtDay(e.date) + ' eastbound ' + e.tracks.length + ' tracks ' + e.tracks[0].letter + '–' + e.tracks[e.tracks.length - 1].letter +
      ', ocean entry north→south ' + e.tracks.map(x => x.entry || '?').join(' ') + (e.unavailable.length ? ' · closed: ' + e.unavailable.join(', ') : '')));
    const lastE = (nat.eastbound || []).slice(-1)[0];
    if (lastE && lastE.bulletin) L.push('  FAA advisory cites NAT OPS Bulletin ' + lastE.bulletin + '.');
    ((nat.live && nat.live.sets) || []).forEach(x => L.push('  Run day ' + x.direction + ' (' + String(x.from).slice(0, 16).replace('T', ' ') + 'Z, TMI ' + (x.tmi || '?') + '): ' + x.tracks.length +
      ' tracks, at 30W from ' + x.north + 'N to ' + x.south + 'N' + (x.splits.length ? ' · split: ' + x.splits.join('; ') : '') + (x.remarks.length ? ' · remarks: ' + x.remarks.join(' | ') : '')));
    L.push('  Eastbound tracks are lettered from the north (Z southernmost). History is the 14 days the FAA keeps; the full');
    L.push('  message with coordinates exists only for the run day.');
  }
  const v = Object.keys(s.volcanoes || {});
  if (v.length) L.push('VOLCANIC ASH BULLETINS: ' + v.map(n => n.toLowerCase() + ' ' + s.volcanoes[n]).join(', ') + '.');
  if (s.staffing.length) L.push('STAFFING TRIGGERS (Operations Plan): ' + s.staffing.map(x => fmtDay(x.date) + ': ' + x.text).join(' | '));
  if (s.outlook && s.outlook.narrative) L.push('LATEST OPERATIONS PLAN (' + fmtDay(s.outlook.date) + '): ' + s.outlook.narrative);
  if (s.prevWeekMissed && s.prevWeekMissed.length) {
    L.push('');
    L.push('MISSED LAST WEEK — the ' + s.prevWeekMissed[0].week + ' briefing did not mention:');
    s.prevWeekMissed.forEach(m => L.push('  ' + fmtDay(m.date) + '  ' + (CAT[m.category] || m.category) + ' at ' + m.airports.map(an).join(', ') +
      ', longest delay ' + hm(m.maxDelay) + (m.comments && m.comments[0] ? ' — "' + m.comments[0].toLowerCase() + '"' : '')));
    L.push('  Report each one in `corrections` as an addition to that week: affects = "' + s.prevWeekMissed[0].week +
           ', airspace / US operations — omitted", whatWasWrong = that the event was not reported, whatIsCorrect = what');
    L.push('  happened (date, airports, cause, delay), howItHappened = the briefing had no US flow source that week,');
    L.push('  consequence = the US flow block now arrives before every run and checks the previous week. State only what the');
    L.push('  advisories say; do not attribute a cause the FAA did not give.');
  }
  L.push('');
  if (s.notes && s.notes.length) { L.push('FETCH NOTES: ' + s.notes.join('; ') + '.'); L.push(''); }
  L.push('HOW TO USE THIS BLOCK');
  L.push('- Weather is the most frequent cause. One weather program is not news, but the week\'s weather pattern is: which');
  L.push('  days, which hubs, which conditions (thunderstorms, low ceilings, wind). Use US WEATHER BY DAY where it explains');
  L.push('  delays or a disruption, together with the weather blocks. Volume and runway construction are routine.');
  L.push('- An EVENT with any other cause (equipment, staffing, security), or a program at a large hub with a');
  L.push('  delay of several hours, is a candidate for the airspace narrative, the management snapshot or a Topic Card.');
  L.push('- North Atlantic tracks and West Atlantic closures matter for long-haul operations: report a split or');
  L.push('  unusually northern/southern system, closed entry points and NAT procedure changes where they matter. Volcanic ash');
  L.push('  touches Central and South America routes.');
  L.push('- Cite as { "name": "FAA ATCSCC: Advisories Database", "url": "' + s.source.url + '", "kind": "news" }, or a single');
  L.push('  advisory by its own adv_otherdis URL. US government data, public domain.');
  return L.join('\n');
}

module.exports = { classify, parseList, adviceText, parseProgram, parseOceanic, parseOpsPlan, parseNatAdvisory, parseNatMessage, parseCoord, mentioned, digest,
  // round 4: ARTCC weather block
  advTime, parsePeriod, sentTime, parseRerouteTitle, parseReroute, parseClosure, programWindows, windowPortions, rerouteGroups, closureGroups,
  aggregateArtcc, artccLines, airportPos, ARTCC_IDS,
  // 2026-10-12: the public weather relay's days so far
  fetchFaaObserved, ourAirportsPositions, readFaaCache, OURAIRPORTS_CSV,
  // 2026-10-20: the weekly producer itself, for the golden tests (scripts/golden/)
  fetchFaa };
if (require.main === module) U.main('fetch-faa', 'faa', fetchFaa, digest);
