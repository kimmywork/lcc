#include "lcc.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

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
