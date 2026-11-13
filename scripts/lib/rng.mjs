/**
 * Deterministic PRNG helpers for property/fuzz tests.
 *
 * Tests must be reproducible from a seed alone.  mulberry32 is small, fast and
 * has enough state for statistical fuzzing (it is not cryptographic).
 */

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export function int(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick(rng, values) {
  return values[int(rng, 0, values.length - 1)];
}

export function chance(rng, p) {
  return rng() < p;
}

export function bytes(rng, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = int(rng, 0, 255);
  return out;
}

const ALPHABETS = {
  ascii: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?-_/\\',
  cjk: '心经金刚般若波罗蜜多时照见五蕴皆空度一切苦厄舍利子色不异空空不异色',
  binary: null,
};

export function text(rng, n, kind = 'ascii') {
  if (kind === 'binary') return bytes(rng, n);
  const alphabet = ALPHABETS[kind] ?? ALPHABETS.ascii;
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[int(rng, 0, alphabet.length - 1)];
  return out;
}

export function shuffle(rng, values) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Gaussian noise via Box-Muller. */
export function gaussian(rng) {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
