/**
 * Reversible luminance-rank constraint.
 *
 * The constraint is applied to the 16 luminance ranks:
 *   |rank(symbol_i) - rank(symbol_{i-1})| <= 8
 *
 * The symbol alphabet is the actual palette, so both "bucketed" and
 * "global" palettes work.  Blocks of up to 64 modules are encoded with an
 * exact enumerative code:
 *
 *   G[k][r] = number of continuations of length k after a symbol of rank r
 *   T[m][r] = number of length-m symbol sequences starting at rank r
 *   L[m]    = floor(log2(min_{r with symbols} T[m][r]))
 *
 * Each block carries exactly L[m] bits.  Unranking/ranking is lexicographic
 * by rank and then by palette index, so encoding and decoding are exact.
 */

import { BitWriter } from './bitstream.js';
import { CONSTRAINT_BLOCK, RANK_COUNT, RANK_MAX_DIFF } from './constants.js';

function allowed(a, b) {
  return Math.abs(a - b) <= RANK_MAX_DIFF;
}

function bitLength(x) {
  return x === 0n ? 0 : x.toString(2).length;
}

export class RankConstraint {
  constructor(paletteInfo, blockSize = CONSTRAINT_BLOCK) {
    this.rankCounts = paletteInfo.rankCounts;
    this.symbolsByRank = paletteInfo.symbolsByRank;
    this.rankOf = paletteInfo.rankOf;
    this.blockSize = blockSize;
    this.G = [];
    this.T = [null];
    this.L = [0];
    this.initialRank = this._initialRank();
    this._build();
  }

  _initialRank() {
    if (this.rankCounts[8] > 0) return 8;
    for (let r = 0; r < RANK_COUNT; r++) if (this.rankCounts[r] > 0) return r;
    throw new Error('constraint: palette has no symbols');
  }

  _build() {
    this.G.push(new Array(RANK_COUNT).fill(1n));
    for (let k = 1; k <= this.blockSize; k++) {
      const prev = this.G[k - 1];
      const row = new Array(RANK_COUNT).fill(0n);
      for (let r = 0; r < RANK_COUNT; r++) {
        let sum = 0n;
        for (let r2 = 0; r2 < RANK_COUNT; r2++) {
          const c = this.rankCounts[r2];
          if (c === 0 || !allowed(r, r2)) continue;
          sum += BigInt(c) * prev[r2];
        }
        row[r] = sum;
      }
      this.G.push(row);
    }

    for (let m = 1; m <= this.blockSize; m++) {
      const row = new Array(RANK_COUNT).fill(0n);
      let min = null;
      for (let r = 0; r < RANK_COUNT; r++) {
        const c = this.rankCounts[r];
        if (c === 0) continue;
        const v = BigInt(c) * this.G[m - 1][r];
        row[r] = v;
        if (min === null || v < min) min = v;
      }
      this.T.push(row);
      this.L.push(min === null ? 0 : bitLength(min) - 1);
    }
  }

  capacityBitsForModules(D) {
    const full = Math.floor(D / this.blockSize);
    const rem = D % this.blockSize;
    return full * this.L[this.blockSize] + (rem > 0 ? this.L[rem] : 0);
  }

  bitsPerModule(D) {
    return D === 0 ? 0 : this.capacityBitsForModules(D) / D;
  }

  encode(reader, D) {
    const symbols = [];
    let startRank = this.initialRank;
    let remaining = D;
    while (remaining > 0) {
      const m = Math.min(this.blockSize, remaining);
      const idx = reader.readBigInt(this.L[m]);
      const block = this._unrank(idx, m, startRank);
      for (const s of block) symbols.push(s);
      startRank = this.rankOf[block[block.length - 1]];
      remaining -= m;
    }
    return symbols;
  }

  decode(symbols) {
    const writer = new BitWriter();
    let startRank = this.initialRank;
    let pos = 0;
    while (pos < symbols.length) {
      const m = Math.min(this.blockSize, symbols.length - pos);
      const block = symbols.slice(pos, pos + m);
      const idx = this._rank(block, startRank);
      const L = this.L[m];
      if (idx >= (1n << BigInt(L))) throw new Error('constraint: decoded index out of range');
      writer.writeBigInt(idx, L);
      startRank = this.rankOf[block[block.length - 1]];
      pos += m;
    }
    return writer;
  }

  _unrank(idx, m, startRank) {
    const out = new Array(m);
    const count0 = this.rankCounts[startRank];
    if (count0 === 0) throw new Error('constraint: invalid start rank');
    const g0 = this.G[m - 1][startRank];
    let rest = idx;
    const first = rest / g0;
    rest %= g0;
    if (first >= BigInt(count0)) throw new Error('constraint: first symbol out of range');
    out[0] = this.symbolsByRank[startRank][Number(first)];
    let prevRank = startRank;
    for (let p = 1; p < m; p++) {
      const rem = m - p - 1;
      let chosen = false;
      for (let r2 = 0; r2 < RANK_COUNT; r2++) {
        const c = this.rankCounts[r2];
        if (c === 0 || !allowed(prevRank, r2)) continue;
        const g = this.G[rem][r2];
        const blockSize = BigInt(c) * g;
        if (rest < blockSize) {
          const symPos = rest / g;
          rest %= g;
          out[p] = this.symbolsByRank[r2][Number(symPos)];
          prevRank = r2;
          chosen = true;
          break;
        }
        rest -= blockSize;
      }
      if (!chosen) throw new Error('constraint: unranking failed');
    }
    return out;
  }

  _rank(block, startRank) {
    const m = block.length;
    let idx = 0n;
    const firstRank = this.rankOf[block[0]];
    if (firstRank !== startRank) throw new Error('constraint: unexpected block start rank');
    const pos0 = this.symbolsByRank[firstRank].indexOf(block[0]);
    if (pos0 < 0) throw new Error('constraint: unknown symbol');
    idx += BigInt(pos0) * this.G[m - 1][firstRank];
    let prevRank = firstRank;
    for (let p = 1; p < m; p++) {
      const rem = m - p - 1;
      const rank = this.rankOf[block[p]];
      if (!allowed(prevRank, rank)) throw new Error('constraint: symbol sequence violates constraint');
      const symPos = this.symbolsByRank[rank].indexOf(block[p]);
      if (symPos < 0) throw new Error('constraint: unknown symbol');
      for (let r2 = 0; r2 < rank; r2++) {
        const c = this.rankCounts[r2];
        if (c === 0 || !allowed(prevRank, r2)) continue;
        idx += BigInt(c) * this.G[rem][r2];
      }
      idx += BigInt(symPos) * this.G[rem][rank];
      prevRank = rank;
    }
    return idx;
  }
}
