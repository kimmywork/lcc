#include "lcc_internal.h"

#include <stdlib.h>
#include <string.h>

static uint8_t GF_EXP[512];
static uint8_t GF_LOG[256];
static int gf_ready = 0;

void lcc_gf_init(void) {
  if (gf_ready) return;
  int x = 1;
  for (int i = 0; i < 255; i++) {
    GF_EXP[i] = (uint8_t)x;
    GF_LOG[x] = (uint8_t)i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (int i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  gf_ready = 1;
}

int lcc_gf_mul(int a, int b) {
  lcc_gf_init();
  if (a == 0 || b == 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

int lcc_gf_div(int a, int b) {
  lcc_gf_init();
  if (b == 0) return -1;
  if (a == 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

int lcc_gf_inv(int a) {
  lcc_gf_init();
  if (a == 0) return -1;
  return GF_EXP[(255 - GF_LOG[a]) % 255];
}

int lcc_gf_pow(int a, int e) {
  lcc_gf_init();
  if (e == 0) return 1;
  if (a == 0) return 0;
  int exp = e % 255;
  if (exp < 0) exp += 255;
  return GF_EXP[(GF_LOG[a] * exp) % 255];
}

uint32_t lcc_crc32(const uint8_t *bytes, int len) {
  static uint32_t table[256];
  static int ready = 0;
  if (!ready) {
    for (int i = 0; i < 256; i++) {
      uint32_t c = (uint32_t)i;
      for (int k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
      table[i] = c;
    }
    ready = 1;
  }
  uint32_t c = 0xffffffffu;
  for (int i = 0; i < len; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >> 8);
  return c ^ 0xffffffffu;
}

static int popcount15(int x) {
  int c = 0;
  x &= 0x7fff;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

static int bch15_encode(int message) {
  const int gen = 0x537;
  int msg = message & 0x1f;
  int val = msg << 10;
  for (int i = 14; i >= 10; i--) {
    if ((val >> i) & 1) val ^= gen << (i - 10);
  }
  return ((msg << 10) | (val & 0x3ff)) & 0x7fff;
}

int lcc_bch15_decode(int word) {
  const int w = word & 0x7fff;
  int best = -1;
  int best_d = 99;
  for (int m = 0; m < 32; m++) {
    const int d = popcount15(w ^ bch15_encode(m));
    if (d < best_d) {
      best_d = d;
      best = m;
    }
  }
  return best_d <= 3 ? best : -1;
}

static int synd_of(const uint8_t *r, int n, int nsym, uint8_t *synd) {
  int has = 0;
  for (int k = 0; k < nsym; k++) {
    const int x = lcc_gf_pow(2, k);
    int val = 0;
    for (int j = n - 1; j >= 0; j--) val = lcc_gf_mul(val, x) ^ r[j];
    synd[k] = (uint8_t)val;
    if (val) has = 1;
  }
  return has;
}

static int eval_poly(const uint8_t *poly, int len, int x) {
  int val = 0;
  for (int i = len - 1; i >= 0; i--) val = lcc_gf_mul(val, x) ^ poly[i];
  return val;
}

static int berlekamp(const uint8_t *synd, int nsym, uint8_t *C, int *C_len) {
  uint8_t B[256];
  uint8_t T[256];
  memset(C, 0, 256);
  memset(B, 0, 256);
  C[0] = 1;
  B[0] = 1;
  int c_len = 1;
  int b_len = 1;
  int L = 0;
  int m = 1;
  int b = 1;
  for (int n = 0; n < nsym; n++) {
    int d = synd[n];
    for (int i = 1; i <= L; i++) {
      const int coef = i < c_len ? C[i] : 0;
      d ^= lcc_gf_mul(coef, synd[n - i]);
    }
    if (d == 0) {
      m++;
      continue;
    }
    memset(T, 0, 256);
    for (int i = 0; i < c_len; i++) T[i] = C[i];
    const int t_len = c_len;
    const int coef = lcc_gf_div(d, b);
    if (coef < 0) return 0;
    for (int i = 0; i < b_len; i++) {
      const int idx = i + m;
      if (idx >= 256) return 0;
      const int cur = idx < c_len ? C[idx] : 0;
      C[idx] = (uint8_t)(cur ^ lcc_gf_mul(coef, B[i]));
      if (idx + 1 > c_len) c_len = idx + 1;
    }
    if (2 * L <= n) {
      L = n + 1 - L;
      memset(B, 0, 256);
      for (int i = 0; i < t_len; i++) B[i] = T[i];
      b_len = t_len;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  *C_len = L + 1;
  return 1;
}

static int solve_gf(uint8_t *A, uint8_t *b, int n, uint8_t *out) {
  const int stride = n + 1;
  uint8_t *M = lcc_alloc((size_t)n * stride);
  if (!M) return 0;
  for (int r = 0; r < n; r++) {
    for (int c = 0; c < n; c++) M[r * stride + c] = A[r * n + c];
    M[r * stride + n] = b[r];
  }
  for (int col = 0; col < n; col++) {
    int pivot = col;
    while (pivot < n && M[pivot * stride + col] == 0) pivot++;
    if (pivot == n) {
      lcc_release(M);
      return 0;
    }
    if (pivot != col) {
      for (int j = col; j <= n; j++) {
        const uint8_t tmp = M[col * stride + j];
        M[col * stride + j] = M[pivot * stride + j];
        M[pivot * stride + j] = tmp;
      }
    }
    const int inv = lcc_gf_inv(M[col * stride + col]);
    if (inv < 0) {
      lcc_release(M);
      return 0;
    }
    for (int j = col; j <= n; j++) M[col * stride + j] = (uint8_t)lcc_gf_mul(M[col * stride + j], inv);
    for (int row = 0; row < n; row++) {
      if (row == col) continue;
      const int factor = M[row * stride + col];
      if (factor == 0) continue;
      for (int j = col; j <= n; j++) {
        M[row * stride + j] ^= (uint8_t)lcc_gf_mul(factor, M[col * stride + j]);
      }
    }
  }
  for (int r = 0; r < n; r++) out[r] = M[r * stride + n];
  lcc_release(M);
  return 1;
}

static int rs_decode_one(const uint8_t *received, int n, int nsym, uint8_t *data, int *corrected) {
  if (nsym <= 0) {
    memcpy(data, received, (size_t)n);
    *corrected = 0;
    return 1;
  }
  uint8_t *r = lcc_alloc((size_t)n);
  if (!r) return 0;
  for (int i = 0; i < n; i++) r[i] = received[n - 1 - i];
  uint8_t synd[256];
  if (!synd_of(r, n, nsym, synd)) {
    memcpy(data, received, (size_t)(n - nsym));
    *corrected = 0;
    lcc_release(r);
    return 1;
  }
  uint8_t lambda[256];
  int lambda_len = 0;
  if (!berlekamp(synd, nsym, lambda, &lambda_len)) {
    lcc_release(r);
    return 0;
  }
  const int t = lambda_len - 1;
  if (t <= 0 || t > nsym / 2) {
    lcc_release(r);
    return 0;
  }
  int positions[128];
  int np = 0;
  for (int j = 0; j < n; j++) {
    const int x = lcc_gf_pow(2, (255 - (j % 255)) % 255);
    if (eval_poly(lambda, lambda_len, x) == 0) {
      if (np >= 128) {
        lcc_release(r);
        return 0;
      }
      positions[np++] = j;
    }
  }
  if (np != t) {
    lcc_release(r);
    return 0;
  }
  uint8_t *A = lcc_alloc((size_t)t * t);
  uint8_t *rhs = lcc_alloc((size_t)t);
  uint8_t *mag = lcc_alloc((size_t)t);
  if (!A || !rhs || !mag) {
    lcc_release(A);
    lcc_release(rhs);
    lcc_release(mag);
    lcc_release(r);
    return 0;
  }
  for (int row = 0; row < t; row++) {
    for (int col = 0; col < t; col++) A[row * t + col] = (uint8_t)lcc_gf_pow(2, (row * positions[col]) % 255);
    rhs[row] = synd[row];
  }
  if (!solve_gf(A, rhs, t, mag)) {
    lcc_release(A);
    lcc_release(rhs);
    lcc_release(mag);
    lcc_release(r);
    return 0;
  }
  for (int l = 0; l < t; l++) r[positions[l]] ^= mag[l];
  if (synd_of(r, n, nsym, synd)) {
    lcc_release(A);
    lcc_release(rhs);
    lcc_release(mag);
    lcc_release(r);
    return 0;
  }
  for (int i = 0; i < n - nsym; i++) data[i] = r[n - 1 - i];
  *corrected = t;
  lcc_release(A);
  lcc_release(rhs);
  lcc_release(mag);
  lcc_release(r);
  return 1;
}

int lcc_rs_decode_blocks(const uint8_t *received, int len, double redundancy, uint8_t **out, int *out_len, int *corrected) {
  if (len <= 0) return 0;
  const int blocks = len > 255 ? (len + 254) / 255 : 1;
  const int base = len / blocks;
  const int rem = len % blocks;
  int ns[64];
  int ks[64];
  int ps[64];
  if (blocks > 64) return 0;
  int max_n = 0;
  int k_total = 0;
  for (int i = 0; i < blocks; i++) {
    const int n = base + (i < rem ? 1 : 0);
    int parity = (int)lcc_js_round(n * redundancy);
    if (parity < 1) parity = 1;
    if (parity > n - 1) parity = n - 1;
    ns[i] = n;
    ps[i] = parity;
    ks[i] = n - parity;
    k_total += ks[i];
    if (n > max_n) max_n = n;
  }
  uint8_t *data[64];
  memset(data, 0, sizeof(data));
  for (int i = 0; i < blocks; i++) {
    data[i] = lcc_alloc((size_t)ns[i]);
    if (!data[i]) return 0;
  }
  int p = 0;
  for (int col = 0; col < max_n; col++) {
    for (int i = 0; i < blocks; i++) {
      if (col < ns[i]) data[i][col] = received[p++];
    }
  }
  uint8_t *merged = lcc_alloc((size_t)k_total);
  if (!merged) return 0;
  int offset = 0;
  int corr = 0;
  for (int i = 0; i < blocks; i++) {
    int c = 0;
    if (!rs_decode_one(data[i], ns[i], ps[i], merged + offset, &c)) {
      for (int j = 0; j < blocks; j++) lcc_release(data[j]);
      lcc_release(merged);
      return 0;
    }
    corr += c;
    offset += ks[i];
  }
  for (int i = 0; i < blocks; i++) lcc_release(data[i]);
  *out = merged;
  *out_len = k_total;
  *corrected = corr;
  return 1;
}
