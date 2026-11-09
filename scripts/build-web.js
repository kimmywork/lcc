/**
 * Copy the browser-compatible core into docs/lib for GitHub Pages.
 * Node-only PNG I/O (src/png.js) is intentionally excluded.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const src = path.join(root, 'src');
const out = path.join(root, 'docs', 'lib');
const skip = new Set(['png.js', 'node-io.js', 'cli.js']);

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

const exOut = path.join(root, 'docs', 'examples');
fs.mkdirSync(exOut, { recursive: true });
for (const name of ['心经.txt', '金刚经.txt']) {
  fs.copyFileSync(path.join(root, 'examples', name), path.join(exOut, name));
}

console.log(`LCC web build: ${out}`);
