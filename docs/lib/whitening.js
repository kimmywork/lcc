/**
 * Deterministic whitening.
 *
 * The seed comes from the format band.  Whitening is applied to the frame
 * before Reed-Solomon, so the codeword statistics are flat and large solid
 * areas are avoided.
 */

export function makeWhitening(seed) {
  let state = ((seed * 0x9e3779b9 + 0x85ebca6b) >>> 0) || 0x1a2b3c4d;
  return function apply(bytes) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      state ^= (state << 13) >>> 0;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= (state << 5) >>> 0;
      state >>>= 0;
      out[i] = bytes[i] ^ (state & 0xff);
    }
    return out;
  };
}
