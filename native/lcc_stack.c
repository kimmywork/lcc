#include "lcc.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/* Sub-cell grid per module used by the multi-frame fusion. */
#define LCC_STACK_SUB 16

static int copy_frame(const LccImage *frame, uint8_t **out_rgb, int *out_w, int *out_h) {
  const size_t n = (size_t)frame->width * (size_t)frame->height * 3;
  uint8_t *data = lcc_alloc(n);
  if (!data) return 0;
  memcpy(data, frame->data, n);
  *out_rgb = data;
  *out_w = frame->width;
  *out_h = frame->height;
  return 1;
}

/* Per-channel median across at most 16 frames.  Even counts average the two
   middle samples so 2-frame bursts still work; the rounding matches the JS
   stacker. */
static int median_of(const int *values, int n) {
  int tmp[16];
  if (n <= 0) return 255;
  for (int i = 0; i < n; i++) tmp[i] = values[i];
  for (int i = 1; i < n; i++) {
    const int v = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > v) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = v;
  }
  if (n & 1) return tmp[n / 2];
  return (int)lcc_js_round((tmp[n / 2 - 1] + tmp[n / 2]) * 0.5);
}

int lcc_stack_frames(
  const LccImage *frames,
  const LccDet *dets,
  int count,
  int quiet_zone,
  int module_size,
  int max_dimension,
  int noise_stride,
  uint8_t **out_rgb,
  int *out_w,
  int *out_h,
  int *out_frames,
  int *out_stacked,
  double *out_noise,
  int *out_version,
  int *out_N,
  int *out_module,
  int *out_quiet,
  int *out_source
) {
  if (count <= 0 || count > 16) return LCC_BAD_INPUT;
  if (quiet_zone < 0 || quiet_zone > 64) return LCC_BAD_INPUT;
  if (module_size < 0 || module_size > 64) return LCC_BAD_INPUT;
  if (max_dimension <= 0) max_dimension = 1400;
  if (max_dimension > 8192) return LCC_BAD_INPUT;
  if (noise_stride <= 0) noise_stride = 257;
  if (noise_stride > (1 << 20)) return LCC_BAD_INPUT;

  int *valid = lcc_alloc((size_t)count * sizeof(int));
  if (!valid) return LCC_ERR;
  int nvalid = 0;
  for (int i = 0; i < count; i++) {
    size_t frame_bytes = 0;
    if (!frames[i].data || !lcc_image_geometry(frames[i].width, frames[i].height, &frame_bytes)) {
      lcc_release(valid);
      return LCC_BAD_INPUT;
    }
    if (!dets[i].valid) continue;
    if (!lcc_valid_symbol_size(dets[i].N) || dets[i].version < 1 || dets[i].version > 100 ||
        !isfinite(dets[i].s) || dets[i].s < 0 || dets[i].s > 4096) {
      lcc_release(valid);
      return LCC_BAD_INPUT;
    }
    valid[nvalid++] = i;
  }
  if (nvalid == 0) {
    lcc_release(valid);
    return LCC_ERR;
  }

  int *best = lcc_alloc((size_t)nvalid * sizeof(int));
  if (!best) {
    lcc_release(valid);
    return LCC_ERR;
  }
  int best_n = 0;
  double best_score = -INFINITY;
  for (int i = 0; i < nvalid; i++) {
    const LccDet *seed = &dets[valid[i]];
    int *group = lcc_alloc((size_t)nvalid * sizeof(int));
    if (!group) {
      lcc_release(valid);
      lcc_release(best);
      return LCC_ERR;
    }
    int gn = 0;
    double score = 0;
    for (int j = 0; j < nvalid; j++) {
      const LccDet *d = &dets[valid[j]];
      if (d->version == seed->version && d->N == seed->N) {
        group[gn++] = valid[j];
        score += d->score;
      }
    }
    score /= gn;
    if (gn > best_n || (gn == best_n && score > best_score)) {
      best_n = gn;
      best_score = score;
      memcpy(best, group, (size_t)gn * sizeof(int));
    }
    lcc_release(group);
  }
  lcc_release(valid);

  const LccDet *ref = &dets[best[0]];
  const int total = ref->N + 2 * quiet_zone;
  if (total <= 0 || total > 4096) {
    lcc_release(best);
    return LCC_BAD_INPUT;
  }
  int module = module_size;
  if (module <= 0) {
    const double s = ref->s > 0 ? ref->s : 16;
    module = (int)lcc_js_round(s);
    if (module < 16) module = 16;
    if (module > 24) module = 24;
  }
  const int fit = total > 0 ? max_dimension / total : module;
  if (module > fit) module = fit;
  if (module < 12) module = 12;

  *out_version = ref->version;
  *out_N = ref->N;
  *out_quiet = quiet_zone;
  *out_frames = best_n;
  *out_noise = 0;

  if (best_n == 1) {
    const int ok = copy_frame(&frames[best[0]], out_rgb, out_w, out_h);
    *out_stacked = 0;
    *out_module = (int)lcc_js_round(ref->s > 0 ? ref->s : module);
    if (out_source) *out_source = best[0];
    lcc_release(best);
    return ok ? LCC_OK : LCC_ERR;
  }

  const int64_t width64 = (int64_t)total * module;
  if (width64 <= 0 || width64 > 32768) {
    lcc_release(best);
    return LCC_BAD_INPUT;
  }
  const int width = (int)width64;
  const int height = width;
  size_t byte_count = 0;
  if (!lcc_image_geometry(width, height, &byte_count)) {
    lcc_release(best);
    return LCC_BAD_INPUT;
  }
  uint8_t *data = lcc_alloc(byte_count);
  if (!data) {
    lcc_release(best);
    return LCC_ERR;
  }
  memset(data, 255, byte_count);

  /* Fusion happens on a 16x16 sub-cell grid inside every module, not on
     individual canonical pixels.  Each frame contributes one bilinear sample
     per sub-cell; the per-channel median across frames rejects a frame that
     mis-sampled, blurred, or mis-classified that cell, and the fused value is
     written as a solid block.  Sixteen cells per module keep the shape
     quadrants intact (shape templates are classified on a 16x16 grid). */
  int vals[3][16];
  double noise_sum = 0;
  int noise_count = 0;
  const int sub = LCC_STACK_SUB;

  for (int row = 0; row < ref->N; row++) {
    for (int col = 0; col < ref->N; col++) {
      int cell[LCC_STACK_SUB][LCC_STACK_SUB][3];
      for (int sy = 0; sy < sub; sy++) {
        for (int sx = 0; sx < sub; sx++) {
          const double mx = (double)col + ((double)sx + 0.5) / (double)sub;
          const double my = (double)row + ((double)sy + 0.5) / (double)sub;
          for (int fi = 0; fi < best_n; fi++) {
            const LccImage *frame = &frames[best[fi]];
            const LccDet *det = &dets[best[fi]];
            double px, py;
            if (det->has_h) {
              const double den = det->H[6] * mx + det->H[7] * my + det->H[8];
              if (fabs(den) < 1e-12) {
                vals[0][fi] = 255;
                vals[1][fi] = 255;
                vals[2][fi] = 255;
                continue;
              }
              px = (det->H[0] * mx + det->H[1] * my + det->H[2]) / den;
              py = (det->H[3] * mx + det->H[4] * my + det->H[5]) / den;
            } else {
              px = det->origin_x + mx * det->s;
              py = det->origin_y + my * det->s;
            }
            int rgb[3] = { 255, 255, 255 };
            if (isfinite(px) && isfinite(py)) lcc_sample_bilinear(frame, px, py, rgb);
            vals[0][fi] = rgb[0];
            vals[1][fi] = rgb[1];
            vals[2][fi] = rgb[2];
          }
          for (int ch = 0; ch < 3; ch++) cell[sy][sx][ch] = median_of(vals[ch], best_n);
          if (best_n >= 2 && sy == 0 && sx == 0) {
            double mean = 0;
            for (int fi = 0; fi < best_n; fi++) {
              mean += 0.2126 * vals[0][fi] + 0.7152 * vals[1][fi] + 0.0722 * vals[2][fi];
            }
            mean /= best_n;
            double var = 0;
            for (int fi = 0; fi < best_n; fi++) {
              const double lum = 0.2126 * vals[0][fi] + 0.7152 * vals[1][fi] + 0.0722 * vals[2][fi];
              var += (lum - mean) * (lum - mean);
            }
            noise_sum += sqrt(var / best_n);
            noise_count++;
          }
        }
      }
      const double block_x0 = ((double)col + quiet_zone) * module;
      const double block_y0 = ((double)row + quiet_zone) * module;
      int x0 = (int)ceil(block_x0 - 0.5);
      int x1 = (int)ceil(block_x0 + module - 0.5);
      int y0 = (int)ceil(block_y0 - 0.5);
      int y1 = (int)ceil(block_y0 + module - 0.5);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > width) x1 = width;
      if (y1 > height) y1 = height;
      for (int y = y0; y < y1; y++) {
        double v = ((double)y + 0.5) / module - quiet_zone - row;
        int sy = (int)floor(v * sub);
        if (sy < 0) sy = 0;
        if (sy >= sub) sy = sub - 1;
        for (int x = x0; x < x1; x++) {
          double u = ((double)x + 0.5) / module - quiet_zone - col;
          int sx = (int)floor(u * sub);
          if (sx < 0) sx = 0;
          if (sx >= sub) sx = sub - 1;
          const size_t q = ((size_t)y * (size_t)width + (size_t)x) * 3;
          data[q] = (uint8_t)cell[sy][sx][0];
          data[q + 1] = (uint8_t)cell[sy][sx][1];
          data[q + 2] = (uint8_t)cell[sy][sx][2];
        }
      }
    }
  }

  *out_rgb = data;
  *out_w = width;
  *out_h = height;
  *out_stacked = 1;
  *out_module = module;
  *out_noise = noise_count ? noise_sum / noise_count : 0;
  if (out_source) *out_source = best[0];
  lcc_release(best);
  return LCC_OK;
}
