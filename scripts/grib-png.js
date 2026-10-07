// ---------------------------------------------------------------------------
// grib-png.js
// GRIB2 data template 5.41 (PNG packing) without dependencies beyond Node's zlib — the packing NOAA
// MRMS uses for every field on the noaa-mrms-pds bucket (fetch-mrms.js). The section-7 payload is a
// whole PNG file whose pixels are the packed integers X; a value is Y = (R + X·2^E) / 10^D, with R, E,
// D and the bit count from section 5 (same layout as simple packing, 5.0).
//
// PNG variants allowed by the WMO template: grey with 1, 2, 4, 8 or 16 bits per pixel, RGB (24-bit
// integers, R the high byte) and RGBA (32-bit integers). Interlaced (Adam7) images are refused.
// The PNG chunks are read with png-lite.js (CRC-checked); the scanline filters are undone here one
// row at a time, so a 7000 × 3500 16-bit MRMS raster (49 MB unpacked) is never held whole:
//
//   const GP = require('./grib-png.js');
//   const m = GP.readMessage(gribBuffer);                 // sections 1, 3, 4, 5, 6 + where section 7 is
//   await GP.streamRows(m.png, (j, row) => { ... GP.sampleAt(row, i, m.image.sampleBits) ... });
//   const values = GP.unpackPng(buf, start, end, pk);     // sync, whole field → Float32Array (small fields, tests)
//
// unpackPng has the same contract as grib-complex.js unpackComplex / grib-aec.js unpackCcsds (packed
// values in order, bitmap applied by the caller), so fetch-wxoutlook.js decodeGrib2 can take 5.41 with
// two lines: `else if (tmpl === 41) pk = GP.pngParams(buf, p);` in section 5 and
// `pk.png ? GP.unpackPng(buf, p + 5, p + L, pk)` beside the CCSDS / complex calls in section 7.
// ---------------------------------------------------------------------------
'use strict';

const zlib = require('zlib');
const PNG = require('./png-lite.js');

// GRIB2 signed integers are sign-and-magnitude, not two's complement.
const sm16 = (b, o) => { const v = b.readUInt16BE(o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const sm32 = (b, o) => { const v = b.readUInt32BE(o); return v & 0x80000000 ? -(v & 0x7fffffff) : v; };

// Section 5 at byte p, template 5.41.
function pngParams(buf, p) {
  const tmpl = buf.readUInt16BE(p + 9);
  if (tmpl !== 41) throw new Error('data template 5.' + tmpl + ' is not PNG packing (5.41)');
  return { png: true, count: buf.readUInt32BE(p + 5), R: buf.readFloatBE(p + 11), E: sm16(buf, p + 15), D: sm16(buf, p + 17), bits: buf[p + 19] };
}

// The image inside section 7: header fields plus the concatenated IDAT stream.
function pngImage(png) {
  const cs = PNG.chunks(png);
  const ih = cs[0] && cs[0].type === 'IHDR' ? cs[0].data : null;
  if (!ih || ih.length < 13) throw new Error('PNG without IHDR');
  const width = ih.readUInt32BE(0), height = ih.readUInt32BE(4), bitDepth = ih[8], colorType = ih[9];
  if (ih[12]) throw new Error('interlaced PNG not supported');
  let sampleBits;
  if (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) sampleBits = bitDepth;
  else if (colorType === 2 && bitDepth === 8) sampleBits = 24;
  else if (colorType === 6 && bitDepth === 8) sampleBits = 32;
  else throw new Error('PNG colour type ' + colorType + ' with ' + bitDepth + ' bits is not a GRIB2 5.41 layout');
  if (!width || !height) throw new Error('PNG size ' + width + 'x' + height);
  const idat = Buffer.concat(cs.filter(c => c.type === 'IDAT').map(c => c.data));
  if (!idat.length) throw new Error('PNG without image data');
  return { width, height, bitDepth, colorType, sampleBits, stride: Math.ceil(width * sampleBits / 8), bpp: Math.max(1, sampleBits >> 3), idat };
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

// Takes the inflated scanlines in pieces of any size, undoes the filter of each complete row and hands it
// to onRow(y, row). `row` is reused for the next row: copy what you keep.
class RowUnfilter {
  constructor(img, onRow) {
    this.h = img.height; this.stride = img.stride; this.bpp = img.bpp; this.onRow = onRow;
    this.raw = Buffer.alloc(img.stride + 1); this.fill = 0; this.y = 0;
    this.prev = Buffer.alloc(img.stride); this.cur = Buffer.alloc(img.stride);
  }
  push(chunk) {
    let o = 0;
    while (o < chunk.length && this.y < this.h) {
      const n = Math.min(chunk.length - o, this.raw.length - this.fill);
      chunk.copy(this.raw, this.fill, o, o + n); this.fill += n; o += n;
      if (this.fill === this.raw.length) { this.row(); this.fill = 0; }
    }
  }
  row() {
    const ft = this.raw[0], src = this.raw, out = this.cur, up = this.prev, S = this.stride, B = this.bpp;
    if (ft === 0) src.copy(out, 0, 1);
    else if (ft === 1) { for (let x = 0; x < S; x++) out[x] = (src[x + 1] + (x >= B ? out[x - B] : 0)) & 255; }
    else if (ft === 2) { for (let x = 0; x < S; x++) out[x] = (src[x + 1] + up[x]) & 255; }
    else if (ft === 3) { for (let x = 0; x < S; x++) out[x] = (src[x + 1] + (((x >= B ? out[x - B] : 0) + up[x]) >> 1)) & 255; }
    else if (ft === 4) { for (let x = 0; x < S; x++) out[x] = (src[x + 1] + paeth(x >= B ? out[x - B] : 0, up[x], x >= B ? up[x - B] : 0)) & 255; }
    else throw new Error('PNG filter type ' + ft + ' unknown (row ' + this.y + ')');
    this.onRow(this.y, out);
    this.cur = up; this.prev = out; this.y++;   // the first row's "previous row" is the zero-filled buffer
  }
  end() { if (this.y < this.h) throw new Error('PNG image data too short (' + this.y + ' of ' + this.h + ' rows)'); }
}

// The packed integer of column i in an unfiltered row.
function sampleAt(row, i, bits) {
  switch (bits) {
    case 16: return (row[i * 2] << 8) | row[i * 2 + 1];
    case 8: return row[i];
    case 24: return (row[i * 3] << 16) | (row[i * 3 + 1] << 8) | row[i * 3 + 2];
    case 32: return row[i * 4] * 16777216 + ((row[i * 4 + 1] << 16) | (row[i * 4 + 2] << 8) | row[i * 4 + 3]);
    default: { const bit = i * bits; return (row[bit >> 3] >> (8 - bits - (bit & 7))) & ((1 << bits) - 1); }
  }
}

// Synchronous: the whole PNG → the packed values scaled, in packing order (bitmap NOT applied).
function unpackPng(buf, start, end, pk) {
  const e2 = Math.pow(2, pk.E), d10 = Math.pow(10, -pk.D);
  if (!pk.bits || end <= start) return new Float32Array(pk.count).fill(pk.R * d10);   // constant field: no image
  const img = pngImage(buf.subarray(start, end));
  if (img.width * img.height !== pk.count) throw new Error('PNG holds ' + img.width * img.height + ' values, section 5 says ' + pk.count);
  const vals = new Float32Array(pk.count), W = img.width, sb = img.sampleBits;
  const ru = new RowUnfilter(img, (y, row) => { for (let x = 0; x < W; x++) vals[y * W + x] = (pk.R + sampleAt(row, x, sb) * e2) * d10; });
  ru.push(zlib.inflateSync(img.idat)); ru.end();
  return vals;
}

// Asynchronous: inflates in 256 KB pieces and calls onRow(y, row) for every scanline; resolves with the
// image header. Peak memory is a few rows plus zlib's window, whatever the raster size.
function streamRows(png, onRow) {
  let img;
  try { img = pngImage(png); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const ru = new RowUnfilter(img, onRow);
    const inf = zlib.createInflate({ chunkSize: 256 * 1024 });
    let failed = false;
    const fail = e => { if (!failed) { failed = true; inf.destroy(); reject(e); } };
    inf.on('data', c => { if (failed) return; try { ru.push(c); } catch (e) { fail(e); } });
    inf.on('end', () => { if (failed) return; try { ru.end(); resolve(img); } catch (e) { fail(e); } });
    inf.on('error', fail);
    inf.end(img.idat);
  });
}

// One GRIB2 message (the first in buf): its sections, without decoding the data.
// Returns { discipline, refTime, cat, num, pdtn, grid {ni, nj, la1, lo1, la2, lo2, di, dj, scan}, pk, bitmap (byte offset | null),
//           data: [start, end] of the section-7 payload, png: Buffer | null, image: header | null }.
function readMessage(buf) {
  const at = buf.indexOf('GRIB');
  if (at < 0) throw new Error('no GRIB message in the buffer');
  if (buf[at + 7] !== 2) throw new Error('GRIB edition ' + buf[at + 7] + ' (only edition 2 is read)');
  const len = Number(buf.readBigUInt64BE(at + 8));
  if (len < 16 || at + len > buf.length) throw new Error('truncated GRIB2 message (' + (buf.length - at) + ' of ' + len + ' bytes)');
  if (buf.toString('latin1', at + len - 4, at + len) !== '7777') throw new Error('GRIB2 message does not end in 7777');
  const m = { discipline: buf[at + 6], grid: null, pk: null, bitmap: null, data: null, png: null, image: null };
  for (let p = at + 16; p < at + len - 4;) {
    const L = buf.readUInt32BE(p), n = buf[p + 4];
    if (L < 5 || p + L > at + len) throw new Error('bad GRIB2 section length at byte ' + p);
    if (n === 1) m.refTime = new Date(Date.UTC(buf.readUInt16BE(p + 12), buf[p + 14] - 1, buf[p + 15], buf[p + 16], buf[p + 17], buf[p + 18])).toISOString().replace(/\.\d{3}Z$/, 'Z');
    else if (n === 3) {
      const tmpl = buf.readUInt16BE(p + 12);
      if (tmpl !== 0) throw new Error('grid template 3.' + tmpl + ' not supported (regular lat/lon only)');
      m.grid = { ni: buf.readUInt32BE(p + 30), nj: buf.readUInt32BE(p + 34), la1: sm32(buf, p + 46) / 1e6, lo1: sm32(buf, p + 50) / 1e6,
                 la2: sm32(buf, p + 55) / 1e6, lo2: sm32(buf, p + 59) / 1e6, di: buf.readUInt32BE(p + 63) / 1e6, dj: buf.readUInt32BE(p + 67) / 1e6, scan: buf[p + 71] };
      if (m.grid.scan & 0x20) throw new Error('grid scan mode 0x' + m.grid.scan.toString(16) + ' (j-consecutive) not supported');
    } else if (n === 4) { m.pdtn = buf.readUInt16BE(p + 7); m.cat = buf[p + 9]; m.num = buf[p + 10]; }
    else if (n === 5) m.pk = pngParams(buf, p);
    else if (n === 6) { const ind = buf[p + 5]; if (ind === 0) m.bitmap = p + 6; else if (ind !== 255) throw new Error('bitmap indicator ' + ind + ' not supported'); }
    else if (n === 7) m.data = [p + 5, p + L];
    p += L;
  }
  if (!m.grid || !m.pk || !m.data) throw new Error('GRIB2 message without grid, packing or data section');
  if (m.pk.bits && m.data[1] > m.data[0]) {
    m.png = buf.subarray(m.data[0], m.data[1]);
    m.image = pngImage(m.png);
    if (m.image.width * m.image.height !== m.pk.count) throw new Error('PNG holds ' + m.image.width * m.image.height + ' values, section 5 says ' + m.pk.count);
    if (m.bitmap === null && m.pk.count !== m.grid.ni * m.grid.nj) throw new Error('value count ' + m.pk.count + ' ≠ grid ' + m.grid.ni + '×' + m.grid.nj + ' and no bitmap');
  }
  return m;
}

// The smallest packed integer whose value is ≥ y: compare integers per pixel instead of scaling each one.
function packedAtLeast(pk, y) {
  const e2 = Math.pow(2, pk.E), d10 = Math.pow(10, pk.D);
  return Math.ceil((y * d10 - pk.R) / e2 - 1e-9);
}
const valueOf = (pk, x) => (pk.R + x * Math.pow(2, pk.E)) / Math.pow(10, pk.D);

// A grey PNG writer for tests: samples (integers) row-major, bit depth 8 or 16, every row filtered with
// `filters[y % filters.length]` (0–4) so the unfilter paths are exercised.
function encodeGrey(width, height, bits, samples, filters) {
  const bpp = bits / 8, stride = width * bpp, rows = Buffer.alloc(height * stride);
  for (let k = 0; k < width * height; k++) { if (bits === 16) rows.writeUInt16BE(samples[k], k * 2); else rows[k] = samples[k]; }
  const fs = filters && filters.length ? filters : [0];
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const ft = fs[y % fs.length], o = y * (stride + 1), r = y * stride;
    raw[o] = ft;
    for (let x = 0; x < stride; x++) {
      const v = rows[r + x], a = x >= bpp ? rows[r + x - bpp] : 0, b = y ? rows[r - stride + x] : 0, c = (y && x >= bpp) ? rows[r - stride + x - bpp] : 0;
      const pred = ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : ft === 4 ? paeth(a, b, c) : 0;
      raw[o + 1 + x] = (v - pred) & 255;
    }
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(typeof zlib.crc32 === 'function' ? zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0 : 0, 8 + data.length);
    return b;
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(width, 0); ih.writeUInt32BE(height, 4); ih[8] = bits; ih[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A one-message GRIB2 file with a regular lat/lon grid and PNG packing, for tests.
// o: { ni, nj, la1, lo1, di, dj, scan, R, E, D, bits, samples, filters, cat, num, time: 'YYYY-MM-DDTHH:MM:SSZ' }
function encodeGrib541(o) {
  const smw = (v, n) => (v < 0 ? (n === 2 ? 0x8000 : 0x80000000) + (-v) : v);
  const s1 = Buffer.alloc(21); s1.writeUInt32BE(21, 0); s1[4] = 1;
  const t = new Date(o.time || '2026-09-30T21:00:00Z');
  s1.writeUInt16BE(t.getUTCFullYear(), 12); s1[14] = t.getUTCMonth() + 1; s1[15] = t.getUTCDate(); s1[16] = t.getUTCHours(); s1[17] = t.getUTCMinutes(); s1[18] = t.getUTCSeconds();
  const s3 = Buffer.alloc(72); s3.writeUInt32BE(72, 0); s3[4] = 3; s3.writeUInt32BE(o.ni * o.nj, 6); s3.writeUInt16BE(0, 12);
  s3.writeUInt32BE(o.ni, 30); s3.writeUInt32BE(o.nj, 34);
  s3.writeUInt32BE(smw(Math.round(o.la1 * 1e6), 4) >>> 0, 46); s3.writeUInt32BE(smw(Math.round(o.lo1 * 1e6), 4) >>> 0, 50);
  s3.writeUInt32BE(Math.round(o.di * 1e6), 63); s3.writeUInt32BE(Math.round(o.dj * 1e6), 67); s3[71] = o.scan || 0;
  const s4 = Buffer.alloc(34); s4.writeUInt32BE(34, 0); s4[4] = 4; s4[9] = o.cat || 0; s4[10] = o.num || 0;
  const s5 = Buffer.alloc(21); s5.writeUInt32BE(21, 0); s5[4] = 5; s5.writeUInt32BE(o.ni * o.nj, 5); s5.writeUInt16BE(41, 9);
  s5.writeFloatBE(o.R, 11); s5.writeUInt16BE(smw(o.E || 0, 2), 15); s5.writeUInt16BE(smw(o.D || 0, 2), 17); s5[19] = o.bits;
  const s6 = Buffer.from([0, 0, 0, 6, 6, 255]);
  const png = o.bits ? encodeGrey(o.ni, o.nj, o.bits, o.samples, o.filters) : Buffer.alloc(0);
  const s7 = Buffer.alloc(5 + png.length); s7.writeUInt32BE(5 + png.length, 0); s7[4] = 7; png.copy(s7, 5);
  const body = Buffer.concat([s1, s3, s4, s5, s6, s7]);
  const s0 = Buffer.alloc(16); s0.write('GRIB', 0, 'latin1'); s0[6] = o.discipline || 209; s0[7] = 2; s0.writeBigUInt64BE(BigInt(16 + body.length + 4), 8);
  return Buffer.concat([s0, body, Buffer.from('7777', 'latin1')]);
}

module.exports = { pngParams, pngImage, RowUnfilter, sampleAt, unpackPng, streamRows, readMessage, packedAtLeast, valueOf, encodeGrey, encodeGrib541 };
