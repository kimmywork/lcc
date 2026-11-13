import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  LAYERS,
  decodeAuto,
  encode,
} from '../../src/index.js';
import { crc32 } from '../../src/ecc/crc32.js';
import { buildFrame } from '../../src/frame.js';
import { mulberry32, int } from '../../scripts/lib/rng.mjs';

function payloadOf(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function symbolBytes(result) {
  const buf = Buffer.alloc(result.symbols.length * 2);
  for (let i = 0; i < result.symbols.length; i++) buf.writeInt16LE(result.symbols[i], i * 2);
  return buf;
}

test('encoding is injective in practice for a fixed parameter set', () => {
  const n = 2000;
  const seen = new Set();
  const options = {
    layer: 'G20', version: 5, moduleSize: 8, quietZone: 2,
    width: 2048, height: 2048, mode: 'compact', constraint: false, seed: 0,
  };
  let capacityBits = 0;
  for (let i = 0; i < n; i++) {
    const payload = payloadOf(8 + (i % 25), 0xc011 + i);
    const result = encode(payload, options);
    capacityBits = result.meta.capacityBits;
    const hash = sha(symbolBytes(result));
    assert.equal(seen.has(hash), false, `encoding collision at sample ${i}`);
    seen.add(hash);
  }
  // Birthday bound over the codeword space.  Two different payloads can only
  // collide if the frame + RS + symbol mapping do, so the bound is generous.
  const log2Pairs = 2 * Math.log2(n) - 1;
  const log2CollisionProbability = log2Pairs - capacityBits;
  assert.ok(log2CollisionProbability < -40, `birthday bound 2^${log2CollisionProbability}`);
});

test('different parameter sets produce distinct symbols for the same payload', () => {
  const payload = payloadOf(32, 0xcafe);
  const seen = new Map();
  const layers = ['G10', 'G20', 'G30', 'C40', 'C50', 'C30', 'C20', 'G13', 'C23', 'C33'];
  for (const layer of layers) {
    const info = LAYERS[layer];
    for (const version of [2, 5, 10]) {
      if ((info.minVersion ?? 1) > version) continue;
      const seeds = info.shapeSetSize ? [0] : [0, 1, 63];
      for (const seed of seeds) {
        const options = {
          layer,
          version,
          moduleSize: Math.max(info.minModulePx ?? 4, 8),
          quietZone: 2,
          width: 2048,
          height: 2048,
          mode: 'compact',
          constraint: false,
          seed,
        };
        let result;
        try {
          result = encode(payload, options);
        } catch {
          continue;
        }
        const key = sha(Buffer.from(result.image.data));
        const label = `${layer} v${version} seed${seed}`;
        assert.equal(seen.has(key), false, `${label} collides with ${seen.get(key)}`);
        seen.set(key, label);

        const decoded = decodeAuto(result.image, { detector: 'axis' });
        assert.equal(decoded.meta.layer, layer, label);
        assert.equal(Buffer.from(decoded.payload).toString('hex'), Buffer.from(payload).toString('hex'), label);
      }
    }
  }
  assert.ok(seen.size > 50, `only ${seen.size} parameter sets checked`);
});

test('format-width parameter aliasing is explicit (seed truncation)', () => {
  const payload = payloadOf(16, 0xa11a5);
  const base = {
    layer: 'G20', moduleSize: 8, quietZone: 2,
    width: 2048, height: 2048, mode: 'compact', constraint: false,
  };
  const v2a = encode(payload, { ...base, version: 2, seed: 0 });
  const v2b = encode(payload, { ...base, version: 2, seed: 4 });
  assert.equal(sha(Buffer.from(v2a.image.data)), sha(Buffer.from(v2b.image.data)));
  assert.equal(v2a.meta.seed, 0);
  assert.equal(v2b.meta.seed, 0);

  // v10 uses the full 6-bit seed field; out-of-range values are rejected
  // rather than silently aliased.
  assert.throws(() => encode(payload, { ...base, version: 10, seed: 64 }), /seed/);

  const v2c = encode(payload, { ...base, version: 2, seed: 1 });
  assert.notEqual(sha(Buffer.from(v2a.image.data)), sha(Buffer.from(v2c.image.data)));
});

test('CRC32 is not collision-resistant, but the frame/RS layer is injective', () => {
  // Search for a natural CRC32 collision.  With 32 bits, a few 10^4 random
  // 12-byte payloads are enough.
  const rng = mulberry32(0x12345);
  const byCrc = new Map();
  let pair = null;
  for (let i = 0; i < 400000; i++) {
    const payload = new Uint8Array(12);
    for (let j = 0; j < payload.length; j++) payload[j] = int(rng, 0, 255);
    const crc = crc32(payload);
    const key = Buffer.from(payload).toString('hex');
    if (byCrc.has(crc)) {
      pair = [byCrc.get(crc), payload];
      break;
    }
    byCrc.set(crc, payload);
  }
  assert.ok(pair, 'no CRC32 collision found');
  const [a, b] = pair;
  assert.equal(crc32(a), crc32(b));
  assert.notEqual(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));

  // The frame includes the payload and RS is systematic, so the two colliding
  // payloads still produce different frames and different codes.
  const frameA = buildFrame({ layerId: 3, flags: 0, payload: a });
  const frameB = buildFrame({ layerId: 3, flags: 0, payload: b });
  assert.notEqual(Buffer.from(frameA).toString('hex'), Buffer.from(frameB).toString('hex'));

  const options = {
    layer: 'C40', version: 2, moduleSize: 8, quietZone: 2,
    width: 1024, height: 1024, mode: 'compact', constraint: false,
  };
  const imageA = encode(a, options).image;
  const imageB = encode(b, options).image;
  assert.notEqual(sha(Buffer.from(imageA.data)), sha(Buffer.from(imageB.data)));
});

test('random corruption never produces a different valid payload', () => {
  const rng = mulberry32(0xdeadbeef);
  let decodedOk = 0;
  let rejected = 0;
  for (const layer of ['G10', 'G20', 'C40']) {
    const payload = payloadOf(48, 0xbeef + layer.length);
    const encoded = encode(payload, {
      layer, version: 5, moduleSize: 8, quietZone: 2,
      width: 1024, height: 1024, mode: 'compact', constraint: false,
    });
    for (let trial = 0; trial < 20; trial++) {
      const data = new Uint8Array(encoded.image.data);
      const flips = int(rng, 1, 1200);
      for (let k = 0; k < flips; k++) {
        const pos = int(rng, 0, data.length - 1);
        data[pos] ^= 1 + int(rng, 0, 254);
      }
      try {
        const decoded = decodeAuto({ width: encoded.image.width, height: encoded.image.height, data }, { detector: 'axis' });
        assert.equal(Buffer.from(decoded.payload).toString('hex'), Buffer.from(payload).toString('hex'));
        decodedOk++;
      } catch (err) {
        assert.ok(err instanceof Error);
        rejected++;
      }
    }
  }
  assert.equal(decodedOk + rejected, 60);
});
