import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, '../../scripts/lib/leak-runner.mjs');

function runLeak(iterations, nodeArgs = []) {
  const stdout = execFileSync(process.execPath, [
    '--expose-gc',
    ...nodeArgs,
    runner,
  ], {
    env: { ...process.env, LEAK_ITER: String(iterations) },
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = stdout.trim().split('\n').at(-1);
  assert.ok(line && line.startsWith('{'), `unexpected child output: ${stdout.slice(-500)}`);
  return JSON.parse(line);
}

test('long repeated encode/decode run does not leak JS or wasm memory', { timeout: 120000 }, () => {
  const result = runLeak(150);
  assert.equal(result.failures, 0, `decode/encode failures: ${result.failures}`);
  assert.equal(result.iterations, 150);
  assert.ok(result.medianMs < 250, `median ${result.medianMs.toFixed(1)} ms`);
  assert.ok(result.p99Ms < 1500, `p99 ${result.p99Ms.toFixed(1)} ms`);
  assert.ok(result.heapDelta < 16 * 1024 * 1024, `JS heap grew ${(result.heapDelta / 1048576).toFixed(2)} MiB`);
  assert.ok(result.wasmDelta < 16 * 1024 * 1024, `wasm memory grew ${(result.wasmDelta / 1048576).toFixed(2)} MiB`);
  assert.ok(result.lastLen > 0, 'last wasm result is empty');
  assert.ok(result.lastPtr !== 0, 'wasm last buffer pointer is null');
});

test('repeated run stays stable under a constrained heap', { timeout: 120000 }, () => {
  const result = runLeak(120, ['--max-old-space-size=96']);
  assert.equal(result.failures, 0);
  assert.ok(result.heapDelta < 16 * 1024 * 1024, `heap grew ${(result.heapDelta / 1048576).toFixed(2)} MiB`);
  assert.ok(result.maxMs < 5000, `slowest iteration ${result.maxMs.toFixed(1)} ms`);
});
