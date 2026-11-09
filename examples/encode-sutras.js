/**
 * Encode the two supplied sutra texts at their natural payload sizes.
 *
 * Run: node examples/encode-sutras.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { encode } from '../src/encoder.js';
import { decodeAuto } from '../src/decoder.js';
import { encodePNG, decodePNG } from '../src/png.js';

const outDir = path.resolve('demo_outputs');
fs.mkdirSync(outDir, { recursive: true });

const texts = [
  { name: '心经', file: 'examples/心经.txt' },
  { name: '金刚经', file: 'examples/金刚经.txt' },
];

const rows = [];
for (const item of texts) {
  const text = fs.readFileSync(item.file, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  for (const size of [1024, 2048]) {
    const result = encode(text, {
      layer: 'L3b',
      width: size,
      height: size,
      mode: 'fill',
      maxModulePx: 32,
      constraint: false,
    });
    const file = path.join(outDir, `${item.name}_L3b_${size}.png`);
    const png = encodePNG(result.image);
    fs.writeFileSync(file, png);
    const decoded = decodeAuto(decodePNG(png));
    const ok = decoded.text === text;
    rows.push({
      name: item.name,
      bytes,
      size,
      version: result.meta.version,
      N: result.meta.N,
      moduleSize: result.meta.moduleSize,
      bitsPerModule: result.meta.bitsPerModule,
      payloadCapacity: result.meta.payloadCapacity,
      corrected: decoded.meta.correctedSymbols,
      ok,
      file,
    });
  }
}

for (const r of rows) {
  console.log(
    `${r.name} ${r.bytes}B @ ${r.size}px -> v${r.version} N=${r.N} s=${r.moduleSize}px ` +
    `bpm=${r.bitsPerModule.toFixed(2)} cap=${r.payloadCapacity}B decoded=${r.ok ? 'OK' : 'FAIL'} ` +
    `corrected=${r.corrected} -> ${r.file}`,
  );
}
