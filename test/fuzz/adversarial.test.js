import test from 'node:test';
import assert from 'node:assert/strict';

import { LAYERS, decodeAuto, encode } from '../../src/index.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { decodeAutoWasm } from '../../src/lcc-wasm.js';
import { bytes, gaussian, int, mulberry32, pick } from '../../scripts/lib/rng.mjs';

/**
 * Deterministic, fast regression subset of scripts/fuzz-lcc.mjs.  The full
 * harness explores thousands of cases; this file only pins the invariants that
 * must hold on every `npm test`.
 */

test('random PNG bytes are always rejected', () => {
  const rng = mulberry32(0x9001);
  for (let i = 0; i < 100; i++) {
    const input = bytes(rng, int(rng, 0, 256));
    assert.throws(() => decodePNG(input), Error, `input ${i}`);
  }
});

test('mutated valid PNGs are rejected or decoded consistently', () => {
  const rng = mulberry32(0x9002);
  const png = encodePNG(encode('png fuzz', {
    layer: 'G20', version: 2, moduleSize: 16, width: 512, height: 512, mode: 'compact',
  }).image);
  for (let i = 0; i < 60; i++) {
    const copy = Buffer.from(png);
    const edits = int(rng, 1, 4);
    for (let e = 0; e < edits; e++) copy[int(rng, 0, copy.length - 1)] ^= 1 + int(rng, 0, 254);
    let image = null;
    try {
      image = decodePNG(copy);
    } catch (err) {
      assert.ok(err instanceof Error, `edit ${i} threw non-Error`);
    }
    if (image) assert.equal(image.data.length, image.width * image.height * 3);
  }
});

test('random image objects never crash decodeAuto', () => {
  const rng = mulberry32(0x9003);
  for (let i = 0; i < 40; i++) {
    const width = int(rng, 1, 32);
    const height = int(rng, 1, 32);
    const image = { width, height, data: bytes(rng, width * height * 3) };
    try {
      decodeAuto(image, { detector: pick(rng, ['axis', 'perspective', 'auto']) });
    } catch (err) {
      assert.ok(err instanceof Error, `case ${i} threw non-Error`);
    }
  }
});

test('damaged symbols decode to the exact payload or throw', () => {
  const rng = mulberry32(0x9004);
  for (const layer of ['G10', 'G20', 'C40']) {
    const payload = 'fuzz invariant';
    const encoded = encode(payload, {
      layer, version: 4, moduleSize: 12, quietZone: 2,
      width: 1024, height: 1024, mode: 'compact', constraint: false,
    });
    for (const sigma of [5, 20, 60]) {
      const data = new Uint8Array(encoded.image.data.length);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.max(0, Math.min(255, Math.round(encoded.image.data[i] + gaussian(rng) * sigma)));
      }
      let decoded = null;
      try {
        decoded = decodeAuto({ width: encoded.image.width, height: encoded.image.height, data }, { detector: 'axis' });
      } catch (err) {
        assert.ok(err instanceof Error, `${layer} sigma ${sigma} threw non-Error`);
      }
      if (decoded) assert.equal(decoded.text, payload, `${layer} sigma ${sigma} wrong payload`);
    }
  }
});

test('random encoder options succeed with a valid image or throw a descriptive Error', () => {
  const rng = mulberry32(0x9005);
  let successes = 0;
  for (let i = 0; i < 120; i++) {
    const layer = pick(rng, Object.keys(LAYERS));
    const shape = !!LAYERS[layer].shapeSetSize;
    const gentle = rng() < 0.5;
    const options = {
      layer,
      width: gentle ? pick(rng, [256, 512, 1024]) : pick(rng, [64, 256, 512, 0, -8, NaN]),
      height: gentle ? pick(rng, [256, 512, 1024]) : pick(rng, [256, 512, 0]),
      mode: gentle ? 'fill' : pick(rng, ['fill', 'compact', 'bogus']),
      constraint: rng() < 0.5,
      eccLevel: gentle ? 'auto' : pick(rng, ['auto', 'L', 'M', 'Q', 'H', 'Z']),
      moduleSize: gentle ? undefined : pick(rng, [undefined, 0, 4, 12, 16, 32, 65]),
      quietZone: gentle ? 2 : pick(rng, [-1, 0, 2, 4]),
      seed: shape ? 0 : (gentle ? pick(rng, [0, 1, 63]) : pick(rng, [0, 1, 63, 64, NaN])),
      minVersion: gentle ? undefined : pick(rng, [undefined, 1, 5, 101]),
      maxVersion: gentle ? undefined : pick(rng, [undefined, 2, 100, 101]),
    };
    let result = null;
    try {
      result = encode(bytes(rng, int(rng, 0, 180)), options);
    } catch (err) {
      assert.ok(err instanceof Error, `case ${i} threw non-Error`);
      assert.match(err.message, /^LCC:/, `case ${i}: ${err.message}`);
    }
    if (result) {
      successes++;
      assert.ok(result.image.width > 0 && result.image.height > 0);
      assert.equal(result.image.data.length, result.image.width * result.image.height * 3);
    }
  }
  assert.ok(successes > 0, 'no random case succeeded');
});

test('C core rejects hostile buffers without killing the process', async () => {
  await assert.rejects(
    async () => decodeAutoWasm({ width: 65536, height: 65536, data: new Uint8Array(64) }, { detector: 'axis' }),
    Error,
  );
  await assert.rejects(
    async () => decodeAutoWasm({ width: -1, height: 64, data: new Uint8Array(192) }, { detector: 'axis' }),
    Error,
  );
});
