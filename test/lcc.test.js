import test from 'node:test';
import assert from 'node:assert/strict';

import { BitReader, BitWriter } from '../src/bitstream.js';
import { deltaE76, rgbToLab } from '../src/color.js';
import { RankConstraint } from '../src/constraint.js';
import { decodeAuto, detectSymbol } from '../src/decoder.js';
import { buildIlluminationModel } from '../src/illumination.js';
import { makeLayout } from '../src/layout.js';
import { bch15Decode, bch15Encode } from '../src/ecc/bch15.js';
import { rsDecode, rsEncode } from '../src/ecc/rs.js';
import { encode } from '../src/encoder.js';
import { LAYERS, LEGACY_LAYER_ALIASES, SHAPE_LAYER_BY_ID, resolveLayerName, resolveShapeLayer } from '../src/constants.js';
import { buildFrame, parseFrame } from '../src/frame.js';
import { generatePalette } from '../src/palettes.js';
import { decodePNG, encodePNG } from '../src/png.js';
import { applyHomography, computeHomography } from '../src/detector.js';
import { classifyShape, foregroundFor, shapeMask, shapeSegmentsNormalized } from '../src/shapes.js';
import { stackCanonicalFrames } from '../src/stack.js';
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
  assert.ok(minPairwiseDeltaE(generatePalette('C40').paletteLab) >= 20);
  assert.ok(minPairwiseDeltaE(generatePalette('C50').paletteLab) >= 15);
});

test('reversible rank constraint works for 8-rank gray', () => {
  const palette = generatePalette('G30', { mode: 'maxmin' });
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
  for (const layer of ['G10', 'G20', 'G30', 'C40', 'C50', 'C60', 'C80']) {
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
  for (const layer of ['G30', 'C40']) {
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
    layer: 'G20', width: 512, height: 512, mode: 'fill', constraint: false,
    eccLevel: 'L', boostEcc: false,
  });
  assert.equal(base.meta.eccLevel, 'L');
  const high = encode('ECC', {
    layer: 'G20', width: 512, height: 512, mode: 'fill', constraint: false,
    eccLevel: 'H', boostEcc: false,
  });
  assert.equal(high.meta.eccLevel, 'H');
  const boosted = encode('ECC', {
    layer: 'G20', width: 512, height: 512, mode: 'fill', constraint: false,
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
    layer: 'G20', width: 512, height: 512, mode: 'fill', constraint: false,
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
    ['C30', 3],
    ['G13', 4],
    ['G23', 5],
    ['G33', 6],
    ['C33', 6],
    ['C43', 7],
  ]);
  for (const [layer, bits] of expected) {
    const result = encode(text, {
      layer,
      version: layer === 'C43' ? 10 : 2,
      moduleSize: layer === 'C43' ? 16 : 24,
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

test('C43 uses large modules for small payloads', () => {
  for (const quietZone of [2, 4]) {
    const result = encode('tiny', {
      layer: 'C43',
      width: 1024,
      height: 1024,
      mode: 'fill',
      quietZone,
      maxModulePx: 32,
    });
    assert.equal(result.meta.version, 2);
    assert.ok(result.meta.moduleSize >= 30, `C43 module size ${result.meta.moduleSize}`);
    const decoded = decodeAuto(decodePNG(encodePNG(result.image)));
    assert.equal(decoded.text, 'tiny');
  }
});

test('32-shape rich layers round-trip', () => {
  const text = 'rich shapes 32';
  for (const layer of ['G15', 'G25', 'G35', 'C25', 'C35', 'C45', 'C55', 'C65', 'C85']) {
    const result = encode(text, {
      layer,
      width: 1024,
      height: 1024,
      mode: 'fill',
      moduleSize: 16,
      constraint: false,
      maxModulePx: 32,
      version: layer === 'C85' ? 6 : undefined,
    });
    assert.equal(result.meta.shapeSetSize, 32, `${layer} shape set`);
    assert.equal(result.meta.bitsPerModule, { G15: 6, G25: 7, G35: 8, C25: 7, C35: 8, C45: 9, C55: 10, C65: 11, C85: 13 }[layer], `${layer} bits`);
    const decoded = decodeAuto(decodePNG(encodePNG(result.image)));
    assert.equal(decoded.text, text, `${layer} round-trip`);
    assert.equal(decoded.meta.layer, layer, `${layer} layer`);
  }
});

test('canonical layer matrix and legacy aliases are consistent', () => {
  for (const [name, layer] of Object.entries(LAYERS)) {
    const colorBits = Math.log2(layer.paletteSize);
    const shapeBits = Math.log2(layer.shapeSetSize ?? 1);
    assert.equal(layer.bitsPerModule, colorBits + shapeBits, `${name} bits`);
    if (layer.kind === 'gray') {
      assert.equal(layer.levels, layer.paletteSize, `${name} gray levels`);
    } else {
      assert.equal(layer.colors, layer.paletteSize, `${name} colors`);
    }
    if (layer.shapeSetSize) {
      assert.equal(
        resolveShapeLayer(layer.shapeLayerId, layer.shapeExt, layer.shapeVariant ?? 0),
        name,
        `${name} shape code`,
      );
    }
  }
  for (const [legacy, canonical] of LEGACY_LAYER_ALIASES) {
    assert.equal(resolveLayerName(legacy), canonical, `${legacy} alias`);
    assert.ok(LAYERS[canonical], `${canonical} exists`);
  }
});

test('legacy layer lookups and shape-map export remain available', () => {
  assert.equal(LAYERS.L1, LAYERS.G10);
  assert.equal(LAYERS.L3c, LAYERS.C40);
  assert.equal(Object.keys(LAYERS).includes('L1'), false);
  assert.equal(SHAPE_LAYER_BY_ID.get(1), 'G13');
  assert.throws(
    () => encode('shape seed', { layer: 'G13', width: 512, height: 512, seed: 1 }),
    /shape layers reserve the format seed field/,
  );
});

test('renderSVG accepts a layer object', () => {
  const result = encode('svg object', {
    layer: 'C23',
    width: 512,
    height: 512,
    mode: 'fill',
    constraint: false,
    maxModulePx: 32,
  });
  const svg = renderSVG({
    symbols: result.symbols,
    layout: result.layout,
    palette: result.paletteInfo.palette,
    layer: LAYERS.C23,
  });
  assert.ok(svg.includes('<line'), 'shape strokes are rendered');
});

test('all 32 shape masks are non-empty and distinct', () => {
  const seen = new Set();
  for (let shape = 1; shape < 32; shape++) {
    const mask = shapeMask(shape, 16);
    const coverage = mask.reduce((sum, v) => sum + v, 0);
    assert.ok(coverage > 0, `shape ${shape} empty`);
    const key = Array.from(mask).join('');
    assert.ok(!seen.has(key), `shape ${shape} duplicates another mask`);
    seen.add(key);
  }
});

test('32-shape arrow geometry uses full shafts', () => {
  const near = (value, expected, label) => {
    assert.ok(Math.abs(value - expected) < 1e-9, `${label}: ${value} != ${expected}`);
  };
  const length = ([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1);
  const shafts = [
    [12, [0.0625, 0.5, 0.9375, 0.5], [0.0625, 0.5]],
    [13, [0.5, 0.0625, 0.5, 0.9375], [0.5, 0.0625]],
    [14, [0.0625, 0.5, 0.9375, 0.5], [0.9375, 0.5]],
    [15, [0.5, 0.0625, 0.5, 0.9375], [0.5, 0.9375]],
  ];
  for (const [shape, shaft, tip] of shafts) {
    const segments = shapeSegmentsNormalized(shape);
    assert.equal(segments.length, 3, `shape ${shape} segment count`);
    for (let i = 0; i < 4; i++) near(segments[0][i], shaft[i], `shape ${shape} shaft`);
    for (const head of segments.slice(1)) {
      near(head[0], tip[0], `shape ${shape} head x`);
      near(head[1], tip[1], `shape ${shape} head y`);
      near(length(head), Math.SQRT2 * 0.4375, `shape ${shape} head length`);
    }
  }

  const diagonals = [
    [16, [0.0625, 0.0625, 0.9375, 0.9375], [0.0625, 0.0625]],
    [17, [0.0625, 0.9375, 0.9375, 0.0625], [0.9375, 0.0625]],
    [18, [0.0625, 0.0625, 0.9375, 0.9375], [0.9375, 0.9375]],
    [19, [0.9375, 0.0625, 0.0625, 0.9375], [0.0625, 0.9375]],
  ];
  for (const [shape, diagonal, tip] of diagonals) {
    const segments = shapeSegmentsNormalized(shape);
    assert.equal(segments.length, 3, `shape ${shape} segment count`);
    for (let i = 0; i < 4; i++) near(segments[0][i], diagonal[i], `shape ${shape} diagonal`);
    for (const head of segments.slice(1)) {
      near(head[0], tip[0], `shape ${shape} head x`);
      near(head[1], tip[1], `shape ${shape} head y`);
      near(length(head), 0.4375, `shape ${shape} head length`);
    }
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

test('multi-frame stacking decodes a noisy burst', () => {
  const text = 'stack test';
  const result = encode(text, {
    layer: 'C33',
    version: 2,
    moduleSize: 24,
    width: 1024,
    height: 1024,
    mode: 'fill',
    maxModulePx: 32,
  });
  const noisy = (image, sigma, seed) => {
    const rand = rng(seed);
    const data = new Uint8Array(image.data.length);
    for (let i = 0; i < data.length; i++) {
      const u1 = Math.max(1e-9, rand());
      const u2 = rand();
      const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
      data[i] = Math.max(0, Math.min(255, Math.round(image.data[i] + g)));
    }
    return { width: image.width, height: image.height, data };
  };
  const frames = [];
  const detections = [];
  for (let i = 0; i < 3; i++) {
    const frame = noisy(result.image, 20, 100 + i);
    frames.push(frame);
    detections.push(detectSymbol(frame));
  }
  const stacked = stackCanonicalFrames(frames, detections, { quietZone: 4 });
  assert.equal(stacked.stacked, true);
  assert.ok(stacked.frames >= 2);
  const decoded = decodeAuto(stacked.image);
  assert.equal(decoded.text, text);
});

function applyChannelCast(image, gain, bias = [0, 0, 0]) {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = image.data[i + c] * gain[c] + bias[c];
      data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: image.width, height: image.height, data };
}

test('locator white balance corrects neutral colour cast', () => {
  const text = 'cast';
  const casts = {
    warm: [[1, 0.82, 0.62], [0, 0, 0]],
    cool: [[0.62, 0.82, 1], [0, 0, 0]],
    red: [[0.55, 1, 1], [8, 0, 0]],
  };
  for (const layer of ['C40', 'C33']) {
    const result = encode(text, {
      layer,
      version: 2,
      moduleSize: 24,
      width: 1024,
      height: 1024,
      mode: 'fill',
      maxModulePx: 32,
      constraint: false,
    });
    const clean = decodeAuto(result.image);
    assert.equal(clean.text, text, `${layer} clean`);
    const det = detectSymbol(result.image);
    const pointAt = (row, col) => [
      det.originX + (col + 0.5) * det.s,
      det.originY + (row + 0.5) * det.s,
    ];
    const layout = makeLayout({ version: det.version, layer: 'G10' });
    const neutral = buildIlluminationModel({ layout, image: result.image, pointAt });
    assert.equal(neutral.chromatic, false, `${layer} clean locators stay neutral`);

    for (const [name, [gain, bias]] of Object.entries(casts)) {
      const cast = applyChannelCast(result.image, gain, bias);
      const castDet = detectSymbol(cast);
      const castPoint = (row, col) => [
        castDet.originX + (col + 0.5) * castDet.s,
        castDet.originY + (row + 0.5) * castDet.s,
      ];
      const model = buildIlluminationModel({
        layout: makeLayout({ version: castDet.version, layer: 'G10' }),
        image: cast,
        pointAt: castPoint,
      });
      assert.equal(model.chromatic, true, `${layer} ${name} enables per-channel correction`);
      const decoded = decodeAuto(cast);
      assert.equal(decoded.text, text, `${layer} ${name} cast`);
    }
  }
});

test('SVG renders shape strokes', () => {
  const result = encode('SVG shape', {
    layer: 'C33',
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
    layer: 'G10', width: 512, height: 512, mode: 'fill', constraint: false,
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
