/**
 * Minimal PNG reader/writer for 8-bit RGB/RGBA, non-interlaced images.
 * Only Node's built-in zlib is used.
 */

import zlib from 'node:zlib';
import { crc32 } from './ecc/crc32.js';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePNG({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG: invalid dimensions');
  }
  if (width * height > MAX_PIXELS) throw new Error('PNG: image too large');
  if (!data || data.length !== width * height * 3) {
    throw new Error('PNG: data length does not match dimensions');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export const MAX_PIXELS = 32 * 1024 * 1024;

export function decodePNG(buffer, options = {}) {
  const maxPixels = options.maxPixels ?? MAX_PIXELS;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG: bad signature');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIHDR = false;
  let sawIEND = false;
  let idatBytes = 0;
  const idat = [];
  while (pos < buf.length) {
    if (pos + 8 > buf.length) throw new Error('PNG: truncated chunk header');
    const len = buf.readUInt32BE(pos);
    if (len > buf.length - pos - 12) throw new Error('PNG: truncated chunk');
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const storedCrc = buf.readUInt32BE(pos + 8 + len);
    const typeBuf = buf.subarray(pos + 4, pos + 8);
    if (crc32(Buffer.concat([typeBuf, data])) !== storedCrc) {
      throw new Error(`PNG: bad CRC in ${type}`);
    }
    pos += 12 + len;
    if (type === 'IHDR') {
      if (sawIHDR || len !== 13) throw new Error('PNG: invalid IHDR');
      sawIHDR = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (width <= 0 || height <= 0) throw new Error('PNG: invalid dimensions');
      if (width * height > maxPixels) throw new Error('PNG: image too large');
    } else if (type === 'IDAT') {
      if (!sawIHDR) throw new Error('PNG: IDAT before IHDR');
      idatBytes += len;
      if (idatBytes > 128 * 1024 * 1024) throw new Error('PNG: compressed data too large');
      idat.push(data);
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
  }
  if (!sawIHDR) throw new Error('PNG: missing IHDR');
  if (!sawIEND) throw new Error('PNG: missing IEND');
  if (idat.length === 0) throw new Error('PNG: missing IDAT');
  if (width * height > maxPixels) throw new Error('PNG: image too large');
  if (bitDepth !== 8) throw new Error(`PNG: unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('PNG: interlaced images are not supported');
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`PNG: unsupported color type ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (err) {
    throw new Error(`PNG: invalid compressed data (${err.message})`);
  }
  if (raw.length < expected) throw new Error('PNG: truncated image data');
  if (raw.length > expected) throw new Error('PNG: excess image data');
  const out = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const f = raw[rp++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = f; break;
        case 1: v = f + a; break;
        case 2: v = f + b; break;
        case 3: v = f + Math.floor((a + b) / 2); break;
        case 4: v = f + paeth(a, b, c); break;
        default: throw new Error(`PNG: bad filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 3;
      out[di] = cur[si];
      out[di + 1] = cur[si + 1];
      out[di + 2] = cur[si + 2];
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}
