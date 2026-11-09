/**
 * Systematic Reed-Solomon over GF(256).
 *
 * The encoder uses the generator polynomial
 *   g(x) = product_{i=0}^{parity-1} (x - alpha^i)
 * and appends the remainder.  The decoder computes syndromes,
 * runs Berlekamp-Massey, finds error positions with Chien search, and solves
 * for the error magnitudes with a small GF(256) linear system.
 */

import { gfDiv, gfInv, gfMul, gfPow } from './gf256.js';

function generatorPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const alpha = gfPow(2, i);
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], alpha);
    }
    g = next;
  }
  return g;
}

export function rsEncode(data, nsym) {
  if (nsym <= 0) return Uint8Array.from(data);
  const gen = generatorPoly(nsym);
  const work = new Uint8Array(data.length + nsym);
  work.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) {
      work[i + j] ^= gfMul(gen[j], coef);
    }
  }
  const out = new Uint8Array(data.length + nsym);
  out.set(data, 0);
  out.set(work.subarray(data.length), data.length);
  return out;
}

function syndromesOf(r, nsym) {
  const synd = new Uint8Array(nsym);
  let hasError = false;
  for (let k = 0; k < nsym; k++) {
    const x = gfPow(2, k);
    let val = 0;
    for (let j = r.length - 1; j >= 0; j--) val = gfMul(val, x) ^ r[j];
    synd[k] = val;
    if (val !== 0) hasError = true;
  }
  return { synd, hasError };
}

function berlekampMassey(synd) {
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < synd.length; n++) {
    let d = synd[n];
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i] ?? 0, synd[n - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const T = C.slice();
    const coef = gfDiv(d, b);
    for (let i = 0; i < B.length; i++) {
      const idx = i + m;
      C[idx] = (C[idx] ?? 0) ^ gfMul(coef, B[i]);
    }
    if (2 * L <= n) {
      L = n + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  return C.slice(0, L + 1);
}

function evalPoly(poly, x) {
  let val = 0;
  for (let i = poly.length - 1; i >= 0; i--) val = gfMul(val, x) ^ poly[i];
  return val;
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && M[pivot][col] === 0) pivot++;
    if (pivot === n) throw new Error('RS linear system is singular');
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const inv = gfInv(M[col][col]);
    for (let j = col; j <= n; j++) M[col][j] = gfMul(M[col][j], inv);
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) M[row][j] ^= gfMul(factor, M[col][j]);
    }
  }
  return Uint8Array.from(M.map((row) => row[n]));
}

export function rsDecode(received, nsym) {
  const n = received.length;
  if (nsym <= 0) return { data: Uint8Array.from(received), corrected: 0 };
  const r = new Uint8Array(n);
  for (let i = 0; i < n; i++) r[i] = received[n - 1 - i];

  const first = syndromesOf(r, nsym);
  if (!first.hasError) return { data: received.slice(0, n - nsym), corrected: 0 };

  const lambda = berlekampMassey(first.synd);
  const t = lambda.length - 1;
  if (t <= 0 || t > Math.floor(nsym / 2)) throw new Error('RS: too many errors');

  const positions = [];
  for (let j = 0; j < n; j++) {
    const x = gfPow(2, (255 - (j % 255)) % 255);
    if (evalPoly(lambda, x) === 0) positions.push(j);
  }
  if (positions.length !== t) throw new Error('RS: Chien search failed');

  const A = Array.from({ length: t }, () => new Uint8Array(t));
  const b = new Uint8Array(t);
  for (let row = 0; row < t; row++) {
    for (let col = 0; col < t; col++) {
      A[row][col] = gfPow(2, (row * positions[col]) % 255);
    }
    b[row] = first.synd[row];
  }
  const magnitudes = solveLinear(A, b);
  for (let l = 0; l < t; l++) r[positions[l]] ^= magnitudes[l];

  const verify = syndromesOf(r, nsym);
  if (verify.hasError) throw new Error('RS: verification failed');

  const corrected = new Uint8Array(n);
  for (let i = 0; i < n; i++) corrected[i] = r[n - 1 - i];
  return { data: corrected.slice(0, n - nsym), corrected: t };
}

export function computeRSBlocks(totalSymbols, redundancy) {
  if (totalSymbols <= 0) throw new Error('RS: totalSymbols must be positive');
  const blocks = Math.max(1, Math.ceil(totalSymbols / 255));
  const base = Math.floor(totalSymbols / blocks);
  const rem = totalSymbols % blocks;
  const out = [];
  for (let i = 0; i < blocks; i++) {
    const n = base + (i < rem ? 1 : 0);
    let parity = Math.max(1, Math.round(n * redundancy));
    parity = Math.min(parity, n - 1);
    out.push({ n, k: n - parity, parity });
  }
  return out;
}

export function rsEncodeBlocks(dataBytes, totalSymbols, redundancy) {
  const blocks = computeRSBlocks(totalSymbols, redundancy);
  const kTotal = blocks.reduce((s, b) => s + b.k, 0);
  if (dataBytes.length > kTotal) {
    throw new Error(`RS: data too large (${dataBytes.length} > ${kTotal})`);
  }
  const padded = new Uint8Array(kTotal);
  padded.set(dataBytes, 0);
  const encoded = [];
  let offset = 0;
  for (const b of blocks) {
    encoded.push(rsEncode(padded.subarray(offset, offset + b.k), b.parity));
    offset += b.k;
  }
  const maxN = Math.max(...blocks.map((b) => b.n));
  const out = new Uint8Array(totalSymbols);
  let p = 0;
  for (let col = 0; col < maxN; col++) {
    for (let i = 0; i < blocks.length; i++) {
      if (col < blocks[i].n) out[p++] = encoded[i][col];
    }
  }
  return out;
}

export function rsDecodeBlocks(received, redundancy) {
  const blocks = computeRSBlocks(received.length, redundancy);
  const data = blocks.map((b) => new Uint8Array(b.n));
  const maxN = Math.max(...blocks.map((b) => b.n));
  let p = 0;
  for (let col = 0; col < maxN; col++) {
    for (let i = 0; i < blocks.length; i++) {
      if (col < blocks[i].n) data[i][col] = received[p++];
    }
  }
  const out = [];
  let corrected = 0;
  for (let i = 0; i < blocks.length; i++) {
    const res = rsDecode(data[i], blocks[i].parity);
    out.push(res.data);
    corrected += res.corrected;
  }
  const total = out.reduce((s, b) => s + b.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of out) {
    merged.set(b, offset);
    offset += b.length;
  }
  return { data: merged, corrected };
}
