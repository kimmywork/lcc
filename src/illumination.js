/**
 * Local illumination model built from the fixed finder/alignment patterns.
 *
 * LCC has three 7x7 finders and (for N>=25) a 5x5 alignment pattern at the
 * fourth corner.  Their black and white modules are known neutrals.  Each
 * channel always gets its own black/white field, including a cast of only a
 * few levels.  Samples are the median of an inset inside the module, so the
 * one-module white ring is not mixed with neighbouring black.  A bilinear
 * field still follows shading.  The hub affine fits a residual the white
 * point cannot see.
 */

import { clamp } from './color.js';
import { sampleImageBilinear } from './image-utils.js';

const WHITE_NEUTRAL_SPREAD = 12;
const INSET = [-0.2, 0, 0.2];

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

function avgRgb(samples) {
  const out = [0, 0, 0];
  for (const rgb of samples) {
    out[0] += rgb[0];
    out[1] += rgb[1];
    out[2] += rgb[2];
  }
  const n = samples.length || 1;
  return [out[0] / n, out[1] / n, out[2] / n];
}

function luminanceOf(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function channelSpread(samples) {
  const mean = avgRgb(samples);
  return Math.max(mean[0], mean[1], mean[2]) - Math.min(mean[0], mean[1], mean[2]);
}

function scaleChannel(value, black, white) {
  const range = Math.max(20, white - black);
  return clamp(Math.round(((value - black) * 255) / range), 0, 255);
}

function medianRgb(samples) {
  return [0, 1, 2].map((ch) => {
    const values = samples.map((rgb) => rgb[ch]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
}

export function buildIlluminationModel({ layout, image, pointAt }) {
  const N = layout.N;
  const rgbAt = (row, col) => {
    const samples = [];
    for (const dv of INSET) {
      for (const du of INSET) {
        const [x, y] = pointAt(row + dv, col + du);
        samples.push(sampleImageBilinear(image, x, y));
      }
    }
    return medianRgb(samples);
  };

  const points = [];
  const finderOrigins = [
    [0, 0],
    [0, N - 7],
    [N - 7, 0],
  ];
  const pushLocator = (row, col, blackSamples, whiteSamples) => {
    const blackRgb = avgRgb(blackSamples.map(([r, c]) => rgbAt(r, c)));
    const whiteRgb = avgRgb(whiteSamples.map(([r, c]) => rgbAt(r, c)));
    points.push({
      row,
      col,
      black: luminanceOf(blackRgb),
      white: luminanceOf(whiteRgb),
      blackRgb,
      whiteRgb,
      black0: blackRgb[0],
      black1: blackRgb[1],
      black2: blackRgb[2],
      white0: whiteRgb[0],
      white1: whiteRgb[1],
      white2: whiteRgb[2],
    });
  };

  for (const [r0, c0] of finderOrigins) {
    pushLocator(
      r0 + 3,
      c0 + 3,
      [[r0 + 3, c0 + 3], [r0, c0 + 3], [r0 + 6, c0 + 3], [r0 + 3, c0], [r0 + 3, c0 + 6]],
      [[r0 + 1, c0 + 3], [r0 + 5, c0 + 3], [r0 + 3, c0 + 1], [r0 + 3, c0 + 5]],
    );
  }

  if (layout.alignment) {
    const ar = N - 4;
    const ac = N - 4;
    pushLocator(
      ar,
      ac,
      [[ar, ac], [ar - 2, ac], [ar + 2, ac], [ar, ac - 2], [ar, ac + 2]],
      [[ar - 1, ac], [ar + 1, ac], [ar, ac - 1], [ar, ac + 1]],
    );
  }

  const chromatic = channelSpread(points.map((p) => p.whiteRgb)) > WHITE_NEUTRAL_SPREAD;
  const blackFit = fitModel(points, 'black');
  const whiteFit = fitModel(points, 'white');
  const blackFits = [0, 1, 2].map((ch) => fitModel(points, `black${ch}`));
  const whiteFits = [0, 1, 2].map((ch) => fitModel(points, `white${ch}`));
  const perChannel = blackFits.every(Boolean) && whiteFits.every(Boolean);

  const blackAt = (row, col) => evalModel(blackFit, row, col) ?? 0;
  const whiteAt = (row, col) => evalModel(whiteFit, row, col) ?? 255;

  return {
    points,
    chromatic,
    blackAt,
    whiteAt,
    normalize(rgb, row, col) {
      if (!perChannel) {
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
      }
      return [0, 1, 2].map((ch) => scaleChannel(
        rgb[ch],
        evalModel(blackFits[ch], row, col) ?? 0,
        evalModel(whiteFits[ch], row, col) ?? 255,
      ));
    },
  };
}
