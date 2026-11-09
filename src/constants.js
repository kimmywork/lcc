/**
 * LCC (Layered Chromatic Code) constants.
 *
 * The layered table is intentionally small and explicit.  Everything that
 * affects the wire format is versioned here so encoder and decoder cannot
 * silently drift apart.
 */

export const LAYERS = {
  L1: {
    id: 0,
    name: 'L1',
    bitsPerModule: 1,
    paletteSize: 2,
    ecc: 0.20,
    defaultConstraint: false,
    description: '2-state black/white, maximum robustness',
  },
  L2: {
    id: 1,
    name: 'L2',
    bitsPerModule: 4,
    paletteSize: 16,
    ecc: 0.35,
    defaultConstraint: true,
    description: '16 equal-L* gray levels',
  },
  L3a: {
    id: 2,
    name: 'L3a',
    bitsPerModule: 6,
    paletteSize: 64,
    ecc: 0.40,
    defaultConstraint: true,
    description: '64 nominal CMYK-gamut colors',
  },
  L3b: {
    id: 3,
    name: 'L3b',
    bitsPerModule: 8,
    paletteSize: 256,
    ecc: 0.40,
    defaultConstraint: true,
    description: '256 sRGB colors',
  },
};

export const LAYER_BY_ID = new Map(Object.values(LAYERS).map((l) => [l.id, l]));

export const ECC_LEVELS = [0.20, 0.35, 0.40, 0.50];
export const ECC_BITS = new Map(ECC_LEVELS.map((r, i) => [r, i]));

export const PALETTE_MODES = ['bucketed', 'global'];
export const PALETTE_MODE_BITS = new Map(PALETTE_MODES.map((m, i) => [m, i]));

export const RANK_COUNT = 16;
export const RANK_MAX_DIFF = 8;
export const CONSTRAINT_BLOCK = 64;

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
