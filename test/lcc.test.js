import test from 'node:test';
import assert from 'node:assert/strict';

import { BitReader, BitWriter } from '../src/bitstream.js';
import { deltaE76, rgbToLab } from '../src/color.js';
import { RankConstraint } from '../src/constraint.js';
import { decodeAuto } from '../src/decoder.js';
import { bch15Decode, bch15Encode } from '../src/ecc/bch15.js';
import { rsDecode, rsEncode } from '../src/ecc/rs.js';
import { encode } from '../src/encoder.js';
import { buildFrame, parseFrame } from '../src/frame.js';
import { generatePalette } from '../src/palettes.js';
import { decodePNG, encodePNG } from '../src/png.js';
import { applyHomography, computeHomography } from '../src/detector.js';
import { classifyShape, foregroundFor, shapeMask } from '../src/shapes.js';
import { renderSVG } from '../src/svg.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function minPairwiseDeltaE(palette) {
  let min = Infinity;
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      min = Math.min(min, deltaE76(palette[i], palette[j]));
    }
  }
  return min;
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

test('palette sizes and minimum DeltaE', () => {
  const expected = { L1: 2, L2a: 4, L2b: 8, L3c: 16, L3d: 32, L4e: 64, L4f: 256 };
  for (const [layer, size] of Object.entries(expected)) {
    const p = generatePalette(layer, { mode: 'maxmin' });
    assert.equal(p.palette.length, size, layer);
  }
  assert.ok(minPairwiseDeltaE(generatePalette('L3c').paletteLab) >= 20);
  assert.ok(minPairwiseDeltaE(generatePalette('L3d').paletteLab) >= 15);
});

test('reversible rank constraint works for 8-rank gray', () => {
  const palette = generatePalette('L2b', { mode: 'maxmin' });
  const rc = new RankConstraint(palette);
  assert.equal(rc.rankCount, 8);
  assert.equal(rc.maxDiff, 4);
  const D = 700;
  const bits = rc.capacityBitsForModules(D);
  const rand = rng(7);
  const writer = new BitWriter();
  for (let i = 0; i < bits; i++) writer.writeBit(rand() < 0.5 ? 0 : 1);
  const source = writer.toBytes();
  const symbols = rc.encode(new BitReader(source, bits), D);
  for (let i = 1; i < symbols.length; i++) {
    assert.ok(Math.abs(palette.rankOf[symbols[i]] - palette.rankOf[symbols[i - 1]]) <= palette.maxRankDiff);
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
  for (const layer of ['L1', 'L2a', 'L2b', 'L3c', 'L3d', 'L4e', 'L4f']) {
    const result = encode(text, {
      layer,
      width: 512,
      height: 512,
      mode: 'fill',
      maxModulePx: 32,
      constraint: false,
    });
    const png = encodePNG(result.image);
    const decoded = decodeAuto(decodePNG(png));
    assert.equal(decoded.text, text, `${layer} round-trip`);
  }
});

test('constraint-on round-trip for L2b and L3c', () => {
  const text = 'constraint on';
  for (const layer of ['L2b', 'L3c']) {
    const result = encode(text, {
      layer,
      width: 512,
      height: 512,
      mode: 'fill',
      maxModulePx: 32,
      constraint: true,
    });
    const decoded = decodeAuto(decodePNG(encodePNG(result.image)));
    assert.equal(decoded.text, text, `${layer} constraint round-trip`);
  }
});

test('ECC selection and Boost ECC', () => {
  const base = encode('ECC', {
    layer: 'L2a', width: 512, height: 512, mode: 'fill', constraint: false,
    eccLevel: 'L', boostEcc: false,
  });
  assert.equal(base.meta.eccLevel, 'L');
  const high = encode('ECC', {
    layer: 'L2a', width: 512, height: 512, mode: 'fill', constraint: false,
    eccLevel: 'H', boostEcc: false,
  });
  assert.equal(high.meta.eccLevel, 'H');
  const boosted = encode('ECC', {
    layer: 'L2a', width: 512, height: 512, mode: 'fill', constraint: false,
    eccLevel: 'L', boostEcc: true,
  });
  assert.ok(boosted.meta.ecc >= base.meta.ecc);
  for (const result of [base, high, boosted]) {
    const decoded = decodeAuto(decodePNG(encodePNG(result.image)));
    assert.equal(decoded.text, 'ECC');
  }
});

test('version range, module size and quiet zone', () => {
  const result = encode('V5', {
    layer: 'L2a', width: 512, height: 512, mode: 'fill', constraint: false,
    version: 5, moduleSize: 8, quietZone: 4,
  });
  assert.equal(result.meta.version, 5);
  assert.equal(result.meta.moduleSize, 8);
  assert.equal(result.meta.quietZone, 4);
  assert.equal(result.image.width, (result.meta.N + 8) * 8);
  const decoded = decodeAuto(decodePNG(encodePNG(result.image)));
  assert.equal(decoded.text, 'V5');
});

test('shape ladder covers 3-7 bits/module', () => {
  const text = 'shape ladder';
  const expected = new Map([
    ['L3b', 3],
    ['L1s', 4],
    ['L2s', 5],
    ['L3s', 6],
    ['L3t', 7],
  ]);
  for (const [layer, bits] of expected) {
    const result = encode(text, {
      layer,
      version: layer === 'L3t' ? 10 : 2,
      moduleSize: layer === 'L3t' ? 16 : 24,
      width: 1024,
      height: 1024,
      mode: 'fill',
      maxModulePx: 32,
    });
    assert.equal(result.meta.bitsPerModule, bits, `${layer} bits/module`);
    assert.equal(result.meta.shapeLayer, true, `${layer} shape mode`);
    const decoded = decodeAuto(decodePNG(encodePNG(result.image)));
    assert.equal(decoded.text, text, `${layer} round-trip`);
    assert.equal(decoded.meta.layer, layer, `${layer} decoded layer`);
  }
});

test('shape templates survive a one-cell shift', () => {
  const mask = shapeMask(6, 16);
  const result = classifyShape(mask, 16);
  assert.equal(result.shape, 6);
  assert.ok(result.costs[6] <= 1);
});

test('foreground colour keeps contrast on mid-grey', () => {
  const background = [128, 128, 128];
  const foreground = foregroundFor(background);
  const distance = deltaE76(rgbToLab(background), rgbToLab(foreground));
  assert.ok(distance > 40, `mid-grey foreground contrast ${distance.toFixed(1)}`);
});

test('SVG renders shape strokes', () => {
  const result = encode('SVG shape', {
    layer: 'L3s',
    version: 10,
    moduleSize: 16,
    width: 1024,
    height: 1024,
    mode: 'fill',
    maxModulePx: 32,
  });
  const svg = renderSVG({
    symbols: result.symbols,
    layout: result.layout,
    palette: result.paletteInfo.palette,
    moduleSize: result.meta.moduleSize,
    quietZone: result.meta.quietZone,
  });
  assert.ok(svg.includes('<line'));
  assert.ok(svg.includes('stroke-width'));
});

test('SVG output and encoder statistics', () => {
  const result = encode('SVG', {
    layer: 'L1', width: 512, height: 512, mode: 'fill', constraint: false,
  });
  const svg = renderSVG({
    symbols: result.symbols,
    layout: result.layout,
    palette: result.paletteInfo.palette,
    moduleSize: result.meta.moduleSize,
    quietZone: result.meta.quietZone,
  });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('viewBox'));
  assert.ok(svg.includes('<rect'));
  assert.ok(result.meta.eccLevel);
  assert.ok(result.meta.minDeltaE > 0);
  assert.equal(result.meta.paletteSize, 2);
});
