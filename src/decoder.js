/**
 * LCC decoder.
 *
 * Phase A: axis-aligned clean images (screenshots, generated PNGs).
 * Phase B: perspective camera photos via connected-component finder
 * detection + homography, plus in-code colour calibration.
 */

import { BitWriter } from './bitstream.js';
import { buildCalibrator } from './calibration.js';
import { luminance, nearestIndex, rgbToLab } from './color.js';
import { ECC_LEVELS, LAYERS, LAYER_BY_ID, sizeToVersion, versionToSize } from './constants.js';
import { RankConstraint, viterbiCorrect } from './constraint.js';
import { detectPerspective } from './detector.js';
import { rsDecodeBlocks } from './ecc/rs.js';
import { parseFrame } from './frame.js';
import { readFormatBand } from './format/format-band.js';
import { FINDER_PATTERN, sampleImage } from './image-utils.js';
import { preprocessVariants } from './preprocess.js';
import { buildIlluminationModel } from './illumination.js';
import { localRankSymbols } from './local-rank.js';
import { BLACK, WHITE, makeLayout } from './layout.js';
import { generatePalette } from './palettes.js';
import { makeWhitening } from './whitening.js';

function finderCandidates(mask, width, height, horizontal) {
  const candidates = [];
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  for (let a = 0; a < outer; a++) {
    const runs = [];
    let start = 0;
    let color = horizontal ? mask[a * width] : mask[a];
    for (let b = 1; b < inner; b++) {
      const v = horizontal ? mask[a * width + b] : mask[b * width + a];
      if (v !== color) {
        runs.push({ color, start, length: b - start });
        start = b;
        color = v;
      }
    }
    runs.push({ color, start, length: inner - start });
    for (let i = 0; i + 4 < runs.length; i++) {
      if (runs[i].color !== 1 || runs[i + 1].color !== 0 || runs[i + 2].color !== 1 ||
          runs[i + 3].color !== 0 || runs[i + 4].color !== 1) continue;
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

function finderScore(mask, width, height, center) {
  let matches = 0;
  let total = 0;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const x = Math.round(center.x + (c - 3) * center.unit);
      const y = Math.round(center.y + (r - 3) * center.unit);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const bit = mask[y * width + x] ? 0 : 1;
      if (bit === FINDER_PATTERN[r][c]) matches++;
      total++;
    }
  }
  return total === 0 ? 0 : matches / total;
}

export function detectSymbol(image, options = {}) {
  const { width, height } = image;
  const variant = options.variant ?? preprocessVariants(image)[0];
  const { mask, thresholdAt } = variant;
  const threshold = thresholdAt(width / 2, height / 2);
  const rowC = finderCandidates(mask, width, height, true);
  const colC = finderCandidates(mask, width, height, false);
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

  const filtered = centers.filter((c) => finderScore(mask, width, height, c) >= 0.8);
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
  const sampler = (row, col) => sampleModule(image, originX, originY, s, row, col);
  const thresholdAtRowCol = (row, col) => thresholdAt(
    originX + (col + 0.5) * s,
    originY + (row + 0.5) * s,
  );
  return {
    originX,
    originY,
    s,
    N,
    version,
    threshold,
    thresholdAt,
    thresholdAtRowCol,
    sampler,
    finders: { tl, tr, bl },
  };
}

export function sampleModule(image, originX, originY, s, row, col) {
  const cx = originX + (col + 0.5) * s;
  const cy = originY + (row + 0.5) * s;
  const radius = Math.max(0, Math.floor(s / 4) - 1);
  return sampleImage(image, cx, cy, radius);
}

function decodeText(payload) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}

function makeExplicitDetector(image, options) {
  const s = options.moduleSize;
  const originX = options.origin.x;
  const originY = options.origin.y;
  return {
    originX,
    originY,
    s,
    version: options.version,
    N: versionToSize(options.version),
    threshold: options.threshold ?? 128,
    thresholdAt: () => options.threshold ?? 128,
    thresholdAtRowCol: () => options.threshold ?? 128,
    pointAt: (row, col) => [originX + (col + 0.5) * s, originY + (row + 0.5) * s],
    sampler: (row, col) => sampleModule(image, originX, originY, s, row, col),
  };
}

export function decode(image, options = {}) {
  const mode = options.detector ?? 'axis';
  let det;
  if (options.sampler) {
    det = { ...options, threshold: options.threshold ?? 128 };
  } else if (options.moduleSize && options.version && options.origin) {
    det = makeExplicitDetector(image, options);
  } else if (mode === 'perspective') {
    det = detectPerspective(image, options);
  } else {
    det = detectSymbol(image, options);
  }

  const rawSampler = det.sampler ?? ((row, col) => sampleModule(image, det.originX, det.originY, det.s, row, col));
  const pointAt = det.pointAt ?? ((row, col) => [
    det.originX + (col + 0.5) * det.s,
    det.originY + (row + 0.5) * det.s,
  ]);
  const version = options.version ?? det.version ?? sizeToVersion(det.N);
  const layoutProbe = makeLayout({ version, layer: 'L1', paletteMode: 'bucketed' });
  const thresholdAtRowCol = det.thresholdAtRowCol ?? (() => det.threshold ?? 128);
  const getFormatSymbol = (r, c) => {
    const rgb = rawSampler(r, c);
    return luminance(rgb) < thresholdAtRowCol(r, c) ? BLACK : WHITE;
  };
  const fmt = readFormatBand(getFormatSymbol, layoutProbe);

  const layerName = options.layer ?? LAYER_BY_ID.get(fmt.layerId)?.name;
  if (!layerName) throw new Error(`LCC decode: unknown layer id ${fmt.layerId}`);
  const paletteMode = options.paletteMode ?? fmt.paletteMode;
  const harmony = options.harmony ?? fmt.harmony;
  const constraint = options.constraint ?? fmt.constraint;
  const seed = options.seed ?? fmt.seed;

  const paletteInfo = generatePalette(layerName, { mode: paletteMode, harmony });
  const layout = makeLayout({ version, layer: layerName, paletteMode, harmony, paletteInfo });
  const illumination = options.normalize === false
    ? null
    : buildIlluminationModel({ layout, image, pointAt, sampleRadius: 1 });
  const sampler = illumination
    ? (row, col) => illumination.normalize(rawSampler(row, col), row, col)
    : rawSampler;
  const calibrator = buildCalibrator({
    layerName,
    layout,
    paletteInfo,
    sampler,
    threshold: det.threshold,
  });

  let symbols = new Array(layout.dataCount);
  const rgbSamples = new Array(layout.dataCount);
  for (let i = 0; i < layout.dataCoords.length; i++) {
    const [r, c] = layout.dataCoords[i];
    const rgb = sampler(r, c);
    rgbSamples[i] = rgb;
    symbols[i] = calibrator.classify(rgb);
  }

  let localRankCosts = null;
  if (layerName === 'L2' && (mode === 'perspective' || options.localRank)) {
    const lr = localRankSymbols({ layout, rgbSamples });
    symbols = Array.from(lr.symbols);
    localRankCosts = lr.costs;
  }

  let writer;
  let capacityBits;
  if (layerName === 'L1') {
    writer = new BitWriter();
    for (const s of symbols) writer.writeBit(s & 1);
    capacityBits = layout.dataCount;
  } else if (constraint) {
    const rc = new RankConstraint(paletteInfo);
    let corrected = symbols;
    if (localRankCosts) {
      corrected = viterbiCorrect(localRankCosts, paletteInfo, rc.initialRank);
    } else if (typeof calibrator.costs === 'function') {
      const costs = new Array(layout.dataCount);
      for (let i = 0; i < rgbSamples.length; i++) costs[i] = calibrator.costs(rgbSamples[i]);
      corrected = viterbiCorrect(costs, paletteInfo, rc.initialRank);
    }
    writer = rc.decode(corrected, { lenient: true });
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
      calibration: calibrator.type,
      flags: frame.flags,
    },
    detection: det,
  };
}

export function decodeAuto(image, options = {}) {
  const detectorOption = options.detector === 'auto' ? undefined : options.detector;
  const variants = preprocessVariants(image);
  const byName = new Map(variants.map((v) => [v.name, v]));
  const sequence = [];
  if (!detectorOption || detectorOption === 'axis') {
    sequence.push(['otsu', 'axis'], ['otsu+close', 'axis']);
  }
  if (!detectorOption || detectorOption === 'perspective') {
    for (const name of [
      'adaptive-1/8+close',
      'adaptive-1/8',
      'adaptive-1/16+close',
      'adaptive-1/16',
      'otsu+close',
      'otsu',
      'adaptive-1/4+close',
      'adaptive-1/4',
    ]) {
      sequence.push([name, 'perspective']);
    }
  }
  const errors = [];
  for (const [name, detector] of sequence) {
    const variant = byName.get(name);
    if (!variant) continue;
    try {
      return decode(image, { ...options, detector, variant });
    } catch (e) {
      errors.push(`${name}/${detector}: ${e.message}`);
    }
  }
  throw new Error(`LCC decode failed (${errors.slice(0, 8).join(' | ')})`);
}
