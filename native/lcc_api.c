#include "lcc.h"

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

int lcc_api_stack(const uint8_t *input, int input_len) {
  if (!input || input_len < 20) return LCC_BAD_INPUT;
  int offset = 0;
  if (offset + 20 > input_len) return LCC_BAD_INPUT;
  const int count = rd_i32(input + offset); offset += 4;
  const int quiet = rd_i32(input + offset); offset += 4;
  const int module = rd_i32(input + offset); offset += 4;
  const int max_dimension = rd_i32(input + offset); offset += 4;
  const int noise_stride = rd_i32(input + offset); offset += 4;
  if (count <= 0 || count > 16) return LCC_BAD_INPUT;
  LccImage *frames = lcc_alloc((size_t)count * sizeof(LccImage));
  LccDet *dets = lcc_alloc((size_t)count * sizeof(LccDet));
  if (!frames || !dets) return LCC_ERR;
  for (int i = 0; i < count; i++) {
    if (offset + 12 > input_len) return LCC_BAD_INPUT;
    const int width = rd_i32(input + offset); offset += 4;
    const int height = rd_i32(input + offset); offset += 4;
    const int nbytes = rd_i32(input + offset); offset += 4;
    if (width <= 0 || height <= 0 || nbytes != width * height * 3 || offset + nbytes > input_len) return LCC_BAD_INPUT;
    frames[i].width = width;
    frames[i].height = height;
    frames[i].data = input + offset;
    offset += nbytes;
    if (offset + 4 + 4 + 4 + 8 + 4 + 9 * 8 + 24 > input_len) return LCC_BAD_INPUT;
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
  }
  uint8_t *rgb = NULL;
  int w = 0, h = 0, frames_used = 0, stacked = 0, version = 0, N = 0, module_out = 0, quiet_out = 0;
  double noise = 0;
  const int status = lcc_stack_frames(
    frames, dets, count, quiet, module, max_dimension, noise_stride,
    &rgb, &w, &h, &frames_used, &stacked, &noise, &version, &N, &module_out, &quiet_out);
  lcc_release(frames);
  lcc_release(dets);
  const int header = 48;
  const int pixels = status == LCC_OK ? w * h * 3 : 0;
  uint8_t *out = lcc_alloc((size_t)header + (size_t)pixels);
  if (!out) {
    lcc_release(rgb);
    return LCC_ERR;
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
  if (pixels && rgb) memcpy(out + header, rgb, (size_t)pixels);
  lcc_release(rgb);
  set_last(out, header + pixels);
  return status;
}

int lcc_api_decode(const uint8_t *rgb, int width, int height, int mode) {
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
    return LCC_ERR;
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
  if (!input || input_len < 4) return LCC_BAD_INPUT;
  int offset = 0;
  const int count = rd_i32(input + offset);
  offset += 4;
  if (count <= 0 || count > 8) return LCC_BAD_INPUT;
  LccImage frames[8];
  memset(frames, 0, sizeof(frames));
  for (int i = 0; i < count; i++) {
    if (offset + 12 > input_len) return LCC_BAD_INPUT;
    const int width = rd_i32(input + offset); offset += 4;
    const int height = rd_i32(input + offset); offset += 4;
    const int nbytes = rd_i32(input + offset); offset += 4;
    if (width <= 0 || height <= 0 || nbytes != width * height * 3 || offset + nbytes > input_len) {
      return LCC_BAD_INPUT;
    }
    frames[i].width = width;
    frames[i].height = height;
    frames[i].data = input + offset;
    offset += nbytes;
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
    return LCC_ERR;
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
