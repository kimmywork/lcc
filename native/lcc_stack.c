#include "lcc.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

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
  const size_t pixel_count = byte_count / 3;
  float *sum = lcc_alloc(pixel_count * 3 * sizeof(float));
  uint16_t *counts = lcc_alloc(pixel_count * sizeof(uint16_t));
  uint8_t *data = lcc_alloc(byte_count);
  if (!sum || !counts || !data) {
    lcc_release(sum);
    lcc_release(counts);
    lcc_release(data);
    lcc_release(best);
    return LCC_ERR;
  }
  memset(data, 255, byte_count);

  typedef struct { float *v; int n; int cap; } Noise;
  Noise *noises = NULL;
  int noise_slots = 0;

  for (int fi = 0; fi < best_n; fi++) {
    const LccImage *frame = &frames[best[fi]];
    const LccDet *det = &dets[best[fi]];
    for (int y = 0; y < height; y++) {
      const double my = ((double)y + 0.5) / module - quiet_zone;
      if (my < 0 || my >= ref->N) continue;
      int x0 = 0;
      while (x0 < width && ((double)x0 + 0.5) / module - quiet_zone < 0) x0++;
      int x1 = width;
      while (x1 > x0 && ((double)(x1 - 1) + 0.5) / module - quiet_zone >= ref->N) x1--;
      if (x0 >= x1) continue;
      const double dmx = 1.0 / module;
      double mx = ((double)x0 + 0.5) / module - quiet_zone;
      double numx = 0, numy = 0, den = 1, dnumx = 0, dnumy = 0, dden = 0, sx0 = 0, sy0 = 0, dsx = 0;
      if (det->has_h) {
        numx = det->H[0] * mx + det->H[1] * my + det->H[2];
        numy = det->H[3] * mx + det->H[4] * my + det->H[5];
        den = det->H[6] * mx + det->H[7] * my + det->H[8];
        dnumx = det->H[0] * dmx;
        dnumy = det->H[3] * dmx;
        dden = det->H[6] * dmx;
      } else {
        sx0 = det->origin_x + mx * det->s;
        sy0 = det->origin_y + my * det->s;
        dsx = det->s * dmx;
      }
      for (int x = x0; x < x1; x++) {
        double sx, sy;
        if (det->has_h) {
          if (fabs(den) < 1e-12) {
            numx += dnumx;
            numy += dnumy;
            den += dden;
            continue;
          }
          sx = numx / den;
          sy = numy / den;
          numx += dnumx;
          numy += dnumy;
          den += dden;
        } else {
          sx = sx0;
          sy = sy0;
          sx0 += dsx;
        }
        if (!isfinite(sx) || !isfinite(sy)) continue;
        int rgb[3];
        lcc_sample_bilinear(frame, sx, sy, rgb);
        const size_t p = (size_t)y * (size_t)width + (size_t)x;
        const size_t q = p * 3;
        sum[q] += (float)rgb[0];
        sum[q + 1] += (float)rgb[1];
        sum[q + 2] += (float)rgb[2];
        counts[p]++;
        if ((int)(p % (size_t)noise_stride) == 0) {
          int slot = -1;
          for (int s = 0; s < noise_slots; s++) {
            if (noises[s].cap == (int)p) {
              slot = s;
              break;
            }
          }
          if (slot < 0) {
            Noise *next = realloc(noises, (size_t)(noise_slots + 1) * sizeof(Noise));
            if (!next) continue;
            noises = next;
            slot = noise_slots++;
            noises[slot].v = NULL;
            noises[slot].n = 0;
            noises[slot].cap = (int)p;
          }
          float *grown = realloc(noises[slot].v, (size_t)(noises[slot].n + 1) * sizeof(float));
          if (!grown) continue;
          noises[slot].v = grown;
          noises[slot].v[noises[slot].n++] = (float)(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
        }
      }
    }
  }

  for (size_t p = 0; p < pixel_count; p++) {
    const int n = counts[p];
    if (n == 0) continue;
    const size_t q = p * 3;
    data[q] = (uint8_t)lcc_js_round(sum[q] / n);
    data[q + 1] = (uint8_t)lcc_js_round(sum[q + 1] / n);
    data[q + 2] = (uint8_t)lcc_js_round(sum[q + 2] / n);
  }

  double noise_sum = 0;
  int noise_count = 0;
  for (int s = 0; s < noise_slots; s++) {
    if (noises[s].n < 2) {
      free(noises[s].v);
      continue;
    }
    double mean = 0;
    for (int i = 0; i < noises[s].n; i++) mean += noises[s].v[i];
    mean /= noises[s].n;
    double var = 0;
    for (int i = 0; i < noises[s].n; i++) {
      const double d = noises[s].v[i] - mean;
      var += d * d;
    }
    var /= noises[s].n;
    noise_sum += sqrt(var);
    noise_count++;
    free(noises[s].v);
  }
  free(noises);

  *out_rgb = data;
  *out_w = width;
  *out_h = height;
  *out_stacked = 1;
  *out_module = module;
  *out_noise = noise_count ? noise_sum / noise_count : 0;
  if (out_source) *out_source = best[0];
  lcc_release(sum);
  lcc_release(counts);
  lcc_release(best);
  return LCC_OK;
}
