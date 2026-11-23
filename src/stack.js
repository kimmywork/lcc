/**
 * Multi-frame stacking for camera captures.
 *
 * Each frame is detected independently.  Frames that agree on version/N are
 * warped into a common canonical module grid and averaged.  Averaging reduces
 * sensor/compression noise; it does not remove motion blur or systematic
 * colour cast.  The caller decodes the canonical image with the normal
 * axis-aligned decoder.
 */

import { MAX_IMAGE_PIXELS, sampleImageBilinear, validateImage } from './image-utils.js';

function groupKey(det) {
  return `${det.version}|${det.N}`;
}

/** Per-channel median across frames; even counts average the middle two.
 *  Sorts into a reusable scratch buffer so fusion allocates nothing per cell. */
function medianInto(scratch, values, n) {
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) {
      scratch[j + 1] = scratch[j];
      j--;
    }
    scratch[j + 1] = v;
  }
  if (n % 2 === 1) return scratch[(n - 1) / 2];
  return Math.round((scratch[n / 2 - 1] + scratch[n / 2]) / 2);
}

function pointAtOf(det) {
  if (typeof det.pointAt === 'function') return det.pointAt;
  if (Array.isArray(det.homography) && det.homography.length === 9) {
    const [a, b, c, d, e, f, g, h, i] = det.homography;
    return (row, col) => {
      // The wasm homography maps module centres (index + 0.5); this helper
      // receives module-relative coordinates with a -0.5 offset.
      const x = col + 1;
      const y = row + 1;
      const den = g * x + h * y + i;
      return [(a * x + b * y + c) / den, (d * x + e * y + f) / den];
    };
  }
  return (row, col) => [
    det.originX + (col + 0.5) * det.s,
    det.originY + (row + 0.5) * det.s,
  ];
}

/**
 * @param {Array<{width:number,height:number,data:Uint8Array}>} frames
 * @param {Array<object|null>} detections  detectPerspective/detectSymbol result per frame
 * @param {object} options
 * @returns {{image:object,frames:number,requested:number,stacked:boolean,version:number,N:number,moduleSize:number,quietZone:number}}
 */
export function stackCanonicalFrames(frames, detections, options = {}) {
  const requested = frames.length;
  for (const frame of frames) validateImage(frame);
  const valid = [];
  for (let i = 0; i < frames.length; i++) {
    const det = detections[i];
    if (!det || !Number.isFinite(det.version) || !Number.isFinite(det.N)) continue;
    if (!Number.isInteger(det.N) || det.N < 21 || det.N > 1000) continue;
    valid.push({ frame: frames[i], det, index: i });
  }
  if (valid.length === 0) throw new Error('stack: no frame with a detected symbol');

  const groups = new Map();
  for (const item of valid) {
    const key = groupKey(item.det);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(item);
  }
  let best = [];
  let bestScore = -Infinity;
  for (const group of groups.values()) {
    const score = group.reduce((s, item) => s + (item.det.score ?? 0), 0) / group.length;
    if (group.length > best.length || (group.length === best.length && score > bestScore)) {
      best = group;
      bestScore = score;
    }
  }

  const ref = best[0].det;
  const quietZone = Number.isInteger(options.quietZone) && options.quietZone >= 0 && options.quietZone <= 64
    ? options.quietZone
    : 4;
  const total = ref.N + 2 * quietZone;
  const maxDimension = Number.isInteger(options.maxDimension) && options.maxDimension > 0 && options.maxDimension <= 8192
    ? options.maxDimension
    : 1400;
  let moduleSize = Number.isInteger(options.moduleSize) && options.moduleSize > 0 && options.moduleSize <= 64
    ? options.moduleSize
    : Math.max(16, Math.min(24, Math.round(ref.s || 16)));
  moduleSize = Math.max(12, Math.min(moduleSize, Math.floor(maxDimension / total)));

  if (best.length === 1) {
    return {
      image: best[0].frame,
      frames: 1,
      requested,
      stacked: false,
      noise: 0,
      version: ref.version,
      N: ref.N,
      moduleSize: Math.round(ref.s || moduleSize),
      quietZone,
    };
  }

  const width = total * moduleSize;
  const height = total * moduleSize;
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error('stack: output image exceeds the pixel budget');
  }
  const data = new Uint8Array(width * height * 3).fill(255);
  const SUB = 16;
  const n = best.length;
  const vals = [new Int32Array(n), new Int32Array(n), new Int32Array(n)];
  const scratch = new Int32Array(n);
  const lum = new Float64Array(n);
  const cell = new Int32Array(SUB * SUB * 3);
  const points = best.map((item) => pointAtOf(item.det));
  let noiseSum = 0;
  let noiseCount = 0;

  for (let row = 0; row < ref.N; row++) {
    for (let col = 0; col < ref.N; col++) {
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const my = row + (sy + 0.5) / SUB;
          const mx = col + (sx + 0.5) / SUB;
          for (let fi = 0; fi < n; fi++) {
            const [px, py] = points[fi](my - 0.5, mx - 0.5);
            const rgb = Number.isFinite(px) && Number.isFinite(py)
              ? sampleImageBilinear(best[fi].frame, px, py)
              : [255, 255, 255];
            vals[0][fi] = rgb[0];
            vals[1][fi] = rgb[1];
            vals[2][fi] = rgb[2];
          }
          for (let ch = 0; ch < 3; ch++) {
            cell[(sy * SUB + sx) * 3 + ch] = medianInto(scratch, vals[ch], n);
          }
        }
      }
      // Frame disagreement is measured at the module centre, not at a corner
      // sub-cell, so boundary disagreement does not dominate sigma.
      if (n >= 2) {
        for (let fi = 0; fi < n; fi++) {
          const [px, py] = points[fi](row, col);
          const rgb = Number.isFinite(px) && Number.isFinite(py)
            ? sampleImageBilinear(best[fi].frame, px, py)
            : [255, 255, 255];
          lum[fi] = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        }
        let mean = 0;
        for (let fi = 0; fi < n; fi++) mean += lum[fi];
        mean /= n;
        let variance = 0;
        for (let fi = 0; fi < n; fi++) variance += (lum[fi] - mean) ** 2;
        noiseSum += Math.sqrt(variance / n);
        noiseCount++;
      }
      const blockX = (col + quietZone) * moduleSize;
      const blockY = (row + quietZone) * moduleSize;
      const x0 = Math.max(0, Math.ceil(blockX - 0.5));
      const x1 = Math.min(width, Math.ceil(blockX + moduleSize - 0.5));
      const y0 = Math.max(0, Math.ceil(blockY - 0.5));
      const y1 = Math.min(height, Math.ceil(blockY + moduleSize - 0.5));
      for (let y = y0; y < y1; y++) {
        const v = (y + 0.5) / moduleSize - quietZone - row;
        const sy = Math.min(SUB - 1, Math.max(0, Math.floor(v * SUB)));
        for (let x = x0; x < x1; x++) {
          const u = (x + 0.5) / moduleSize - quietZone - col;
          const sx = Math.min(SUB - 1, Math.max(0, Math.floor(u * SUB)));
          const q = (y * width + x) * 3;
          const c = (sy * SUB + sx) * 3;
          data[q] = cell[c];
          data[q + 1] = cell[c + 1];
          data[q + 2] = cell[c + 2];
        }
      }
    }
  }

  return {
    image: { width, height, data },
    frames: best.length,
    requested,
    stacked: true,
    noise: noiseCount ? noiseSum / noiseCount : 0,
    version: ref.version,
    N: ref.N,
    moduleSize,
    quietZone,
  };
}
