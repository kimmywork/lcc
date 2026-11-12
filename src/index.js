/**
 * LCC public API.
 */

export { encode, capacityFor, chooseVersionAndScale } from './encoder.js';
export { decode, decodeAuto, detectSymbol, sampleModule } from './decoder.js';
export { detectPerspective, computeHomography, applyHomography } from './detector.js';
export { buildCalibrator } from './calibration.js';
export { generatePalette } from './palettes.js';
export { makeLayout, hilbertOrder } from './layout.js';
export { renderSVG } from './svg.js';
export { LAYERS, LAYER_BY_ID, LEGACY_LAYER_ALIASES, resolveLayerName, SHAPE_LAYER_CODE_BY_NAME, SHAPE_LAYER_NAME_BY_CODE, resolveShapeLayer, ECC_LEVELS, ECC_NAMES, ECC_BY_NAME, eccNameOf, versionToSize, sizeToVersion } from './constants.js';
export { SHAPE_NAMES, foregroundFor, shapeMask, classifyShape, clusterModule, refineBackground } from './shapes.js';
export { stackCanonicalFrames } from './stack.js';
export { RankConstraint } from './constraint.js';
export { rsEncode, rsDecode } from './ecc/rs.js';
export { bch15Encode, bch15Decode } from './ecc/bch15.js';
export { crc32 } from './ecc/crc32.js';
