/**
 * Perspective-capable LCC detector for camera photos.
 *
 * The finder outer ring is a connected dark component with a hole.  We find
 * ring-like components, try triples, build a homography from the three finder
 * centres plus the inferred fourth corner, and validate the 7x7 finder
 * patterns in canonical module coordinates.
 */

import { versionToSize } from './constants.js';
import { FINDER_PATTERN, sampleImage, validateImage } from './image-utils.js';
import { createPreprocessor } from './preprocess.js';

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

export function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveReal(A, b);
  if (!h) return null;
  return [...h, 1];
}

export function applyHomography(H, u, v) {
  const w = H[6] * u + H[7] * v + H[8];
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [
    (H[0] * u + H[1] * v + H[2]) / w,
    (H[3] * u + H[4] * v + H[5]) / w,
  ];
}

export function ringComponents(mask, width, height) {
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const out = [];
  const minSide = Math.min(width, height);
  for (let start = 0; start < mask.length; start++) {
    if (visited[start] || !mask[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p / width) | 0;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (!visited[q] && mask[q]) {
            visited[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (area < 20 || bw < 7 || bh < 7) continue;
    const aspect = bw / bh;
    if (aspect < 0.3 || aspect > 3.2) continue;
    const fill = area / (bw * bh);
    if (fill < 0.15 || fill > 0.9) continue;
    const cx = sumX / area;
    const cy = sumY / area;
    const s = Math.sqrt(area / 24);
    if (s < 2 || s > minSide / 10) continue;

    // Orientation-invariant ring check: the finder has a white ring at about
    // 1.75 module radii and a black outer ring at about 3.2 module radii.
    let whiteHits = 0;
    let blackHits = 0;
    let probes = 0;
    for (let a = 0; a < 16; a++) {
      const angle = (a / 16) * Math.PI * 2;
      const x1 = Math.round(cx + Math.cos(angle) * 1.75 * s);
      const y1 = Math.round(cy + Math.sin(angle) * 1.75 * s);
      const x2 = Math.round(cx + Math.cos(angle) * 3.2 * s);
      const y2 = Math.round(cy + Math.sin(angle) * 3.2 * s);
      if (x1 >= 0 && x1 < width && y1 >= 0 && y1 < height) {
        probes++;
        if (!mask[y1 * width + x1]) whiteHits++;
      }
      if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height) {
        if (mask[y2 * width + x2]) blackHits++;
      }
    }
    if (probes < 8) continue;
    if (whiteHits < probes * 0.6 || blackHits < probes * 0.6) continue;
    out.push({ x: cx, y: cy, s, area, bw, bh, fill });
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

const ALIGNMENT_PATTERN = [
  [0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 1, 0, 1, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0],
];

function timingScore(H, image, thresholdAt, N) {
  let matches = 0;
  let total = 0;
  for (let c = 8; c <= N - 9; c++) {
    const [x, y] = applyHomography(H, c + 0.5, 6.5);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rgb = sampleImage(image, x, y, 1);
    const bit = Math.max(rgb[0], rgb[1], rgb[2]) < thresholdAt(x, y) ? 0 : 1;
    if (bit === (c % 2 === 0 ? 0 : 1)) matches++;
    total++;
  }
  for (let r = 8; r <= N - 9; r++) {
    const [x, y] = applyHomography(H, 6.5, r + 0.5);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rgb = sampleImage(image, x, y, 1);
    const bit = Math.max(rgb[0], rgb[1], rgb[2]) < thresholdAt(x, y) ? 0 : 1;
    if (bit === (r % 2 === 0 ? 0 : 1)) matches++;
    total++;
  }
  return total === 0 ? 0 : matches / total;
}

function alignmentScore(H, image, thresholdAt, N) {
  const row0 = N - 6;
  const col0 = N - 6;
  let matches = 0;
  let total = 0;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const [x, y] = applyHomography(H, col0 + c + 0.5, row0 + r + 0.5);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const rgb = sampleImage(image, x, y, 1);
      const bit = Math.max(rgb[0], rgb[1], rgb[2]) < thresholdAt(x, y) ? 0 : 1;
      if (bit === ALIGNMENT_PATTERN[r][c]) matches++;
      total++;
    }
  }
  return total === 0 ? 0 : matches / total;
}

function finderScore(H, image, thresholdAt, row0, col0) {
  let matches = 0;
  let total = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const [x, y] = applyHomography(H, col0 + c + 0.5, row0 + r + 0.5);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const rgb = sampleImage(image, x, y, 1);
      const bit = Math.max(rgb[0], rgb[1], rgb[2]) < thresholdAt(x, y) ? 0 : 1;
      if (bit === FINDER_PATTERN[r][c]) matches++;
      total++;
    }
  }
  return total === 0 ? 0 : matches / total;
}

function snapVersion(n) {
  const version = Math.max(1, Math.min(100, Math.round((n - 21) / 4) + 1));
  return { version, N: versionToSize(version) };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cross(tl, tr, bl) {
  return (tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x);
}

function* triples(arr) {
  for (let i = 0; i < arr.length - 2; i++) {
    for (let j = i + 1; j < arr.length - 1; j++) {
      for (let k = j + 1; k < arr.length; k++) yield [arr[i], arr[j], arr[k]];
    }
  }
}

function darkCorners(mask, width, height) {
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;
  let pMinSum = null;
  let pMaxSum = null;
  let pMinDiff = null;
  let pMaxDiff = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const s = x + y;
      const d = x - y;
      if (s < minSum) { minSum = s; pMinSum = [x, y]; }
      if (s > maxSum) { maxSum = s; pMaxSum = [x, y]; }
      if (d < minDiff) { minDiff = d; pMinDiff = [x, y]; }
      if (d > maxDiff) { maxDiff = d; pMaxDiff = [x, y]; }
    }
  }
  if (!pMinSum) return null;
  return { minSum: pMinSum, maxSum: pMaxSum, minDiff: pMinDiff, maxDiff: pMaxDiff };
}

function assignCorners(list, tl, tr, bl) {
  const used = new Set();
  const pick = (p) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(list[i][0] - p.x, list[i][1] - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    used.add(best);
    return list[best];
  };
  const tlC = pick(tl);
  const trC = pick(tr);
  const blC = pick(bl);
  if (!tlC || !trC || !blC) return null;
  let brC = null;
  for (let i = 0; i < list.length; i++) {
    if (!used.has(i)) {
      brC = list[i];
      break;
    }
  }
  if (!brC) return null;
  return { tl: tlC, tr: trC, bl: blC, br: brC };
}

export function detectPerspective(image, options = {}) {
  validateImage(image);
  const debug = options.debug ?? false;
  const { width, height } = image;
  const variant = options.variant ?? createPreprocessor(image).get('otsu');
  const { mask, thresholdAt } = variant;
  const candidates = ringComponents(mask, width, height).slice(0, 10);
  if (debug) console.log('[perspective] candidates', candidates.map((c) => ({ x: +c.x.toFixed(1), y: +c.y.toFixed(1), s: +c.s.toFixed(2) })));
  if (candidates.length < 3) throw new Error('LCC perspective: not enough ring candidates');
  const cornerSet = darkCorners(mask, width, height);
  if (!cornerSet) throw new Error('LCC perspective: no dark corners');
  const cornerList = [cornerSet.minSum, cornerSet.maxSum, cornerSet.minDiff, cornerSet.maxDiff];

  let best = null;
  for (const group of triples(candidates)) {
    // The vertex opposite the longest side is the top-left finder.
    const d01 = distance(group[0], group[1]);
    const d02 = distance(group[0], group[2]);
    const d12 = distance(group[1], group[2]);
    let tl;
    let a;
    let b;
    if (d12 >= d01 && d12 >= d02) {
      tl = group[0];
      a = group[1];
      b = group[2];
    } else if (d02 >= d01 && d02 >= d12) {
      tl = group[1];
      a = group[0];
      b = group[2];
    } else {
      tl = group[2];
      a = group[0];
      b = group[1];
    }

    const assignments = [
      [a, b],
      [b, a],
    ];
    for (const [tr, bl] of assignments) {
      if (cross(tl, tr, bl) <= 0) continue;
      const sTop = (tl.s + tr.s) / 2;
      const sLeft = (tl.s + bl.s) / 2;
      const n1 = distance(tl, tr) / sTop + 7;
      const n2 = distance(tl, bl) / sLeft + 7;
      const versionEst = Math.round((((n1 + n2) / 2) - 21) / 4) + 1;
      if (debug) console.log('[perspective] triple', { tl: [tl.x, tl.y], tr: [tr.x, tr.y], bl: [bl.x, bl.y], n1, n2, versionEst });
      for (let v = Math.max(1, versionEst - 3); v <= Math.min(100, versionEst + 3); v++) {
        const N = versionToSize(v);
        const canonicalFinders = [[3.5, 3.5], [N - 3.5, 3.5], [3.5, N - 3.5], [N - 3.5, N - 3.5]];
        const canonicalCorners = [[0, 0], [N, 0], [0, N], [N, N]];
        const hypotheses = [];

        if (N >= 25) {
          const expectedBR = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };
          const maxD = 0.35 * Math.max(distance(tl, tr), distance(tl, bl));
          const avgArea = (tl.area + tr.area + bl.area) / 3;
          let bestAlign = null;
          let bestD = Infinity;
          for (const c of candidates) {
            if (c === tl || c === tr || c === bl) continue;
            const d = Math.hypot(c.x - expectedBR.x, c.y - expectedBR.y);
            if (d > maxD) continue;
            if (c.area > 0.95 * avgArea) continue;
            if (d < bestD) {
              bestD = d;
              bestAlign = c;
            }
          }
          if (bestAlign) {
            const H = computeHomography(canonicalFinders, [
              [tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [bestAlign.x, bestAlign.y],
            ]);
            if (H) hypotheses.push({ H, alignment: bestAlign, kind: 'align' });
          }

          // Parallelogram hypothesis: exact for rotation/scale/translation and
          // a good initialisation under mild perspective.  It does not depend
          // on a possibly missing alignment ring.
          const H = computeHomography(canonicalFinders, [
            [tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [expectedBR.x, expectedBR.y],
          ]);
          if (H) hypotheses.push({ H, alignment: null, kind: 'para' });
        }

        const assigned = assignCorners(cornerList, tl, tr, bl);
        if (assigned) {
          const H = computeHomography(canonicalCorners, [
            assigned.tl, assigned.tr, assigned.bl, assigned.br,
          ]);
          if (H) hypotheses.push({ H, alignment: null, kind: 'corners' });
        }

        for (const hypothesis of hypotheses) {
          const { H, alignment } = hypothesis;
          const scoreTL = finderScore(H, image, thresholdAt, 0, 0);
          const scoreTR = finderScore(H, image, thresholdAt, 0, N - 7);
          const scoreBL = finderScore(H, image, thresholdAt, N - 7, 0);
          let scoreA = 1;
          if (alignment) {
            scoreA = alignmentScore(H, image, thresholdAt, N);
            if (scoreA < 0.65) continue;
          }
          const minScore = Math.min(scoreTL, scoreTR, scoreBL, scoreA);
          const scoreT = timingScore(H, image, thresholdAt, N);
          if (debug) console.log('[perspective] v', v, 'N', N, 'scores', scoreTL.toFixed(3), scoreTR.toFixed(3), scoreBL.toFixed(3), 'align', scoreA.toFixed(3), 'timing', scoreT.toFixed(3), 'min', minScore.toFixed(3), 'kind', hypothesis.kind, 'alignPt', alignment ? [alignment.x.toFixed(1), alignment.y.toFixed(1)] : null);
          if (minScore < 0.65) continue;
          const consistency = 1 - Math.min(1, Math.abs(n1 - n2) / N);
          const total = minScore + 0.5 * scoreT + 0.1 * consistency;
          if (!best || total > best.score) {
            best = {
              version: v,
              N,
              s: (tl.s + tr.s + bl.s) / 3,
              threshold: thresholdAt(width / 2, height / 2),
              thresholdAt,
              thresholdAtRowCol: (row, col) => {
                const [x, y] = applyHomography(H, col + 0.5, row + 0.5);
                return thresholdAt(x, y);
              },
              pointAt: (row, col) => applyHomography(H, col + 0.5, row + 0.5),
              homography: H,
              finders: { tl, tr, bl },
              score: total,
              finderScores: { tl: scoreTL, tr: scoreTR, bl: scoreBL },
              timingScore: scoreT,
              alignmentScore: scoreA,
              sampler: (row, col) => {
                const samples = [];
                for (const dv of [-0.2, 0, 0.2]) {
                  for (const du of [-0.2, 0, 0.2]) {
                    const [x, y] = applyHomography(H, col + 0.5 + du, row + 0.5 + dv);
                    samples.push(sampleImage(image, x, y, 0));
                  }
                }
                const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[4];
                return [med(0), med(1), med(2)];
              },
            };
          }
        }
      }
    }
  }

  if (!best) throw new Error('LCC perspective: no valid finder triple');
  return best;
}
