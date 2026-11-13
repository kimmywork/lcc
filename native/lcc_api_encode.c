#include "lcc_encode_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ENC_HEADER 320

static uint8_t *g_last = NULL;
static int g_last_len = 0;

uint8_t *lcc_last(void) { return g_last; }
int lcc_last_len(void) { return g_last_len; }

static void set_last(uint8_t *data, int len) {
  free(g_last);
  g_last = data;
  g_last_len = len;
}

static int32_t rd_i32(const uint8_t *p) {
  return (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24));
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

static int publish_error(int status, const char *message) {
  uint8_t *out = lcc_alloc(ENC_HEADER);
  if (!out) {
    set_last(NULL, 0);
    return status;
  }
  memset(out, 0, ENC_HEADER);
  wr_u32(out + 0, (uint32_t)status);
  if (message) {
    size_t n = strlen(message);
    if (n > 95) n = 95;
    memcpy(out + 8, message, n);
  }
  set_last(out, ENC_HEADER);
  return status;
}

static int publish_result(const LccEncodeResult *r, int layout_only) {
  const int N = r->N;
  const int palette_size = r->palette_size;
  const int cells = N * N;
  const int image_bytes = layout_only ? 0 : r->width * r->height * 3;
  int offset = ENC_HEADER;
  const int symbols_offset = layout_only ? 0 : offset;
  if (!layout_only) offset += cells * 2;
  const int image_offset = layout_only ? 0 : offset;
  offset += image_bytes;
  const int palette_offset = offset;
  offset += palette_size * 3;
  const int palette_lab_offset = offset;
  offset += palette_size * 3 * (int)sizeof(double);
  const int rank_of_offset = offset;
  offset += palette_size * (int)sizeof(int16_t);
  const int rank_counts_offset = offset;
  offset += r->rank_count * (int)sizeof(int32_t);
  const int fixed_color_offset = offset;
  offset += cells * 3;
  const int has_fixed_color_offset = offset;
  offset += cells;
  const int fixed_shape_offset = offset;
  offset += cells;
  const int has_fixed_shape_offset = offset;
  offset += cells;
  const int data_coords_offset = offset;
  offset += r->data_count * 2 * (int)sizeof(int32_t);
  const int gray_rgb_offset = offset;
  offset += 16 * 3;
  const int gray_lab_offset = offset;
  offset += 16 * 3 * (int)sizeof(double);
  const int total = offset;

  uint8_t *out = lcc_alloc((size_t)total);
  if (!out) {
    set_last(NULL, 0);
    return LCC_ERR;
  }
  memset(out, 0, (size_t)total);
  wr_u32(out + 0, LCC_OK);
  wr_u32(out + 104, (uint32_t)r->width);
  wr_u32(out + 108, (uint32_t)r->height);
  wr_u32(out + 112, (uint32_t)r->N);
  wr_u32(out + 116, (uint32_t)r->version);
  wr_u32(out + 120, (uint32_t)r->module_size);
  wr_u32(out + 124, (uint32_t)r->quiet_zone);
  wr_u32(out + 128, (uint32_t)r->payload_capacity);
  wr_u32(out + 132, (uint32_t)r->data_count);
  wr_u32(out + 136, (uint32_t)r->function_count);
  wr_u32(out + 140, (uint32_t)r->capacity_bits);
  wr_u32(out + 144, (uint32_t)r->payload_size);
  wr_u32(out + 148, (uint32_t)r->format_blocks);
  wr_u32(out + 152, (uint32_t)r->seed);
  wr_u32(out + 156, (uint32_t)r->constraint);
  wr_u32(out + 160, (uint32_t)r->harmony);
  wr_u32(out + 164, (uint32_t)r->palette_mode);
  wr_u32(out + 168, (uint32_t)r->palette_size);
  wr_u32(out + 172, (uint32_t)r->ecc_index);
  wr_u32(out + 176, (uint32_t)r->shape_set);
  wr_u32(out + 180, (uint32_t)r->shape_layer_id);
  wr_u32(out + 184, (uint32_t)r->shape_ext);
  wr_u32(out + 188, (uint32_t)r->shape_variant);
  wr_u32(out + 192, (uint32_t)r->layer_id);
  wr_u32(out + 196, (uint32_t)r->flags);
  wr_f64(out + 200, r->bits_per_module);
  wr_f64(out + 208, r->ecc);
  wr_f64(out + 216, r->min_delta_e);
  wr_u32(out + 224, (uint32_t)r->rank_count);
  wr_u32(out + 228, (uint32_t)r->max_rank_diff);
  wr_u32(out + 232, (uint32_t)r->black_index);
  wr_u32(out + 236, (uint32_t)r->white_index);
  wr_u32(out + 240, (uint32_t)image_bytes);
  wr_u32(out + 244, (uint32_t)r->rs_symbols);
  wr_u32(out + 248, (uint32_t)symbols_offset);
  wr_u32(out + 252, (uint32_t)image_offset);
  wr_u32(out + 256, (uint32_t)palette_offset);
  wr_u32(out + 260, (uint32_t)palette_lab_offset);
  wr_u32(out + 264, (uint32_t)rank_of_offset);
  wr_u32(out + 268, (uint32_t)rank_counts_offset);
  wr_u32(out + 272, (uint32_t)fixed_color_offset);
  wr_u32(out + 276, (uint32_t)has_fixed_color_offset);
  wr_u32(out + 280, (uint32_t)fixed_shape_offset);
  wr_u32(out + 284, (uint32_t)has_fixed_shape_offset);
  wr_u32(out + 288, (uint32_t)data_coords_offset);
  wr_u32(out + 292, (uint32_t)gray_rgb_offset);
  wr_u32(out + 296, (uint32_t)gray_lab_offset);
  wr_u32(out + 300, (uint32_t)total);
  wr_u32(out + 304, (uint32_t)r->initial_rank);
  wr_u32(out + 308, (uint32_t)r->layout.rows_per_copy);
  wr_u32(out + 312, (uint32_t)r->layout.copy_count);
  wr_u32(out + 316, (uint32_t)r->k_total);
  wr_u32(out + 116, (uint32_t)r->version);

  if (!layout_only && r->symbols) {
    memcpy(out + symbols_offset, r->symbols, (size_t)cells * sizeof(int16_t));
  }
  if (!layout_only && r->image) {
    memcpy(out + image_offset, r->image, (size_t)image_bytes);
  }
  const LccPaletteInfo *p = r->palette;
  if (p) {
    memcpy(out + palette_offset, p->rgb, (size_t)palette_size * 3);
    memcpy(out + palette_lab_offset, p->lab, (size_t)palette_size * 3 * sizeof(double));
    memcpy(out + rank_of_offset, p->rank_of, (size_t)palette_size * sizeof(int16_t));
    for (int i = 0; i < r->rank_count; i++) {
      int count = 0;
      for (int s = 0; s < palette_size; s++) if (p->rank_of[s] == i) count++;
      wr_u32(out + rank_counts_offset + i * 4, (uint32_t)count);
    }
    memcpy(out + gray_rgb_offset, p->gray_rgb, 16 * 3);
    memcpy(out + gray_lab_offset, p->gray_lab, 16 * 3 * sizeof(double));
  }
  if (r->layout.fixed_color) memcpy(out + fixed_color_offset, r->layout.fixed_color, (size_t)cells * 3);
  if (r->layout.has_fixed_color) memcpy(out + has_fixed_color_offset, r->layout.has_fixed_color, (size_t)cells);
  if (r->layout.fixed_shape) memcpy(out + fixed_shape_offset, r->layout.fixed_shape, (size_t)cells);
  if (r->layout.has_fixed_shape) memcpy(out + has_fixed_shape_offset, r->layout.has_fixed_shape, (size_t)cells);
  if (r->layout.data_rc) {
    for (int i = 0; i < r->data_count; i++) {
      wr_u32(out + data_coords_offset + i * 8, (uint32_t)r->layout.data_rc[i * 2]);
      wr_u32(out + data_coords_offset + i * 8 + 4, (uint32_t)r->layout.data_rc[i * 2 + 1]);
    }
  }
  set_last(out, total);
  return LCC_OK;
}

static int parse_header(const uint8_t *input, int input_len, LccEncodeOptions *options, const uint8_t **payload, int *payload_len, char *layer_name) {
  if (!input || input_len < 96) return 0;
  const int plen = rd_i32(input + 0);
  if (plen < 0 || 96 + plen > input_len) return 0;
  memcpy(layer_name, input + 80, 16);
  layer_name[15] = '\0';
  memset(options, 0, sizeof(*options));
  options->layer = layer_name;
  options->width = rd_i32(input + 4);
  options->height = rd_i32(input + 8);
  options->mode = rd_i32(input + 12);
  options->palette_mode = rd_i32(input + 16);
  options->harmony = rd_i32(input + 20);
  options->constraint = rd_i32(input + 24);
  options->seed = rd_i32(input + 28);
  options->ecc_index = rd_i32(input + 32);
  options->boost_ecc = rd_i32(input + 36);
  options->min_module = rd_i32(input + 40);
  options->max_module = rd_i32(input + 44);
  options->quiet_zone = rd_i32(input + 48);
  options->min_version = rd_i32(input + 52);
  options->max_version = rd_i32(input + 56);
  options->module_size = rd_i32(input + 60);
  options->version = rd_i32(input + 64);
  options->compressed = rd_i32(input + 68);
  options->encrypted = rd_i32(input + 72);
  *payload = input + 96;
  *payload_len = plen;
  return 1;
}

int lcc_api_encode(const uint8_t *input, int input_len) {
  LccEncodeOptions options;
  const uint8_t *payload = NULL;
  int payload_len = 0;
  char layer_name[16];
  if (!parse_header(input, input_len, &options, &payload, &payload_len, layer_name)) {
    return publish_error(LCC_BAD_INPUT, "LCC: malformed encode request");
  }
  LccEncodeResult result;
  char error[128];
  error[0] = '\0';
  const int status = lcc_encode_payload(payload, payload_len, &options, &result, error, (int)sizeof(error));
  if (status != LCC_OK) {
    lcc_encode_result_free(&result);
    return publish_error(status, error[0] ? error : "LCC: encode failed");
  }
  const int publish = publish_result(&result, 0);
  lcc_encode_result_free(&result);
  return publish;
}

int lcc_api_encode_layout(const uint8_t *input, int input_len) {
  LccEncodeOptions options;
  const uint8_t *payload = NULL;
  int payload_len = 0;
  char layer_name[16];
  if (!parse_header(input, input_len, &options, &payload, &payload_len, layer_name)) {
    return publish_error(LCC_BAD_INPUT, "LCC: malformed layout request");
  }
  (void)payload;
  (void)payload_len;
  const LccEncodeLayer *layer = lcc_encode_layer(options.layer);
  if (!layer) return publish_error(LCC_BAD_INPUT, "LCC: unknown layer");
  if (options.version < 1 || options.version > 100) {
    return publish_error(LCC_BAD_INPUT, "LCC: version must be between 1 and 100");
  }
  const int is_shape = layer->shape_set != 0;
  const int harmony = is_shape ? 0 : (options.harmony ? 1 : 0);
  const LccPaletteInfo *palette = lcc_palette(layer->name, harmony);
  if (!palette) return publish_error(LCC_BAD_INPUT, "LCC: unknown layer");
  const int constraint = options.constraint < 0
    ? (strcmp(layer->name, "G10") == 0 || is_shape ? 0 : layer->default_constraint)
    : (options.constraint ? 1 : 0);

  LccEncodeResult result;
  memset(&result, 0, sizeof(result));
  if (!lcc_encode_layout_build(palette, options.version, &result.layout)) {
    return publish_error(LCC_ERR, "LCC: layout build failed");
  }
  result.version = options.version;
  result.N = result.layout.N;
  result.palette = palette;
  result.palette_size = palette->palette_size;
  result.black_index = palette->black_index;
  result.white_index = palette->white_index;
  result.rank_count = palette->rank_count;
  result.max_rank_diff = palette->max_rank_diff;
  result.initial_rank = palette->initial_rank;
  result.min_delta_e = palette->min_delta_e;
  result.harmony = harmony;
  result.palette_mode = is_shape ? 0 : (options.palette_mode ? 1 : 0);
  result.shape_set = is_shape ? layer->shape_set : 0;
  result.shape_layer_id = is_shape ? layer->shape_layer_id : -1;
  result.shape_ext = is_shape ? layer->shape_ext : 0;
  result.shape_variant = is_shape ? layer->shape_variant : 0;
  result.layer_id = layer->id;
  result.constraint = constraint;
  result.data_count = result.layout.data_count;
  result.function_count = result.layout.function_count;
  result.format_blocks = result.layout.blocks;
  result.bits_per_module = (double)layer->bits;

  int cb = 0, pc = 0, rs = 0, kt = 0;
  const int ecc_index = options.ecc_index >= 0 ? options.ecc_index : -1;
  if (lcc_capacity_info(layer->name, options.version, constraint, ecc_index, &cb, &pc, &rs, &kt, &result.ecc_index)) {
    result.capacity_bits = cb;
    result.payload_capacity = pc;
    result.rs_symbols = rs;
    result.k_total = kt;
    const double levels[4] = { 0.20, 0.30, 0.35, 0.40 };
    result.ecc = levels[result.ecc_index];
    if (strcmp(layer->name, "G10") == 0) result.bits_per_module = 1.0;
    else if (constraint) result.bits_per_module = result.data_count > 0 ? (double)cb / (double)result.data_count : 0;
    else result.bits_per_module = (double)layer->bits;
  }
  const int publish = publish_result(&result, 1);
  lcc_encode_result_free(&result);
  return publish;
}
