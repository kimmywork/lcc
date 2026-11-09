/**
 * BCH(15,5,7) for the compact format band.
 *
 * Generator polynomial:
 *   g(x) = x^10 + x^8 + x^5 + x^4 + x^2 + x + 1 = 0x537
 *
 * The code has 32 codewords and minimum distance 7, so it corrects up to
 * three bit errors.  The decoder uses a tiny maximum-likelihood table (32
 * codewords), which is exact and trivial to audit.
 */

export const BCH_GENERATOR = 0x537;
export const BCH_N = 15;
export const BCH_K = 5;

export function bch15Encode(message) {
  const msg = message & 0x1f;
  let val = msg << 10;
  for (let i = 14; i >= 10; i--) {
    if ((val >> i) & 1) val ^= BCH_GENERATOR << (i - 10);
  }
  return ((msg << 10) | (val & 0x3ff)) & 0x7fff;
}

const TABLE = (() => {
  const out = [];
  for (let m = 0; m < 32; m++) out.push({ message: m, codeword: bch15Encode(m) });
  return out;
})();

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

export function bch15Decode(word) {
  const w = word & 0x7fff;
  let best = -1;
  let bestD = 99;
  for (const entry of TABLE) {
    const d = popcount(w ^ entry.codeword);
    if (d < bestD) {
      bestD = d;
      best = entry.message;
    }
  }
  return bestD <= 3 ? best : -1;
}

export function bch15Codewords() {
  return TABLE.map((e) => e.codeword);
}
