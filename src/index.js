/**
 * LCC public API.
 */

export { encode, capacityFor, chooseVersionAndScale } from './encoder.js';
export { decode, decodeAuto } from './decoder.js';
export { detectSymbol, detectPerspective, sampleModule } from './detect-symbol.js';
export { computeHomography, applyHomography } from './detector.js';
export { buildCalibrator } from './calibration.js';
export { generatePalette, makeLayout, hilbertOrder } from './layout-api.js';
export { renderSVG } from './svg.js';
export { LAYERS, LAYER_BY_ID, LEGACY_LAYER_ALIASES, SHAPE_LAYER_BY_ID, resolveLayerName, SHAPE_LAYER_CODE_BY_NAME, SHAPE_LAYER_NAME_BY_CODE, resolveShapeLayer, ECC_LEVELS, ECC_NAMES, ECC_BY_NAME, eccNameOf, versionToSize, sizeToVersion } from './constants.js';
export { SHAPE_NAMES, foregroundFor, shapeMask, classifyShape, clusterModule, refineBackground } from './shapes.js';
export { stackCanonicalFrames } from './stack.js';
