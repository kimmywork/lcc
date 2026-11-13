import test from 'node:test';
import assert from 'node:assert/strict';

import { encode } from '../../src/index.js';
import { decodeAutoWasm } from '../../src/lcc-wasm.js';
import { degrade } from '../../scripts/lib/degrade.mjs';
import { mulberry32 } from '../../scripts/lib/rng.mjs';

function payloadOf(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Camera-path smoke gate: a handful of representative degradations must decode
 * exactly through the C core.  The full success-rate matrix lives in
 * scripts/bench-camera.mjs.
 */
test('C/WASM decodes representative camera degradations exactly', { timeout: 60000 }, async () => {
  const conditions = ['cast-warm', 'illumination', 'blur-1', 'noise-10', 'perspective-0.05', 'jpeg-50'];
  for (const layer of ['G20', 'C40']) {
    const payload = payloadOf(96, 0xca11 + layer.length);
    const encoded = encode(payload, {
      layer,
      version: 5,
      moduleSize: 12,
      quietZone: 4,
      width: 1024,
      height: 1024,
      mode: 'compact',
      constraint: false,
    });
    for (const condition of conditions) {
      const image = degrade(encoded.image, condition, 7);
      const decoded = await decodeAutoWasm(image, { detector: 'auto' });
      assert.ok(decoded, `${layer} ${condition}: no result`);
      assert.equal(hex(decoded.payload), hex(payload), `${layer} ${condition}`);
    }
  }
});

test('C/WASM decodes rotated camera frames through 20 degrees', { timeout: 60000 }, async () => {
  for (const layer of ['G20', 'C40']) {
    const payload = payloadOf(96, 0x1207 + layer.length);
    const encoded = encode(payload, {
      layer, version: 8, moduleSize: 12, quietZone: 4,
      width: 2048, height: 2048, mode: 'compact', constraint: false,
    });
    for (const angle of [5, 10, 12, 15, 20]) {
      const image = degrade(encoded.image, `rotate-${angle}`, 3);
      const decoded = await decodeAutoWasm(image, { detector: 'auto' });
      assert.equal(hex(decoded.payload), hex(payload), `${layer} rotate-${angle}`);
    }
  }
});
