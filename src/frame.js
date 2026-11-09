/**
 * LCC frame format.
 *
 * Header (13 bytes):
 *   magic     2  "LC" (0x4C 0x43)
 *   version   1  frame version
 *   layer     1  layer id
 *   flags     1  bit0 constraint, bit1 compressed, bit2 encrypted
 *   length    4  payload length, big-endian
 *   crc32     4  payload CRC32, big-endian
 *
 * The frame is padded with zeros to fill the Reed-Solomon data capacity.
 */

import { crc32 } from './ecc/crc32.js';
import { FRAME_HEADER_SIZE, FRAME_MAGIC, FRAME_VERSION } from './constants.js';

export function buildFrame({ layerId, flags = 0, payload }) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(FRAME_HEADER_SIZE + data.length);
  out[0] = (FRAME_MAGIC >> 8) & 0xff;
  out[1] = FRAME_MAGIC & 0xff;
  out[2] = FRAME_VERSION;
  out[3] = layerId & 0xff;
  out[4] = flags & 0xff;
  const len = data.length >>> 0;
  out[5] = (len >>> 24) & 0xff;
  out[6] = (len >>> 16) & 0xff;
  out[7] = (len >>> 8) & 0xff;
  out[8] = len & 0xff;
  const crc = crc32(data);
  out[9] = (crc >>> 24) & 0xff;
  out[10] = (crc >>> 16) & 0xff;
  out[11] = (crc >>> 8) & 0xff;
  out[12] = crc & 0xff;
  out.set(data, FRAME_HEADER_SIZE);
  return out;
}

export function parseFrame(bytes) {
  if (bytes.length < FRAME_HEADER_SIZE) throw new Error('LCC frame: too short');
  const magic = (bytes[0] << 8) | bytes[1];
  if (magic !== FRAME_MAGIC) throw new Error('LCC frame: bad magic');
  const version = bytes[2];
  if (version !== FRAME_VERSION) throw new Error(`LCC frame: unsupported version ${version}`);
  const layerId = bytes[3];
  const flags = bytes[4];
  const len = ((bytes[5] << 24) >>> 0) + (bytes[6] << 16) + (bytes[7] << 8) + bytes[8];
  const crc = ((bytes[9] << 24) >>> 0) + (bytes[10] << 16) + (bytes[11] << 8) + bytes[12];
  if (len > bytes.length - FRAME_HEADER_SIZE) throw new Error('LCC frame: length exceeds data');
  const payload = bytes.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + len);
  if (crc32(payload) !== crc) throw new Error('LCC frame: CRC mismatch');
  return { layerId, flags, payload, length: len };
}
