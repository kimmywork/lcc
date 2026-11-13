#!/usr/bin/env node
/**
 * WASM security audit probes.
 *
 *   node scripts/audit-wasm.mjs
 *
 * These probes deliberately violate the C API contract.  They are kept out of
 * the normal test suite because they document current weaknesses rather than
 * desired behavior:
 *   - a malformed packed stack input leaks the frames/dets allocations
 *   - width*height*3 or total*module overflows reach raw memory access
 *   - a trapped call can leave the cached instance unusable for later calls
 */

import { performance } from 'node:perf_hooks';

import { encode } from '../src/index.js';
import { decodeAutoWasm, forceNextWasmTrap, wasmExports, wasmMemoryStats } from '../docs/lib/lcc-wasm.js';

const wasm = await wasmExports();

function writeBytes(bytes) {
  const ptr = wasm.malloc(bytes.length);
  if (!ptr) throw new Error('malloc failed');
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  return ptr;
}

function callStack(bytes) {
  const ptr = writeBytes(bytes);
  try {
    return wasm.lcc_api_stack(ptr, bytes.length);
  } finally {
    wasm.free(ptr);
  }
}

function i32(view, offset, value) {
  view.setInt32(offset, value, true);
  return offset + 4;
}

function f64(view, offset, value) {
  view.setFloat64(offset, value, true);
  return offset + 8;
}

function packedStackHeader() {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  let o = 0;
  o = i32(view, o, 2);       // count
  o = i32(view, o, 4);       // quiet zone
  o = i32(view, o, 0);       // module size (auto)
  o = i32(view, o, 1400);    // max dimension
  i32(view, o, 257);         // noise stride
  return bytes;
}

/** Truncated second frame: initial validation allocates frames/dets then fails. */
function truncatedStackInput() {
  const header = packedStackHeader();
  const frame = new Uint8Array(12 + 64 * 64 * 3);
  const view = new DataView(frame.buffer);
  i32(view, 0, 64);
  i32(view, 4, 64);
  i32(view, 8, 64 * 64 * 3);
  for (let i = 12; i < frame.length; i++) frame[i] = i % 251;
  const det = new Uint8Array(4 + 4 + 4 + 8 + 4 + 9 * 8 + 8 + 8 + 8);
  const dv = new DataView(det.buffer);
  let o = 0;
  o = i32(dv, o, 1);      // valid
  o = i32(dv, o, 2);      // version
  o = i32(dv, o, 25);     // N
  o = f64(dv, o, 1);      // score
  i32(dv, o, 0);          // has_h (rest are zero, which is fine)
  const total = new Uint8Array(header.length + frame.length + det.length);
  total.set(header, 0);
  total.set(frame, header.length);
  total.set(det, header.length + frame.length);
  return total;
}

/** Same as truncatedStackInput, but with an overflowing frame size check. */
function overflowingStackInput(N, moduleSize) {
  const header = packedStackHeader();
  const view = new DataView(header.buffer);
  view.setInt32(8, moduleSize, true);
  view.setInt32(12, 2147483647, true); // do not clamp module size in stack_frames
  const frame = new Uint8Array(12); // nbytes = 0, dims overflow width*height*3
  const fv = new DataView(frame.buffer);
  let o = 0;
  o = i32(fv, o, 65536);
  o = i32(fv, o, 65536);
  i32(fv, o, 0);
  const det = new Uint8Array(4 + 4 + 4 + 8 + 4 + 9 * 8 + 8 + 8 + 8);
  const dv = new DataView(det.buffer);
  let p = 0;
  p = i32(dv, p, 1);
  p = i32(dv, p, 1);
  p = i32(dv, p, N);
  p = f64(dv, p, 1);
  i32(dv, p, 0);
  // Duplicate the frame and detection so the stack has two candidates.
  const total = new Uint8Array(header.length + (frame.length + det.length) * 2);
  total.set(header, 0);
  total.set(frame, header.length);
  total.set(det, header.length + frame.length);
  total.set(frame, header.length + frame.length + det.length);
  total.set(det, header.length + 2 * frame.length + det.length);
  return total;
}

async function leakProbe(rounds = 100000) {
  const input = truncatedStackInput();
  const status = callStack(input);
  if (status !== 2) throw new Error(`expected BAD_INPUT, got ${status}`);
  const before = await wasmMemoryStats();
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) callStack(input);
  const after = await wasmMemoryStats();
  return {
    rounds,
    status,
    memoryBefore: before.bytes,
    memoryAfter: after.bytes,
    growth: after.bytes - before.bytes,
    growthPerCall: (after.bytes - before.bytes) / rounds,
    ms: performance.now() - t0,
  };
}

async function wrapperResetProbe() {
  const encoded = encode('reset probe', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  });
  let trapped = false;
  forceNextWasmTrap();
  try {
    await decodeAutoWasm(encoded.image, { detector: 'axis' });
  } catch (err) {
    trapped = err?.name === 'RuntimeError';
  }
  let recovered = false;
  try {
    const decoded = await decodeAutoWasm(encoded.image, { detector: 'axis' });
    recovered = decoded?.text === 'reset probe';
  } catch {
    recovered = false;
  }
  return { trapped, recovered };
}

async function isolationProbe() {
  const encoded = encode('isolation probe', {
    layer: 'C40', version: 2, moduleSize: 24, width: 512, height: 512, mode: 'fill', constraint: false,
  });
  const det = { version: 2, N: 25, s: 24, score: 1 };
  const baseline = await decodeAutoWasm(encoded.image, { detector: 'axis' });
  if (baseline.text !== 'isolation probe') throw new Error('baseline failed');

  let traps = 0;
  let recovered = 0;
  const trials = 20;
  for (let i = 0; i < trials; i++) {
    try {
      const input = overflowingStackInput(4096, 16);
      callStack(input);
    } catch (err) {
      if (err?.name === 'RuntimeError') traps++;
    }
    try {
      const decoded = await decodeAutoWasm(encoded.image, { detector: 'axis' });
      if (decoded.text === 'isolation probe') recovered++;
    } catch (err) {
      if (err?.name === 'RuntimeError') traps++;
    }
  }
  return { trials, traps, recovered };
}

const leak = await leakProbe();
console.log('malformed stack leak:', JSON.stringify(leak, null, 2));

const isolation = await isolationProbe();
console.log('post-trap isolation:', JSON.stringify(isolation, null, 2));

const reset = await wrapperResetProbe();
console.log('wrapper reset:', JSON.stringify(reset, null, 2));

const verdict = [];
if (leak.growth > 1024 * 1024) {
  verdict.push(`LEAK: ${(leak.growth / 1048576).toFixed(2)} MiB retained after ${leak.rounds} malformed calls`);
}
if (isolation.recovered < isolation.trials) {
  verdict.push(`ISOLATION: ${isolation.trials - isolation.recovered}/${isolation.trials} valid decodes failed after a trap`);
}
if (!reset.trapped || !reset.recovered) {
  verdict.push(`WRAPPER RESET: trapped=${reset.trapped} recovered=${reset.recovered}`);
}
if (verdict.length) {
  console.log('\nfindings:');
  for (const line of verdict) console.log(` - ${line}`);
  process.exitCode = 1;
} else {
  console.log('\nno leaks or state-isolation failures in this run');
}
