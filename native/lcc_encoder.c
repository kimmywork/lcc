#include "lcc_encode_internal.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define FRAME_HEADER_SIZE 13
#define FRAME_MAGIC 0x4c43
#define FRAME_VERSION 1
#define FLAG_CONSTRAINT 1
#define FLAG_COMPRESSED 2
#define FLAG_ENCRYPTED 4

static double js_round(double x) {
  return floor(x + 0.5);
}

static void set_error(char *error, int error_len, const char *fmt, ...) {
  if (!error || error_len <= 0) return;
  va_list args;
  va_start(args, fmt);
  vsnprintf(error, (size_t)error_len, fmt, args);
  va_end(args);
}

static int clampi(int v, int lo, int hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static int version_to_size(int version) {
  return 21 + 4 * (version - 1);
}

static void rs_blocks(int total, double redundancy, int *block_count, int *k_total) {
  const int blocks = total > 255 ? (total + 254) / 255 : 1;
  const int base = total / blocks;
  const int rem = total % blocks;
  int kt = 0;
  for (int i = 0; i < blocks; i++) {
    const int n = base + (i < rem ? 1 : 0);
    int parity = (int)js_round(n * redundancy);
    if (parity < 1) parity = 1;
    if (parity > n - 1) parity = n - 1;
    kt += n - parity;
  }
  *block_count = blocks;
  *k_total = kt;
}

static int capacity_for_layer(
  const LccEncodeLayer *layer,
  const LccPaletteInfo *palette,
  int version,
  int constraint,
  double ecc,
  int *capacity_bits,
  int *payload_capacity,
  int *rs_symbols,
  int *k_total
) {
  LccLayout probe;
  memset(&probe, 0, sizeof(probe));
  if (!lcc_make_layout(palette, version, &probe)) return 0;
  const int D = probe.data_count;
  lcc_layout_free(&probe);

  int bits = 0;
  LccRankConstraint *rc = NULL;
  if (strcmp(layer->name, "G10") == 0) {
    bits = D;
  } else if (constraint) {
    rc = lcc_rank_constraint_build(palette);
    if (!rc) return 0;
    bits = lcc_rank_constraint_capacity_bits(rc, D);
    lcc_rank_constraint_free(rc);
  } else {
    bits = D * layer->bits;
  }
  const int S = bits / 8;
  *capacity_bits = bits;
  *rs_symbols = S > 0 ? S : 0;
  if (S <= 0) {
    *payload_capacity = -1;
    *k_total = 0;
    return 1;
  }
  int kt = 0, bc = 0;
  rs_blocks(S, ecc, &bc, &kt);
  *k_total = kt;
  *payload_capacity = kt - FRAME_HEADER_SIZE;
  return 1;
}

int lcc_capacity_info(
  const char *layer_name,
  int version,
  int constraint,
  int ecc_index,
  int *capacity_bits,
  int *payload_capacity,
  int *rs_symbols,
  int *k_total,
  int *ecc_index_out
) {
  const LccEncodeLayer *layer = lcc_encode_layer(layer_name);
  if (!layer || version < 1 || version > 100) return 0;
  const LccPaletteInfo *palette = lcc_palette(layer->name, 0);
  if (!palette) return 0;
  int idx = ecc_index;
  if (idx < 0) {
    idx = 0;
    for (int i = 0; i < 4; i++) {
      const double levels[4] = { 0.20, 0.30, 0.35, 0.40 };
      if (fabs(levels[i] - layer->ecc) < 1e-9) idx = i;
    }
  }
  if (idx < 0 || idx > 3) return 0;
  const double levels[4] = { 0.20, 0.30, 0.35, 0.40 };
  int cb = 0, pc = 0, rs = 0, kt = 0;
  if (!capacity_for_layer(layer, palette, version, constraint, levels[idx], &cb, &pc, &rs, &kt)) return 0;
  if (capacity_bits) *capacity_bits = cb;
  if (payload_capacity) *payload_capacity = pc;
  if (rs_symbols) *rs_symbols = rs;
  if (k_total) *k_total = kt;
  if (ecc_index_out) *ecc_index_out = idx;
  return 1;
}

/* ----- frame / whitening / format band ----- */

static void build_frame(uint8_t *out, int layer_id, int flags, const uint8_t *payload, int payload_len) {
  const uint32_t crc = lcc_crc32(payload, payload_len);
  out[0] = (uint8_t)((FRAME_MAGIC >> 8) & 0xff);
  out[1] = (uint8_t)(FRAME_MAGIC & 0xff);
  out[2] = FRAME_VERSION;
  out[3] = (uint8_t)(layer_id & 0xff);
  out[4] = (uint8_t)(flags & 0xff);
  const uint32_t len = (uint32_t)payload_len;
  out[5] = (uint8_t)((len >> 24) & 0xff);
  out[6] = (uint8_t)((len >> 16) & 0xff);
  out[7] = (uint8_t)((len >> 8) & 0xff);
  out[8] = (uint8_t)(len & 0xff);
  out[9] = (uint8_t)((crc >> 24) & 0xff);
  out[10] = (uint8_t)((crc >> 16) & 0xff);
  out[11] = (uint8_t)((crc >> 8) & 0xff);
  out[12] = (uint8_t)(crc & 0xff);
  memcpy(out + FRAME_HEADER_SIZE, payload, (size_t)payload_len);
}

static void whiten_bytes(uint8_t *out, const uint8_t *in, int len, int seed) {
  uint32_t state = (uint32_t)seed * 0x9e3779b9u + 0x85ebca6bu;
  if (state == 0) state = 0x1a2b3c4du;
  for (int i = 0; i < len; i++) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    out[i] = (uint8_t)(in[i] ^ (state & 0xff));
  }
}

static void push_bits(int *bits, int offset, int value, int n) {
  for (int i = n - 1; i >= 0; i--) bits[offset++] = (value >> i) & 1;
}

static int value_of(const int *bits, int offset, int n) {
  int v = 0;
  for (int i = 0; i < n; i++) v = (v << 1) | bits[offset + i];
  return v;
}

static void pack_format(
  int format_blocks,
  int mode_id,
  int ecc_index,
  int palette_mode,
  int harmony,
  int seed,
  int constraint,
  int compressed,
  int encrypted,
  int shape_layer_id,
  int shape_ext,
  int is_shape,
  uint8_t *chunks
) {
  int bits[15];
  memset(bits, 0, sizeof(bits));
  const int actual_mode = is_shape ? 7 : mode_id;
  const int palette_bits = is_shape ? (shape_layer_id & 3) : ((harmony || palette_mode == 1) ? 1 : 0);
  const int constraint_bit = is_shape ? (shape_ext ? 1 : 0) : (constraint ? 1 : 0);
  const int flag = (compressed || encrypted) ? 1 : 0;
  int offset = 0;
  push_bits(bits, offset, actual_mode, 3); offset += 3;
  push_bits(bits, offset, ecc_index, 2); offset += 2;
  if (format_blocks > 1) {
    bits[offset++] = constraint_bit;
    push_bits(bits, offset, palette_bits, 2); offset += 2;
    push_bits(bits, offset, seed & (format_blocks == 2 ? 3 : 63), format_blocks == 2 ? 2 : 6);
    offset += format_blocks == 2 ? 2 : 6;
    if (format_blocks > 2) bits[offset++] = flag;
  }
  for (int i = 0; i < format_blocks; i++) chunks[i] = (uint8_t)value_of(bits, i * 5, 5);
}

static void write_format_band(int16_t *symbols, const LccEncodeLayout *layout, const uint8_t *chunks) {
  const int N = layout->N;
  for (int copy = 0; copy < layout->copy_count; copy++) {
    for (int block = 0; block < layout->blocks; block++) {
      const int cw = lcc_bch15_encode(chunks[block]);
      const int row0 = layout->copy_row[copy] + block * 2;
      const int col0 = layout->copy_col[copy];
      for (int j = 0; j < 16; j++) {
        const int r = row0 + (j >= 8 ? 1 : 0);
        const int c = col0 + (j % 8);
        const int bit = j < 15 ? (cw >> (14 - j)) & 1 : 0;
        symbols[r * N + c] = (int16_t)(bit ? layout->white_symbol : layout->black_symbol);
      }
    }
  }
}

static int read_bit_at(const uint8_t *bytes, int bit_length, int pos) {
  if (pos < 0 || pos >= bit_length) return 0;
  return (bytes[pos >> 3] >> (7 - (pos & 7))) & 1;
}

static int read_bits_at(const uint8_t *bytes, int bit_length, int *pos, int n) {
  int v = 0;
  for (int i = 0; i < n; i++) v = (v << 1) | read_bit_at(bytes, bit_length, (*pos)++);
  return v;
}

/* ----- rendering ----- */

static void paint_module(
  uint8_t *data,
  int size,
  int x0,
  int y0,
  int module_size,
  const uint8_t background[3],
  int shape_index
) {
  int foreground[3] = { 0, 0, 0 };
  uint8_t *mask = NULL;
  if (shape_index >= 0) {
    lcc_encode_foreground((const int[]){ background[0], background[1], background[2] }, foreground);
    mask = lcc_alloc((size_t)module_size * (size_t)module_size);
    if (mask) lcc_encode_shape_mask(shape_index, module_size, mask);
  }
  for (int dy = 0; dy < module_size; dy++) {
    size_t p = ((size_t)(y0 + dy) * (size_t)size + (size_t)x0) * 3;
    for (int dx = 0; dx < module_size; dx++) {
      const int on = mask ? mask[dy * module_size + dx] : 0;
      if (on) {
        data[p++] = (uint8_t)foreground[0];
        data[p++] = (uint8_t)foreground[1];
        data[p++] = (uint8_t)foreground[2];
      } else {
        data[p++] = background[0];
        data[p++] = background[1];
        data[p++] = background[2];
      }
    }
  }
  lcc_release(mask);
}

static int render_result(LccEncodeResult *result, const LccEncodeLayout *layout, const LccPaletteInfo *palette) {
  const int N = layout->N;
  const int side = (N + 2 * result->quiet_zone) * result->module_size;
  if (side <= 0 || side > 32768) return 0;
  if ((int64_t)side * (int64_t)side > (int64_t)LCC_MAX_PIXELS) return 0;
  result->width = side;
  result->height = side;
  result->image = lcc_alloc((size_t)side * (size_t)side * 3);
  if (!result->image) return 0;
  memset(result->image, 255, (size_t)side * (size_t)side * 3);

  const int color_count = palette->palette_size;
  const int shape_set = result->shape_set > 0 ? result->shape_set : 1;
  for (int r = 0; r < N; r++) {
    for (int c = 0; c < N; c++) {
      const int i = r * N + c;
      uint8_t background[3];
      int shape_index = -1;
      if (layout->has_fixed_color[i]) {
        background[0] = layout->fixed_color[i * 3];
        background[1] = layout->fixed_color[i * 3 + 1];
        background[2] = layout->fixed_color[i * 3 + 2];
        if (layout->has_fixed_shape[i]) shape_index = layout->fixed_shape[i];
      } else {
        const int sym = result->symbols[i];
        if (sym < 0 || sym >= shape_set * color_count) return 0;
        if (shape_set > 1) {
          shape_index = sym / color_count;
          background[0] = palette->rgb[(sym % color_count) * 3];
          background[1] = palette->rgb[(sym % color_count) * 3 + 1];
          background[2] = palette->rgb[(sym % color_count) * 3 + 2];
        } else {
          background[0] = palette->rgb[sym * 3];
          background[1] = palette->rgb[sym * 3 + 1];
          background[2] = palette->rgb[sym * 3 + 2];
        }
      }
      const int y0 = (r + result->quiet_zone) * result->module_size;
      const int x0 = (c + result->quiet_zone) * result->module_size;
      paint_module(result->image, side, x0, y0, result->module_size, background, shape_index);
    }
  }
  return 1;
}

/* ----- option resolution ----- */

static int resolve_ecc_index(int option, const LccEncodeLayer *layer) {
  if (option == -1) {
    const double levels[4] = { 0.20, 0.30, 0.35, 0.40 };
    for (int i = 0; i < 4; i++) if (fabs(levels[i] - layer->ecc) < 1e-9) return i;
    return -1;
  }
  return option >= 0 && option <= 3 ? option : -1;
}

static int int_option(int value, int is_set, const char *name, int min, int max, char *error, int error_len, int *out) {
  if (!is_set) return 1;
  if (value < min || value > max) {
    set_error(error, error_len, "LCC: %s must be an integer between %d and %d", name, min, max);
    return 0;
  }
  *out = value;
  return 1;
}

int lcc_encode_payload(
  const uint8_t *payload,
  int payload_len,
  const LccEncodeOptions *options,
  LccEncodeResult *result,
  char *error,
  int error_len
) {
  if (!options || !result || payload_len < 0 || (payload_len > 0 && !payload)) {
    set_error(error, error_len, "LCC: bad encode input");
    return LCC_BAD_INPUT;
  }
  memset(result, 0, sizeof(*result));
  const LccEncodeLayer *layer = lcc_encode_layer(options->layer ? options->layer : "G10");
  if (!layer) {
    set_error(error, error_len, "LCC: unknown layer %s", options->layer ? options->layer : "");
    return LCC_BAD_INPUT;
  }
  const int is_shape = layer->shape_set != 0;
  const int requested_seed = options->seed;
  if (requested_seed < 0 || requested_seed > 63) {
    set_error(error, error_len, "LCC: seed must be an integer between 0 and 63");
    return LCC_BAD_INPUT;
  }
  if (is_shape && requested_seed != 0) {
    set_error(error, error_len, "LCC: shape layers reserve the format seed field for the shape variant; options.seed must be 0");
    return LCC_BAD_INPUT;
  }
  const int palette_mode = is_shape ? 0 : (options->palette_mode ? 1 : 0);
  const int harmony = is_shape ? 0 : (options->harmony ? 1 : 0);
  int constraint = options->constraint < 0 ? layer->default_constraint : (options->constraint ? 1 : 0);
  if (strcmp(layer->name, "G10") == 0 || is_shape) constraint = 0;

  const int mode = options->mode ? 1 : 0;
  const int width = options->width > 0 ? options->width : 1024;
  const int height = options->height > 0 ? options->height : 1024;
  const int quiet_zone = options->quiet_zone < 0 ? 2 : options->quiet_zone;
  const int min_module = options->min_module > 0 ? options->min_module : 4;
  const int max_module = options->max_module > 0 ? options->max_module : 64;
  const int min_module_px = min_module > layer->min_module_px ? min_module : layer->min_module_px;
  const int max_module_px = max_module;
  const int base_ecc_index = resolve_ecc_index(options->ecc_index, layer);
  if (base_ecc_index < 0) {
    set_error(error, error_len, "LCC: eccLevel must be auto/L/M/Q/H");
    return LCC_BAD_INPUT;
  }
  const double levels[4] = { 0.20, 0.30, 0.35, 0.40 };
  const int boost_ecc = options->boost_ecc ? 1 : 0;
  const int module_size_option = options->module_size > 0 ? options->module_size : 0;

  const int palette_mode_ok = options->palette_mode == 0 || options->palette_mode == 1;
  if (!palette_mode_ok && !is_shape) {
    set_error(error, error_len, "LCC: paletteMode must be maxmin or harmony");
    return LCC_BAD_INPUT;
  }
  const LccPaletteInfo *palette = lcc_palette(layer->name, harmony);
  if (!palette) {
    set_error(error, error_len, "LCC: unknown layer %s", layer->name);
    return LCC_BAD_INPUT;
  }

  const int rich_format = is_shape || layer->kind == 1 || constraint ||
    requested_seed != 0 || palette_mode != 0 || harmony != 0;
  int min_version = options->min_version > 0 ? options->min_version : 1;
  if (min_version < (rich_format ? 2 : 1)) min_version = rich_format ? 2 : 1;
  if (min_version < layer->min_version) min_version = layer->min_version;
  int max_version = options->max_version > 0 ? options->max_version : 100;
  if (min_version < 1 || max_version > 100 || max_version < min_version) {
    set_error(error, error_len, "LCC: invalid version range");
    return LCC_BAD_INPUT;
  }

  int chosen_version = 0;
  int chosen_module = 0;
  int chosen_ecc = 0;
  int cap_bits = 0;
  int cap_payload = 0;
  int cap_rs = 0;
  int cap_k = 0;

  if (options->version > 0) {
    const int version = options->version;
    if (version < min_version || version > max_version) {
      set_error(error, error_len, "LCC: version must be between %d and %d", min_version, max_version);
      return LCC_BAD_INPUT;
    }
    LccLayout probe;
    memset(&probe, 0, sizeof(probe));
    if (!lcc_make_layout(palette, version, &probe)) return LCC_ERR;
    const int D = probe.data_count;
    lcc_layout_free(&probe);
    int found = 0;
    if (!boost_ecc) {
      int cb, pc, rs, kt;
      if (capacity_for_layer(layer, palette, version, constraint, levels[base_ecc_index], &cb, &pc, &rs, &kt) &&
          pc >= payload_len) {
        chosen_ecc = base_ecc_index;
        cap_bits = cb; cap_payload = pc; cap_rs = rs; cap_k = kt;
        found = 1;
      }
    } else {
      for (int e = 3; e >= base_ecc_index; e--) {
        int cb, pc, rs, kt;
        if (!capacity_for_layer(layer, palette, version, constraint, levels[e], &cb, &pc, &rs, &kt)) continue;
        if (pc >= payload_len) {
          chosen_ecc = e;
          cap_bits = cb; cap_payload = pc; cap_rs = rs; cap_k = kt;
          found = 1;
          break;
        }
      }
    }
    (void)D;
    if (!found) {
      set_error(error, error_len, "LCC: payload does not fit at this version");
      return LCC_BAD_INPUT;
    }
    int s = module_size_option > 0 ? module_size_option : (int)floor((double)(width < height ? width : height) / (version_to_size(version) + 2 * quiet_zone));
    s = clampi(s, min_module_px, max_module_px);
    chosen_version = version;
    chosen_module = s;
  } else {
    const int min_side = width < height ? width : height;
    int found = 0;
    const int version_max_from_side = (int)floor((double)(min_side / max_module_px) / 1.0);
    (void)version_max_from_side;
    if (mode == 1) {
      if (module_size_option > 0) {
        const int s = clampi(module_size_option, min_module_px, max_module_px);
        const int n_max = min_side / s - 2 * quiet_zone;
        if (n_max < 21) {
          set_error(error, error_len, "LCC: module size is too large for the canvas");
          return LCC_BAD_INPUT;
        }
        const int v_max = (n_max - 21) / 4 + 1;
        const int limit = v_max < max_version ? v_max : max_version;
        if (limit < min_version) {
          set_error(error, error_len, "LCC: version range does not fit the canvas");
          return LCC_BAD_INPUT;
        }
        for (int version = min_version; version <= limit; version++) {
          int e = base_ecc_index;
          int cb, pc, rs, kt;
          int ok = 0;
          if (!boost_ecc) {
            ok = capacity_for_layer(layer, palette, version, constraint, levels[base_ecc_index], &cb, &pc, &rs, &kt) && pc >= payload_len;
          } else {
            for (e = 3; e >= base_ecc_index; e--) {
              if (capacity_for_layer(layer, palette, version, constraint, levels[e], &cb, &pc, &rs, &kt) && pc >= payload_len) {
                ok = 1;
                break;
              }
            }
          }
          if (ok) {
            chosen_version = version;
            chosen_module = s;
            chosen_ecc = e;
            cap_bits = cb; cap_payload = pc; cap_rs = rs; cap_k = kt;
            found = 1;
            break;
          }
        }
        if (!found) {
          set_error(error, error_len, "LCC: payload does not fit in the requested canvas");
          return LCC_BAD_INPUT;
        }
      } else {
        for (int version = min_version; version <= max_version; version++) {
          int e = base_ecc_index;
          int cb, pc, rs, kt;
          int ok = 0;
          if (!boost_ecc) {
            ok = capacity_for_layer(layer, palette, version, constraint, levels[base_ecc_index], &cb, &pc, &rs, &kt) && pc >= payload_len;
          } else {
            for (e = 3; e >= base_ecc_index; e--) {
              if (capacity_for_layer(layer, palette, version, constraint, levels[e], &cb, &pc, &rs, &kt) && pc >= payload_len) {
                ok = 1;
                break;
              }
            }
          }
          if (ok) {
            const int s = min_side / (version_to_size(version) + 2 * quiet_zone);
            if (s < min_module_px) break;
            chosen_version = version;
            chosen_module = s < max_module_px ? s : max_module_px;
            chosen_ecc = e;
            cap_bits = cb; cap_payload = pc; cap_rs = rs; cap_k = kt;
            found = 1;
            break;
          }
        }
        if (!found) {
          set_error(error, error_len, "LCC: payload does not fit in the requested canvas");
          return LCC_BAD_INPUT;
        }
      }
    } else if (module_size_option > 0) {
      const int s = clampi(module_size_option, min_module_px, max_module_px);
      const int n_max = min_side / s - 2 * quiet_zone;
      if (n_max < 21) {
        set_error(error, error_len, "LCC: module size is too large for the canvas");
        return LCC_BAD_INPUT;
      }
      int version = (n_max - 21) / 4 + 1;
      if (version > max_version) version = max_version;
      if (version < min_version) {
        set_error(error, error_len, "LCC: version range does not fit the canvas");
        return LCC_BAD_INPUT;
      }
      int e = base_ecc_index;
      int cb, pc, rs, kt;
      int ok = 0;
      if (!boost_ecc) {
        ok = capacity_for_layer(layer, palette, version, constraint, levels[base_ecc_index], &cb, &pc, &rs, &kt) && pc >= payload_len;
      } else {
        for (e = 3; e >= base_ecc_index; e--) {
          if (capacity_for_layer(layer, palette, version, constraint, levels[e], &cb, &pc, &rs, &kt) && pc >= payload_len) {
            ok = 1;
            break;
          }
        }
      }
      if (!ok) {
        set_error(error, error_len, "LCC: payload does not fit at this module size");
        return LCC_BAD_INPUT;
      }
      chosen_version = version;
      chosen_module = s;
      chosen_ecc = e;
      cap_bits = cb; cap_payload = pc; cap_rs = rs; cap_k = kt;
    } else {
      for (int s = max_module_px; s >= min_module_px; s--) {
        const int n_max = min_side / s - 2 * quiet_zone;
        if (n_max < 21) continue;
        int version = (n_max - 21) / 4 + 1;
        if (version > max_version) version = max_version;
        if (version < min_version) continue;
        int e = base_ecc_index;
        int cb, pc, rs, kt;
        int ok = 0;
        if (!boost_ecc) {
          ok = capacity_for_layer(layer, palette, version, constraint, levels[base_ecc_index], &cb, &pc, &rs, &kt) && pc >= payload_len;
        } else {
          for (e = 3; e >= base_ecc_index; e--) {
            if (capacity_for_layer(layer, palette, version, constraint, levels[e], &cb, &pc, &rs, &kt) && pc >= payload_len) {
              ok = 1;
              break;
            }
          }
        }
        if (ok) {
          chosen_version = version;
          chosen_module = s;
          chosen_ecc = e;
          cap_bits = cb; cap_payload = pc; cap_rs = rs; cap_k = kt;
          found = 1;
          break;
        }
      }
      if (!found) {
        set_error(error, error_len, "LCC: payload does not fit even at the minimum module size");
        return LCC_BAD_INPUT;
      }
    }
  }

  const int version = chosen_version;
  const int module_size = chosen_module;
  const int ecc_index = chosen_ecc;
  const double ecc = levels[ecc_index];

  LccEncodeLayout layout;
  if (!lcc_encode_layout_build(palette, version, &layout)) return LCC_ERR;
  const int format_blocks = layout.blocks;

  int seed = requested_seed;
  if (is_shape) {
    seed = layer->shape_variant;
  } else if (format_blocks == 1) {
    seed = 0;
  } else if (format_blocks == 2) {
    seed &= 3;
  } else {
    seed &= 63;
  }
  const int whiten_seed = is_shape ? 0 : seed;

  if (payload_len > cap_payload) {
    set_error(error, error_len, "LCC: payload too large (%d > %d)", payload_len, cap_payload);
    lcc_encode_layout_free(&layout);
    return LCC_BAD_INPUT;
  }

  const int flags = (constraint ? FLAG_CONSTRAINT : 0) |
    (options->compressed ? FLAG_COMPRESSED : 0) |
    (options->encrypted ? FLAG_ENCRYPTED : 0);
  const int frame_len = FRAME_HEADER_SIZE + payload_len;
  if (frame_len > cap_k) {
    set_error(error, error_len, "LCC: frame too large (%d > %d)", frame_len, cap_k);
    lcc_encode_layout_free(&layout);
    return LCC_BAD_INPUT;
  }

  uint8_t *padded = lcc_alloc((size_t)cap_k);
  uint8_t *whitened = lcc_alloc((size_t)cap_k);
  uint8_t *rs_bytes = NULL;
  int rs_len = 0;
  int16_t *data_symbols = lcc_alloc((size_t)layout.data_count * sizeof(int16_t));
  int *format_chunks = lcc_alloc(8 * sizeof(int));
  if (!padded || !whitened || !data_symbols || !format_chunks) {
    lcc_release(padded);
    lcc_release(whitened);
    lcc_release(data_symbols);
    lcc_release(format_chunks);
    lcc_encode_layout_free(&layout);
    return LCC_ERR;
  }
  build_frame(padded, layer->id, flags, payload, payload_len);
  whiten_bytes(whitened, padded, cap_k, whiten_seed);
  if (!lcc_rs_encode_blocks(whitened, cap_k, cap_rs, ecc, &rs_bytes, &rs_len)) {
    lcc_release(padded);
    lcc_release(whitened);
    lcc_release(data_symbols);
    lcc_release(format_chunks);
    lcc_encode_layout_free(&layout);
    return LCC_ERR;
  }

  const int bit_bytes = (cap_bits + 7) / 8;
  uint8_t *bits = lcc_alloc((size_t)(bit_bytes > 0 ? bit_bytes : 1));
  if (!bits) {
    lcc_release(rs_bytes);
    lcc_release(padded);
    lcc_release(whitened);
    lcc_release(data_symbols);
    lcc_release(format_chunks);
    lcc_encode_layout_free(&layout);
    return LCC_ERR;
  }
  memset(bits, 0, (size_t)(bit_bytes > 0 ? bit_bytes : 1));
  if (rs_len > 0) {
    const int copy = rs_len < bit_bytes ? rs_len : bit_bytes;
    memcpy(bits, rs_bytes, (size_t)copy);
  }

  int encode_ok = 1;
  if (strcmp(layer->name, "G10") == 0) {
    int pos = 0;
    for (int i = 0; i < layout.data_count; i++) {
      data_symbols[i] = (int16_t)read_bits_at(bits, cap_bits, &pos, 1);
    }
  } else if (constraint) {
    LccRankConstraint *rc = lcc_rank_constraint_build(palette);
    if (!rc || !lcc_rank_constraint_encode(rc, bits, cap_bits, layout.data_count, data_symbols)) encode_ok = 0;
    lcc_rank_constraint_free(rc);
  } else {
    int pos = 0;
    for (int i = 0; i < layout.data_count; i++) {
      data_symbols[i] = (int16_t)read_bits_at(bits, cap_bits, &pos, layer->bits);
    }
  }
  lcc_release(bits);
  lcc_release(rs_bytes);
  lcc_release(padded);
  lcc_release(whitened);

  if (!encode_ok) {
    lcc_release(data_symbols);
    lcc_release(format_chunks);
    lcc_encode_layout_free(&layout);
    return LCC_ERR;
  }

  result->symbols = lcc_alloc((size_t)layout.N * (size_t)layout.N * sizeof(int16_t));
  if (!result->symbols) {
    lcc_release(data_symbols);
    lcc_release(format_chunks);
    lcc_encode_layout_free(&layout);
    return LCC_ERR;
  }
  memcpy(result->symbols, layout.fixed, (size_t)layout.N * (size_t)layout.N * sizeof(int16_t));
  for (int i = 0; i < layout.data_count; i++) {
    const int r = layout.data_rc[i * 2];
    const int c = layout.data_rc[i * 2 + 1];
    result->symbols[r * layout.N + c] = data_symbols[i];
  }
  lcc_release(data_symbols);

  const int is_shape_int = is_shape ? 1 : 0;
  pack_format(
    format_blocks,
    layer->id,
    ecc_index,
    palette_mode,
    harmony,
    seed,
    constraint,
    options->compressed,
    options->encrypted,
    is_shape_int ? layer->shape_layer_id : 0,
    is_shape_int ? layer->shape_ext : 0,
    is_shape_int,
    (uint8_t *)format_chunks
  );
  write_format_band(result->symbols, &layout, (const uint8_t *)format_chunks);
  lcc_release(format_chunks);

  result->version = version;
  result->N = layout.N;
  result->module_size = module_size;
  result->quiet_zone = quiet_zone;
  result->ecc_index = ecc_index;
  result->format_blocks = format_blocks;
  result->seed = whiten_seed;
  result->constraint = constraint;
  result->palette_size = layer->palette_size;
  result->black_index = palette->black_index;
  result->white_index = palette->white_index;
  result->rank_count = palette->rank_count;
  result->max_rank_diff = palette->max_rank_diff;
  result->initial_rank = palette->initial_rank;
  result->flags = flags;
  result->shape_set = is_shape ? layer->shape_set : 0;
  result->shape_layer_id = is_shape ? layer->shape_layer_id : -1;
  result->shape_ext = is_shape ? layer->shape_ext : 0;
  result->shape_variant = is_shape ? layer->shape_variant : 0;
  result->layer_id = layer->id;
  result->capacity_bits = cap_bits;
  result->data_count = layout.data_count;
  result->function_count = layout.function_count;
  result->payload_capacity = cap_payload;
  result->payload_size = payload_len;
  result->rs_symbols = cap_rs;
  result->k_total = cap_k;
  result->ecc = ecc;
  result->bits_per_module = strcmp(layer->name, "G10") == 0
    ? 1.0
    : constraint
      ? (double)cap_bits / (double)layout.data_count
      : (double)layer->bits;
  result->min_delta_e = palette->min_delta_e;
  result->palette_mode = palette_mode;
  result->harmony = harmony;
  result->palette = palette;
  result->layout = layout;

  if (!render_result(result, &layout, palette)) {
    set_error(error, error_len, "LCC: rendered image exceeds the pixel budget");
    lcc_encode_result_free(result);
    return LCC_BAD_INPUT;
  }
  return LCC_OK;
}

void lcc_encode_result_free(LccEncodeResult *result) {
  if (!result) return;
  lcc_release(result->image);
  lcc_release(result->symbols);
  lcc_encode_layout_free(&result->layout);
  memset(result, 0, sizeof(*result));
}
