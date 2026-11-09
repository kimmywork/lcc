/**
 * In-code calibration.
 *
 * L1: black/white threshold.
 * L2: rank classification using the 16-block gray ramp (monotonic lighting
 *     changes are absorbed by nearest measured luminance).
 * L3: 3x4 affine colour correction fitted from the palette calibration
 *     blocks, then CIELAB nearest-neighbour classification.
 *
 * Each calibrator also exposes a per-symbol cost vector.  The constraint
 * decoder uses those costs for Viterbi correction, so a few misclassified
 * modules do not destroy the whole constrained block.
 */

import { clamp, deltaE76, luminance, nearestIndex, rgbToLab } from './color.js';

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

function fitChannel(samples, channel) {
  if (samples.length < 4) return null;
  const AtA = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const Aty = new Array(4).fill(0);
  for (const s of samples) {
    const row = [s.measured[0], s.measured[1], s.measured[2], 1];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) AtA[i][j] += row[i] * row[j];
      Aty[i] += row[i] * s.nominal[channel];
    }
  }
  for (let i = 0; i < 4; i++) AtA[i][i] += 1e-6;
  return solveReal(AtA, Aty);
}

function labDist2(a, b) {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

function argmin(costs) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < costs.length; i++) {
    if (costs[i] < bestD) {
      bestD = costs[i];
      best = i;
    }
  }
  return best;
}

export function buildCalibrator({ layerName, layout, paletteInfo, sampler, threshold }) {
  if (layerName === 'L1') {
    const costs = (rgb) => {
      const lum = luminance(rgb);
      const d = lum - threshold;
      return [Math.max(0, d) ** 2, Math.max(0, -d) ** 2];
    };
    return {
      type: 'threshold',
      costs,
      classify: (rgb) => argmin(costs(rgb)),
    };
  }

  if (layerName === 'L2') {
    const samples = layout.grayBlocks.map((b) => ({
      measuredL: rgbToLab(sampler(b.row, b.col))[0],
      index: b.symbol,
    }));
    samples.sort((a, b) => a.measuredL - b.measuredL);
    const costs = (rgb) => {
      const L = rgbToLab(rgb)[0];
      const out = new Array(16).fill(Infinity);
      for (const s of samples) out[s.index] = (L - s.measuredL) ** 2;
      return out;
    };
    return {
      type: 'gray-rank',
      samples,
      costs,
      classify: (rgb) => argmin(costs(rgb)),
    };
  }

  const samples = layout.paletteBlocks.map((b) => {
    const measured = sampler(b.row, b.col);
    const nominal = paletteInfo.palette[b.symbol];
    return {
      measured,
      nominal,
      dE: deltaE76(rgbToLab(measured), rgbToLab(nominal)),
    };
  });
  const avgDE = samples.length
    ? samples.reduce((s, x) => s + x.dE, 0) / samples.length
    : 0;

  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  let matrix = identity;
  let type = 'identity-clean';

  if (avgDE >= 2.5) {
    const M = [0, 1, 2].map((ch) => fitChannel(samples, ch));
    if (M.every((row) => Array.isArray(row))) {
      matrix = M;
      type = 'affine';
    } else {
      type = 'identity';
    }
  }

  const correctLab = (rgb) => {
    const out = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const row = matrix[ch];
      out[ch] = clamp(
        Math.round(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2] + row[3]),
        0,
        255,
      );
    }
    return rgbToLab(out);
  };

  const costs = (rgb) => {
    const lab = correctLab(rgb);
    return paletteInfo.paletteLab.map((p) => labDist2(lab, p));
  };

  return {
    type,
    matrix,
    samples: samples.length,
    avgDE,
    costs,
    classify: (rgb) => argmin(costs(rgb)),
  };
}
