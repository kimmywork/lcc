/**
 * Cross-process reproducibility child.
 *
 *   node scripts/lib/repro-child.mjs '<json specs>'
 *
 * Each spec is { payloadHex, options }.  Prints one JSON array of hashes so a
 * test can prove that a fresh process produces byte-identical codes.
 */
import crypto from 'node:crypto';

import { encode } from '../../src/index.js';

const specs = JSON.parse(process.argv[2]);

function hash(bytes) {
  const h = crypto.createHash('sha256');
  h.update(bytes);
  return h.digest('hex');
}

const out = specs.map((spec) => {
  try {
    const payload = new Uint8Array(Buffer.from(spec.payloadHex, 'hex'));
    const result = encode(payload, spec.options);
    const symbolBytes = Buffer.alloc(result.symbols.length * 2);
    for (let i = 0; i < result.symbols.length; i++) symbolBytes.writeInt16LE(result.symbols[i], i * 2);
    return {
      image: hash(Buffer.from(result.image.data)),
      symbols: hash(symbolBytes),
      meta: hash(Buffer.from(JSON.stringify(result.meta))),
      size: result.image.data.length,
    };
  } catch (err) {
    return { error: err.message };
  }
});

process.stdout.write(JSON.stringify(out));
