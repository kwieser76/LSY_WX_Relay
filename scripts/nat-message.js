// ---------------------------------------------------------------------------
// nat-message.js
// The North Atlantic track message of the day as the FAA NOTAM system publishes it, parsed into tracks.
// Shared by fetch-faa.js (nat.live of the weekly snapshot) and the public weather relay (parts.nat), so
// both read the message the same way. One request, no key:
//   https://nms.aim.faa.gov/datanat/nat.json — US Government work (public domain); the tracks themselves
//   are issued by Shanwick (EGGX, westbound) and Gander (CZQX, eastbound).
// ---------------------------------------------------------------------------
'use strict';

const U = require('./fetch-util.js');

// The NAT track message as the FAA NOTAM system publishes it (nat.json: one object per part, the text
// in condition_message). EGGX (Shanwick) issues the westbound system, CZQX (Gander) the eastbound one.
// A track line: "C RESNO 56/20 58/30 59/40 58/50 DORYY" — named fixes and lat/lon pairs (degrees
// north / degrees west; "5530/20" is 55°30'N). The latitude where a track crosses 30W shows how far
// north the system runs, which follows the jet stream; a gap of 4 degrees or more between two
// neighbouring tracks is a split system.
function parseCoord(tok) {
  const c = /^(\d{2})(\d{2})?\/(\d{2,3})$/.exec(tok);
  return c ? { lat: parseInt(c[1], 10) + (c[2] ? parseInt(c[2], 10) / 60 : 0), lon: -parseInt(c[3], 10) } : null;
}
function parseNatMessage(parts) {
  const sets = {};
  (Array.isArray(parts) ? parts : []).forEach(p => {
    const icao = String(p.icao_id || '').toUpperCase(), key = icao + '|' + p.start_datetime;
    const st = sets[key] || (sets[key] = { icao, direction: icao === 'EGGX' ? 'westbound' : (icao === 'CZQX' ? 'eastbound' : 'unknown'),
      from: p.start_datetime || null, to: p.end_datetime || null, parts: [], tmi: null, tracks: [], remarks: [] });
    st.parts.push({ no: p.part_no, text: String(p.condition_message || '').replace(/\r/g, '') });
  });
  return Object.values(sets).map(st => {
    st.parts.sort((a, b) => a.no - b.no);
    const text = st.parts.map(x => x.text).join('\n');
    text.split('\n').forEach(l => {
      const m = /^([A-Z]) ((?:[A-Z]{5}|\d{2,4}\/\d{2,3})(?: (?:[A-Z]{5}|\d{2,4}\/\d{2,3}))+)-?\s*$/.exec(l.trim());
      if (!m) return;
      const toks = m[2].split(' '), coords = toks.map(parseCoord).filter(Boolean), fixes = toks.filter(x => !parseCoord(x));
      const at = lon => { const c = coords.find(x => x.lon === lon); return c ? Math.round(c.lat * 10) / 10 : null; };
      st.tracks.push({ letter: m[1], route: m[2], entry: parseCoord(toks[0]) ? null : toks[0], fixes, lat30: at(-30), lat40: at(-40), lat50: at(-50) });
    });
    const tmi = /TMI IS (\d+)/.exec(text); st.tmi = tmi ? parseInt(tmi[1], 10) : null;
    const rem = text.split(/REMARKS\.?/)[1] || '';
    st.remarks = rem.split(/\n(?=\d+\.)/).map(x => x.replace(/\s+/g, ' ').replace(/-?\s*END OF PART.*$/, '').trim())
      .filter(x => /OCR|GNSS|UNAVAIL|NOT AVAILABLE|CLOSED|RESTRICT|EXERCISE|MILITARY|VOLCAN|\bASH\b/.test(x) || (/PBCS/.test(x) && !/NO ASSIGNED PBCS/.test(x))).slice(0, 5);
    const ref = st.tracks.map(tk => ({ letter: tk.letter, lat: tk.lat30 != null ? tk.lat30 : tk.lat40 })).filter(x => x.lat != null).sort((a, b) => b.lat - a.lat);
    st.north = ref.length ? ref[0].lat : null; st.south = ref.length ? ref[ref.length - 1].lat : null;
    st.splits = []; for (let i = 1; i < ref.length; i++) if (ref[i - 1].lat - ref[i].lat >= 4) st.splits.push(ref[i - 1].letter + '/' + ref[i].letter + ' ' + ref[i - 1].lat + 'N→' + ref[i].lat + 'N');
    delete st.parts;
    return st;
  }).sort((a, b) => String(a.from).localeCompare(String(b.from)));
}
const NAT_JSON = 'https://nms.aim.faa.gov/datanat/nat.json';
const NAT_PAGE = 'https://nms.aim.faa.gov/nat';

// The run day's message as nat.live: { fetchedAt, page, sets }, or null when it could not be read. Problems
// go into notes (the wording fetch-faa.js has always used), never thrown.
async function fetchNatLive(notes) {
  try {
    const sets = parseNatMessage(JSON.parse(await U.getText(NAT_JSON, { accept: 'application/json', timeoutMs: 20000, retries: 1 })));
    const live = { fetchedAt: new Date().toISOString(), page: NAT_PAGE, sets };
    if (!sets.length || !sets.some(x => x.tracks.length)) notes.push('NAT track message read, but no tracks parsed — the format may have changed');
    return live;
  } catch (e) { notes.push('NAT track message unreadable: ' + e.message); return null; }
}

module.exports = { NAT_JSON, NAT_PAGE, parseCoord, parseNatMessage, fetchNatLive };
