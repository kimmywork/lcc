/**
 * Palette construction for the new LCC hierarchy.
 *
 * Gray layers use equal-L* gray ramps (2/4/8 levels).
 * Color layers use a CIELAB max-min DeltaE palette seeded with black/white.
 * The minimum pairwise DeltaE is the metric that matters for camera
 * robustness; 16/32 colors keep it large, 64/256 are for clean/digital use.
 */

import { deltaE76, generateGrayPalette, rgbToLab } from './color.js';
import { LAYERS, layerMaxRankDiff, layerRankCount } from './constants.js';

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
    if (h === null) return true;
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

function generateColorPalette(count, { harmony = false } = {}) {
  let candidates = srgbCandidates();
  if (harmony) candidates = harmonyFilter(candidates);
  const black = { rgb: [0, 0, 0], lab: rgbToLab([0, 0, 0]) };
  const white = { rgb: [255, 255, 255], lab: rgbToLab([255, 255, 255]) };
  const seeds = [black, white];
  const used = new Uint8Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const [r, g, b] = candidates[i].rgb;
    if ((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255)) {
      used[i] = 1;
    }
  }
  const picked = greedySelect(candidates, count, seeds, used);
  let guard = 0;
  while (picked.length < count && guard < count * 8) {
    const base = picked[picked.length % 16] ?? picked[0];
    const n = guard++;
    const rgb = [base.rgb[0], base.rgb[1], (base.rgb[2] + n) % 256];
    picked.push({ rgb, lab: rgbToLab(rgb) });
  }
  return picked.slice(0, count);
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

export function generatePalette(layerName, options = {}) {
  const layer = LAYERS[layerName];
  if (!layer) throw new Error(`Unknown layer: ${layerName}`);
  const mode = options.mode ?? 'maxmin';
  const harmony = options.harmony ?? false;
  const k = keyOf(layerName, mode, harmony);
  if (cache.has(k)) return cache.get(k);

  const referenceGray = generateGrayPalette(16);
  const referenceGrayLab = referenceGray.map(rgbToLab);

  let palette;
  if (layer.kind === 'gray') {
    palette = generateGrayPalette(layer.levels).map((rgb) => ({ rgb, lab: rgbToLab(rgb) }));
  } else {
    palette = generateColorPalette(layer.colors, { harmony });
  }

  const paletteRgb = palette.map((c) => c.rgb);
  const paletteLab = palette.map((c) => c.lab);

  const rankCount = layerRankCount(layer);
  const maxRankDiff = layerMaxRankDiff(layer);
  const rankOf = new Int16Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    rankOf[i] = layer.kind === 'gray' ? i : nearestRank(paletteLab[i], referenceGrayLab);
  }

  const symbolsByRank = Array.from({ length: rankCount }, () => []);
  for (let i = 0; i < rankOf.length; i++) symbolsByRank[rankOf[i]].push(i);
  const rankCounts = symbolsByRank.map((s) => s.length);

  let initialRank = Math.floor(rankCount / 2);
  if (rankCounts[initialRank] === 0) {
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r < rankCount; r++) {
      if (rankCounts[r] === 0) continue;
      const d = Math.abs(r - initialRank);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    initialRank = best >= 0 ? best : 0;
  }

  const blackIndex = 0;
  const whiteIndex = layer.kind === 'gray' ? layer.levels - 1 : 1;

  const result = {
    layer: layerName,
    kind: layer.kind,
    levels: layer.levels ?? null,
    colors: layer.colors ?? null,
    mode,
    harmony,
    palette: paletteRgb,
    paletteLab,
    rankOf,
    rankCount,
    maxRankDiff,
    initialRank,
    symbolsByRank,
    rankCounts,
    grayPalette: referenceGray,
    grayLab: referenceGrayLab,
    blackIndex,
    whiteIndex,
  };
  cache.set(k, result);
  return result;
}

export function clearPaletteCache() {
  cache.clear();
}
