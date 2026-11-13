/**
 * Shared wasm loader used by the decoder and encoder artifacts.
 *
 * Node loads the module synchronously during module initialization, so the
 * public encode/decode APIs stay synchronous.  Browsers fetch and instantiate
 * asynchronously; top-level await in the callers makes that transparent.
 */

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

function wasiImports() {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const base = {
    args_sizes_get(argcPtr, argvBufSizePtr) {
      view().setUint32(argcPtr, 0, true);
      view().setUint32(argvBufSizePtr, 0, true);
      return 0;
    },
    args_get() { return 0; },
    environ_sizes_get(countPtr, sizePtr) {
      view().setUint32(countPtr, 0, true);
      view().setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get() { return 0; },
    fd_close() { return 0; },
    fd_seek() { return 0; },
    fd_write() { return 0; },
    fd_fdstat_get() { return 0; },
    fd_prestat_get() { return 8; },
    fd_prestat_dir_name() { return 0; },
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

export async function loadWasmBytes(filename) {
  const candidates = [
    new URL(`./${filename}`, import.meta.url),
    new URL(`../docs/lib/${filename}`, import.meta.url),
  ];
  if (isNode) {
    const { readFileSync, existsSync } = await import('node:fs');
    for (const url of candidates) {
      if (existsSync(url)) return readFileSync(url);
    }
    throw new Error(`LCC wasm not found: ${filename} (run npm run build:wasm)`);
  }
  let lastStatus = 0;
  for (const url of candidates) {
    const response = await fetch(url);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    lastStatus = response.status;
  }
  throw new Error(`LCC wasm fetch failed: ${filename} (${lastStatus})`);
}

export function instantiateWasmBytes(bytes) {
  const imports = wasiImports();
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: imports.wasi_snapshot_preview1,
  });
  const exports = instance.exports;
  imports.bind(exports.memory);
  return {
    exports,
    write(bytesIn) {
      const ptr = exports.malloc(bytesIn.length);
      if (!ptr) throw new Error('LCC wasm: out of memory');
      new Uint8Array(exports.memory.buffer).set(bytesIn, ptr);
      return ptr;
    },
    readLast() {
      const ptr = exports.lcc_last();
      const len = exports.lcc_last_len();
      if (!ptr || len <= 0) throw new Error('LCC wasm: empty result');
      return new Uint8Array(exports.memory.buffer).slice(ptr, ptr + len);
    },
    memoryStats() {
      return {
        bytes: exports.memory.buffer.byteLength,
        lastPtr: exports.lcc_last(),
        lastLen: exports.lcc_last_len(),
      };
    },
  };
}
