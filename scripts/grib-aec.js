// ---------------------------------------------------------------------------
// grib-aec.js
// Dependency-free decoder for GRIB2 data template 5.42: CCSDS 121.0-B lossless compression
// ("Adaptive Entropy Coding", AEC), with the semantics of libaec, the library ecCodes uses.
// ECMWF packs every field of its open data this way (flags 14 = PREPROCESS | MSB | 3BYTE,
// block size 32, reference sample interval 128, 8–16 bits per value), which is why the simple-
// packing reader in fetch-wxoutlook.js could not read them.
//
// The bitstream, MSB first. Each block of J samples starts with an option id of idLen bits
// (3 for n <= 8, 4 for n <= 16, 5 above; 1–2 for the RESTRICTED set at n <= 4):
//   id 0, then 1 bit: 0 = zero blocks (a fundamental-sequence count, 5 = "rest of segment"),
//                     1 = second extension (pairs coded as one FS value)
//   id all ones:      uncompressed, J samples of n bits
//   otherwise:        split sample, k = id - 1: J fundamental sequences (value >> k), then J k-bit tails
// With PREPROCESS the first sample of every RSI (rsi blocks) is a raw reference sample of n bits
// (inside the block, so that block carries J - 1 coded samples) and every other sample is a
// mapped prediction residual relative to the previous output (unit-delay predictor). Byte order
// (MSB) and sample width (3BYTE) only describe libaec's output buffer and do not change the stream.
//
// The decoder checks itself where it can: an option id or second-extension value out of range, a
// stream that ends before the samples do, or one that leaves more than a byte (plus RSI padding)
// unread, all throw instead of returning numbers.
// ---------------------------------------------------------------------------
'use strict';

const AEC = { SIGNED: 1, THREE_BYTE: 2, MSB: 4, PREPROCESS: 8, RESTRICTED: 16, PAD_RSI: 32, NOT_ENFORCE: 64 };
const ROS = 5;                // zero-block count meaning "to the end of the segment / RSI"
const SE_TABLE_SIZE = 90;

// m -> [sum of the pair, first m of that sum]: the second-extension code of libaec.
const SE = (() => { const t = []; for (let i = 0; i < 13; i++) { const ms = t.length; for (let j = 0; j <= i; j++) t.push([i, ms]); } return t; })();

function idLength(n, flags) {
  if (n > 16) return 5;
  if (n > 8) return 4;
  if (flags & AEC.RESTRICTED) { if (n <= 2) return 1; if (n <= 4) return 2; throw new Error('AEC: RESTRICTED needs <= 4 bits per sample, got ' + n); }
  return 3;
}

// Big-endian bit reader over buf[start, end).
function bitReader(buf, start, end) {
  let pos = start * 8;
  const lim = end * 8;
  return {
    bits(n) {
      if (pos + n > lim) throw new Error('AEC: stream ended early (need ' + n + ' bits at bit ' + (pos - start * 8) + ')');
      let v = 0;
      while (n > 0) {
        const off = pos & 7, avail = 8 - off, take = avail < n ? avail : n;
        v = v * (1 << take) + ((buf[pos >> 3] >> (avail - take)) & ((1 << take) - 1));
        pos += take; n -= take;
      }
      return v;
    },
    fs() {   // fundamental sequence: the number of 0 bits before the next 1
      let count = 0;
      for (;;) {
        if (pos >= lim) throw new Error('AEC: stream ended inside a fundamental sequence');
        const off = pos & 7, b = (buf[pos >> 3] << off) & 0xff;
        if (b === 0) { count += 8 - off; pos += 8 - off; continue; }
        const lz = Math.clz32(b) - 24;
        pos += lz + 1;
        return count + lz;
      }
    },
    align() { pos = (pos + 7) & ~7; },
    get used() { return pos - start * 8; },
    get total() { return lim - start * 8; },
  };
}

// Decodes `count` samples. Returns a Uint32Array (Int32Array with the SIGNED flag).
function aecDecode(buf, start, end, p, count) {
  const n = p.bitsPerSample, J = p.blockSize, R = p.rsi, flags = p.flags || 0;
  if (!(n >= 1 && n <= 32)) throw new Error('AEC: bits per sample ' + n + ' out of range');
  if (!(J === 8 || J === 16 || J === 32 || J === 64 || (flags & AEC.NOT_ENFORCE && J > 0 && J % 2 === 0)))
    throw new Error('AEC: block size ' + J + ' not supported');
  if (!(R >= 1 && R <= 4096)) throw new Error('AEC: reference sample interval ' + R + ' out of range');
  const pp = !!(flags & AEC.PREPROCESS), signed = !!(flags & AEC.SIGNED), padRsi = !!(flags & AEC.PAD_RSI);
  const idLen = idLength(n, flags), idUncomp = (1 << idLen) - 1;
  const xmin = signed ? -Math.pow(2, n - 1) : 0, xmax = signed ? Math.pow(2, n - 1) - 1 : Math.pow(2, n) - 1;
  const ext = v => (signed && v >= Math.pow(2, n - 1) ? v - Math.pow(2, n) : v);
  const out = signed ? new Int32Array(count) : new Uint32Array(count);
  const rd = bitReader(buf, start, end), rsiLen = J * R;
  let o = 0, rsiPos = 0, last = 0;
  const fsv = new Array(J);

  const put = v => {
    if (o >= count) { rsiPos++; return; }
    if (!pp) out[o++] = ext(v);
    else if (rsiPos === 0) { last = ext(v); out[o++] = last; }
    else {   // inverse of the CCSDS prediction-error mapping
      const lo = last - xmin, hi = xmax - last, theta = lo < hi ? lo : hi;
      if (v <= 2 * theta) last += (v & 1) ? -((v + 1) / 2) : v / 2;
      else last = lo <= hi ? xmin + v : xmax - v;
      out[o++] = last;
    }
    rsiPos++;
  };

  while (o < count) {
    const ref = pp && rsiPos === 0 ? 1 : 0;
    const id = rd.bits(idLen);
    if (id === 0) {
      const second = rd.bits(1);
      if (ref) put(rd.bits(n));
      if (second) {                                   // second extension
        for (let i = ref; i < J;) {
          const m = rd.fs();
          if (m > SE_TABLE_SIZE) throw new Error('AEC: second-extension value ' + m + ' out of range');
          const d1 = m - SE[m][1];
          if ((i & 1) === 0) { put(SE[m][0] - d1); i++; }
          put(d1); i++;
        }
      } else {                                        // zero blocks
        let zb = rd.fs() + 1;
        if (zb === ROS) { const b = Math.floor(rsiPos / J); zb = Math.min(R - b, 64 - (b % 64)); }
        else if (zb > ROS) zb--;
        for (let i = zb * J - ref; i > 0; i--) put(0);
      }
    } else if (id === idUncomp) {                     // uncompressed
      for (let i = 0; i < J; i++) put(rd.bits(n));
    } else {                                          // split sample
      const k = id - 1;
      if (ref) put(rd.bits(n));
      const m = J - ref;
      for (let i = 0; i < m; i++) fsv[i] = rd.fs();
      const sk = Math.pow(2, k);
      for (let i = 0; i < m; i++) put(fsv[i] * sk + (k ? rd.bits(k) : 0));
    }
    if (rsiPos >= rsiLen) { rsiPos -= rsiLen; if (padRsi) rd.align(); }
  }
  // The stream must be used up: at most the last byte's padding (or an RSI's padding) may remain.
  const left = rd.total - rd.used;
  if (left >= 8 && !(padRsi && left < 16)) throw new Error('AEC: ' + left + ' bits left unread after ' + count + ' samples — wrong parameters or a corrupt stream');
  return out;
}

// GRIB2 section 5, template 5.42, starting at the section's first byte.
function ccsdsParams(buf, p5) {
  const tmpl = buf.readUInt16BE(p5 + 9);
  if (tmpl !== 42) throw new Error('not data template 5.42 (got 5.' + tmpl + ')');
  const sm16 = o => { const v = buf.readUInt16BE(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
  return { count: buf.readUInt32BE(p5 + 5), R: buf.readFloatBE(p5 + 11), E: sm16(p5 + 15), D: sm16(p5 + 17), bits: buf[p5 + 19],
           flags: buf[p5 + 21], blockSize: buf[p5 + 22], rsi: buf.readUInt16BE(p5 + 23) };
}

// Values of one field: (R + X * 2^E) / 10^D for the `count` packed samples in buf[start, end).
function unpackCcsds(buf, start, end, p) {
  const vals = new Float64Array(p.count);
  const e2 = Math.pow(2, p.E), d10 = Math.pow(10, -p.D);
  if (p.bits === 0) { vals.fill(p.R * d10); return vals; }
  const x = aecDecode(buf, start, end, { bitsPerSample: p.bits, blockSize: p.blockSize, rsi: p.rsi, flags: p.flags }, p.count);
  for (let i = 0; i < p.count; i++) vals[i] = (p.R + x[i] * e2) * d10;
  return vals;
}

module.exports = { AEC, idLength, aecDecode, ccsdsParams, unpackCcsds };
