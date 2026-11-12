#include "lcc.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

void *lcc_alloc(size_t n) {
  return calloc(1, n ? n : 1);
}

void lcc_release(void *p) {
  free(p);
}

double lcc_js_round(double x) {
  return floor(x + 0.5);
}

const LccPaletteInfo *lcc_palette(const char *name, int harmony) {
  const LccPaletteInfo *fallback = NULL;
  for (int i = 0; i < lcc_palette_count; i++) {
    if (strcmp(lcc_palettes[i].name, name) != 0) continue;
    if (lcc_palettes[i].harmony == (harmony ? 1 : 0)) return &lcc_palettes[i];
    if (!fallback) fallback = &lcc_palettes[i];
  }
  return fallback;
}

static int clampi(int v, int lo, int hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

void lcc_sample_image(const LccImage *image, double x, double y, int radius, int rgb[3]) {
  const int cx = (int)lcc_js_round(x);
  const int cy = (int)lcc_js_round(y);
  int r = 0;
  int g = 0;
  int b = 0;
  int n = 0;
  for (int yy = cy - radius; yy <= cy + radius; yy++) {
    if (yy < 0 || yy >= image->height) continue;
    for (int xx = cx - radius; xx <= cx + radius; xx++) {
      if (xx < 0 || xx >= image->width) continue;
      const int p = (yy * image->width + xx) * 3;
      r += image->data[p];
      g += image->data[p + 1];
      b += image->data[p + 2];
      n++;
    }
  }
  if (n == 0) {
    rgb[0] = rgb[1] = rgb[2] = 255;
    return;
  }
  rgb[0] = (int)lcc_js_round((double)r / n);
  rgb[1] = (int)lcc_js_round((double)g / n);
  rgb[2] = (int)lcc_js_round((double)b / n);
}

void lcc_sample_bilinear(const LccImage *image, double x, double y, int rgb[3]) {
  const int x0 = (int)floor(x);
  const int y0 = (int)floor(y);
  const double fx = x - x0;
  const double fy = y - y0;
  const int x1 = x0 + 1;
  const int y1 = y0 + 1;
  int px[4][3];
  const int xs[4] = { x0, x1, x0, x1 };
  const int ys[4] = { y0, y0, y1, y1 };
  for (int i = 0; i < 4; i++) {
    const int cx = clampi(xs[i], 0, image->width - 1);
    const int cy = clampi(ys[i], 0, image->height - 1);
    const int p = (cy * image->width + cx) * 3;
    px[i][0] = image->data[p];
    px[i][1] = image->data[p + 1];
    px[i][2] = image->data[p + 2];
  }
  const double w00 = (1.0 - fx) * (1.0 - fy);
  const double w10 = fx * (1.0 - fy);
  const double w01 = (1.0 - fx) * fy;
  const double w11 = fx * fy;
  for (int ch = 0; ch < 3; ch++) {
    rgb[ch] = (int)lcc_js_round(
      px[0][ch] * w00 + px[1][ch] * w10 + px[2][ch] * w01 + px[3][ch] * w11);
  }
}

static void gather_bilinear(const LccImage *image, int x0, int y0, int px[4][3]) {
  const int x1 = x0 + 1;
  const int y1 = y0 + 1;
  const int xs[4] = { x0, x1, x0, x1 };
  const int ys[4] = { y0, y0, y1, y1 };
  for (int i = 0; i < 4; i++) {
    const int cx = clampi(xs[i], 0, image->width - 1);
    const int cy = clampi(ys[i], 0, image->height - 1);
    const int p = (cy * image->width + cx) * 3;
    px[i][0] = image->data[p];
    px[i][1] = image->data[p + 1];
    px[i][2] = image->data[p + 2];
  }
}

void lcc_sample_bilinear2(const LccImage *image, double x0, double y0, double x1, double y1, int rgb0[3], int rgb1[3]) {
#if defined(__wasm_simd128__)
  const int ix0 = (int)floor(x0);
  const int iy0 = (int)floor(y0);
  const int ix1 = (int)floor(x1);
  const int iy1 = (int)floor(y1);
  const double fx0 = x0 - ix0;
  const double fy0 = y0 - iy0;
  const double fx1 = x1 - ix1;
  const double fy1 = y1 - iy1;
  int p0[4][3];
  int p1[4][3];
  gather_bilinear(image, ix0, iy0, p0);
  gather_bilinear(image, ix1, iy1, p1);
  const double w00_0 = (1.0 - fx0) * (1.0 - fy0);
  const double w10_0 = fx0 * (1.0 - fy0);
  const double w01_0 = (1.0 - fx0) * fy0;
  const double w11_0 = fx0 * fy0;
  const double w00_1 = (1.0 - fx1) * (1.0 - fy1);
  const double w10_1 = fx1 * (1.0 - fy1);
  const double w01_1 = (1.0 - fx1) * fy1;
  const double w11_1 = fx1 * fy1;
  const double w0[4] = { w00_0, w10_0, w01_0, w11_0 };
  const double w1[4] = { w00_1, w10_1, w01_1, w11_1 };
  for (int ch = 0; ch < 3; ch++) {
    v128_t acc = wasm_f64x2_splat(0);
    for (int i = 0; i < 4; i++) {
      const v128_t sample = wasm_f64x2_make((double)p0[i][ch], (double)p1[i][ch]);
      const v128_t weight = wasm_f64x2_make(w0[i], w1[i]);
      acc = wasm_f64x2_add(acc, wasm_f64x2_mul(sample, weight));
    }
    rgb0[ch] = (int)lcc_js_round(wasm_f64x2_extract_lane(acc, 0));
    rgb1[ch] = (int)lcc_js_round(wasm_f64x2_extract_lane(acc, 1));
  }
#else
  lcc_sample_bilinear(image, x0, y0, rgb0);
  lcc_sample_bilinear(image, x1, y1, rgb1);
#endif
}

#if defined(__wasm_simd128__)
static void down2_pixel(const uint8_t *a, const uint8_t *b, uint8_t *out) {
  const v128_t az = wasm_u16x8_extend_low_u8x16(wasm_v128_load64_zero(a));
  const v128_t bz = wasm_u16x8_extend_low_u8x16(wasm_v128_load64_zero(b));
  const v128_t sum = wasm_i16x8_add(az, bz);
  const v128_t paired = wasm_i16x8_shuffle(sum, sum, 3, 4, 5, 0, 1, 2, 6, 7);
  const v128_t both = wasm_i16x8_add(sum, paired);
  const v128_t quarter = wasm_u16x8_shr(both, 2);
  out[0] = (uint8_t)wasm_u16x8_extract_lane(quarter, 0);
  out[1] = (uint8_t)wasm_u16x8_extract_lane(quarter, 1);
  out[2] = (uint8_t)wasm_u16x8_extract_lane(quarter, 2);
}
#endif

void lcc_downscale_box(const uint8_t *src, int sw, int sh, int factor, uint8_t *dst) {
  const int dw = sw / factor;
  const int dh = sh / factor;
  if (factor == 2) {
    for (int y = 0; y < dh; y++) {
      const uint8_t *a = src + (size_t)(y * 2) * (size_t)sw * 3;
      const uint8_t *b = a + (size_t)sw * 3;
      uint8_t *out = dst + (size_t)y * (size_t)dw * 3;
      for (int x = 0; x < dw; x++) {
#if defined(__wasm_simd128__)
        if (x + 1 < dw) {
          down2_pixel(a + (size_t)x * 6, b + (size_t)x * 6, out + (size_t)x * 3);
          continue;
        }
#endif
        const int i = x * 6;
        for (int ch = 0; ch < 3; ch++) {
          out[x * 3 + ch] = (uint8_t)((a[i + ch] + a[i + 3 + ch] + b[i + ch] + b[i + 3 + ch]) / 4);
        }
      }
    }
    return;
  }
  const int area = factor * factor;
  for (int y = 0; y < dh; y++) {
    for (int x = 0; x < dw; x++) {
      int acc[3] = { 0, 0, 0 };
      for (int dy = 0; dy < factor; dy++) {
        for (int dx = 0; dx < factor; dx++) {
          const int p = ((y * factor + dy) * sw + (x * factor + dx)) * 3;
          acc[0] += src[p];
          acc[1] += src[p + 1];
          acc[2] += src[p + 2];
        }
      }
      const int o = (y * dw + x) * 3;
      dst[o] = (uint8_t)(acc[0] / area);
      dst[o + 1] = (uint8_t)(acc[1] / area);
      dst[o + 2] = (uint8_t)(acc[2] / area);
    }
  }
}

int lcc_solve(const double *A, const double *b, int n, double *out) {
  double *M = lcc_alloc((size_t)n * (n + 1) * sizeof(double));
  if (!M) return 0;
  for (int r = 0; r < n; r++) {
    for (int c = 0; c < n; c++) M[r * (n + 1) + c] = A[r * n + c];
    M[r * (n + 1) + n] = b[r];
  }
  for (int col = 0; col < n; col++) {
    int pivot = col;
    for (int r = col + 1; r < n; r++) {
      if (fabs(M[r * (n + 1) + col]) > fabs(M[pivot * (n + 1) + col])) pivot = r;
    }
    if (fabs(M[pivot * (n + 1) + col]) < 1e-12) {
      lcc_release(M);
      return 0;
    }
    if (pivot != col) {
      for (int j = col; j <= n; j++) {
        const double tmp = M[col * (n + 1) + j];
        M[col * (n + 1) + j] = M[pivot * (n + 1) + j];
        M[pivot * (n + 1) + j] = tmp;
      }
    }
    const double pv = M[col * (n + 1) + col];
    for (int j = col; j <= n; j++) M[col * (n + 1) + j] /= pv;
    for (int r = 0; r < n; r++) {
      if (r == col) continue;
      const double f = M[r * (n + 1) + col];
      if (fabs(f) < 1e-15) continue;
      for (int j = col; j <= n; j++) M[r * (n + 1) + j] -= f * M[col * (n + 1) + j];
    }
  }
  for (int r = 0; r < n; r++) out[r] = M[r * (n + 1) + n];
  lcc_release(M);
  return 1;
}

/*
 * Estimate a gray-world per-channel gain and return a corrected copy.
 * Used only as a retry after the normal decode fails, so it cannot regress
 * frames that already decode.
 */
int lcc_white_balance_copy(const LccImage *src, LccImage *dst) {
  if (!src || !src->data || src->width <= 0 || src->height <= 0) return 0;
  uint64_t sr = 0, sg = 0, sb = 0;
  uint64_t n = 0;
  const size_t pixels = (size_t)src->width * (size_t)src->height;
  for (size_t i = 0; i < pixels; i += 4) {
    const uint8_t *p = src->data + i * 3;
    sr += p[0];
    sg += p[1];
    sb += p[2];
    n++;
  }
  if (n == 0 || sr == 0 || sg == 0 || sb == 0) return 0;
  const double mr = (double)sr / (double)n;
  const double mg = (double)sg / (double)n;
  const double mb = (double)sb / (double)n;
  const double target = (mr + mg + mb) / 3.0;
  double g[3] = { target / mr, target / mg, target / mb };
  for (int c = 0; c < 3; c++) {
    if (g[c] < 0.75) g[c] = 0.75;
    if (g[c] > 1.35) g[c] = 1.35;
  }
  if (fabs(g[0] - 1) < 0.005 && fabs(g[1] - 1) < 0.005 && fabs(g[2] - 1) < 0.005) {
    return 0;
  }
  uint8_t *data = lcc_alloc(pixels * 3);
  if (!data) return 0;
  for (size_t i = 0; i < pixels; i++) {
    const uint8_t *p = src->data + i * 3;
    uint8_t *q = data + i * 3;
    for (int c = 0; c < 3; c++) {
      int v = (int)lcc_js_round((double)p[c] * g[c]);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      q[c] = (uint8_t)v;
    }
  }
  dst->width = src->width;
  dst->height = src->height;
  dst->data = data;
  return 1;
}
