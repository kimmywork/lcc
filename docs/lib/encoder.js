/**
 * LCC encoder.
 *
 * payload -> frame -> whitening -> RS -> interleaving -> constrained symbol
 * mapping -> layout -> render.
 *
 * ECC can be selected as auto/L/M/Q/H; Boost ECC tries the highest level that
 * still fits the payload at the chosen symbol size.
 */

import { BitReader } from './bitstream.js';
import {
  ECC_BY_NAME,
  ECC_LEVELS,
  FRAME_HEADER_SIZE,
  LAYERS,
  MAX_MODULE_PX,
  MIN_MODULE_PX,
  QUIET_ZONE,
  eccNameOf,
  resolveLayerName,
} from './constants.js';
import { RankConstraint } from './constraint.js';
import { computeRSBlocks, rsEncodeBlocks } from './ecc/rs.js';
import { buildFrame } from './frame.js';
import { packFormatPayload, writeFormatBand } from './format/format-band.js';
import { makeLayout } from './layout.js';
import { generatePalette } from './palettes.js';
import { foregroundFor, shapeMask } from './shapes.js';
import { makeWhitening } from './whitening.js';

function resolveEcc(option, layer) {
  if (option === undefined || option === null || option === 'auto') return layer.ecc;
  if (typeof option === 'string') {
    const value = ECC_BY_NAME.get(option.toUpperCase());
    if (value === undefined) throw new Error('LCC: eccLevel must be auto/L/M/Q/H');
    return value;
  }
  if (typeof option === 'number' && ECC_LEVELS.includes(option)) return option;
  throw new Error('LCC: eccLevel must be auto/L/M/Q/H');
}

function eccCandidates(baseEcc, boostEcc) {
  if (!boostEcc) return [baseEcc];
  return ECC_LEVELS.filter((e) => e >= baseEcc).sort((a, b) => b - a);
}

function baseCapacityFor(layout, layerName, paletteInfo, constraint) {
  const layer = LAYERS[layerName];
  const D = layout.dataCount;
  let capacityBits;
  let rankConstraint = null;
  if (layerName === 'G10') {
    capacityBits = D;
  } else if (constraint) {
    rankConstraint = new RankConstraint(paletteInfo);
    capacityBits = rankConstraint.capacityBitsForModules(D);
  } else {
    capacityBits = D * layer.bitsPerModule;
  }
  return { D, capacityBits, rankConstraint };
}

function payloadForEcc(capacityBits, ecc) {
  const S = Math.floor(capacityBits / 8);
  if (S <= 0) return { S: 0, kTotal: 0, payloadCapacity: -1 };
  const blocks = computeRSBlocks(S, ecc);
  const kTotal = blocks.reduce((s, b) => s + b.k, 0);
  return { S, kTotal, payloadCapacity: kTotal - FRAME_HEADER_SIZE };
}

export function capacityFor(
  layout,
  layerName,
  paletteInfo,
  constraint,
  ecc = undefined,
) {
  layerName = resolveLayerName(layerName);
  if (ecc === undefined) ecc = LAYERS[layerName].ecc;
  const base = baseCapacityFor(layout, layerName, paletteInfo, constraint);
  const payload = payloadForEcc(base.capacityBits, ecc);
  return { ...base, ...payload, ecc };
}

function pickCap(layout, layerName, paletteInfo, constraint, payloadSize, baseEcc, boostEcc) {
  const base = baseCapacityFor(layout, layerName, paletteInfo, constraint);
  for (const ecc of eccCandidates(baseEcc, boostEcc)) {
    const payload = payloadForEcc(base.capacityBits, ecc);
    if (payload.payloadCapacity >= payloadSize) {
      return { cap: { ...base, ...payload, ecc }, ecc };
    }
  }
  return null;
}

export function chooseVersionAndScale({
  payloadSize,
  layerName: rawLayerName,
  paletteInfo,
  harmony = false,
  constraint,
  width,
  height,
  mode,
  minModulePx,
  maxModulePx,
  quietZone,
  minVersion = 1,
  maxVersion = 100,
  baseEcc = undefined,
  boostEcc = false,
  moduleSize = null,
}) {
  const layerName = resolveLayerName(rawLayerName);
  if (baseEcc === undefined) baseEcc = LAYERS[layerName].ecc;
  const minSide = Math.min(width, height);
  const layoutFor = (version) => makeLayout({
    version,
    layer: layerName,
    paletteMode: paletteInfo.mode,
    harmony,
    paletteInfo,
  });
  const tryVersion = (version, s) => {
    const layout = layoutFor(version);
    const picked = pickCap(layout, layerName, paletteInfo, constraint, payloadSize, baseEcc, boostEcc);
    if (!picked) return null;
    return { version, layout, cap: picked.cap, moduleSize: s, ecc: picked.ecc };
  };

  if (mode === 'compact') {
    if (moduleSize) {
      const s = Math.max(minModulePx, Math.min(maxModulePx, moduleSize));
      const nMax = Math.floor(minSide / s) - 2 * quietZone;
      if (nMax < 21) throw new Error('LCC: module size is too large for the canvas');
      const vMax = Math.min(maxVersion, Math.floor((nMax - 21) / 4) + 1);
      if (vMax < minVersion) throw new Error('LCC: version range does not fit the canvas');
      for (let version = minVersion; version <= vMax; version++) {
        const chosen = tryVersion(version, s);
        if (chosen) return chosen;
      }
      throw new Error('LCC: payload does not fit in the requested canvas');
    }
    for (let version = minVersion; version <= maxVersion; version++) {
      const layout = layoutFor(version);
      const picked = pickCap(layout, layerName, paletteInfo, constraint, payloadSize, baseEcc, boostEcc);
      if (picked) {
        const s = Math.floor(minSide / (layout.N + 2 * quietZone));
        if (s < minModulePx) break;
        return {
          version,
          layout,
          cap: picked.cap,
          moduleSize: Math.min(s, maxModulePx),
          ecc: picked.ecc,
        };
      }
    }
    throw new Error('LCC: payload does not fit in the requested canvas');
  }

  if (moduleSize) {
    const s = Math.max(minModulePx, Math.min(maxModulePx, moduleSize));
    const nMax = Math.floor(minSide / s) - 2 * quietZone;
    if (nMax < 21) throw new Error('LCC: module size is too large for the canvas');
    const version = Math.min(maxVersion, Math.floor((nMax - 21) / 4) + 1);
    if (version < minVersion) throw new Error('LCC: version range does not fit the canvas');
    const chosen = tryVersion(version, s);
    if (chosen) return chosen;
    throw new Error('LCC: payload does not fit at this module size');
  }

  for (let s = maxModulePx; s >= minModulePx; s--) {
    const nMax = Math.floor(minSide / s) - 2 * quietZone;
    if (nMax < 21) continue;
    const version = Math.min(maxVersion, Math.floor((nMax - 21) / 4) + 1);
    if (version < minVersion) continue;
    const chosen = tryVersion(version, s);
    if (chosen) return chosen;
  }
  throw new Error('LCC: payload does not fit even at the minimum module size');
}

function paintModule(data, size, x0, y0, moduleSize, background, shapeIndex) {
  const foreground = shapeIndex >= 0 ? foregroundFor(background) : null;
  const mask = shapeIndex >= 0 ? shapeMask(shapeIndex, moduleSize) : null;
  for (let dy = 0; dy < moduleSize; dy++) {
    let p = ((y0 + dy) * size + x0) * 3;
    for (let dx = 0; dx < moduleSize; dx++) {
      const on = mask ? mask[dy * moduleSize + dx] : 0;
      const color = on ? foreground : background;
      data[p++] = color[0];
      data[p++] = color[1];
      data[p++] = color[2];
    }
  }
}

function render(symbols, layout, palette, moduleSize, quietZone, layer) {
  const N = layout.N;
  const size = (N + 2 * quietZone) * moduleSize;
  const data = new Uint8Array(size * size * 3).fill(255);
  const colorCount = palette.length;
  const shapeSetSize = layer?.shapeSetSize ?? 1;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      let background;
      let shapeIndex = -1;
      if (layout.hasFixedColor[i]) {
        background = [
          layout.fixedColor[i * 3],
          layout.fixedColor[i * 3 + 1],
          layout.fixedColor[i * 3 + 2],
        ];
        if (layout.hasFixedShape[i]) shapeIndex = layout.fixedShape[i];
      } else {
        const sym = symbols[i];
        if (sym < 0 || sym >= shapeSetSize * colorCount) {
          throw new Error(`LCC: invalid symbol at (${r},${c})`);
        }
        if (shapeSetSize > 1) {
          shapeIndex = Math.floor(sym / colorCount);
          background = palette[sym % colorCount];
        } else {
          background = palette[sym];
        }
      }
      const y0 = (r + quietZone) * moduleSize;
      const x0 = (c + quietZone) * moduleSize;
      paintModule(data, size, x0, y0, moduleSize, background, shapeIndex);
    }
  }
  return { width: size, height: size, data };
}

export function encode(payload, options = {}) {
  const layerName = resolveLayerName(options.layer ?? 'G10');
  const layer = LAYERS[layerName];
  if (!layer) throw new Error(`LCC: unknown layer ${layerName}`);

  const isShapeLayer = !!layer.shapeSetSize;
  if (isShapeLayer && (options.seed ?? 0) !== 0) {
    throw new Error(
      'LCC: shape layers reserve the format seed field for the shape variant; options.seed must be 0',
    );
  }
  const paletteMode = isShapeLayer ? 'maxmin' : (options.paletteMode ?? 'maxmin');
  const harmony = isShapeLayer ? false : (options.harmony ?? false);
  let constraint = options.constraint ?? layer.defaultConstraint;
  if (layerName === 'G10' || isShapeLayer) constraint = false;

  const mode = options.mode ?? 'fill';
  const width = options.width ?? 1024;
  const height = options.height ?? 1024;
  const quietZone = options.quietZone ?? QUIET_ZONE.screen;
  const minModulePx = Math.max(options.minModulePx ?? MIN_MODULE_PX, layer.minModulePx ?? 0);
  const maxModulePx = options.maxModulePx ?? MAX_MODULE_PX;
  const baseEcc = resolveEcc(options.eccLevel, layer);
  const boostEcc = options.boostEcc ?? false;
  const moduleSize = options.moduleSize ?? null;

  const payloadBytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : new Uint8Array(payload);

  let paletteInfo = generatePalette(layerName, { mode: paletteMode, harmony });
  const richFormat = isShapeLayer || layer.kind === 'color' || constraint
    || (options.seed ?? 0) !== 0 || paletteMode !== 'maxmin' || harmony;
  const minVersion = Math.max(
    options.minVersion ?? 1,
    richFormat ? 2 : 1,
    layer.minVersion ?? 1,
  );
  const maxVersion = options.maxVersion ?? 100;
  if (minVersion < 1 || maxVersion > 100 || maxVersion < minVersion) {
    throw new Error('LCC: invalid version range');
  }

  let chosen;
  if (options.version) {
    const version = options.version;
    if (version < minVersion || version > maxVersion) {
      throw new Error(`LCC: version must be between ${minVersion} and ${maxVersion}`);
    }
    const layout = makeLayout({ version, layer: layerName, paletteMode, harmony, paletteInfo });
    const picked = pickCap(layout, layerName, paletteInfo, constraint, payloadBytes.length, baseEcc, boostEcc);
    if (!picked) throw new Error('LCC: payload does not fit at this version');
    let s = moduleSize ?? Math.floor(Math.min(width, height) / (layout.N + 2 * quietZone));
    s = Math.max(minModulePx, Math.min(s, maxModulePx));
    chosen = { version, layout, cap: picked.cap, moduleSize: s, ecc: picked.ecc };
  } else {
    chosen = chooseVersionAndScale({
      payloadSize: payloadBytes.length,
      layerName,
      paletteInfo,
      harmony,
      constraint,
      width,
      height,
      mode,
      minModulePx,
      maxModulePx,
      quietZone,
      minVersion,
      maxVersion,
      baseEcc,
      boostEcc,
      moduleSize,
    });
  }

  const { version, layout, cap, moduleSize: chosenModuleSize, ecc } = chosen;
  const formatBlocks = layout.format.blocksPerCopy;

  let seed = options.seed ?? 0;
  if (isShapeLayer) {
    // The format seed field carries the shape-layer variant.  Shape layers
    // always use a fixed whitening seed so existing variant-0 codes are
    // unchanged.
    seed = layer.shapeVariant ?? 0;
  } else if (formatBlocks === 1) seed = 0;
  else if (formatBlocks === 2) seed &= 3;
  else seed &= 63;
  const whitenSeed = isShapeLayer ? 0 : seed;

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
  const whitened = makeWhitening(whitenSeed)(padded);
  const rsBytes = rsEncodeBlocks(whitened, cap.S, ecc);

  const bitLength = cap.capacityBits;
  const bitBytes = new Uint8Array(Math.ceil(bitLength / 8));
  bitBytes.set(rsBytes.subarray(0, Math.min(rsBytes.length, bitBytes.length)));

  let dataSymbols;
  if (layerName === 'G10') {
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

  const eccIndex = ECC_LEVELS.indexOf(ecc);
  const chunks = packFormatPayload({
    formatBlocks,
    modeId: isShapeLayer ? 7 : layer.id,
    eccIndex,
    paletteMode,
    harmony,
    seed,
    constraint,
    compressed: !!options.compressed,
    encrypted: !!options.encrypted,
    shapeLayerId: isShapeLayer ? layer.shapeLayerId : null,
    shapeExt: isShapeLayer ? layer.shapeExt : 0,
  });
  writeFormatBand(symbols, layout, chunks);

  const image = render(
    symbols,
    layout,
    paletteInfo.palette,
    chosenModuleSize,
    quietZone,
    layer,
  );

  const actualBitsPerModule = layerName === 'G10'
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
      moduleSize: chosenModuleSize,
      quietZone,
      paletteMode,
      harmony,
      paletteSize: layer.paletteSize,
      minDeltaE: paletteInfo.minDeltaE,
      constraint,
      constraintRankCount: paletteInfo.rankCount,
      constraintMaxDiff: paletteInfo.maxRankDiff,
      seed: whitenSeed,
      ecc,
      eccLevel: eccNameOf(ecc),
      dataCount: cap.D,
      functionCount: layout.functionCount,
      capacityBits: cap.capacityBits,
      bitsPerModule: actualBitsPerModule,
      payloadCapacity: cap.payloadCapacity,
      payloadSize: payloadBytes.length,
      formatBlocks,
      shapeLayer: isShapeLayer,
      legacyLayer: layer.legacyName ?? null,
      shapeLayerId: isShapeLayer ? layer.shapeLayerId : null,
      shapeExt: isShapeLayer ? layer.shapeExt : 0,
      shapeVariant: isShapeLayer ? (layer.shapeVariant ?? 0) : 0,
      shapeSetSize: layer.shapeSetSize ?? 1,
      shapeBits: isShapeLayer ? Math.log2(layer.shapeSetSize) : 0,
      colorCount: layer.paletteSize,
    },
  };
}
