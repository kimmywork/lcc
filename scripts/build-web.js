/**
 * Copy the browser-compatible core into docs/lib for GitHub Pages.
 * Node-only PNG I/O (src/png.js) is intentionally excluded.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const src = path.join(root, 'src');
const out = path.join(root, 'docs', 'lib');
// Keep the browser bundle free of the JavaScript reference codec pipeline.
// The public browser entry points only use the two wasm artifacts plus the
// small detection/stack/SVG helpers.
const skip = new Set([
  'png.js',
  'node-io.js',
  'cli.js',
  'bitstream.js',
  'constraint.js',
  'frame.js',
  'layout.js',
  'palettes.js',
  'whitening.js',
  'local-rank.js',
  'illumination.js',
  'ecc',
  'format',
]);
const keepNames = ['lcc-decoder.wasm', 'lcc-encoder.wasm'];
const kept = new Map();
for (const name of keepNames) {
  const file = path.join(out, name);
  if (fs.existsSync(file)) kept.set(name, fs.readFileSync(file));
}

fs.rmSync(out, { recursive: true, force: true });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const f = path.join(from, entry.name);
    const t = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(f, t);
    else if (entry.name.endsWith('.js')) fs.copyFileSync(f, t);
  }
}

copyDir(src, out);
for (const [name, bytes] of kept) {
  fs.writeFileSync(path.join(out, name), bytes);
}

const exOut = path.join(root, 'docs', 'examples');
fs.mkdirSync(exOut, { recursive: true });
for (const name of ['心经.txt', '金刚经.txt']) {
  fs.copyFileSync(path.join(root, 'examples', name), path.join(exOut, name));
}

console.log(`LCC web build: ${out}`);
