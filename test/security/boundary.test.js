import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { decodeAuto, encode, stackCanonicalFrames } from '../../src/index.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { crc32 } from '../../src/ecc/crc32.js';
import { debugResidualsForcedWasm, decodeAutoWasm, stackCanonicalFramesWasm } from '../../docs/lib/lcc-wasm.js';
import { bytes, int, mulberry32 } from '../../scripts/lib/rng.mjs';

function mutatePNG(png, mutate, { fixCrc = false } = {}) {
  const copy = Buffer.from(png);
  mutate(copy);
  if (fixCrc) {
    // IHDR: length at 8..12, type 12..16, data 16..29, CRC 29..33.
    copy.writeUInt32BE(crc32(Buffer.concat([copy.subarray(12, 16), copy.subarray(16, 29)])), 29);
  }
  return copy;
}

test('PNG parser rejects random input and absurd headers without crashing', () => {
  const rng = mulberry32(0xdead);
  for (let i = 0; i < 200; i++) {
    const input = bytes(rng, int(rng, 0, 256));
    assert.throws(() => decodePNG(input), Error, `random input ${i}`);
  }

  const valid = encodePNG(encode('png boundary', {
    layer: 'G20', version: 2, moduleSize: 16, width: 512, height: 512, mode: 'compact',
  }).image);

  for (const [name, mutate, pattern, fixCrc] of [
    ['bad signature', (b) => { b[0] ^= 0xff; }, /bad signature/, false],
    ['huge width', (b) => { b.writeUInt32BE(0xffffffff, 16); }, /image too large/, true],
    ['huge height', (b) => { b.writeUInt32BE(0xffffffff, 20); }, /image too large/, true],
    ['bad bit depth', (b) => { b[24] = 16; }, /unsupported bit depth/, true],
    ['interlaced', (b) => { b[28] = 1; }, /interlaced/, true],
    ['bad color type', (b) => { b[25] = 0; }, /unsupported color type/, true],
    ['bad CRC', (b) => { b[24] ^= 1; }, /bad CRC/, false],
  ]) {
    const t0 = performance.now();
    assert.throws(() => decodePNG(mutatePNG(valid, mutate, { fixCrc })), pattern, name);
    assert.ok(performance.now() - t0 < 2000, `${name} was slow`);
  }
});

test('JS decoder contains hostile image objects (no crash, bounded time)', () => {
  const cases = [
    ['zero dims', { width: 0, height: 0, data: new Uint8Array(0) }],
    ['negative dims', { width: -8, height: -8, data: new Uint8Array(64) }],
    ['missing data', { width: 64, height: 64, data: new Uint8Array(0) }],
    ['data too large', { width: 4, height: 4, data: new Uint8Array(4096) }],
    ['NaN dims', { width: NaN, height: NaN, data: new Uint8Array(64) }],
    ['declared 2k x 2k, empty data', { width: 2048, height: 2048, data: new Uint8Array(0) }],
  ];
  for (const [name, image] of cases) {
    const t0 = performance.now();
    try {
      decodeAuto(image, { detector: 'axis' });
    } catch (err) {
      assert.ok(err instanceof Error, `${name} threw a non-Error`);
    }
    const ms = performance.now() - t0;
    assert.ok(ms < 10000, `${name} took ${ms.toFixed(0)} ms`);
  }
});

test('C core traps are contained by the loader (process survives malformed buffers)', async () => {
  const encoded = encode('wasm boundary', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  });
  const det = { version: 2, N: 25, s: 24, score: 1 };

  const baseline = await decodeAutoWasm(encoded.image, { detector: 'axis' });
  assert.equal(baseline.text, 'wasm boundary');

  await assert.rejects(
    decodeAutoWasm({ width: 65536, height: 65536, data: new Uint8Array(64) }, { detector: 'axis' }),
    Error,
  );
  await assert.rejects(
    stackCanonicalFramesWasm(
      [encoded.image, encoded.image],
      [{ ...det, N: 4096 }, { ...det, N: 4096 }],
      { moduleSize: 16, quietZone: 0, maxDimension: 2147483647 },
    ),
    Error,
  );
});

test('C API rejects mismatched buffer lengths without a trap', async () => {
  await assert.rejects(
    decodeAutoWasm({ width: 1024, height: 1024, data: new Uint8Array(64) }, { detector: 'axis' }),
    (err) => err instanceof Error && err.name !== 'RuntimeError' && /decode failed/.test(err.message),
  );
  await assert.rejects(
    decodeAutoWasm({ width: 65536, height: 65536, data: new Uint8Array(64) }, { detector: 'axis' }),
    (err) => err instanceof Error && err.name !== 'RuntimeError' && /decode failed/.test(err.message),
  );
});

test('forced-debug and stack homographies reject unsafe projections', async () => {
  const encoded = encode('homography boundary', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  });
  const zero = Array(9).fill(0);
  const debug = await debugResidualsForcedWasm(encoded.image, zero, 2, 25, 24);
  assert.equal(debug.status, 2);
  const huge = [1e12, 0, 1e12, 0, 1e12, 1e12, 0, 0, 1e-3];
  await assert.rejects(
    stackCanonicalFramesWasm(
      [encoded.image, encoded.image],
      [
        { version: 2, N: 25, s: 24, score: 1, has_h: true, homography: huge },
        { version: 2, N: 25, s: 24, score: 1, has_h: true, homography: huge },
      ],
      { moduleSize: 16, quietZone: 4 },
    ),
    /stack failed/,
  );
});

test('C stack parser rejects overflowing N/module combinations without a trap', async () => {
  const encoded = encode('stack boundary', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  });
  const det = { version: 2, N: 4096, s: 16, score: 1 };
  await assert.rejects(
    stackCanonicalFramesWasm([encoded.image, encoded.image], [det, det], {
      moduleSize: 16, quietZone: 0, maxDimension: 2147483647,
    }),
    (err) => err instanceof Error && err.name !== 'RuntimeError' && /stack failed/.test(err.message),
  );
});

test('wasm instance stays usable after a rejected malformed input', async () => {
  const encoded = encode('recovery', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  });
  await assert.rejects(
    decodeAutoWasm({ width: 1024, height: 1024, data: new Uint8Array(64) }, { detector: 'axis' }),
    Error,
  );
  const decoded = await decodeAutoWasm(encoded.image, { detector: 'axis' });
  assert.equal(decoded.text, 'recovery');
});

test('encoder rejects negative or non-integer geometry options', () => {
  assert.throws(() => encode('x', { layer: 'G20', quietZone: -1 }), /quietZone/);
  assert.throws(() => encode('x', { layer: 'G20', moduleSize: 0 }), /moduleSize/);
  assert.throws(() => encode('x', { layer: 'G20', version: 0 }), /version/);
  assert.throws(() => encode('x', { layer: 'G20', width: 0 }), /width/);
  assert.throws(() => encode('x', { layer: 'G20', seed: -1 }), /seed/);
});

test('PNG parser enforces a pixel budget before inflating', () => {
  const png = encodePNG(encode('png budget', {
    layer: 'G20', version: 2, moduleSize: 16, width: 512, height: 512, mode: 'compact',
  }).image);
  assert.throws(() => decodePNG(png, { maxPixels: 100 }), /too large/);
});

test('JS stack builder rejects output above the shared pixel budget', () => {
  const frame = encode('stack budget', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  }).image;
  const det = { version: 40, N: 177, s: 32, score: 1 };
  assert.throws(
    () => stackCanonicalFrames([frame, frame], [det, det], {
      quietZone: 4, moduleSize: 32, maxDimension: 8192,
    }),
    /pixel budget/,
  );
});

test('JS decoder rejects inconsistent image objects before allocation', () => {
  assert.throws(
    () => decodeAuto({ width: 1024, height: 1024, data: new Uint8Array(300) }, { detector: 'axis' }),
    /data length/,
  );
  assert.throws(
    () => decodeAuto({ width: 65536, height: 65536, data: new Uint8Array(3) }, { detector: 'axis' }),
    /too large/,
  );
});
