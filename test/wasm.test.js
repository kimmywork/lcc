import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeAuto, detectSymbol } from '../src/decoder.js';
import { encode } from '../src/encoder.js';
import { stackCanonicalFrames } from '../src/stack.js';
import { decodeAutoWasm, stackCanonicalFramesWasm } from '../docs/lib/lcc-wasm.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function applyChannelCast(image, gain, bias = [0, 0, 0]) {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = image.data[i + c] * gain[c] + bias[c];
      data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: image.width, height: image.height, data };
}

function noisy(image, sigma, seed) {
  const rand = rng(seed);
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i++) {
    const u1 = Math.max(1e-9, rand());
    const u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
    data[i] = Math.max(0, Math.min(255, Math.round(image.data[i] + g)));
  }
  return { width: image.width, height: image.height, data };
}

test('wasm decode matches JS on clean, cast, and stacked images', async () => {
  const samples = [
    ['L1', { layer: 'L1', width: 512, height: 512, mode: 'fill', constraint: false, maxModulePx: 32 }],
    ['L3c', { layer: 'L3c', version: 2, moduleSize: 24, width: 1024, height: 1024, mode: 'fill', maxModulePx: 32, constraint: false }],
    ['L3s', { layer: 'L3s', version: 2, moduleSize: 24, width: 1024, height: 1024, mode: 'fill', maxModulePx: 32 }],
    ['L3u', { layer: 'L3u', version: 4, moduleSize: 16, width: 1024, height: 1024, mode: 'fill', maxModulePx: 32 }],
  ];
  for (const [layer, options] of samples) {
    const image = encode(`wasm ${layer}`, options).image;
    const js = decodeAuto(image, { detector: 'axis' });
    const wasm = await decodeAutoWasm(image, { detector: 'axis' });
    assert.equal(wasm.text, js.text, layer);
    assert.deepEqual(Array.from(wasm.payload), Array.from(js.payload), layer);
  }

  const color = encode('cast', {
    layer: 'L3c', version: 2, moduleSize: 24, width: 1024, height: 1024, mode: 'fill', maxModulePx: 32, constraint: false,
  }).image;
  const cast = applyChannelCast(color, [1, 0.82, 0.62]);
  const castJs = decodeAuto(cast, { detector: 'axis' });
  const castWasm = await decodeAutoWasm(cast, { detector: 'axis' });
  assert.equal(castWasm.text, castJs.text);
  assert.deepEqual(Array.from(castWasm.payload), Array.from(castJs.payload));

  const burst = encode('stack test', {
    layer: 'L3s', version: 2, moduleSize: 24, width: 1024, height: 1024, mode: 'fill', maxModulePx: 32,
  }).image;
  const frames = [];
  const detections = [];
  for (let i = 0; i < 3; i++) {
    const frame = noisy(burst, 20, 100 + i);
    frames.push(frame);
    detections.push(detectSymbol(frame));
  }
  const jsStack = stackCanonicalFrames(frames, detections, { quietZone: 4 });
  const wasmStack = await stackCanonicalFramesWasm(frames, detections, { quietZone: 4 });
  assert.equal(wasmStack.image.width, jsStack.image.width);
  assert.equal(wasmStack.image.height, jsStack.image.height);
  assert.equal(wasmStack.stacked, true);
  let maxDiff = 0;
  for (let i = 0; i < jsStack.image.data.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(wasmStack.image.data[i] - jsStack.image.data[i]));
  }
  assert.ok(maxDiff <= 1, `stack pixel delta ${maxDiff}`);
  const stacked = await decodeAutoWasm(wasmStack.image, { detector: 'axis' });
  assert.equal(stacked.text, 'stack test');

  const perspective = await decodeAutoWasm(color, { detector: 'perspective' });
  assert.equal(perspective.text, 'cast');
});

test('wasm leaves constraint codes to the JS decoder', async () => {
  const image = encode('constrained', {
    layer: 'L2b', width: 512, height: 512, mode: 'fill', constraint: true, maxModulePx: 32,
  }).image;
  assert.equal(await decodeAutoWasm(image, { detector: 'axis' }), null);
  assert.equal(decodeAuto(image, { detector: 'axis' }).text, 'constrained');
});

test('wasm stack and decode are faster than JS on the same fixture', async () => {
  const image = encode('timing', {
    layer: 'L3s', version: 2, moduleSize: 24, width: 1024, height: 1024, mode: 'fill', maxModulePx: 32,
  }).image;
  const frames = [];
  const detections = [];
  for (let i = 0; i < 3; i++) {
    const frame = noisy(image, 12, 40 + i);
    frames.push(frame);
    detections.push(detectSymbol(frame));
  }
  await stackCanonicalFramesWasm(frames, detections, { quietZone: 4 });
  await decodeAutoWasm(image, { detector: 'axis' });

  const jsStackStart = performance.now();
  stackCanonicalFrames(frames, detections, { quietZone: 4 });
  const jsStack = performance.now() - jsStackStart;
  const wasmStackStart = performance.now();
  await stackCanonicalFramesWasm(frames, detections, { quietZone: 4 });
  const wasmStack = performance.now() - wasmStackStart;

  const jsDecodeStart = performance.now();
  decodeAuto(image, { detector: 'axis' });
  const jsDecode = performance.now() - jsDecodeStart;
  const wasmDecodeStart = performance.now();
  await decodeAutoWasm(image, { detector: 'axis' });
  const wasmDecode = performance.now() - wasmDecodeStart;

  assert.ok(wasmStack < jsStack, `stack wasm ${wasmStack.toFixed(1)} ms, js ${jsStack.toFixed(1)} ms`);
  assert.ok(wasmDecode < jsDecode, `decode wasm ${wasmDecode.toFixed(1)} ms, js ${jsDecode.toFixed(1)} ms`);
});
