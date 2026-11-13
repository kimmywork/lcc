#!/usr/bin/env node
/**
 * LCC performance benchmark.
 *
 *   node scripts/bench-lcc.mjs                 # default run
 *   node scripts/bench-lcc.mjs --quick         # fewer iterations
 *   node scripts/bench-lcc.mjs --json out.json # also write machine-readable results
 *
 * Measures:
 *   - encode latency / throughput by layer and payload size
 *   - decode latency (clean axis, perspective, JS vs wasm)
 *   - repeated-decode stability (p50/p95/p99, drift, JS heap and wasm memory)
 *   - phase breakdown (preprocess / detect / full decode)
 *   - version scalability (latency vs module count)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  capacityFor,
  decode,
  decodeAuto,
  detectSymbol,
  encode,
  generatePalette,
  makeLayout,
} from '../src/index.js';
import { preprocessVariants } from '../src/preprocess.js';
import { decodeAutoWasm, wasmMemoryStats } from '../docs/lib/lcc-wasm.js';
import { mulberry32 } from '../scripts/lib/rng.mjs';
import { batchMeans, fmt, fmtBytes, summarize, table } from '../scripts/lib/stats.mjs';

function parseArgs(argv) {
  const out = { iterations: null, repeat: 300, json: null, quick: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const quick = args.quick === true;
const ITER = Number(args.iterations) || (quick ? 8 : 24);
const WARMUP = 3;
const REPEAT = Number(args.repeat) || (quick ? 100 : 300);

function payloadOf(n, seed = 12345) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function timeSync(fn, iterations, warmup = WARMUP) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return summarize(times);
}

async function timeAsync(fn, iterations, warmup = WARMUP) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return summarize(times);
}

function memory() {
  if (typeof global.gc === 'function') global.gc();
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
}

function makeFixture(layer, options, payload) {
  const t0 = performance.now();
  const encoded = encode(payload, options);
  const encodeMs = performance.now() - t0;
  const t1 = performance.now();
  const decoded = decodeAuto(encoded.image, { detector: 'axis' });
  const decodeMs = performance.now() - t1;
  if (decoded.text !== null && Buffer.from(decoded.payload).toString('hex') !== Buffer.from(payload).toString('hex')) {
    throw new Error(`fixture ${layer}: wrong decode`);
  }
  return { encoded, decoded, encodeMs, decodeMs };
}

async function main() {
  const env = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    iterations: ITER,
    repeat: REPEAT,
  };

  const results = {
    env,
    encode: [],
    decode: [],
    throughput: [],
    stability: null,
    phases: [],
    scalability: [],
    capacity: [],
    wasmMemory: null,
  };

  // ---------------------------------------------------------------------------
  // 1. Encode latency and throughput
  // ---------------------------------------------------------------------------
  console.log('\n# Encode (1024 px canvas, quiet zone 2, max module 32)\n');
  const encodeLayers = ['G10', 'G20', 'G30', 'C40', 'C50', 'C33', 'C55'];
  const payloadSizes = quick ? [32, 512] : [32, 512, 2048];
  const encodeRows = [];
  for (const layer of encodeLayers) {
    for (const size of payloadSizes) {
      let encoded;
      try {
        encoded = encode(payloadOf(size, 1000 + size), {
          layer,
          width: 1024,
          height: 1024,
          mode: 'fill',
          maxModulePx: 32,
          constraint: false,
        });
      } catch {
        continue; // payload does not fit this layer/canvas
      }
      if (encoded.meta.payloadCapacity < size) continue;
      const stats = timeSync(() => encode(payloadOf(size, 1000 + size), {
        layer,
        width: 1024,
        height: 1024,
        mode: 'fill',
        maxModulePx: 32,
        constraint: false,
      }), ITER);
      const row = {
        layer,
        payloadBytes: size,
        version: encoded.meta.version,
        N: encoded.meta.N,
        moduleSize: encoded.meta.moduleSize,
        imagePx: encoded.image.width,
        bitsPerModule: encoded.meta.bitsPerModule,
        capacityBytes: encoded.meta.payloadCapacity,
        medianMs: stats.median,
        p95Ms: stats.p95,
        codesPerSec: 1000 / Math.max(stats.median, 1e-6),
        mibPerSec: (size / (1024 * 1024)) / (stats.median / 1000),
      };
      results.encode.push(row);
      encodeRows.push(row);
    }
  }
  console.log(table(encodeRows, [
    { key: 'layer', title: 'layer' },
    { key: 'payloadBytes', title: 'payload' },
    { key: 'version', title: 'ver' },
    { key: 'N', title: 'N' },
    { key: 'moduleSize', title: 'mod' },
    { key: 'imagePx', title: 'image' },
    { key: 'bitsPerModule', title: 'bit/mod', format: (r) => fmt(r.bitsPerModule, 1) },
    { key: 'medianMs', title: 'median', format: (r) => `${fmt(r.medianMs)} ms` },
    { key: 'p95Ms', title: 'p95', format: (r) => `${fmt(r.p95Ms)} ms` },
    { key: 'codesPerSec', title: 'codes/s', format: (r) => fmt(r.codesPerSec, 0) },
    { key: 'mibPerSec', title: 'MiB/s', format: (r) => fmt(r.mibPerSec, 2) },
  ]));

  // ---------------------------------------------------------------------------
  // 2. Decode fixtures: axis, perspective, JS vs wasm
  // ---------------------------------------------------------------------------
  console.log('\n# Decode fixtures\n');
  const fixtures = [
    ['G10', 'axis', 512, { layer: 'G10', width: 1024, height: 1024, mode: 'fill', constraint: false, maxModulePx: 32 }],
    ['G20', 'axis', 512, { layer: 'G20', width: 1024, height: 1024, mode: 'fill', constraint: false, maxModulePx: 32 }],
    ['G30-constraint', 'axis', 256, { layer: 'G30', width: 1024, height: 1024, mode: 'fill', constraint: true, maxModulePx: 32 }],
    ['C40', 'axis', 512, { layer: 'C40', width: 1024, height: 1024, mode: 'fill', constraint: false, maxModulePx: 32 }],
    ['C55', 'axis', 192, { layer: 'C55', width: 1024, height: 1024, mode: 'fill', version: 4, moduleSize: 16, constraint: false }],
  ];
  const fixtureImages = {};
  const decodeRows = [];
  for (const [name, , payloadSize, options] of fixtures) {
    const payload = payloadOf(payloadSize, 7000 + payloadSize + name.length);
    const { encoded } = makeFixture(name, options, payload);
    fixtureImages[name] = encoded.image;
    const js = timeSync(() => decodeAuto(encoded.image, { detector: 'axis' }), ITER);
    let wasm = { median: NaN, p95: NaN };
    if (!options.constraint) {
      try {
        wasm = await timeAsync(() => decodeAutoWasm(encoded.image, { detector: 'axis' }), Math.max(4, Math.floor(ITER / 2)));
      } catch (err) {
        wasm = { median: NaN, p95: NaN, error: err.message };
      }
    }
    const prep = preprocessVariants(encoded.image);
    const detect = timeSync(() => detectSymbol(encoded.image, { variant: prep[0] }), ITER);
    let perspective = null;
    try {
      perspective = timeSync(() => decodeAuto(encoded.image, { detector: 'perspective' }), Math.max(4, Math.floor(ITER / 2)));
    } catch {
      perspective = { median: NaN, p95: NaN };
    }
    const row = {
      fixture: name,
      layer: encoded.meta.layer,
      version: encoded.meta.version,
      N: encoded.meta.N,
      moduleSize: encoded.meta.moduleSize,
      imagePx: encoded.image.width,
      payloadBytes: payloadSize,
      jsMedianMs: js.median,
      jsP95Ms: js.p95,
      wasmMedianMs: wasm.median,
      speedup: wasm.median ? js.median / wasm.median : NaN,
      perspectiveMs: perspective.median,
      detectOnlyMs: detect.median,
      codesPerSec: 1000 / Math.max(js.median, 1e-6),
      payloadMiBPerSec: (payloadSize / (1024 * 1024)) / (js.median / 1000),
      imageMpxPerSec: ((encoded.image.width * encoded.image.height) / 1e6) / (js.median / 1000),
      wasmCodesPerSec: wasm.median ? 1000 / wasm.median : NaN,
      wasmMpxPerSec: wasm.median ? ((encoded.image.width * encoded.image.height) / 1e6) / (wasm.median / 1000) : NaN,
    };
    results.decode.push(row);
    decodeRows.push(row);
  }
  console.log('C/WASM is the primary decode path; JS columns are the fallback reference.\n');
  console.log(table(decodeRows, [
    { key: 'fixture', title: 'fixture' },
    { key: 'version', title: 'ver' },
    { key: 'N', title: 'N' },
    { key: 'imagePx', title: 'image' },
    { key: 'payloadBytes', title: 'payload' },
    { key: 'wasmMedianMs', title: 'C/WASM', format: (r) => (Number.isFinite(r.wasmMedianMs) ? `${fmt(r.wasmMedianMs)} ms` : '-') },
    { key: 'wasmCodesPerSec', title: 'C codes/s', format: (r) => (Number.isFinite(r.wasmCodesPerSec) ? fmt(r.wasmCodesPerSec, 1) : '-') },
    { key: 'wasmMpxPerSec', title: 'C Mpx/s', format: (r) => (Number.isFinite(r.wasmMpxPerSec) ? fmt(r.wasmMpxPerSec, 2) : '-') },
    { key: 'jsMedianMs', title: 'JS', format: (r) => `${fmt(r.jsMedianMs)} ms` },
    { key: 'speedup', title: 'speedup', format: (r) => (Number.isFinite(r.speedup) ? `${fmt(r.speedup, 2)}x` : '-') },
    { key: 'detectOnlyMs', title: 'detect', format: (r) => `${fmt(r.detectOnlyMs)} ms` },
    { key: 'perspectiveMs', title: 'persp', format: (r) => `${fmt(r.perspectiveMs)} ms` },
    { key: 'codesPerSec', title: 'JS codes/s', format: (r) => fmt(r.codesPerSec, 1) },
    { key: 'payloadMiBPerSec', title: 'JS MiB/s', format: (r) => fmt(r.payloadMiBPerSec, 3) },
    { key: 'imageMpxPerSec', title: 'JS Mpx/s', format: (r) => fmt(r.imageMpxPerSec, 2) },
  ]));

  // ---------------------------------------------------------------------------
  // 3. Repeated-decode stability
  // ---------------------------------------------------------------------------
  console.log('\n# Repeat stability\n');
  {
    const image = fixtureImages['C40'];
    const payload = payloadOf(512, 7000 + 512 + 'C40'.length);
    const expected = Buffer.from(payload).toString('hex');
    const run = () => {
      const decoded = decodeAuto(image, { detector: 'axis' });
      if (Buffer.from(decoded.payload).toString('hex') !== expected) throw new Error('wrong payload');
      return decoded;
    };
    for (let i = 0; i < 10; i++) run();
    const before = memory();
    const wasmBefore = await wasmMemoryStats();
    const times = [];
    const batchSize = Math.max(20, Math.floor(REPEAT / 6));
    let failures = 0;
    const t0 = performance.now();
    for (let i = 0; i < REPEAT; i++) {
      const start = performance.now();
      try {
        run();
      } catch {
        failures++;
      }
      times.push(performance.now() - start);
    }
    const wallMs = performance.now() - t0;
    const after = memory();
    const wasmAfter = await wasmMemoryStats();
    const batches = batchMeans(times, batchSize);
    const stats = summarize(times);
    const row = {
      iterations: REPEAT,
      failures,
      medianMs: stats.median,
      meanMs: stats.mean,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
      maxMs: stats.max,
      cv: stats.cv,
      batchMeans: batches,
      driftPct: batches.length > 1 ? ((batches.at(-1) - batches[0]) / batches[0]) * 100 : 0,
      wallMs,
      codesPerSec: 1000 / Math.max(stats.median, 1e-6),
      payloadMiBPerSec: (512 / (1024 * 1024)) / (stats.median / 1000),
      heapDelta: after.heapUsed - before.heapUsed,
      rssDelta: after.rss - before.rss,
      externalDelta: after.external - before.external,
      wasmBytesBefore: wasmBefore.bytes,
      wasmBytesAfter: wasmAfter.bytes,
      wasmDelta: wasmAfter.bytes - wasmBefore.bytes,
    };
    results.stability = row;
    results.wasmMemory = { before: wasmBefore, after: wasmAfter };
    console.log(table([row], [
      { key: 'iterations', title: 'runs' },
      { key: 'failures', title: 'fail' },
      { key: 'medianMs', title: 'median', format: (r) => `${fmt(r.medianMs)} ms` },
      { key: 'p95Ms', title: 'p95', format: (r) => `${fmt(r.p95Ms)} ms` },
      { key: 'p99Ms', title: 'p99', format: (r) => `${fmt(r.p99Ms)} ms` },
      { key: 'maxMs', title: 'max', format: (r) => `${fmt(r.maxMs)} ms` },
      { key: 'cv', title: 'CV', format: (r) => `${fmt(r.cv * 100, 1)}%` },
      { key: 'driftPct', title: 'drift', format: (r) => `${fmt(r.driftPct, 1)}%` },
      { key: 'heapDelta', title: 'heap Δ', format: (r) => fmtBytes(r.heapDelta) },
      { key: 'rssDelta', title: 'rss Δ', format: (r) => fmtBytes(r.rssDelta) },
      { key: 'wasmDelta', title: 'wasm Δ', format: (r) => fmtBytes(r.wasmDelta) },
      { key: 'codesPerSec', title: 'codes/s', format: (r) => fmt(r.codesPerSec, 1) },
      { key: 'payloadMiBPerSec', title: 'payload MiB/s', format: (r) => fmt(r.payloadMiBPerSec, 3) },
    ]));
    console.log(`batch means (ms): ${batches.map((b) => fmt(b)).join(', ')}`);
  }

  // ---------------------------------------------------------------------------
  // 4. Phase breakdown
  // ---------------------------------------------------------------------------
  console.log('\n# Phase breakdown (C40, 512 B)\n');
  {
    const image = fixtureImages['C40'];
    const prep = preprocessVariants(image);
    const variant = prep[0];
    const eagerPreprocess = timeSync(() => preprocessVariants(image), ITER);
    const detect = timeSync(() => detectSymbol(image, { variant }), ITER);
    const fixedDecode = timeSync(() => decode(image, { variant }), ITER);
    const auto = timeSync(() => decodeAuto(image, { detector: 'axis' }), ITER);
    const rows = [
      { phase: 'preprocessVariants (eager, 16 variants)', medianMs: eagerPreprocess.median },
      { phase: 'detectSymbol (given variant)', medianMs: detect.median },
      { phase: 'decode (given variant)', medianMs: fixedDecode.median },
      { phase: 'decodeAuto (lazy variants)', medianMs: auto.median },
    ];
    results.phases = rows;
    console.log(table(rows, [
      { key: 'phase', title: 'phase' },
      { key: 'medianMs', title: 'median', format: (r) => `${fmt(r.medianMs)} ms` },
    ]));
    console.log(`lazy decodeAuto is ${(eagerPreprocess.median / Math.max(auto.median, 1e-6)).toFixed(1)}x faster than building all 16 variants eagerly`);
  }

  // ---------------------------------------------------------------------------
  // 5. Scalability with version
  // ---------------------------------------------------------------------------
  console.log('\n# Version scalability (G20, fixed 8 px modules)\n');
  {
    const scaleRows = [];
    for (const version of [2, 4, 8, 12, 16, 20]) {
      let encoded;
      try {
        encoded = encode(payloadOf(64, 99), {
          layer: 'G20',
          width: 4096,
          height: 4096,
          mode: 'compact',
          version,
          moduleSize: 8,
          quietZone: 2,
          constraint: false,
          maxModulePx: 32,
        });
      } catch {
        continue;
      }
      let decoded;
      try {
        decoded = decodeAuto(encoded.image, { detector: 'axis' });
      } catch (err) {
        console.log(`v${version}: decode failed (${err.message})`);
        continue;
      }
      if (!decoded) continue;
      const stats = timeSync(() => decodeAuto(encoded.image, { detector: 'axis' }), Math.max(4, Math.floor(ITER / 2)));
      const row = {
        version,
        N: encoded.meta.N,
        modules: encoded.meta.N ** 2,
        imagePx: encoded.image.width,
        megapixels: (encoded.image.width * encoded.image.height) / 1e6,
        medianMs: stats.median,
        megapixelsPerSec: ((encoded.image.width * encoded.image.height) / 1e6) / (stats.median / 1000),
        nsPerModule: (stats.median * 1e6) / (encoded.meta.N ** 2),
      };
      results.scalability.push(row);
      scaleRows.push(row);
    }
    console.log(table(scaleRows, [
      { key: 'version', title: 'ver' },
      { key: 'N', title: 'N' },
      { key: 'modules', title: 'modules' },
      { key: 'imagePx', title: 'image' },
      { key: 'medianMs', title: 'median', format: (r) => `${fmt(r.medianMs)} ms` },
      { key: 'megapixelsPerSec', title: 'Mpx/s', format: (r) => fmt(r.megapixelsPerSec, 2) },
      { key: 'nsPerModule', title: 'ns/module', format: (r) => fmt(r.nsPerModule, 1) },
    ]));
  }

  // ---------------------------------------------------------------------------
  // 6. Capacity vs version (no rendering)
  // ---------------------------------------------------------------------------
  console.log('\n# Payload capacity by layer (bytes, ECC from layer)\n');
  {
    const versions = [1, 2, 5, 10, 20, 40];
    const layers = ['G10', 'G20', 'G30', 'C40', 'C50', 'C60', 'C80', 'G13', 'C33', 'C55', 'C85'];
    const header = ['layer', ...versions.map((v) => `v${v}`)];
    const rows = [];
    for (const layer of layers) {
      const paletteInfo = generatePalette(layer, { mode: 'maxmin' });
      const cells = { layer };
      for (const version of versions) {
        try {
          const layout = makeLayout({ version, layer, paletteMode: 'maxmin', paletteInfo });
          const cap = capacityFor(layout, layer, paletteInfo, undefined, undefined);
          cells[`v${version}`] = cap.payloadCapacity;
        } catch {
          cells[`v${version}`] = '-';
        }
      }
      rows.push(cells);
      results.capacity.push({ layer, ...cells });
    }
    console.log(table(rows, header.map((title) => ({
      key: title,
      title,
      format: (r) => String(r[title] ?? '-'),
    }))));
  }

  // ---------------------------------------------------------------------------
  // Write output
  // ---------------------------------------------------------------------------
  if (args.json) {
    const out = path.resolve(String(args.json));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
  console.log(`\nwasm memory: ${fmtBytes(results.wasmMemory?.before.bytes ?? 0)} -> ${fmtBytes(results.wasmMemory?.after.bytes ?? 0)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
