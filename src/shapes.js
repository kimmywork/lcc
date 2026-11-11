/**
 * Shape dimension for LCC.
 *
 * A data module can carry a background colour plus one of eight foreground
 * patterns:
 *
 *   blank  /  \  X  +  -  |  square
 *
 * The pattern is rendered in a high-contrast foreground colour.  The default
 * foreground is the complement of the background, but black/white is used
 * when the complement is too close to the background (notably mid-grey).
 *
 * The decoder reads the background from the module border, where strokes are
 * inset, and matches the luminance residual against the eight known templates.
 * Clustering is kept for callers that already have a binary mask.
 */

import { deltaE76, luminance, rgbToLab } from './color.js';

export const SHAPE_NAMES = [
  'blank', '/', '\\', 'X', '+', '-', '|', 'square',
  'left-v', 'right-v', 'down-v', 'up-v',
  'left-arrow', 'up-arrow', 'right-arrow', 'down-arrow',
  'nw-arrow', 'ne-arrow', 'se-arrow', 'sw-arrow',
  'tl-block', 'tr-block', 'bl-block', 'br-block',
  't-down', 't-right', 't-left', 't-up',
  'diag-t1', 'diag-t2', 'diag-t3', 'diag-t4',
];

/** Compact labels for UI / SVG titles. */
export const SHAPE_LABELS = [
  'blank', '/', '\\', 'X', '+', '-', '|', '□',
  '<', '>', 'V', '^',
  '←', '↑', '→', '↓',
  '↖', '↗', '↘', '↙',
  '▘', '▝', '▖', '▗',
  '┬', '├', '┤', '┴',
  'dT1', 'dT2', 'dT3', 'dT4',
];

/** The classic eight-shape set is still the default for camera layers. */
export const SHAPE_COUNT = SHAPE_NAMES.length;
export const LEGACY_SHAPE_COUNT = 8;

const maskCache = new Map();

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function complementRgb(rgb) {
  return [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
}

/**
 * Pick the highest-contrast foreground for a background colour.
 *
 * Candidates are the exact complement, black, and white.  For saturated
 * colours the complement usually wins; for mid-grey it loses and black/white
 * is selected, so the pattern never disappears.
 */
export function foregroundFor(rgb) {
  const lab = rgbToLab(rgb);
  const candidates = [complementRgb(rgb), [0, 0, 0], [255, 255, 255]];
  let best = candidates[0];
  let bestD = -1;
  for (const candidate of candidates) {
    const d = deltaE76(lab, rgbToLab(candidate));
    if (d > bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

export function shapeLineWidth(size) {
  return Math.max(1, Math.round(size / 8));
}

export function shapeInset(size) {
  return Math.max(1, Math.round(size / 16));
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return Math.hypot(px - x, py - y);
}

/**
 * Geometry in module pixels.  `fills` are filled rectangles; `segments` are
 * stroked lines.  The same function is used at size=1 for normalized SVG
 * output, so pixel and vector rendering stay in sync.
 */
function shapeGeometry(shapeIndex, size, inset) {
  const lo = inset;
  const hi = size - inset;
  const mid = size / 2;
  const squareInset = Math.max(inset, size >= 4 ? Math.round(size / 4) : size / 4);
  const slo = squareInset;
  const shi = size - squareInset;
  const head = Math.max(inset * 2, size / 6);
  const gap = Math.max(inset, size * 0.08);
  const segments = [];
  const fills = [];
  const add = (x1, y1, x2, y2) => segments.push([x1, y1, x2, y2]);

  switch (shapeIndex) {
    case 1: // /
      add(lo, hi, hi, lo);
      break;
    case 2: // backslash
      add(lo, lo, hi, hi);
      break;
    case 3: // X
      add(lo, hi, hi, lo);
      add(lo, lo, hi, hi);
      break;
    case 4: // +
      add(lo, mid, hi, mid);
      add(mid, lo, mid, hi);
      break;
    case 5: // -
      add(lo, mid, hi, mid);
      break;
    case 6: // |
      add(mid, lo, mid, hi);
      break;
    case 7: // square
      add(slo, slo, shi, slo);
      add(shi, slo, shi, shi);
      add(shi, shi, slo, shi);
      add(slo, shi, slo, slo);
      break;

    // Four chevrons built from a side midpoint to the opposite corners.
    case 8: // <
      add(lo, mid, hi, lo);
      add(lo, mid, hi, hi);
      break;
    case 9: // >
      add(hi, mid, lo, lo);
      add(hi, mid, lo, hi);
      break;
    case 10: // V
      add(mid, hi, lo, lo);
      add(mid, hi, hi, lo);
      break;
    case 11: // ^
      add(mid, lo, lo, hi);
      add(mid, lo, hi, hi);
      break;

    // Midline arrows: half shaft plus a short V head.
    case 12: // left
      add(mid, mid, lo, mid);
      add(lo, mid, lo + head, mid - head);
      add(lo, mid, lo + head, mid + head);
      break;
    case 13: // up
      add(mid, mid, mid, lo);
      add(mid, lo, mid - head, lo + head);
      add(mid, lo, mid + head, lo + head);
      break;
    case 14: // right
      add(mid, mid, hi, mid);
      add(hi, mid, hi - head, mid - head);
      add(hi, mid, hi - head, mid + head);
      break;
    case 15: // down
      add(mid, mid, mid, hi);
      add(mid, hi, mid - head, hi - head);
      add(mid, hi, mid + head, hi - head);
      break;

    // Diagonal arrows.
    case 16: // nw
      add(mid, mid, lo, lo);
      add(lo, lo, lo + head, lo);
      add(lo, lo, lo, lo + head);
      break;
    case 17: // ne
      add(mid, mid, hi, lo);
      add(hi, lo, hi - head, lo);
      add(hi, lo, hi, lo + head);
      break;
    case 18: // se
      add(mid, mid, hi, hi);
      add(hi, hi, hi - head, hi);
      add(hi, hi, hi, hi - head);
      break;
    case 19: // sw
      add(mid, mid, lo, hi);
      add(lo, hi, lo + head, hi);
      add(lo, hi, lo, hi - head);
      break;

    // One filled quarter block.
    case 20: fills.push([lo, lo, mid - gap, mid - gap]); break;
    case 21: fills.push([mid + gap, lo, hi, mid - gap]); break;
    case 22: fills.push([lo, mid + gap, mid - gap, hi]); break;
    case 23: fills.push([mid + gap, mid + gap, hi, hi]); break;

    // T junctions: one full midline plus one half midline.
    case 24: // T down
      add(lo, mid, hi, mid);
      add(mid, mid, mid, hi);
      break;
    case 25: // T right
      add(mid, lo, mid, hi);
      add(mid, mid, hi, mid);
      break;
    case 26: // T left
      add(mid, lo, mid, hi);
      add(lo, mid, mid, mid);
      break;
    case 27: // T up
      add(lo, mid, hi, mid);
      add(mid, lo, mid, mid);
      break;

    // Diagonal T: one full diagonal plus half of the other diagonal.
    case 28:
      add(lo, hi, hi, lo);
      add(mid, mid, lo, lo);
      break;
    case 29:
      add(lo, hi, hi, lo);
      add(mid, mid, hi, hi);
      break;
    case 30:
      add(lo, lo, hi, hi);
      add(mid, mid, hi, lo);
      break;
    case 31:
      add(lo, lo, hi, hi);
      add(mid, mid, lo, hi);
      break;
    default:
      break;
  }
  return { segments, fills };
}

function shapeSegmentsPx(shapeIndex, size, inset) {
  return shapeGeometry(shapeIndex, size, inset).segments;
}

/** Binary foreground mask for one shape at a square pixel resolution. */
export function shapeMask(shapeIndex, size, lineWidth = shapeLineWidth(size), inset = shapeInset(size)) {
  const key = `${shapeIndex}|${size}|${lineWidth}|${inset}`;
  const cached = maskCache.get(key);
  if (cached) return cached;

  const mask = new Uint8Array(size * size);
  const { segments, fills } = shapeGeometry(shapeIndex, size, inset);
  if (segments.length === 0 && fills.length === 0) {
    maskCache.set(key, mask);
    return mask;
  }
  const half = Math.max(0.5, lineWidth / 2);
  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      let on = false;
      for (const [x0, y0, x1, y1] of fills) {
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
          on = true;
          break;
        }
      }
      if (!on) {
        for (const [x1, y1, x2, y2] of segments) {
          if (distanceToSegment(px, py, x1, y1, x2, y2) <= half) {
            on = true;
            break;
          }
        }
      }
      if (on) mask[y * size + x] = 1;
    }
  }
  maskCache.set(key, mask);
  return mask;
}

/** Mask used by the decoder's template matcher. */
export function shapeMaskGrid(shapeIndex, gridN, lineWidth = shapeLineWidth(gridN), inset = shapeInset(gridN)) {
  return shapeMask(shapeIndex, gridN, lineWidth, inset);
}

function hammingShifted(mask, template, n, dx, dy) {
  let d = 0;
  for (let y = 0; y < n; y++) {
    const ty = y + dy;
    for (let x = 0; x < n; x++) {
      const tx = x + dx;
      const t = tx >= 0 && tx < n && ty >= 0 && ty < n
        ? template[ty * n + tx]
        : 0;
      if (mask[y * n + x] !== t) d++;
    }
  }
  return d;
}

export function classifyShape(mask, gridN, options = {}) {
  const coverage = mask.reduce((sum, v) => sum + v, 0) / (gridN * gridN);
  const lineWidth = options.lineWidth ?? shapeLineWidth(gridN);
  const inset = options.inset ?? shapeInset(gridN);
  const maxShift = options.maxShift ?? 1;
  const shapeCount = options.shapeCount ?? LEGACY_SHAPE_COUNT;
  const costs = new Array(shapeCount);
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i < shapeCount; i++) {
    const template = shapeMaskGrid(i, gridN, lineWidth, inset);
    let d = Infinity;
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      for (let dx = -maxShift; dx <= maxShift; dx++) {
        const candidate = hammingShifted(mask, template, gridN, dx, dy);
        if (candidate < d) d = candidate;
      }
    }
    costs[i] = d;
    if (d < bestCost) {
      bestCost = d;
      best = i;
    }
  }
  // A near-empty mask is blank; this prevents sensor noise from being
  // interpreted as a thin line.
  if (coverage < 0.02) best = 0;
  return { shape: best, costs, coverage, lineWidth, inset };
}

function meanRgb(samples, indices) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of indices) {
    r += samples[i][0];
    g += samples[i][1];
    b += samples[i][2];
  }
  const n = indices.length || 1;
  return [clampByte(r / n), clampByte(g / n), clampByte(b / n)];
}

function medianRgb(samples, indices) {
  if (indices.length === 0) return [255, 255, 255];
  const channels = [[], [], []];
  for (const i of indices) {
    channels[0].push(samples[i][0]);
    channels[1].push(samples[i][1]);
    channels[2].push(samples[i][2]);
  }
  return channels.map((values) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
}

/**
 * Split a module's sampled colours into background (majority) and foreground
 * (minority) clusters.
 */
function dilateMask(mask, n, radius = 1) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!mask[y * n + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < n && xx >= 0 && xx < n) out[yy * n + xx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * Re-estimate the background after the shape is known.  Blur pulls foreground
 * pixels into the background cluster, especially for the square outline; a
 * dilated shape mask removes that contaminated ring before taking the median.
 */
export function refineBackground(grid, shapeIndex, gridN, lineWidth = shapeLineWidth(gridN), inset = shapeInset(gridN)) {
  const all = grid.map((_, i) => i);
  if (shapeIndex <= 0) return medianRgb(grid, all);
  const template = shapeMaskGrid(shapeIndex, gridN, lineWidth, inset);
  const dilated = dilateMask(template, gridN, 1);
  const indices = [];
  for (let i = 0; i < dilated.length; i++) {
    if (!dilated[i]) indices.push(i);
  }
  if (indices.length < grid.length * 0.15) return medianRgb(grid, all);
  return medianRgb(grid, indices);
}

function backgroundFromMajority(samples) {
  const levels = samples.map((rgb) => luminance(rgb));
  const bins = new Uint16Array(32);
  for (const value of levels) bins[Math.min(31, value / 8 | 0)]++;
  let mode = 0;
  for (let i = 1; i < bins.length; i++) {
    if (bins[i] > bins[mode]) mode = i;
  }
  const center = mode * 8 + 4;
  const indices = [];
  for (let i = 0; i < levels.length; i++) {
    if (Math.abs(levels[i] - center) <= 14) indices.push(i);
  }
  if (indices.length < samples.length * 0.25) {
    return medianRgb(samples, samples.map((_, i) => i));
  }
  return medianRgb(samples, indices);
}

function shiftedMaskValue(mask, gridN, x, y, dx, dy) {
  const tx = x + dx;
  const ty = y + dy;
  if (tx < 0 || ty < 0 || tx >= gridN || ty >= gridN) return 0;
  return mask[ty * gridN + tx];
}

function normalizedCorrelation(residual, mask, gridN, dx, dy) {
  const n = gridN * gridN;
  let sumR = 0;
  let sumM = 0;
  for (let y = 0; y < gridN; y++) {
    for (let x = 0; x < gridN; x++) {
      sumR += residual[y * gridN + x];
      sumM += shiftedMaskValue(mask, gridN, x, y, dx, dy);
    }
  }
  const meanR = sumR / n;
  const meanM = sumM / n;
  let num = 0;
  let denR = 0;
  let denM = 0;
  for (let y = 0; y < gridN; y++) {
    for (let x = 0; x < gridN; x++) {
      const ar = residual[y * gridN + x] - meanR;
      const am = shiftedMaskValue(mask, gridN, x, y, dx, dy) - meanM;
      num += ar * am;
      denR += ar * ar;
      denM += am * am;
    }
  }
  if (denR < 1e-6 || denM < 1e-6) return 0;
  return Math.abs(num) / Math.sqrt(denR * denM);
}

function sharpenResidual(residual, gridN) {
  const blurred = new Float64Array(residual.length);
  for (let y = 0; y < gridN; y++) {
    for (let x = 0; x < gridN; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= gridN) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gridN) continue;
          sum += residual[yy * gridN + xx];
          count++;
        }
      }
      blurred[y * gridN + x] = sum / count;
    }
  }
  const out = new Float64Array(residual.length);
  for (let i = 0; i < residual.length; i++) {
    out[i] = residual[i] + 0.8 * (residual[i] - blurred[i]);
  }
  return out;
}

/**
 * Match one module against the eight known stroke templates.
 * Background is the majority luminance, so a stroke touching the border does
 * not move the colour.  The score is the absolute
 * normalised correlation of the luminance residual, so a light stroke on a
 * dark ground and a dark stroke on a light ground both match.  A weak best
 * score is blank.
 */
export function matchShape(samples, gridN, options = {}) {
  const lineWidth = options.lineWidth ?? shapeLineWidth(gridN);
  const inset = options.inset ?? shapeInset(gridN);
  const maxShift = options.maxShift ?? 1;
  const blankThreshold = options.blankThreshold ?? 0.32;
  const shapeCount = options.shapeCount ?? LEGACY_SHAPE_COUNT;
  const background = backgroundFromMajority(samples);
  const bgL = luminance(background);
  let residual = Float64Array.from(samples, (rgb) => luminance(rgb) - bgL);
  if (options.sharpen) residual = sharpenResidual(residual, gridN);

  const costs = new Array(shapeCount).fill(0);
  let shape = 0;
  let best = 0;
  for (let i = 1; i < shapeCount; i++) {
    const template = shapeMaskGrid(i, gridN, lineWidth, inset);
    let score = 0;
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      for (let dx = -maxShift; dx <= maxShift; dx++) {
        const candidate = normalizedCorrelation(residual, template, gridN, dx, dy);
        if (candidate > score) score = candidate;
      }
    }
    costs[i] = score;
    if (score > best) {
      best = score;
      shape = i;
    }
  }
  if (best < blankThreshold) shape = 0;
  return { shape, costs, score: best, background, lineWidth, inset };
}

export function clusterModule(grid) {
  const n = grid.length;
  const labs = grid.map(rgbToLab);
  let mean = [0, 0, 0];
  for (const lab of labs) {
    mean[0] += lab[0];
    mean[1] += lab[1];
    mean[2] += lab[2];
  }
  mean = mean.map((v) => v / n);

  let c1 = labs[0];
  let d1 = -1;
  for (const lab of labs) {
    const d = deltaE76(lab, mean);
    if (d > d1) {
      d1 = d;
      c1 = lab;
    }
  }
  let c2 = labs[0];
  let d2 = -1;
  for (const lab of labs) {
    const d = deltaE76(lab, c1);
    if (d > d2) {
      d2 = d;
      c2 = lab;
    }
  }

  if (d2 < 8) {
    return {
      background: meanRgb(grid, grid.map((_, i) => i)),
      foregroundMask: new Uint8Array(n),
      foregroundFraction: 0,
      separation: d2,
    };
  }

  const assign = new Uint8Array(n);
  let centers = [c1, c2];
  for (let iter = 0; iter < 6; iter++) {
    let n0 = 0;
    let n1 = 0;
    const sum0 = [0, 0, 0];
    const sum1 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const lab = labs[i];
      const d0 = deltaE76(lab, centers[0]);
      const d1 = deltaE76(lab, centers[1]);
      if (d0 <= d1) {
        assign[i] = 0;
        n0++;
        sum0[0] += lab[0];
        sum0[1] += lab[1];
        sum0[2] += lab[2];
      } else {
        assign[i] = 1;
        n1++;
        sum1[0] += lab[0];
        sum1[1] += lab[1];
        sum1[2] += lab[2];
      }
    }
    if (n0 === 0 || n1 === 0) break;
    centers = [
      [sum0[0] / n0, sum0[1] / n0, sum0[2] / n0],
      [sum1[0] / n1, sum1[1] / n1, sum1[2] / n1],
    ];
  }

  let n0 = 0;
  let n1 = 0;
  for (const a of assign) {
    if (a === 0) n0++;
    else n1++;
  }
  if (n0 === 0 || n1 === 0) {
    return {
      background: meanRgb(grid, grid.map((_, i) => i)),
      foregroundMask: new Uint8Array(n),
      foregroundFraction: 0,
      separation: 0,
    };
  }

  const bgCluster = n0 >= n1 ? 0 : 1;
  const bgIndices = [];
  const fgIndices = [];
  for (let i = 0; i < n; i++) {
    if (assign[i] === bgCluster) bgIndices.push(i);
    else fgIndices.push(i);
  }
  const foregroundMask = new Uint8Array(n);
  for (const i of fgIndices) foregroundMask[i] = 1;
  const separation = deltaE76(centers[0], centers[1]);
  const foregroundFraction = fgIndices.length / n;
  if (foregroundFraction < 0.02 || separation < 12) {
    return {
      background: meanRgb(grid, grid.map((_, i) => i)),
      foregroundMask: new Uint8Array(n),
      foregroundFraction: 0,
      separation,
    };
  }
  return {
    background: medianRgb(grid, bgIndices),
    foregroundMask,
    foregroundFraction,
    separation,
  };
}

/** Geometry in normalized module coordinates, for SVG output. */
export function shapeSegmentsNormalized(shapeIndex, inset = 1 / 16) {
  return shapeGeometry(shapeIndex, 1, inset).segments;
}

/** Filled rectangles in normalized module coordinates, for SVG output. */
export function shapeFillsNormalized(shapeIndex, inset = 1 / 16) {
  return shapeGeometry(shapeIndex, 1, inset).fills;
}
