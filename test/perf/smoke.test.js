import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { decodeAuto, encode } from '../../src/index.js';
import { decodeAutoWasm } from '../../src/lcc-wasm.js';
import { quantile } from '../../scripts/lib/stats.mjs';

/**
 * Performance smoke gates.  Thresholds are deliberately loose (CI machines,
 * thermal throttling) and exist to catch order-of-magnitude regressions, not
 * to replace scripts/bench-lcc.mjs.
 */

function median(values) {
  return quantile(values, 0.5);
}

function sample(fn, iterations) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return times;
}

const fixture = encode('performance smoke test payload '.repeat(8), {
  layer: 'G20',
  width: 1024,
  height: 1024,
  mode: 'fill',
  maxModulePx: 32,
  constraint: false,
});

test('encode stays within the interactive budget', () => {
  const times = sample(() => encode('performance smoke test payload '.repeat(8), {
    layer: 'G20',
    width: 1024,
    height: 1024,
    mode: 'fill',
    maxModulePx: 32,
    constraint: false,
  }), 10);
  const med = median(times);
  assert.ok(med < 500, `encode median ${med.toFixed(1)} ms`);
});

test('clean decode stays within budget and is stable over repeats', async () => {
  // Warm up JIT and palette caches.
  for (let i = 0; i < 3; i++) decodeAuto(fixture.image, { detector: 'axis' });
  const times = sample(() => {
    const result = decodeAuto(fixture.image, { detector: 'axis' });
    assert.ok(result.text.startsWith('performance smoke test payload'));
  }, 15);
  const med = median(times);
  const p99 = quantile(times, 0.99);
  assert.ok(med < 3000, `decode median ${med.toFixed(1)} ms`);
  assert.ok(p99 < med * 5 + 500, `decode p99 ${p99.toFixed(1)} ms vs median ${med.toFixed(1)} ms`);

  const wasm = await decodeAutoWasm(fixture.image, { detector: 'axis' });
  assert.ok(wasm.text.startsWith('performance smoke test payload'));
});
