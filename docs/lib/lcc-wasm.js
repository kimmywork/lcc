/**
 * Small loader for the C scan core in lcc.wasm.
 * The module is wasm32-wasi and only needs a handful of preview1 calls.
 */

let instancePromise = null;

/** Drop the cached instance (a wasm trap can leave allocator state unusable). */
export function resetWasmInstance() {
  instancePromise = null;
}

let forcedTrap = false;

/** Test-only hook: make the next protected wasm call throw a RuntimeError. */
export function forceNextWasmTrap() {
  forcedTrap = true;
}

function trapSafe(fn) {
  if (forcedTrap) {
    forcedTrap = false;
    instancePromise = null;
    const err = new Error('forced wasm trap');
    err.name = 'RuntimeError';
    throw err;
  }
  try {
    return fn();
  } catch (err) {
    if (err && err.name === 'RuntimeError') instancePromise = null;
    throw err;
  }
}

function wasiImports() {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const base = {
    args_sizes_get(argcPtr, argvBufSizePtr) {
      view().setUint32(argcPtr, 0, true);
      view().setUint32(argvBufSizePtr, 0, true);
      return 0;
    },
    args_get() {
      return 0;
    },
    environ_sizes_get(countPtr, sizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get() {
      return 0;
    },
    fd_close() {
      return 0;
    },
    fd_seek() {
      return 0;
    },
    fd_write() {
      return 0;
    },
    fd_fdstat_get() {
      return 0;
    },
    fd_prestat_get() {
      return 8;
    },
    fd_prestat_dir_name() {
      return 0;
    },
    clock_time_get(id, precision, timePtr) {
      view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true);
      return 0;
    },
    proc_exit(code) {
      throw new Error(`LCC wasm exited ${code}`);
    },
    random_get(ptr, len) {
      const bytes = new Uint8Array(memory.buffer, ptr, len);
      if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
      else bytes.fill(1);
      return 0;
    },
  };
  return {
    wasi_snapshot_preview1: new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => 0;
      },
    }),
    bind(exportedMemory) {
      memory = exportedMemory;
    },
  };
}

async function loadInstance() {
  if (!instancePromise) {
    instancePromise = (async () => {
      const imports = wasiImports();
      let bytes;
      if (typeof process !== 'undefined' && process.versions?.node) {
        const { readFile } = await import('node:fs/promises');
        bytes = await readFile(new URL('./lcc.wasm', import.meta.url));
      } else {
        const response = await fetch(new URL('./lcc.wasm', import.meta.url));
        if (!response.ok) throw new Error(`LCC wasm fetch failed: ${response.status}`);
        bytes = await response.arrayBuffer();
      }
      const { instance } = await WebAssembly.instantiate(bytes, {
        wasi_snapshot_preview1: imports.wasi_snapshot_preview1,
      });
      imports.bind(instance.exports.memory);
      return instance.exports;
    })();
  }
  return instancePromise;
}

function writeBytes(exports, bytes) {
  const ptr = exports.malloc(bytes.length);
  if (!ptr) throw new Error('LCC wasm: out of memory');
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return ptr;
}

function readLast(exports) {
  const ptr = exports.lcc_last();
  const len = exports.lcc_last_len();
  if (!ptr || len <= 0) throw new Error('LCC wasm: empty result');
  return new Uint8Array(exports.memory.buffer).slice(ptr, ptr + len);
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
      shapeBits: shapeSet > 1 ? 3 : 0,
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

export async function stackCanonicalFramesWasm(frames, detections, options = {}) {
  const wasm = await loadInstance();
  const packed = packStack(frames, detections, options);
  const ptr = writeBytes(wasm, packed);
  try {
    trapSafe(() => wasm.lcc_api_stack(ptr, packed.length));
    return parseStack(readLast(wasm));
  } finally {
    wasm.free(ptr);
  }
}

export async function decodeAutoWasm(image, options = {}) {
  const wasm = await loadInstance();
  const mode = options.detector === 'axis' ? 1 : options.detector === 'perspective' ? 2 : 0;
  const ptr = writeBytes(wasm, image.data);
  try {
    trapSafe(() => wasm.lcc_api_decode(ptr, image.data.length, image.width, image.height, mode));
    return parseDecode(readLast(wasm));
  } finally {
    wasm.free(ptr);
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
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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


export async function debugResidualsWasm(image, options = {}) {
  const wasm = await loadInstance();
  const mode = options.detector === 'axis' ? 1 : options.detector === 'perspective' ? 2 : 0;
  const ptr = writeBytes(wasm, image.data);
  try {
    const status = trapSafe(() => wasm.lcc_api_debug_residuals(ptr, image.data.length, image.width, image.height, mode));
    return { status, records: parseDebugRecords(readLast(wasm)) };
  } finally {
    wasm.free(ptr);
  }
}

export async function debugResidualsForcedWasm(image, homography, version, N, moduleSize) {
  if (!Array.isArray(homography) || homography.length !== 9) {
    throw new Error('debugResidualsForcedWasm: homography must be an array of 9 numbers');
  }
  const wasm = await loadInstance();
  const ptr = writeBytes(wasm, image.data);
  try {
    const status = trapSafe(() => wasm.lcc_api_debug_residuals_h(
      ptr, image.data.length, image.width, image.height,
      homography[0], homography[1], homography[2],
      homography[3], homography[4], homography[5],
      homography[6], homography[7], homography[8],
      version, N, moduleSize,
    ));
    return { status, records: parseDebugRecords(readLast(wasm)) };
  } finally {
    wasm.free(ptr);
  }
}


/**
 * Raw wasm exports, for security audits that need to call the C API with
 * deliberately malformed buffers.  Normal callers should use the wrappers
 * above.  The wasm instance is cached and shared.
 */
export async function wasmExports() {
  return loadInstance();
}

/**
 * Current size of the wasm linear memory in bytes, plus the exported heap
 * pointers.  Used by leak/repeat-stability tests: wasm memory never shrinks,
 * so a stable value after warm-up means malloc/free are balanced.
 */
export async function wasmMemoryStats() {
  const wasm = await loadInstance();
  return {
    bytes: wasm.memory.buffer.byteLength,
    lastPtr: wasm.lcc_last(),
    lastLen: wasm.lcc_last_len(),
  };
}

export async function scanFramesWasm(frames) {
  const wasm = await loadInstance();
  const packed = packScan(frames);
  const ptr = writeBytes(wasm, packed);
  try {
    trapSafe(() => wasm.lcc_api_scan(ptr, packed.length));
    return parseDecode(readLast(wasm));
  } finally {
    wasm.free(ptr);
  }
}
