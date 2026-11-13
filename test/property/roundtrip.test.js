import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYERS,
  capacityFor,
  decodeAuto,
  encode,
  generatePalette,
  makeLayout,
} from '../../src/index.js';
import { decodePNG, encodePNG } from '../../src/png.js';
import { chance, int, mulberry32, pick, text } from '../../scripts/lib/rng.mjs';

const FAST_LAYERS = ['G10', 'G20', 'G30', 'C40', 'C50', 'C60', 'C80', 'C30', 'C20'];
const SHAPE_LAYERS = ['G13', 'C23', 'C33'];

function makePayload(rng, length, kind) {
  if (kind === 'ascii') return text(rng, length, 'ascii');
  if (kind === 'cjk') return text(rng, length, 'cjk');
  if (kind === 'binary') {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = int(rng, 0, 255);
    return out;
  }
  return '';
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

test('property: encode -> decodeAuto returns the exact payload', () => {
  const rng = mulberry32(0x51cc);
  const iterations = Number(process.env.LCC_PROPERTY_ITER) || 24;
  let executed = 0;
  for (let i = 0; i < iterations; i++) {
    const shape = chance(rng, 0.15);
    const layerName = shape ? pick(rng, SHAPE_LAYERS) : pick(rng, FAST_LAYERS);
    const layer = LAYERS[layerName];
    const version = int(rng, 2, shape ? 5 : 10);
    const moduleSize = Math.max(layer.minModulePx ?? 4, pick(rng, [8, 12, 16, 20, 24]));
    const constraint = !shape && (layerName === 'G20' || layerName === 'G30') && chance(rng, 0.3);
    const quietZone = int(rng, 2, 4);
    const paletteInfo = generatePalette(layerName, { mode: 'maxmin' });
    const layout = makeLayout({ version, layer: layerName, paletteMode: 'maxmin', paletteInfo });
    const cap = capacityFor(layout, layerName, paletteInfo, constraint, undefined);
    if (cap.payloadCapacity < 0) continue;
    const max = Math.min(cap.payloadCapacity, shape ? 160 : 320);
    const length = int(rng, 0, Math.max(0, max));
    const kind = pick(rng, ['ascii', 'ascii', 'cjk', 'binary']);
    const payload = makePayload(rng, length, kind);

    const options = {
      layer: layerName,
      version,
      moduleSize,
      quietZone,
      width: (layout.N + 2 * quietZone) * moduleSize,
      height: (layout.N + 2 * quietZone) * moduleSize,
      mode: 'compact',
      constraint,
    };
    let encoded;
    try {
      encoded = encode(payload, options);
    } catch (err) {
      // Some layer/version combinations cannot carry even the frame header.
      assert.match(err.message, /does not fit|too large/, `${layerName} v${version}: ${err.message}`);
      continue;
    }
    executed++;
    const decoded = decodeAuto(encoded.image, { detector: 'axis' });
    const expected = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    assert.equal(
      Buffer.from(decoded.payload).toString('hex'),
      expected.toString('hex'),
      `${layerName} v${version} ${moduleSize}px constraint=${constraint} kind=${kind} len=${length}`,
    );
    assert.equal(decoded.meta.layer, layerName);
    assert.equal(decoded.meta.version, version);
    assert.equal(decoded.text, decodeUtf8(expected), `${layerName} text`);

    if (i % 5 === 0) {
      const pngDecoded = decodeAuto(decodePNG(encodePNG(encoded.image)), { detector: 'axis' });
      assert.equal(Buffer.from(pngDecoded.payload).toString('hex'), expected.toString('hex'), `${layerName} png`);
    }
  }
  assert.ok(executed >= Math.floor(iterations * 0.6), `only ${executed}/${iterations} cases executed`);
});

test('property: empty and one-byte payloads survive every fast layer', () => {
  for (const layerName of FAST_LAYERS) {
    for (const payload of ['', 'A']) {
      const encoded = encode(payload, {
        layer: layerName,
        version: 2,
        moduleSize: 16,
        quietZone: 2,
        width: 1024,
        height: 1024,
        mode: 'compact',
        constraint: false,
      });
      const decoded = decodeAuto(encoded.image, { detector: 'axis' });
      assert.equal(decoded.text, payload, `${layerName} ${JSON.stringify(payload)}`);
      assert.equal(decoded.payload.length, Buffer.byteLength(payload));
    }
  }
});

test('property: decode either returns the exact payload or throws, never silent corruption', () => {
  const rng = mulberry32(0xc0de);
  const cases = [
    ['G10', 4, 8],
    ['G20', 4, 8],
    ['C40', 4, 8],
  ];
  for (const [layerName, version, moduleSize] of cases) {
    const payload = text(rng, 40, 'ascii');
    const encoded = encode(payload, {
      layer: layerName,
      version,
      moduleSize,
      quietZone: 2,
      width: 1024,
      height: 1024,
      mode: 'compact',
      constraint: false,
    });
    for (const sigma of [1, 3, 8, 15, 30, 60, 120]) {
      for (let trial = 0; trial < 2; trial++) {
        const data = new Uint8Array(encoded.image.data.length);
        for (let i = 0; i < data.length; i++) {
          const u1 = Math.max(1e-9, rng());
          const u2 = rng();
          const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
          data[i] = Math.max(0, Math.min(255, Math.round(encoded.image.data[i] + g)));
        }
        const damaged = { width: encoded.image.width, height: encoded.image.height, data };
        let decoded;
        try {
          decoded = decodeAuto(damaged, { detector: 'axis' });
        } catch (err) {
          assert.ok(err instanceof Error, `${layerName} sigma ${sigma} threw non-Error`);
          continue;
        }
        assert.equal(decoded.text, payload, `${layerName} sigma ${sigma} returned wrong data`);
      }
    }
  }
});
