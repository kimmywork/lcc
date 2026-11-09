/**
 * Two minimal LCC demos.
 *
 * Run:  npm run demo
 * Outputs: demo_outputs/demo_L2.png, demo_outputs/demo_L3b.png
 */

import fs from 'node:fs';
import path from 'node:path';
import { encode } from '../src/encoder.js';
import { decode } from '../src/decoder.js';
import { encodePNG, decodePNG } from '../src/png.js';

const outDir = path.resolve('demo_outputs');
fs.mkdirSync(outDir, { recursive: true });

const demos = [
  {
    name: 'demo_L2a',
    layer: 'L2a',
    text: 'LCC demo · L2a 4-level gray · 你好，分层彩色码！',
    options: { width: 512, height: 512, mode: 'fill', maxModulePx: 32, constraint: false },
  },
  {
    name: 'demo_L3c',
    layer: 'L3c',
    text: 'https://example.com/lcc?layer=L3c&demo=1',
    options: { width: 512, height: 512, mode: 'fill', maxModulePx: 32, constraint: false },
  },
];

for (const demo of demos) {
  const result = encode(demo.text, { layer: demo.layer, ...demo.options });
  const png = encodePNG(result.image);
  const file = path.join(outDir, `${demo.name}.png`);
  fs.writeFileSync(file, png);

  const decoded = decode(decodePNG(png));
  const ok = decoded.text === demo.text;

  console.log(`\n=== ${demo.name} ===`);
  console.log(`layer       : ${result.meta.layer}`);
  console.log(`version/N   : v${result.meta.version} / ${result.meta.N}x${result.meta.N} modules`);
  console.log(`module size : ${result.meta.moduleSize}px`);
  console.log(`palette     : ${result.meta.paletteMode}${result.meta.harmony ? ' + harmony' : ''}`);
  console.log(`constraint  : ${result.meta.constraint ? 'on' : 'off'}`);
  console.log(`bits/module : ${result.meta.bitsPerModule.toFixed(3)}`);
  console.log(`payload     : ${result.meta.payloadSize} bytes / capacity ${result.meta.payloadCapacity} bytes`);
  console.log(`image       : ${file}`);
  console.log(`decoded     : ${ok ? 'OK' : 'MISMATCH'}  (${JSON.stringify(decoded.text)})`);
  if (!ok) process.exitCode = 1;
}
