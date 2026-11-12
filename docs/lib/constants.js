/**
 * LCC layer table.
 *
 * Canonical names encode the two channel dimensions:
 *   G<color bits><shape bits>   grayscale (G)
 *   C<color bits><shape bits>   chromatic (C)
 *
 * The first number is log2(palette size); the second is log2(shape set size).
 * A trailing 0 means "no shape pattern".  Examples:
 *   G13 = 2-state black/white (1 bit) + 8 shapes (3 bits) = 4 bit/module
 *   C35 = 8 max-min colors (3 bits) + 32 shapes (5 bits)  = 8 bit/module
 *   C80 = 256 max-min colors (8 bits), no shapes           = 8 bit/module
 *
 * Legacy L* names are kept as aliases (see LEGACY_LAYER_ALIASES) so existing
 * documents, corpus manifests and scripts keep working.
 *
 * File Mode (24-bit) is a separate digital carrier and is not in this table.
 */

export const LAYERS = {
  // --- base layers: no shape pattern, normal 3-bit mode ids -----------------
  G10: {
    id: 0,
    name: 'G10',
    legacyName: 'L1',
    kind: 'gray',
    levels: 2,
    paletteSize: 2,
    bitsPerModule: 1,
    ecc: 0.20,
    defaultConstraint: false,
    camera: true,
    description: '2-state black/white',
  },
  G20: {
    id: 1,
    name: 'G20',
    legacyName: 'L2a',
    kind: 'gray',
    levels: 4,
    paletteSize: 4,
    bitsPerModule: 2,
    ecc: 0.20,
    defaultConstraint: true,
    camera: true,
    description: '4-level equal-L* gray',
  },
  G30: {
    id: 2,
    name: 'G30',
    legacyName: 'L2b',
    kind: 'gray',
    levels: 8,
    paletteSize: 8,
    bitsPerModule: 3,
    ecc: 0.30,
    defaultConstraint: true,
    camera: true,
    description: '8-level equal-L* gray',
  },
  C40: {
    id: 3,
    name: 'C40',
    legacyName: 'L3c',
    kind: 'color',
    colors: 16,
    paletteSize: 16,
    bitsPerModule: 4,
    ecc: 0.35,
    defaultConstraint: false,
    camera: true,
    description: '16 max-min DeltaE colors',
  },
  C50: {
    id: 4,
    name: 'C50',
    legacyName: 'L3d',
    kind: 'color',
    colors: 32,
    paletteSize: 32,
    bitsPerModule: 5,
    ecc: 0.40,
    defaultConstraint: false,
    camera: true,
    description: '32 max-min DeltaE colors',
  },
  C60: {
    id: 5,
    name: 'C60',
    legacyName: 'L4e',
    kind: 'color',
    colors: 64,
    paletteSize: 64,
    bitsPerModule: 6,
    ecc: 0.40,
    defaultConstraint: true,
    camera: false,
    description: '64 max-min DeltaE colors',
  },
  C80: {
    id: 6,
    name: 'C80',
    legacyName: 'L4f',
    kind: 'color',
    colors: 256,
    paletteSize: 256,
    bitsPerModule: 8,
    ecc: 0.40,
    defaultConstraint: true,
    camera: false,
    description: '256 max-min DeltaE colors',
  },

  // --- shape-escape layers: mode=7 + layer code ----------------------------
  // The code is (shapeExt, shapeLayerId, shapeVariant).  shapeVariant is the
  // low two bits of the format seed field.  Shape layers use a fixed whitening
  // seed of 0.  The explicit code table is below.
  C30: {
    id: 7,
    name: 'C30',
    legacyName: 'L3b',
    kind: 'color',
    colors: 8,
    paletteSize: 8,
    bitsPerModule: 3,
    ecc: 0.30,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 1,
    shapeLayerId: 0,
    shapeExt: 0,
    minVersion: 2,
    minModulePx: 8,
    description: '8 max-min colors, no pattern',
  },
  C20: {
    id: 7,
    name: 'C20',
    kind: 'color',
    colors: 4,
    paletteSize: 4,
    bitsPerModule: 2,
    ecc: 0.20,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 1,
    shapeLayerId: 1,
    shapeExt: 1,
    shapeVariant: 1,
    minVersion: 2,
    minModulePx: 8,
    description: '4 max-min colors, no pattern',
  },

  C23: {
    id: 7,
    name: 'C23',
    kind: 'color',
    colors: 4,
    paletteSize: 4,
    bitsPerModule: 5,
    ecc: 0.20,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 8,
    shapeLayerId: 1,
    shapeExt: 1,
    shapeVariant: 2,
    minVersion: 2,
    minModulePx: 12,
    description: '4 max-min colors + 8 shapes',
  },

  // --- 8-shape family ------------------------------------------------------
  G13: {
    id: 7,
    name: 'G13',
    legacyName: 'L1s',
    kind: 'gray',
    levels: 2,
    paletteSize: 2,
    bitsPerModule: 4,
    ecc: 0.20,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 8,
    shapeLayerId: 1,
    shapeExt: 0,
    minVersion: 2,
    minModulePx: 12,
    description: '2-state B/W + 8 shapes',
  },
  G23: {
    id: 7,
    name: 'G23',
    legacyName: 'L2s',
    kind: 'gray',
    levels: 4,
    paletteSize: 4,
    bitsPerModule: 5,
    ecc: 0.20,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 8,
    shapeLayerId: 2,
    shapeExt: 0,
    minVersion: 2,
    minModulePx: 12,
    description: '4-level gray + 8 shapes',
  },
  G33: {
    id: 7,
    name: 'G33',
    kind: 'gray',
    levels: 8,
    paletteSize: 8,
    bitsPerModule: 6,
    ecc: 0.30,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 8,
    shapeLayerId: 2,
    shapeExt: 0,
    shapeVariant: 1,
    minVersion: 2,
    minModulePx: 12,
    description: '8-level gray + 8 shapes',
  },
  C33: {
    id: 7,
    name: 'C33',
    legacyName: 'L3s',
    kind: 'color',
    colors: 8,
    paletteSize: 8,
    bitsPerModule: 6,
    ecc: 0.30,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 8,
    shapeLayerId: 3,
    shapeExt: 0,
    minVersion: 2,
    minModulePx: 12,
    description: '8 max-min colors + 8 shapes',
  },
  C35: {
    id: 7,
    name: 'C35',
    kind: 'color',
    colors: 8,
    paletteSize: 8,
    bitsPerModule: 8,
    ecc: 0.30,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 3,
    shapeExt: 0,
    shapeVariant: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '8 max-min colors + 32 shapes',
  },
  C43: {
    id: 7,
    name: 'C43',
    legacyName: 'L3t',
    kind: 'color',
    colors: 16,
    paletteSize: 16,
    bitsPerModule: 7,
    ecc: 0.35,
    defaultConstraint: false,
    camera: true,
    shapeSetSize: 8,
    shapeLayerId: 3,
    shapeExt: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '16 max-min colors + 8 shapes',
  },
  C53: {
    id: 7,
    name: 'C53',
    kind: 'color',
    colors: 32,
    paletteSize: 32,
    bitsPerModule: 8,
    ecc: 0.35,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 8,
    shapeLayerId: 2,
    shapeExt: 1,
    shapeVariant: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '32 max-min colors + 8 shapes',
  },
  C63: {
    id: 7,
    name: 'C63',
    kind: 'color',
    colors: 64,
    paletteSize: 64,
    bitsPerModule: 9,
    ecc: 0.40,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 8,
    shapeLayerId: 2,
    shapeExt: 1,
    shapeVariant: 2,
    minVersion: 2,
    minModulePx: 16,
    description: '64 max-min colors + 8 shapes',
  },
  C83: {
    id: 7,
    name: 'C83',
    kind: 'color',
    colors: 256,
    paletteSize: 256,
    bitsPerModule: 11,
    ecc: 0.40,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 8,
    shapeLayerId: 2,
    shapeExt: 1,
    shapeVariant: 3,
    minVersion: 4,
    minModulePx: 16,
    description: '256 max-min colors + 8 shapes',
  },

  // --- 32-shape family -----------------------------------------------------
  G15: {
    id: 7,
    name: 'G15',
    legacyName: 'L1u',
    kind: 'gray',
    levels: 2,
    paletteSize: 2,
    bitsPerModule: 6,
    ecc: 0.20,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 0,
    shapeExt: 1,
    shapeVariant: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '2-state B/W + 32 shapes',
  },
  G25: {
    id: 7,
    name: 'G25',
    kind: 'gray',
    levels: 4,
    paletteSize: 4,
    bitsPerModule: 7,
    ecc: 0.20,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 0,
    shapeExt: 1,
    shapeVariant: 3,
    minVersion: 2,
    minModulePx: 16,
    description: '4-level gray + 32 shapes',
  },
  G35: {
    id: 7,
    name: 'G35',
    legacyName: 'L2u',
    kind: 'gray',
    levels: 8,
    paletteSize: 8,
    bitsPerModule: 8,
    ecc: 0.30,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 0,
    shapeExt: 1,
    shapeVariant: 2,
    minVersion: 2,
    minModulePx: 16,
    description: '8-level gray + 32 shapes',
  },
  C25: {
    id: 7,
    name: 'C25',
    kind: 'color',
    colors: 4,
    paletteSize: 4,
    bitsPerModule: 7,
    ecc: 0.30,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 1,
    shapeExt: 1,
    shapeVariant: 3,
    minVersion: 2,
    minModulePx: 16,
    description: '4 max-min colors + 32 shapes',
  },
  C45: {
    id: 7,
    name: 'C45',
    kind: 'color',
    colors: 16,
    paletteSize: 16,
    bitsPerModule: 9,
    ecc: 0.35,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 3,
    shapeExt: 1,
    shapeVariant: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '16 max-min colors + 32 shapes',
  },
  C55: {
    id: 7,
    name: 'C55',
    legacyName: 'L3u',
    kind: 'color',
    colors: 32,
    paletteSize: 32,
    bitsPerModule: 10,
    ecc: 0.35,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 0,
    shapeExt: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '32 max-min colors + 32 shapes',
  },
  C65: {
    id: 7,
    name: 'C65',
    legacyName: 'L4eS',
    kind: 'color',
    colors: 64,
    paletteSize: 64,
    bitsPerModule: 11,
    ecc: 0.40,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 1,
    shapeExt: 1,
    minVersion: 2,
    minModulePx: 16,
    description: '64 max-min colors + 32 shapes',
  },
  C85: {
    id: 7,
    name: 'C85',
    legacyName: 'L4fS',
    kind: 'color',
    colors: 256,
    paletteSize: 256,
    bitsPerModule: 13,
    ecc: 0.40,
    defaultConstraint: false,
    camera: false,
    shapeSetSize: 32,
    shapeLayerId: 2,
    shapeExt: 1,
    minVersion: 4,
    minModulePx: 16,
    description: '256 max-min colors + 32 shapes',
  },
};

// Complete legacy mapping.  Keep this table even after the UI/docs move to
// canonical names, so old manifests and user scripts remain readable.
export const LEGACY_LAYER_ALIASES = new Map([
  ['L1', 'G10'],
  ['L2a', 'G20'],
  ['L2b', 'G30'],
  ['L3b', 'C30'],
  ['L3c', 'C40'],
  ['L3d', 'C50'],
  ['L4e', 'C60'],
  ['L4f', 'C80'],
  ['L1s', 'G13'],
  ['L2s', 'G23'],
  ['L3s', 'C33'],
  ['L3t', 'C43'],
  ['L1u', 'G15'],
  ['L2u', 'G35'],
  ['L3u', 'C55'],
  ['L4eS', 'C65'],
  ['L4fS', 'C85'],
]);

export function resolveLayerName(name) {
  if (!name) return name;
  return LEGACY_LAYER_ALIASES.get(name) ?? name;
}

// Keep legacy `LAYERS['L1']` lookups working without putting aliases into
// canonical enumeration (Object.keys/values/entries).  This matters for
// scripts that inspect LAYERS to build palette tables or UI lists.
for (const [legacy, canonical] of LEGACY_LAYER_ALIASES) {
  Object.defineProperty(LAYERS, legacy, {
    value: LAYERS[canonical],
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

// Legacy view: the original 8-shape slot ids, now pointing at canonical names.
export const SHAPE_LAYER_BY_ID = new Map([
  [0, 'C30'],
  [1, 'G13'],
  [2, 'G23'],
  [3, 'C33'],
]);

// Shape layers use the mode=7 escape and are not addressable by a 3-bit mode
// id.  Keep LAYER_BY_ID for the normal layers only.
export const LAYER_BY_ID = new Map(
  Object.values(LAYERS).filter((l) => !l.shapeSetSize).map((l) => [l.id, l]),
);

// Shape-escape code table: [shapeExt, shapeLayerId, shapeVariant] -> name.
// Variant 0 preserves the original 8 shape-layer codes.  The remaining slots
// cover the complete grayscale/color x 0/8/32 symbol matrix.
export const SHAPE_LAYER_CODE_BY_NAME = new Map([
  ['C30', [0, 0, 0]],
  ['G13', [0, 1, 0]],
  ['G23', [0, 2, 0]],
  ['G33', [0, 2, 1]],
  ['C33', [0, 3, 0]],
  ['C35', [0, 3, 1]],
  ['C55', [1, 0, 0]],
  ['G15', [1, 0, 1]],
  ['G35', [1, 0, 2]],
  ['G25', [1, 0, 3]],
  ['C65', [1, 1, 0]],
  ['C20', [1, 1, 1]],
  ['C23', [1, 1, 2]],
  ['C25', [1, 1, 3]],
  ['C85', [1, 2, 0]],
  ['C53', [1, 2, 1]],
  ['C63', [1, 2, 2]],
  ['C83', [1, 2, 3]],
  ['C43', [1, 3, 0]],
  ['C45', [1, 3, 1]],
]);

export const SHAPE_LAYER_NAME_BY_CODE = new Map(
  Array.from(SHAPE_LAYER_CODE_BY_NAME, ([name, code]) => [code.join(','), name]),
);

export const SHAPE_LAYER_IDS = [0, 1, 2, 3];

export function resolveShapeLayer(shapeLayerId, shapeExt = 0, shapeVariant = 0) {
  return SHAPE_LAYER_NAME_BY_CODE.get(`${shapeExt},${shapeLayerId},${shapeVariant}`) ?? null;
}

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
