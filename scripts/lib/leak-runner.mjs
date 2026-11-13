/**
 * Leak / repeat-stability child process.
 *
 * Run by test/security/memory.test.js with --expose-gc:
 *   node --expose-gc scripts/lib/leak-runner.mjs
 *
 * Prints one JSON line.  Kept out of *.test.js so it is not discovered by the
 * test runner itself.
 */
import { performance } from 'node:perf_hooks';

import { decodeAuto, encode } from '../../src/index.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { decodeAutoWasm, wasmMemoryStats } from '../../docs/lib/lcc-wasm.js';
import { mulberry32 } from './rng.mjs';

const ITER = Number(process.env.LEAK_ITER) || 200;

function heap() {
  if (typeof global.gc === 'function') global.gc();
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers };
}

function payload(seed, n) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

async function main() {
  const rng = mulberry32(424242);
  const fixtures = [];
  for (const layer of ['G10', 'G20', 'C40', 'C33']) {
    const bytes = payload(layer.length * 17, 48);
    const encoded = encode(bytes, {
      layer,
      version: layer === 'C33' ? 2 : 4,
      moduleSize: layer === 'C33' ? 16 : 10,
      quietZone: 2,
      width: 512,
      height: 512,
      mode: 'compact',
      constraint: false,
    });
    fixtures.push({ layer, bytes, encoded });
  }

  // Warm up parsers, palette caches, wasm instance.
  for (const fixture of fixtures) {
    decodeAuto(fixture.encoded.image, { detector: 'axis' });
    await decodeAutoWasm(fixture.encoded.image, { detector: 'axis' });
  }

  const before = heap();
  const wasmBefore = await wasmMemoryStats();
  const times = [];
  let failures = 0;
  let checksum = 0;

  for (let i = 0; i < ITER; i++) {
    const fixture = fixtures[i % fixtures.length];
    const t0 = performance.now();
    try {
      const decoded = decodeAuto(fixture.encoded.image, { detector: 'axis' });
      if (Buffer.from(decoded.payload).toString('hex') !== Buffer.from(fixture.bytes).toString('hex')) {
        failures++;
      }
      checksum ^= decoded.payload.length;

      const wasm = await decodeAutoWasm(fixture.encoded.image, { detector: 'axis' });
      if (!wasm || Buffer.from(wasm.payload).toString('hex') !== Buffer.from(fixture.bytes).toString('hex')) {
        failures++;
      }

      if (i % 10 === 0) {
        const png = encodePNG(fixture.encoded.image);
        const round = decodePNG(png);
        if (round.width !== fixture.encoded.image.width) failures++;
        const fresh = encode(fixture.bytes, {
          layer: fixture.layer,
          version: fixture.layer === 'C33' ? 2 : 4,
          moduleSize: fixture.layer === 'C33' ? 16 : 10,
          quietZone: 2,
          width: 512,
          height: 512,
          mode: 'compact',
          constraint: false,
        });
        if (fresh.meta.version !== fixture.encoded.meta.version) failures++;
      }
      // Exercise a different random payload size to avoid allocator luck.
      if (i % 23 === 0) encode(payload(i, 8 + (i % 120)), {
        layer: 'G20', width: 512, height: 512, mode: 'fill', constraint: false,
      });
    } catch (err) {
      failures++;
      console.error('iteration failure', i, err.message);
    }
    times.push(performance.now() - t0);
  }

  if (typeof global.gc === 'function') global.gc();
  const after = heap();
  const wasmAfter = await wasmMemoryStats();
  const sorted = times.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  console.log(JSON.stringify({
    iterations: ITER,
    failures,
    checksum,
    medianMs: median,
    p99Ms: p99,
    maxMs: Math.max(...times),
    heapBefore: before.heapUsed,
    heapAfter: after.heapUsed,
    heapDelta: after.heapUsed - before.heapUsed,
    rssDelta: after.rss - before.rss,
    externalDelta: after.external - before.external,
    arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
    wasmBefore: wasmBefore.bytes,
    wasmAfter: wasmAfter.bytes,
    wasmDelta: wasmAfter.bytes - wasmBefore.bytes,
    lastPtr: wasmAfter.lastPtr,
    lastLen: wasmAfter.lastLen,
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
