import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAYERS,
  decodeAuto,
  encode,
} from '../../src/index.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { renderSVG } from '../../src/svg.js';
import { mulberry32 } from '../../scripts/lib/rng.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, '../../scripts/lib/repro-child.mjs');

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashResult(result) {
  const symbols = Buffer.alloc(result.symbols.length * 2);
  for (let i = 0; i < result.symbols.length; i++) symbols.writeInt16LE(result.symbols[i], i * 2);
  return {
    image: sha(Buffer.from(result.image.data)),
    symbols: sha(symbols),
    meta: sha(Buffer.from(JSON.stringify(result.meta))),
  };
}

function payloadOf(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

const REPRO_LAYERS = ['G10', 'G20', 'G30', 'C40', 'C50', 'C60', 'C80', 'G13', 'C23', 'C33', 'C55'];

function matrixSpecs() {
  const specs = [];
  for (const layer of REPRO_LAYERS) {
    const info = LAYERS[layer];
    for (const version of [1, 2, 5, 10]) {
      if ((info.minVersion ?? 1) > version) continue;
      for (const seed of (info.shapeSetSize ? [0] : [0, 1, 63])) {
        for (const quietZone of [2, 4]) {
          specs.push({
            payloadHex: Buffer.from(payloadOf(24, version + seed + layer.length)).toString('hex'),
            options: {
              layer,
              version,
              moduleSize: Math.max(info.minModulePx ?? 4, 8),
              quietZone,
              width: 2048,
              height: 2048,
              mode: 'compact',
              constraint: layer === 'G20' || layer === 'G30',
              seed,
            },
          });
        }
      }
    }
  }
  return specs;
}

test('same parameters produce byte-identical image, symbols and metadata', () => {
  let checked = 0;
  for (const spec of matrixSpecs()) {
    let a;
    try {
      a = encode(new Uint8Array(Buffer.from(spec.payloadHex, 'hex')), spec.options);
    } catch {
      continue;
    }
    const b = encode(new Uint8Array(Buffer.from(spec.payloadHex, 'hex')), spec.options);
    assert.deepEqual(hashResult(b), hashResult(a), JSON.stringify(spec.options));
    checked++;
  }
  assert.ok(checked > 80, `only ${checked} parameter sets checked`);
});

test('encoding is independent of previous encoder calls and call order', () => {
  const specs = matrixSpecs().filter((_, i) => i % 17 === 0);
  const first = new Map();
  for (const spec of specs) {
    let result;
    try {
      result = encode(new Uint8Array(Buffer.from(spec.payloadHex, 'hex')), spec.options);
    } catch {
      continue;
    }
    first.set(JSON.stringify(spec), hashResult(result));
  }
  // Encode in reverse and with an unrelated call between each pair.
  for (const spec of [...specs].reverse()) {
    const key = JSON.stringify(spec);
    if (!first.has(key)) continue;
    encode(payloadOf(17, 99), {
      layer: 'C40', version: 2, moduleSize: 8, quietZone: 2,
      width: 1024, height: 1024, mode: 'compact', constraint: false,
    });
    const result = encode(new Uint8Array(Buffer.from(spec.payloadHex, 'hex')), spec.options);
    assert.deepEqual(hashResult(result), first.get(key), key);
  }
});

function encodableSpecs() {
  return matrixSpecs().filter((spec) => {
    try {
      encode(new Uint8Array(Buffer.from(spec.payloadHex, 'hex')), spec.options);
      return true;
    } catch {
      return false;
    }
  });
}

test('a fresh process reproduces the same bytes', () => {
  const specs = encodableSpecs().filter((_, i) => i % 29 === 0).slice(0, 12);
  const run = () => JSON.parse(execFileSync(process.execPath, [child, JSON.stringify(specs)], {
    encoding: 'utf8',
    timeout: 120000,
  }));
  const a = run();
  const b = run();
  assert.deepEqual(b, a);
  assert.equal(a.length, specs.length);
  for (const record of a) {
    assert.ok(record.image && record.symbols && record.meta, `encode failed: ${record.error ?? 'missing hash'}`);
  }
});

test('PNG and SVG output are deterministic', () => {
  for (const layer of ['G10', 'G20', 'C40', 'C33']) {
    const result = encode('deterministic output', {
      layer,
      version: 4,
      moduleSize: layer === 'C33' ? 16 : 10,
      quietZone: 2,
      width: 1024,
      height: 1024,
      mode: 'compact',
      constraint: false,
      seed: 0,
    });
    const pngA = encodePNG(result.image);
    const pngB = encodePNG(result.image);
    assert.equal(sha(pngA), sha(pngB), `${layer} png`);
    assert.equal(sha(decodePNG(pngA).data), sha(result.image.data), `${layer} png content`);

    const svgOptions = {
      symbols: result.symbols,
      layout: result.layout,
      palette: result.paletteInfo.palette,
      moduleSize: result.meta.moduleSize,
      quietZone: result.meta.quietZone,
    };
    assert.equal(renderSVG(svgOptions), renderSVG(svgOptions), `${layer} svg`);
  }
});

test('decode is deterministic for the same image', () => {
  const result = encode('decode determinism', {
    layer: 'G30', version: 5, moduleSize: 12, quietZone: 2,
    width: 1024, height: 1024, mode: 'compact', constraint: false,
  });
  const first = decodeAuto(result.image, { detector: 'axis' });
  for (let i = 0; i < 5; i++) {
    const again = decodeAuto(result.image, { detector: 'axis' });
    assert.equal(Buffer.from(again.payload).toString('hex'), Buffer.from(first.payload).toString('hex'));
    assert.deepEqual(again.meta, first.meta);
  }
});
