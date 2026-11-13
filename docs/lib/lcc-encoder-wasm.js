/**
 * Loader / serializer for the C encode core in lcc-encoder.wasm.
 *
 * Node instantiates synchronously during module evaluation, so the public
 * encoder API stays synchronous.  Browsers fetch the artifact asynchronously
 * during module evaluation (top-level await).
 */

import { instantiateWasmBytes, loadWasmBytes } from './wasm-common.js';

const wasmBytes = await loadWasmBytes('lcc-encoder.wasm');
let wasm = instantiateWasmBytes(wasmBytes);

export function resetEncoderWasm() {
  wasm = instantiateWasmBytes(wasmBytes);
}

function packRequest(payload, options = {}) {
  const layer = String(options.layer ?? 'G10');
  const payloadBytes = typeof payload === 'string'
    ? new TextEncoder().encode(payload)
    : new Uint8Array(payload);
  const header = new Uint8Array(96 + payloadBytes.length);
  const view = new DataView(header.buffer);
  view.setInt32(0, payloadBytes.length, true);
  view.setInt32(4, options.width ?? 0, true);
  view.setInt32(8, options.height ?? 0, true);
  view.setInt32(12, options.mode === 'compact' ? 1 : 0, true);
  view.setInt32(16, options.paletteMode === 'harmony' ? 1 : 0, true);
  view.setInt32(20, options.harmony ? 1 : 0, true);
  view.setInt32(24, options.constraint === undefined ? -1 : options.constraint ? 1 : 0, true);
  view.setInt32(28, options.seed ?? 0, true);
  const eccIndex = options.eccLevel === undefined || options.eccLevel === null || options.eccLevel === 'auto'
    ? -1
    : (typeof options.eccLevel === 'number'
      ? ({ 0.2: 0, 0.3: 1, 0.35: 2, 0.4: 3 }[options.eccLevel] ?? -2)
      : ({ L: 0, M: 1, Q: 2, H: 3 }[String(options.eccLevel).toUpperCase()] ?? -2));
  view.setInt32(32, eccIndex, true);
  view.setInt32(36, options.boostEcc ? 1 : 0, true);
  view.setInt32(40, options.minModulePx ?? 0, true);
  view.setInt32(44, options.maxModulePx ?? 0, true);
  view.setInt32(48, options.quietZone ?? -1, true);
  view.setInt32(52, options.minVersion ?? 0, true);
  view.setInt32(56, options.maxVersion ?? 0, true);
  view.setInt32(60, options.moduleSize ?? 0, true);
  view.setInt32(64, options.version ?? 0, true);
  view.setInt32(68, options.compressed ? 1 : 0, true);
  view.setInt32(72, options.encrypted ? 1 : 0, true);
  header.set(new TextEncoder().encode(layer).subarray(0, 15), 80);
  header.set(payloadBytes, 96);
  return header;
}

function readHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getInt32(0, true);
  const errorEnd = bytes.indexOf(0, 8);
  const error = new TextDecoder().decode(
    bytes.slice(8, errorEnd >= 0 && errorEnd < 104 ? errorEnd : 104),
  );
  return {
    status,
    error,
    width: view.getUint32(104, true),
    height: view.getUint32(108, true),
    N: view.getUint32(112, true),
    version: view.getUint32(116, true),
    moduleSize: view.getUint32(120, true),
    quietZone: view.getUint32(124, true),
    payloadCapacity: view.getInt32(128, true),
    dataCount: view.getUint32(132, true),
    functionCount: view.getUint32(136, true),
    capacityBits: view.getUint32(140, true),
    payloadSize: view.getUint32(144, true),
    formatBlocks: view.getUint32(148, true),
    seed: view.getUint32(152, true),
    constraint: view.getUint32(156, true) === 1,
    harmony: view.getUint32(160, true) === 1,
    paletteMode: view.getUint32(164, true) === 1 ? 'harmony' : 'maxmin',
    paletteSize: view.getUint32(168, true),
    eccIndex: view.getUint32(172, true),
    shapeSetSize: view.getUint32(176, true),
    shapeLayerId: view.getInt32(180, true),
    shapeExt: view.getUint32(184, true),
    shapeVariant: view.getUint32(188, true),
    layerId: view.getUint32(192, true),
    flags: view.getUint32(196, true),
    bitsPerModule: view.getFloat64(200, true),
    ecc: view.getFloat64(208, true),
    minDeltaE: view.getFloat64(216, true),
    rankCount: view.getUint32(224, true),
    maxRankDiff: view.getUint32(228, true),
    blackIndex: view.getUint32(232, true),
    whiteIndex: view.getUint32(236, true),
    imageBytes: view.getUint32(240, true),
    rsSymbols: view.getUint32(244, true),
    symbolsOffset: view.getUint32(248, true),
    imageOffset: view.getUint32(252, true),
    paletteOffset: view.getUint32(256, true),
    paletteLabOffset: view.getUint32(260, true),
    rankOfOffset: view.getUint32(264, true),
    rankCountsOffset: view.getUint32(268, true),
    fixedColorOffset: view.getUint32(272, true),
    hasFixedColorOffset: view.getUint32(276, true),
    fixedShapeOffset: view.getUint32(280, true),
    hasFixedShapeOffset: view.getUint32(284, true),
    dataCoordsOffset: view.getUint32(288, true),
    grayRgbOffset: view.getUint32(292, true),
    grayLabOffset: view.getUint32(296, true),
    totalBytes: view.getUint32(300, true),
    initialRank: view.getUint32(304, true),
    rowsPerCopy: view.getUint32(308, true),
    copyCount: view.getUint32(312, true),
    kTotal: view.getUint32(316, true),
  };
}

function callEncode(payload, options) {
  const request = packRequest(payload, options);
  const ptr = wasm.write(request);
  try {
    const status = wasm.exports.lcc_api_encode(ptr, request.length);
    if (status !== 0 && status !== 3) {
      const header = readHeader(wasm.readLast());
      throw new Error(header.error || 'LCC encode failed');
    }
    return wasm.readLast();
  } finally {
    wasm.exports.free(ptr);
  }
}

function callLayout(options) {
  const request = packRequest(new Uint8Array(0), options);
  const ptr = wasm.write(request);
  try {
    const status = wasm.exports.lcc_api_encode_layout(ptr, request.length);
    const bytes = wasm.readLast();
    const header = readHeader(bytes);
    if (status !== 0) throw new Error(header.error || 'LCC layout failed');
    return { bytes, header };
  } finally {
    wasm.exports.free(ptr);
  }
}

function parsePalette(bytes, header) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = header.paletteSize;
  const palette = [];
  for (let i = 0; i < size; i++) {
    const o = header.paletteOffset + i * 3;
    palette.push([bytes[o], bytes[o + 1], bytes[o + 2]]);
  }
  const paletteLab = [];
  for (let i = 0; i < size; i++) {
    const o = header.paletteLabOffset + i * 24;
    paletteLab.push([
      view.getFloat64(o, true),
      view.getFloat64(o + 8, true),
      view.getFloat64(o + 16, true),
    ]);
  }
  const rankOf = new Int16Array(size);
  for (let i = 0; i < size; i++) {
    rankOf[i] = view.getInt16(header.rankOfOffset + i * 2, true);
  }
  const rankCounts = [];
  for (let i = 0; i < header.rankCount; i++) {
    rankCounts.push(view.getUint32(header.rankCountsOffset + i * 4, true));
  }
  const symbolsByRank = Array.from({ length: header.rankCount }, () => []);
  for (let i = 0; i < size; i++) symbolsByRank[rankOf[i]]?.push(i);
  const grayPalette = [];
  const grayLab = [];
  for (let i = 0; i < 16; i++) {
    const o = header.grayRgbOffset + i * 3;
    grayPalette.push([bytes[o], bytes[o + 1], bytes[o + 2]]);
    const l = header.grayLabOffset + i * 24;
    grayLab.push([
      view.getFloat64(l, true),
      view.getFloat64(l + 8, true),
      view.getFloat64(l + 16, true),
    ]);
  }
  return {
    palette,
    paletteLab,
    rankOf,
    rankCounts,
    symbolsByRank,
    grayPalette,
    grayLab,
    minDeltaE: header.minDeltaE,
    rankCount: header.rankCount,
    maxRankDiff: header.maxRankDiff,
    initialRank: header.initialRank,
    blackIndex: header.blackIndex,
    whiteIndex: header.whiteIndex,
    mode: header.paletteMode,
    harmony: header.harmony,
  };
}

function parseLayout(bytes, header, layerName) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const N = header.N;
  const cells = N * N;
  const fixed = new Int16Array(cells).fill(-1);
  const fixedColor = new Uint8Array(cells * 3);
  const hasFixedColor = new Uint8Array(cells);
  const fixedShape = new Int8Array(cells).fill(-1);
  const hasFixedShape = new Uint8Array(cells);
  fixedColor.set(bytes.subarray(header.fixedColorOffset, header.fixedColorOffset + cells * 3));
  hasFixedColor.set(bytes.subarray(header.hasFixedColorOffset, header.hasFixedColorOffset + cells));
  for (let i = 0; i < cells; i++) {
    fixedShape[i] = view.getInt8(header.fixedShapeOffset + i);
  }
  hasFixedShape.set(bytes.subarray(header.hasFixedShapeOffset, header.hasFixedShapeOffset + cells));
  const dataCoords = [];
  for (let i = 0; i < header.dataCount; i++) {
    const o = header.dataCoordsOffset + i * 8;
    dataCoords.push([view.getUint32(o, true), view.getUint32(o + 4, true)]);
  }
  const mask = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    if (hasFixedColor[i] || fixedShape[i] >= 0) mask[i] = 1;
  }
  const copies = [];
  if (N >= 25) {
    copies.push({ row0: 8, col0: N - 8, rows: header.rowsPerCopy, cols: 8 });
    copies.push({ row0: N - 8, col0: 8, rows: header.rowsPerCopy, cols: 8 });
  } else {
    for (let copy = 0; copy < 2; copy++) {
      copies.push({
        row0: N - (2 - copy) * header.rowsPerCopy,
        col0: N - 8,
        rows: header.rowsPerCopy,
        cols: 8,
      });
    }
  }
  return {
    version: header.version,
    N,
    layer: layerName,
    paletteMode: header.paletteMode,
    harmony: header.harmony,
    mask,
    fixed,
    fixedColor,
    hasFixedColor,
    fixedShape,
    hasFixedShape,
    dataCoords,
    functionCount: header.functionCount,
    dataCount: header.dataCount,
    format: {
      blocksPerCopy: header.formatBlocks,
      rowsPerCopy: header.rowsPerCopy,
      cols: 8,
      copies,
    },
    hub: null,
    alignment: null,
    blackSymbol: header.blackIndex,
    whiteSymbol: header.whiteIndex,
    BLACK: 0,
    WHITE: 15,
  };
}

export function encodeWasm(payload, options = {}) {
  const bytes = callEncode(payload, options);
  const header = readHeader(bytes);
  const layerName = options.layer ?? 'G10';
  const N = header.N;
  const symbols = new Int16Array(N * N);
  const symbolBytes = bytes.subarray(header.symbolsOffset, header.symbolsOffset + N * N * 2);
  new Uint8Array(symbols.buffer).set(symbolBytes);
  const image = {
    width: header.width,
    height: header.height,
    data: bytes.slice(header.imageOffset, header.imageOffset + header.imageBytes),
  };
  return {
    image,
    symbols,
    layout: parseLayout(bytes, header, layerName),
    paletteInfo: parsePalette(bytes, header),
    meta: {
      layer: layerName,
      version: header.version,
      N,
      moduleSize: header.moduleSize,
      quietZone: header.quietZone,
      paletteMode: header.paletteMode,
      harmony: header.harmony,
      paletteSize: header.paletteSize,
      minDeltaE: header.minDeltaE,
      constraint: header.constraint,
      constraintRankCount: header.rankCount,
      constraintMaxDiff: header.maxRankDiff,
      seed: header.seed,
      ecc: header.ecc,
      eccLevel: ['L', 'M', 'Q', 'H'][header.eccIndex] ?? null,
      dataCount: header.dataCount,
      functionCount: header.functionCount,
      capacityBits: header.capacityBits,
      bitsPerModule: header.bitsPerModule,
      payloadCapacity: header.payloadCapacity,
      payloadSize: header.payloadSize,
      formatBlocks: header.formatBlocks,
      shapeLayer: header.shapeSetSize > 0,
      legacyLayer: null,
      shapeLayerId: header.shapeSetSize > 0 ? header.shapeLayerId : null,
      shapeExt: header.shapeExt,
      shapeVariant: header.shapeVariant,
      shapeSetSize: header.shapeSetSize > 0 ? header.shapeSetSize : 1,
      shapeBits: header.shapeSetSize > 1 ? Math.log2(header.shapeSetSize) : 0,
      colorCount: header.paletteSize,
    },
  };
}

export function makeLayoutWasm({
  version,
  layer,
  paletteMode = 'maxmin',
  harmony = false,
}) {
  const { bytes, header } = callLayout({
    layer,
    version,
    paletteMode,
    harmony,
    constraint: 0,
    eccLevel: 'auto',
  });
  return {
    layout: parseLayout(bytes, header, layer),
    paletteInfo: parsePalette(bytes, header),
    header,
  };
}

export function generatePaletteWasm(layer, { mode = 'maxmin', harmony = false } = {}) {
  const { paletteInfo } = makeLayoutWasm({
    version: 2,
    layer,
    paletteMode: mode,
    harmony: Boolean(harmony),
  });
  return paletteInfo;
}

export function capacityForWasm(layout, layer, constraint, eccLevel) {
  const { header } = callLayout({
    layer,
    version: layout.version,
    paletteMode: layout.paletteMode,
    harmony: layout.harmony,
    constraint: constraint ? 1 : 0,
    eccLevel,
  });
  return {
    D: header.dataCount,
    capacityBits: header.capacityBits,
    S: header.rsSymbols,
    kTotal: header.kTotal,
    payloadCapacity: header.payloadCapacity,
    ecc: header.ecc,
  };
}
