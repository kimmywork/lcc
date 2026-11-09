/**
 * LCC decoder for clean / axis-aligned images.
 *
 * Phase A scope: deterministic round-trip from the encoder's own PNG output.
 * The detector uses the custom 1:2:1:2:1 finder profile to recover the module
 * size, symbol origin and version.  Camera perspective, multi-frame and
 * calibration are Phase B.
 */

import { BitWriter } from './bitstream.js';
import { ECC_LEVELS, LAYERS, LAYER_BY_ID, versionToSize, sizeToVersion } from './constants.js';
import { luminance, nearestIndex, rgbToLab } from './color.js';
import { RankConstraint } from './constraint.js';
import { rsDecodeBlocks } from './ecc/rs.js';
import { parseFrame } from './frame.js';
import { readFormatBand } from './format/format-band.js';
import { BLACK, WHITE, makeLayout } from './layout.js';
import { generatePalette } from './palettes.js';
import { makeWhitening } from './whitening.js';

function grayscale(image) {
  const { width, height, data } = image;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 3) {
    gray[i] = Math.round(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
  }
  return gray;
}

function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

// Expected 7x7 finder pattern: 0 = black, 1 = white.
const FINDER_PATTERN = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 0, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 0],
];

function finderScore(gray, width, height, center, threshold) {
  let matches = 0;
  let total = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const x = Math.round(center.x + (c - 3) * center.unit);
      const y = Math.round(center.y + (r - 3) * center.unit);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const bit = gray[y * width + x] < threshold ? 0 : 1;
      if (bit === FINDER_PATTERN[r][c]) matches++;
      total++;
    }
  }
  return total === 0 ? 0 : matches / total;
}

function finderCandidates(gray, width, height, threshold, horizontal) {
  const candidates = [];
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  for (let a = 0; a < outer; a++) {
    const runs = [];
    let start = 0;
    let color = horizontal ? (gray[a * width] < threshold ? 0 : 1) : (gray[a] < threshold ? 0 : 1);
    for (let b = 1; b < inner; b++) {
      const v = horizontal ? gray[a * width + b] : gray[b * width + a];
      const c = v < threshold ? 0 : 1;
      if (c !== color) {
        runs.push({ color, start, length: b - start });
        start = b;
        color = c;
      }
    }
    runs.push({ color, start, length: inner - start });
    for (let i = 0; i + 4 < runs.length; i++) {
      if (runs[i].color !== 0 || runs[i + 1].color !== 1 || runs[i + 2].color !== 0 ||
          runs[i + 3].color !== 1 || runs[i + 4].color !== 0) continue;
      const lens = [runs[i].length, runs[i + 1].length, runs[i + 2].length,
        runs[i + 3].length, runs[i + 4].length];
      const total = lens.reduce((s, x) => s + x, 0);
      const unit = total / 7;
      if (unit < 1) continue;
      const tol = Math.max(1, unit * 0.65);
      if (Math.abs(lens[0] - unit) > tol ||
          Math.abs(lens[1] - 2 * unit) > tol ||
          Math.abs(lens[2] - unit) > tol ||
          Math.abs(lens[3] - 2 * unit) > tol ||
          Math.abs(lens[4] - unit) > tol) continue;
      const center = runs[i].start + 3.5 * unit;
      candidates.push(horizontal
        ? { x: center, y: a, unit }
        : { x: a, y: center, unit });
    }
  }
  return candidates;
}

export function detectSymbol(image) {
  const { width, height } = image;
  const gray = grayscale(image);
  let mn = 255;
  let mx = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < mn) mn = gray[i];
    if (gray[i] > mx) mx = gray[i];
  }
  if (mn === mx) throw new Error('LCC detect: image has no contrast');
  let threshold = otsuThreshold(gray);
  // With a two-valued image Otsu can return the minimum; force a mid-gap
  // threshold in that case.
  if (threshold <= mn || threshold >= mx) threshold = Math.floor((mn + mx) / 2);
  const rowC = finderCandidates(gray, width, height, threshold, true);
  const colC = finderCandidates(gray, width, height, threshold, false);
  const centers = [];
  for (const r of rowC) {
    let best = null;
    let bestD = Infinity;
    for (const c of colC) {
      const tol = Math.max(2, 2.5 * Math.max(r.unit, c.unit));
      const d = Math.hypot(r.x - c.x, r.y - c.y);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      centers.push({ x: (r.x + best.x) / 2, y: (r.y + best.y) / 2, unit: (r.unit + best.unit) / 2 });
    }
  }
  if (centers.length < 3) throw new Error('LCC detect: not enough finder candidates');

  const filtered = centers.filter((c) => finderScore(gray, width, height, c, threshold) >= 0.8);
  const usable = filtered.length >= 3 ? filtered : centers;

  const clusters = [];
  for (const c of usable) {
    let found = null;
    for (const cl of clusters) {
      if (Math.hypot(c.x - cl.x, c.y - cl.y) < 2 * Math.max(c.unit, cl.unit)) {
        found = cl;
        break;
      }
    }
    if (found) {
      found.x = (found.x * found.n + c.x) / (found.n + 1);
      found.y = (found.y * found.n + c.y) / (found.n + 1);
      found.unit = (found.unit * found.n + c.unit) / (found.n + 1);
      found.n++;
    } else {
      clusters.push({ ...c, n: 1 });
    }
  }
  if (clusters.length < 3) throw new Error('LCC detect: not enough finder clusters');

  // Pick TL / TR / BL by geometry.
  const bySum = [...clusters].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = bySum[0];
  let tr = null;
  let bl = null;
  let bestTR = -Infinity;
  let bestBL = -Infinity;
  for (const c of clusters) {
    if (c === tl) continue;
    if (c.x - c.y > bestTR) {
      bestTR = c.x - c.y;
      tr = c;
    }
    if (c.y - c.x > bestBL) {
      bestBL = c.y - c.x;
      bl = c;
    }
  }
  if (!tr || !bl || tr === bl) throw new Error('LCC detect: could not identify three finders');
  if (tr.x <= tl.x || bl.y <= tl.y) throw new Error('LCC detect: finder orientation is invalid');

  const s = (tl.unit + tr.unit + bl.unit) / 3;
  const n1 = Math.round((tr.x - tl.x) / s) + 7;
  const n2 = Math.round((bl.y - tl.y) / s) + 7;
  if (Math.abs(n1 - n2) > 1) throw new Error('LCC detect: inconsistent version estimate');
  let N = Math.round((n1 + n2) / 2);
  let version = Math.round((N - 21) / 4) + 1;
  version = Math.max(1, Math.min(100, version));
  N = versionToSize(version);

  const originX = tl.x - 3.5 * s;
  const originY = tl.y - 3.5 * s;
  return { originX, originY, s, N, version, threshold, finders: { tl, tr, bl } };
}

export function sampleModule(image, originX, originY, s, row, col) {
  const { width, height, data } = image;
  const cx = Math.floor(originX + (col + 0.5) * s);
  const cy = Math.floor(originY + (row + 0.5) * s);
  const radius = Math.max(0, Math.floor(s / 4) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || x >= width) continue;
      const p = (y * width + x) * 3;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      n++;
    }
  }
  if (n === 0) return [255, 255, 255];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function decodeText(payload) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}

export function decode(image, options = {}) {
  const det = options.moduleSize && options.version && options.origin
    ? {
      originX: options.origin.x,
      originY: options.origin.y,
      s: options.moduleSize,
      version: options.version,
      N: versionToSize(options.version),
      threshold: options.threshold ?? 128,
    }
    : detectSymbol(image);

  const version = options.version ?? det.version ?? sizeToVersion(det.N);
  const layoutProbe = makeLayout({ version, layer: 'L1', paletteMode: 'bucketed' });
  const getFormatSymbol = (r, c) => {
    const rgb = sampleModule(image, det.originX, det.originY, det.s, r, c);
    return luminance(rgb) < det.threshold ? BLACK : WHITE;
  };
  const fmt = readFormatBand(getFormatSymbol, layoutProbe);

  const layerName = options.layer ?? LAYER_BY_ID.get(fmt.layerId)?.name;
  if (!layerName) throw new Error(`LCC decode: unknown layer id ${fmt.layerId}`);
  const paletteMode = options.paletteMode ?? fmt.paletteMode;
  const harmony = options.harmony ?? fmt.harmony;
  const constraint = options.constraint ?? fmt.constraint;
  const seed = options.seed ?? fmt.seed;

  const paletteInfo = generatePalette(layerName, { mode: paletteMode, harmony });
  const layout = makeLayout({ version, layer: layerName, paletteMode });

  const symbols = new Array(layout.dataCount);
  for (let i = 0; i < layout.dataCoords.length; i++) {
    const [r, c] = layout.dataCoords[i];
    const rgb = sampleModule(image, det.originX, det.originY, det.s, r, c);
    symbols[i] = nearestIndex(rgbToLab(rgb), paletteInfo.paletteLab);
  }

  let writer;
  let capacityBits;
  if (layerName === 'L1') {
    writer = new BitWriter();
    for (const s of symbols) writer.writeBit(s & 1);
    capacityBits = layout.dataCount;
  } else if (constraint) {
    const rc = new RankConstraint(paletteInfo);
    writer = rc.decode(symbols);
    capacityBits = rc.capacityBitsForModules(layout.dataCount);
  } else {
    const bitsPerModule = LAYERS[layerName].bitsPerModule;
    writer = new BitWriter();
    for (const s of symbols) writer.writeBits(s, bitsPerModule);
    capacityBits = layout.dataCount * bitsPerModule;
  }

  const S = Math.floor(capacityBits / 8);
  if (S <= 0) throw new Error('LCC decode: no RS symbols');
  const bitBytes = writer.toBytes();
  const rsReceived = bitBytes.slice(0, S);
  const ecc = ECC_LEVELS[fmt.eccIndex] ?? LAYERS[layerName].ecc;
  const rs = rsDecodeBlocks(rsReceived, ecc);
  const frameBytes = makeWhitening(seed)(rs.data);
  const frame = parseFrame(frameBytes);

  return {
    payload: frame.payload,
    text: decodeText(frame.payload),
    meta: {
      layer: layerName,
      version,
      N: layout.N,
      moduleSize: det.s,
      paletteMode,
      harmony,
      constraint,
      seed,
      ecc,
      dataCount: layout.dataCount,
      capacityBits,
      rsSymbols: S,
      correctedSymbols: rs.corrected,
      flags: frame.flags,
    },
    detection: det,
  };
}

