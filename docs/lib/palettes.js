/**
 * Palette construction for LCC.
 *
 * Two modes are supported:
 *   - "bucketed": the 16 equal-L* grays are indices 0..15; the remaining
 *     colors are selected per luminance bucket so the palette is spread
 *     evenly over the luminance axis.  This is the default because it works
 *     best with the reversible luminance-rank constraint.
 *   - "global": the 16 grays are indices 0..15; the remaining colors are
 *     selected by global max-min DeltaE.  Better raw color separation, but
 *     a less even luminance distribution.
 *
 * Both modes keep the L2 gray palette as the first 16 entries, so the index
 * nesting rule (L2 subset of L3) always holds.
 */

import { deltaE76, generateGrayPalette, rgbToLab } from './color.js';
import { LAYERS } from './constants.js';

const cache = new Map();

function keyOf(layerName, mode, harmony) {
  return `${layerName}|${mode}|${harmony ? 1 : 0}`;
}

function uniqueCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const rgb of list) {
    const k = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ rgb, lab: rgbToLab(rgb) });
  }
  return out;
}

function srgbCandidates() {
  const list = [];
  for (let r = 0; r <= 255; r += 16) {
    for (let g = 0; g <= 255; g += 16) {
      for (let b = 0; b <= 255; b += 16) {
        list.push([r, g, b]);
      }
    }
  }
  // Dense dark/bright ramps: the extreme luminance buckets are small in
  // sRGB, so a 16-step grid alone cannot supply enough distinct variants.
  const ramp = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 112, 128,
    144, 160, 176, 192, 208, 216, 224, 232, 240, 248, 252, 255];
  for (const r of ramp) {
    for (const g of ramp) {
      list.push([r, g, 0]);
      list.push([r, g, 255]);
    }
  }
  for (const r of ramp) {
    for (const b of ramp) {
      list.push([r, 0, b]);
      list.push([r, 255, b]);
    }
  }
  for (const g of ramp) {
    for (const b of ramp) {
      list.push([0, g, b]);
      list.push([255, g, b]);
    }
  }
  return uniqueCandidates(list);
}

function cmykCandidates() {
  const list = [];
  const inks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const blacks = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
  for (const c of inks) {
    for (const m of inks) {
      for (const y of inks) {
        for (const k of blacks) {
          const r = Math.round(255 * (1 - c) * (1 - k));
          const g = Math.round(255 * (1 - m) * (1 - k));
          const b = Math.round(255 * (1 - y) * (1 - k));
          list.push([r, g, b]);
        }
      }
    }
  }
  return uniqueCandidates(list);
}

function rgbHue([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function harmonyFilter(candidates, centerHue = 30, arc = 60) {
  return candidates.filter((c) => {
    const h = rgbHue(c.rgb);
    if (h === null) return true; // keep neutral colors
    const d = Math.min(Math.abs(h - centerHue), 360 - Math.abs(h - centerHue));
    return d <= arc;
  });
}

function greedySelect(candidates, count, seeds, used) {
  const selected = seeds.slice();
  const minDist = new Float64Array(candidates.length).fill(Infinity);
  for (let i = 0; i < candidates.length; i++) {
    if (used[i]) continue;
    for (const s of seeds) {
      const d = deltaE76(candidates[i].lab, s.lab);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  while (selected.length < count) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (used[i]) continue;
      if (minDist[i] > bestD) {
        bestD = minDist[i];
        best = i;
      }
    }
    if (best < 0) break;
    used[best] = 1;
    const chosen = candidates[best];
    selected.push(chosen);
    for (let i = 0; i < candidates.length; i++) {
      if (used[i]) continue;
      const d = deltaE76(candidates[i].lab, chosen.lab);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  return selected;
}

function nearestRank(lab, grayLab) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < grayLab.length; i++) {
    const g = grayLab[i];
    const d = (lab[0] - g[0]) ** 2 + (lab[1] - g[1]) ** 2 + (lab[2] - g[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function selectBucketed(candidates, paletteSize, grayPalette, grayLab) {
  const buckets = new Array(grayPalette.length);
  for (let i = 0; i < grayPalette.length; i++) buckets[i] = [];
  for (const c of candidates) {
    buckets[nearestRank(c.lab, grayLab)].push(c);
  }

  const perBucket = Math.floor(paletteSize / grayPalette.length);
  const selected = grayPalette.map((rgb, i) => ({ rgb, lab: grayLab[i] }));
  const used = new Set();
  const add = (c) => {
    const k = (c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2];
    if (used.has(k)) return false;
    used.add(k);
    selected.push(c);
    return true;
  };
  for (const g of selected) used.add((g.rgb[0] << 16) | (g.rgb[1] << 8) | g.rgb[2]);

  const deficits = [];
  for (let b = 0; b < grayPalette.length; b++) {
    const pool = buckets[b];
    const seed = [{ rgb: grayPalette[b], lab: grayLab[b] }];
    const usedLocal = new Uint8Array(pool.length);
    // Mark the gray itself if it appears in the pool.
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].rgb[0] === grayPalette[b][0] &&
          pool[i].rgb[1] === grayPalette[b][1] &&
          pool[i].rgb[2] === grayPalette[b][2]) {
        usedLocal[i] = 1;
      }
    }
    const picked = greedySelect(pool, perBucket, seed, usedLocal);
    let added = 1;
    for (let i = 1; i < picked.length; i++) {
      if (add(picked[i])) added++;
    }
    if (added < perBucket) deficits.push(perBucket - added);
  }

  let deficit = paletteSize - selected.length;
  if (deficit > 0) {
    const remaining = candidates.filter((c) => {
      const k = (c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2];
      return !used.has(k);
    });
    const usedGlobal = new Uint8Array(remaining.length);
    const extra = greedySelect(remaining, deficit, selected, usedGlobal);
    for (let i = selected.length; i < extra.length; i++) add(extra[i]);
  }

  // If the candidate pool was still too small, fill deterministically with
  // near-duplicate colors so the symbol table size is exact.  This only
  // happens for very small candidate sets (harmony mode) and is documented.
  let guard = 0;
  while (selected.length < paletteSize && guard < paletteSize * 8) {
    const base = selected[selected.length % 16] ?? selected[0];
    const n = guard++;
    add({
      rgb: [base.rgb[0], base.rgb[1], (base.rgb[2] + n) % 256],
      lab: rgbToLab([base.rgb[0], base.rgb[1], (base.rgb[2] + n) % 256]),
    });
  }

  return selected.slice(0, paletteSize);
}

function selectGlobal(candidates, paletteSize, grayPalette, grayLab) {
  const seeds = grayPalette.map((rgb, i) => ({ rgb, lab: grayLab[i] }));
  const used = new Uint8Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    for (const s of seeds) {
      if (candidates[i].rgb[0] === s.rgb[0] &&
          candidates[i].rgb[1] === s.rgb[1] &&
          candidates[i].rgb[2] === s.rgb[2]) {
        used[i] = 1;
        break;
      }
    }
  }
  const picked = greedySelect(candidates, paletteSize, seeds, used);
  let guard = 0;
  while (picked.length < paletteSize && guard < paletteSize * 8) {
    const base = picked[picked.length % 16] ?? picked[0];
    const n = guard++;
    const rgb = [base.rgb[0], base.rgb[1], (base.rgb[2] + n) % 256];
    picked.push({ rgb, lab: rgbToLab(rgb) });
  }
  return picked.slice(0, paletteSize);
}

export function generatePalette(layerName, options = {}) {
  const layer = LAYERS[layerName];
  if (!layer) throw new Error(`Unknown layer: ${layerName}`);
  const mode = options.mode ?? 'bucketed';
  const harmony = options.harmony ?? false;
  const k = keyOf(layerName, mode, harmony);
  if (cache.has(k)) return cache.get(k);

  const grayPalette = generateGrayPalette(16);
  const grayLab = grayPalette.map(rgbToLab);
  let palette;

  if (layer.paletteSize === 2) {
    palette = [{ rgb: [0, 0, 0], lab: rgbToLab([0, 0, 0]) },
      { rgb: [255, 255, 255], lab: rgbToLab([255, 255, 255]) }];
  } else if (layer.paletteSize === 16) {
    palette = grayPalette.map((rgb, i) => ({ rgb, lab: grayLab[i] }));
  } else {
    let candidates = layerName === 'L3a' ? cmykCandidates() : srgbCandidates();
    if (harmony) candidates = harmonyFilter(candidates);
    palette = mode === 'global'
      ? selectGlobal(candidates, layer.paletteSize, grayPalette, grayLab)
      : selectBucketed(candidates, layer.paletteSize, grayPalette, grayLab);
  }

  const paletteRgb = palette.map((c) => c.rgb);
  const paletteLab = palette.map((c) => c.lab);
  const rankOf = new Int16Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    rankOf[i] = layer.paletteSize === 2 ? (i === 0 ? 0 : 15) : nearestRank(paletteLab[i], grayLab);
  }

  const result = {
    layer: layerName,
    mode,
    harmony,
    palette: paletteRgb,
    paletteLab,
    rankOf,
    grayPalette,
    grayLab,
    symbolsByRank: null,
    rankCounts: null,
  };
  const symbolsByRank = Array.from({ length: 16 }, () => []);
  for (let i = 0; i < rankOf.length; i++) symbolsByRank[rankOf[i]].push(i);
  result.symbolsByRank = symbolsByRank;
  result.rankCounts = symbolsByRank.map((s) => s.length);

  cache.set(k, result);
  return result;
}

export function clearPaletteCache() {
  cache.clear();
}
