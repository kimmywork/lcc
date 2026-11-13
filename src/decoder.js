/**
 * LCC decoder public wrapper.
 *
 * The decode path is lcc-decoder.wasm.  `detectSymbol` / `sampleModule` are a
 * small JavaScript helper used by the multi-frame stacker and benchmarks; they
 * do not decode payloads.
 */

import { decodeAutoWasm, decodeExplicitWasm } from './lcc-wasm.js';
import { detectSymbol, sampleModule } from './detect-symbol.js';
import { MAX_IMAGE_PIXELS } from './image-utils.js';

export { detectSymbol, sampleModule };

function validateImage(image) {
  if (!image || typeof image !== 'object') throw new Error('LCC: invalid image');
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('LCC: invalid image dimensions');
  }
  const pixels = width * height;
  if (pixels > MAX_IMAGE_PIXELS) throw new Error('LCC: image too large');
  if (!data || typeof data.length !== 'number' || data.length !== pixels * 3) {
    throw new Error('LCC: image data length does not match dimensions');
  }
}

function finish(result, options) {
  if (!result) {
    throw new Error('LCC decode failed');
  }
  return result;
}

export function decode(image, options = {}) {
  validateImage(image);
  if (options.sampler) {
    throw new Error('LCC decode: custom samplers are not supported by the wasm decoder');
  }
  if (options.moduleSize && options.version && options.origin) {
    return finish(decodeExplicitWasm(image, {
      originX: options.origin.x,
      originY: options.origin.y,
      moduleSize: options.moduleSize,
      version: options.version,
      threshold: options.threshold ?? 128,
    }), options);
  }
  const mode = options.detector ?? 'axis';
  return finish(decodeAutoWasm(image, { detector: mode }), options);
}

export function decodeAuto(image, options = {}) {
  validateImage(image);
  const detector = options.detector === 'axis' || options.detector === 'perspective'
    ? options.detector
    : 'auto';
  return finish(decodeAutoWasm(image, { detector }), options);
}
