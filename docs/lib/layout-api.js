/**
 * Layout / palette helpers backed by lcc-encoder.wasm.
 *
 * These keep the JavaScript-facing API (`makeLayout`, `generatePalette`)
 * available without maintaining a second implementation of the layout and
 * palette tables.
 */

import { LAYERS, resolveLayerName } from './constants.js';
import { generatePaletteWasm, makeLayoutWasm } from './lcc-encoder-wasm.js';

export function generatePalette(layerName, options = {}) {
  const layer = resolveLayerName(layerName) ?? layerName;
  if (!LAYERS[layer]) throw new Error(`Unknown layer: ${layerName}`);
  const mode = options.mode ?? 'maxmin';
  const harmony = options.harmony ?? false;
  const info = generatePaletteWasm(layer, { mode, harmony });
  const layerInfo = LAYERS[layer];
  return {
    ...info,
    layer,
    kind: layerInfo.kind,
    levels: layerInfo.levels ?? null,
    colors: layerInfo.colors ?? null,
    mode,
    harmony,
  };
}

export function makeLayout({ version, layer, paletteMode = 'maxmin', harmony = false }) {
  const resolved = resolveLayerName(layer) ?? layer;
  if (!LAYERS[resolved]) throw new Error(`Unknown layer: ${layer}`);
  const { layout, paletteInfo } = makeLayoutWasm({
    version,
    layer: resolved,
    paletteMode,
    harmony,
  });
  layout.paletteInfo = paletteInfo;
  return layout;
}

export function clearPaletteCache() {
  /* Tables live in wasm; nothing to clear. */
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export function hilbertD2XY(n, d) {
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

export function hilbertOrder(n) {
  const p = nextPowerOfTwo(n);
  const out = [];
  for (let d = 0; d < p * p; d++) {
    const [x, y] = hilbertD2XY(p, d);
    if (x < n && y < n) out.push([y, x]);
  }
  return out;
}
