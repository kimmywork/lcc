/** QR Code rasterization helpers shared by the benchmark scripts. */

import QRCode from 'qrcode';

export function qrPayload(data, binary) {
  if (binary) return [{ data: Buffer.from(data), mode: 'byte' }];
  return data;
}

export function rasterizeQR(data, {
  binary = false,
  scale = 8,
  target = 0,
  border = 4,
  ecc = 'M',
} = {}) {
  const qr = QRCode.create(qrPayload(data, binary), { errorCorrectionLevel: ecc });
  const n = qr.modules.size;
  if (target > 0) scale = Math.max(1, Math.floor(target / (n + 2 * border)));
  const side = (n + 2 * border) * scale;
  const rgb = new Uint8Array(side * side * 3).fill(255);
  const modules = qr.modules.data;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!modules[r * n + c]) continue;
      const y0 = (r + border) * scale;
      const x0 = (c + border) * scale;
      for (let dy = 0; dy < scale; dy++) {
        let p = ((y0 + dy) * side + x0) * 3;
        for (let dx = 0; dx < scale; dx++) {
          rgb[p++] = 0;
          rgb[p++] = 0;
          rgb[p++] = 0;
        }
      }
    }
  }
  return {
    image: { width: side, height: side, data: rgb },
    version: qr.version,
    modules: n,
    scale,
  };
}

export function toRGBA(image) {
  const { width, height, data } = image;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 3, q += 4) {
    rgba[q] = data[p];
    rgba[q + 1] = data[p + 1];
    rgba[q + 2] = data[p + 2];
    rgba[q + 3] = 255;
  }
  return rgba;
}
