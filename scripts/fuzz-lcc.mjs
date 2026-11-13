#!/usr/bin/env node
/**
 * LCC fuzz / robustness harness.
 *
 *   node scripts/fuzz-lcc.mjs                     # default, reproducible seed
 *   node scripts/fuzz-lcc.mjs --iterations 2000 --seed 7
 *   node scripts/fuzz-lcc.mjs --suite png --strict
 *   node scripts/fuzz-lcc.mjs --json bench-results/fuzz.json
 *
 * Suites:
 *   encode   random payloads/options, valid and invalid
 *   decode   random clean images and random corruptions; a decode either
 *            returns the exact payload or throws (never a silent wrong result)
 *   corrupt  burst/bit/pixel corruption of valid symbols
 *   png      random bytes and mutated PNG headers/chunks
 *   ecc      Reed-Solomon / BCH / frame codec properties
 *   wasm     C core called with valid and hostile buffers
 *   stack    multi-frame stacking with valid and hostile detections
 *
 * Traps (wasm RuntimeError) are counted as "findings": they are caught
 * exceptions, but they mean a malformed input reached raw memory access.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  bch15Decode,
  bch15Encode,
  decodeAuto,
  detectSymbol,
  encode,
  rsDecode,
  rsEncode,
  LAYERS,
} from '../src/index.js';
import { decodePNG, encodePNG } from '../src/png.js';
import { buildFrame, parseFrame } from '../src/frame.js';
import { stackCanonicalFrames } from '../src/stack.js';
import { decodeAutoWasm, stackCanonicalFramesWasm, wasmExports, wasmMemoryStats } from '../src/lcc-wasm.js';
import { bytes, gaussian, int, mulberry32, pick, text } from '../scripts/lib/rng.mjs';

function parseArgs(argv) {
  const out = { iterations: 300, seed: 1, suite: 'all', json: null, strict: false };
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
const SEED = Number(args.seed) || 1;
const ITER = Math.max(1, Number(args.iterations) || 300);
const rng = mulberry32(SEED);

const report = {
  seed: SEED,
  iterations: ITER,
  suites: {},
  findings: [],
  slowest: [],
};

function fail(message, detail) {
  const finding = { message, detail };
  report.findings.push(finding);
  console.error(`  FINDING: ${message}${detail ? ` (${detail})` : ''}`);
}

function errorKind(err) {
  if (!(err instanceof Error)) return 'non-error-throw';
  if (err.name === 'RuntimeError') return 'wasm-trap';
  if (err instanceof RangeError) return 'range';
  if (err instanceof TypeError) return 'type';
  return 'error';
}

async function suite(name, iterations, fn) {
  const stats = {
    name,
    runs: 0,
    ok: 0,
    rejected: 0,
    unexpected: 0,
    findings: 0,
    slow: 0,
    maxMs: 0,
    errors: {},
  };
  const findingsBefore = report.findings.length;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      await fn(i, stats);
      stats.ok++;
    } catch (err) {
      const kind = errorKind(err);
      stats.errors[kind] = (stats.errors[kind] ?? 0) + 1;
      stats.lastError = err instanceof Error ? err.message : String(err);
      stats.unexpected++;
      if (kind === 'non-error-throw') {
        fail(`${name}: threw a non-Error value`, String(err));
      } else if (kind === 'wasm-trap') {
        fail(`${name}: wasm trapped on a malformed input`, String(err.message).slice(0, 80));
      } else {
        fail(`${name}: unexpected exception`, String(err.message ?? err).slice(0, 120));
      }
    }
    const ms = performance.now() - t0;
    stats.runs++;
    stats.maxMs = Math.max(stats.maxMs, ms);
    if (ms > 1000) {
      stats.slow++;
      report.slowest.push({ suite: name, iteration: i, ms });
    }
  }
  stats.findings = report.findings.length - findingsBefore;
  report.suites[name] = stats;
  console.log(
    `${name.padEnd(8)} runs=${String(stats.runs).padStart(4)} ok=${String(stats.ok).padStart(4)} `
    + `rejected=${String(stats.rejected).padStart(4)} max=${stats.maxMs.toFixed(1)}ms `
    + `kinds=${JSON.stringify(stats.errors)}`
    + (stats.lastError ? ` last=${JSON.stringify(stats.lastError.slice(0, 90))}` : ''),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const LAYER_NAMES = Object.keys(LAYERS);
const BASE_LAYERS = ['G10', 'G20', 'G30', 'C40', 'C50', 'C60', 'C80', 'C30', 'C20'];
const SHAPE_LAYERS = ['G13', 'G23', 'G33', 'C23', 'C33', 'C43'];

function makeFixture(layer, payloadBytes = 96, seed = 1) {
  const encoded = encode(bytes(mulberry32(seed), payloadBytes), {
    layer,
    width: 512,
    height: 512,
    mode: 'fill',
    maxModulePx: 32,
    constraint: false,
  });
  return { encoded, payload: encoded.meta.payloadSize };
}

// ---------------------------------------------------------------------------
// encode: random inputs and options
// ---------------------------------------------------------------------------
async function encodeSuite(i, stats) {
  const hostile = rng() < 0.5;
  const layer = pick(rng, LAYER_NAMES);
  const isShape = !!LAYERS[layer].shapeSetSize;
  const n = hostile ? int(rng, 0, 220) : int(rng, 0, 4);
  const useText = rng() < 0.6;
  const payload = useText
    ? text(rng, n, rng() < 0.3 ? 'cjk' : 'ascii')
    : bytes(rng, n);
  const width = hostile ? pick(rng, [128, 256, 512, 1024, 1, 0, -8, NaN]) : 2048;
  const height = hostile ? pick(rng, [width, 128, 512, 1024]) : 2048;
  const moduleSize = hostile && rng() < 0.4
    ? pick(rng, [0, -4, 3, 8, 16, 32, 64, 65, NaN])
    : undefined;
  const quietZone = hostile && rng() < 0.4
    ? pick(rng, [-2, 0, 1, 2, 4, 8, NaN])
    : 2;
  const version = hostile && rng() < 0.5
    ? pick(rng, [1, 2, 3, 5, 10, 100, 101, 0, -1])
    : undefined;
  const options = {
    layer,
    width,
    height,
    mode: hostile ? pick(rng, ['fill', 'compact', 'nonsense']) : 'fill',
    maxModulePx: 32,
    constraint: rng() < 0.5,
    eccLevel: hostile ? pick(rng, ['auto', 'L', 'M', 'Q', 'H', 'Z', 0.2, 99]) : 'auto',
    boostEcc: rng() < 0.5,
    minVersion: hostile ? pick(rng, [undefined, 1, 2, 5, 101]) : undefined,
    maxVersion: hostile ? pick(rng, [undefined, 1, 2, 100, 101]) : undefined,
    moduleSize,
    quietZone,
    version,
    seed: isShape ? 0 : (hostile ? pick(rng, [undefined, 0, 1, 2, 63, 64, -1, NaN]) : pick(rng, [undefined, 0, 1, 2, 63])),
    compressed: rng() < 0.5,
    encrypted: rng() < 0.5,
    paletteMode: isShape ? 'maxmin' : (hostile ? pick(rng, ['maxmin', 'harmony', 'bogus']) : pick(rng, ['maxmin', 'harmony'])),
    harmony: isShape ? false : rng() < 0.2,
  };
  let result;
  try {
    result = encode(payload, options);
  } catch (err) {
    if (hostile && err instanceof Error) {
      stats.rejected++;
      stats.errors[errorKind(err)] = (stats.errors[errorKind(err)] ?? 0) + 1;
      return;
    }
    err.message += ` [options=${JSON.stringify(options)} payload=${n}]`;
    throw err;
  }
  if (!result || !result.image || result.image.width <= 0 || result.image.height <= 0) {
    throw new Error('encode returned an invalid image');
  }
  if (result.image.data.length !== result.image.width * result.image.height * 3) {
    throw new Error('encode image buffer length mismatch');
  }
  if (!Number.isFinite(result.meta.payloadCapacity) || result.meta.payloadCapacity < 0) {
    throw new Error('encode returned invalid capacity');
  }
  const symbols = result.symbols;
  const maxSymbol = (result.meta.shapeSetSize ?? 1) * result.meta.paletteSize;
  for (const [r, c] of result.layout.dataCoords) {
    const symbol = symbols[r * result.layout.N + c];
    if (symbol < 0 || symbol >= maxSymbol) {
      throw new Error(`symbol out of range at (${r},${c}): ${symbol}`);
    }
  }
}

// ---------------------------------------------------------------------------
// decode: random garbage images (small, to keep it fast)
// ---------------------------------------------------------------------------
async function decodeSuite(i, stats) {
  const width = int(rng, 1, 48);
  const height = int(rng, 1, 48);
  const data = bytes(rng, width * height * 3);
  let result;
  try {
    result = decodeAuto({ width, height, data }, {
      detector: pick(rng, ['axis', 'perspective', 'auto']),
    });
  } catch (err) {
    if (err instanceof Error) {
      stats.rejected++;
      stats.errors[errorKind(err)] = (stats.errors[errorKind(err)] ?? 0) + 1;
      return;
    }
    throw err;
  }
  if (result) fail('decode: accepted random garbage', `${width}x${height}`);
}

// ---------------------------------------------------------------------------
// corrupt: valid code + random damage; exact payload or throw
// ---------------------------------------------------------------------------
function corruptImage(image, mode, strength) {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  if (mode === 'noise') {
    for (let i = 0; i < out.data.length; i++) {
      out.data[i] = Math.max(0, Math.min(255, Math.round(out.data[i] + gaussian(rng) * strength)));
    }
  } else if (mode === 'flip') {
    const n = Math.max(1, Math.round((strength / 100) * out.data.length / 3));
    for (let i = 0; i < n; i++) {
      const pixel = int(rng, 0, out.width * out.height - 1);
      const channel = int(rng, 0, 2);
      out.data[pixel * 3 + channel] ^= 1 + int(rng, 0, 254);
    }
  } else if (mode === 'burst') {
    const n = Math.max(1, Math.round(strength / 10));
    for (let i = 0; i < n; i++) {
      const x0 = int(rng, 0, out.width - 1);
      const y0 = int(rng, 0, out.height - 1);
      const w = int(rng, 1, Math.max(1, Math.floor(out.width / 8)));
      const h = int(rng, 1, Math.max(1, Math.floor(out.height / 8)));
      const rgb = [int(rng, 0, 255), int(rng, 0, 255), int(rng, 0, 255)];
      for (let y = y0; y < Math.min(out.height, y0 + h); y++) {
        for (let x = x0; x < Math.min(out.width, x0 + w); x++) {
          const p = (y * out.width + x) * 3;
          out.data[p] = rgb[0];
          out.data[p + 1] = rgb[1];
          out.data[p + 2] = rgb[2];
        }
      }
    }
  } else if (mode === 'shift') {
    const dx = int(rng, -3, 3);
    const dy = int(rng, -3, 3);
    const src = new Uint8Array(out.data);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const sx = Math.max(0, Math.min(out.width - 1, x - dx));
        const sy = Math.max(0, Math.min(out.height - 1, y - dy));
        const p = (y * out.width + x) * 3;
        const q = (sy * out.width + sx) * 3;
        out.data[p] = src[q];
        out.data[p + 1] = src[q + 1];
        out.data[p + 2] = src[q + 2];
      }
    }
  }
  return out;
}

const corruptFixtures = new Map();
function getCorruptFixture(layer, size) {
  const key = `${layer}:${size}`;
  if (!corruptFixtures.has(key)) {
    const rngLocal = mulberry32(9000 + layer.length + size);
    const payload = bytes(rngLocal, size);
    const encoded = encode(payload, {
      layer,
      width: 512,
      height: 512,
      mode: 'fill',
      maxModulePx: 32,
      constraint: false,
    });
    corruptFixtures.set(key, { encoded, payload });
  }
  return corruptFixtures.get(key);
}

async function corruptSuite(i, stats) {
  const layer = pick(rng, ['G10', 'G20', 'G30', 'C40', 'C50', 'C33']);
  const size = int(rng, 8, layer === 'G10' ? 96 : 192);
  const { encoded, payload } = getCorruptFixture(layer, size);
  const mode = pick(rng, ['noise', 'flip', 'burst', 'shift']);
  const strength = pick(rng, [2, 5, 10, 20, 40, 80, 120]);
  const damaged = corruptImage(encoded.image, mode, strength);
  let decoded = null;
  try {
    decoded = decodeAuto(damaged, { detector: 'axis' });
  } catch (err) {
    if (err instanceof Error) {
      stats.rejected++;
      return;
    }
    throw err;
  }
  const got = Buffer.from(decoded.payload).toString('hex');
  const want = Buffer.from(payload).toString('hex');
  if (got !== want) {
    fail('corrupt: decode returned wrong payload without error', `${layer} ${mode} ${strength}`);
  }
}

// ---------------------------------------------------------------------------
// png: random bytes and mutated valid PNGs
// ---------------------------------------------------------------------------
async function pngSuite(i, stats) {
  const input = bytes(rng, int(rng, 0, 256));
  try {
    const image = decodePNG(input);
    fail('png: accepted random bytes as a PNG', `${image.width}x${image.height}`);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    stats.rejected++;
  }

  if (rng() < 0.5) {
    const { encoded } = getCorruptFixture('G20', 32);
    const png = encodePNG(encoded.image);
    const mutated = Buffer.from(png);
    const edits = int(rng, 1, 6);
    for (let i = 0; i < edits; i++) {
      const pos = int(rng, 0, mutated.length - 1);
      mutated[pos] ^= 1 + int(rng, 0, 254);
    }
    let image = null;
    try {
      image = decodePNG(mutated);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      stats.rejected++;
    }
    if (image && image.width * image.height * 3 !== image.data.length) {
      fail('png: decoded image has inconsistent dimensions');
    }
  }
}

// ---------------------------------------------------------------------------
// ecc: RS / BCH / frame properties
// ---------------------------------------------------------------------------
function hamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += x & 1;
    x >>= 1;
  }
  return n;
}

async function eccSuite(i, stats) {
  if (rng() < 0.6) {
    const n = int(rng, 4, 120);
    const parity = int(rng, 1, Math.max(1, Math.min(40, n - 1)));
    const data = bytes(rng, n - parity);
    const encoded = rsEncode(data, parity);
    const bad = Uint8Array.from(encoded);
    const t = Math.floor(parity / 2);
    const errors = int(rng, 0, t);
    for (let i = 0; i < errors; i++) {
      bad[int(rng, 0, bad.length - 1)] ^= 1 + int(rng, 0, 254);
    }
    const decoded = rsDecode(bad, parity);
    const want = Buffer.from(data).toString('hex');
    const got = Buffer.from(decoded.data).toString('hex');
    if (want !== got) fail('ecc: RS failed to correct within capacity', `${errors}/${t}`);
  } else {
    const word = int(rng, 0, 0x7fff);
    const msg = bch15Decode(word);
    if (msg >= 0) {
      if (msg > 31) throw new Error(`bch15Decode out of range: ${msg}`);
      const distance = hamming(bch15Encode(msg), word);
      if (distance > 3) fail('ecc: BCH(15,5) accepted a word beyond radius 3', `distance ${distance}`);
    }
  }

  if (rng() < 0.5) {
    const payload = bytes(rng, int(rng, 0, 40));
    const frame = buildFrame({ layerId: int(rng, 0, 7), flags: int(rng, 0, 7), payload });
    const parsed = parseFrame(frame);
    if (Buffer.from(parsed.payload).toString('hex') !== Buffer.from(payload).toString('hex')) {
      fail('ecc: frame round-trip mismatch');
    }
    const bad = Uint8Array.from(frame);
    bad[int(rng, 0, bad.length - 1)] ^= 1 << int(rng, 0, 7);
    try {
      const parsedBad = parseFrame(bad);
      if (Buffer.from(parsedBad.payload).toString('hex') !== Buffer.from(payload).toString('hex')) {
        fail('ecc: corrupted frame returned a wrong payload');
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      stats.rejected++;
    }
  }
}

// ---------------------------------------------------------------------------
// wasm: valid fixtures + hostile buffers
// ---------------------------------------------------------------------------
const wasmFixture = (() => {
  const payload = bytes(mulberry32(11), 48);
  const encoded = encode(payload, {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill',
    constraint: false,
  });
  return { encoded, payload };
})();

async function wasmSuite(i, stats) {
  if (rng() < 0.5) {
    const decoded = await decodeAutoWasm(wasmFixture.encoded.image, { detector: 'axis' });
    if (!decoded || Buffer.from(decoded.payload).toString('hex') !== Buffer.from(wasmFixture.payload).toString('hex')) {
      fail('wasm: valid fixture failed');
    }
    return;
  }
  if (rng() < 0.5) {
    const width = int(rng, 1, 64);
    const height = int(rng, 1, 64);
    const data = bytes(rng, width * height * 3);
    let result = null;
    try {
      result = await decodeAutoWasm({ width, height, data }, { detector: 'axis' });
    } catch (err) {
      if (err instanceof Error) {
        stats.rejected++;
        stats.errors[errorKind(err)] = (stats.errors[errorKind(err)] ?? 0) + 1;
        return;
      }
      throw err;
    }
    if (result !== null) fail('wasm: decoded random garbage', `${width}x${height}`);
    return;
  }
  const detections = [detectSymbol(wasmFixture.encoded.image), detectSymbol(wasmFixture.encoded.image)];
  const stacked = await stackCanonicalFramesWasm(
    [wasmFixture.encoded.image, wasmFixture.encoded.image],
    detections,
    { quietZone: int(rng, 0, 4), moduleSize: int(rng, 8, 24) },
  );
  if (!stacked || !stacked.image || stacked.image.width <= 0) {
    throw new Error('wasm: stack returned an invalid image');
  }
}

// ---------------------------------------------------------------------------
// wasmraw: call the C exports directly with valid and mutated buffers
// ---------------------------------------------------------------------------
function packScan(frames) {
  const chunks = [];
  const i32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n | 0, true);
    chunks.push(b);
  };
  i32(frames.length);
  for (const frame of frames) {
    i32(frame.width);
    i32(frame.height);
    i32(frame.data.length);
    chunks.push(frame.data);
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function packStack(frames, detections, options = {}) {
  const chunks = [];
  const i32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n | 0, true);
    chunks.push(b);
  };
  const f64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, Number.isFinite(n) ? n : 0, true);
    chunks.push(b);
  };
  i32(frames.length);
  i32(options.quietZone ?? 4);
  i32(options.moduleSize ?? 0);
  i32(options.maxDimension ?? 1400);
  i32(options.noiseStride ?? 257);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const det = detections[i];
    i32(frame.width);
    i32(frame.height);
    i32(frame.data.length);
    chunks.push(frame.data);
    const valid = det && Number.isFinite(det.version) && Number.isFinite(det.N);
    i32(valid ? 1 : 0);
    i32(valid ? det.version : 0);
    i32(valid ? det.N : 0);
    f64(valid ? det.score ?? 0 : 0);
    i32(0);
    for (let h = 0; h < 9; h++) f64(0);
    f64(valid ? det.originX ?? 0 : 0);
    f64(valid ? det.originY ?? 0 : 0);
    f64(valid ? det.s ?? 0 : 0);
  }
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const rawWasm = await wasmExports();

function rawCall(name, bytes, ...args) {
  const ptr = rawWasm.malloc(bytes.length);
  if (!ptr) throw new Error('wasm malloc failed');
  new Uint8Array(rawWasm.memory.buffer).set(bytes, ptr);
  try {
    return rawWasm[name](ptr, ...args);
  } finally {
    rawWasm.free(ptr);
  }
}

function mutateBytes(bytes, rng, count) {
  const out = Uint8Array.from(bytes);
  for (let i = 0; i < count; i++) out[int(rng, 0, out.length - 1)] ^= 1 + int(rng, 0, 254);
  return out;
}

let scanInput = null;
let stackInput = null;
let rawMemoryBefore = null;

async function wasmRawSuite() {
  const det = detectSymbol(wasmFixture.encoded.image);
  const frame = wasmFixture.encoded.image;
  if (!scanInput) {
    scanInput = packScan([frame, frame]);
    stackInput = packStack([frame, frame], [det, det], { quietZone: 4, moduleSize: 16 });
    // Warm up every path so linear-memory growth from first-use buffers is not
    // mistaken for a leak.
    rawCall('lcc_api_scan', scanInput, scanInput.length);
    rawCall('lcc_api_stack', stackInput, stackInput.length);
    rawCall('lcc_api_decode', frame.data, frame.data.length, frame.width, frame.height, 0);
    rawMemoryBefore = (await wasmMemoryStats()).bytes;
  }

  const mode = int(rng, 0, 4);
  if (mode === 4) {
    // Target the packed header/detection fields where sizes and offsets live.
    const source = rng() < 0.5 ? stackInput : scanInput;
    const mutated = Uint8Array.from(source);
    const limit = Math.min(mutated.length, 200);
    for (let i = 0; i < int(rng, 1, 16); i++) {
      mutated[int(rng, 0, limit - 1)] = int(rng, 0, 255);
    }
    const name = source === stackInput ? 'lcc_api_stack' : 'lcc_api_scan';
    const status = rawCall(name, mutated, mutated.length);
    if (status < 0 || status > 3) throw new Error(`unexpected ${name} status ${status}`);
    return;
  }
  if (mode === 0) {
    const mutated = mutateBytes(scanInput, rng, int(rng, 1, 12));
    const status = rawCall('lcc_api_scan', mutated, mutated.length);
    if (status < 0 || status > 3) throw new Error(`unexpected scan status ${status}`);
    return;
  }
  if (mode === 1) {
    const mutated = mutateBytes(stackInput, rng, int(rng, 1, 12));
    const status = rawCall('lcc_api_stack', mutated, mutated.length);
    if (status < 0 || status > 3) throw new Error(`unexpected stack status ${status}`);
    return;
  }
  if (mode === 2) {
    // Valid encoded image with pixel-level mutations (decoder fuzz).
    const mutated = mutateBytes(frame.data, rng, int(rng, 1, 400));
    const status = rawCall('lcc_api_decode', mutated, mutated.length, frame.width, frame.height, 0);
    if (status < 0 || status > 3) throw new Error(`unexpected decode status ${status}`);
    return;
  }
  // Random consistent image (decoder path, no length mismatch).
  const width = int(rng, 8, 64);
  const height = int(rng, 8, 64);
  const image = { width, height, data: bytes(rng, width * height * 3) };
  const status = rawCall('lcc_api_decode', image.data, image.data.length, width, height, int(rng, 0, 2));
  if (status < 0 || status > 3) throw new Error(`unexpected decode status ${status}`);
}

// ---------------------------------------------------------------------------
// stack: valid detections (camera path building block)
// ---------------------------------------------------------------------------
async function stackSuite(i, stats) {
  const detections = [detectSymbol(wasmFixture.encoded.image), detectSymbol(wasmFixture.encoded.image)];
  const result = stackCanonicalFrames(
    [wasmFixture.encoded.image, wasmFixture.encoded.image],
    detections,
    { quietZone: int(rng, 0, 4), moduleSize: int(rng, 8, 24) },
  );
  if (!result || !result.image || result.image.width * result.image.height * 3 !== result.image.data.length) {
    throw new Error('stack returned an invalid image');
  }
  const wasmStack = await stackCanonicalFramesWasm(
    [wasmFixture.encoded.image, wasmFixture.encoded.image],
    detections,
    { quietZone: 4, moduleSize: 16 },
  );
  if (!wasmStack || !wasmStack.image) throw new Error('wasm stack returned an invalid image');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const suiteName = String(args.suite);
  const run = (name, entry) => {
    if (suiteName === 'all' || suiteName === name) return [name, ...entry];
    return null;
  };
  const scaled = (fraction, minimum) => Math.max(minimum, Math.floor(ITER * fraction));
  const selected = [
    run('encode', [ITER, encodeSuite]),
    run('decode', [ITER, decodeSuite]),
    run('corrupt', [scaled(0.1, 10), corruptSuite]),
    run('png', [ITER, pngSuite]),
    run('ecc', [ITER, eccSuite]),
    run('wasm', [scaled(0.1, 10), wasmSuite]),
    run('wasmraw', [scaled(0.15, 15), wasmRawSuite]),
    run('stack', [scaled(0.05, 5), stackSuite]),
  ].filter(Boolean);
  if (selected.length === 0) {
    console.error(`unknown suite: ${suiteName}`);
    process.exit(2);
  }

  console.log(`LCC fuzz seed=${SEED} iterations=${ITER} suite=${suiteName}\n`);
  for (const [name, iterations, fn] of selected) {
    await suite(name, iterations, fn);
  }

  if (rawMemoryBefore !== null) {
    const after = (await wasmMemoryStats()).bytes;
    const growth = after - rawMemoryBefore;
    report.wasmMemory = { before: rawMemoryBefore, after, growth };
    // Linear memory never shrinks; variable-size inputs legitimately raise the
    // high-water mark.  The deterministic per-call leak check lives in
    // scripts/audit-wasm.mjs, so only flag gross growth here.
    if (growth > 16 * 1024 * 1024) {
      fail('wasmraw: wasm memory grew unexpectedly during fuzzing', `${growth} bytes`);
    }
  }

  const findings = report.findings.length;
  console.log(`\nfindings: ${findings}`);
  for (const finding of report.findings.slice(0, 20)) {
    console.log(` - ${finding.message}${finding.detail ? `: ${finding.detail}` : ''}`);
  }
  if (report.slowest.length) {
    console.log(`slow cases (>1s): ${report.slowest.length}`);
  }

  if (args.json) {
    const out = path.resolve(String(args.json));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }

  if (findings > 0 && args.strict) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
