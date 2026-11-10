/**
 * Compact, scalable format band.
 *
 * Payload is split into 5-bit BCH(15,5) blocks.  Each block is rendered as
 * 2 rows x 8 columns (15 codeword bits + one padding bit).  Two mirrored
 * copies are used; N>=25 places them near the top-right and bottom-left
 * finders.
 *
 *   1 block / copy : mode(3) + ecc(2)
 *   2 blocks/copy  : mode(3) + ecc(2) + constraint(1) + palette(2) + seed(2)
 *   3 blocks/copy  : mode(3) + ecc(2) + constraint(1) + palette(2) + seed(6) + flags(1)
 *
 * Mode is the layer id (L1/L2a/L2b/L3c/L3d/L4e/L4f).  Version/N is derived
 * from the finder-centre distance and timing pattern.
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

function paletteBitsOf(paletteMode, harmony) {
  if (harmony) return 1;
  if (paletteMode === 'harmony') return 1;
  return 0;
}

export function packFormatPayload({
  formatBlocks,
  modeId,
  eccIndex,
  paletteMode = 'maxmin',
  harmony = false,
  seed = 0,
  constraint = false,
  compressed = false,
  encrypted = false,
  shapeLayerId = null,
  shapeExt = 0,
}) {
  const isShape = shapeLayerId !== null && shapeLayerId !== undefined;
  if (isShape && formatBlocks < 2) {
    throw new Error('LCC format band: shape layers require at least 2 blocks');
  }
  if (isShape && shapeExt && formatBlocks < 3) {
    throw new Error('LCC format band: extended shape layer requires 3 blocks');
  }
  const actualModeId = isShape ? 7 : modeId;
  const paletteBits = isShape ? (shapeLayerId & 3) : paletteBitsOf(paletteMode, harmony);
  const flag = isShape ? (shapeExt ? 1 : 0) : (compressed || encrypted ? 1 : 0);
  let bits;
  if (formatBlocks === 1) {
    bits = [...bitsOf(actualModeId, 3), ...bitsOf(eccIndex, 2)];
  } else if (formatBlocks === 2) {
    bits = [
      ...bitsOf(actualModeId, 3),
      ...bitsOf(eccIndex, 2),
      constraint ? 1 : 0,
      ...bitsOf(paletteBits, 2),
      ...bitsOf(seed & 3, 2),
    ];
  } else {
    bits = [
      ...bitsOf(actualModeId, 3),
      ...bitsOf(eccIndex, 2),
      constraint ? 1 : 0,
      ...bitsOf(paletteBits, 2),
      ...bitsOf(seed & 63, 6),
      flag,
    ];
  }
  const chunks = [];
  for (let i = 0; i < formatBlocks; i++) {
    chunks.push(valueOf(bits, i * 5, 5));
  }
  return chunks;
}

export function unpackFormatPayload(chunks, formatBlocks) {
  const bits = [];
  for (const c of chunks) bits.push(...bitsOf(c, 5));
  const modeId = valueOf(bits, 0, 3);
  const eccIndex = valueOf(bits, 3, 2);
  if (formatBlocks === 1) {
    return {
      modeId,
      eccIndex,
      paletteMode: 'maxmin',
      harmony: false,
      seed: 0,
      constraint: false,
      compressed: false,
      encrypted: false,
    };
  }
  if (formatBlocks === 2) {
    const paletteBits = valueOf(bits, 6, 2);
    if (modeId === 7) {
      return {
        modeId,
        eccIndex,
        shapeLayerId: paletteBits,
        shapeExt: 0,
        paletteMode: 'maxmin',
        harmony: false,
        seed: valueOf(bits, 8, 2),
        constraint: bits[5] === 1,
        compressed: false,
        encrypted: false,
      };
    }
    return {
      modeId,
      eccIndex,
      shapeLayerId: null,
      shapeExt: 0,
      paletteMode: paletteBits === 1 ? 'harmony' : 'maxmin',
      harmony: paletteBits === 1,
      seed: valueOf(bits, 8, 2),
      constraint: bits[5] === 1,
      compressed: false,
      encrypted: false,
    };
  }
  const paletteBits = valueOf(bits, 6, 2);
  const seed = valueOf(bits, 8, 6);
  const flag = bits[14] === 1;
  if (modeId === 7) {
    return {
      modeId,
      eccIndex,
      shapeLayerId: paletteBits,
      shapeExt: flag ? 1 : 0,
      paletteMode: 'maxmin',
      harmony: false,
      seed,
      constraint: bits[5] === 1,
      compressed: false,
      encrypted: false,
    };
  }
  return {
    modeId,
    eccIndex,
    shapeLayerId: null,
    shapeExt: 0,
    paletteMode: paletteBits === 1 ? 'harmony' : 'maxmin',
    harmony: paletteBits === 1,
    seed,
    constraint: bits[5] === 1,
    compressed: flag,
    encrypted: flag,
  };
}

export function writeFormatBand(symbols, layout, chunks) {
  const { copies, blocksPerCopy } = layout.format;
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
  const { copies, blocksPerCopy } = layout.format;
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
  const keyOf = (chunks) => chunks.join(',');
  const counts = new Map();
  for (const chunks of decodedCopies) {
    const k = keyOf(chunks);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [k, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = k;
    }
  }
  if (bestCount < 2 && decodedCopies.length > 1) {
    throw new Error('LCC format band: copies disagree without a majority');
  }
  const chosen = decodedCopies.find((chunks) => keyOf(chunks) === bestKey);
  return unpackFormatPayload(chosen, blocksPerCopy);
}
