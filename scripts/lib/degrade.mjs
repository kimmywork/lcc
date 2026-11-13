/**
 * Image degradations used by the camera benchmark and damage tests.
 *
 * Pure functions over {width, height, data: Uint8Array RGB}.  They model the
 * main failure modes of a phone camera / print-scan path: colour cast,
 * illumination falloff, defocus/motion blur, sensor noise, distance
 * (downscale), hand-held rotation, perspective, and JPEG compression.
 */

import jpeg from 'jpeg-js';
import { mulberry32 } from './rng.mjs';

export function cloneImage(image) {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}

export function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function applyColorCast(image, gain, bias = [0, 0, 0]) {
  const out = cloneImage(image);
  for (let i = 0; i < out.data.length; i += 3) {
    out.data[i] = clampByte(out.data[i] * gain[0] + bias[0]);
    out.data[i + 1] = clampByte(out.data[i + 1] * gain[1] + bias[1]);
    out.data[i + 2] = clampByte(out.data[i + 2] * gain[2] + bias[2]);
  }
  return out;
}

export function applyIllumination(image, { gradient = 0, vignette = 0, angle = 0.35 } = {}) {
  const { width, height } = image;
  const out = cloneImage(image);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const maxR = Math.hypot(cx, cy);
  const gx = Math.cos(angle) * gradient;
  const gy = Math.sin(angle) * gradient;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x - cx) / Math.max(1, cx);
      const ny = (y - cy) / Math.max(1, cy);
      const r = Math.hypot(x - cx, y - cy) / maxR;
      const falloff = 1 - vignette * r * r - gx * nx - gy * ny;
      const k = Math.max(0, falloff);
      const p = (y * width + x) * 3;
      out.data[p] = clampByte(out.data[p] * k);
      out.data[p + 1] = clampByte(out.data[p + 1] * k);
      out.data[p + 2] = clampByte(out.data[p + 2] * k);
    }
  }
  return out;
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

export function gaussianBlur(image, sigma) {
  if (sigma <= 0) return cloneImage(image);
  const { kernel, radius } = gaussianKernel(sigma);
  const { width, height, data } = image;
  const tmp = new Float64Array(width * height * 3);
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.max(0, Math.min(width - 1, x + k));
          sum += data[(y * width + xx) * 3 + c] * kernel[k + radius];
        }
        tmp[p + c] = sum;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.max(0, Math.min(height - 1, y + k));
          sum += tmp[(yy * width + x) * 3 + c] * kernel[k + radius];
        }
        out[p + c] = clampByte(sum);
      }
    }
  }
  return { width, height, data: out };
}

export function motionBlur(image, length, angle = 0) {
  if (length <= 1) return cloneImage(image);
  const { width, height, data } = image;
  const out = new Uint8Array(data.length);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const n = Math.max(1, Math.round(length));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < n; i++) {
          const t = (i - (n - 1) / 2) / Math.max(1, n - 1);
          const xx = Math.round(x + dx * length * t);
          const yy = Math.round(y + dy * length * t);
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          sum += data[(yy * width + xx) * 3 + c];
          count++;
        }
        out[p + c] = count ? clampByte(sum / count) : data[p + c];
      }
    }
  }
  return { width, height, data: out };
}

export function addNoise(image, sigma, seed = 1) {
  if (sigma <= 0) return cloneImage(image);
  const rng = mulberry32(seed);
  const out = cloneImage(image);
  for (let i = 0; i < out.data.length; i++) {
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
    out.data[i] = clampByte(out.data[i] + g);
  }
  return out;
}

function sampleBilinear(image, x, y, background = 255) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [background, background, background];
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= image.width - 1 || y0 >= image.height - 1) {
    if (x < -0.5 || y < -0.5 || x > image.width - 0.5 || y > image.height - 0.5) {
      return [background, background, background];
    }
    const cx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
    const p = (cy * image.width + cx) * 3;
    return [image.data[p], image.data[p + 1], image.data[p + 2]];
  }
  const fx = x - x0;
  const fy = y - y0;
  const p00 = (y0 * image.width + x0) * 3;
  const p10 = p00 + 3;
  const p01 = ((y0 + 1) * image.width + x0) * 3;
  const p11 = p01 + 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = clampByte(
      image.data[p00 + c] * (1 - fx) * (1 - fy) +
      image.data[p10 + c] * fx * (1 - fy) +
      image.data[p01 + c] * (1 - fx) * fy +
      image.data[p11 + c] * fx * fy,
    );
  }
  return out;
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}

function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination.
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const inv = 1 / M[col][col];
    for (let j = col; j <= n; j++) M[col][j] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  const p = M.map((row) => row[n]);
  return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], 1];
}

export function warpPerspective(image, corners, outWidth = image.width, outHeight = image.height) {
  const src = [[0, 0], [image.width, 0], [0, image.height], [image.width, image.height]];
  const H = computeHomography(src, corners);
  if (!H) return cloneImage(image);
  const Hinv = invert3x3(H);
  if (!Hinv) return cloneImage(image);
  const out = new Uint8Array(outWidth * outHeight * 3).fill(255);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const den = Hinv[6] * (x + 0.5) + Hinv[7] * (y + 0.5) + Hinv[8];
      if (Math.abs(den) < 1e-12) continue;
      const sx = (Hinv[0] * (x + 0.5) + Hinv[1] * (y + 0.5) + Hinv[2]) / den - 0.5;
      const sy = (Hinv[3] * (x + 0.5) + Hinv[4] * (y + 0.5) + Hinv[5]) / den - 0.5;
      const rgb = sampleBilinear(image, sx, sy);
      const p = (y * outWidth + x) * 3;
      out[p] = rgb[0];
      out[p + 1] = rgb[1];
      out[p + 2] = rgb[2];
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

export function rotate(image, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const cx = image.width / 2;
  const cy = image.height / 2;
  const rot = (x, y) => [
    cx + Math.cos(rad) * (x - cx) - Math.sin(rad) * (y - cy),
    cy + Math.sin(rad) * (x - cx) + Math.cos(rad) * (y - cy),
  ];
  const corners = [
    rot(0, 0),
    rot(image.width, 0),
    rot(0, image.height),
    rot(image.width, image.height),
  ];
  return warpPerspective(image, corners, image.width, image.height);
}

function resizeBilinear(image, outWidth, outHeight) {
  const out = new Uint8Array(outWidth * outHeight * 3);
  const sxScale = image.width / outWidth;
  const syScale = image.height / outHeight;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const rgb = sampleBilinear(image, (x + 0.5) * sxScale - 0.5, (y + 0.5) * syScale - 0.5);
      const p = (y * outWidth + x) * 3;
      out[p] = rgb[0];
      out[p + 1] = rgb[1];
      out[p + 2] = rgb[2];
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

export function padImage(image, fraction, background = 255) {
  const padX = Math.round(image.width * fraction);
  const padY = Math.round(image.height * fraction);
  const width = image.width + 2 * padX;
  const height = image.height + 2 * padY;
  const data = new Uint8Array(width * height * 3).fill(background);
  for (let y = 0; y < image.height; y++) {
    data.set(
      image.data.subarray(y * image.width * 3, (y + 1) * image.width * 3),
      ((y + padY) * width + padX) * 3,
    );
  }
  return { width, height, data };
}

export function downscale(image, factor) {
  return resizeBilinear(image, Math.max(8, Math.round(image.width * factor)), Math.max(8, Math.round(image.height * factor)));
}

export function upscale(image, factor) {
  return resizeBilinear(image, Math.round(image.width * factor), Math.round(image.height * factor));
}

export function jpegRoundTrip(image, quality = 70) {
  // jpeg-js encodes and decodes RGBA buffers.
  const rgba = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0, p = 0, q = 0; i < image.width * image.height; i++, p += 3, q += 4) {
    rgba[q] = image.data[p];
    rgba[q + 1] = image.data[p + 1];
    rgba[q + 2] = image.data[p + 2];
    rgba[q + 3] = 255;
  }
  const encoded = jpeg.encode({ data: rgba, width: image.width, height: image.height }, quality);
  const decoded = jpeg.decode(encoded.data, { useTArray: true, formatAsRGBA: true });
  const out = new Uint8Array(image.width * image.height * 3);
  for (let i = 0, p = 0, q = 0; i < image.width * image.height; i++, p += 4, q += 3) {
    out[q] = decoded.data[p];
    out[q + 1] = decoded.data[p + 1];
    out[q + 2] = decoded.data[p + 2];
  }
  return { width: image.width, height: image.height, data: out };
}

export function perspectiveCorners(width, height, amount) {
  const dx = width * amount;
  const dy = height * amount;
  return [
    [dx * 0.6, dy * 0.9],
    [width - dx, dy * 0.2],
    [dx * 0.2, height - dy * 0.6],
    [width - dx * 0.8, height - dy],
  ];
}

export function perspective(image, amount) {
  return warpPerspective(image, perspectiveCorners(image.width, image.height, amount), image.width, image.height);
}

/**
 * Named degradation pipelines.  `harsh` and `combined` are meant to be near
 * the practical failure boundary, not to guarantee success.
 */
export function degrade(image, name, seed = 1) {
  switch (name) {
    case 'clean':
      return image;
    case 'cast-warm':
      return applyColorCast(image, [1.0, 0.82, 0.62], [0, 0, 0]);
    case 'cast-cool':
      return applyColorCast(image, [0.62, 0.82, 1.0], [0, 0, 0]);
    case 'cast-red':
      return applyColorCast(image, [0.55, 1.0, 1.0], [8, 0, 0]);
    case 'illumination':
      return applyIllumination(image, { gradient: 0.28, vignette: 0.35 });
    case 'blur-1':
      return gaussianBlur(image, 1.0);
    case 'blur-2':
      return gaussianBlur(image, 2.0);
    case 'blur-3':
      return gaussianBlur(image, 3.0);
    case 'motion-7':
      return motionBlur(image, 7, 0.35);
    case 'motion-13':
      return motionBlur(image, 13, 0.35);
    case 'noise-10':
      return addNoise(image, 10, seed);
    case 'noise-25':
      return addNoise(image, 25, seed);
    case 'downscale-0.5':
      return downscale(image, 0.5);
    case 'downscale-0.35':
      return downscale(image, 0.35);
    case 'rotate-5':
      return rotate(padImage(image, 0.08), 5);
    case 'rotate-10':
      return rotate(padImage(image, 0.08), 10);
    case 'rotate-12':
      return rotate(padImage(image, 0.08), 12);
    case 'rotate-15':
      return rotate(padImage(image, 0.08), 15);
    case 'rotate-20':
      return rotate(padImage(image, 0.08), 20);
    case 'perspective-0.05':
      return perspective(image, 0.05);
    case 'perspective-0.12':
      return perspective(image, 0.12);
    case 'jpeg-80':
      return jpegRoundTrip(image, 80);
    case 'jpeg-50':
      return jpegRoundTrip(image, 50);
    case 'jpeg-25':
      return jpegRoundTrip(image, 25);
    case 'combo-mild':
      return jpegRoundTrip(
        addNoise(
          gaussianBlur(applyColorCast(image, [1.0, 0.88, 0.75]), 0.8),
          6,
          seed,
        ),
        80,
      );
    case 'combo-harsh':
      return jpegRoundTrip(
        addNoise(
          perspective(
            gaussianBlur(applyColorCast(image, [1.0, 0.8, 0.65], [0, 0, 0]), 1.8),
            0.06,
          ),
          18,
          seed,
        ),
        45,
      );
    default:
      throw new Error(`unknown degradation: ${name}`);
  }
}

export const DEGRADATIONS = [
  'clean',
  'cast-warm',
  'cast-cool',
  'cast-red',
  'illumination',
  'blur-1',
  'blur-2',
  'blur-3',
  'motion-7',
  'motion-13',
  'noise-10',
  'noise-25',
  'downscale-0.5',
  'downscale-0.35',
  'rotate-5',
  'rotate-10',
  'rotate-12',
  'rotate-15',
  'rotate-20',
  'perspective-0.05',
  'perspective-0.12',
  'jpeg-80',
  'jpeg-50',
  'jpeg-25',
  'combo-mild',
  'combo-harsh',
];
