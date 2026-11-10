#ifndef LCC_H
#define LCC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  int width;
  int height;
  const uint8_t *data;
} LccImage;

typedef struct {
  int valid;
  int version;
  int N;
  double score;
  int has_h;
  double H[9];
  double origin_x;
  double origin_y;
  double s;
} LccDet;

typedef struct {
  const char *name;
  int harmony;
  int kind;
  int levels;
  int palette_size;
  int bits;
  int shape_set;
  int shape_layer_id;
  int shape_ext;
  int black_index;
  int white_index;
  int rank_count;
  int max_rank_diff;
  int initial_rank;
  double min_delta_e;
  const uint8_t *rgb;
  const double *lab;
  const uint8_t *gray_rgb;
  const double *gray_lab;
  const int16_t *rank_of;
} LccPaletteInfo;

typedef struct {
  int status;
  int version;
  int N;
  double module_size;
  double ecc;
  int corrected;
  int palette_size;
  double min_delta_e;
  int constraint;
  int harmony;
  int seed;
  int shape_set;
  double bits_per_module;
  int format_blocks;
  int data_count;
  int rs_symbols;
  int rank_count;
  int max_rank_diff;
  int calibration;
  char layer[8];
  char palette_mode[16];
} LccDecodeMeta;

enum {
  LCC_OK = 0,
  LCC_ERR = 1,
  LCC_BAD_INPUT = 2,
  LCC_UNSUPPORTED = 3
};

enum {
  LCC_CAL_THRESHOLD = 0,
  LCC_CAL_GRAY = 1,
  LCC_CAL_IDENTITY_CLEAN = 2,
  LCC_CAL_AFFINE = 3,
  LCC_CAL_IDENTITY = 4
};

extern const LccPaletteInfo lcc_palettes[];
extern const int lcc_palette_count;

const LccPaletteInfo *lcc_palette(const char *name, int harmony);

double lcc_js_round(double x);
void lcc_sample_image(const LccImage *image, double x, double y, int radius, int rgb[3]);
void lcc_sample_bilinear(const LccImage *image, double x, double y, int rgb[3]);

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
  int *out_quiet);

int lcc_decode_image(const LccImage *image, int mode, uint8_t **payload, int *payload_len, LccDecodeMeta *meta);

void *lcc_alloc(size_t n);
void lcc_release(void *p);

int lcc_api_stack(const uint8_t *input, int input_len);
int lcc_api_decode(const uint8_t *rgb, int width, int height, int mode);
uint8_t *lcc_last(void);
int lcc_last_len(void);

#ifdef __cplusplus
}
#endif

#endif
