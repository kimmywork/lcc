#!/usr/bin/env node
/**
 * Decode benchmark for the C/WASM scan core.
 *
 *   node scripts/bench-wasm.mjs --manifest training/corpus/eval/manifest.json --mode scan
 *   node scripts/bench-wasm.mjs --manifest training/corpus/clean/manifest.json --mode decode
 *
 * The manifest is the same shape emitted by gen-lcc-corpus.mjs and make_eval.py.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodeAutoWasm, scanFramesWasm } from '../src/lcc-wasm.js';

function parseArgs(argv) {
  const out = {
    manifest: 'training/corpus/eval/manifest.json',
    mode: 'scan',
    limit: 0,
    repeat: 1,
  };
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

function readImage(root, sample) {
  const bytes = fs.readFileSync(path.join(root, sample.file));
  return {
    width: sample.width,
    height: sample.height,
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  };
}

// The decoder signals a normal recognition miss with this message. Anything
// else (missing wasm, OOM, loader failure) is infrastructure and must abort
// the benchmark instead of being scored as a miss.
function isDecodeMiss(err) {
  return err instanceof Error && err.message === 'LCC wasm decode failed';
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(String(args.manifest));
  const root = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const limit = Number(args.limit) || manifest.samples.length;
  const repeat = Math.max(1, Number(args.repeat) || 1);

  // The loader caches the instance. Reaching through the module keeps the
  // benchmark independent of a feature-specific wrapper.

  let ok = 0;
  let wrong = 0;
  let fail = 0;
  let total = 0;
  const times = [];
  const failures = [];
  const started = performance.now();

  for (let i = 0; i < limit; i++) {
    const sample = manifest.samples[i];
    const image = readImage(root, sample);
    for (let r = 0; r < repeat; r++) {
      const t0 = performance.now();
      let result = null;
      try {
        result = args.mode === 'decode'
          ? await decodeAutoWasm(image, { detector: args.detector ?? 'perspective' })
          : await scanFramesWasm([image]);
      } catch (err) {
        if (!isDecodeMiss(err)) throw err;
        result = null;
      }
      const dt = performance.now() - t0;
      total++;
      times.push(dt);
      if (result && result.text === sample.payload) ok++;
      else if (result && result.text != null) {
        wrong++;
        if (failures.length < 12) failures.push({ i, file: sample.file, kind: 'wrong', text: result.text.slice(0, 24) });
      } else {
        fail++;
        if (failures.length < 12) failures.push({ i, file: sample.file, kind: 'miss' });
      }
    }
    if ((i + 1) % 25 === 0) process.stderr.write(`\r${i + 1}/${limit}`);
  }

  const elapsed = performance.now() - started;
  const p = (n) => (total ? ((100 * n) / total).toFixed(1) : '0.0');
  console.log(JSON.stringify({
    manifest: path.basename(root),
    mode: args.mode,
    total,
    ok,
    wrong,
    fail,
    okPct: Number(p(ok)),
    wrongPct: Number(p(wrong)),
    failPct: Number(p(fail)),
    ms: {
      mean: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length),
      median: quantile(times, 0.5),
      p95: quantile(times, 0.95),
      max: Math.max(...times),
    },
    wallMs: elapsed,
    failures,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
