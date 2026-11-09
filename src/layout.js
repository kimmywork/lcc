/**
 * LCC symbol layout.
 *
 * The layout is defined entirely in module units.  It is shared by the
 * encoder and decoder, so every function module, calibration block and data
 * position is reproducible from (version, layer, palette mode).
 *
 * v1 function patterns:
 *   - three 7x7 custom finders with a 1:2:1:2:1 profile
 *   - a 1-module separator around each finder
 *   - row/column timing patterns
 *   - a scalable bottom-right format band (1/2/3 BCH blocks per copy)
 *   - a central calibration hub (gray ramp + endpoints + palette samples)
 *
 * Data modules use a Hilbert curve order filtered to the data cells.
 */

import { LAYERS, versionToSize } from './constants.js';

export const BLACK = 0;
export const WHITE = 15;

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Hilbert d -> (x,y) for a power-of-two grid. */
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
  if (layerName === 'L1' || layerName === 'L2') return 0;
  if (layerName === 'L3a') return N < 33 ? 16 : 64;
  if (layerName === 'L3b') return N < 33 ? 16 : N < 57 ? 64 : 256;
  throw new Error(`Unknown layer: ${layerName}`);
}

export function calibrationSampleIndices(layerName, N) {
  const layer = LAYERS[layerName];
  const count = calibrationSampleCount(layerName, N);
  if (count === 0) return [];
  if (count >= layer.paletteSize) {
    return Array.from({ length: layer.paletteSize }, (_, i) => i);
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < 16; i++) {
    out.push(i);
    seen.add(i);
  }
  const remaining = count - 16;
  if (remaining > 0) {
    for (let i = 0; i < remaining; i++) {
      const idx = 16 + Math.round((i * (layer.paletteSize - 17)) / Math.max(1, remaining - 1));
      if (!seen.has(idx)) {
        out.push(idx);
        seen.add(idx);
      }
    }
  }
  // If rounding produced duplicates, fill deterministically.
  let k = 16;
  while (out.length < count) {
    if (!seen.has(k)) {
      out.push(k);
      seen.add(k);
    }
    k++;
  }
  return out.slice(0, count);
}

function finderCell(r, c) {
  if (r === 0 || r === 6 || c === 0 || c === 6) return BLACK;
  if (r === 3 && c === 3) return BLACK;
  return WHITE;
}

export function makeLayout({ version, layer: layerName, paletteMode = 'bucketed' }) {
  const layer = LAYERS[layerName];
  if (!layer) throw new Error(`Unknown layer: ${layerName}`);
  const N = versionToSize(version);
  const blackSym = 0;
  const whiteSym = layerName === 'L1' ? 1 : 15;
  const mask = new Uint8Array(N * N);
  const fixed = new Int16Array(N * N).fill(-1);
  const set = (r, c, symbol) => {
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    const i = r * N + c;
    mask[i] = 1;
    fixed[i] = symbol;
  };

  // --- finders + separators -------------------------------------------------
  const finders = [
    { row: 0, col: 0 },
    { row: 0, col: N - 7 },
    { row: N - 7, col: 0 },
  ];
  for (const f of finders) {
    // separator (8x8) is white
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const rr = f.row === 0 ? r : N - 8 + r;
        const cc = f.col === 0 ? c : N - 8 + c;
        set(rr, cc, whiteSym);
      }
    }
    // 7x7 finder
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        set(f.row + r, f.col + c, finderCell(r, c) === BLACK ? blackSym : whiteSym);
      }
    }
  }

  // --- timing patterns ------------------------------------------------------
  for (let c = 8; c <= N - 9; c++) set(6, c, c % 2 === 0 ? blackSym : whiteSym);
  for (let r = 8; r <= N - 9; r++) set(r, 6, r % 2 === 0 ? blackSym : whiteSym);

  // --- alignment + format band ---------------------------------------------
  const formatBlocks = N < 33 ? 1 : N < 57 ? 2 : 3;
  const formatRowsPerCopy = formatBlocks * 2;
  const formatCols = 8;
  const formatCopies = [];
  let alignment = null;

  if (N >= 33) {
    // 5x5 alignment ring at the bottom-right corner, with a 1-module white
    // border.  Its centre is the fourth homography point for camera photos.
    const base = N - 7;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) set(base + r, base + c, whiteSym);
    }
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const black = r === 0 || r === 4 || c === 0 || c === 4 || (r === 2 && c === 2);
        set(base + 1 + r, base + 1 + c, black ? blackSym : whiteSym);
      }
    }
    alignment = { row: base, col: base, size: 7, centerRow: N - 3.5, centerCol: N - 3.5 };

    // Format copies near the top-right and bottom-left finders.
    formatCopies.push({ row0: 8, col0: N - formatCols, rows: formatRowsPerCopy, cols: formatCols });
    formatCopies.push({ row0: N - 8, col0: 8, rows: formatRowsPerCopy, cols: formatCols });
  } else {
    // Small versions keep two stacked copies at the bottom-right.
    for (let copy = 0; copy < 2; copy++) {
      const row0 = N - (2 - copy) * formatRowsPerCopy;
      formatCopies.push({ row0, col0: N - formatCols, rows: formatRowsPerCopy, cols: formatCols });
    }
  }

  for (const copy of formatCopies) {
    for (let r = 0; r < copy.rows; r++) {
      for (let c = 0; c < copy.cols; c++) set(copy.row0 + r, copy.col0 + c, whiteSym);
    }
  }

  // --- calibration hub ------------------------------------------------------
  let hub = null;
  const grayBlocks = [];
  const paletteBlocks = [];
  const endpointBlocks = [];
  if (layerName !== 'L1') {
    const paletteCount = calibrationSampleCount(layerName, N);
    const paletteSide = paletteCount === 0 ? 0 : Math.round(Math.sqrt(paletteCount));
    const graySide = 4;
    const hubW = graySide + paletteSide + 2;
    const hubH = Math.max(graySide, paletteSide) + 2;
    const hubRow = Math.floor((N - hubH) / 2);
    const hubCol = Math.floor((N - hubW) / 2);
    hub = { row: hubRow, col: hubCol, w: hubW, h: hubH };

    // Border endpoints: corners black, other border cells white.
    for (let r = 0; r < hubH; r++) {
      for (let c = 0; c < hubW; c++) {
        const edge = r === 0 || r === hubH - 1 || c === 0 || c === hubW - 1;
        if (!edge) continue;
        const corner = (r === 0 || r === hubH - 1) && (c === 0 || c === hubW - 1);
        const symbol = corner ? blackSym : whiteSym;
        set(hubRow + r, hubCol + c, symbol);
        endpointBlocks.push({ row: hubRow + r, col: hubCol + c, symbol });
      }
    }

    // Gray ramp: 4x4, indices 0..15.
    for (let i = 0; i < 16; i++) {
      const r = hubRow + 1 + Math.floor(i / graySide);
      const c = hubCol + 1 + (i % graySide);
      set(r, c, i);
      grayBlocks.push({ row: r, col: c, symbol: i });
    }

    // Palette samples.
    if (paletteSide > 0) {
      const indices = calibrationSampleIndices(layerName, N);
      for (let i = 0; i < indices.length; i++) {
        const r = hubRow + 1 + Math.floor(i / paletteSide);
        const c = hubCol + 1 + graySide + (i % paletteSide);
        set(r, c, indices[i]);
        paletteBlocks.push({ row: r, col: c, symbol: indices[i] });
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
    mask,
    fixed,
    dataCoords,
    functionCount,
    dataCount: dataCoords.length,
    format: { blocksPerCopy: formatBlocks, rowsPerCopy: formatRowsPerCopy, cols: formatCols, copies: formatCopies },
    hub,
    alignment,
    grayBlocks,
    paletteBlocks,
    endpointBlocks,
    finders,
    blackSymbol: blackSym,
    whiteSymbol: whiteSym,
    BLACK,
    WHITE,
  };
}
