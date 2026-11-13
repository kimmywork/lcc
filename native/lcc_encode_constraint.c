#include "lcc_encode_internal.h"

#include <string.h>

#define BIG_LIMBS 16
#define CONSTRAINT_BLOCK 64

typedef struct {
  uint32_t v[BIG_LIMBS];
} Big;

struct LccRankConstraint {
  int rank_count;
  int max_diff;
  int initial_rank;
  int block_size;
  int rank_counts[16];
  int symbol_counts[16];
  int symbols_by_rank[16][256];
  int rank_of[256];
  Big G[CONSTRAINT_BLOCK + 1][16];
  Big T[CONSTRAINT_BLOCK + 1][16];
  int L[CONSTRAINT_BLOCK + 1];
};

static void big_zero(Big *a) {
  memset(a, 0, sizeof(*a));
}

static void big_from_u32(Big *a, uint32_t v) {
  big_zero(a);
  a->v[0] = v;
}

static int big_is_zero(const Big *a) {
  for (int i = 0; i < BIG_LIMBS; i++) if (a->v[i]) return 0;
  return 1;
}

static int big_cmp(const Big *a, const Big *b) {
  for (int i = BIG_LIMBS - 1; i >= 0; i--) {
    if (a->v[i] < b->v[i]) return -1;
    if (a->v[i] > b->v[i]) return 1;
  }
  return 0;
}

static void big_add(Big *out, const Big *a, const Big *b) {
  uint64_t carry = 0;
  for (int i = 0; i < BIG_LIMBS; i++) {
    const uint64_t sum = (uint64_t)a->v[i] + (uint64_t)b->v[i] + carry;
    out->v[i] = (uint32_t)sum;
    carry = sum >> 32;
  }
}

static void big_sub(Big *out, const Big *a, const Big *b) {
  uint64_t borrow = 0;
  for (int i = 0; i < BIG_LIMBS; i++) {
    const uint64_t av = a->v[i];
    const uint64_t bv = (uint64_t)b->v[i] + borrow;
    out->v[i] = (uint32_t)(av - bv);
    borrow = av < bv ? 1 : 0;
  }
}

static void big_add_mul_small(Big *out, const Big *a, uint32_t m) {
  uint64_t carry = 0;
  for (int i = 0; i < BIG_LIMBS; i++) {
    const uint64_t cur = (uint64_t)a->v[i] * (uint64_t)m + carry;
    out->v[i] = (uint32_t)cur;
    carry = cur >> 32;
  }
}

static Big big_mul_small(const Big *a, uint32_t m) {
  Big out;
  big_add_mul_small(&out, a, m);
  return out;
}

static void big_shl1(Big *a) {
  uint32_t carry = 0;
  for (int i = 0; i < BIG_LIMBS; i++) {
    const uint32_t next = a->v[i] >> 31;
    a->v[i] = (a->v[i] << 1) | carry;
    carry = next;
  }
}

static int big_bitlen(const Big *a) {
  for (int i = BIG_LIMBS - 1; i >= 0; i--) {
    if (!a->v[i]) continue;
    uint32_t x = a->v[i];
    int bits = 0;
    while (x) {
      x >>= 1;
      bits++;
    }
    return i * 32 + bits;
  }
  return 0;
}

static int big_getbit(const Big *a, int bit) {
  if (bit < 0 || bit >= BIG_LIMBS * 32) return 0;
  return (a->v[bit / 32] >> (bit % 32)) & 1;
}

static void big_setbit(Big *a, int bit) {
  if (bit < 0 || bit >= BIG_LIMBS * 32) return;
  a->v[bit / 32] |= (uint32_t)1 << (bit % 32);
}

static uint32_t big_to_u32(const Big *a) {
  return a->v[0];
}

static void big_divmod(const Big *a, const Big *b, Big *q, Big *r) {
  big_zero(q);
  big_zero(r);
  if (big_is_zero(b)) return;
  const int bits = big_bitlen(a);
  for (int i = bits - 1; i >= 0; i--) {
    big_shl1(r);
    if (big_getbit(a, i)) r->v[0] |= 1u;
    if (big_cmp(r, b) >= 0) {
      Big t;
      big_sub(&t, r, b);
      *r = t;
      big_setbit(q, i);
    }
  }
}

static int allowed(const LccRankConstraint *rc, int a, int b) {
  int d = a - b;
  if (d < 0) d = -d;
  return d <= rc->max_diff;
}

LccRankConstraint *lcc_rank_constraint_build(const LccPaletteInfo *palette) {
  if (!palette || palette->rank_count <= 0 || palette->rank_count > 16) return NULL;
  LccRankConstraint *rc = lcc_alloc(sizeof(*rc));
  if (!rc) return NULL;
  rc->rank_count = palette->rank_count;
  rc->max_diff = palette->max_rank_diff;
  rc->initial_rank = palette->initial_rank;
  rc->block_size = CONSTRAINT_BLOCK;
  memset(rc->symbol_counts, 0, sizeof(rc->symbol_counts));
  for (int i = 0; i < palette->palette_size && i < 256; i++) {
    const int rank = palette->rank_of[i];
    rc->rank_of[i] = rank;
    if (rank >= 0 && rank < rc->rank_count) {
      rc->symbols_by_rank[rank][rc->symbol_counts[rank]++] = i;
    }
  }
  for (int r = 0; r < rc->rank_count; r++) rc->rank_counts[r] = rc->symbol_counts[r];

  for (int r = 0; r < rc->rank_count; r++) big_from_u32(&rc->G[0][r], 1);

  for (int k = 1; k <= rc->block_size; k++) {
    for (int r = 0; r < rc->rank_count; r++) {
      Big sum;
      big_zero(&sum);
      for (int r2 = 0; r2 < rc->rank_count; r2++) {
        const int c = rc->rank_counts[r2];
        if (c == 0 || !allowed(rc, r, r2)) continue;
        Big term = big_mul_small(&rc->G[k - 1][r2], (uint32_t)c);
        Big next;
        big_add(&next, &sum, &term);
        sum = next;
      }
      rc->G[k][r] = sum;
    }
  }

  rc->L[0] = 0;
  for (int m = 1; m <= rc->block_size; m++) {
    Big min;
    int has_min = 0;
    for (int r = 0; r < rc->rank_count; r++) {
      const int c = rc->rank_counts[r];
      if (c == 0) {
        big_zero(&rc->T[m][r]);
        continue;
      }
      Big v = big_mul_small(&rc->G[m - 1][r], (uint32_t)c);
      rc->T[m][r] = v;
      if (!has_min || big_cmp(&v, &min) < 0) {
        min = v;
        has_min = 1;
      }
    }
    rc->L[m] = has_min ? big_bitlen(&min) - 1 : 0;
    if (rc->L[m] < 0) rc->L[m] = 0;
  }
  return rc;
}

void lcc_rank_constraint_free(LccRankConstraint *rc) {
  lcc_release(rc);
}

int lcc_rank_constraint_capacity_bits(const LccRankConstraint *rc, int modules) {
  if (!rc || modules <= 0) return 0;
  const int full = modules / rc->block_size;
  const int rem = modules % rc->block_size;
  return full * rc->L[rc->block_size] + (rem > 0 ? rc->L[rem] : 0);
}

typedef struct {
  const uint8_t *bytes;
  int bit_length;
  int pos;
} BitReader;

static int read_bit(BitReader *r) {
  if (r->pos >= r->bit_length) return 0;
  const int byte = r->bytes[r->pos >> 3];
  const int bit = (byte >> (7 - (r->pos & 7))) & 1;
  r->pos++;
  return bit;
}

static Big read_big(BitReader *r, int n) {
  Big v;
  big_zero(&v);
  for (int i = 0; i < n; i++) {
    big_shl1(&v);
    if (read_bit(r)) v.v[0] |= 1u;
  }
  return v;
}

static int unrank(
  const LccRankConstraint *rc,
  const Big *idx,
  int m,
  int start_rank,
  int16_t *out
) {
  const int R = rc->rank_count;
  const int count0 = rc->rank_counts[start_rank];
  if (count0 == 0) return 0;
  Big g0 = rc->G[m - 1][start_rank];
  Big first_q, rest;
  big_divmod(idx, &g0, &first_q, &rest);
  const uint32_t first = big_to_u32(&first_q);
  if (first >= (uint32_t)count0) return 0;
  out[0] = (int16_t)rc->symbols_by_rank[start_rank][first];
  int prev = start_rank;

  for (int p = 1; p < m; p++) {
    const int rem = m - p - 1;
    int chosen = 0;
    for (int r2 = 0; r2 < R; r2++) {
      const int c = rc->rank_counts[r2];
      if (c == 0 || !allowed(rc, prev, r2)) continue;
      const Big *g = &rc->G[rem][r2];
      Big block = big_mul_small(g, (uint32_t)c);
      if (big_cmp(&rest, &block) < 0) {
        Big q, rr;
        big_divmod(&rest, g, &q, &rr);
        const uint32_t sympos = big_to_u32(&q);
        if (sympos >= (uint32_t)c) return 0;
        out[p] = (int16_t)rc->symbols_by_rank[r2][sympos];
        rest = rr;
        prev = r2;
        chosen = 1;
        break;
      }
      Big next;
      big_sub(&next, &rest, &block);
      rest = next;
    }
    if (!chosen) return 0;
  }
  return 1;
}

static int symbol_index(const LccRankConstraint *rc, int rank, int symbol) {
  for (int i = 0; i < rc->symbol_counts[rank]; i++) {
    if (rc->symbols_by_rank[rank][i] == symbol) return i;
  }
  return -1;
}

static int closest_symbol(const LccRankConstraint *rc, int rank, int symbol) {
  int best = rc->symbols_by_rank[rank][0];
  int best_d = 1 << 30;
  for (int i = 0; i < rc->symbol_counts[rank]; i++) {
    const int s = rc->symbols_by_rank[rank][i];
    int d = s - symbol;
    if (d < 0) d = -d;
    if (d < best_d) {
      best_d = d;
      best = s;
    }
  }
  return best;
}

static void correct_block(const LccRankConstraint *rc, int16_t *block, int m, int start_rank) {
  if (rc->rank_of[block[0]] != start_rank) {
    block[0] = (int16_t)closest_symbol(rc, start_rank, block[0]);
  }
  for (int p = 1; p < m; p++) {
    const int prev = rc->rank_of[block[p - 1]];
    const int obs = rc->rank_of[block[p]];
    if (allowed(rc, prev, obs)) continue;
    int best_rank = prev;
    int best_d = 1 << 30;
    for (int r = 0; r < rc->rank_count; r++) {
      if (rc->rank_counts[r] == 0 || !allowed(rc, prev, r)) continue;
      int d = r - obs;
      if (d < 0) d = -d;
      if (d < best_d) {
        best_d = d;
        best_rank = r;
      }
    }
    block[p] = (int16_t)closest_symbol(rc, best_rank, block[p]);
  }
}

static int rank_block(const LccRankConstraint *rc, const int16_t *block, int m, int start_rank, Big *out) {
  Big idx;
  big_zero(&idx);
  const int first_rank = rc->rank_of[block[0]];
  if (first_rank != start_rank) return 0;
  const int pos0 = symbol_index(rc, first_rank, block[0]);
  if (pos0 < 0) return 0;
  Big term = big_mul_small(&rc->G[m - 1][first_rank], (uint32_t)pos0);
  big_add(&idx, &idx, &term);
  int prev = first_rank;
  for (int p = 1; p < m; p++) {
    const int rem = m - p - 1;
    const int rank = rc->rank_of[block[p]];
    if (!allowed(rc, prev, rank)) return 0;
    const int sympos = symbol_index(rc, rank, block[p]);
    if (sympos < 0) return 0;
    for (int r2 = 0; r2 < rank; r2++) {
      const int c = rc->rank_counts[r2];
      if (c == 0 || !allowed(rc, prev, r2)) continue;
      Big part = big_mul_small(&rc->G[rem][r2], (uint32_t)c);
      big_add(&idx, &idx, &part);
    }
    Big part = big_mul_small(&rc->G[rem][rank], (uint32_t)sympos);
    big_add(&idx, &idx, &part);
    prev = rank;
  }
  *out = idx;
  return 1;
}

int lcc_rank_constraint_decode(
  const LccRankConstraint *rc,
  const int16_t *symbols,
  int count,
  uint8_t **out,
  int *out_bits
) {
  if (!rc || !symbols || count <= 0) return 0;
  int total_bits = lcc_rank_constraint_capacity_bits(rc, count);
  const int bytes = (total_bits + 7) / 8;
  uint8_t *buffer = lcc_alloc((size_t)bytes);
  if (!buffer) return 0;
  int write_pos = 0;
  int start = rc->initial_rank;
  int pos = 0;
  while (pos < count) {
    const int m = count - pos < rc->block_size ? count - pos : rc->block_size;
    int16_t block[CONSTRAINT_BLOCK];
    memcpy(block, symbols + pos, (size_t)m * sizeof(int16_t));
    correct_block(rc, block, m, start);
    Big idx;
    if (!rank_block(rc, block, m, start, &idx)) {
      lcc_release(buffer);
      return 0;
    }
    const int L = rc->L[m];
    for (int bit = L - 1; bit >= 0; bit--) {
      const int value = big_getbit(&idx, bit);
      if (write_pos < total_bits) {
        if (value) buffer[write_pos >> 3] |= (uint8_t)(1u << (7 - (write_pos & 7)));
        write_pos++;
      }
    }
    start = rc->rank_of[block[m - 1]];
    pos += m;
  }
  *out_bits = total_bits;
  *out = buffer;
  return 1;
}

int lcc_rank_constraint_encode(
  const LccRankConstraint *rc,
  const uint8_t *bytes,
  int bit_length,
  int modules,
  int16_t *symbols
) {
  if (!rc || !symbols || modules <= 0) return 0;
  BitReader reader = { bytes, bit_length, 0 };
  int start = rc->initial_rank;
  int remaining = modules;
  int pos = 0;
  while (remaining > 0) {
    const int m = remaining < rc->block_size ? remaining : rc->block_size;
    const Big idx = read_big(&reader, rc->L[m]);
    if (!unrank(rc, &idx, m, start, symbols + pos)) return 0;
    start = rc->rank_of[symbols[pos + m - 1]];
    pos += m;
    remaining -= m;
  }
  return 1;
}
