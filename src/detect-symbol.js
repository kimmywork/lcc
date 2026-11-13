/**
 * Finder / geometry detection backed by lcc-decoder.wasm.
 *
 * `sampleModule` remains a small bilinear sampling helper for callers that
 * already have a module grid; it does not detect or decode anything.
 */

import { detectPerspectiveWasm, detectSymbolWasm } from './lcc-wasm.js';
import { sampleImage, validateImage } from './image-utils.js';

export function detectSymbol(image, options = {}) {
  validateImage(image);
  return detectSymbolWasm(image, options);
}

export function detectPerspective(image, options = {}) {
  validateImage(image);
  return detectPerspectiveWasm(image, options);
}

export function sampleModule(image, originX, originY, s, row, col) {
  const cx = originX + (col + 0.5) * s;
  const cy = originY + (row + 0.5) * s;
  const radius = Math.max(0, Math.floor(s / 4) - 1);
  return sampleImage(image, cx, cy, radius);
}
