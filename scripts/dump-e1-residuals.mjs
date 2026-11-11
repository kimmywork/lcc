#!/usr/bin/env node
/**
 * Dump forced-alignment residuals with both expected and C-decoded symbols.
 * This is the input to the E1 oracle-erasure budget simulation.
 *
 *   node scripts/dump-e1-residuals.mjs --manifest training/corpus/eval/manifest.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { encode } from '../src/encoder.js';
import { debugResidualsForcedSymbolsWasm } from '../docs/lib/lcc-wasm.js';

function parseArgs(argv) {
  const out = { manifest: 'training/corpus/eval/manifest.json', out: 'training/corpus/e1_residuals' };
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

function truthFor(sample) {
  const options = {
    layer: sample.layer,
    version: sample.version,
    moduleSize: sample.moduleSize,
    width: sample.width,
    height: sample.height,
    mode: 'fill',
    constraint: false,
    maxModulePx: 64,
  };
  if (sample.quietZone !== undefined) options.quietZone = sample.quietZone;
  const result = encode(sample.payload, options);
  const N = result.layout.N;
  const symbols = new Map();
  const indexByKey = new Map();
  result.layout.dataCoords.forEach(([row, col], index) => {
    const key = `${row},${col}`;
    symbols.set(key, result.symbols[row * N + col]);
    indexByKey.set(key, index);
  });
  return {
    symbols,
    indexByKey,
    dataCount: result.layout.dataCoords.length,
    ecc: result.meta.ecc,
    N,
    bitsPerModule: result.meta.bitsPerModule,
    colorCount: result.meta.paletteSize,
    layer: result.meta.layer,
  };
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
  for (let i = 0; i < manifest.samples.length; i++) {
    const sample = manifest.samples[i];
    if (!Array.isArray(sample.homographyModuleFlat)) continue;
    const image = readImage(root, sample);
    const truth = truthFor(sample);
    let debug = await debugResidualsForcedSymbolsWasm(
      image,
      sample.homographyModuleFlat,
      sample.version,
      sample.N,
      sample.moduleSize,
      0,
    );
    if (debug.meta?.layer !== truth.layer || debug.meta?.dataCount !== truth.dataCount) {
      const alt = await debugResidualsForcedSymbolsWasm(
        image,
        sample.homographyModuleFlat,
        sample.version,
        sample.N,
        sample.moduleSize,
        1,
      );
      if (alt.meta?.layer === truth.layer && alt.meta?.dataCount === truth.dataCount) debug = alt;
      else if ((alt.meta?.dataCount ?? 0) > (debug.meta?.dataCount ?? 0)) debug = alt;
    }
    if (!debug.records.length) continue;
    let kept = 0;
    const sampleIndex = samples.length;
    for (const rec of debug.records) {
      const key = `${rec.row},${rec.col}`;
      const expected = truth.symbols.get(key);
      const moduleIndex = truth.indexByKey.get(key);
      if (expected === undefined || moduleIndex === undefined || rec.symbol < 0) continue;
      records.push({
        sampleIndex,
        moduleIndex,
        row: rec.row,
        col: rec.col,
        gridN: rec.gridN,
        expectedShape: -1,
        cShape: rec.shape,
        expectedSymbol: expected,
        cSymbol: rec.symbol,
        res: rec.res,
      });
      kept++;
    }
    if (!kept) continue;
    samples.push({
      file: sample.file,
      layer: truth.layer,
      version: sample.version,
      N: truth.N,
      moduleSize: sample.moduleSize,
      bitsPerModule: truth.bitsPerModule,
      colorCount: truth.colorCount,
      dataCount: truth.dataCount,
      ecc: truth.ecc,
      status: debug.status,
      cLayer: debug.meta?.layer ?? '',
      cVersion: debug.meta?.version ?? 0,
      cN: debug.meta?.N ?? 0,
      cDataCount: debug.meta?.dataCount ?? 0,
      cShapeSet: debug.meta?.shapeSet ?? 0,
      records: kept,
    });
    if ((i + 1) % 20 === 0) process.stderr.write(`\r${i + 1}/${manifest.samples.length}`);
  }
  process.stderr.write('\n');

  const header = 12;
  const recordBytes = 9 * 4 + 256 * 4;
  const buf = Buffer.alloc(header + records.length * recordBytes);
  buf.write('CRES', 0, 'ascii');
  buf.writeUInt32LE(3, 4);
  buf.writeUInt32LE(records.length, 8);
  let off = header;
  for (const rec of records) {
    buf.writeInt32LE(rec.sampleIndex, off); off += 4;
    buf.writeInt32LE(rec.moduleIndex, off); off += 4;
    buf.writeInt32LE(rec.row, off); off += 4;
    buf.writeInt32LE(rec.col, off); off += 4;
    buf.writeInt32LE(rec.gridN, off); off += 4;
    buf.writeInt32LE(rec.expectedShape, off); off += 4;
    buf.writeInt32LE(rec.cShape, off); off += 4;
    buf.writeInt32LE(rec.expectedSymbol, off); off += 4;
    buf.writeInt32LE(rec.cSymbol, off); off += 4;
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
  console.log(`wrote ${records.length} E1 records from ${samples.length} frames to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
