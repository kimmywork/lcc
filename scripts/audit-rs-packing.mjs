#!/usr/bin/env node
/**
 * Audit how many data modules each GF(256) byte touches.
 *
 * The encoder packs module bits sequentially into the RS byte stream.  A
 * module that spans a byte boundary can corrupt more than one RS symbol; this
 * script measures that effect for every layer/version.
 *
 *   node scripts/audit-rs-packing.mjs
 */

import { LAYERS } from '../src/constants.js';
import { makeLayout } from '../src/layout.js';
import { generatePalette } from '../src/palettes.js';
import { computeRSBlocks } from '../src/ecc/rs.js';

const LAYERS_TO_CHECK = ['L1', 'L2a', 'L2b', 'L3b', 'L3c', 'L3d', 'L3s', 'L3t', 'L3u', 'L4eS', 'L4fS'];
const VERSIONS = [4, 10, 20];

const rows = [];
for (const layerName of LAYERS_TO_CHECK) {
  const layer = LAYERS[layerName];
  for (const version of VERSIONS) {
    const palette = generatePalette(layerName, { mode: 'maxmin' });
    const layout = makeLayout({ version, layer: layerName, paletteMode: 'maxmin', paletteInfo: palette });
    const D = layout.dataCount;
    const bits = layerName === 'L1' ? 1 : layer.bitsPerModule;
    const totalBits = D * bits;
    const S = Math.floor(totalBits / 8);
    const blocks = computeRSBlocks(S, layer.ecc);
    const byteCounts = new Array(S).fill(0);
    let sumSpan = 0;
    let maxSpan = 0;
    for (let i = 0; i < D; i++) {
      const a = i * bits;
      const b = a + bits - 1;
      const b0 = Math.floor(a / 8);
      const b1 = Math.floor(b / 8);
      const span = b1 - b0 + 1;
      sumSpan += span;
      if (span > maxSpan) maxSpan = span;
      for (let k = b0; k <= b1 && k < S; k++) byteCounts[k]++;
    }
    rows.push({
      layer: layerName,
      version,
      N: layout.N,
      dataModules: D,
      bitsPerModule: bits,
      rsBytes: S,
      avgModulesPerByte: Number((sumSpan / D).toFixed(2)),
      maxModulesPerByte: maxSpan,
      avgModulesPerSymbol: Number((byteCounts.reduce((a, b) => a + b, 0) / Math.max(1, S)).toFixed(2)),
      blocks: blocks.map((b) => `${b.n}/${b.k}`),
    });
  }
}

console.log(JSON.stringify(rows, null, 2));
