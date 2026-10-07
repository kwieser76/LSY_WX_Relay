#!/usr/bin/env node
// ---------------------------------------------------------------------------
// privacy-check.js
// Fails (exit 1) when a file meant for the public relay carries something that must stay private:
// an e-mail address, a local file path, or a list of airports with values attached (a "hub table").
// Every finding is printed with the file, the rule and the matched text.
//
//   node privacy-check.js <file|dir> [...]          check files (directories recursively, .git skipped)
//   node privacy-check.js --terms terms.json <...>  also check a list of extra private terms
//
// Built-in rules (always on):
//   email        any e-mail address except the GitHub noreply addresses the workflow commits with
//   local path   a user home folder (macOS, Linux, Windows) or a synced cloud-drive folder
//   hub arrays   in JSON: a "hubs" or "hubProb" array with content, or any array of objects that pairs an
//                airport code ("code"/"icao") with a position ("lat"/"lon")
// Extra terms (--terms, or privacy-terms.js next to this file when it exists; neither is published):
//   { words: [..] }            any hit fails
//   { names: [..] }            any hit fails (case-insensitive, whole words)
//   { soft: [..] }             reported; 3 or more different ones in one file fail (ambiguous words)
//   { icao: [..], iata: [..], places: [..] }
//                              reported; a JSON "icao"/"code" field holding one fails; 3 or more
//                              different ones in one file fail (a list, not a passing mention)
// No dependencies. Exported for relay.js: checkText(name, text, terms), checkJson(name, obj), loadTerms().
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');

const LIST_MIN = 3;
const NOREPLY = /^(\d+\+)?[\w.\-[\]]+@users\.noreply\.github\.com$|^noreply@github\.com$/i;
const EMAIL = /[A-Za-z0-9._%+\-[\]]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const PATHS = [/\/Users\/[^\s'"`]*/g, /\/home\/[a-z][\w.-]*\//g, /[A-Za-z]:\\Users\\[^\s'"`]*/g, /One[D]rive[^\s'"`]*/g];

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (t, flags) => new RegExp('(^|[^A-Za-z0-9_])(' + esc(t) + ')(?![A-Za-z0-9_])', flags || 'g');
const ctx = (text, i, n) => text.slice(Math.max(0, i - 30), i + n + 30).replace(/\s+/g, ' ');

function hits(text, re) {
  const out = []; let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) { const t = m[2] != null ? m[2] : m[0]; out.push({ t, i: m.index + (m[2] != null ? m[1].length : 0) }); if (!re.global) break; }
  return out;
}

// Text rules. terms: the optional extra lists. Returns [{ file, rule, text, fatal }].
function checkText(name, text, terms) {
  const F = [], T = terms || {};
  const add = (rule, t, i, fatal) => F.push({ file: name, rule, text: t, at: ctx(text, i, t.length), fatal });
  hits(text, EMAIL).forEach(h => { if (!NOREPLY.test(h.t)) add('email', h.t, h.i, true); });
  PATHS.forEach(re => hits(text, re).forEach(h => add('local path', h.t, h.i, true)));
  (T.words || []).forEach(w => hits(text, word(w)).forEach(h => add('private word', h.t, h.i, true)));
  (T.names || []).forEach(w => hits(text, word(w, 'gi')).forEach(h => add('private name', h.t, h.i, true)));
  const listRule = (rule, list, flags, fieldRe) => {
    const seen = new Map();
    (list || []).forEach(w => hits(text, word(w, flags)).forEach(h => { if (!seen.has(w)) seen.set(w, []); seen.get(w).push(h); }));
    const many = seen.size >= LIST_MIN;
    seen.forEach((hs, w) => hs.forEach(h => {
      const field = fieldRe && fieldRe(w).test(text.slice(Math.max(0, h.i - 12), h.i + w.length + 1));
      add(rule + (many ? ' (' + seen.size + ' different in this file)' : field ? ' (as a data field)' : ''), h.t, h.i, many || !!field);
    }));
  };
  const field = keys => w => new RegExp('"(' + keys + ')"\\s*:\\s*"' + esc(w) + '"');
  listRule('soft term', T.soft, 'gi');
  listRule('airport ICAO code', T.icao, 'g', field('icao|code|station'));
  listRule('airport IATA code', T.iata, 'g', field('code|iata'));
  listRule('airport name', T.places, 'g', field('name'));
  return F;
}

// JSON structure rules: hub arrays with content, airport-code + position tables.
function checkJson(name, obj) {
  const F = [];
  (function walk(v, p) {
    if (Array.isArray(v)) {
      if (v.length && v.some(x => x && typeof x === 'object' && !Array.isArray(x) && ('code' in x || 'icao' in x) && ('lat' in x || 'lon' in x)))
        F.push({ file: name, rule: 'airport table (code + position)', text: p + ' [' + v.length + ']', at: JSON.stringify(v[0]).slice(0, 90), fatal: true });
      v.forEach((x, i) => walk(x, p + '[' + i + ']'));
    } else if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => {
        if ((k === 'hubs' || k === 'hubProb') && Array.isArray(v[k]) && v[k].length)
          F.push({ file: name, rule: 'hub array with content', text: p + '.' + k + ' [' + v[k].length + ']', at: JSON.stringify(v[k]).slice(0, 90), fatal: true });
        walk(v[k], p + '.' + k);
      });
    }
  })(obj, '$');
  return F;
}

// The extra terms: --terms file, else privacy-terms.js beside this file (kept out of the public copy).
function loadTerms(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const local = path.join(__dirname, 'privacy-terms.js');
  if (fs.existsSync(local)) return require(local).terms();
  return null;
}

function listFiles(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [p];
  return fs.readdirSync(p).filter(n => n !== '.git' && n !== 'node_modules').sort().flatMap(n => listFiles(path.join(p, n)));
}

function checkFiles(paths, terms) {
  const F = [];
  paths.flatMap(listFiles).forEach(f => {
    const text = fs.readFileSync(f, 'utf8');
    F.push(...checkText(f, text, terms));
    if (/\.json$/i.test(f)) { try { F.push(...checkJson(f, JSON.parse(text))); } catch (e) { F.push({ file: f, rule: 'unreadable JSON', text: e.message, at: '', fatal: true }); } }
  });
  return F;
}

function report(F, nFiles, withTerms) {
  F.forEach(x => console.log((x.fatal ? 'FAIL ' : 'note ') + x.file + ' · ' + x.rule + ' · "' + x.text + '"' + (x.at ? ' · …' + x.at + '…' : '')));
  const bad = F.filter(x => x.fatal).length;
  console.log('privacy-check: ' + nFiles + ' file(s), ' + (withTerms ? 'built-in rules + private term lists' : 'built-in rules only (no private term list here)') + ' · ' +
              bad + ' failure(s), ' + (F.length - bad) + ' note(s) → ' + (bad ? 'FAILED' : 'passed'));
  return bad;
}

module.exports = { checkText, checkJson, checkFiles, loadTerms, report, LIST_MIN };

if (require.main === module) {
  const a = process.argv.slice(2), ti = a.indexOf('--terms');
  const termsFile = ti >= 0 ? a.splice(ti, 2)[1] : null;
  if (!a.length) { console.log('usage: node privacy-check.js [--terms terms.json] <file|dir> [...]'); process.exit(2); }
  const terms = loadTerms(termsFile);
  const files = a.flatMap(listFiles);
  process.exit(report(checkFiles(a, terms), files.length, !!terms) ? 1 : 0);
}
