#!/usr/bin/env node
/**
 * Dump the exact 16x16 residual grids the C decoder uses for shape matching.
 *
 * Input is the axis-aligned blur_shape corpus. Each sample is re-encoded with
 * the same parameters to recover its symbol/layout ground truth, then the
 * degraded frame is decoded by the C core and the captured residuals are
 * written with their expected shape.
 *
 *   node scripts/dump-c-residuals.mjs --manifest training/corpus/blur_shape/manifest.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { encode } from '../src/encoder.js';
import { debugResidualsWasm, debugResidualsForcedWasm } from '../src/lcc-wasm.js';

function parseArgs(argv) {
  const out = { manifest: 'training/corpus/blur_shape/manifest.json', out: 'training/corpus/c_residuals', detector: 'axis', onlyOk: true };
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

function expectedShapes(sample) {
  const result = encode(sample.payload, {
    layer: sample.layer,
    version: sample.version,
    moduleSize: sample.moduleSize,
    quietZone: sample.quietZone,
    width: sample.width,
    height: sample.height,
    mode: 'fill',
    constraint: false,
    maxModulePx: 32,
  });
  const colorCount = result.meta.paletteSize;
  const N = result.layout.N;
  const shapes = new Map();
  for (const [row, col] of result.layout.dataCoords) {
    const symbol = result.symbols[row * N + col];
    shapes.set(`${row},${col}`, Math.floor(symbol / colorCount));
  }
  return { shapes, layer: result.meta.layer, N, colorCount };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(String(args.manifest));
  const root = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const outDir = path.resolve(String(args.out));
  fs.mkdirSync(outDir, { recursive: true });

  const records = [];
  const samples = [];
  let used = 0;
  for (let i = 0; i < manifest.samples.length; i++) {
    const sample = manifest.samples[i];
    const image = readImage(root, sample);
    const truth = expectedShapes(sample);
    const debug = args.detector === 'forced'
      ? await debugResidualsForcedWasm(
        image,
        sample.homographyModuleFlat,
        sample.version,
        sample.N,
        sample.moduleSize,
      )
      : await debugResidualsWasm(image, { detector: String(args.detector) });
    if (!debug.records.length) continue;
    // Automatic capture keeps only the final attempt's records, but a failed
    // sample can still have reached module matching before RS rejected it.
    // Skip those by default so labels always come from the winning variant.
    if (args.onlyOk && args.detector !== 'forced' && debug.status !== 0) continue;
    const sampleIndex = samples.length;
    samples.push({
      file: sample.file,
      layer: truth.layer,
      version: sample.version,
      N: truth.N,
      moduleSize: sample.moduleSize,
      colorCount: truth.colorCount,
      difficulty: sample.difficulty,
      status: debug.status,
      records: debug.records.length,
    });
    let kept = 0;
    for (const rec of debug.records) {
      const expected = truth.shapes.get(`${rec.row},${rec.col}`);
      if (expected === undefined) continue;
      records.push({ sampleIndex, ...rec, expected });
      kept++;
    }
    if (kept) used++;
    if ((i + 1) % 20 === 0) process.stderr.write(`\r${i + 1}/${manifest.samples.length}`);
  }
  process.stderr.write(`\n`);

  // Binary layout:
  //   char magic[4] = "CRES", u32 version, u32 count
  //   record: i32 sample, i32 row, i32 col, i32 gridN, i32 expected,
  //           i32 cShape, f32 res[256]
  const header = 12;
  const recordBytes = 6 * 4 + 256 * 4;
  const buf = Buffer.alloc(header + records.length * recordBytes);
  buf.write('CRES', 0, 'ascii');
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(records.length, 8);
  let off = header;
  for (const rec of records) {
    buf.writeInt32LE(rec.sampleIndex, off); off += 4;
    buf.writeInt32LE(rec.row, off); off += 4;
    buf.writeInt32LE(rec.col, off); off += 4;
    buf.writeInt32LE(rec.gridN, off); off += 4;
    buf.writeInt32LE(rec.expected, off); off += 4;
    buf.writeInt32LE(rec.shape, off); off += 4;
    for (let k = 0; k < 256; k++) {
      buf.writeFloatLE(rec.res[k] ?? 0, off);
      off += 4;
    }
  }
  fs.writeFileSync(path.join(outDir, 'residuals.bin'), buf);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    source: path.basename(root),
    samples,
    records: records.length,
    recordBytes,
  }, null, 2));
  console.log(`wrote ${records.length} residuals from ${used}/${manifest.samples.length} frames to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
