#!/usr/bin/env node
/**
 * LCC vs QR Code benchmark.
 *
 *   node scripts/bench-qr.mjs
 *   node scripts/bench-qr.mjs --json bench-results/qr.json
 *
 * Requires the dev-only comparison deps:
 *   npm i -D qrcode jsqr
 *
 * Compares, for identical payloads:
 *   - encoded image resolution (px) and symbol module count (N x N)
 *   - PNG byte size on an equal 1024 px canvas
 *   - encode and decode wall time
 *   - payload density (bytes per module, bits per module)
 *
 * QR uses error correction level M by default; LCC uses each layer's default
 * ECC unless noted.  LCC G10 is the fair 1 bit/module black-and-white
 * comparison; colour layers show the density gain of the LCC design.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { rasterizeQR, toRGBA } from './lib/qr-image.mjs';

import { encode, decodeAuto, generatePalette, makeLayout, capacityFor } from '../src/index.js';
import { encodePNG } from '../src/png.js';
import { mulberry32 } from '../scripts/lib/rng.mjs';
import { fmt, summarize, table } from '../scripts/lib/stats.mjs';

function parseArgs(argv) {
  const out = { json: null, qrEcc: 'M', canvas: 1024 };
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
const QR_ECC = String(args.qrEcc).toUpperCase();
const CANVAS = Number(args.canvas) || 1024;
const ITER = 12;

function randomBytes(n, seed = 2026) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

const LOREM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. `;

function payloadCases() {
  const cases = [];
  cases.push({ name: 'short', data: 'Hello World!' });
  cases.push({
    name: 'url',
    data: 'https://example.com/products/12345?utm_source=label&utm_campaign=lcc-vs-qr',
  });
  cases.push({
    name: 'sentence',
    data: 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
  });
  cases.push({ name: 'lorem-400', data: LOREM.repeat(3).slice(0, 400) });
  cases.push({
    name: 'cjk-200',
    data: '心经金刚般若波罗蜜多时照见五蕴皆空度一切苦厄舍利子色不异空空不异色'.repeat(6).slice(0, 200),
  });
  cases.push({ name: 'binary-512', data: randomBytes(512, 1), binary: true });
  cases.push({ name: 'lorem-1200', data: LOREM.repeat(10).slice(0, 1200) });
  return cases;
}

function padToCanvas(image, side, background = 255) {
  if (image.width === side && image.height === side) return image;
  const data = new Uint8Array(side * side * 3).fill(background);
  const x0 = Math.floor((side - image.width) / 2);
  const y0 = Math.floor((side - image.height) / 2);
  for (let y = 0; y < image.height; y++) {
    const src = y * image.width * 3;
    const dst = ((y0 + y) * side + x0) * 3;
    data.set(image.data.subarray(src, src + image.width * 3), dst);
  }
  return { width: side, height: side, data };
}

function timeIt(fn, iterations = ITER, warmup = 2) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return summarize(times);
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function payloadBytesOf(item) {
  return typeof item.data === 'string' ? Buffer.from(item.data, 'utf8') : Buffer.from(item.data);
}

function qrMaxBytes(version, ecc) {
  let lo = 0;
  let hi = 3000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    try {
      QRCode.create('a'.repeat(mid), { version, errorCorrectionLevel: ecc });
      lo = mid;
    } catch {
      hi = mid - 1;
    }
  }
  return lo;
}

async function main() {
  const results = {
    env: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      qrEcc: QR_ECC,
      canvas: CANVAS,
    },
    cases: [],
    density: [],
  };

  // ---------------------------------------------------------------------------
  // 1. Same payload: LCC vs QR
  // ---------------------------------------------------------------------------
  console.log(`\n# Same payload (QR ECC ${QR_ECC}, target canvas ${CANVAS}px)\n`);
  const rows = [];
  const lccLayers = ['G10', 'G20', 'C40', 'C55'];

  for (const item of payloadCases()) {
    const original = payloadBytesOf(item);
    const payloadBytes = original.length;
    const qr = rasterizeQR(item.data, { binary: !!item.binary, target: CANVAS });
    const qrPadded = padToCanvas(qr.image, CANVAS);
    const qrPng = encodePNG(qrPadded);
    const qrRgba = toRGBA(qrPadded);
    const qrDecoded = jsQR(qrRgba, qrPadded.width, qrPadded.height);
    const qrOk = qrDecoded ? hex(qrDecoded.binaryData) === hex(original) : false;
    const qrDecode = timeIt(() => jsQR(qrRgba, qrPadded.width, qrPadded.height));
    const qrEncode = timeIt(() => rasterizeQR(item.data, { binary: !!item.binary, target: CANVAS }));
    const qrRow = {
      case: item.name,
      payloadBytes,
      codec: 'QR',
      detail: `v${qr.version} ECC-${QR_ECC}`,
      version: qr.version,
      modules: qr.modules,
      modulePx: qr.scale,
      imagePx: qr.image.width,
      pngBytes: qrPng.length,
      bitsPerModule: (payloadBytes * 8) / (qr.modules * qr.modules),
      encodeMs: qrEncode.median,
      decodeMs: qrDecode.median,
      ok: qrOk,
    };
    rows.push(qrRow);
    results.cases.push(qrRow);

    for (const layer of lccLayers) {
      let encoded;
      try {
        encoded = encode(item.data, {
          layer,
          width: CANVAS,
          height: CANVAS,
          mode: 'fill',
          maxModulePx: 32,
          constraint: false,
        });
      } catch {
        continue;
      }
      const padded = padToCanvas(encoded.image, CANVAS);
      const png = encodePNG(padded);
      let ok = false;
      try {
        const decoded = decodeAuto(padded, { detector: 'axis' });
        ok = hex(decoded.payload) === hex(original);
      } catch {
        ok = false;
      }
      const decode = timeIt(() => decodeAuto(padded, { detector: 'axis' }));
      const encodeStats = timeIt(() => encode(item.data, {
        layer,
        width: CANVAS,
        height: CANVAS,
        mode: 'fill',
        maxModulePx: 32,
        constraint: false,
      }));
      const row = {
        case: item.name,
        payloadBytes,
        codec: 'LCC',
        detail: layer,
        version: encoded.meta.version,
        modules: encoded.meta.N,
        modulePx: encoded.meta.moduleSize,
        imagePx: encoded.image.width,
        pngBytes: png.length,
        bitsPerModule: encoded.meta.bitsPerModule,
        encodeMs: encodeStats.median,
        decodeMs: decode.median,
        ok,
      };
      rows.push(row);
      results.cases.push(row);
    }
  }

  console.log(table(rows, [
    { key: 'case', title: 'case' },
    { key: 'payloadBytes', title: 'bytes' },
    { key: 'codec', title: 'codec' },
    { key: 'detail', title: 'variant' },
    { key: 'version', title: 'ver' },
    { key: 'modules', title: 'N' },
    { key: 'modulePx', title: 'mod px' },
    { key: 'imagePx', title: 'image' },
    { key: 'pngBytes', title: 'png B' },
    { key: 'bitsPerModule', title: 'bit/mod', format: (r) => fmt(r.bitsPerModule, 2) },
    { key: 'encodeMs', title: 'enc ms', format: (r) => fmt(r.encodeMs) },
    { key: 'decodeMs', title: 'dec ms', format: (r) => fmt(r.decodeMs) },
    { key: 'ok', title: 'ok' },
  ]));

  // ---------------------------------------------------------------------------
  // 2. Density comparison at equal module count
  // ---------------------------------------------------------------------------
  console.log('\n# Payload density at equal module count (QR ECC ' + QR_ECC + ')\n');
  const densityRows = [];
  const layers = ['G10', 'G20', 'C40', 'C55', 'C85'];
  for (const version of [1, 2, 5, 10, 20, 30, 40]) {
    const qrBytes = qrMaxBytes(version, QR_ECC);
    const row = {
      version,
      N: 21 + 4 * (version - 1),
      qrBytes,
      qrBitsPerModule: (qrBytes * 8) / ((21 + 4 * (version - 1)) ** 2),
    };
    for (const layer of layers) {
      const paletteInfo = generatePalette(layer, { mode: 'maxmin' });
      try {
        const layout = makeLayout({ version, layer, paletteMode: 'maxmin', paletteInfo });
        const cap = capacityFor(layout, layer, paletteInfo, false, undefined);
        row[layer] = cap.payloadCapacity;
        row[`${layer}Bits`] = (cap.payloadCapacity * 8) / (layout.N * layout.N);
      } catch {
        row[layer] = '-';
        row[`${layer}Bits`] = 0;
      }
    }
    densityRows.push(row);
    results.density.push(row);
  }
  console.log(table(densityRows, [
    { key: 'version', title: 'ver' },
    { key: 'N', title: 'N' },
    { key: 'qrBytes', title: `QR-${QR_ECC}` },
    { key: 'qrBitsPerModule', title: 'QR bit/mod', format: (r) => fmt(r.qrBitsPerModule, 2) },
    ...layers.map((layer) => ({
      key: layer,
      title: layer,
      format: (row) => String(row[layer] ?? '-'),
    })),
    { key: 'G10Ratio', title: 'LCC G10 / QR', format: (r) => (r.G10 > 0 ? `${fmt(r.G10 / r.qrBytes, 2)}x` : '-') },
    { key: 'C55Ratio', title: 'LCC C55 / QR', format: (r) => (r.C55 > 0 ? `${fmt(r.C55 / r.qrBytes, 2)}x` : '-') },
  ]));

  // ---------------------------------------------------------------------------
  // 3. Summary for the fair G10 (1 bit/module) comparison
  // ---------------------------------------------------------------------------
  console.log('\n# Summary: LCC G10 vs QR (same payload)\n');
  const summaryRows = [];
  for (const item of payloadCases()) {
    const qr = results.cases.find((r) => r.case === item.name && r.codec === 'QR');
    const lcc = results.cases.find((r) => r.case === item.name && r.codec === 'LCC' && r.detail === 'G10');
    if (!qr || !lcc) continue;
    summaryRows.push({
      case: item.name,
      bytes: qr.payloadBytes,
      modulesRatio: lcc.modules / qr.modules,
      resolutionRatio: lcc.imagePx / qr.imagePx,
      pngRatio: lcc.pngBytes / qr.pngBytes,
      encodeRatio: lcc.encodeMs / qr.encodeMs,
      decodeRatio: lcc.decodeMs / qr.decodeMs,
      decodeOk: `${lcc.ok ? 'ok' : 'FAIL'} / ${qr.ok ? 'ok' : 'FAIL'}`,
    });
  }
  console.log(table(summaryRows, [
    { key: 'case', title: 'case' },
    { key: 'bytes', title: 'bytes' },
    { key: 'modulesRatio', title: 'N ratio', format: (r) => `${fmt(r.modulesRatio, 2)}x` },
    { key: 'resolutionRatio', title: 'px ratio', format: (r) => `${fmt(r.resolutionRatio, 2)}x` },
    { key: 'pngRatio', title: 'png ratio', format: (r) => `${fmt(r.pngRatio, 2)}x` },
    { key: 'encodeRatio', title: 'enc ratio', format: (r) => `${fmt(r.encodeRatio, 2)}x` },
    { key: 'decodeRatio', title: 'dec ratio', format: (r) => `${fmt(r.decodeRatio, 2)}x` },
    { key: 'decodeOk', title: 'LCC/QR' },
  ]));

  if (args.json) {
    const out = path.resolve(String(args.json));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
