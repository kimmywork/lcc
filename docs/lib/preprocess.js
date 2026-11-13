/**
 * QR-style preprocessing variants.
 *
 * Real QR decoders do not rely on a single global threshold.  They build
 * several binarizations (global histogram + block/local adaptive), optionally
 * close small gaps, and retry the detector on each.  This module provides the
 * same idea for LCC:
 *
 *   - global Otsu
 *   - Bradley-style local mean threshold (integral image)
 *   - morphological closing to bridge screen-moire gaps in finder rings
 *
 * Each variant carries a binary mask (1 = black) and a thresholdAt(x, y)
 * function used for local format-bit sampling.
 */

import { grayscale, robustThreshold } from './image-utils.js';

export function integralImage(gray, width, height) {
  const W = width + 1;
  const I = new Float64Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + rowSum;
    }
  }
  return I;
}

export function adaptiveMask(gray, width, height, integral, window, offset) {
  const W = width + 1;
  const mask = new Uint8Array(width * height);
  const threshold = new Float32Array(width * height);
  const r = Math.max(4, Math.floor(window / 2));
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1]
        - integral[y1 * W + x0] + integral[y0 * W + x0];
      const mean = sum / area;
      const t = mean * (1 - offset);
      const i = y * width + x;
      threshold[i] = t;
      mask[i] = gray[i] < t ? 1 : 0;
    }
  }
  return { mask, threshold };
}

function dilate(mask, width, height, radius) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -radius; dy <= radius && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (mask[yy * width + xx]) {
            v = 1;
            break;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

function erode(mask, width, height, radius) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 1;
      for (let dy = -radius; dy <= radius && v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (!mask[yy * width + xx]) {
            v = 0;
            break;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

export function morphClose(mask, width, height, radius = 1) {
  return erode(dilate(mask, width, height, radius), width, height, radius);
}

function thresholdFunction(threshold, width, height) {
  return (x, y) => {
    const xx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(height - 1, Math.round(y)));
    return threshold[yy * width + xx];
  };
}

const ADAPTIVE_CONFIGS = [
  ['1/8', 0.15],
  ['1/16', 0.10],
  ['1/4', 0.20],
];

export const PREPROCESS_NAMES = [
  'otsu',
  'otsu+close',
  'adaptive-1/8',
  'adaptive-1/8+close',
  'adaptive-1/16',
  'adaptive-1/16+close',
  'adaptive-1/4',
  'adaptive-1/4+close',
  'value-otsu',
  'value-otsu+close',
  'value-adaptive-1/8',
  'value-adaptive-1/8+close',
  'value-adaptive-1/16',
  'value-adaptive-1/16+close',
  'value-adaptive-1/4',
  'value-adaptive-1/4+close',
];

function adaptiveWindow(kind, minSide) {
  if (kind === '1/8') return Math.max(15, Math.floor(minSide / 8));
  if (kind === '1/16') return Math.max(11, Math.floor(minSide / 16));
  return Math.max(21, Math.floor(minSide / 4));
}

/**
 * Lazy variant factory.  Building all 16 masks on every decode was ~97% of the
 * JS decode time; the Axis path usually succeeds with the first variant.  The
 * shared gray/value/integral buffers are still memoised, so eager
 * preprocessVariants() and lazy decodeAuto() share the same code.
 */
export function createPreprocessor(image) {
  const { width, height } = image;
  const minSide = Math.min(width, height);
  const cache = new Map();
  let gray = null;
  let otsu = 0;
  let grayMask = null;
  let grayIntegral = null;
  let value = null;
  let sat = null;
  let valueOtsu = 0;
  let valueMask = null;
  let valueIntegral = null;

  const ensureGray = () => {
    if (gray) return gray;
    gray = grayscale(image);
    otsu = robustThreshold(gray).threshold;
    return gray;
  };

  const ensureGrayMask = () => {
    if (grayMask) return grayMask;
    const src = ensureGray();
    grayMask = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) grayMask[i] = src[i] < otsu ? 1 : 0;
    return grayMask;
  };

  const ensureGrayIntegral = () => {
    if (!grayIntegral) grayIntegral = integralImage(ensureGray(), width, height);
    return grayIntegral;
  };

  const ensureValue = () => {
    if (value) return value;
    value = new Uint8Array(width * height);
    sat = new Float32Array(width * height);
    for (let i = 0, p = 0; i < value.length; i++, p += 3) {
      const r = image.data[p];
      const g = image.data[p + 1];
      const b = image.data[p + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      value[i] = mx;
      sat[i] = mx === 0 ? 0 : (mx - mn) / mx;
    }
    valueOtsu = robustThreshold(value).threshold;
    valueMask = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      valueMask[i] = value[i] < valueOtsu && (sat[i] < 0.5 || value[i] < 80) ? 1 : 0;
    }
    return value;
  };

  const ensureValueIntegral = () => {
    if (!valueIntegral) valueIntegral = integralImage(ensureValue(), width, height);
    return valueIntegral;
  };

  const build = (name) => {
    if (name === 'otsu') {
      return { name, mask: ensureGrayMask(), thresholdAt: () => otsu, gray: ensureGray() };
    }
    if (name === 'otsu+close') {
      return {
        name,
        mask: morphClose(ensureGrayMask(), width, height, 1),
        thresholdAt: () => otsu,
        gray: ensureGray(),
      };
    }
    if (name === 'value-otsu') {
      ensureValue();
      return { name, mask: valueMask, thresholdAt: () => valueOtsu, channel: 'value' };
    }
    if (name === 'value-otsu+close') {
      ensureValue();
      return {
        name,
        mask: morphClose(valueMask, width, height, 1),
        thresholdAt: () => valueOtsu,
        channel: 'value',
      };
    }
    const adaptive = /^(value-)?adaptive-(1\/8|1\/16|1\/4)(\+close)?$/.exec(name);
    if (!adaptive) return null;
    const isValue = !!adaptive[1];
    const kind = adaptive[2];
    const close = !!adaptive[3];
    const window = adaptiveWindow(kind, minSide);
    const offset = ADAPTIVE_CONFIGS.find(([k]) => k === kind)[1];
    const source = isValue ? ensureValue() : ensureGray();
    const integral = isValue ? ensureValueIntegral() : ensureGrayIntegral();
    const { mask, threshold } = adaptiveMask(source, width, height, integral, window, offset);
    let finalMask = mask;
    if (isValue) {
      finalMask = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) {
        finalMask[i] = mask[i] && (sat[i] < 0.5 || value[i] < 80) ? 1 : 0;
      }
    }
    if (close) finalMask = morphClose(finalMask, width, height, 1);
    return {
      name,
      mask: finalMask,
      thresholdAt: thresholdFunction(threshold, width, height),
      gray: isValue ? undefined : gray,
      channel: isValue ? 'value' : undefined,
    };
  };

  return {
    image,
    get(name) {
      if (cache.has(name)) return cache.get(name);
      const variant = build(name);
      if (variant) cache.set(name, variant);
      return variant;
    },
  };
}

export function preprocessVariants(image) {
  const pre = createPreprocessor(image);
  return PREPROCESS_NAMES.map((name) => pre.get(name));
}

export function localMeanFunction(gray, width, height, window) {
  const integral = integralImage(gray, width, height);
  const W = width + 1;
  const r = Math.max(8, Math.floor(window / 2));
  return (x, y) => {
    const xx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const x0 = Math.max(0, xx - r);
    const x1 = Math.min(width, xx + r + 1);
    const y0 = Math.max(0, yy - r);
    const y1 = Math.min(height, yy + r + 1);
    const area = (x1 - x0) * (y1 - y0);
    return (integral[y1 * W + x1] - integral[y0 * W + x1]
      - integral[y1 * W + x0] + integral[y0 * W + x0]) / area;
  };
}

export function meanGray(gray) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return sum / gray.length;
}

export function localStatsFunction(gray, width, height, window) {
  const W = width + 1;
  const I = new Float64Array(W * (height + 1));
  const I2 = new Float64Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSum2 = 0;
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      rowSum += v;
      rowSum2 += v * v;
      I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + rowSum;
      I2[(y + 1) * W + (x + 1)] = I2[y * W + (x + 1)] + rowSum2;
    }
  }
  const r = Math.max(8, Math.floor(window / 2));
  return (x, y) => {
    const xx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const x0 = Math.max(0, xx - r);
    const x1 = Math.min(width, xx + r + 1);
    const y0 = Math.max(0, yy - r);
    const y1 = Math.min(height, yy + r + 1);
    const area = (x1 - x0) * (y1 - y0);
    const sum = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
    const sum2 = I2[y1 * W + x1] - I2[y0 * W + x1] - I2[y1 * W + x0] + I2[y0 * W + x0];
    const mean = sum / area;
    const variance = Math.max(0, sum2 / area - mean * mean);
    return { mean, std: Math.sqrt(variance) };
  };
}
