#include "lcc_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef LCC_ENABLE_MODELS

int lcc_model_get_features(void) { return 0; }
void lcc_model_set_features(int features) { (void)features; }
void lcc_bilinear_resample(const float *src, int sw, int sh, float *dst, int dw, int dh) {
  (void)src; (void)sw; (void)sh; (void)dst; (void)dw; (void)dh;
}
void lcc_sr_forward(const float *x, float *out) {
  (void)x;
  for (int i = 0; i < 32 * 32; i++) out[i] = 0;
}
void lcc_shape_forward(const float *x, float *logits) {
  (void)x;
  for (int i = 0; i < 8; i++) logits[i] = 0;
}
void lcc_cheap_shape_forward(const float *x, float *logits) {
  (void)x;
  for (int i = 0; i < 8; i++) logits[i] = 0;
}
int lcc_finder_centers(const uint8_t *gray, int width, int height, double out[3][2]) {
  (void)gray; (void)width; (void)height; (void)out;
  return 0;
}

#else

#include "model_weights.h"

/* Feature bits are declared in lcc.h. */
static int g_features = 0;

int lcc_model_get_features(void) {
  return g_features;
}

void lcc_model_set_features(int features) {
  g_features = features;
}

void lcc_bilinear_resample(const float *src, int sw, int sh, float *dst, int dw, int dh) {
  const double sx = (double)sw / (double)dw;
  const double sy = (double)sh / (double)dh;
  for (int y = 0; y < dh; y++) {
    double fy = ((double)y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    if (fy > sh - 1) fy = sh - 1;
    const int y0 = (int)floor(fy);
    const int y1 = y0 + 1 < sh ? y0 + 1 : y0;
    const double ty = fy - y0;
    for (int x = 0; x < dw; x++) {
      double fx = ((double)x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      if (fx > sw - 1) fx = sw - 1;
      const int x0 = (int)floor(fx);
      const int x1 = x0 + 1 < sw ? x0 + 1 : x0;
      const double tx = fx - x0;
      const double a = src[(size_t)y0 * (size_t)sw + (size_t)x0];
      const double b = src[(size_t)y0 * (size_t)sw + (size_t)x1];
      const double c = src[(size_t)y1 * (size_t)sw + (size_t)x0];
      const double d = src[(size_t)y1 * (size_t)sw + (size_t)x1];
      dst[(size_t)y * (size_t)dw + (size_t)x] = (float)(
        a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
      );
    }
  }
}

static void conv3x3_relu(
  const float *in,
  int in_ch,
  int w,
  int h,
  const float *weight,
  const float *bias,
  int out_ch,
  float *out
) {
  for (int oc = 0; oc < out_ch; oc++) {
    const float *wo = weight + (size_t)oc * (size_t)in_ch * 9;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        double sum = bias ? bias[oc] : 0;
        for (int ic = 0; ic < in_ch; ic++) {
          const float *wi = wo + (size_t)ic * 9;
          for (int ky = -1; ky <= 1; ky++) {
            const int yy = y + ky;
            if (yy < 0 || yy >= h) continue;
            for (int kx = -1; kx <= 1; kx++) {
              const int xx = x + kx;
              if (xx < 0 || xx >= w) continue;
              sum += (double)wi[(ky + 1) * 3 + (kx + 1)] *
                (double)in[((size_t)ic * (size_t)h + (size_t)yy) * (size_t)w + (size_t)xx];
            }
          }
        }
        out[((size_t)oc * (size_t)h + (size_t)y) * (size_t)w + (size_t)x] =
          (float)(sum > 0 ? sum : 0);
      }
    }
  }
}

static void conv3x3_stride2_relu(
  const float *in,
  int in_ch,
  int w,
  int h,
  const float *weight,
  const float *bias,
  int out_ch,
  float *out
) {
  const int ow = (w + 1) / 2;
  const int oh = (h + 1) / 2;
  for (int oc = 0; oc < out_ch; oc++) {
    const float *wo = weight + (size_t)oc * (size_t)in_ch * 9;
    for (int y = 0; y < oh; y++) {
      for (int x = 0; x < ow; x++) {
        const int cy = y * 2;
        const int cx = x * 2;
        double sum = bias ? bias[oc] : 0;
        for (int ic = 0; ic < in_ch; ic++) {
          const float *wi = wo + (size_t)ic * 9;
          for (int ky = -1; ky <= 1; ky++) {
            const int yy = cy + ky;
            if (yy < 0 || yy >= h) continue;
            for (int kx = -1; kx <= 1; kx++) {
              const int xx = cx + kx;
              if (xx < 0 || xx >= w) continue;
              sum += (double)wi[(ky + 1) * 3 + (kx + 1)] *
                (double)in[((size_t)ic * (size_t)h + (size_t)yy) * (size_t)w + (size_t)xx];
            }
          }
        }
        out[((size_t)oc * (size_t)oh + (size_t)y) * (size_t)ow + (size_t)x] =
          (float)(sum > 0 ? sum : 0);
      }
    }
  }
}

static void conv1x1(
  const float *in,
  int in_ch,
  int w,
  int h,
  const float *weight,
  const float *bias,
  int out_ch,
  float *out
) {
  for (int oc = 0; oc < out_ch; oc++) {
    const float *wo = weight + (size_t)oc * (size_t)in_ch;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        double sum = bias ? bias[oc] : 0;
        for (int ic = 0; ic < in_ch; ic++) {
          sum += (double)wo[ic] * (double)in[((size_t)ic * (size_t)h + (size_t)y) * (size_t)w + (size_t)x];
        }
        out[((size_t)oc * (size_t)h + (size_t)y) * (size_t)w + (size_t)x] = (float)sum;
      }
    }
  }
}

static void conv3x3(
  const float *in,
  int in_ch,
  int w,
  int h,
  const float *weight,
  const float *bias,
  int out_ch,
  float *out
) {
  for (int oc = 0; oc < out_ch; oc++) {
    const float *wo = weight + (size_t)oc * (size_t)in_ch * 9;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        double sum = bias ? bias[oc] : 0;
        for (int ic = 0; ic < in_ch; ic++) {
          const float *wi = wo + (size_t)ic * 9;
          for (int ky = -1; ky <= 1; ky++) {
            const int yy = y + ky;
            if (yy < 0 || yy >= h) continue;
            for (int kx = -1; kx <= 1; kx++) {
              const int xx = x + kx;
              if (xx < 0 || xx >= w) continue;
              sum += (double)wi[(ky + 1) * 3 + (kx + 1)] *
                (double)in[((size_t)ic * (size_t)h + (size_t)yy) * (size_t)w + (size_t)xx];
            }
          }
        }
        out[((size_t)oc * (size_t)h + (size_t)y) * (size_t)w + (size_t)x] = (float)sum;
      }
    }
  }
}

/*
 * Shape-layer residual super-resolution.
 *
 * x is a normalized 16x16 luminance-residual grid. out is a normalized 32x32
 * residual. The network is four 3x3 convolutions plus a bilinear skip.
 */
void lcc_sr_forward(const float *x, float *out) {
  enum { G = LCC_SR_GRID, T = LCC_SR_TARGET, W = LCC_SR_WIDTH };
  static float a[W * G * G];
  static float b[W * G * G];
  static float c[W * G * G];
  static float d[W * T * T];
  static float skip[T * T];

  conv3x3_relu(x, 1, G, G, LCC_SR_C1_W, LCC_SR_C1_B, W, a);
  conv3x3_relu(a, W, G, G, LCC_SR_C2_W, LCC_SR_C2_B, W, b);
  conv3x3_relu(b, W, G, G, LCC_SR_C3_W, LCC_SR_C3_B, W, c);
  for (int ch = 0; ch < W; ch++) {
    lcc_bilinear_resample(c + (size_t)ch * G * G, G, G, d + (size_t)ch * T * T, T, T);
  }
  conv3x3(d, W, T, T, LCC_SR_C4_W, LCC_SR_C4_B, 1, out);
  lcc_bilinear_resample(x, G, G, skip, T, T);
  for (int i = 0; i < T * T; i++) out[i] += skip[i];
}

/*
 * Module-level shape classifier over the decoder's 16x16 residual grid.
 * Three 3x3 convolutions, global average + max pooling, linear 8-way head.
 */
void lcc_shape_forward(const float *x, float *logits) {
  enum { G = LCC_SHAPE_GRID, W = LCC_SHAPE_WIDTH };
  static float a[W * G * G];
  static float b[W * G * G];
  static float c[W * G * G];
  conv3x3_relu(x, 1, G, G, LCC_SHAPE_C1_W, LCC_SHAPE_C1_B, W, a);
  conv3x3_relu(a, W, G, G, LCC_SHAPE_C2_W, LCC_SHAPE_C2_B, W, b);
  conv3x3_relu(b, W, G, G, LCC_SHAPE_C3_W, LCC_SHAPE_C3_B, W, c);
  float feat[2 * W];
  for (int ch = 0; ch < W; ch++) {
    double sum = 0;
    float mx = -1e30f;
    for (int i = 0; i < G * G; i++) {
      const float v = c[(size_t)ch * G * G + i];
      sum += v;
      if (v > mx) mx = v;
    }
    feat[ch] = (float)(sum / (G * G));
    feat[W + ch] = mx;
  }
  for (int o = 0; o < 8; o++) {
    double sum = LCC_SHAPE_FC_B[o];
    for (int i = 0; i < 2 * W; i++) sum += (double)LCC_SHAPE_FC_W[o * 2 * W + i] * feat[i];
    logits[o] = (float)sum;
  }
}

/*
 * Cheap shape classifier: absolute 16x16 residual + row/column/diagonal
 * projections + four radial band energies -> 324 -> 64 -> 8 MLP.
 */
void lcc_cheap_shape_forward(const float *x, float *logits) {
  enum { G = 16, IN = LCC_CHEAP_IN, H = LCC_CHEAP_HIDDEN };
  float a[G * G];
  float feat[IN];
  for (int i = 0; i < G * G; i++) a[i] = fabsf(x[i]);
  for (int i = 0; i < 256; i++) feat[i] = a[i];
  for (int y = 0; y < G; y++) {
    double rs = 0;
    for (int x2 = 0; x2 < G; x2++) rs += a[y * G + x2];
    feat[256 + y] = (float)rs;
  }
  for (int x2 = 0; x2 < G; x2++) {
    double cs = 0;
    for (int y = 0; y < G; y++) cs += a[y * G + x2];
    feat[272 + x2] = (float)cs;
  }
  double diag[31] = { 0 };
  double anti[31] = { 0 };
  double bands[4] = { 0 };
  for (int y = 0; y < G; y++) {
    for (int x2 = 0; x2 < G; x2++) {
      const double v = a[y * G + x2];
      diag[y - x2 + 15] += v;
      anti[y + x2] += v;
      const double dy = y - 7.5;
      const double dx = x2 - 7.5;
      const double r2 = dy * dy + dx * dx;
      if (r2 < 9) bands[0] += v * v;
      else if (r2 < 36) bands[1] += v * v;
      else if (r2 < 81) bands[2] += v * v;
      else if (r2 < 144) bands[3] += v * v;
    }
  }
  for (int i = 0; i < 16; i++) {
    feat[288 + i] = (float)diag[i * 2];
    feat[304 + i] = (float)anti[i * 2];
  }
  for (int i = 0; i < 4; i++) feat[320 + i] = (float)bands[i];

  float hidden[H];
  for (int h = 0; h < H; h++) {
    double sum = LCC_CHEAP_B1[h];
    for (int i = 0; i < IN; i++) sum += (double)LCC_CHEAP_W1[h * IN + i] * feat[i];
    hidden[h] = sum > 0 ? (float)sum : 0;
  }
  for (int o = 0; o < 8; o++) {
    double sum = LCC_CHEAP_B2[o];
    for (int h = 0; h < H; h++) sum += (double)LCC_CHEAP_W2[o * H + h] * hidden[h];
    logits[o] = (float)sum;
  }
}

typedef struct {
  float score;
  int x;
  int y;
} HeatPeak;

static int peak_cmp(const void *a, const void *b) {
  const HeatPeak *pa = (const HeatPeak *)a;
  const HeatPeak *pb = (const HeatPeak *)b;
  if (pa->score < pb->score) return 1;
  if (pa->score > pb->score) return -1;
  return 0;
}

/*
 * Find the three LCC locator centers. gray is a normal grayscale image. The
 * returned coordinates are in that image's pixel space.
 */
int lcc_finder_centers(const uint8_t *gray, int width, int height, double out[3][2]) {
  enum {
    IN = LCC_FINDER_INPUT,
    ST = LCC_FINDER_STRIDE,
    HEAT = LCC_FINDER_INPUT / LCC_FINDER_STRIDE,
    W = LCC_FINDER_WIDTH
  };
  static float input[IN * IN];
  static float a[8 * (IN / 2) * (IN / 2)];
  static float b[16 * (IN / 4) * (IN / 4)];
  static float c[W * (IN / 8) * (IN / 8)];
  static float d[W * (IN / 8) * (IN / 8)];
  static float e[24 * (IN / 8) * (IN / 8)];
  static float f[24 * HEAT * HEAT];
  static float logits[HEAT * HEAT];

  /* Bilinear grayscale resize to the fixed network input. */
  for (int y = 0; y < IN; y++) {
    const double fy = ((double)y + 0.5) * height / IN - 0.5;
    const int y0 = (int)floor(fy < 0 ? 0 : (fy > height - 1 ? height - 1 : fy));
    const int y1 = y0 + 1 < height ? y0 + 1 : y0;
    const double ty = (fy < 0 ? 0 : (fy > height - 1 ? height - 1 : fy)) - y0;
    for (int x = 0; x < IN; x++) {
      const double fx = ((double)x + 0.5) * width / IN - 0.5;
      const int x0 = (int)floor(fx < 0 ? 0 : (fx > width - 1 ? width - 1 : fx));
      const int x1 = x0 + 1 < width ? x0 + 1 : x0;
      const double tx = (fx < 0 ? 0 : (fx > width - 1 ? width - 1 : fx)) - x0;
      const double v =
        (1 - tx) * (1 - ty) * gray[y0 * width + x0] +
        tx * (1 - ty) * gray[y0 * width + x1] +
        (1 - tx) * ty * gray[y1 * width + x0] +
        tx * ty * gray[y1 * width + x1];
      input[y * IN + x] = (float)(v / 255.0);
    }
  }

  conv3x3_stride2_relu(input, 1, IN, IN, LCC_FINDER_C1_W, LCC_FINDER_C1_B, 8, a);
  conv3x3_stride2_relu(a, 8, IN / 2, IN / 2, LCC_FINDER_C2_W, LCC_FINDER_C2_B, 16, b);
  conv3x3_stride2_relu(b, 16, IN / 4, IN / 4, LCC_FINDER_C3_W, LCC_FINDER_C3_B, W, c);
  conv3x3_relu(c, W, IN / 8, IN / 8, LCC_FINDER_C4_W, LCC_FINDER_C4_B, W, d);
  conv3x3_relu(d, W, IN / 8, IN / 8, LCC_FINDER_C5_W, LCC_FINDER_C5_B, 24, e);
  for (int ch = 0; ch < 24; ch++) {
    lcc_bilinear_resample(e + (size_t)ch * (IN / 8) * (IN / 8), IN / 8, IN / 8,
      f + (size_t)ch * HEAT * HEAT, HEAT, HEAT);
  }
  conv1x1(f, 24, HEAT, HEAT, LCC_FINDER_C6_W, LCC_FINDER_C6_B, 1, logits);

  HeatPeak peaks[HEAT * HEAT];
  int npeaks = 0;
  for (int y = 0; y < HEAT; y++) {
    for (int x = 0; x < HEAT; x++) {
      const float v = logits[y * HEAT + x];
      const float s = (float)(1.0 / (1.0 + exp(-v)));
      if (s < 0.25f) continue;
      int local = 1;
      for (int dy = -1; dy <= 1 && local; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          const int yy = y + dy;
          const int xx = x + dx;
          if (yy < 0 || yy >= HEAT || xx < 0 || xx >= HEAT) continue;
          if (logits[yy * HEAT + xx] > v) {
            local = 0;
            break;
          }
        }
      }
      if (!local) continue;
      peaks[npeaks].score = s;
      peaks[npeaks].x = x;
      peaks[npeaks].y = y;
      npeaks++;
    }
  }
  qsort(peaks, (size_t)npeaks, sizeof(HeatPeak), peak_cmp);
  int picked = 0;
  int px[3];
  int py[3];
  for (int i = 0; i < npeaks && picked < 3; i++) {
    int far = 1;
    for (int j = 0; j < picked; j++) {
      const int dx = peaks[i].x - px[j];
      const int dy = peaks[i].y - py[j];
      if (dx * dx + dy * dy < 36) {
        far = 0;
        break;
      }
    }
    if (!far) continue;
    px[picked] = peaks[i].x;
    py[picked] = peaks[i].y;
    out[picked][0] = (peaks[i].x + 0.5) * ST * width / (double)IN;
    out[picked][1] = (peaks[i].y + 0.5) * ST * height / (double)IN;
    picked++;
  }
  return picked == 3;
}

#endif /* LCC_ENABLE_MODELS */
