#!/usr/bin/env node
/**
 * Error-tolerance / partial-damage benchmark.
 *
 *   node scripts/bench-damage.mjs
 *   node scripts/bench-damage.mjs --json bench-results/damage.json --trials 4
 *
 * Damage is applied at module granularity, which is how real print defects,
 * stains, and dead pixels reach the decoder:
 *   - isolated wrong modules (count sweep)
 *   - burst/occlusion blocks
 *   - format-band bit flips (one copy / both copies)
 *   - QR module flips for comparison
 *
 * Decoding uses the C/WASM core.  Every successful decode must return the
 * exact payload; a successful wrong decode is counted separately and must stay
 * zero.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { encode } from '../src/index.js';
import { decodeAutoWasm } from '../docs/lib/lcc-wasm.js';
import { computeRSBlocks } from '../src/ecc/rs.js';
import { mulberry32 } from './lib/rng.mjs';
import { fmt, table } from './lib/stats.mjs';

function parseArgs(argv) {
  const out = { trials: 3, json: null, layers: 'G10,G20,G30,C40,C50,C33', ecc: 'L,M,Q,H' };
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

const args = parseArgs(process.argv.slice(2));
const TRIALS = Math.max(1, Number(args.trials) || 3);
const LAYERS = String(args.layers).split(',').map((s) => s.trim()).filter(Boolean);
const ECCS = String(args.ecc).split(',').map((s) => s.trim()).filter(Boolean);

function payloadOf(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function clone(image) {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}

function paintModule(image, meta, r, c, rgb) {
  const s = meta.moduleSize;
  const q = meta.quietZone;
  const x0 = (c + q) * s;
  const y0 = (r + q) * s;
  for (let dy = 0; dy < s; dy++) {
    let p = ((y0 + dy) * image.width + x0) * 3;
    for (let dx = 0; dx < s; dx++) {
      image.data[p++] = rgb[0];
      image.data[p++] = rgb[1];
      image.data[p++] = rgb[2];
    }
  }
}

function corruptModules(encoded, count, rng) {
  const out = clone(encoded.image);
  const { layout, meta, paletteInfo } = encoded;
  const palette = paletteInfo.palette;
  const total = layout.dataCoords.length;
  const chosen = new Set();
  while (chosen.size < Math.min(count, total)) chosen.add(Math.floor(rng() * total));
  for (const idx of chosen) {
    const [r, c] = layout.dataCoords[idx];
    const original = encoded.symbols[r * meta.N + c];
    const offset = 1 + Math.floor(rng() * Math.max(1, palette.length - 1));
    const symbol = (original + offset) % palette.length;
    paintModule(out, meta, r, c, palette[symbol]);
  }
  return out;
}

function burstDamage(encoded, size, rng) {
  const out = clone(encoded.image);
  const { layout, meta, paletteInfo } = encoded;
  const total = layout.dataCoords.length;
  const start = layout.dataCoords[Math.floor(rng() * total)];
  const color = paletteInfo.palette[paletteInfo.palette.length - 1];
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = start[0] + dr;
      const c = start[1] + dc;
      if (r >= meta.N || c >= meta.N) continue;
      if (!layout.dataCoords.some(([rr, cc]) => rr === r && cc === c)) continue;
      paintModule(out, meta, r, c, color);
    }
  }
  return out;
}

function formatBandDamage(encoded, copies, bits, rng) {
  const out = clone(encoded.image);
  const { layout, meta, paletteInfo } = encoded;
  const black = paletteInfo.palette[0];
  const white = paletteInfo.palette[paletteInfo.palette.length - 1];
  const copyList = layout.format.copies.slice(0, copies);
  for (const copy of copyList) {
    for (let b = 0; b < layout.format.blocksPerCopy; b++) {
      const row0 = copy.row0 + b * 2;
      const col0 = copy.col0;
      const order = Array.from({ length: 15 }, (_, i) => i).sort(() => rng() - 0.5);
      for (const j of order.slice(0, bits)) {
        const r = row0 + (j >= 8 ? 1 : 0);
        const c = col0 + (j % 8);
        const symbol = encoded.symbols[r * meta.N + c];
        paintModule(out, meta, r, c, symbol === layout.blackSymbol ? white : black);
      }
    }
  }
  return out;
}

function qrSymbol(payload, ecc) {
  return QRCode.create([{ data: Buffer.from(payload), mode: 'byte' }], { errorCorrectionLevel: ecc });
}

function qrImage(qr, scale = 8, border = 4) {
  const n = qr.modules.size;
  const side = (n + 2 * border) * scale;
  const data = new Uint8Array(side * side * 3).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.data[r * n + c]) continue;
      const y0 = (r + border) * scale;
      const x0 = (c + border) * scale;
      for (let dy = 0; dy < scale; dy++) {
        let p = ((y0 + dy) * side + x0) * 3;
        for (let dx = 0; dx < scale; dx++) {
          data[p++] = 0;
          data[p++] = 0;
          data[p++] = 0;
        }
      }
    }
  }
  return { width: side, height: side, data, scale, border, modules: n };
}

function qrDamage(payload, ecc, count, rng) {
  const qr = qrSymbol(payload, ecc);
  const n = qr.modules.size;
  const matrix = Uint8Array.from(qr.modules.data);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * n * n);
    matrix[idx] ^= 1;
  }
  const qrCopy = { modules: { size: n, data: matrix } };
  return { image: qrImage(qrCopy), n };
}

async function decodeLcc(image, payload) {
  try {
    const decoded = await decodeAutoWasm(image, { detector: 'auto' });
    if (!decoded) return { ok: false, wrong: false };
    const ok = hex(decoded.payload) === hex(payload);
    return { ok, wrong: !ok };
  } catch {
    return { ok: false, wrong: false };
  }
}

function decodeQr(image, payload) {
  try {
    const decoded = jsQR(
      (() => {
        const rgba = new Uint8ClampedArray(image.width * image.height * 4);
        for (let i = 0, p = 0, q = 0; i < image.width * image.height; i++, p += 3, q += 4) {
          rgba[q] = image.data[p];
          rgba[q + 1] = image.data[p + 1];
          rgba[q + 2] = image.data[p + 2];
          rgba[q + 3] = 255;
        }
        return rgba;
      })(),
      image.width,
      image.height,
    );
    if (!decoded) return { ok: false, wrong: false };
    const ok = hex(decoded.binaryData) === hex(payload);
    return { ok, wrong: !ok };
  } catch {
    return { ok: false, wrong: false };
  }
}

async function main() {
  const payload = payloadOf(64, 0xda11);
  const results = [];
  const summary = [];

  for (const layer of LAYERS) {
    for (const ecc of ECCS) {
      let encoded;
      try {
        encoded = encode(payload, {
          layer,
          version: 10,
          moduleSize: layer === 'C33' ? 16 : 12,
          quietZone: 4,
          width: 2048,
          height: 2048,
          mode: 'compact',
          constraint: false,
          eccLevel: ecc,
        });
      } catch {
        continue;
      }
      const blocks = computeRSBlocks(Math.floor(encoded.meta.capacityBits / 8), encoded.meta.ecc);
      const tPerBlock = blocks.reduce((s, b) => s + Math.floor(b.parity / 2), 0);
      const dataModules = encoded.layout.dataCoords.length;

      const rowBase = {
        layer,
        ecc: encoded.meta.eccLevel,
        version: encoded.meta.version,
        N: encoded.meta.N,
        dataModules,
        rsBlocks: blocks.length,
        tTotal: tPerBlock,
      };

      // Isolated module errors.
      for (const count of [1, 2, 4, 8, 16, 32, 64, 128]) {
        let ok = 0;
        let wrong = 0;
        for (let trial = 0; trial < TRIALS; trial++) {
          const rng = mulberry32(0xd000 + trial * 31 + count + layer.length);
          const damaged = corruptModules(encoded, count, rng);
          const res = await decodeLcc(damaged, payload);
          if (res.ok) ok++;
          if (res.wrong) wrong++;
        }
        results.push({ ...rowBase, damage: 'modules', amount: count, pct: (100 * count) / dataModules, trials: TRIALS, ok, wrong });
      }

      // Burst occlusion.
      for (const size of [3, 5, 8, 12]) {
        let ok = 0;
        let wrong = 0;
        for (let trial = 0; trial < TRIALS; trial++) {
          const rng = mulberry32(0xd100 + trial * 37 + size + layer.length);
          const damaged = burstDamage(encoded, size, rng);
          const res = await decodeLcc(damaged, payload);
          if (res.ok) ok++;
          if (res.wrong) wrong++;
        }
        results.push({ ...rowBase, damage: 'burst', amount: size * size, pct: (100 * size * size) / dataModules, trials: TRIALS, ok, wrong });
      }

      // Format band damage: 1/2/3 bits in one copy, then in both copies.
      for (const [copies, bits] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]) {
        let ok = 0;
        let wrong = 0;
        for (let trial = 0; trial < TRIALS; trial++) {
          const rng = mulberry32(0xd200 + trial * 41 + bits * 3 + copies);
          const damaged = formatBandDamage(encoded, copies, bits, rng);
          const res = await decodeLcc(damaged, payload);
          if (res.ok) ok++;
          if (res.wrong) wrong++;
        }
        results.push({
          ...rowBase,
          damage: `format-${copies}copy-${bits}bit`,
          amount: bits,
          pct: 0,
          trials: TRIALS,
          ok,
          wrong,
        });
      }

      // QR comparison with the same ECC family and module-flip counts.
      const qrCounts = [1, 2, 4, 8, 16, 32, 64, 128, 256];
      for (const count of qrCounts) {
        let ok = 0;
        let wrong = 0;
        for (let trial = 0; trial < TRIALS; trial++) {
          const rng = mulberry32(0xd300 + trial * 43 + count + ecc.charCodeAt(0));
          const { image, n } = qrDamage(payload, ecc, count, rng);
          const res = decodeQr(image, payload);
          if (res.ok) ok++;
          if (res.wrong) wrong++;
          if (trial === 0) rowBase.qrModules = n * n;
        }
        results.push({
          layer: 'QR',
          ecc,
          version: '-',
          N: rowBase.qrModules,
          dataModules: rowBase.qrModules,
          rsBlocks: 0,
          tTotal: 0,
          damage: 'modules',
          amount: count,
          pct: (100 * count) / rowBase.qrModules,
          trials: TRIALS,
          ok,
          wrong,
        });
      }
    }
  }

  // Summaries: maximum damage that still decoded in every trial.
  for (const layer of [...LAYERS, 'QR']) {
    for (const ecc of ECCS) {
      const rows = results.filter((r) => r.layer === layer && r.ecc === ecc);
      if (rows.length === 0) continue;
      const moduleRows = rows.filter((r) => r.damage === 'modules').sort((a, b) => a.amount - b.amount);
      const maxOk = moduleRows.filter((r) => r.ok === r.trials).at(-1);
      const firstFail = moduleRows.find((r) => r.ok < r.trials);
      const formatRows = rows.filter((r) => r.damage.startsWith('format-'));
      const formatOk = formatRows.filter((r) => r.ok === r.trials).length;
      summary.push({
        layer,
        ecc,
        N: rows[0].N,
        dataModules: rows[0].dataModules,
        tTotal: rows[0].tTotal,
        maxModulesOk: maxOk ? maxOk.amount : 0,
        maxModulesOkPct: maxOk ? maxOk.pct : 0,
        firstFail: firstFail ? firstFail.amount : '-',
        formatOk: `${formatOk}/${formatRows.length}`,
        wrong: rows.reduce((s, r) => s + r.wrong, 0),
      });
    }
  }

  console.log('\n# Isolated module damage (C/WASM)\n');
  console.log(table(summary, [
    { key: 'layer', title: 'layer' },
    { key: 'ecc', title: 'ecc' },
    { key: 'N', title: 'N' },
    { key: 'dataModules', title: 'data mod' },
    { key: 'tTotal', title: 'RS t total', format: (r) => String(r.tTotal) },
    { key: 'maxModulesOk', title: 'max 100%', format: (r) => String(r.maxModulesOk) },
    { key: 'maxModulesOkPct', title: 'max %', format: (r) => fmt(r.maxModulesOkPct, 1) },
    { key: 'firstFail', title: 'first fail', format: (r) => String(r.firstFail) },
    { key: 'formatOk', title: 'format ok' },
    { key: 'wrong', title: 'wrong' },
  ]));

  console.log('\n# Module damage curve (selected layers, ECC M)\n');
  const curve = results.filter((r) => r.damage === 'modules' && r.ecc === 'M' && ['G10', 'G20', 'C40', 'QR'].includes(r.layer));
  console.log(table(curve, [
    { key: 'layer', title: 'layer' },
    { key: 'amount', title: 'flips' },
    { key: 'pct', title: '% of modules', format: (r) => fmt(r.pct, 2) },
    { key: 'ok', title: 'ok', format: (r) => `${r.ok}/${r.trials}` },
    { key: 'wrong', title: 'wrong' },
  ]));

  const wrong = results.reduce((s, r) => s + r.wrong, 0);
  console.log(`\nsilent wrong decodes: ${wrong}`);

  if (args.json) {
    const out = path.resolve(String(args.json));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({
      env: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        trials: TRIALS,
        layers: LAYERS,
        ecc: ECCS,
      },
      summary,
      results,
    }, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
