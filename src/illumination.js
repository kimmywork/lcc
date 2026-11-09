/**
 * Local illumination model built from the fixed finder/alignment patterns.
 *
 * QR decoders use the known finder patterns as black/white references.  LCC
 * has three 7x7 finders and (for N>=25) a 5x5 alignment pattern at the fourth
 * corner.  We sample their black and white modules, fit a bilinear black/white
 * level model over the symbol, and normalise each data module before colour
 * classification.  This removes screen reflections and low-frequency lighting
 * gradients that a single global palette calibration cannot handle.
 */

import { clamp } from './color.js';
import { sampleImage } from './image-utils.js';

function solveReal(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const pv = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

function fitModel(points, key) {
  const n = points.length;
  if (n >= 4) {
    // Bilinear: value = a + b*row + c*col + d*row*col
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const p = points[i];
      A.push([1, p.row, p.col, p.row * p.col]);
      b.push(p[key]);
    }
    const model = solveReal(A, b);
    return model ? { kind: 'bilinear', model } : null;
  }
  if (n >= 3) {
    // Affine plane: value = a + b*row + c*col
    const A = [];
    const b = [];
    for (let i = 0; i < 3; i++) {
      const p = points[i];
      A.push([1, p.row, p.col]);
      b.push(p[key]);
    }
    const model = solveReal(A, b);
    return model ? { kind: 'affine', model } : null;
  }
  return null;
}

function evalModel(fit, row, col) {
  if (!fit) return null;
  const [a, b, c, d] = fit.model;
  if (fit.kind === 'bilinear') return a + b * row + c * col + d * row * col;
  return a + b * row + c * col;
}

function avg(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function buildIlluminationModel({ layout, image, pointAt, sampleRadius = 1 }) {
  const N = layout.N;
  const lumAt = (row, col) => {
    const [x, y] = pointAt(row, col);
    const rgb = sampleImage(image, x, y, sampleRadius);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };

  const points = [];
  const finderOrigins = [
    [0, 0],
    [0, N - 7],
    [N - 7, 0],
  ];
  for (const [r0, c0] of finderOrigins) {
    const black = avg([
      lumAt(r0 + 3, c0 + 3),
      lumAt(r0 + 0, c0 + 3),
      lumAt(r0 + 6, c0 + 3),
      lumAt(r0 + 3, c0 + 0),
      lumAt(r0 + 3, c0 + 6),
    ]);
    const white = avg([
      lumAt(r0 + 1, c0 + 3),
      lumAt(r0 + 5, c0 + 3),
      lumAt(r0 + 3, c0 + 1),
      lumAt(r0 + 3, c0 + 5),
    ]);
    points.push({ row: r0 + 3, col: c0 + 3, black, white });
  }

  if (layout.alignment) {
    const ar = N - 4;
    const ac = N - 4;
    const black = avg([
      lumAt(ar, ac),
      lumAt(ar - 2, ac),
      lumAt(ar + 2, ac),
      lumAt(ar, ac - 2),
      lumAt(ar, ac + 2),
    ]);
    const white = avg([
      lumAt(ar - 1, ac),
      lumAt(ar + 1, ac),
      lumAt(ar, ac - 1),
      lumAt(ar, ac + 1),
    ]);
    points.push({ row: ar, col: ac, black, white });
  }

  const blackFit = fitModel(points, 'black');
  const whiteFit = fitModel(points, 'white');

  const blackAt = (row, col) => evalModel(blackFit, row, col) ?? 0;
  const whiteAt = (row, col) => evalModel(whiteFit, row, col) ?? 255;

  return {
    points,
    blackAt,
    whiteAt,
    normalize(rgb, row, col) {
      const b = blackAt(row, col);
      const w = whiteAt(row, col);
      const range = Math.max(20, w - b);
      const scale = 255 / range;
      const offset = -b * scale;
      return [
        clamp(Math.round(rgb[0] * scale + offset), 0, 255),
        clamp(Math.round(rgb[1] * scale + offset), 0, 255),
        clamp(Math.round(rgb[2] * scale + offset), 0, 255),
      ];
    },
  };
}
