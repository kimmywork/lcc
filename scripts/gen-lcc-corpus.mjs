#!/usr/bin/env node
/**
 * Generate clean LCC symbols for model experiments.
 *
 * Writes one raw RGB file plus a manifest entry per symbol. The Python
 * training scripts apply perspective, blur, cast and noise afterwards and
 * keep the payload as the decode ground truth.
 *
 *   node scripts/gen-lcc-corpus.mjs --out training/corpus/clean --count 240
 */

import fs from 'node:fs';
import path from 'node:path';
import { encode } from '../src/encoder.js';

function parseArgs(argv) {
  const out = { count: 120, seed: 1, out: 'training/corpus/clean' };
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

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const LAYERS = ['L1', 'L2a', 'L3c', 'L1s', 'L2s', 'L3s', 'L3t'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;-_/';

function payloadOf(rand, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const count = Number(args.count);
  const seed = Number(args.seed);
  const outDir = path.resolve(String(args.out));
  fs.mkdirSync(outDir, { recursive: true });
  const rand = rng(seed);
  const manifest = [];

  for (let i = 0; i < count; i++) {
    let sample = null;
    for (let attempt = 0; attempt < 80 && !sample; attempt++) {
      const layer = LAYERS[Math.floor(rand() * LAYERS.length)];
      const shapeLayer = layer.endsWith('s') || layer === 'L3t';
      const version = 2 + Math.floor(rand() * 14);
      const moduleSize = shapeLayer
        ? 12 + Math.floor(rand() * 13)
        : 8 + Math.floor(rand() * 17);
      const quietZone = 2 + Math.floor(rand() * 3);
      const N = 21 + 4 * (version - 1);
      const side = (N + 2 * quietZone) * moduleSize;
      if (side > 1800) continue;
      const maxPayload = shapeLayer ? 90 : 240;
      const payload = payloadOf(rand, 8 + Math.floor(rand() * maxPayload));
      try {
        const result = encode(payload, {
          layer,
          version,
          moduleSize,
          quietZone,
          width: side,
          height: side,
          mode: 'fill',
          constraint: false,
          maxModulePx: 32,
        });
        sample = { payload, result, layer, version, moduleSize, quietZone };
      } catch {
        // payload did not fit this version/module combination
      }
    }
    if (!sample) continue;

    const { payload, result, layer, version, moduleSize, quietZone } = sample;
    const { width, height, data } = result.image;
    const file = `symbol-${String(i).padStart(4, '0')}.rgb`;
    fs.writeFileSync(path.join(outDir, file), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    const s = moduleSize;
    const finders = [
      [quietZone + 3.5, quietZone + 3.5],
      [quietZone + result.meta.N - 3.5, quietZone + 3.5],
      [quietZone + 3.5, quietZone + result.meta.N - 3.5],
    ].map(([mx, my]) => [mx * s, my * s]);
    manifest.push({
      file,
      width,
      height,
      payload,
      layer,
      version,
      N: result.meta.N,
      moduleSize: s,
      quietZone,
      finders,
    });
    if ((i + 1) % 25 === 0) process.stderr.write(`\r${i + 1}/${count}`);
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ seed, samples: manifest }, null, 2));
  process.stderr.write(`\nwrote ${manifest.length} symbols to ${outDir}\n`);
}

main();
