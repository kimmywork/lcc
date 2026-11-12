#!/usr/bin/env node
/**
 * Run the real-photo validation set through the WASM scanner.
 *
 *   node scripts/bench-real.mjs
 *
 * Photos are expected under photo/png and photo/pngjpg (gitignored). Text is
 * reported only as a prefix; the important signal is whether CRC/RS accepted
 * the frame and how long the scan took.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from '../src/png.js';
import { scanFramesWasm } from '../docs/lib/lcc-wasm.js';

// Only a decoder rejection is a normal miss. Loader/OOM failures should abort
// the run so a missing or broken wasm cannot look like a low recognition rate.
function isDecodeMiss(err) {
  return err instanceof Error && err.message === 'LCC wasm decode failed';
}

function parseArgs(argv) {
  const out = { repeat: 1 };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repeat = Math.max(1, Number(args.repeat) || 1);
  const dirs = ['photo/png', 'photo/pngjpg'].filter((d) => fs.existsSync(d));
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.png')) files.push(path.join(dir, name));
    }
  }
  files.sort();
  const rows = [];
  for (const file of files) {
    const image = decodePNG(fs.readFileSync(file));
    let result = null;
    let error = null;
    const t0 = performance.now();
    for (let r = 0; r < repeat; r++) {
      try {
        result = await scanFramesWasm([image]);
      } catch (e) {
        if (!isDecodeMiss(e)) throw e;
        error = 'miss';
        result = null;
      }
    }
    const ms = (performance.now() - t0) / repeat;
    rows.push({ file, ms, result, error });
    const text = result?.text ? JSON.stringify(result.text.slice(0, 28)) : (error ?? 'miss');
    console.log(
      `${path.basename(file)} ${image.width}x${image.height} `
      + `${result ? 'OK' : 'FAIL'} ${result?.meta?.layer ?? '-'} ${ms.toFixed(0)}ms ${text}`
    );
  }
  const ok = rows.filter((r) => r.result).length;
  const times = rows.map((r) => r.ms);
  console.log(JSON.stringify({
    total: rows.length,
    ok,
    okPct: Number(((100 * ok) / rows.length).toFixed(1)),
    meanMs: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
