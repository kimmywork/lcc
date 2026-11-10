/**
 * Multi-frame stacking for camera captures.
 *
 * Each frame is detected independently.  Frames that agree on version/N are
 * warped into a common canonical module grid and averaged.  Averaging reduces
 * sensor/compression noise; it does not remove motion blur or systematic
 * colour cast.  The caller decodes the canonical image with the normal
 * axis-aligned decoder.
 */

import { sampleImageBilinear } from './image-utils.js';

function groupKey(det) {
  return `${det.version}|${det.N}`;
}

function pointAtOf(det) {
  if (typeof det.pointAt === 'function') return det.pointAt;
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
  const valid = [];
  for (let i = 0; i < frames.length; i++) {
    const det = detections[i];
    if (!det || !Number.isFinite(det.version) || !Number.isFinite(det.N)) continue;
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
  const quietZone = options.quietZone ?? 4;
  const total = ref.N + 2 * quietZone;
  const maxDimension = options.maxDimension ?? 1400;
  let moduleSize = options.moduleSize
    ?? Math.max(16, Math.min(24, Math.round(ref.s || 16)));
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
  const sum = new Float32Array(width * height * 3);
  const counts = new Uint16Array(width * height);
  const noiseSamples = new Map();
  const noiseStride = options.noiseStride ?? 257;

  for (const { frame, det } of best) {
    const pointAt = pointAtOf(det);
    for (let y = 0; y < height; y++) {
      const my = (y + 0.5) / moduleSize - quietZone;
      if (my < 0 || my >= ref.N) continue;
      const row = Math.floor(my);
      const v = my - row;
      for (let x = 0; x < width; x++) {
        const mx = (x + 0.5) / moduleSize - quietZone;
        if (mx < 0 || mx >= ref.N) continue;
        const col = Math.floor(mx);
        const u = mx - col;
        const [sx, sy] = pointAt(row + v - 0.5, col + u - 0.5);
        const rgb = sampleImageBilinear(frame, sx, sy);
        const p = y * width + x;
        const q = p * 3;
        sum[q] += rgb[0];
        sum[q + 1] += rgb[1];
        sum[q + 2] += rgb[2];
        counts[p]++;
        if (p % noiseStride === 0) {
          let values = noiseSamples.get(p);
          if (!values) {
            values = [];
            noiseSamples.set(p, values);
          }
          values.push(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
        }
      }
    }
  }

  const data = new Uint8Array(width * height * 3).fill(255);
  for (let p = 0; p < width * height; p++) {
    const n = counts[p];
    if (n === 0) continue;
    const q = p * 3;
    data[q] = Math.round(sum[q] / n);
    data[q + 1] = Math.round(sum[q + 1] / n);
    data[q + 2] = Math.round(sum[q + 2] / n);
  }

  let noiseSum = 0;
  let noiseCount = 0;
  for (const values of noiseSamples.values()) {
    if (values.length < 2) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    noiseSum += Math.sqrt(variance);
    noiseCount++;
  }
  const noise = noiseCount ? noiseSum / noiseCount : 0;

  return {
    image: { width, height, data },
    frames: best.length,
    requested,
    stacked: true,
    noise,
    version: ref.version,
    N: ref.N,
    moduleSize,
    quietZone,
  };
}
