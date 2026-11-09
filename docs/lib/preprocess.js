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

export function preprocessVariants(image) {
  const { width, height } = image;
  const gray = grayscale(image);
  const stats = robustThreshold(gray);
  const otsu = stats.threshold;

  const otsuMask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) otsuMask[i] = gray[i] < otsu ? 1 : 0;

  const variants = [];
  variants.push({
    name: 'otsu',
    mask: otsuMask,
    thresholdAt: () => otsu,
    gray,
  });
  variants.push({
    name: 'otsu+close',
    mask: morphClose(otsuMask, width, height, 1),
    thresholdAt: () => otsu,
    gray,
  });

  const integral = integralImage(gray, width, height);
  const minSide = Math.min(width, height);
  const configs = [
    ['adaptive-1/8', Math.max(15, Math.floor(minSide / 8)), 0.15],
    ['adaptive-1/16', Math.max(11, Math.floor(minSide / 16)), 0.10],
    ['adaptive-1/4', Math.max(21, Math.floor(minSide / 4)), 0.20],
  ];
  for (const [name, window, offset] of configs) {
    const { mask, threshold } = adaptiveMask(gray, width, height, integral, window, offset);
    const thresholdAt = thresholdFunction(threshold, width, height);
    variants.push({ name, mask, thresholdAt, gray });
    variants.push({
      name: `${name}+close`,
      mask: morphClose(mask, width, height, 1),
      thresholdAt,
      gray,
    });
  }
  return variants;
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
