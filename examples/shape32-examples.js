/**
 * README 32-symbol layer examples.
 *
 * Generates one text for each rich shape layer: L3u (32 colors),
 * L4eS (64 colors), L4fS (256 colors). These layers are intended for
 * digital/print/controlled capture, not casual phone photos.
 *
 * Run: node examples/shape32-examples.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { encode } from '../src/encoder.js';
import { decodeAuto } from '../src/decoder.js';
import { encodePNG, decodePNG } from '../src/png.js';

const outDir = path.resolve('demo_outputs');
fs.mkdirSync(outDir, { recursive: true });

const cases = [
  {
    name: 'lorem_ipsum',
    label: 'Lorem ipsum',
    layer: 'L3u',
    width: 1024,
    height: 1024,
    file: 'examples/lorem_ipsum.txt',
  },
  {
    name: 'heart_sutra',
    label: '心经',
    layer: 'L4eS',
    width: 1024,
    height: 1024,
    file: 'examples/心经.txt',
  },
  {
    name: 'diamond_sutra',
    label: '金刚经',
    layer: 'L4fS',
    width: 3072,
    height: 3072,
    file: 'examples/金刚经.txt',
  },
];

const rows = [];
for (const item of cases) {
  const text = item.file ? fs.readFileSync(item.file, 'utf8') : item.text;
  const bytes = Buffer.byteLength(text, 'utf8');
  const result = encode(text, {
    layer: item.layer,
    width: item.width,
    height: item.height,
    mode: 'fill',
    maxModulePx: 32,
  });
  const file = path.join(outDir, `${item.name}_${item.layer}.png`);
  const png = encodePNG(result.image);
  fs.writeFileSync(file, png);
  const decoded = decodeAuto(decodePNG(png));
  const ok = decoded.text === text;
  const row = {
    name: item.name,
    label: item.label,
    bytes,
    layer: item.layer,
    version: result.meta.version,
    N: result.meta.N,
    moduleSize: result.meta.moduleSize,
    bitsPerModule: result.meta.bitsPerModule,
    shapeSetSize: result.meta.shapeSetSize,
    ecc: result.meta.ecc,
    eccLevel: result.meta.eccLevel,
    minDeltaE: result.meta.minDeltaE,
    paletteSize: result.meta.paletteSize,
    quietZone: result.meta.quietZone,
    payloadCapacity: result.meta.payloadCapacity,
    corrected: decoded.meta.correctedSymbols,
    ok,
    file: path.relative(process.cwd(), file).split(path.sep).join('/'),
  };
  rows.push(row);
  console.log(
    `${row.label} ${row.bytes}B -> ${row.layer} v${row.version} N=${row.N} ` +
    `s=${row.moduleSize}px bpm=${row.bitsPerModule.toFixed(2)} ` +
    `shapes=${row.shapeSetSize} ECC=${row.eccLevel} cap=${row.payloadCapacity}B ` +
    `decoded=${row.ok ? 'OK' : 'FAIL'} corrected=${row.corrected} -> ${row.file}`,
  );
}

fs.writeFileSync(
  path.join(outDir, 'shape32-examples.json'),
  `${JSON.stringify(rows, null, 2)}\n`,
);
