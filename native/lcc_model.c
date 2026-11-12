#include "lcc_internal.h"

#include <math.h>
#include <string.h>

#include "model_weights.h"

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

/*
 * Shape classifier over the decoder's 16x16 residual grid.
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
