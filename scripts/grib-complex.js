'use strict';
// grib-complex.js — GRIB2 complex packing (data templates 5.2 and 5.3), without dependencies.
//
// Why: NOMADS keeps GFS cycles for about ten days, and its grib filter answers in simple packing
// (5.0). The same GFS files stay for years in NOAA's open-data bucket on AWS
// (noaa-gfs-bdp-pds, "open to the public and can be used as desired"), but there the 1° fields are
// stored in complex packing with second-order spatial differencing (5.3). fetch-wxreview.js reads
// that archive when NOMADS no longer has a day (PO decision 2026-10-06), so the decoder in
// fetch-wxoutlook.js needs this unpacker. Layout from WMO FM 92 GRIB2, templates 5.2/5.3 and 7.2/7.3;
// the reconstruction follows NCEP's g2clib comunpack.c.

// Section 5 starts at byte p (its length field). Offsets below are octet number − 1.
function sm16(buf, p) { const v = buf.readUInt16BE(p); return v & 0x8000 ? -(v & 0x7fff) : v; }

function complexParams(buf, p) {
  const tmpl = buf.readUInt16BE(p + 9);
  if (tmpl !== 2 && tmpl !== 3) throw new Error('not a complex-packing template: 5.' + tmpl);
  const pk = {
    complex: true, tmpl,
    count: buf.readUInt32BE(p + 5), R: buf.readFloatBE(p + 11), E: sm16(buf, p + 15), D: sm16(buf, p + 17), bits: buf[p + 19],
    split: buf[p + 21], missing: buf[p + 22],
    ng: buf.readUInt32BE(p + 31), widthRef: buf[p + 35], widthBits: buf[p + 36],
    lenRef: buf.readUInt32BE(p + 37), lenInc: buf[p + 41], lastLen: buf.readUInt32BE(p + 42), lenBits: buf[p + 46],
    order: tmpl === 3 ? buf[p + 47] : 0, ospd: tmpl === 3 ? buf[p + 48] : 0,
  };
  if (pk.split !== 1) throw new Error('complex packing: group splitting method ' + pk.split + ' not supported');
  if (pk.order > 2) throw new Error('complex packing: spatial differencing of order ' + pk.order + ' not supported');
  return pk;
}

// Data section payload from byte `start` to `end` (exclusive). Returns pk.count scaled values;
// missing values (missing-value management 1 or 2) come back as NaN.
function unpackComplex(buf, start, end, pk) {
  let bit = start * 8;
  const limit = end * 8;
  const read = n => {
    if (!n) return 0;
    if (bit + n > limit) throw new Error('complex packing: data section ends early');
    let x = 0;
    for (let b = 0; b < n; b++, bit++) x = x * 2 + ((buf[bit >> 3] >> (7 - (bit & 7))) & 1);
    return x;
  };
  const align = () => { bit = Math.ceil(bit / 8) * 8; };
  const signed = n => {            // sign-magnitude integer of n octets
    let x = 0;
    for (let b = 0; b < n; b++) x = x * 256 + buf[(bit >> 3) + b];
    bit += n * 8;
    const top = Math.pow(2, n * 8 - 1);
    return x >= top ? -(x - top) : x;
  };

  let ival1 = 0, ival2 = 0, minsd = 0;
  if (pk.tmpl === 3 && pk.order) {
    ival1 = signed(pk.ospd);
    if (pk.order === 2) ival2 = signed(pk.ospd);
    minsd = signed(pk.ospd);
  }
  const ng = pk.ng;
  const refs = new Array(ng), widths = new Array(ng), lens = new Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = read(pk.bits);
  align();
  for (let g = 0; g < ng; g++) widths[g] = pk.widthRef + read(pk.widthBits);
  align();
  for (let g = 0; g < ng; g++) lens[g] = pk.lenRef + read(pk.lenBits) * pk.lenInc;
  align();
  if (ng) lens[ng - 1] = pk.lastLen;
  const total = lens.reduce((a, b) => a + b, 0);
  if (total !== pk.count) throw new Error('complex packing: groups hold ' + total + ' values, section 5 says ' + pk.count);

  const ints = new Float64Array(pk.count), miss = new Uint8Array(pk.count);
  const allOnes = n => Math.pow(2, n) - 1;
  let k = 0;
  for (let g = 0; g < ng; g++) {
    const w = widths[g], L = lens[g];
    if (w === 0) {
      const isMiss = pk.missing >= 1 && pk.bits > 0 && refs[g] === allOnes(pk.bits);
      for (let i = 0; i < L; i++, k++) { ints[k] = refs[g]; if (isMiss) miss[k] = 1; }
    } else {
      for (let i = 0; i < L; i++, k++) {
        const v = read(w);
        if (pk.missing === 1 && v === allOnes(w)) miss[k] = 1;
        else if (pk.missing === 2 && (v === allOnes(w) || v === allOnes(w) - 1)) miss[k] = 1;
        else ints[k] = refs[g] + v;
      }
    }
  }

  // Undo the spatial differencing over the non-missing values only.
  if (pk.tmpl === 3 && pk.order) {
    const idx = [];
    for (let i = 0; i < pk.count; i++) if (!miss[i]) idx.push(i);
    if (idx.length) {
      if (pk.order === 1) {
        ints[idx[0]] = ival1;
        for (let n = 1; n < idx.length; n++) ints[idx[n]] = ints[idx[n]] + minsd + ints[idx[n - 1]];
      } else {
        ints[idx[0]] = ival1;
        if (idx.length > 1) ints[idx[1]] = ival2;
        for (let n = 2; n < idx.length; n++) ints[idx[n]] = ints[idx[n]] + minsd + 2 * ints[idx[n - 1]] - ints[idx[n - 2]];
      }
    }
  }

  const e2 = Math.pow(2, pk.E), d10 = Math.pow(10, -pk.D);
  const out = new Float64Array(pk.count);
  for (let i = 0; i < pk.count; i++) out[i] = miss[i] ? NaN : (pk.R + ints[i] * e2) * d10;
  return out;
}

module.exports = { complexParams, unpackComplex };
