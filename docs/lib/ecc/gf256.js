/**
 * GF(256) arithmetic for Reed-Solomon.
 * Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1 (0x11D), generator 2.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let ready = false;

function init() {
  if (ready) return;
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  ready = true;
}

export function gfAdd(a, b) {
  return a ^ b;
}

export function gfMul(a, b) {
  init();
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function gfDiv(a, b) {
  init();
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

export function gfPow(a, e) {
  init();
  if (e === 0) return 1;
  if (a === 0) return 0;
  let exp = e % 255;
  if (exp < 0) exp += 255;
  return EXP[(LOG[a] * exp) % 255];
}

export function gfInv(a) {
  init();
  if (a === 0) throw new Error('GF(256) inverse of zero');
  return EXP[(255 - LOG[a]) % 255];
}

export function gfExp(i) {
  init();
  return EXP[i % 255];
}

export function gfLog(a) {
  init();
  return LOG[a];
}
