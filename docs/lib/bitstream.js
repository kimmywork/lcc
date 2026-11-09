/**
 * MSB-first bit reader/writer used by the frame/RS/constraint pipeline.
 */

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.used = 0;
    this.length = 0;
  }

  writeBit(bit) {
    this.current = (this.current << 1) | (bit & 1);
    this.used++;
    this.length++;
    if (this.used === 8) {
      this.bytes.push(this.current & 0xff);
      this.current = 0;
      this.used = 0;
    }
  }

  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) this.writeBit((value >> i) & 1);
  }

  writeBigInt(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.writeBit(Number((value >> BigInt(i)) & 1n));
    }
  }

  writeBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i], 8);
  }

  toBytes() {
    const out = Uint8Array.from(this.bytes);
    if (this.used > 0) {
      const padded = new Uint8Array(out.length + 1);
      padded.set(out);
      padded[out.length] = (this.current << (8 - this.used)) & 0xff;
      return padded;
    }
    return out;
  }
}

export class BitReader {
  constructor(bytes, bitLength = bytes.length * 8) {
    this.bytes = bytes;
    this.bitLength = bitLength;
    this.pos = 0;
  }

  readBit() {
    if (this.pos >= this.bitLength) throw new Error('bitstream: end of input');
    const byte = this.bytes[this.pos >> 3] ?? 0;
    const bit = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return bit;
  }

  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }

  readBigInt(n) {
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(this.readBit());
    return v;
  }

  remaining() {
    return this.bitLength - this.pos;
  }
}

export function bitsToBytes(bits) {
  const w = new BitWriter();
  for (const b of bits) w.writeBit(b);
  return w.toBytes();
}

export function bytesToBits(bytes, bitLength = bytes.length * 8) {
  const r = new BitReader(bytes, bitLength);
  const out = [];
  for (let i = 0; i < bitLength; i++) out.push(r.readBit());
  return out;
}
