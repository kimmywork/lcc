/**
 * README text examples.
 *
 * Run: node examples/text-examples.js
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
    name: 'hello_world',
    label: 'Hello World!',
    layer: 'L1',
    width: 512,
    height: 512,
    text: 'Hello World!',
  },
  {
    name: 'quick_brown_fox',
    label: 'The quick brown fox',
    layer: 'L2a',
    width: 512,
    height: 512,
    text: 'The quick brown fox jumps over the lazy dog.',
  },
  {
    name: 'lorem_ipsum',
    label: 'Lorem ipsum',
    layer: 'L3c',
    width: 1024,
    height: 1024,
    file: 'examples/lorem_ipsum.txt',
  },
  {
    name: 'heart_sutra',
    label: '心经',
    layer: 'L3d',
    width: 1024,
    height: 1024,
    file: 'examples/心经.txt',
  },
  {
    name: 'diamond_sutra',
    label: '金刚经',
    layer: 'L4f',
    width: 2048,
    height: 2048,
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
    constraint: false,
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
    payloadCapacity: result.meta.payloadCapacity,
    corrected: decoded.meta.correctedSymbols,
    ok,
    file: path.relative(process.cwd(), file).split(path.sep).join('/'),
  };
  rows.push(row);
  console.log(
    `${row.label} ${row.bytes}B -> ${row.layer} v${row.version} N=${row.N} ` +
    `s=${row.moduleSize}px bpm=${row.bitsPerModule.toFixed(2)} cap=${row.payloadCapacity}B ` +
    `decoded=${row.ok ? 'OK' : 'FAIL'} corrected=${row.corrected} -> ${row.file}`,
  );
}

fs.writeFileSync(
  path.join(outDir, 'examples.json'),
  `${JSON.stringify(rows, null, 2)}\n`,
);
