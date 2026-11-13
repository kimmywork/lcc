#include "lcc_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *g_last = NULL;
static int g_last_len = 0;

uint8_t *lcc_last(void) { return g_last; }
int lcc_last_len(void) { return g_last_len; }

static void set_last(uint8_t *data, int len) {
  free(g_last);
  g_last = data;
  g_last_len = len;
}

static uint32_t rd_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int32_t rd_i32(const uint8_t *p) {
  return (int32_t)rd_u32(p);
}

static double rd_f64(const uint8_t *p) {
  double value;
  memcpy(&value, p, 8);
  return value;
}

static void wr_u32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

static void wr_f64(uint8_t *p, double v) {
  memcpy(p, &v, 8);
}

static void wr_f32(uint8_t *p, float v) {
  memcpy(p, &v, 4);
}

static int publish_decode_status(int status) {
  uint8_t *out = lcc_alloc(120);
  if (!out) {
    set_last(NULL, 0);
    return LCC_ERR;
  }
  memset(out, 0, 120);
  wr_u32(out, (uint32_t)status);
  set_last(out, 120);
  return status;
}

static int publish_stack_status(int status) {
  uint8_t *out = lcc_alloc(48);
  if (!out) {
    set_last(NULL, 0);
    return LCC_ERR;
  }
  memset(out, 0, 48);
  wr_u32(out, (uint32_t)status);
  set_last(out, 48);
  return status;
}

static int reject_debug_residuals(int status) {
  uint8_t *out = lcc_alloc(4);
  if (out) {
    memset(out, 0, 4);
    set_last(out, 4);
  } else {
    set_last(NULL, 0);
  }
  return status;
}

static int publish_debug_residuals(int status) {
  const int count = lcc_debug_count();
  const int record = 16 + 256 * 4;
  uint8_t *out = lcc_alloc((size_t)4 + (size_t)count * (size_t)record);
  if (!out) return LCC_ERR;
  wr_u32(out, (uint32_t)count);
  float res[256];
  for (int i = 0; i < count; i++) {
    int row = 0, col = 0, grid_n = 0, shape = -1;
    lcc_debug_get(i, &row, &col, &grid_n, &shape, res);
    uint8_t *p = out + 4 + (size_t)i * (size_t)record;
    wr_u32(p + 0, (uint32_t)row);
    wr_u32(p + 4, (uint32_t)col);
    wr_u32(p + 8, (uint32_t)grid_n);
    wr_u32(p + 12, (uint32_t)shape);
    for (int k = 0; k < 256; k++) wr_f32(p + 16 + k * 4, res[k]);
  }
  set_last(out, 4 + count * record);
  return status;
}


int lcc_api_debug_residuals(const uint8_t *rgb, size_t rgb_len, int width, int height, int mode) {
  size_t bytes = 0;
  if (!rgb || !lcc_image_geometry(width, height, &bytes) || rgb_len < bytes) {
    return reject_debug_residuals(LCC_BAD_INPUT);
  }
  LccImage image = { width, height, rgb };
  uint8_t *payload = NULL;
  int payload_len = 0;
  LccDecodeMeta meta;
  memset(&meta, 0, sizeof(meta));
  lcc_debug_reset();
  const int status = lcc_decode_image(&image, mode, &payload, &payload_len, &meta);
  lcc_debug_stop();
  lcc_release(payload);
  return publish_debug_residuals(status);
}

int lcc_api_debug_residuals_h(
  const uint8_t *rgb,
  size_t rgb_len,
  int width,
  int height,
  double h0, double h1, double h2,
  double h3, double h4, double h5,
  double h6, double h7, double h8,
  int version,
  int N,
  int module_size
) {
  size_t bytes = 0;
  const double Hv[9] = { h0, h1, h2, h3, h4, h5, h6, h7, h8 };
  if (!rgb || !lcc_image_geometry(width, height, &bytes) || rgb_len < bytes ||
      version < 1 || version > 100 || !lcc_valid_symbol_size(N) || module_size <= 0 || module_size > 64 ||
      !lcc_homography_safe(Hv, N)) {
    return reject_debug_residuals(LCC_BAD_INPUT);
  }
  LccImage image = { width, height, rgb };
  LccFound found;
  memset(&found, 0, sizeof(found));
  found.version = version;
  found.N = N;
  found.s = module_size;
  found.score = 1;
  found.has_h = 1;
  found.axis = 0;
  found.H[0] = h0; found.H[1] = h1; found.H[2] = h2;
  found.H[3] = h3; found.H[4] = h4; found.H[5] = h5;
  found.H[6] = h6; found.H[7] = h7; found.H[8] = h8;
  uint8_t *payload = NULL;
  int payload_len = 0;
  LccDecodeMeta meta;
  memset(&meta, 0, sizeof(meta));
  lcc_debug_reset();
  const int status = lcc_debug_decode_forced(
    &image, &found, "value-otsu", &payload, &payload_len, &meta
  );
  lcc_debug_stop();
  lcc_release(payload);
  return publish_debug_residuals(status);
}


int lcc_api_stack(const uint8_t *input, int input_len) {
  if (!input || input_len < 20) return publish_stack_status(LCC_BAD_INPUT);
  LccImage *frames = NULL;
  LccDet *dets = NULL;
  int status = LCC_BAD_INPUT;
  int offset = 0;
  const int count = rd_i32(input + offset); offset += 4;
  const int quiet = rd_i32(input + offset); offset += 4;
  const int module = rd_i32(input + offset); offset += 4;
  const int max_dimension = rd_i32(input + offset); offset += 4;
  const int noise_stride = rd_i32(input + offset); offset += 4;
  if (count <= 0 || count > 16) return publish_stack_status(LCC_BAD_INPUT);
  if (quiet < 0 || quiet > 64 || module < 0 || module > 64 ||
      max_dimension < 0 || max_dimension > 8192 ||
      noise_stride < 0 || noise_stride > (1 << 20)) {
    return publish_stack_status(LCC_BAD_INPUT);
  }
  frames = lcc_alloc((size_t)count * sizeof(LccImage));
  dets = lcc_alloc((size_t)count * sizeof(LccDet));
  if (!frames || !dets) {
    status = LCC_ERR;
    goto cleanup;
  }
  for (int i = 0; i < count; i++) {
    if ((size_t)offset + 12 > (size_t)input_len) goto cleanup;
    const int width = rd_i32(input + offset); offset += 4;
    const int height = rd_i32(input + offset); offset += 4;
    const int nbytes = rd_i32(input + offset); offset += 4;
    size_t bytes = 0;
    if (!lcc_image_geometry(width, height, &bytes) || nbytes < 0 ||
        (size_t)nbytes != bytes || (size_t)offset + bytes > (size_t)input_len) {
      goto cleanup;
    }
    frames[i].width = width;
    frames[i].height = height;
    frames[i].data = input + offset;
    offset += (int)bytes;

    if ((size_t)offset + 4 + 4 + 4 + 8 + 4 + 9 * 8 + 24 > (size_t)input_len) goto cleanup;
    dets[i].valid = rd_i32(input + offset); offset += 4;
    dets[i].version = rd_i32(input + offset); offset += 4;
    dets[i].N = rd_i32(input + offset); offset += 4;
    dets[i].score = rd_f64(input + offset); offset += 8;
    dets[i].has_h = rd_i32(input + offset); offset += 4;
    for (int h = 0; h < 9; h++) {
      dets[i].H[h] = rd_f64(input + offset);
      offset += 8;
    }
    dets[i].origin_x = rd_f64(input + offset); offset += 8;
    dets[i].origin_y = rd_f64(input + offset); offset += 8;
    dets[i].s = rd_f64(input + offset); offset += 8;
    if (dets[i].valid) {
      if (!lcc_valid_symbol_size(dets[i].N) || dets[i].version < 1 || dets[i].version > 100 ||
          !isfinite(dets[i].score) || !isfinite(dets[i].origin_x) || !isfinite(dets[i].origin_y) ||
          fabs(dets[i].origin_x) > 1e9 || fabs(dets[i].origin_y) > 1e9 ||
          !isfinite(dets[i].s) || dets[i].s < 0 || dets[i].s > 4096) {
        goto cleanup;
      }
      if (dets[i].has_h) {
        if (!lcc_homography_safe(dets[i].H, dets[i].N)) goto cleanup;
      }
    }
  }
  uint8_t *rgb = NULL;
  int w = 0, h = 0, frames_used = 0, stacked = 0, version = 0, N = 0, module_out = 0, quiet_out = 0;
  double noise = 0;
  status = lcc_stack_frames(
    frames, dets, count, quiet, module, max_dimension, noise_stride,
    &rgb, &w, &h, &frames_used, &stacked, &noise, &version, &N, &module_out, &quiet_out, NULL);
  const int header = 48;
  size_t pixels = 0;
  if (status == LCC_OK) {
    if (!lcc_image_geometry(w, h, &pixels)) {
      lcc_release(rgb);
      status = LCC_ERR;
      goto cleanup;
    }
  }
  uint8_t *out = lcc_alloc((size_t)header + pixels);
  if (!out) {
    lcc_release(rgb);
    status = LCC_ERR;
    goto cleanup;
  }
  wr_u32(out + 0, (uint32_t)status);
  wr_u32(out + 4, (uint32_t)w);
  wr_u32(out + 8, (uint32_t)h);
  wr_u32(out + 12, (uint32_t)frames_used);
  wr_u32(out + 16, (uint32_t)count);
  wr_u32(out + 20, (uint32_t)stacked);
  wr_u32(out + 24, (uint32_t)version);
  wr_u32(out + 28, (uint32_t)N);
  wr_u32(out + 32, (uint32_t)module_out);
  wr_u32(out + 36, (uint32_t)quiet_out);
  wr_f64(out + 40, noise);
  if (pixels && rgb) memcpy(out + header, rgb, pixels);
  lcc_release(rgb);
  set_last(out, header + (int)pixels);

cleanup:
  lcc_release(frames);
  lcc_release(dets);
  if (status != LCC_OK) publish_stack_status(status);
  return status;
}

int lcc_api_decode(const uint8_t *rgb, size_t rgb_len, int width, int height, int mode) {
  size_t bytes = 0;
  if (!rgb || !lcc_image_geometry(width, height, &bytes) || rgb_len < bytes) {
    return publish_decode_status(LCC_BAD_INPUT);
  }
  if (mode < 0 || mode > 2) return publish_decode_status(LCC_BAD_INPUT);
  LccImage image = { width, height, rgb };
  uint8_t *payload = NULL;
  int payload_len = 0;
  LccDecodeMeta meta;
  memset(&meta, 0, sizeof(meta));
  const int status = lcc_decode_image(&image, mode, &payload, &payload_len, &meta);
  const int header = 120;
  uint8_t *out = lcc_alloc((size_t)header + (status == LCC_OK ? (size_t)payload_len : 0));
  if (!out) {
    lcc_release(payload);
    return publish_decode_status(LCC_ERR);
  }
  memset(out, 0, header);
  wr_u32(out + 0, (uint32_t)status);
  wr_u32(out + 4, (uint32_t)meta.version);
  wr_u32(out + 8, (uint32_t)meta.N);
  wr_f64(out + 12, meta.module_size);
  wr_f64(out + 20, meta.ecc);
  wr_u32(out + 28, (uint32_t)meta.corrected);
  wr_u32(out + 32, (uint32_t)meta.palette_size);
  wr_f64(out + 36, meta.min_delta_e);
  wr_u32(out + 44, (uint32_t)meta.constraint);
  wr_u32(out + 48, (uint32_t)meta.harmony);
  wr_u32(out + 52, (uint32_t)meta.seed);
  wr_u32(out + 56, (uint32_t)meta.shape_set);
  wr_f64(out + 60, meta.bits_per_module);
  wr_u32(out + 68, (uint32_t)meta.format_blocks);
  wr_u32(out + 72, (uint32_t)meta.data_count);
  wr_u32(out + 76, (uint32_t)meta.rs_symbols);
  wr_u32(out + 80, (uint32_t)meta.rank_count);
  wr_u32(out + 84, (uint32_t)meta.max_rank_diff);
  wr_u32(out + 88, (uint32_t)meta.calibration);
  wr_u32(out + 92, status == LCC_OK ? (uint32_t)payload_len : 0);
  memcpy(out + 96, meta.layer, 8);
  memcpy(out + 104, meta.palette_mode, 16);
  if (status == LCC_OK && payload_len) memcpy(out + header, payload, (size_t)payload_len);
  lcc_release(payload);
  set_last(out, header + (status == LCC_OK ? payload_len : 0));
  return status;
}

int lcc_api_scan(const uint8_t *input, int input_len) {
  if (!input || input_len < 4) return publish_decode_status(LCC_BAD_INPUT);
  int offset = 0;
  const int count = rd_i32(input + offset);
  offset += 4;
  if (count <= 0 || count > 8) return publish_decode_status(LCC_BAD_INPUT);
  LccImage frames[8];
  memset(frames, 0, sizeof(frames));
  for (int i = 0; i < count; i++) {
    if ((size_t)offset + 12 > (size_t)input_len) return publish_decode_status(LCC_BAD_INPUT);
    const int width = rd_i32(input + offset); offset += 4;
    const int height = rd_i32(input + offset); offset += 4;
    const int nbytes = rd_i32(input + offset); offset += 4;
    size_t bytes = 0;
    if (!lcc_image_geometry(width, height, &bytes) || nbytes < 0 || (size_t)nbytes != bytes ||
        (size_t)offset + bytes > (size_t)input_len) {
      return publish_decode_status(LCC_BAD_INPUT);
    }
    frames[i].width = width;
    frames[i].height = height;
    frames[i].data = input + offset;
    offset += (int)bytes;
  }
  uint8_t *payload = NULL;
  int payload_len = 0;
  LccDecodeMeta meta;
  memset(&meta, 0, sizeof(meta));
  const int status = lcc_scan_frames(frames, count, &payload, &payload_len, &meta);
  const int header = 120;
  uint8_t *out = lcc_alloc((size_t)header + (status == LCC_OK ? (size_t)payload_len : 0));
  if (!out) {
    lcc_release(payload);
    return publish_decode_status(LCC_ERR);
  }
  memset(out, 0, header);
  wr_u32(out + 0, (uint32_t)status);
  wr_u32(out + 4, (uint32_t)meta.version);
  wr_u32(out + 8, (uint32_t)meta.N);
  wr_f64(out + 12, meta.module_size);
  wr_f64(out + 20, meta.ecc);
  wr_u32(out + 28, (uint32_t)meta.corrected);
  wr_u32(out + 32, (uint32_t)meta.palette_size);
  wr_f64(out + 36, meta.min_delta_e);
  wr_u32(out + 44, (uint32_t)meta.constraint);
  wr_u32(out + 48, (uint32_t)meta.harmony);
  wr_u32(out + 52, (uint32_t)meta.seed);
  wr_u32(out + 56, (uint32_t)meta.shape_set);
  wr_f64(out + 60, meta.bits_per_module);
  wr_u32(out + 68, (uint32_t)meta.format_blocks);
  wr_u32(out + 72, (uint32_t)meta.data_count);
  wr_u32(out + 76, (uint32_t)meta.rs_symbols);
  wr_u32(out + 80, (uint32_t)meta.rank_count);
  wr_u32(out + 84, (uint32_t)meta.max_rank_diff);
  wr_u32(out + 88, (uint32_t)meta.calibration);
  wr_u32(out + 92, status == LCC_OK ? (uint32_t)payload_len : 0);
  memcpy(out + 96, meta.layer, 8);
  memcpy(out + 104, meta.palette_mode, 16);
  if (status == LCC_OK && payload_len) memcpy(out + header, payload, (size_t)payload_len);
  lcc_release(payload);
  set_last(out, header + (status == LCC_OK ? payload_len : 0));
  return status;
}
