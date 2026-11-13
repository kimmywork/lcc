#!/usr/bin/env node
/**
 * Camera / print robustness benchmark for the C/WASM decoder.
 *
 *   node scripts/bench-camera.mjs
 *   node scripts/bench-camera.mjs --seeds 5 --json bench-results/camera.json
 *
 * Each fixture is encoded once, then degraded with colour cast, illumination
 * falloff, defocus/motion blur, sensor noise, distance (downscale), rotation,
 * perspective and JPEG compression.  Decoding always goes through the C core
 * (decodeAutoWasm, detector=auto); the JS decoder is not measured here because
 * it is scheduled for replacement.
 *
 * A QR Code with byte-mode payload is rasterized at the same module pixel size
 * and pushed through the identical degradations for comparison.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

import jsQR from 'jsqr';
import { encode } from '../src/index.js';
import { decodeAutoWasm } from '../docs/lib/lcc-wasm.js';
import { DEGRADATIONS, degrade } from './lib/degrade.mjs';
import { rasterizeQR, toRGBA } from './lib/qr-image.mjs';
import { mulberry32 } from './lib/rng.mjs';
import { fmt, summarize, table } from './lib/stats.mjs';
import { positiveInt } from './lib/args.mjs';

function parseArgs(argv) {
  const out = { seeds: 3, json: null, layers: 'G10,G20,C40,C33', ecc: 'M' };
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
const SEEDS = positiveInt(args.seeds, 'seeds', 3, 1000);
const LAYERS = String(args.layers).split(',').map((s) => s.trim()).filter(Boolean);
const QR_ECC = String(args.ecc).toUpperCase();

function payloadOf(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function buildFixtures() {
  const fixtures = [];
  for (const layer of LAYERS) {
    const moduleSize = layer === 'C33' ? 16 : 12;
    const payload = payloadOf(96, 0x100 + layer.length);
    const encoded = encode(payload, {
      layer,
      version: 8,
      moduleSize,
      quietZone: 4,
      width: 2048,
      height: 2048,
      mode: 'compact',
      constraint: false,
    });
    const qr = rasterizeQR(payload, { binary: true, scale: moduleSize, ecc: QR_ECC });
    fixtures.push({ layer, payload, encoded, qr, moduleSize });
  }
  return fixtures;
}

async function decodeLcc(image) {
  return decodeAutoWasm(image, { detector: 'auto' });
}

function decodeQr(image) {
  const rgba = toRGBA(image);
  return jsQR(rgba, image.width, image.height);
}

async function main() {
  const fixtures = buildFixtures();
  const rows = [];

  for (const fixture of fixtures) {
    for (const condition of DEGRADATIONS) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const lccImage = degrade(fixture.encoded.image, condition, seed);
        const qrImage = degrade(fixture.qr.image, condition, seed);

        let lccOk = false;
        let lccWrong = false;
        let lccMs = NaN;
        try {
          const t0 = performance.now();
          const decoded = await decodeLcc(lccImage);
          lccMs = performance.now() - t0;
          if (decoded) {
            lccOk = hex(decoded.payload) === hex(fixture.payload);
            lccWrong = !lccOk;
          }
        } catch {
          lccOk = false;
        }

        let qrOk = false;
        let qrWrong = false;
        let qrMs = NaN;
        try {
          const t0 = performance.now();
          const decoded = decodeQr(qrImage);
          qrMs = performance.now() - t0;
          if (decoded) {
            qrOk = hex(decoded.binaryData) === hex(fixture.payload);
            qrWrong = !qrOk;
          }
        } catch {
          qrOk = false;
        }

        rows.push({
          layer: fixture.layer,
          condition,
          seed,
          lccOk,
          lccWrong,
          lccMs,
          qrOk,
          qrWrong,
          qrMs,
          imagePx: lccImage.width,
          qrPx: qrImage.width,
        });
      }
    }
  }

  // Aggregate per layer / condition.
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.layer}|${row.condition}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const detail = [];
  for (const [key, list] of grouped) {
    const [layer, condition] = key.split('|');
    const lccTimes = list.filter((r) => Number.isFinite(r.lccMs) && r.lccOk).map((r) => r.lccMs);
    const qrTimes = list.filter((r) => Number.isFinite(r.qrMs) && r.qrOk).map((r) => r.qrMs);
    detail.push({
      layer,
      condition,
      runs: list.length,
      lccOk: list.filter((r) => r.lccOk).length,
      lccWrong: list.filter((r) => r.lccWrong).length,
      lccMedianMs: lccTimes.length ? summarize(lccTimes).median : NaN,
      qrOk: list.filter((r) => r.qrOk).length,
      qrWrong: list.filter((r) => r.qrWrong).length,
      qrMedianMs: qrTimes.length ? summarize(qrTimes).median : NaN,
      imagePx: list[0].imagePx,
    });
  }
  detail.sort((a, b) => DEGRADATIONS.indexOf(a.condition) - DEGRADATIONS.indexOf(b.condition) || a.layer.localeCompare(b.layer));

  // Aggregate per condition across layers (headline table).
  const byCondition = new Map();
  for (const row of detail) {
    if (!byCondition.has(row.condition)) byCondition.set(row.condition, []);
    byCondition.get(row.condition).push(row);
  }
  const summary = [];
  for (const [condition, list] of byCondition) {
    const runs = list.reduce((s, r) => s + r.runs, 0);
    const lccOk = list.reduce((s, r) => s + r.lccOk, 0);
    const lccWrong = list.reduce((s, r) => s + r.lccWrong, 0);
    const qrOk = list.reduce((s, r) => s + r.qrOk, 0);
    const qrWrong = list.reduce((s, r) => s + r.qrWrong, 0);
    const lccTimes = list.map((r) => r.lccMedianMs).filter(Number.isFinite);
    const qrTimes = list.map((r) => r.qrMedianMs).filter(Number.isFinite);
    summary.push({
      condition,
      runs,
      lccOkPct: (100 * lccOk) / runs,
      lccWrong,
      lccMedianMs: lccTimes.length ? summarize(lccTimes).median : NaN,
      qrOkPct: (100 * qrOk) / runs,
      qrWrong,
      qrMedianMs: qrTimes.length ? summarize(qrTimes).median : NaN,
    });
  }

  console.log(`\n# C/WASM decoder under realistic degradations (${LAYERS.join(', ')}; ${SEEDS} seeds; QR ECC ${QR_ECC})\n`);
  console.log(table(summary, [
    { key: 'condition', title: 'condition' },
    { key: 'runs', title: 'runs' },
    { key: 'lccOkPct', title: 'C ok %', format: (r) => fmt(r.lccOkPct, 0) },
    { key: 'lccWrong', title: 'C wrong', format: (r) => String(r.lccWrong) },
    { key: 'lccMedianMs', title: 'C ms', format: (r) => fmt(r.lccMedianMs) },
    { key: 'qrOkPct', title: 'QR ok %', format: (r) => fmt(r.qrOkPct, 0) },
    { key: 'qrWrong', title: 'QR wrong', format: (r) => String(r.qrWrong) },
    { key: 'qrMedianMs', title: 'QR ms', format: (r) => fmt(r.qrMedianMs) },
  ]));

  console.log('\n# Per-layer detail\n');
  console.log(table(detail, [
    { key: 'layer', title: 'layer' },
    { key: 'condition', title: 'condition' },
    { key: 'runs', title: 'runs' },
    { key: 'lccOk', title: 'C ok', format: (r) => `${r.lccOk}/${r.runs}` },
    { key: 'lccWrong', title: 'C wrong' },
    { key: 'lccMedianMs', title: 'C ms', format: (r) => fmt(r.lccMedianMs) },
    { key: 'qrOk', title: 'QR ok', format: (r) => `${r.qrOk}/${r.runs}` },
    { key: 'qrWrong', title: 'QR wrong' },
    { key: 'qrMedianMs', title: 'QR ms', format: (r) => fmt(r.qrMedianMs) },
  ]));

  const lccWorst = summary
    .filter((r) => r.lccOkPct < 100)
    .map((r) => `${r.condition} ${fmt(r.lccOkPct, 0)}%`);
  console.log(`\nconditions not at 100% (C): ${lccWorst.length ? lccWorst.join(', ') : 'none'}`);
  const wrong = rows.filter((r) => r.lccWrong).length + rows.filter((r) => r.qrWrong).length;
  console.log(`silent wrong decodes: ${wrong}`);

  if (args.json) {
    const out = path.resolve(String(args.json));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({
      env: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        seeds: SEEDS,
        qrEcc: QR_ECC,
        layers: LAYERS,
      },
      summary,
      detail,
      rows,
    }, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
