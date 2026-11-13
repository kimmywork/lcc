#include "lcc_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static int otsu_threshold(const uint8_t *gray, int n) {
  uint32_t hist[256];
  memset(hist, 0, sizeof(hist));
  for (int i = 0; i < n; i++) hist[gray[i]]++;
  double sum = 0;
  for (int i = 0; i < 256; i++) sum += (double)i * hist[i];
  double sum_b = 0;
  double w_b = 0;
  double best = -1;
  int threshold = 128;
  for (int t = 0; t < 256; t++) {
    w_b += hist[t];
    if (w_b == 0) continue;
    const double w_f = (double)n - w_b;
    if (w_f == 0) break;
    sum_b += (double)t * hist[t];
    const double m_b = sum_b / w_b;
    const double m_f = (sum - sum_b) / w_f;
    const double between = w_b * w_f * (m_b - m_f) * (m_b - m_f);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

static double robust_threshold(const uint8_t *gray, int n) {
  int mn = 255;
  int mx = 0;
  for (int i = 0; i < n; i++) {
    if (gray[i] < mn) mn = gray[i];
    if (gray[i] > mx) mx = gray[i];
  }
  if (mn == mx) return 128;
  int threshold = otsu_threshold(gray, n);
  if (threshold <= mn || threshold >= mx) threshold = (mn + mx) / 2;
  return threshold;
}

static double *integral_image(const uint8_t *gray, int width, int height) {
  const int W = width + 1;
  double *I = lcc_alloc((size_t)W * (height + 1) * sizeof(double));
  if (!I) return NULL;
  for (int y = 0; y < height; y++) {
    double row = 0;
    for (int x = 0; x < width; x++) {
      row += gray[y * width + x];
      I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + row;
    }
  }
  return I;
}

static void adaptive_mask(const uint8_t *gray, int width, int height, const double *integral, int window, double offset, uint8_t *mask, float *threshold) {
  const int W = width + 1;
  int radius = window / 2;
  if (radius < 4) radius = 4;
  for (int y = 0; y < height; y++) {
    const int y0 = y - radius > 0 ? y - radius : 0;
    const int y1 = y + radius + 1 < height ? y + radius + 1 : height;
    for (int x = 0; x < width; x++) {
      const int x0 = x - radius > 0 ? x - radius : 0;
      const int x1 = x + radius + 1 < width ? x + radius + 1 : width;
      const int area = (x1 - x0) * (y1 - y0);
      const double sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      const double mean = sum / area;
      const double t = mean * (1.0 - offset);
      const int i = y * width + x;
      threshold[i] = (float)t;
      mask[i] = gray[i] < t ? 1 : 0;
    }
  }
}

static uint8_t *morph_close(const uint8_t *mask, int width, int height) {
  uint8_t *dilated = lcc_alloc((size_t)width * height);
  uint8_t *out = lcc_alloc((size_t)width * height);
  if (!dilated || !out) {
    lcc_release(dilated);
    lcc_release(out);
    return NULL;
  }
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      int v = 0;
      for (int dy = -1; dy <= 1 && !v; dy++) {
        const int yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (int dx = -1; dx <= 1; dx++) {
          const int xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (mask[yy * width + xx]) {
            v = 1;
            break;
          }
        }
      }
      dilated[y * width + x] = (uint8_t)v;
    }
  }
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      int v = 1;
      for (int dy = -1; dy <= 1 && v; dy++) {
        const int yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (int dx = -1; dx <= 1; dx++) {
          const int xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (!dilated[yy * width + xx]) {
            v = 0;
            break;
          }
        }
      }
      out[y * width + x] = (uint8_t)v;
    }
  }
  lcc_release(dilated);
  return out;
}

int lcc_prep_init(LccPrep *prep, const LccImage *image) {
  memset(prep, 0, sizeof(*prep));
  size_t bytes = 0;
  if (!lcc_image_geometry(image->width, image->height, &bytes)) return 0;
  const size_t n = bytes / 3;
  prep->width = image->width;
  prep->height = image->height;
  prep->rgb = image->data;
  prep->gray = lcc_alloc(n);
  prep->value = lcc_alloc(n);
  prep->sat = lcc_alloc(n * sizeof(float));
  if (!prep->gray || !prep->value || !prep->sat) {
    lcc_prep_free(prep);
    return 0;
  }
  for (size_t i = 0, p = 0; i < n; i++, p += 3) {
    const int r = image->data[p];
    const int g = image->data[p + 1];
    const int b = image->data[p + 2];
    prep->gray[i] = (uint8_t)lcc_js_round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const int mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const int mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    prep->value[i] = (uint8_t)mx;
    prep->sat[i] = mx == 0 ? 0 : (float)(mx - mn) / (float)mx;
  }
  prep->gray_otsu = robust_threshold(prep->gray, (int)n);
  prep->value_otsu = robust_threshold(prep->value, (int)n);
  prep->gray_integral = integral_image(prep->gray, image->width, image->height);
  prep->value_integral = integral_image(prep->value, image->width, image->height);
  if (!prep->gray_integral || !prep->value_integral) {
    lcc_prep_free(prep);
    return 0;
  }
  return 1;
}

void lcc_prep_free(LccPrep *prep) {
  lcc_release(prep->gray);
  lcc_release(prep->value);
  lcc_release(prep->sat);
  lcc_release(prep->gray_integral);
  lcc_release(prep->value_integral);
  memset(prep, 0, sizeof(*prep));
}

void lcc_variant_free(LccVariant *v) {
  lcc_release(v->mask);
  lcc_release(v->threshold);
  v->mask = NULL;
  v->threshold = NULL;
}

double lcc_threshold_at(const LccVariant *v, double x, double y) {
  if (!v->threshold) return v->otsu;
  int xx = (int)lcc_js_round(x);
  int yy = (int)lcc_js_round(y);
  if (xx < 0) xx = 0;
  if (yy < 0) yy = 0;
  if (xx >= v->width) xx = v->width - 1;
  if (yy >= v->height) yy = v->height - 1;
  return v->threshold[yy * v->width + xx];
}

int lcc_variant_build(LccPrep *prep, const char *name, LccVariant *out) {
  memset(out, 0, sizeof(*out));
  out->width = prep->width;
  out->height = prep->height;
  const size_t n = (size_t)prep->width * (size_t)prep->height;
  const int value = strncmp(name, "value-", 6) == 0;
  const char *body = value ? name + 6 : name;
  int close = 0;
  char base[64];
  strncpy(base, body, sizeof(base) - 1);
  const size_t len = strlen(base);
  if (len > 6 && strcmp(base + len - 6, "+close") == 0) {
    close = 1;
    base[len - 6] = 0;
  }
  const uint8_t *src = value ? prep->value : prep->gray;
  const double *integral = value ? prep->value_integral : prep->gray_integral;
  const double otsu = value ? prep->value_otsu : prep->gray_otsu;
  uint8_t *mask = lcc_alloc(n);
  if (!mask) return 0;
  float *threshold = NULL;
  if (strcmp(base, "otsu") == 0) {
    for (size_t i = 0; i < n; i++) {
      int on = src[i] < otsu;
      if (value) on = on && (prep->sat[i] < 0.5f || prep->value[i] < 80);
      mask[i] = (uint8_t)on;
    }
    out->otsu = otsu;
  } else if (strncmp(base, "adaptive-", 9) == 0) {
    int window = 15;
    double offset = 0.15;
    if (strcmp(base, "adaptive-1/8") == 0) {
      window = prep->width < prep->height ? prep->width : prep->height;
      window = window / 8;
      if (window < 15) window = 15;
      offset = 0.15;
    } else if (strcmp(base, "adaptive-1/16") == 0) {
      window = prep->width < prep->height ? prep->width : prep->height;
      window = window / 16;
      if (window < 11) window = 11;
      offset = 0.10;
    } else if (strcmp(base, "adaptive-1/4") == 0) {
      window = prep->width < prep->height ? prep->width : prep->height;
      window = window / 4;
      if (window < 21) window = 21;
      offset = 0.20;
    } else {
      lcc_release(mask);
      return 0;
    }
    threshold = lcc_alloc((size_t)n * sizeof(float));
    if (!threshold) {
      lcc_release(mask);
      return 0;
    }
    adaptive_mask(src, prep->width, prep->height, integral, window, offset, mask, threshold);
    if (value) {
      for (size_t i = 0; i < n; i++) {
        mask[i] = mask[i] && (prep->sat[i] < 0.5f || prep->value[i] < 80) ? 1 : 0;
      }
    }
    out->otsu = otsu;
  } else {
    lcc_release(mask);
    return 0;
  }
  if (close) {
    uint8_t *closed = morph_close(mask, prep->width, prep->height);
    lcc_release(mask);
    if (!closed) {
      lcc_release(threshold);
      return 0;
    }
    mask = closed;
  }
  out->mask = mask;
  out->threshold = threshold;
  out->constant = threshold ? 0 : 1;
  return 1;
}
