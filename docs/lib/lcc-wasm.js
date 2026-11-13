/**
 * Loader for the C decode core in lcc-decoder.wasm.
 *
 * Node instantiates synchronously during module evaluation, so these
 * functions stay synchronous.  Browsers fetch the artifact asynchronously
 * during module evaluation (top-level await).
 */

import {
  compileWasmAsync,
  compileWasmBytes,
  instantiateWasmModule,
  isNode,
  loadWasmBytes,
  wasmSimdSupported,
} from './wasm-common.js';

const wasmFile = wasmSimdSupported() ? 'lcc-decoder.wasm' : 'lcc-decoder-baseline.wasm';
const wasmBytes = await loadWasmBytes(wasmFile);
const wasmModule = isNode ? compileWasmBytes(wasmBytes) : await compileWasmAsync(wasmBytes);
let wasm = instantiateWasmModule(wasmModule);

let forcedTrap = false;

/** Drop the cached instance (a wasm trap can leave allocator state unusable). */
export function resetWasmInstance() {
  wasm = instantiateWasmModule(wasmModule);
}

/** Test-only hook: make the next protected wasm call throw a RuntimeError. */
export function forceNextWasmTrap() {
  forcedTrap = true;
}

function trapSafe(fn) {
  if (forcedTrap) {
    forcedTrap = false;
    wasm = instantiateWasmModule(wasmModule);
    const err = new Error('forced wasm trap');
    err.name = 'RuntimeError';
    throw err;
  }
  try {
    return fn();
  } catch (err) {
    if (err && err.name === 'RuntimeError') wasm = instantiateWasmModule(wasmModule);
    throw err;
  }
}

function writeBytes(bytes) {
  return wasm.write(bytes);
}

function readLast() {
  return wasm.readLast();
}

const CALIBRATION = ['threshold', 'gray-map', 'identity-clean', 'affine', 'identity'];
const ECC_NAMES = [[0.20, 'L'], [0.30, 'M'], [0.35, 'Q'], [0.40, 'H']];

function eccName(ecc) {
  const hit = ECC_NAMES.find(([value]) => Math.abs(value - ecc) < 1e-9);
  return hit ? hit[1] : null;
}

function cString(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function packStack(frames, detections, options) {
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
    const H = valid && Array.isArray(det.homography) ? det.homography : null;
    i32(H ? 1 : 0);
    for (let h = 0; h < 9; h++) f64(H ? H[h] : 0);
    f64(valid ? det.originX ?? 0 : 0);
    f64(valid ? det.originY ?? 0 : 0);
    f64(valid ? det.s ?? 0 : 0);
  }
  return concat(chunks);
}

function concat(chunks) {
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function parseStack(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getInt32(0, true);
  if (status !== 0) throw new Error('LCC wasm stack failed');
  const width = view.getInt32(4, true);
  const height = view.getInt32(8, true);
  return {
    image: { width, height, data: bytes.slice(48, 48 + width * height * 3) },
    frames: view.getInt32(12, true),
    requested: view.getInt32(16, true),
    stacked: view.getInt32(20, true) === 1,
    noise: view.getFloat64(40, true),
    version: view.getInt32(24, true),
    N: view.getInt32(28, true),
    moduleSize: view.getInt32(32, true),
    quietZone: view.getInt32(36, true),
  };
}

function parseDecode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getInt32(0, true);
  if (status === 3) return null;
  if (status !== 0) throw new Error('LCC wasm decode failed');
  const payloadLen = view.getUint32(92, true);
  const payload = bytes.slice(120, 120 + payloadLen);
  const shapeSet = view.getInt32(56, true);
  const ecc = view.getFloat64(20, true);
  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    text = null;
  }
  return {
    payload,
    text,
    meta: {
      layer: cString(bytes.subarray(96, 104)),
      version: view.getInt32(4, true),
      N: view.getInt32(8, true),
      moduleSize: view.getFloat64(12, true),
      ecc,
      eccLevel: eccName(ecc),
      correctedSymbols: view.getInt32(28, true),
      paletteSize: view.getInt32(32, true),
      minDeltaE: view.getFloat64(36, true),
      constraint: view.getInt32(44, true) === 1,
      harmony: view.getInt32(48, true) === 1,
      seed: view.getInt32(52, true),
      shapeSetSize: shapeSet,
      shapeBits: shapeSet > 1 ? Math.log2(shapeSet) : 0,
      bitsPerModule: view.getFloat64(60, true),
      formatBlocks: view.getInt32(68, true),
      dataCount: view.getInt32(72, true),
      rsSymbols: view.getInt32(76, true),
      constraintRankCount: view.getInt32(80, true),
      constraintMaxDiff: view.getInt32(84, true),
      calibration: CALIBRATION[view.getInt32(88, true)] ?? 'identity',
      paletteMode: cString(bytes.subarray(104, 120)),
    },
  };
}

export function stackCanonicalFramesWasm(frames, detections, options = {}) {
  const packed = packStack(frames, detections, options);
  const ptr = writeBytes(packed);
  try {
    trapSafe(() => wasm.exports.lcc_api_stack(ptr, packed.length));
    return parseStack(readLast());
  } finally {
    wasm.exports.free(ptr);
  }
}

export function decodeAutoWasm(image, options = {}) {
  const mode = options.detector === 'axis' ? 1 : options.detector === 'perspective' ? 2 : 0;
  const ptr = writeBytes(image.data);
  try {
    trapSafe(() => wasm.exports.lcc_api_decode(ptr, image.data.length, image.width, image.height, mode));
    return parseDecode(readLast());
  } finally {
    wasm.exports.free(ptr);
  }
}

function packDetect(image, perspective, variantName) {
  const name = String(variantName ?? 'otsu').slice(0, 31);
  const bytes = new Uint8Array(48 + image.data.length);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, image.width, true);
  view.setInt32(4, image.height, true);
  view.setInt32(8, perspective ? 1 : 0, true);
  view.setInt32(12, image.data.length, true);
  bytes.set(new TextEncoder().encode(name), 16);
  bytes.set(image.data, 48);
  return bytes;
}

function parseDetect(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getInt32(0, true);
  if (status !== 0 || view.getInt32(4, true) !== 1) {
    throw new Error('LCC detect: no usable symbol geometry');
  }
  const hasH = view.getInt32(60, true) === 1;
  const homography = hasH ? [] : null;
  if (hasH) {
    for (let i = 0; i < 9; i++) homography.push(view.getFloat64(64 + i * 8, true));
  }
  return {
    originX: view.getFloat64(24, true),
    originY: view.getFloat64(32, true),
    s: view.getFloat64(16, true),
    N: view.getInt32(12, true),
    version: view.getInt32(8, true),
    score: view.getFloat64(40, true),
    threshold: view.getFloat64(48, true),
    axis: view.getInt32(56, true) === 1,
    has_h: hasH,
    homography,
  };
}

function runDetect(image, options, perspective) {
  const variant = options.variant;
  const name = typeof variant === 'string' ? variant : variant?.name;
  const packed = packDetect(image, perspective, name);
  const ptr = writeBytes(packed);
  try {
    const status = trapSafe(() => wasm.exports.lcc_api_detect(ptr, packed.length));
    if (status !== 0) throw new Error('LCC detect: no usable symbol geometry');
    return parseDetect(readLast());
  } finally {
    wasm.exports.free(ptr);
  }
}

export function detectSymbolWasm(image, options = {}) {
  return runDetect(image, options, false);
}

export function detectPerspectiveWasm(image, options = {}) {
  return runDetect(image, options, true);
}

export function decodeExplicitWasm(image, { originX, originY, moduleSize, version, threshold = 128 }) {
  const ptr = writeBytes(image.data);
  try {
    trapSafe(() => wasm.exports.lcc_api_decode_explicit(
      ptr, image.data.length, image.width, image.height,
      originX, originY, moduleSize, version, threshold,
    ));
    return parseDecode(readLast());
  } finally {
    wasm.exports.free(ptr);
  }
}

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
  return concat(chunks);
}

function parseDebugRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const records = [];
  for (let i = 0; i < count; i++) {
    const base = 4 + i * (16 + 256 * 4);
    const res = new Float32Array(256);
    for (let k = 0; k < 256; k++) res[k] = view.getFloat32(base + 16 + k * 4, true);
    records.push({
      row: view.getInt32(base, true),
      col: view.getInt32(base + 4, true),
      gridN: view.getInt32(base + 8, true),
      shape: view.getInt32(base + 12, true),
      res,
    });
  }
  return records;
}

export function debugResidualsWasm(image, options = {}) {
  const mode = options.detector === 'axis' ? 1 : options.detector === 'perspective' ? 2 : 0;
  const ptr = writeBytes(image.data);
  try {
    const status = trapSafe(() => wasm.exports.lcc_api_debug_residuals(ptr, image.data.length, image.width, image.height, mode));
    return { status, records: parseDebugRecords(readLast()) };
  } finally {
    wasm.exports.free(ptr);
  }
}

export function debugResidualsForcedWasm(image, homography, version, N, moduleSize) {
  if (!Array.isArray(homography) || homography.length !== 9) {
    throw new Error('debugResidualsForcedWasm: homography must be an array of 9 numbers');
  }
  const ptr = writeBytes(image.data);
  try {
    const status = trapSafe(() => wasm.exports.lcc_api_debug_residuals_h(
      ptr, image.data.length, image.width, image.height,
      homography[0], homography[1], homography[2],
      homography[3], homography[4], homography[5],
      homography[6], homography[7], homography[8],
      version, N, moduleSize,
    ));
    return { status, records: parseDebugRecords(readLast()) };
  } finally {
    wasm.exports.free(ptr);
  }
}

/**
 * Raw wasm exports, for security audits that need to call the C API with
 * deliberately malformed buffers.
 */
export function wasmExports() {
  return wasm.exports;
}

/**
 * Current size of the wasm linear memory in bytes, plus the exported heap
 * pointers.
 */
export function wasmMemoryStats() {
  return wasm.memoryStats();
}

export function scanFramesWasm(frames) {
  const packed = packScan(frames);
  const ptr = writeBytes(packed);
  try {
    trapSafe(() => wasm.exports.lcc_api_scan(ptr, packed.length));
    return parseDecode(readLast());
  } finally {
    wasm.exports.free(ptr);
  }
}
