/**
 * sRGB <-> CIELAB (D65) helpers.
 *
 * The reference implementation uses CIELAB for palette construction and for
 * nearest-symbol classification.  All conversions are deterministic and
 * dependency-free.
 */

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v) {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(clamp(c, 0, 1) * 255);
}

export function rgbToXyz([r, g, b]) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return [
    R * 0.4124564 + G * 0.3575761 + B * 0.1804375,
    R * 0.2126729 + G * 0.7151522 + B * 0.0721750,
    R * 0.0193339 + G * 0.1191920 + B * 0.9503041,
  ];
}

const WHITE = [0.95047, 1.0, 1.08883];

function labF(t) {
  return t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
}

function labFInv(t) {
  return t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29);
}

export function xyzToLab([x, y, z]) {
  const fx = labF(x / WHITE[0]);
  const fy = labF(y / WHITE[1]);
  const fz = labF(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function rgbToLab(rgb) {
  return xyzToLab(rgbToXyz(rgb));
}

export function labToXyz([L, a, b]) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  return [WHITE[0] * labFInv(fx), WHITE[1] * labFInv(fy), WHITE[2] * labFInv(fz)];
}

export function labToRgb([L, a, b]) {
  const [x, y, z] = labToXyz([L, a, b]);
  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
}

export function deltaE76(a, b) {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function lstarToGray(L) {
  return labToRgb([L, 0, 0]);
}

/** 16 equal-L* gray levels, with exact black and white endpoints. */
export function generateGrayPalette(levels = 16) {
  const out = [];
  for (let i = 0; i < levels; i++) {
    const L = (i * 100) / (levels - 1);
    out.push(lstarToGray(L));
  }
  out[0] = [0, 0, 0];
  out[levels - 1] = [255, 255, 255];
  return out;
}

export function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function nearestIndex(colorLab, paletteLab) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < paletteLab.length; i++) {
    const p = paletteLab[i];
    const dl = colorLab[0] - p[0];
    const da = colorLab[1] - p[1];
    const db = colorLab[2] - p[2];
    const d = dl * dl + da * da + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
