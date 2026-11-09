/**
 * LCC encoder.
 *
 * Pipeline:
 *   payload -> frame -> whitening -> RS -> interleaving -> constrained
 *   symbol mapping -> layout -> render
 */

import { BitReader } from './bitstream.js';
import { ECC_LEVELS, FRAME_HEADER_SIZE, LAYERS, MAX_MODULE_PX, MIN_MODULE_PX, QUIET_ZONE, versionToSize } from './constants.js';
import { RankConstraint } from './constraint.js';
import { computeRSBlocks, rsEncodeBlocks } from './ecc/rs.js';
import { buildFrame } from './frame.js';
import { packFormatPayload, writeFormatBand } from './format/format-band.js';
import { makeLayout } from './layout.js';
import { generatePalette } from './palettes.js';
import { makeWhitening } from './whitening.js';

export function capacityFor(layout, layerName, paletteInfo, constraint) {
  const layer = LAYERS[layerName];
  const D = layout.dataCount;
  let capacityBits;
  let rankConstraint = null;
  if (layerName === 'L1') {
    capacityBits = D;
  } else if (constraint) {
    rankConstraint = new RankConstraint(paletteInfo);
    capacityBits = rankConstraint.capacityBitsForModules(D);
  } else {
    capacityBits = D * layer.bitsPerModule;
  }
  const S = Math.floor(capacityBits / 8);
  if (S <= 0) {
    return { D, capacityBits, rankConstraint, S, kTotal: 0, payloadCapacity: -1 };
  }
  const blocks = computeRSBlocks(S, layer.ecc);
  const kTotal = blocks.reduce((s, b) => s + b.k, 0);
  return {
    D,
    capacityBits,
    rankConstraint,
    S,
    kTotal,
    payloadCapacity: kTotal - FRAME_HEADER_SIZE,
  };
}

export function chooseVersionAndScale({
  payloadSize,
  layerName,
  paletteInfo,
  constraint,
  width,
  height,
  mode,
  minModulePx,
  maxModulePx,
  quietZone,
  minVersion = 1,
}) {
  const minSide = Math.min(width, height);
  if (mode === 'compact') {
    for (let version = minVersion; version <= 100; version++) {
      const layout = makeLayout({ version, layer: layerName, paletteMode: paletteInfo.mode });
      const cap = capacityFor(layout, layerName, paletteInfo, constraint);
      if (cap.payloadCapacity >= payloadSize) {
        const s = Math.floor(minSide / (layout.N + 2 * quietZone));
        if (s < minModulePx) break;
        return { version, layout, cap, moduleSize: Math.min(s, maxModulePx) };
      }
    }
    throw new Error('LCC: payload does not fit in the requested canvas');
  }

  for (let s = maxModulePx; s >= minModulePx; s--) {
    const nMax = Math.floor(minSide / s) - 2 * quietZone;
    if (nMax < 21) continue;
    let version = Math.min(100, Math.floor((nMax - 21) / 4) + 1);
    if (version < minVersion) continue;
    const layout = makeLayout({ version, layer: layerName, paletteMode: paletteInfo.mode });
    const cap = capacityFor(layout, layerName, paletteInfo, constraint);
    if (cap.payloadCapacity >= payloadSize) {
      return { version, layout, cap, moduleSize: s };
    }
  }
  throw new Error('LCC: payload does not fit even at the minimum module size');
}

function render(symbols, layout, palette, moduleSize, quietZone) {
  const N = layout.N;
  const size = (N + 2 * quietZone) * moduleSize;
  const data = new Uint8Array(size * size * 3).fill(255);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const sym = symbols[r * N + c];
      if (sym < 0 || sym >= palette.length) {
        throw new Error(`LCC: invalid symbol at (${r},${c})`);
      }
      const [rr, gg, bb] = palette[sym];
      const y0 = (r + quietZone) * moduleSize;
      const x0 = (c + quietZone) * moduleSize;
      for (let dy = 0; dy < moduleSize; dy++) {
        let p = ((y0 + dy) * size + x0) * 3;
        for (let dx = 0; dx < moduleSize; dx++) {
          data[p++] = rr;
          data[p++] = gg;
          data[p++] = bb;
        }
      }
    }
  }
  return { width: size, height: size, data };
}

export function encode(payload, options = {}) {
  const layerName = options.layer ?? 'L2';
  const layer = LAYERS[layerName];
  if (!layer) throw new Error(`LCC: unknown layer ${layerName}`);

  let paletteMode = options.paletteMode ?? 'bucketed';
  let harmony = options.harmony ?? false;
  let constraint = options.constraint ?? layer.defaultConstraint;
  if (layerName === 'L1') constraint = false;

  const mode = options.mode ?? 'fill';
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;
  const quietZone = options.quietZone ?? QUIET_ZONE.screen;
  const minModulePx = options.minModulePx ?? MIN_MODULE_PX;
  const maxModulePx = options.maxModulePx ?? MAX_MODULE_PX;

  const payloadBytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : new Uint8Array(payload);

  let paletteInfo = generatePalette(layerName, { mode: paletteMode, harmony });
  const richFormat = paletteMode !== 'bucketed' || harmony || (options.seed ?? 0) !== 0;
  const minVersion = richFormat ? 4 : 1;
  let chosen;
  if (options.version) {
    const version = options.version;
    if (version < minVersion) {
      throw new Error('LCC: non-default palette/seed requires version >= 4 (N >= 33)');
    }
    const layout = makeLayout({ version, layer: layerName, paletteMode });
    const cap = capacityFor(layout, layerName, paletteInfo, constraint);
    let s = options.moduleSize ?? Math.floor(Math.min(width, height) / (layout.N + 2 * quietZone));
    s = Math.max(minModulePx, Math.min(s, maxModulePx));
    chosen = { version, layout, cap, moduleSize: s };
  } else {
    chosen = chooseVersionAndScale({
      payloadSize: payloadBytes.length,
      layerName,
      paletteInfo,
      constraint,
      width,
      height,
      mode,
      minModulePx,
      maxModulePx,
      quietZone,
      minVersion,
    });
  }

  const { version, layout, cap, moduleSize } = chosen;
  const formatBlocks = layout.format.blocksPerCopy;

  // Small versions only carry layer/ecc/constraint; palette and seed are fixed.
  if (formatBlocks === 1) {
    if (paletteMode !== 'bucketed' || harmony || (options.seed ?? 0) !== 0) {
      throw new Error('LCC: version 1-3 (N<33) only supports bucketed palette, no harmony, seed=0');
    }
  }
  if (formatBlocks === 2) {
    paletteMode = paletteMode;
  }

  let seed = options.seed ?? 0;
  if (formatBlocks === 1) seed = 0;
  else if (formatBlocks === 2) seed &= 7;
  else seed &= 63;

  // The palette must match the palette mode that the format band can express.
  paletteInfo = generatePalette(layerName, { mode: paletteMode, harmony });

  if (payloadBytes.length > cap.payloadCapacity) {
    throw new Error(`LCC: payload too large (${payloadBytes.length} > ${cap.payloadCapacity})`);
  }

  const flags = (constraint ? 1 : 0) | (options.compressed ? 2 : 0) | (options.encrypted ? 4 : 0);
  const frame = buildFrame({ layerId: layer.id, flags, payload: payloadBytes });
  if (frame.length > cap.kTotal) {
    throw new Error(`LCC: frame too large (${frame.length} > ${cap.kTotal})`);
  }
  const padded = new Uint8Array(cap.kTotal);
  padded.set(frame, 0);
  const whitened = makeWhitening(seed)(padded);
  const rsBytes = rsEncodeBlocks(whitened, cap.S, layer.ecc);

  const bitLength = cap.capacityBits;
  const bitBytes = new Uint8Array(Math.ceil(bitLength / 8));
  bitBytes.set(rsBytes.subarray(0, Math.min(rsBytes.length, bitBytes.length)));

  let dataSymbols;
  if (layerName === 'L1') {
    const reader = new BitReader(bitBytes, bitLength);
    dataSymbols = new Array(cap.D);
    for (let i = 0; i < cap.D; i++) dataSymbols[i] = reader.readBit();
  } else if (constraint) {
    const reader = new BitReader(bitBytes, bitLength);
    dataSymbols = cap.rankConstraint.encode(reader, cap.D);
  } else {
    const reader = new BitReader(bitBytes, bitLength);
    dataSymbols = new Array(cap.D);
    for (let i = 0; i < cap.D; i++) dataSymbols[i] = reader.readBits(layer.bitsPerModule);
  }

  const symbols = Int16Array.from(layout.fixed);
  for (let i = 0; i < layout.dataCoords.length; i++) {
    const [r, c] = layout.dataCoords[i];
    symbols[r * layout.N + c] = dataSymbols[i];
  }

  const eccIndex = ECC_LEVELS.indexOf(layer.ecc);
  const chunks = packFormatPayload({
    formatBlocks,
    layerId: layer.id,
    eccIndex,
    paletteMode,
    harmony,
    seed,
    constraint,
    compressed: !!options.compressed,
    encrypted: !!options.encrypted,
  });
  writeFormatBand(symbols, layout, chunks);

  const image = render(symbols, layout, paletteInfo.palette, moduleSize, quietZone);

  const actualBitsPerModule = layerName === 'L1'
    ? 1
    : constraint
      ? cap.capacityBits / cap.D
      : layer.bitsPerModule;

  return {
    image,
    symbols,
    layout,
    paletteInfo,
    meta: {
      layer: layerName,
      version,
      N: layout.N,
      moduleSize,
      quietZone,
      paletteMode,
      harmony,
      constraint,
      seed,
      ecc: layer.ecc,
      dataCount: cap.D,
      functionCount: layout.functionCount,
      capacityBits: cap.capacityBits,
      bitsPerModule: actualBitsPerModule,
      payloadCapacity: cap.payloadCapacity,
      payloadSize: payloadBytes.length,
      formatBlocks,
    },
  };
}
