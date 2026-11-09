import test from 'node:test';
import assert from 'node:assert/strict';

import { BitReader, BitWriter } from '../src/bitstream.js';
import { generateGrayPalette } from '../src/color.js';
import { RankConstraint } from '../src/constraint.js';
import { decodeAuto } from '../src/decoder.js';
import { bch15Decode, bch15Encode } from '../src/ecc/bch15.js';
import { rsDecode, rsEncode } from '../src/ecc/rs.js';
import { encode } from '../src/encoder.js';
import { buildFrame, parseFrame } from '../src/frame.js';
import { generatePalette } from '../src/palettes.js';
import { decodePNG, encodePNG } from '../src/png.js';
import { applyHomography, computeHomography } from '../src/detector.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('RS corrects up to t symbol errors', () => {
  const rand = rng(1);
  const data = Uint8Array.from({ length: 60 }, () => Math.floor(rand() * 256));
  const parity = 24;
  const encoded = rsEncode(data, parity);
  const bad = Uint8Array.from(encoded);
  for (let i = 0; i < 12; i++) {
    bad[Math.floor(rand() * bad.length)] ^= 1 + Math.floor(rand() * 255);
  }
  const decoded = rsDecode(bad, parity);
  assert.deepEqual(Array.from(decoded.data), Array.from(data));
  assert.equal(decoded.corrected, 12);
});

test('BCH(15,5) corrects three bit errors', () => {
  for (let m = 0; m < 32; m++) {
    const cw = bch15Encode(m);
    assert.equal(bch15Decode(cw), m);
    const bad = cw ^ (1 << 0) ^ (1 << 5) ^ (1 << 14);
    assert.equal(bch15Decode(bad), m);
  }
});

test('palette nesting: first 16 L3b entries are the L2 grays', () => {
  const gray = generateGrayPalette(16);
  const l3b = generatePalette('L3b', { mode: 'bucketed' });
  assert.equal(l3b.palette.length, 256);
  assert.deepEqual(l3b.palette.slice(0, 16), gray);
  assert.equal(l3b.rankCounts.reduce((a, b) => a + b, 0), 256);
});

test('reversible rank constraint round-trips and satisfies the bound', () => {
  const palette = generatePalette('L3b', { mode: 'bucketed' });
  const rc = new RankConstraint(palette);
  const D = 700;
  const bits = rc.capacityBitsForModules(D);
  const rand = rng(7);
  const writer = new BitWriter();
  for (let i = 0; i < bits; i++) writer.writeBit(rand() < 0.5 ? 0 : 1);
  const source = writer.toBytes();
  const symbols = rc.encode(new BitReader(source, bits), D);
  for (let i = 1; i < symbols.length; i++) {
    assert.ok(Math.abs(palette.rankOf[symbols[i]] - palette.rankOf[symbols[i - 1]]) <= 8);
  }
  const decoded = rc.decode(symbols, { lenient: true }).toBytes();
  const a = new BitReader(source, bits);
  const b = new BitReader(decoded, bits);
  for (let i = 0; i < bits; i++) assert.equal(a.readBit(), b.readBit());
});

test('frame header + CRC round-trip and corruption rejection', () => {
  const payload = new TextEncoder().encode('LCC frame test');
  const frame = buildFrame({ layerId: 3, flags: 0, payload });
  const parsed = parseFrame(frame);
  assert.equal(parsed.layerId, 3);
  assert.deepEqual(Array.from(parsed.payload), Array.from(payload));
  const bad = Uint8Array.from(frame);
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => parseFrame(bad), /CRC/);
});

test('homography maps the four canonical corners', () => {
  const dst = [[100, 80], [800, 120], [60, 760], [820, 700]];
  const H = computeHomography([[0, 0], [10, 0], [0, 10], [10, 10]], dst);
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyHomography(H, i === 1 || i === 3 ? 10 : 0, i >= 2 ? 10 : 0);
    assert.ok(Math.abs(x - dst[i][0]) < 1e-6);
    assert.ok(Math.abs(y - dst[i][1]) < 1e-6);
  }
});

test('clean-image round-trip for all layers', () => {
  const text = 'LCC round-trip 你好';
  for (const layer of ['L1', 'L2', 'L3a', 'L3b']) {
    const result = encode(text, {
      layer,
      width: 512,
      height: 512,
      mode: 'fill',
      maxModulePx: 32,
      constraint: layer !== 'L1',
    });
    const png = encodePNG(result.image);
    const decoded = decodeAuto(decodePNG(png));
    assert.equal(decoded.text, text, `${layer} round-trip`);
  }
});
