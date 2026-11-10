#ifndef LCC_INTERNAL_H
#define LCC_INTERNAL_H

#include "lcc.h"

int lcc_solve(const double *A, const double *b, int n, double *out);

void lcc_rgb_to_lab(const int rgb[3], double lab[3]);
double lcc_delta_e(const double *a, const double *b);
double lcc_luminance(const int rgb[3]);

void lcc_gf_init(void);
int lcc_gf_mul(int a, int b);
int lcc_gf_div(int a, int b);
int lcc_gf_inv(int a);
int lcc_gf_pow(int a, int e);

uint32_t lcc_crc32(const uint8_t *bytes, int len);
int lcc_bch15_decode(int word);

int lcc_rs_decode_blocks(const uint8_t *received, int len, double redundancy, uint8_t **out, int *out_len, int *corrected);

typedef struct {
  int version;
  int N;
  int blocks;
  int copy_row[2];
  int copy_col[2];
  int copy_count;
  int has_alignment;
  int data_count;
  int *data_rc;
  int gray_count;
  int gray_row[16];
  int gray_col[16];
  uint8_t gray_rgb[16][3];
  int palette_count;
  int pal_row[256];
  int pal_col[256];
  uint8_t pal_rgb[256][3];
} LccLayout;

int lcc_make_layout(const LccPaletteInfo *palette, int version, LccLayout *layout);
void lcc_layout_free(LccLayout *layout);

typedef struct {
  int width;
  int height;
  uint8_t *mask;
  int constant;
  float *threshold;
  double otsu;
} LccVariant;

typedef struct {
  int width;
  int height;
  const uint8_t *rgb;
  uint8_t *gray;
  uint8_t *value;
  float *sat;
  double gray_otsu;
  double value_otsu;
  double *gray_integral;
  double *value_integral;
} LccPrep;

int lcc_prep_init(LccPrep *prep, const LccImage *image);
void lcc_prep_free(LccPrep *prep);
int lcc_variant_build(LccPrep *prep, const char *name, LccVariant *out);
void lcc_variant_free(LccVariant *v);
double lcc_threshold_at(const LccVariant *v, double x, double y);

typedef struct {
  int version;
  int N;
  double s;
  double score;
  int has_h;
  double H[9];
  double origin_x;
  double origin_y;
  double threshold;
  int axis;
} LccFound;

int lcc_detect_axis(const LccImage *image, const LccVariant *variant, LccFound *found);
int lcc_detect_perspective(const LccImage *image, const LccVariant *variant, LccFound *found);

#endif
