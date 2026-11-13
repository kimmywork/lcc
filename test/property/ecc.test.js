import test from 'node:test';
import assert from 'node:assert/strict';

import { BitReader, BitWriter } from '../../src/bitstream.js';
import { crc32 } from '../../src/ecc/crc32.js';
import { bch15Decode, bch15Encode } from '../../src/ecc/bch15.js';
import { computeRSBlocks, rsDecode, rsEncode, rsEncodeBlocks, rsDecodeBlocks } from '../../src/ecc/rs.js';
import { buildFrame, parseFrame } from '../../src/frame.js';
import { packFormatPayload, readFormatBand, unpackFormatPayload, writeFormatBand } from '../../src/format/format-band.js';
import { RankConstraint } from '../../src/constraint.js';
import { generatePalette } from '../../src/palettes.js';
import { makeWhitening } from '../../src/whitening.js';
import { makeLayout } from '../../src/layout.js';
import { mulberry32, int } from '../../scripts/lib/rng.mjs';

function data(rand, n) {
  return Uint8Array.from({ length: n }, () => int(rand, 0, 255));
}

function hamming(a, b) {
  let x = (a ^ b) >>> 0;
  let n = 0;
  while (x) {
    n += x & 1;
    x >>>= 1;
  }
  return n;
}

test('RS property: every pattern up to t errors is corrected', () => {
  const rand = mulberry32(0x5252);
  for (let trial = 0; trial < 120; trial++) {
    const n = int(rand, 4, 180);
    const parity = int(rand, 1, Math.max(1, Math.min(48, n - 1)));
    const payload = data(rand, n - parity);
    const encoded = rsEncode(payload, parity);
    const bad = Uint8Array.from(encoded);
    const t = Math.floor(parity / 2);
    const errors = int(rand, 0, t);
    const positions = new Set();
    while (positions.size < errors) positions.add(int(rand, 0, bad.length - 1));
    for (const p of positions) bad[p] ^= int(rand, 1, 255);
    const decoded = rsDecode(bad, parity);
    assert.equal(
      Buffer.from(decoded.data).toString('hex'),
      Buffer.from(payload).toString('hex'),
      `trial ${trial}: ${errors}/${t} errors, n=${n}, parity=${parity}`,
    );
    assert.equal(decoded.corrected, errors);
  }
});

test('RS block interleaving is lossless', () => {
  const rand = mulberry32(0x5353);
  for (const [total, parityRate] of [[100, 0.2], [255, 0.3], [300, 0.2], [512, 0.4]]) {
    const blocks = computeRSBlocks(total, parityRate);
    const kTotal = blocks.reduce((s, b) => s + b.k, 0);
    const payload = data(rand, kTotal);
    const encoded = rsEncodeBlocks(payload, total, parityRate);
    assert.equal(encoded.length, total);
    const decoded = rsDecodeBlocks(encoded, parityRate);
    assert.equal(Buffer.from(decoded.data).toString('hex'), Buffer.from(payload).toString('hex'));
    assert.equal(decoded.corrected, 0);
  }
});

test('BCH property: accepted words are inside the radius-3 decoding ball', () => {
  const codewords = Array.from({ length: 32 }, (_, m) => bch15Encode(m));
  for (let m = 0; m < 32; m++) assert.equal(bch15Decode(codewords[m]), m);

  const rand = mulberry32(0x1515);
  for (let trial = 0; trial < 2000; trial++) {
    const word = int(rand, 0, 0x7fff);
    const decoded = bch15Decode(word);
    if (decoded < 0) {
      for (const cw of codewords) assert.ok(hamming(cw, word) > 3, 'rejected a word inside radius 3');
      continue;
    }
    assert.ok(decoded <= 31);
    assert.ok(hamming(bch15Encode(decoded), word) <= 3, 'accepted a word outside radius 3');
  }
});

test('frame property: payload and CRC round-trip, header mutations never yield a different payload', () => {
  const rand = mulberry32(0xf4a3);
  for (let trial = 0; trial < 100; trial++) {
    const payload = data(rand, int(rand, 0, 64));
    const frame = buildFrame({ layerId: int(rand, 0, 7), flags: int(rand, 0, 7), payload });
    const parsed = parseFrame(frame);
    assert.equal(Buffer.from(parsed.payload).toString('hex'), Buffer.from(payload).toString('hex'));

    for (let flip = 0; flip < 5; flip++) {
      const bad = Uint8Array.from(frame);
      bad[int(rand, 0, bad.length - 1)] ^= 1 << int(rand, 0, 7);
      let parsedBad = null;
      try {
        parsedBad = parseFrame(bad);
      } catch (err) {
        assert.ok(err instanceof Error);
      }
      if (parsedBad) {
        assert.equal(Buffer.from(parsedBad.payload).toString('hex'), Buffer.from(payload).toString('hex'));
      }
    }
  }
});

test('CRC32 properties: empty vector, determinism, single-bit sensitivity', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  const rand = mulberry32(0xc3c3);
  for (let trial = 0; trial < 50; trial++) {
    const buf = data(rand, int(rand, 1, 64));
    const a = crc32(buf);
    const b = crc32(Uint8Array.from(buf));
    assert.equal(a, b);
    const bad = Uint8Array.from(buf);
    const bit = int(rand, 0, bad.length * 8 - 1);
    bad[bit >> 3] ^= 1 << (bit & 7);
    assert.notEqual(crc32(bad), a, 'single-bit change did not change CRC32');
  }
});

test('bitstream property: write/read round-trip for arbitrary widths', () => {
  const rand = mulberry32(0xb175);
  for (let trial = 0; trial < 100; trial++) {
    const n = int(rand, 0, 200);
    const bits = Array.from({ length: n }, () => int(rand, 0, 1));
    const writer = new BitWriter();
    for (const bit of bits) writer.writeBit(bit);
    const bytes = writer.toBytes();
    const reader = new BitReader(bytes, n);
    for (const bit of bits) assert.equal(reader.readBit(), bit);
    assert.throws(() => reader.readBit(), /end of input/);
  }

  for (let trial = 0; trial < 50; trial++) {
    const value = int(rand, 0, 0xffff);
    const n = int(rand, 0, 16);
    const writer = new BitWriter();
    writer.writeBits(value, n);
    const reader = new BitReader(writer.toBytes(), n);
    assert.equal(reader.readBits(n), value & ((1 << n) - 1));
  }
});

test('format band property: field round-trip and BCH error correction', () => {
  const rand = mulberry32(0xf0f0);
  for (let trial = 0; trial < 100; trial++) {
    const formatBlocks = int(rand, 1, 3);
    const shape = trial % 3 === 0;
    const fields = {
      formatBlocks,
      modeId: shape ? 7 : int(rand, 0, 6),
      eccIndex: int(rand, 0, 3),
      paletteMode: int(rand, 0, 1) ? 'maxmin' : 'harmony',
      harmony: false,
      seed: int(rand, 0, 63),
      constraint: int(rand, 0, 1) === 1,
      compressed: int(rand, 0, 1) === 1,
      encrypted: int(rand, 0, 1) === 1,
      shapeLayerId: shape ? int(rand, 0, 3) : null,
      shapeExt: shape ? int(rand, 0, 1) : 0,
    };
    if (formatBlocks === 1 && shape) continue;
    const chunks = packFormatPayload(fields);
    const decoded = unpackFormatPayload(chunks, formatBlocks);
    assert.equal(decoded.modeId, fields.modeId);
    assert.equal(decoded.eccIndex, fields.eccIndex);
    if (formatBlocks > 1) {
      if (shape) {
        assert.equal(decoded.shapeLayerId, fields.shapeLayerId);
        assert.equal(decoded.shapeExt, fields.shapeExt);
        assert.equal(decoded.seed, formatBlocks === 2 ? (fields.seed & 3) : (fields.seed & 63));
      } else {
        assert.equal(decoded.seed, formatBlocks === 2 ? (fields.seed & 3) : (fields.seed & 63));
        assert.equal(decoded.constraint, fields.constraint);
      }
    }
  }

  // Flip up to 3 bits in each 15-bit BCH codeword and decode through the band.
  const layer = 'G20';
  const paletteInfo = generatePalette(layer, { mode: 'maxmin' });
  const layout = makeLayout({ version: 5, layer, paletteMode: 'maxmin', paletteInfo });
  const chunks = packFormatPayload({
    formatBlocks: layout.format.blocksPerCopy,
    modeId: 1,
    eccIndex: 2,
    paletteMode: 'maxmin',
    harmony: false,
    seed: 1,
    constraint: false,
  });
  const symbols = new Int16Array(layout.N * layout.N).fill(layout.whiteSymbol);
  writeFormatBand(symbols, layout, chunks);
  const read = () => readFormatBand((r, c) => symbols[r * layout.N + c], layout);
  assert.equal(read().modeId, 1);
  const copy = layout.format.copies[0];
  for (let bit = 0; bit < 3; bit++) {
    const j = (bit * 5 + 1) % 15;
    const r = copy.row0 + (j >= 8 ? 1 : 0);
    const c = copy.col0 + (j % 8);
    symbols[r * layout.N + c] = symbols[r * layout.N + c] === layout.blackSymbol
      ? layout.whiteSymbol
      : layout.blackSymbol;
  }
  assert.equal(read().modeId, 1);
});

test('rank constraint property: reversible for gray and colour palettes', () => {
  const rand = mulberry32(0x2a2a);
  for (const layer of ['G20', 'G30', 'C40']) {
    const palette = generatePalette(layer, { mode: 'maxmin' });
    const rc = new RankConstraint(palette);
    const D = int(rand, 100, 800);
    const bits = rc.capacityBitsForModules(D);
    const writer = new BitWriter();
    for (let i = 0; i < bits; i++) writer.writeBit(int(rand, 0, 1));
    const source = writer.toBytes();
    const symbols = rc.encode(new BitReader(source, bits), D);
    for (let i = 1; i < symbols.length; i++) {
      const a = palette.rankOf[symbols[i - 1]];
      const b = palette.rankOf[symbols[i]];
      assert.ok(Math.abs(a - b) <= palette.maxRankDiff, `${layer} rank jump ${a}->${b}`);
    }
    const decoded = rc.decode(symbols, { lenient: true }).toBytes();
    const a = new BitReader(source, bits);
    const b = new BitReader(decoded, bits);
    for (let i = 0; i < bits; i++) assert.equal(a.readBit(), b.readBit(), `${layer} bit ${i}`);
  }
});

test('whitening is an involution for every seed', () => {
  const rand = mulberry32(0x77aa);
  for (const seed of [0, 1, 3, 63]) {
    const payload = data(rand, 128);
    const once = makeWhitening(seed)(payload);
    const round = makeWhitening(seed)(once);
    assert.equal(Buffer.from(round).toString('hex'), Buffer.from(payload).toString('hex'), `seed ${seed}`);
  }
});
