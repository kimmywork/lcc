/**
 * LCC encoder public wrapper.
 *
 * The encoding pipeline (frame, whitening, RS, constraint mapping, layout,
 * format band and rendering) lives in lcc-encoder.wasm.  This module only
 * translates the JavaScript option object into the wasm request and turns the
 * packed result back into the documented object shape.
 */

import { LAYERS, resolveLayerName } from './constants.js';
import {
  capacityForWasm,
  encodeWasm,
} from './lcc-encoder-wasm.js';

function canonicalLayer(name) {
  const resolved = resolveLayerName(name ?? 'G10');
  return resolved ?? name;
}

function intOption(value, name, min, max) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`LCC: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateOptions(options) {
  const layerName = options.layer ?? 'G10';
  const layer = LAYERS[canonicalLayer(layerName)];
  if (!layer) throw new Error(`LCC: unknown layer ${layerName}`);
  intOption(options.width, 'width', 1, 32768);
  intOption(options.height, 'height', 1, 32768);
  intOption(options.quietZone, 'quietZone', 0, 64);
  intOption(options.minModulePx, 'minModulePx', 1, 64);
  intOption(options.maxModulePx, 'maxModulePx', 1, 64);
  intOption(options.moduleSize, 'moduleSize', 1, 64);
  intOption(options.minVersion, 'minVersion', 1, 100);
  intOption(options.maxVersion, 'maxVersion', 1, 100);
  intOption(options.version, 'version', 1, 100);
  intOption(options.seed, 'seed', 0, 63);
  if (options.mode !== undefined && options.mode !== 'fill' && options.mode !== 'compact') {
    throw new Error('LCC: mode must be fill or compact');
  }
  if (options.paletteMode !== undefined && options.paletteMode !== 'maxmin' && options.paletteMode !== 'harmony') {
    throw new Error('LCC: paletteMode must be maxmin or harmony');
  }
  if (options.eccLevel !== undefined && options.eccLevel !== null && options.eccLevel !== 'auto') {
    if (typeof options.eccLevel === 'string') {
      if (!['L', 'M', 'Q', 'H'].includes(options.eccLevel.toUpperCase())) {
        throw new Error('LCC: eccLevel must be auto/L/M/Q/H');
      }
    } else if (![0.20, 0.30, 0.35, 0.40].includes(options.eccLevel)) {
      throw new Error('LCC: eccLevel must be auto/L/M/Q/H');
    }
  }
  const minVersion = options.minVersion ?? 1;
  const maxVersion = options.maxVersion ?? 100;
  if (maxVersion < minVersion) throw new Error('LCC: invalid version range');
  return layer;
}

export function encode(payload, options = {}) {
  validateOptions(options);
  const layer = canonicalLayer(options.layer);
  const result = encodeWasm(payload, { ...options, layer });
  const layerInfo = LAYERS[layer];
  result.meta.layer = layer;
  result.meta.legacyLayer = layerInfo?.legacyName ?? null;
  result.layout.layer = layer;
  result.paletteInfo.layer = layer;
  result.paletteInfo.kind = layerInfo?.kind ?? null;
  result.paletteInfo.levels = layerInfo?.levels ?? null;
  result.paletteInfo.colors = layerInfo?.colors ?? null;
  return result;
}

export function capacityFor(layout, layerName, paletteInfo, constraint, ecc = undefined) {
  const layer = canonicalLayer(layerName);
  const cap = capacityForWasm(layout, layer, constraint, ecc);
  return { ...cap, ecc: cap.ecc };
}

export function chooseVersionAndScale(args) {
  const payload = new Uint8Array(Math.max(0, args.payloadSize ?? 0));
  const result = encode(payload, {
    layer: args.layerName,
    width: args.width,
    height: args.height,
    mode: args.mode,
    minModulePx: args.minModulePx,
    maxModulePx: args.maxModulePx,
    quietZone: args.quietZone,
    minVersion: args.minVersion,
    maxVersion: args.maxVersion,
    eccLevel: args.baseEcc,
    boostEcc: args.boostEcc,
    moduleSize: args.moduleSize,
    paletteMode: args.paletteMode ?? (args.harmony ? 'harmony' : 'maxmin'),
    harmony: args.harmony,
    constraint: args.constraint,
  });
  return {
    version: result.meta.version,
    layout: result.layout,
    cap: {
      D: result.meta.dataCount,
      capacityBits: result.meta.capacityBits,
      S: result.meta.rsSymbols,
      kTotal: result.meta.rsSymbols,
      payloadCapacity: result.meta.payloadCapacity,
      ecc: result.meta.ecc,
    },
    moduleSize: result.meta.moduleSize,
    ecc: result.meta.ecc,
  };
}
