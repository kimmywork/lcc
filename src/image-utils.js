/**
 * Image helpers shared by the clean-image and camera decoders.
 */

export function grayscale(image) {
  const { width, height, data } = image;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 3) {
    gray[i] = Math.round(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
  }
  return gray;
}

export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

export function imageStats(gray) {
  let mn = 255;
  let mx = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < mn) mn = gray[i];
    if (gray[i] > mx) mx = gray[i];
  }
  return { min: mn, max: mx };
}

export function robustThreshold(gray) {
  const { min, max } = imageStats(gray);
  if (min === max) return { threshold: 128, min, max, contrast: 0 };
  let threshold = otsuThreshold(gray);
  if (threshold <= min || threshold >= max) threshold = Math.floor((min + max) / 2);
  return { threshold, min, max, contrast: max - min };
}

export function sampleImageBilinear(image, x, y) {
  const { width, height, data } = image;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const px = (xx, yy) => {
    const cx = xx < 0 ? 0 : xx >= width ? width - 1 : xx;
    const cy = yy < 0 ? 0 : yy >= height ? height - 1 : yy;
    const p = (cy * width + cx) * 3;
    return [data[p], data[p + 1], data[p + 2]];
  };
  const p00 = px(x0, y0);
  const p10 = px(x1, y0);
  const p01 = px(x0, y1);
  const p11 = px(x1, y1);
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  return [0, 1, 2].map((ch) => Math.round(
    p00[ch] * w00 + p10[ch] * w10 + p01[ch] * w01 + p11[ch] * w11,
  ));
}

export function sampleImage(image, x, y, radius = 1) {
  const { width, height, data } = image;
  const cx = Math.round(x);
  const cy = Math.round(y);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let yy = cy - radius; yy <= cy + radius; yy++) {
    if (yy < 0 || yy >= height) continue;
    for (let xx = cx - radius; xx <= cx + radius; xx++) {
      if (xx < 0 || xx >= width) continue;
      const p = (yy * width + xx) * 3;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      n++;
    }
  }
  if (n === 0) return [255, 255, 255];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// Expected 7x7 finder pattern: 0 = black, 1 = white.
export const FINDER_PATTERN = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 0, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 0],
];
