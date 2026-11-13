#ifndef LCC_ENCODE_INTERNAL_H
#define LCC_ENCODE_INTERNAL_H

#include "lcc_internal.h"

/* ------------------------------------------------------------------ */
/* Layer metadata (encoder side)                                      */
/* ------------------------------------------------------------------ */

typedef struct {
  const char *name;
  const char *legacy;
  int id;
  int kind;          /* 0 = gray, 1 = color */
  int levels;        /* gray levels, 0 for color layers */
  int palette_size;
  int bits;
  double ecc;
  int default_constraint;
  int shape_set;     /* 0 = base layer, 1/8/32 = shape family */
  int shape_layer_id;
  int shape_ext;
  int shape_variant;
  int min_version;
  int min_module_px;
} LccEncodeLayer;

const LccEncodeLayer *lcc_encode_layer(const char *name);
const LccEncodeLayer *lcc_encode_layer_by_index(int index);
int lcc_encode_layer_count(void);

/* ------------------------------------------------------------------ */
/* Full encoder layout                                                */
/* ------------------------------------------------------------------ */

typedef struct {
  int version;
  int N;
  int blocks;
  int rows_per_copy;
  int cols_per_copy;
  int copy_count;
  int copy_row[2];
  int copy_col[2];
  int data_count;
  int function_count;
  int black_symbol;
  int white_symbol;
  int *data_rc;          /* data_count * 2 (row, col) */
  int16_t *fixed;        /* N * N, -1 for data cells */
  uint8_t *fixed_color;  /* N * N * 3 */
  uint8_t *has_fixed_color;
  int8_t *fixed_shape;
  uint8_t *has_fixed_shape;
} LccEncodeLayout;

int lcc_encode_layout_build(const LccPaletteInfo *palette, int version, LccEncodeLayout *layout);
void lcc_encode_layout_free(LccEncodeLayout *layout);

/* ------------------------------------------------------------------ */
/* Shape masks / rendering helpers                                    */
/* ------------------------------------------------------------------ */

void lcc_encode_shape_mask(int shape_index, int size, uint8_t *mask);
void lcc_encode_foreground(const int background[3], int foreground[3]);

/* ------------------------------------------------------------------ */
/* Constraint + capacity helpers                                      */
/* ------------------------------------------------------------------ */

typedef struct LccRankConstraint LccRankConstraint;

LccRankConstraint *lcc_rank_constraint_build(const LccPaletteInfo *palette);
void lcc_rank_constraint_free(LccRankConstraint *rc);
int lcc_rank_constraint_capacity_bits(const LccRankConstraint *rc, int modules);
int lcc_rank_constraint_encode(
  const LccRankConstraint *rc,
  const uint8_t *bytes,
  int bit_length,
  int modules,
  int16_t *symbols
);
int lcc_rank_constraint_decode(
  const LccRankConstraint *rc,
  const int16_t *symbols,
  int count,
  uint8_t **out,
  int *out_bits
);

/* ------------------------------------------------------------------ */
/* Encoding core                                                      */
/* ------------------------------------------------------------------ */

typedef struct {
  const char *layer;
  int width;
  int height;
  int mode;              /* 0 = fill, 1 = compact */
  int palette_mode;      /* 0 = maxmin, 1 = harmony */
  int harmony;
  int constraint;        /* -1 = layer default */
  int seed;
  int ecc_index;         /* -1 = auto, 0..3 = L/M/Q/H */
  int boost_ecc;
  int min_module;
  int max_module;
  int quiet_zone;        /* -1 = default */
  int min_version;       /* 0 = default */
  int max_version;       /* 0 = default */
  int module_size;       /* 0 = auto */
  int version;           /* 0 = auto */
  int compressed;
  int encrypted;
} LccEncodeOptions;

typedef struct {
  int version;
  int N;
  int module_size;
  int quiet_zone;
  int ecc_index;
  int format_blocks;
  int seed;
  int constraint;
  int palette_size;
  int black_index;
  int white_index;
  int rank_count;
  int max_rank_diff;
  int initial_rank;
  int flags;
  int shape_set;
  int shape_layer_id;
  int shape_ext;
  int shape_variant;
  int layer_id;
  int capacity_bits;
  int data_count;
  int function_count;
  int payload_capacity;
  int payload_size;
  int rs_symbols;
  int k_total;
  double ecc;
  double bits_per_module;
  double min_delta_e;
  int palette_mode;
  int harmony;
  int width;
  int height;
  uint8_t *image;
  int16_t *symbols;
  const LccPaletteInfo *palette;
  LccEncodeLayout layout;
} LccEncodeResult;

int lcc_encode_payload(
  const uint8_t *payload,
  int payload_len,
  const LccEncodeOptions *options,
  LccEncodeResult *result,
  char *error,
  int error_len
);
void lcc_encode_result_free(LccEncodeResult *result);

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
);

int lcc_api_encode(const uint8_t *input, int input_len);
int lcc_api_encode_layout(const uint8_t *input, int input_len);

#endif
