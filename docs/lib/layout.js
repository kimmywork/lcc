/**
 * LCC symbol layout.
 *
 * Function patterns are black/white and independent of the data palette.
 * The calibration hub contains:
 *   - a 4x4 reference gray ramp (16 equal-L* grays) as fixed RGB colours;
 *   - a compact grid of data-palette samples (for colour layers);
 *   - black/white endpoint cells on the hub border.
 *
 * Data modules use a Hilbert curve order filtered to the data cells.
 */

import { deltaE76 } from './color.js';
import { LAYERS, resolveLayerName, versionToSize } from './constants.js';
import { generatePalette } from './palettes.js';

export const BLACK = 0;
export const WHITE = 15;

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export function hilbertD2XY(n, d) {
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

export function hilbertOrder(n) {
  const p = nextPowerOfTwo(n);
  const out = [];
  for (let d = 0; d < p * p; d++) {
    const [x, y] = hilbertD2XY(p, d);
    if (x < n && y < n) out.push([y, x]);
  }
  return out;
}

export function calibrationSampleCount(layerName, N) {
  const layer = LAYERS[layerName];
  if (!layer || layerName === 'G10') return 0;
  if (layer.kind === 'gray') return 0;
  if (layer.shapeSetSize) {
    const count = layer.colors ?? 0;
    if (count <= 8) return count;
    return N < 33 ? 8 : count;
  }
  if (layerName === 'C40') return 16;
  if (layerName === 'C50') return N < 33 ? 16 : 32;
  if (layerName === 'C60') return N < 33 ? 16 : N < 57 ? 32 : 64;
  if (layerName === 'C80') return N < 33 ? 16 : N < 57 ? 64 : 256;
  return 0;
}

export function calibrationSampleIndices(layerName, N, paletteInfo) {
  const count = calibrationSampleCount(layerName, N);
  if (count === 0) return [];
  const palette = paletteInfo?.paletteLab;
  if (!palette || palette.length === 0) return [];
  if (count >= palette.length) return Array.from({ length: palette.length }, (_, i) => i);

  const selected = [];
  const used = new Uint8Array(palette.length);
  const pick = (idx) => {
    selected.push(idx);
    used[idx] = 1;
  };
  pick(0);
  if (palette.length > 1) pick(1);
  while (selected.length < count) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < palette.length; i++) {
      if (used[i]) continue;
      let minD = Infinity;
      for (const s of selected) {
        const d = deltaE76(palette[i], palette[s]);
        if (d < minD) minD = d;
      }
      if (minD > bestD) {
        bestD = minD;
        best = i;
      }
    }
    if (best < 0) break;
    pick(best);
  }
  return selected;
}

function finderCell(r, c) {
  if (r === 0 || r === 6 || c === 0 || c === 6) return BLACK;
  if (r === 3 && c === 3) return BLACK;
  return WHITE;
}

export function makeLayout({
  version,
  layer: layerName,
  paletteMode = 'maxmin',
  harmony = false,
  paletteInfo = null,
}) {
  layerName = resolveLayerName(layerName);
  const layer = LAYERS[layerName];
  if (!layer) throw new Error(`Unknown layer: ${layerName}`);
  const palette = paletteInfo ?? generatePalette(layerName, { mode: paletteMode, harmony });
  const N = versionToSize(version);
  const blackSym = palette.blackIndex;
  const whiteSym = palette.whiteIndex;

  const mask = new Uint8Array(N * N);
  const fixed = new Int16Array(N * N).fill(-1);
  const fixedColor = new Uint8Array(N * N * 3);
  const hasFixedColor = new Uint8Array(N * N);
  const fixedShape = new Int8Array(N * N).fill(-1);
  const hasFixedShape = new Uint8Array(N * N);

  const setSymbol = (r, c, symbol) => {
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    const i = r * N + c;
    mask[i] = 1;
    fixed[i] = symbol;
    hasFixedColor[i] = 0;
    hasFixedShape[i] = 0;
    fixedShape[i] = -1;
  };
  const setColor = (r, c, rgb) => {
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    const i = r * N + c;
    mask[i] = 1;
    fixed[i] = -1;
    hasFixedColor[i] = 1;
    fixedColor[i * 3] = rgb[0];
    fixedColor[i * 3 + 1] = rgb[1];
    fixedColor[i * 3 + 2] = rgb[2];
    hasFixedShape[i] = 0;
    fixedShape[i] = -1;
  };
  const setShape = (r, c, shapeIndex, rgb) => {
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    const i = r * N + c;
    mask[i] = 1;
    fixed[i] = -1;
    hasFixedColor[i] = 1;
    fixedColor[i * 3] = rgb[0];
    fixedColor[i * 3 + 1] = rgb[1];
    fixedColor[i * 3 + 2] = rgb[2];
    hasFixedShape[i] = 1;
    fixedShape[i] = shapeIndex;
  };

  // --- finders + separators -------------------------------------------------
  const finders = [
    { row: 0, col: 0 },
    { row: 0, col: N - 7 },
    { row: N - 7, col: 0 },
  ];
  for (const f of finders) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const rr = f.row === 0 ? r : N - 8 + r;
        const cc = f.col === 0 ? c : N - 8 + c;
        setSymbol(rr, cc, whiteSym);
      }
    }
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        setSymbol(f.row + r, f.col + c, finderCell(r, c) === BLACK ? blackSym : whiteSym);
      }
    }
  }

  // --- timing patterns ------------------------------------------------------
  for (let c = 8; c <= N - 9; c++) setSymbol(6, c, c % 2 === 0 ? blackSym : whiteSym);
  for (let r = 8; r <= N - 9; r++) setSymbol(r, 6, r % 2 === 0 ? blackSym : whiteSym);

  // --- alignment + format band ---------------------------------------------
  const formatBlocks = N < 25 ? 1 : N < 57 ? 2 : 3;
  const formatRowsPerCopy = formatBlocks * 2;
  const formatCols = 8;
  const formatCopies = [];
  let alignment = null;

  if (N >= 25) {
    const base = N - 7;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) setSymbol(base + r, base + c, whiteSym);
    }
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const black = r === 0 || r === 4 || c === 0 || c === 4 || (r === 2 && c === 2);
        setSymbol(base + 1 + r, base + 1 + c, black ? blackSym : whiteSym);
      }
    }
    alignment = { row: base, col: base, size: 7, centerRow: N - 3.5, centerCol: N - 3.5 };

    formatCopies.push({ row0: 8, col0: N - formatCols, rows: formatRowsPerCopy, cols: formatCols });
    formatCopies.push({ row0: N - 8, col0: 8, rows: formatRowsPerCopy, cols: formatCols });
  } else {
    for (let copy = 0; copy < 2; copy++) {
      const row0 = N - (2 - copy) * formatRowsPerCopy;
      formatCopies.push({ row0, col0: N - formatCols, rows: formatRowsPerCopy, cols: formatCols });
    }
  }
  for (const copy of formatCopies) {
    for (let r = 0; r < copy.rows; r++) {
      for (let c = 0; c < copy.cols; c++) setSymbol(copy.row0 + r, copy.col0 + c, whiteSym);
    }
  }

  // --- calibration hub ------------------------------------------------------
  let hub = null;
  const grayBlocks = [];
  const paletteBlocks = [];
  const shapeBlocks = [];
  const endpointBlocks = [];
  if (layerName !== 'G10') {
    const paletteCount = calibrationSampleCount(layerName, N);
    const paletteSide = paletteCount === 0 ? 0 : Math.ceil(Math.sqrt(paletteCount));
    const grayLevels = layer.kind === 'gray' ? layer.levels : 16;
    const graySide = Math.ceil(Math.sqrt(grayLevels));
    const grayColors = layer.kind === 'gray' ? palette.palette : palette.grayPalette;
    const shapeCount = layer.shapeSetSize > 1 ? layer.shapeSetSize : 0;
    const shapeSide = shapeCount === 0 ? 0 : Math.ceil(Math.sqrt(shapeCount));
    const hubW = graySide + paletteSide + shapeSide + 2;
    const hubH = Math.max(graySide, paletteSide, shapeSide) + 2;
    const hubRow = Math.floor((N - hubH) / 2);
    const hubCol = Math.floor((N - hubW) / 2);
    hub = { row: hubRow, col: hubCol, w: hubW, h: hubH };

    for (let r = 0; r < hubH; r++) {
      for (let c = 0; c < hubW; c++) {
        const edge = r === 0 || r === hubH - 1 || c === 0 || c === hubW - 1;
        if (!edge) continue;
        const corner = (r === 0 || r === hubH - 1) && (c === 0 || c === hubW - 1);
        const symbol = corner ? blackSym : whiteSym;
        setSymbol(hubRow + r, hubCol + c, symbol);
        endpointBlocks.push({ row: hubRow + r, col: hubCol + c, symbol });
      }
    }

    // Gray layers show the data's own 4/8 levels; colour layers use a
    // 16-level reference ramp for luminance anchoring.
    for (let i = 0; i < grayLevels; i++) {
      const r = hubRow + 1 + Math.floor(i / graySide);
      const c = hubCol + 1 + (i % graySide);
      const rgb = grayColors[i];
      setColor(r, c, rgb);
      grayBlocks.push({ row: r, col: c, rgb });
    }

    if (paletteSide > 0) {
      const indices = calibrationSampleIndices(layerName, N, palette);
      for (let i = 0; i < indices.length; i++) {
        const r = hubRow + 1 + Math.floor(i / paletteSide);
        const c = hubCol + 1 + graySide + (i % paletteSide);
        const symbol = indices[i];
        setSymbol(r, c, symbol);
        paletteBlocks.push({ row: r, col: c, symbol, rgb: palette.palette[symbol] });
      }
      // Remaining cells in the palette rectangle stay white function modules.
      for (let i = indices.length; i < paletteSide * paletteSide; i++) {
        const r = hubRow + 1 + Math.floor(i / paletteSide);
        const c = hubCol + 1 + graySide + (i % paletteSide);
        setSymbol(r, c, whiteSym);
      }
    }

    // Shape reference tiles: each of the eight patterns in a fixed black
    // background, used to estimate the PSF / line width on the decoder side.
    if (shapeSide > 0) {
      for (let i = 0; i < shapeCount; i++) {
        const r = hubRow + 1 + Math.floor(i / shapeSide);
        const c = hubCol + 1 + graySide + paletteSide + (i % shapeSide);
        setShape(r, c, i, [0, 0, 0]);
        shapeBlocks.push({ row: r, col: c, shape: i, rgb: [0, 0, 0] });
      }
      for (let i = shapeCount; i < shapeSide * shapeSide; i++) {
        const r = hubRow + 1 + Math.floor(i / shapeSide);
        const c = hubCol + 1 + graySide + paletteSide + (i % shapeSide);
        setSymbol(r, c, whiteSym);
      }
    }
  }

  // --- data cells in Hilbert order -----------------------------------------
  const order = hilbertOrder(N);
  const dataCoords = [];
  for (const [r, c] of order) {
    if (mask[r * N + c] === 0) dataCoords.push([r, c]);
  }

  let functionCount = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) functionCount++;

  return {
    version,
    N,
    layer: layerName,
    paletteMode,
    harmony,
    mask,
    fixed,
    fixedColor,
    hasFixedColor,
    fixedShape,
    hasFixedShape,
    dataCoords,
    functionCount,
    dataCount: dataCoords.length,
    format: { blocksPerCopy: formatBlocks, rowsPerCopy: formatRowsPerCopy, cols: formatCols, copies: formatCopies },
    hub,
    alignment,
    grayBlocks,
    paletteBlocks,
    shapeBlocks,
    endpointBlocks,
    finders,
    blackSymbol: blackSym,
    whiteSymbol: whiteSym,
    BLACK,
    WHITE,
  };
}
