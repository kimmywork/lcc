/**
 * LCC layer table.
 *
 * The hierarchy is deliberately ordered by channel robustness:
 *   L1  : 2-state black/white
 *   L2a : 4-level gray
 *   L2b : 8-level gray
 *   L3c : 16 max-min DeltaE colors   (camera colour)
 *   L3d : 32 max-min DeltaE colors   (camera colour, controlled)
 *   L4e : 64 max-min DeltaE colors   (clean/digital/print)
 *   L4f : 256 max-min DeltaE colors  (clean/digital/print)
 *
 * File Mode (24-bit) is a separate digital carrier and is not in this table.
 */

export const LAYERS = {
  L1: {
    id: 0,
    name: 'L1',
    kind: 'gray',
    levels: 2,
    paletteSize: 2,
    bitsPerModule: 1,
    ecc: 0.20,
    defaultConstraint: false,
    camera: true,
    description: '2-state black/white',
  },
  L2a: {
    id: 1,
    name: 'L2a',
    kind: 'gray',
    levels: 4,
    paletteSize: 4,
    bitsPerModule: 2,
    ecc: 0.20,
    defaultConstraint: true,
    camera: true,
    description: '4-level equal-L* gray',
  },
  L2b: {
    id: 2,
    name: 'L2b',
    kind: 'gray',
    levels: 8,
    paletteSize: 8,
    bitsPerModule: 3,
    ecc: 0.30,
    defaultConstraint: true,
    camera: true,
    description: '8-level equal-L* gray',
  },
  L3c: {
    id: 3,
    name: 'L3c',
    kind: 'color',
    colors: 16,
    paletteSize: 16,
    bitsPerModule: 4,
    ecc: 0.35,
    defaultConstraint: false,
    camera: true,
    description: '16 max-min DeltaE colors',
  },
  L3d: {
    id: 4,
    name: 'L3d',
    kind: 'color',
    colors: 32,
    paletteSize: 32,
    bitsPerModule: 5,
    ecc: 0.40,
    defaultConstraint: false,
    camera: true,
    description: '32 max-min DeltaE colors',
  },
  L4e: {
    id: 5,
    name: 'L4e',
    kind: 'color',
    colors: 64,
    paletteSize: 64,
    bitsPerModule: 6,
    ecc: 0.40,
    defaultConstraint: true,
    camera: false,
    description: '64 max-min DeltaE colors',
  },
  L4f: {
    id: 6,
    name: 'L4f',
    kind: 'color',
    colors: 256,
    paletteSize: 256,
    bitsPerModule: 8,
    ecc: 0.40,
    defaultConstraint: true,
    camera: false,
    description: '256 max-min DeltaE colors',
  },
};

export const LAYER_BY_ID = new Map(Object.values(LAYERS).map((l) => [l.id, l]));

export const ECC_LEVELS = [0.20, 0.30, 0.35, 0.40];
export const ECC_NAMES = ['L', 'M', 'Q', 'H'];
export const ECC_BY_NAME = new Map(ECC_NAMES.map((name, i) => [name, ECC_LEVELS[i]]));

export function eccNameOf(ecc) {
  const i = ECC_LEVELS.indexOf(ecc);
  return i >= 0 ? ECC_NAMES[i] : null;
}

export const PALETTE_MODES = ['maxmin', 'harmony'];

export const CONSTRAINT_BLOCK = 64;

export function layerRankCount(layer) {
  return layer.kind === 'gray' ? layer.levels : 16;
}

export function layerMaxRankDiff(layer) {
  return Math.floor(layerRankCount(layer) / 2);
}

export const MIN_MODULE_PX = 4;
export const MAX_MODULE_PX = 64;

export const QUIET_ZONE = {
  screen: 2,
  print: 4,
};

export const VERSION_MIN = 1;
export const VERSION_MAX = 100;

/** Symbol side length in modules, excluding quiet zone. */
export function versionToSize(version) {
  return 21 + 4 * (version - 1);
}

export function sizeToVersion(n) {
  const v = Math.round((n - 21) / 4) + 1;
  return versionToSize(v) === n ? v : null;
}

export const FRAME_MAGIC = 0x4c43; // "LC"
export const FRAME_VERSION = 1;

export const FLAG_CONSTRAINT = 0x01;
export const FLAG_COMPRESSED = 0x02;
export const FLAG_ENCRYPTED = 0x04;

export const FRAME_HEADER_SIZE = 13;
