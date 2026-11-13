import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYERS,
  capacityFor,
  decode,
  encode,
  generatePalette,
  makeLayout,
  sizeToVersion,
  versionToSize,
} from '../../src/index.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { mulberry32, bytes } from '../../scripts/lib/rng.mjs';

const LAYER_NAMES = Object.keys(LAYERS);
const BASE_LAYERS = ['G10', 'G20', 'G30', 'C40', 'C50', 'C60', 'C80'];

function payload(n, seed = 1) {
  return bytes(mulberry32(seed), n);
}

test('encode is deterministic for the same input and options', () => {
  for (const layer of ['G10', 'G20', 'C40', 'C33']) {
    const options = {
      layer,
      version: 4,
      moduleSize: 12,
      width: 512,
      height: 512,
      mode: 'fill',
      constraint: false,
      seed: layer === 'C33' ? 0 : 2,
      quietZone: 2,
    };
    const a = encode('deterministic', options);
    const b = encode('deterministic', options);
    assert.equal(Buffer.from(a.image.data).toString('hex'), Buffer.from(b.image.data).toString('hex'), layer);
    assert.deepEqual(Array.from(a.symbols), Array.from(b.symbols), layer);
    assert.deepEqual(a.meta, b.meta, layer);
  }
});

test('metadata, dimensions, and symbol domain are consistent for every layer', () => {
  const text = 'invariants';
  for (const layerName of LAYER_NAMES) {
    const layer = LAYERS[layerName];
    const result = encode(text, {
      layer: layerName,
      version: 5,
      moduleSize: 24,
      quietZone: 2,
      width: 2048,
      height: 2048,
      mode: 'compact',
      constraint: false,
    });
    const { meta, layout, symbols, image } = result;
    assert.equal(meta.layer, layerName);
    assert.equal(meta.version, 5, layerName);
    assert.equal(meta.N, versionToSize(5), layerName);
    assert.equal(meta.quietZone, 2, layerName);
    assert.equal(image.width, (meta.N + 4) * meta.moduleSize, layerName);
    assert.equal(image.height, image.width, layerName);
    assert.equal(image.data.length, image.width * image.height * 3, layerName);
    assert.equal(symbols.length, meta.N * meta.N, layerName);
    assert.equal(layout.dataCoords.length, layout.dataCount, layerName);
    assert.equal(layout.functionCount + layout.dataCount, meta.N * meta.N, layerName);

    const colorBits = Math.log2(layer.paletteSize);
    const shapeBits = Math.log2(layer.shapeSetSize ?? 1);
    if (!meta.constraint) {
      assert.equal(meta.bitsPerModule, colorBits + shapeBits, layerName);
    }
    const maxSymbol = (layer.shapeSetSize ?? 1) * layer.paletteSize;
    for (const [r, c] of layout.dataCoords) {
      const s = symbols[r * meta.N + c];
      assert.ok(s >= 0 && s < maxSymbol, `${layerName} symbol ${s} at ${r},${c}`);
    }

    const png = encodePNG(image);
    const back = decodePNG(png);
    assert.equal(back.width, image.width, layerName);
    assert.equal(back.height, image.height, layerName);
    assert.equal(Buffer.from(back.data).toString('hex'), Buffer.from(image.data).toString('hex'), layerName);
  }
});

test('payload capacity boundary: exact fit succeeds, one extra byte fails', () => {
  for (const [layerName, constraint] of [
    ['G10', false],
    ['G20', false],
    ['G30', true],
    ['C40', false],
    ['C55', false],
  ]) {
    const version = 5;
    const paletteInfo = generatePalette(layerName, { mode: 'maxmin' });
    const layout = makeLayout({ version, layer: layerName, paletteMode: 'maxmin', paletteInfo });
    const cap = capacityFor(layout, layerName, paletteInfo, constraint, undefined);
    assert.ok(cap.payloadCapacity > 0, layerName);
    const options = {
      layer: layerName,
      version,
      moduleSize: 16,
      width: 1024,
      height: 1024,
      mode: 'compact',
      constraint,
    };
    const exact = encode(payload(cap.payloadCapacity, 5), options);
    assert.equal(exact.meta.payloadSize, cap.payloadCapacity, layerName);
    assert.throws(
      () => encode(payload(cap.payloadCapacity + 1, 5), options),
      /does not fit|too large/,
      layerName,
    );
  }
});

test('capacity grows with version and matches bits per module', () => {
  for (const layerName of BASE_LAYERS) {
    const paletteInfo = generatePalette(layerName, { mode: 'maxmin' });
    let previous = -1;
    for (const version of [1, 2, 5, 10, 20, 40]) {
      if (LAYER_NAMES.includes(layerName) && (LAYERS[layerName].minVersion ?? 1) > version) continue;
      const layout = makeLayout({ version, layer: layerName, paletteMode: 'maxmin', paletteInfo });
      const cap = capacityFor(layout, layerName, paletteInfo, false, undefined);
      assert.ok(cap.payloadCapacity >= previous, `${layerName} v${version} capacity regressed`);
      previous = cap.payloadCapacity;
      assert.equal(cap.S, Math.floor(cap.capacityBits / 8), `${layerName} v${version} RS bytes`);
      assert.ok(cap.kTotal <= cap.S, `${layerName} v${version} data > total`);
      assert.equal(cap.payloadCapacity, cap.kTotal - 13, `${layerName} v${version} header`);
    }
  }
});

test('seed is truncated to the format band capacity', () => {
  const cases = [
    [2, 3],
    [5, 3],
    [10, 63],
  ];
  for (const [version, expected] of cases) {
    const result = encode('seed', {
      layer: 'G20',
      version,
      moduleSize: 12,
      width: 2048,
      height: 2048,
      mode: 'compact',
      constraint: false,
      seed: 63,
    });
    assert.equal(result.meta.seed, expected, `v${version}`);
  }
});

test('invalid options fail with a descriptive Error', () => {
  const cases = [
    [() => encode('x', { layer: 'NOPE' }), /unknown layer|Unknown layer/],
    [() => encode('x', { layer: 'G10', eccLevel: 'Z' }), /eccLevel/],
    [() => encode('x', { layer: 'G10', version: 101 }), /version/],
    [() => encode('x', { layer: 'G10', minVersion: 5, maxVersion: 2 }), /version range/],
    [() => encode('x'.repeat(10000), { layer: 'G10', width: 64, height: 64 }), /does not fit|too large/],
    [() => encode('x', { layer: 'G13', seed: 1 }), /shape layers reserve/],
    [() => encode('x', { layer: 'G10', width: 0, height: 0 }), /width/],
    [() => encode('x', { layer: 'G10', version: 0 }), /version/],
    [() => encode('x', { layer: 'G10', quietZone: -1 }), /quietZone/],
    [() => encode('x', { layer: 'G10', moduleSize: 0 }), /moduleSize/],
  ];
  for (const [fn, pattern] of cases) {
    assert.throws(fn, pattern);
  }
});

test('explicit detector options decode the expected geometry', () => {
  const encoded = encode('options', {
    layer: 'G10', width: 512, height: 512, mode: 'fill', constraint: false,
  });
  const image = encoded.image;
  assert.equal(decode(image).text, 'options');
  const explicit = decode(image, {
    moduleSize: encoded.meta.moduleSize,
    version: encoded.meta.version,
    origin: { x: encoded.meta.quietZone * encoded.meta.moduleSize, y: encoded.meta.quietZone * encoded.meta.moduleSize },
  });
  assert.equal(explicit.text, 'options');
  assert.throws(
    () => decode(image, { moduleSize: 4, version: 100, origin: { x: 0, y: 0 } }),
    Error,
  );
});

test('size/version mapping is bijective on the supported grid', () => {
  for (let version = 1; version <= 100; version++) {
    const n = versionToSize(version);
    assert.equal(n, 21 + 4 * (version - 1));
    assert.equal(sizeToVersion(n), version);
  }
  for (const n of [20, 22, 24, 26, 39, 43]) assert.equal(sizeToVersion(n), null, String(n));
});
