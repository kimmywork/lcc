/**
 * Compact, scalable format band.
 *
 * Payload is split into 5-bit BCH(15,5) blocks.  Each block is rendered as
 * 2 rows x 8 columns (15 codeword bits + one padding bit).  Two mirrored
 * copies are stacked in the bottom-right corner.
 *
 *   1 block / copy : layer(2) + ecc(2) + constraint(1)
 *   2 blocks/copy  : layer(2) + ecc(2) + palette(2) + constraint(1) + seed(3)
 *   3 blocks/copy  : layer(2) + ecc(2) + palette(2) + seed(6) + flags(3)
 *
 * Version/N is intentionally not stored: the decoder derives it from the
 * finder-centre distance.  This keeps the format band small on small codes.
 */

import { bch15Decode, bch15Encode } from '../ecc/bch15.js';
import { BLACK, WHITE } from '../layout.js';

function bitsOf(value, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push((value >> i) & 1);
  return out;
}

function valueOf(bits, offset, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | bits[offset + i];
  return v;
}

export function packFormatPayload({
  formatBlocks,
  layerId,
  eccIndex,
  paletteMode = 'bucketed',
  harmony = false,
  seed = 0,
  constraint = false,
  compressed = false,
  encrypted = false,
}) {
  const paletteBits = (paletteMode === 'global' ? 2 : 0) | (harmony ? 1 : 0);
  let bits;
  if (formatBlocks === 1) {
    bits = [...bitsOf(layerId, 2), ...bitsOf(eccIndex, 2), constraint ? 1 : 0];
  } else if (formatBlocks === 2) {
    bits = [
      ...bitsOf(layerId, 2),
      ...bitsOf(eccIndex, 2),
      ...bitsOf(paletteBits, 2),
      constraint ? 1 : 0,
      ...bitsOf(seed & 7, 3),
    ];
  } else {
    const flags = (constraint ? 1 : 0) | (compressed ? 2 : 0) | (encrypted ? 4 : 0);
    bits = [
      ...bitsOf(layerId, 2),
      ...bitsOf(eccIndex, 2),
      ...bitsOf(paletteBits, 2),
      ...bitsOf(seed & 63, 6),
      ...bitsOf(flags, 3),
    ];
  }
  const chunks = [];
  for (let i = 0; i < formatBlocks; i++) {
    const offset = i * 5;
    chunks.push(valueOf(bits, offset, 5));
  }
  return chunks;
}

export function unpackFormatPayload(chunks, formatBlocks) {
  const bits = [];
  for (const c of chunks) bits.push(...bitsOf(c, 5));
  const layerId = valueOf(bits, 0, 2);
  const eccIndex = valueOf(bits, 2, 2);
  if (formatBlocks === 1) {
    return {
      layerId,
      eccIndex,
      paletteMode: 'bucketed',
      harmony: false,
      seed: 0,
      constraint: bits[4] === 1,
      compressed: false,
      encrypted: false,
    };
  }
  if (formatBlocks === 2) {
    const paletteBits = valueOf(bits, 4, 2);
    return {
      layerId,
      eccIndex,
      paletteMode: paletteBits >= 2 ? 'global' : 'bucketed',
      harmony: (paletteBits & 1) === 1,
      seed: valueOf(bits, 7, 3),
      constraint: bits[6] === 1,
      compressed: false,
      encrypted: false,
    };
  }
  const paletteBits = valueOf(bits, 4, 2);
  const seed = valueOf(bits, 6, 6);
  const flags = valueOf(bits, 12, 3);
  return {
    layerId,
    eccIndex,
    paletteMode: paletteBits >= 2 ? 'global' : 'bucketed',
    harmony: (paletteBits & 1) === 1,
    seed,
    constraint: (flags & 1) === 1,
    compressed: (flags & 2) === 2,
    encrypted: (flags & 4) === 4,
  };
}

export function writeFormatBand(symbols, layout, chunks) {
  const { copies, blocksPerCopy, cols } = layout.format;
  for (const copy of copies) {
    for (let block = 0; block < blocksPerCopy; block++) {
      const cw = bch15Encode(chunks[block] ?? 0);
      const row0 = copy.row0 + block * 2;
      const col0 = copy.col0;
      for (let j = 0; j < 16; j++) {
        const r = row0 + (j >= 8 ? 1 : 0);
        const c = col0 + (j % 8);
        const bit = j < 15 ? (cw >> (14 - j)) & 1 : 0;
        symbols[r * layout.N + c] = bit ? layout.whiteSymbol : layout.blackSymbol;
      }
    }
  }
}

export function readFormatBand(getSymbol, layout) {
  const { copies, blocksPerCopy, cols } = layout.format;
  const decodedCopies = [];
  for (const copy of copies) {
    const chunks = [];
    let ok = true;
    for (let block = 0; block < blocksPerCopy; block++) {
      const row0 = copy.row0 + block * 2;
      const col0 = copy.col0;
      let cw = 0;
      for (let j = 0; j < 15; j++) {
        const r = row0 + (j >= 8 ? 1 : 0);
        const c = col0 + (j % 8);
        const sym = getSymbol(r, c);
        const bit = sym === BLACK ? 0 : 1;
        cw = (cw << 1) | bit;
      }
      const msg = bch15Decode(cw);
      if (msg < 0) {
        ok = false;
        break;
      }
      chunks.push(msg);
    }
    if (ok) decodedCopies.push(chunks);
  }
  if (decodedCopies.length === 0) throw new Error('LCC format band: no valid copy');
  const first = decodedCopies[0];
  for (let i = 1; i < decodedCopies.length; i++) {
    if (decodedCopies[i].join(',') !== first.join(',')) {
      throw new Error('LCC format band: mirrored copies disagree');
    }
  }
  return unpackFormatPayload(first, blocksPerCopy);
}
