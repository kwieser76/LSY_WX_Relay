// ---------------------------------------------------------------------------
// png-lite.js
// A small PNG reader with no dependencies beyond Node's zlib, for the map images the fetchers pull
// from WMS servers (fetch-lightning.js: EUMETView). It reads what such servers send — non-interlaced
// PNGs, colour types 0 (grey), 2 (RGB), 3 (palette, 1/2/4/8 bit), 4 (grey + alpha) and 6 (RGBA),
// 8 bit, plus 16 bit for the non-palette types — and returns every pixel as 8-bit RGBA, transparency
// from the alpha channel or from tRNS. Interlaced (Adam7) files are refused with an error rather
// than read wrongly.
//
//   const png = require('./png-lite.js').decode(buffer);   // { width, height, rgba: Uint8Array(w*h*4), colorType, bitDepth }
// ---------------------------------------------------------------------------
'use strict';

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function isPng(buf) { return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIG); }

// The chunks of the file, CRC-checked where this Node has zlib.crc32 (v20.15+).
function chunks(buf) {
  if (!isPng(buf)) throw new Error('not a PNG (signature)');
  const out = [];
  for (let p = 8; p + 12 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error('PNG truncated in chunk ' + type);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (typeof zlib.crc32 === 'function' && (zlib.crc32(buf.subarray(p + 4, p + 8 + len)) >>> 0) !== buf.readUInt32BE(p + 8 + len)) {
      throw new Error('PNG CRC mismatch in chunk ' + type);
    }
    out.push({ type, data });
    p += 12 + len;
    if (type === 'IEND') return out;
  }
  throw new Error('PNG has no IEND chunk (truncated)');
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

// Undo the per-scanline filters in place; returns the raw scanlines without their filter bytes.
function unfilter(data, height, stride, bpp) {
  if (data.length < height * (stride + 1)) throw new Error('PNG image data too short (' + data.length + ' < ' + height * (stride + 1) + ')');
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = data[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[prev + x] : 0, c = (y && x >= bpp) ? out[prev + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: throw new Error('PNG filter type ' + ft + ' unknown (row ' + y + ')');
      }
      out[row + x] = v & 255;
    }
  }
  return out;
}

function decode(buf) {
  const cs = chunks(buf);
  const ih = cs[0] && cs[0].type === 'IHDR' ? cs[0].data : null;
  if (!ih || ih.length < 13) throw new Error('PNG without IHDR');
  const width = ih.readUInt32BE(0), height = ih.readUInt32BE(4), bitDepth = ih[8], colorType = ih[9], interlace = ih[12];
  if (!(colorType in CHANNELS)) throw new Error('PNG colour type ' + colorType + ' unknown');
  if (interlace) throw new Error('interlaced PNG not supported');
  if (colorType === 3 ? ![1, 2, 4, 8].includes(bitDepth) : ![8, 16].includes(bitDepth)) throw new Error('PNG bit depth ' + bitDepth + ' with colour type ' + colorType + ' not supported');
  if (!width || !height || width * height > 40e6) throw new Error('PNG size ' + width + 'x' + height + ' out of range');
  const plte = cs.find(c => c.type === 'PLTE'), trns = cs.find(c => c.type === 'tRNS');
  if (colorType === 3 && !plte) throw new Error('palette PNG without PLTE');
  const idat = Buffer.concat(cs.filter(c => c.type === 'IDAT').map(c => c.data));
  if (!idat.length) throw new Error('PNG without image data');
  const bitsPerPixel = CHANNELS[colorType] * bitDepth;
  const stride = Math.ceil(width * bitsPerPixel / 8), bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = unfilter(zlib.inflateSync(idat), height, stride, bpp);
  const rgba = new Uint8Array(width * height * 4);
  const hi = bitDepth === 16 ? 2 : 1;                             // 16 bit: keep the high byte
  const s16 = (row, i) => raw[row + i * hi];
  // tRNS for grey / RGB: one key colour (16-bit values) that is fully transparent.
  const keyGrey = trns && colorType === 0 && trns.data.length >= 2 ? trns.data.readUInt16BE(0) : null;
  const keyRgb = trns && colorType === 2 && trns.data.length >= 6 ? [trns.data.readUInt16BE(0), trns.data.readUInt16BE(2), trns.data.readUInt16BE(4)] : null;
  const full = (row, i) => (bitDepth === 16 ? raw.readUInt16BE(row + i * 2) : raw[row + i]);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) { const i = x * 4; rgba[o] = s16(row, i); rgba[o + 1] = s16(row, i + 1); rgba[o + 2] = s16(row, i + 2); rgba[o + 3] = s16(row, i + 3); }
      else if (colorType === 2) {
        const i = x * 3; rgba[o] = s16(row, i); rgba[o + 1] = s16(row, i + 1); rgba[o + 2] = s16(row, i + 2);
        rgba[o + 3] = keyRgb && full(row, i) === keyRgb[0] && full(row, i + 1) === keyRgb[1] && full(row, i + 2) === keyRgb[2] ? 0 : 255;
      } else if (colorType === 4) { const i = x * 2, g = s16(row, i); rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = s16(row, i + 1); }
      else if (colorType === 0) { const g = s16(row, x); rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = keyGrey != null && full(row, x) === keyGrey ? 0 : 255; }
      else {                                                       // palette, 1/2/4/8 bit
        const bit = x * bitDepth, idx = (raw[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
        if (idx * 3 + 2 >= plte.data.length) throw new Error('PNG palette index ' + idx + ' out of range');
        rgba[o] = plte.data[idx * 3]; rgba[o + 1] = plte.data[idx * 3 + 1]; rgba[o + 2] = plte.data[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.data.length ? trns.data[idx] : 255;
      }
    }
  }
  return { width, height, bitDepth, colorType, rgba };
}

// A tiny PNG writer (RGBA 8 bit, filter 0) — for tests and quick visual checks, not for the dashboards.
function encode(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
    b.writeUInt32BE(typeof zlib.crc32 === 'function' ? zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0 : 0, 8 + data.length);
    return b;
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(width, 0); ih.writeUInt32BE(height, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { isPng, decode, encode, chunks };
