#include "lcc_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

static const char *AXIS_NAMES[] = {
  "value-otsu", "value-otsu+close", "otsu", "otsu+close",
};
static const char *PERSP_NAMES[] = {
  "value-adaptive-1/8+close",
  "value-adaptive-1/8",
  "value-otsu+close",
  "value-otsu",
  "adaptive-1/8+close",
  "adaptive-1/8",
  "adaptive-1/16+close",
  "adaptive-1/16",
  "otsu+close",
  "otsu",
  "adaptive-1/4+close",
  "adaptive-1/4",
};

static void apply_h(const double H[9], double u, double v, double *x, double *y) {
  const double w = H[6] * u + H[7] * v + H[8];
  if (fabs(w) < 1e-12) {
    *x = NAN;
    *y = NAN;
    return;
  }
  *x = (H[0] * u + H[1] * v + H[2]) / w;
  *y = (H[3] * u + H[4] * v + H[5]) / w;
}

static void point_at(const LccFound *found, double row, double col, double *x, double *y) {
  if (found->has_h) apply_h(found->H, col + 0.5, row + 0.5, x, y);
  else {
    *x = found->origin_x + (col + 0.5) * found->s;
    *y = found->origin_y + (row + 0.5) * found->s;
  }
}

static void raw_sample(const LccImage *image, const LccFound *found, int row, int col, int rgb[3]) {
  if (!found->has_h) {
    const double cx = found->origin_x + (col + 0.5) * found->s;
    const double cy = found->origin_y + (row + 0.5) * found->s;
    int radius = (int)floor(found->s / 4.0) - 1;
    if (radius < 0) radius = 0;
    lcc_sample_image(image, cx, cy, radius, rgb);
    return;
  }
  int samples[9][3];
  int n = 0;
  const double offs[3] = { -0.2, 0, 0.2 };
  for (int iy = 0; iy < 3; iy++) {
    for (int ix = 0; ix < 3; ix++) {
      double x, y;
      apply_h(found->H, col + 0.5 + offs[ix], row + 0.5 + offs[iy], &x, &y);
      lcc_sample_image(image, x, y, 0, samples[n]);
      n++;
    }
  }
  for (int ch = 0; ch < 3; ch++) {
    int vals[9];
    for (int i = 0; i < 9; i++) vals[i] = samples[i][ch];
    for (int i = 1; i < 9; i++) {
      int key = vals[i];
      int j = i - 1;
      while (j >= 0 && vals[j] > key) {
        vals[j + 1] = vals[j];
        j--;
      }
      vals[j + 1] = key;
    }
    rgb[ch] = vals[4];
  }
}

static double threshold_rc(const LccFound *found, const LccVariant *variant, int row, int col) {
  double x, y;
  if (found->has_h) apply_h(found->H, col + 0.5, row + 0.5, &x, &y);
  else {
    x = found->origin_x + (col + 0.5) * found->s;
    y = found->origin_y + (row + 0.5) * found->s;
  }
  return lcc_threshold_at(variant, x, y);
}

static int format_symbol(const LccImage *image, const LccFound *found, const LccVariant *variant, int row, int col) {
  int rgb[3];
  raw_sample(image, found, row, col, rgb);
  const int v = rgb[0] > rgb[1] ? (rgb[0] > rgb[2] ? rgb[0] : rgb[2]) : (rgb[1] > rgb[2] ? rgb[1] : rgb[2]);
  return v < threshold_rc(found, variant, row, col) ? 0 : 1;
}

typedef struct {
  int mode_id;
  int ecc_index;
  int shape_layer_id;
  int shape_ext;
  int harmony;
  int seed;
  int constraint;
  char palette_mode[16];
} FormatInfo;

static int read_format(const LccImage *image, const LccFound *found, const LccVariant *variant, const LccLayout *layout, FormatInfo *fmt) {
  int copies[2][3];
  int copy_ok[2] = { 0, 0 };
  int nok = 0;
  for (int copy = 0; copy < layout->copy_count; copy++) {
    int ok = 1;
    int chunks[3] = { 0, 0, 0 };
    for (int block = 0; block < layout->blocks; block++) {
      const int row0 = layout->copy_row[copy] + block * 2;
      const int col0 = layout->copy_col[copy];
      int cw = 0;
      for (int j = 0; j < 15; j++) {
        const int r = row0 + (j >= 8 ? 1 : 0);
        const int c = col0 + (j % 8);
        const int bit = format_symbol(image, found, variant, r, c) ? 1 : 0;
        cw = (cw << 1) | bit;
      }
      const int msg = lcc_bch15_decode(cw);
      if (msg < 0) {
        ok = 0;
        break;
      }
      chunks[block] = msg;
    }
    if (!ok) continue;
    for (int i = 0; i < layout->blocks; i++) copies[nok][i] = chunks[i];
    copy_ok[nok] = 1;
    nok++;
  }
  if (nok == 0) return 0;
  int chosen = 0;
  if (nok > 1) {
    int same = 1;
    for (int i = 0; i < layout->blocks; i++) {
      if (copies[0][i] != copies[1][i]) same = 0;
    }
    if (!same) return 0;
  }
  (void)copy_ok;
  int bits[16];
  int nbits = 0;
  for (int i = 0; i < layout->blocks; i++) {
    for (int b = 4; b >= 0; b--) bits[nbits++] = (copies[chosen][i] >> b) & 1;
  }
  memset(fmt, 0, sizeof(*fmt));
  fmt->mode_id = (bits[0] << 2) | (bits[1] << 1) | bits[2];
  fmt->ecc_index = (bits[3] << 1) | bits[4];
  strcpy(fmt->palette_mode, "maxmin");
  if (layout->blocks == 1) return 1;
  fmt->seed = layout->blocks == 2 ? (bits[8] << 1) | bits[9] : 0;
  if (layout->blocks >= 3) {
    fmt->seed = 0;
    for (int i = 0; i < 6; i++) fmt->seed = (fmt->seed << 1) | bits[8 + i];
  }
  const int palette_bits = (bits[6] << 1) | bits[7];
  if (fmt->mode_id == 7) {
    fmt->shape_layer_id = palette_bits;
    fmt->shape_ext = bits[5] ? 1 : 0;
    fmt->constraint = 0;
  } else {
    fmt->shape_layer_id = -1;
    fmt->harmony = palette_bits == 1;
    if (fmt->harmony) strcpy(fmt->palette_mode, "harmony");
    fmt->constraint = bits[5] ? 1 : 0;
  }
  return 1;
}

static const char *layer_name_of(const FormatInfo *fmt) {
  if (fmt->mode_id == 7) {
    if (fmt->shape_ext) {
      if (fmt->shape_layer_id == 0) return "L3u";
      if (fmt->shape_layer_id == 1) return "L4eS";
      if (fmt->shape_layer_id == 2) return "L4fS";
      if (fmt->shape_layer_id == 3) return "L3t";
      return NULL;
    }
    if (fmt->shape_layer_id == 0) return "L3b";
    if (fmt->shape_layer_id == 1) return "L1s";
    if (fmt->shape_layer_id == 2) return "L2s";
    if (fmt->shape_layer_id == 3) return "L3s";
    return NULL;
  }
  const char *names[] = { "L1", "L2a", "L2b", "L3c", "L3d", "L4e", "L4f" };
  if (fmt->mode_id < 0 || fmt->mode_id > 6) return NULL;
  return names[fmt->mode_id];
}

typedef struct {
  int chromatic;
  int per_channel;
  int nfit;
  double black[4];
  double white[4];
  double black_ch[3][4];
  double white_ch[3][4];
} Illum;

static int fit_field(const double *row, const double *col, const double *value, int n, double model[4], int *ncoef) {
  if (n >= 4) {
    double A[16];
    double b[4];
    for (int i = 0; i < 4; i++) {
      A[i * 4 + 0] = 1;
      A[i * 4 + 1] = row[i];
      A[i * 4 + 2] = col[i];
      A[i * 4 + 3] = row[i] * col[i];
      b[i] = value[i];
    }
    if (!lcc_solve(A, b, 4, model)) return 0;
    *ncoef = 4;
    return 1;
  }
  if (n >= 3) {
    double A[9];
    double b[3];
    for (int i = 0; i < 3; i++) {
      A[i * 3 + 0] = 1;
      A[i * 3 + 1] = row[i];
      A[i * 3 + 2] = col[i];
      b[i] = value[i];
    }
    if (!lcc_solve(A, b, 3, model)) return 0;
    model[3] = 0;
    *ncoef = 3;
    return 1;
  }
  return 0;
}

static double eval_field(const double model[4], int ncoef, double row, double col) {
  if (ncoef >= 4) return model[0] + model[1] * row + model[2] * col + model[3] * row * col;
  return model[0] + model[1] * row + model[2] * col;
}

static void sort_ints(int *v, int n) {
  for (int i = 1; i < n; i++) {
    const int key = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > key) {
      v[j + 1] = v[j];
      j--;
    }
    v[j + 1] = key;
  }
}

static void sample_inset(const LccImage *image, const LccFound *found, double row, double col, int rgb[3]) {
  int samples[9][3];
  const double off[3] = { -0.2, 0.0, 0.2 };
  int n = 0;
  for (int iy = 0; iy < 3; iy++) {
    for (int ix = 0; ix < 3; ix++) {
      double x, y;
      point_at(found, row + off[iy], col + off[ix], &x, &y);
      lcc_sample_bilinear(image, x, y, samples[n]);
      n++;
    }
  }
  for (int c = 0; c < 3; c++) {
    int vals[9];
    for (int i = 0; i < 9; i++) vals[i] = samples[i][c];
    sort_ints(vals, 9);
    rgb[c] = vals[4];
  }
}

static void build_illum(const LccImage *image, const LccFound *found, const LccLayout *layout, Illum *illum) {
  memset(illum, 0, sizeof(*illum));
  const int N = layout->N;
  double rows[4], cols[4];
  double black[4], white[4];
  double black_ch[3][4], white_ch[3][4];
  int n = 0;
  const int origins[4][2] = { { 0, 0 }, { 0, N - 7 }, { N - 7, 0 }, { N - 4, N - 4 } };
  const int nloc = layout->has_alignment ? 4 : 3;
  for (int i = 0; i < nloc; i++) {
    const int r0 = origins[i][0];
    const int c0 = origins[i][1];
    int black_rc[5][2];
    int white_rc[4][2];
    int nb, nw;
    if (i < 3) {
      const int bsrc[5][2] = { { r0 + 3, c0 + 3 }, { r0, c0 + 3 }, { r0 + 6, c0 + 3 }, { r0 + 3, c0 }, { r0 + 3, c0 + 6 } };
      const int wsrc[4][2] = { { r0 + 1, c0 + 3 }, { r0 + 5, c0 + 3 }, { r0 + 3, c0 + 1 }, { r0 + 3, c0 + 5 } };
      memcpy(black_rc, bsrc, sizeof(bsrc));
      memcpy(white_rc, wsrc, sizeof(wsrc));
      nb = 5;
      nw = 4;
      rows[n] = r0 + 3;
      cols[n] = c0 + 3;
    } else {
      const int bsrc[5][2] = { { r0, c0 }, { r0 - 2, c0 }, { r0 + 2, c0 }, { r0, c0 - 2 }, { r0, c0 + 2 } };
      const int wsrc[4][2] = { { r0 - 1, c0 }, { r0 + 1, c0 }, { r0, c0 - 1 }, { r0, c0 + 1 } };
      memcpy(black_rc, bsrc, sizeof(bsrc));
      memcpy(white_rc, wsrc, sizeof(wsrc));
      nb = 5;
      nw = 4;
      rows[n] = r0;
      cols[n] = c0;
    }
    double br = 0, bg = 0, bb = 0, wr = 0, wg = 0, wb = 0;
    for (int k = 0; k < nb; k++) {
      int rgb[3];
      sample_inset(image, found, black_rc[k][0], black_rc[k][1], rgb);
      br += rgb[0];
      bg += rgb[1];
      bb += rgb[2];
    }
    for (int k = 0; k < nw; k++) {
      int rgb[3];
      sample_inset(image, found, white_rc[k][0], white_rc[k][1], rgb);
      wr += rgb[0];
      wg += rgb[1];
      wb += rgb[2];
    }
    br /= nb;
    bg /= nb;
    bb /= nb;
    wr /= nw;
    wg /= nw;
    wb /= nw;
    black_ch[0][n] = br;
    black_ch[1][n] = bg;
    black_ch[2][n] = bb;
    white_ch[0][n] = wr;
    white_ch[1][n] = wg;
    white_ch[2][n] = wb;
    black[n] = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
    white[n] = 0.2126 * wr + 0.7152 * wg + 0.0722 * wb;
    n++;
  }
  const double mean_w[3] = {
    (white_ch[0][0] + white_ch[0][1] + white_ch[0][2] + (n > 3 ? white_ch[0][3] : 0)) / n,
    (white_ch[1][0] + white_ch[1][1] + white_ch[1][2] + (n > 3 ? white_ch[1][3] : 0)) / n,
    (white_ch[2][0] + white_ch[2][1] + white_ch[2][2] + (n > 3 ? white_ch[2][3] : 0)) / n,
  };
  double spread = mean_w[0];
  double mn = mean_w[0];
  for (int c = 1; c < 3; c++) {
    if (mean_w[c] > spread) spread = mean_w[c];
    if (mean_w[c] < mn) mn = mean_w[c];
  }
  spread -= mn;
  int ncoef = 0;
  if (!fit_field(rows, cols, black, n, illum->black, &ncoef)) ncoef = 0;
  int ncoef_w = 0;
  if (!fit_field(rows, cols, white, n, illum->white, &ncoef_w)) ncoef_w = 0;
  illum->nfit = ncoef < ncoef_w ? ncoef : ncoef_w;
  int ok = 1;
  int channel_fit = 0;
  for (int ch = 0; ch < 3; ch++) {
    int nb = 0, nw = 0;
    if (!fit_field(rows, cols, black_ch[ch], n, illum->black_ch[ch], &nb)) ok = 0;
    if (!fit_field(rows, cols, white_ch[ch], n, illum->white_ch[ch], &nw)) ok = 0;
    if (ch == 0) channel_fit = nb < nw ? nb : nw;
  }
  illum->per_channel = ok && channel_fit >= 3;
  if (illum->per_channel) illum->nfit = channel_fit;
  illum->chromatic = spread > 12 && illum->per_channel;
}

static int clamp_byte(int v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

static void normalize_rgb(const Illum *illum, const int rgb[3], int row, int col, int out[3]) {
  if (!illum->per_channel || illum->nfit < 3) {
    const double b = illum->nfit >= 3 ? eval_field(illum->black, illum->nfit, row, col) : 0;
    const double w = illum->nfit >= 3 ? eval_field(illum->white, illum->nfit, row, col) : 255;
    const double range = (w - b) > 20 ? (w - b) : 20;
    const double scale = 255.0 / range;
    const double offset = -b * scale;
    for (int c = 0; c < 3; c++) out[c] = clamp_byte((int)lcc_js_round(rgb[c] * scale + offset));
    return;
  }
  for (int c = 0; c < 3; c++) {
    const double b = eval_field(illum->black_ch[c], illum->nfit, row, col);
    const double w = eval_field(illum->white_ch[c], illum->nfit, row, col);
    const double range = (w - b) > 20 ? (w - b) : 20;
    out[c] = clamp_byte((int)lcc_js_round(((rgb[c] - b) * 255.0) / range));
  }
}

typedef struct {
  int type;
  double levels[16];
  int nlevels;
  double measured_l[16];
  double nominal_l[16];
  int nsamples;
  double matrix[3][4];
} Calibrator;

static int argmin(const double *costs, int n) {
  int best = 0;
  double best_d = INFINITY;
  for (int i = 0; i < n; i++) {
    if (costs[i] < best_d) {
      best_d = costs[i];
      best = i;
    }
  }
  return best;
}

static void build_calibrator(const LccPaletteInfo *palette, const LccLayout *layout, const LccImage *image, const LccFound *found, const Illum *illum, Calibrator *cal) {
  memset(cal, 0, sizeof(*cal));
  if (strcmp(palette->name, "L1") == 0) {
    cal->type = LCC_CAL_THRESHOLD;
    return;
  }
  if (palette->kind == 0) {
    cal->type = LCC_CAL_GRAY;
    cal->nlevels = palette->palette_size;
    for (int i = 0; i < palette->palette_size; i++) {
      int rgb[3] = { palette->rgb[i * 3], palette->rgb[i * 3 + 1], palette->rgb[i * 3 + 2] };
      double lab[3];
      lcc_rgb_to_lab(rgb, lab);
      cal->levels[i] = lab[0];
    }
    cal->nsamples = layout->gray_count;
    for (int i = 0; i < layout->gray_count; i++) {
      int raw[3], rgb[3];
      raw_sample(image, found, layout->gray_row[i], layout->gray_col[i], raw);
      normalize_rgb(illum, raw, layout->gray_row[i], layout->gray_col[i], rgb);
      double lab[3], nominal[3];
      lcc_rgb_to_lab(rgb, lab);
      int nom[3] = { layout->gray_rgb[i][0], layout->gray_rgb[i][1], layout->gray_rgb[i][2] };
      lcc_rgb_to_lab(nom, nominal);
      cal->measured_l[i] = lab[0];
      cal->nominal_l[i] = nominal[0];
    }
    for (int i = 1; i < cal->nsamples; i++) {
      double m = cal->measured_l[i];
      double nom = cal->nominal_l[i];
      int j = i - 1;
      while (j >= 0 && cal->measured_l[j] > m) {
        cal->measured_l[j + 1] = cal->measured_l[j];
        cal->nominal_l[j + 1] = cal->nominal_l[j];
        j--;
      }
      cal->measured_l[j + 1] = m;
      cal->nominal_l[j + 1] = nom;
    }
    return;
  }
  cal->type = LCC_CAL_IDENTITY_CLEAN;
  for (int c = 0; c < 3; c++) cal->matrix[c][c] = 1;
  if (layout->palette_count < 1) return;
  double sum_de = 0;
  for (int i = 0; i < layout->palette_count; i++) {
    int raw[3], rgb[3];
    raw_sample(image, found, layout->pal_row[i], layout->pal_col[i], raw);
    normalize_rgb(illum, raw, layout->pal_row[i], layout->pal_col[i], rgb);
    double lab_m[3], lab_n[3];
    int nom[3] = { layout->pal_rgb[i][0], layout->pal_rgb[i][1], layout->pal_rgb[i][2] };
    lcc_rgb_to_lab(rgb, lab_m);
    lcc_rgb_to_lab(nom, lab_n);
    sum_de += lcc_delta_e(lab_m, lab_n);
  }
  const double avg = sum_de / layout->palette_count;
  if (avg < 2.5 || layout->palette_count < 4) return;
  int ok = 1;
  for (int ch = 0; ch < 3; ch++) {
    double ata[16];
    double aty[4];
    memset(ata, 0, sizeof(ata));
    memset(aty, 0, sizeof(aty));
    for (int i = 0; i < layout->palette_count; i++) {
      int raw[3], rgb[3];
      raw_sample(image, found, layout->pal_row[i], layout->pal_col[i], raw);
      normalize_rgb(illum, raw, layout->pal_row[i], layout->pal_col[i], rgb);
      const double rowv[4] = { rgb[0], rgb[1], rgb[2], 1 };
      for (int a = 0; a < 4; a++) {
        for (int b = 0; b < 4; b++) ata[a * 4 + b] += rowv[a] * rowv[b];
        aty[a] += rowv[a] * layout->pal_rgb[i][ch];
      }
    }
    for (int a = 0; a < 4; a++) ata[a * 4 + a] += 1e-6;
    if (!lcc_solve(ata, aty, 4, cal->matrix[ch])) ok = 0;
  }
  if (!ok) {
    memset(cal->matrix, 0, sizeof(cal->matrix));
    for (int c = 0; c < 3; c++) cal->matrix[c][c] = 1;
    cal->type = LCC_CAL_IDENTITY;
  } else {
    cal->type = LCC_CAL_AFFINE;
  }
}

static double map_l(const Calibrator *cal, double measured) {
  if (cal->nsamples <= 0) return measured;
  if (measured <= cal->measured_l[0]) return cal->nominal_l[0];
  if (measured >= cal->measured_l[cal->nsamples - 1]) return cal->nominal_l[cal->nsamples - 1];
  for (int i = 1; i < cal->nsamples; i++) {
    if (measured <= cal->measured_l[i]) {
      const double span = cal->measured_l[i] - cal->measured_l[i - 1];
      const double t = span == 0 ? 0 : (measured - cal->measured_l[i - 1]) / span;
      return cal->nominal_l[i - 1] + t * (cal->nominal_l[i] - cal->nominal_l[i - 1]);
    }
  }
  return measured;
}

static int classify_color(const Calibrator *cal, const LccPaletteInfo *palette, const int rgb[3], double threshold) {
  if (cal->type == LCC_CAL_THRESHOLD) {
    const double d = lcc_luminance(rgb) - threshold;
    const double c0 = d > 0 ? d * d : 0;
    const double c1 = d < 0 ? d * d : 0;
    return c0 <= c1 ? 0 : 1;
  }
  if (palette->kind == 0) {
    double lab[3];
    lcc_rgb_to_lab(rgb, lab);
    const double L = map_l(cal, lab[0]);
    int best = 0;
    double best_d = INFINITY;
    for (int i = 0; i < cal->nlevels; i++) {
      const double d = (L - cal->levels[i]) * (L - cal->levels[i]);
      if (d < best_d) {
        best_d = d;
        best = i;
      }
    }
    return best;
  }
  int corrected[3];
  for (int ch = 0; ch < 3; ch++) {
    const double *row = cal->matrix[ch];
    corrected[ch] = clamp_byte((int)lcc_js_round(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2] + row[3]));
  }
  double lab[3];
  lcc_rgb_to_lab(corrected, lab);
  int best = 0;
  double best_d = INFINITY;
  for (int i = 0; i < palette->palette_size; i++) {
    const double dl = lab[0] - palette->lab[i * 3];
    const double da = lab[1] - palette->lab[i * 3 + 1];
    const double db = lab[2] - palette->lab[i * 3 + 2];
    const double d = dl * dl + da * da + db * db;
    if (d < best_d) {
      best_d = d;
      best = i;
    }
  }
  (void)argmin;
  return best;
}

static int median_channel(int *values, int n) {
  for (int i = 1; i < n; i++) {
    int key = values[i];
    int j = i - 1;
    while (j >= 0 && values[j] > key) {
      values[j + 1] = values[j];
      j--;
    }
    values[j + 1] = key;
  }
  return values[n / 2];
}

static void median_rgb(const int *grid, const int *indices, int nidx, int out[3]) {
  if (nidx <= 0) {
    out[0] = out[1] = out[2] = 255;
    return;
  }
  int vals[256];
  for (int ch = 0; ch < 3; ch++) {
    for (int i = 0; i < nidx; i++) vals[i] = grid[indices[i] * 3 + ch];
    out[ch] = median_channel(vals, nidx);
  }
}

static double dist_seg(double px, double py, double x1, double y1, double x2, double y2) {
  const double dx = x2 - x1;
  const double dy = y2 - y1;
  const double len2 = dx * dx + dy * dy;
  if (len2 == 0) return hypot(px - x1, py - y1);
  double t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

static void shape_mask(int shape, int size, int line, int inset, uint8_t *mask) {
  memset(mask, 0, (size_t)size * size);
  if (shape <= 0) return;
  const double lo = inset;
  const double hi = size - inset;
  const double mid = size / 2.0;
  const double square = inset > (int)lcc_js_round(size / 4.0) ? inset : (int)lcc_js_round(size / 4.0);
  const double slo = square;
  const double shi = size - square;
  const double head = (inset * 2.0) > (size / 6.0) ? (inset * 2.0) : (size / 6.0);
  const double gap = (size * 0.08) > inset ? (size * 0.08) : inset;
  double segs[4][4];
  int nseg = 0;
  double rects[4][4];
  int nrect = 0;
  if (shape == 1) {
    segs[0][0] = lo; segs[0][1] = hi; segs[0][2] = hi; segs[0][3] = lo; nseg = 1;
  } else if (shape == 2) {
    segs[0][0] = lo; segs[0][1] = lo; segs[0][2] = hi; segs[0][3] = hi; nseg = 1;
  } else if (shape == 3) {
    segs[0][0] = lo; segs[0][1] = hi; segs[0][2] = hi; segs[0][3] = lo;
    segs[1][0] = lo; segs[1][1] = lo; segs[1][2] = hi; segs[1][3] = hi; nseg = 2;
  } else if (shape == 4) {
    segs[0][0] = lo; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = mid;
    segs[1][0] = mid; segs[1][1] = lo; segs[1][2] = mid; segs[1][3] = hi; nseg = 2;
  } else if (shape == 5) {
    segs[0][0] = lo; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = mid; nseg = 1;
  } else if (shape == 6) {
    segs[0][0] = mid; segs[0][1] = lo; segs[0][2] = mid; segs[0][3] = hi; nseg = 1;
  } else if (shape == 7) {
    segs[0][0] = slo; segs[0][1] = slo; segs[0][2] = shi; segs[0][3] = slo;
    segs[1][0] = shi; segs[1][1] = slo; segs[1][2] = shi; segs[1][3] = shi;
    segs[2][0] = shi; segs[2][1] = shi; segs[2][2] = slo; segs[2][3] = shi;
    segs[3][0] = slo; segs[3][1] = shi; segs[3][2] = slo; segs[3][3] = slo;
    nseg = 4;
  } else if (shape == 8) {
    segs[0][0] = lo; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = lo;
    segs[1][0] = lo; segs[1][1] = mid; segs[1][2] = hi; segs[1][3] = hi; nseg = 2;
  } else if (shape == 9) {
    segs[0][0] = hi; segs[0][1] = mid; segs[0][2] = lo; segs[0][3] = lo;
    segs[1][0] = hi; segs[1][1] = mid; segs[1][2] = lo; segs[1][3] = hi; nseg = 2;
  } else if (shape == 10) {
    segs[0][0] = mid; segs[0][1] = hi; segs[0][2] = lo; segs[0][3] = lo;
    segs[1][0] = mid; segs[1][1] = hi; segs[1][2] = hi; segs[1][3] = lo; nseg = 2;
  } else if (shape == 11) {
    segs[0][0] = mid; segs[0][1] = lo; segs[0][2] = lo; segs[0][3] = hi;
    segs[1][0] = mid; segs[1][1] = lo; segs[1][2] = hi; segs[1][3] = hi; nseg = 2;
  } else if (shape == 12) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = lo; segs[0][3] = mid;
    segs[1][0] = lo; segs[1][1] = mid; segs[1][2] = lo + head; segs[1][3] = mid - head;
    segs[2][0] = lo; segs[2][1] = mid; segs[2][2] = lo + head; segs[2][3] = mid + head; nseg = 3;
  } else if (shape == 13) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = mid; segs[0][3] = lo;
    segs[1][0] = mid; segs[1][1] = lo; segs[1][2] = mid - head; segs[1][3] = lo + head;
    segs[2][0] = mid; segs[2][1] = lo; segs[2][2] = mid + head; segs[2][3] = lo + head; nseg = 3;
  } else if (shape == 14) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = mid;
    segs[1][0] = hi; segs[1][1] = mid; segs[1][2] = hi - head; segs[1][3] = mid - head;
    segs[2][0] = hi; segs[2][1] = mid; segs[2][2] = hi - head; segs[2][3] = mid + head; nseg = 3;
  } else if (shape == 15) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = mid; segs[0][3] = hi;
    segs[1][0] = mid; segs[1][1] = hi; segs[1][2] = mid - head; segs[1][3] = hi - head;
    segs[2][0] = mid; segs[2][1] = hi; segs[2][2] = mid + head; segs[2][3] = hi - head; nseg = 3;
  } else if (shape == 16) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = lo; segs[0][3] = lo;
    segs[1][0] = lo; segs[1][1] = lo; segs[1][2] = lo + head; segs[1][3] = lo;
    segs[2][0] = lo; segs[2][1] = lo; segs[2][2] = lo; segs[2][3] = lo + head; nseg = 3;
  } else if (shape == 17) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = lo;
    segs[1][0] = hi; segs[1][1] = lo; segs[1][2] = hi - head; segs[1][3] = lo;
    segs[2][0] = hi; segs[2][1] = lo; segs[2][2] = hi; segs[2][3] = lo + head; nseg = 3;
  } else if (shape == 18) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = hi;
    segs[1][0] = hi; segs[1][1] = hi; segs[1][2] = hi - head; segs[1][3] = hi;
    segs[2][0] = hi; segs[2][1] = hi; segs[2][2] = hi; segs[2][3] = hi - head; nseg = 3;
  } else if (shape == 19) {
    segs[0][0] = mid; segs[0][1] = mid; segs[0][2] = lo; segs[0][3] = hi;
    segs[1][0] = lo; segs[1][1] = hi; segs[1][2] = lo + head; segs[1][3] = hi;
    segs[2][0] = lo; segs[2][1] = hi; segs[2][2] = lo; segs[2][3] = hi - head; nseg = 3;
  } else if (shape == 20) {
    rects[0][0] = lo; rects[0][1] = lo; rects[0][2] = mid - gap; rects[0][3] = mid - gap; nrect = 1;
  } else if (shape == 21) {
    rects[0][0] = mid + gap; rects[0][1] = lo; rects[0][2] = hi; rects[0][3] = mid - gap; nrect = 1;
  } else if (shape == 22) {
    rects[0][0] = lo; rects[0][1] = mid + gap; rects[0][2] = mid - gap; rects[0][3] = hi; nrect = 1;
  } else if (shape == 23) {
    rects[0][0] = mid + gap; rects[0][1] = mid + gap; rects[0][2] = hi; rects[0][3] = hi; nrect = 1;
  } else if (shape == 24) {
    segs[0][0] = lo; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = mid;
    segs[1][0] = mid; segs[1][1] = mid; segs[1][2] = mid; segs[1][3] = hi; nseg = 2;
  } else if (shape == 25) {
    segs[0][0] = mid; segs[0][1] = lo; segs[0][2] = mid; segs[0][3] = hi;
    segs[1][0] = mid; segs[1][1] = mid; segs[1][2] = hi; segs[1][3] = mid; nseg = 2;
  } else if (shape == 26) {
    segs[0][0] = mid; segs[0][1] = lo; segs[0][2] = mid; segs[0][3] = hi;
    segs[1][0] = lo; segs[1][1] = mid; segs[1][2] = mid; segs[1][3] = mid; nseg = 2;
  } else if (shape == 27) {
    segs[0][0] = lo; segs[0][1] = mid; segs[0][2] = hi; segs[0][3] = mid;
    segs[1][0] = mid; segs[1][1] = lo; segs[1][2] = mid; segs[1][3] = mid; nseg = 2;
  } else if (shape == 28) {
    segs[0][0] = lo; segs[0][1] = hi; segs[0][2] = hi; segs[0][3] = lo;
    segs[1][0] = mid; segs[1][1] = mid; segs[1][2] = lo; segs[1][3] = lo; nseg = 2;
  } else if (shape == 29) {
    segs[0][0] = lo; segs[0][1] = hi; segs[0][2] = hi; segs[0][3] = lo;
    segs[1][0] = mid; segs[1][1] = mid; segs[1][2] = hi; segs[1][3] = hi; nseg = 2;
  } else if (shape == 30) {
    segs[0][0] = lo; segs[0][1] = lo; segs[0][2] = hi; segs[0][3] = hi;
    segs[1][0] = mid; segs[1][1] = mid; segs[1][2] = hi; segs[1][3] = lo; nseg = 2;
  } else if (shape == 31) {
    segs[0][0] = lo; segs[0][1] = lo; segs[0][2] = hi; segs[0][3] = hi;
    segs[1][0] = mid; segs[1][1] = mid; segs[1][2] = lo; segs[1][3] = hi; nseg = 2;
  }
  const double half = line / 2.0 > 0.5 ? line / 2.0 : 0.5;
  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) {
      const double px = x + 0.5;
      const double py = y + 0.5;
      int on = 0;
      for (int r = 0; r < nrect; r++) {
        if (px >= rects[r][0] && px <= rects[r][2] && py >= rects[r][1] && py <= rects[r][3]) {
          on = 1;
          break;
        }
      }
      if (!on) {
        for (int s = 0; s < nseg; s++) {
          if (dist_seg(px, py, segs[s][0], segs[s][1], segs[s][2], segs[s][3]) <= half) {
            on = 1;
            break;
          }
        }
      }
      mask[y * size + x] = (uint8_t)on;
    }
  }
}

static int hamming_shift(const uint8_t *mask, const uint8_t *templ, int n, int dx, int dy) {
  int d = 0;
  for (int y = 0; y < n; y++) {
    const int ty = y + dy;
    for (int x = 0; x < n; x++) {
      const int tx = x + dx;
      const int t = tx >= 0 && tx < n && ty >= 0 && ty < n ? templ[ty * n + tx] : 0;
      if (mask[y * n + x] != t) d++;
    }
  }
  return d;
}

static int classify_shape(const uint8_t *mask, int grid, int line, int inset) {
  int coverage = 0;
  for (int i = 0; i < grid * grid; i++) coverage += mask[i];
  int best = 0;
  int best_cost = 1 << 30;
  uint8_t *templ = lcc_alloc((size_t)grid * grid);
  for (int shape = 0; shape < 8; shape++) {
    shape_mask(shape, grid, line, inset, templ);
    int d = 1 << 30;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        const int cand = hamming_shift(mask, templ, grid, dx, dy);
        if (cand < d) d = cand;
      }
    }
    if (d < best_cost) {
      best_cost = d;
      best = shape;
    }
  }
  lcc_release(templ);
  if (grid > 0 && (double)coverage / (grid * grid) < 0.02) best = 0;
  return best;
}

static void refine_background(const int *grid, int shape, int grid_n, int line, int inset, int out[3]) {
  const int n = grid_n * grid_n;
  int *all = lcc_alloc((size_t)n * sizeof(int));
  for (int i = 0; i < n; i++) all[i] = i;
  if (shape <= 0) {
    median_rgb(grid, all, n, out);
    lcc_release(all);
    return;
  }
  uint8_t *templ = lcc_alloc((size_t)n);
  uint8_t *dilated = lcc_alloc((size_t)n);
  shape_mask(shape, grid_n, line, inset, templ);
  for (int y = 0; y < grid_n; y++) {
    for (int x = 0; x < grid_n; x++) {
      if (!templ[y * grid_n + x]) continue;
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          const int yy = y + dy;
          const int xx = x + dx;
          if (yy >= 0 && yy < grid_n && xx >= 0 && xx < grid_n) dilated[yy * grid_n + xx] = 1;
        }
      }
    }
  }
  int *idx = lcc_alloc((size_t)n * sizeof(int));
  int nidx = 0;
  for (int i = 0; i < n; i++) if (!dilated[i]) idx[nidx++] = i;
  if (nidx < n * 0.15) median_rgb(grid, all, n, out);
  else median_rgb(grid, idx, nidx, out);
  lcc_release(all);
  lcc_release(templ);
  lcc_release(dilated);
  lcc_release(idx);
}

static void background_majority(const int *grid, int count, int out[3]) {
  double levels[256];
  int bins[32];
  memset(bins, 0, sizeof(bins));
  for (int i = 0; i < count; i++) {
    int rgb[3] = { grid[i * 3], grid[i * 3 + 1], grid[i * 3 + 2] };
    levels[i] = lcc_luminance(rgb);
    int bin = (int)(levels[i] / 8.0);
    if (bin < 0) bin = 0;
    if (bin > 31) bin = 31;
    bins[bin]++;
  }
  int mode = 0;
  for (int i = 1; i < 32; i++) if (bins[i] > bins[mode]) mode = i;
  const double center = mode * 8 + 4;
  int idx[256];
  int nidx = 0;
  for (int i = 0; i < count; i++) {
    double d = levels[i] - center;
    if (d < 0) d = -d;
    if (d <= 14) idx[nidx++] = i;
  }
  int all[256];
  for (int i = 0; i < count; i++) all[i] = i;
  if (nidx < count * 0.25) median_rgb(grid, all, count, out);
  else median_rgb(grid, idx, nidx, out);
}

static void sharpen_residual(double *res, int n) {
  double blurred[256];
  for (int y = 0; y < n; y++) {
    for (int x = 0; x < n; x++) {
      double sum = 0;
      int count = 0;
      for (int dy = -1; dy <= 1; dy++) {
        const int yy = y + dy;
        if (yy < 0 || yy >= n) continue;
        for (int dx = -1; dx <= 1; dx++) {
          const int xx = x + dx;
          if (xx < 0 || xx >= n) continue;
          sum += res[yy * n + xx];
          count++;
        }
      }
      blurred[y * n + x] = sum / count;
    }
  }
  for (int i = 0; i < n * n; i++) res[i] += 0.8 * (res[i] - blurred[i]);
}

static double ncc_vec(const double *res, const double *mask, int count) {
  double sum_r = 0;
  double sum_m = 0;
  int i = 0;
#if defined(__wasm_simd128__)
  {
    v128_t sr = wasm_f64x2_splat(0);
    v128_t sm = wasm_f64x2_splat(0);
    for (; i + 2 <= count; i += 2) {
      sr = wasm_f64x2_add(sr, wasm_v128_load(res + i));
      sm = wasm_f64x2_add(sm, wasm_v128_load(mask + i));
    }
    sum_r = wasm_f64x2_extract_lane(sr, 0) + wasm_f64x2_extract_lane(sr, 1);
    sum_m = wasm_f64x2_extract_lane(sm, 0) + wasm_f64x2_extract_lane(sm, 1);
  }
#endif
  for (; i < count; i++) {
    sum_r += res[i];
    sum_m += mask[i];
  }
  const double mean_r = sum_r / count;
  const double mean_m = sum_m / count;
  double num = 0, dr = 0, dm = 0;
  i = 0;
#if defined(__wasm_simd128__)
  {
    const v128_t mr = wasm_f64x2_splat(mean_r);
    const v128_t mm = wasm_f64x2_splat(mean_m);
    v128_t nsum = wasm_f64x2_splat(0);
    v128_t rsum = wasm_f64x2_splat(0);
    v128_t msum = wasm_f64x2_splat(0);
    for (; i + 2 <= count; i += 2) {
      const v128_t ar = wasm_f64x2_sub(wasm_v128_load(res + i), mr);
      const v128_t am = wasm_f64x2_sub(wasm_v128_load(mask + i), mm);
      nsum = wasm_f64x2_add(nsum, wasm_f64x2_mul(ar, am));
      rsum = wasm_f64x2_add(rsum, wasm_f64x2_mul(ar, ar));
      msum = wasm_f64x2_add(msum, wasm_f64x2_mul(am, am));
    }
    num = wasm_f64x2_extract_lane(nsum, 0) + wasm_f64x2_extract_lane(nsum, 1);
    dr = wasm_f64x2_extract_lane(rsum, 0) + wasm_f64x2_extract_lane(rsum, 1);
    dm = wasm_f64x2_extract_lane(msum, 0) + wasm_f64x2_extract_lane(msum, 1);
  }
#endif
  for (; i < count; i++) {
    const double ar = res[i] - mean_r;
    const double am = mask[i] - mean_m;
    num += ar * am;
    dr += ar * ar;
    dm += am * am;
  }
  if (dr < 1e-6 || dm < 1e-6) return 0;
  const double v = num / sqrt(dr * dm);
  return v < 0 ? -v : v;
}

static void resample_double(const double *src, int n, int dn, double *dst) {
  const double scale = (double)n / (double)dn;
  for (int y = 0; y < dn; y++) {
    double fy = ((double)y + 0.5) * scale - 0.5;
    if (fy < 0) fy = 0;
    if (fy > n - 1) fy = n - 1;
    const int y0 = (int)floor(fy);
    const int y1 = y0 + 1 < n ? y0 + 1 : y0;
    const double ty = fy - y0;
    for (int x = 0; x < dn; x++) {
      double fx = ((double)x + 0.5) * scale - 0.5;
      if (fx < 0) fx = 0;
      if (fx > n - 1) fx = n - 1;
      const int x0 = (int)floor(fx);
      const int x1 = x0 + 1 < n ? x0 + 1 : x0;
      const double tx = fx - x0;
      const double a = src[y0 * n + x0];
      const double b = src[y0 * n + x1];
      const double c = src[y1 * n + x0];
      const double d = src[y1 * n + x1];
      dst[y * dn + x] = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    }
  }
}

static void normalize_double(double *v, int n);

#define LCC_DEBUG_MAX 8192
static int g_dbg_capture = 0;
static int g_dbg_count = 0;
static int *g_dbg_row = NULL;
static int *g_dbg_col = NULL;
static int *g_dbg_grid = NULL;
static int *g_dbg_shape = NULL;
static float *g_dbg_res = NULL;

void lcc_debug_reset(void) {
  if (!g_dbg_res) {
    g_dbg_row = lcc_alloc((size_t)LCC_DEBUG_MAX * sizeof(int));
    g_dbg_col = lcc_alloc((size_t)LCC_DEBUG_MAX * sizeof(int));
    g_dbg_grid = lcc_alloc((size_t)LCC_DEBUG_MAX * sizeof(int));
    g_dbg_shape = lcc_alloc((size_t)LCC_DEBUG_MAX * sizeof(int));
    g_dbg_res = lcc_alloc((size_t)LCC_DEBUG_MAX * 256 * sizeof(float));
  }
  g_dbg_count = 0;
  g_dbg_capture = g_dbg_res && g_dbg_row && g_dbg_col && g_dbg_grid && g_dbg_shape;
}

void lcc_debug_stop(void) {
  g_dbg_capture = 0;
}

int lcc_debug_count(void) {
  return g_dbg_count;
}

int lcc_debug_get(int index, int *row, int *col, int *grid_n, int *shape, float *res) {
  if (index < 0 || index >= g_dbg_count) return 0;
  if (row) *row = g_dbg_row[index];
  if (col) *col = g_dbg_col[index];
  if (grid_n) *grid_n = g_dbg_grid[index];
  if (shape) *shape = g_dbg_shape[index];
  if (res) memcpy(res, g_dbg_res + (size_t)index * 256, 256 * sizeof(float));
  return 1;
}

static void make_model_input(const double *res, int grid_n, double *in16) {
  double border[256];
  int nb = 0;
  for (int x = 0; x < grid_n; x++) {
    border[nb++] = res[x];
    if (grid_n > 1) border[nb++] = res[(grid_n - 1) * grid_n + x];
  }
  for (int y = 1; y + 1 < grid_n; y++) {
    border[nb++] = res[y * grid_n];
    border[nb++] = res[y * grid_n + grid_n - 1];
  }
  for (int i = 1; i < nb; i++) {
    const double key = border[i];
    int j = i - 1;
    while (j >= 0 && border[j] > key) {
      border[j + 1] = border[j];
      j--;
    }
    border[j + 1] = key;
  }
  const double border_level = nb > 0 ? border[nb / 2] : 0;
  double res_sr[256];
  for (int i = 0; i < grid_n * grid_n; i++) res_sr[i] = res[i] - border_level;
  resample_double(res_sr, grid_n, 16, in16);
  normalize_double(in16, 256);
}

static void normalize_double(double *v, int n) {
  double mean = 0;
  for (int i = 0; i < n; i++) mean += v[i];
  mean /= n;
  double var = 0;
  for (int i = 0; i < n; i++) {
    const double d = v[i] - mean;
    var += d * d;
  }
  const double std = sqrt(var / n);
  if (std < 1e-6) {
    for (int i = 0; i < n; i++) v[i] = 0;
    return;
  }
  for (int i = 0; i < n; i++) v[i] = (v[i] - mean) / std;
}

static int match_shape(
  const int *grid,
  int grid_n,
  const double *planes,
  int stride,
  int sharpen,
  int background[3],
  const double *planes_model,
  int model_stride,
  int shape_set,
  int module_row,
  int module_col
) {
  const int count = grid_n * grid_n;
  background_majority(grid, count, background);
  int bg_rgb[3] = { background[0], background[1], background[2] };
  const double bg_l = lcc_luminance(bg_rgb);
  double res[256] __attribute__((aligned(16)));
  for (int i = 0; i < count; i++) {
    int rgb[3] = { grid[i * 3], grid[i * 3 + 1], grid[i * 3 + 2] };
    res[i] = lcc_luminance(rgb) - bg_l;
  }

  double in16[256];
  if (shape_set <= 8 || g_dbg_capture) make_model_input(res, grid_n, in16);

  int dbg_slot = -1;
  if (g_dbg_capture && g_dbg_count < LCC_DEBUG_MAX) {
    dbg_slot = g_dbg_count++;
    g_dbg_row[dbg_slot] = module_row;
    g_dbg_col[dbg_slot] = module_col;
    g_dbg_grid[dbg_slot] = grid_n;
    g_dbg_shape[dbg_slot] = -1;
    for (int i = 0; i < 256; i++) g_dbg_res[(size_t)dbg_slot * 256 + i] = (float)in16[i];
  }

  if (shape_set <= 8 && planes_model) {
    // Cheap 16x16 template gate: skip the network when the correlation is
    // strong and unambiguous.
    if (planes_model) {
      int cheap = 0;
      double b1 = 0;
      double b2 = 0;
      for (int s = 1; s < 8; s++) {
        const double *base = planes_model + (size_t)(s - 1) * 9 * (size_t)model_stride;
        const double score = fabs(ncc_vec(in16, base + 4 * (size_t)model_stride, 256));
        if (score > b1) {
          b2 = b1;
          b1 = score;
          cheap = s;
        } else if (score > b2) {
          b2 = score;
        }
      }
      if (b1 < 0.32) cheap = 0;
      if (b1 >= 0.55 && b1 - b2 >= 0.10) {
        if (dbg_slot >= 0) g_dbg_shape[dbg_slot] = cheap;
        return cheap;
      }
    }
    float x[256];
    float logits[8];
    for (int i = 0; i < 256; i++) x[i] = (float)in16[i];
    lcc_shape_forward(x, logits);
    int shape = 0;
    for (int k = 1; k < 8; k++) {
      if (logits[k] > logits[shape]) shape = k;
    }
    if (dbg_slot >= 0) g_dbg_shape[dbg_slot] = shape;
    return shape;
  }

  // 32-shape digital/print layers use the analytic templates.
  if (sharpen) sharpen_residual(res, grid_n);
  int shape = 0;
  double best = 0;
  for (int s = 1; s < shape_set; s++) {
    const double *base = planes + (size_t)(s - 1) * 9 * (size_t)stride;
    double score = fabs(ncc_vec(res, base + 4 * (size_t)stride, count));
    if (score < 0.72) {
      for (int shift = 0; shift < 9; shift++) {
        if (shift == 4) continue;
        const double candidate = fabs(ncc_vec(res, base + (size_t)shift * (size_t)stride, count));
        if (candidate > score) score = candidate;
      }
    }
    if (score > best) {
      best = score;
      shape = s;
    }
  }
  if (best < 0.32) shape = 0;
  if (dbg_slot >= 0) g_dbg_shape[dbg_slot] = shape;
  return shape;
}

static int cluster_shape(const int *grid, int n, uint8_t *foreground) {
  memset(foreground, 0, (size_t)n);
  if (n <= 0) return 0;
  double (*labs)[3] = lcc_alloc((size_t)n * sizeof(*labs));
  double mean[3] = { 0, 0, 0 };
  for (int i = 0; i < n; i++) {
    int rgb[3] = { grid[i * 3], grid[i * 3 + 1], grid[i * 3 + 2] };
    lcc_rgb_to_lab(rgb, labs[i]);
    mean[0] += labs[i][0];
    mean[1] += labs[i][1];
    mean[2] += labs[i][2];
  }
  mean[0] /= n;
  mean[1] /= n;
  mean[2] /= n;
  int i1 = 0;
  double d1 = -1;
  for (int i = 0; i < n; i++) {
    const double d = lcc_delta_e(labs[i], mean);
    if (d > d1) {
      d1 = d;
      i1 = i;
    }
  }
  int i2 = 0;
  double d2 = -1;
  for (int i = 0; i < n; i++) {
    const double d = lcc_delta_e(labs[i], labs[i1]);
    if (d > d2) {
      d2 = d;
      i2 = i;
    }
  }
  if (d2 < 8) {
    lcc_release(labs);
    return 0;
  }
  double centers[2][3];
  memcpy(centers[0], labs[i1], sizeof(centers[0]));
  memcpy(centers[1], labs[i2], sizeof(centers[1]));
  uint8_t *assign = lcc_alloc((size_t)n);
  for (int iter = 0; iter < 6; iter++) {
    int n0 = 0, n1 = 0;
    double sum0[3] = { 0, 0, 0 };
    double sum1[3] = { 0, 0, 0 };
    for (int i = 0; i < n; i++) {
      const double a = lcc_delta_e(labs[i], centers[0]);
      const double b = lcc_delta_e(labs[i], centers[1]);
      if (a <= b) {
        assign[i] = 0;
        n0++;
        for (int c = 0; c < 3; c++) sum0[c] += labs[i][c];
      } else {
        assign[i] = 1;
        n1++;
        for (int c = 0; c < 3; c++) sum1[c] += labs[i][c];
      }
    }
    if (n0 == 0 || n1 == 0) break;
    for (int c = 0; c < 3; c++) {
      centers[0][c] = sum0[c] / n0;
      centers[1][c] = sum1[c] / n1;
    }
  }
  int n0 = 0, n1 = 0;
  for (int i = 0; i < n; i++) {
    if (assign[i] == 0) n0++;
    else n1++;
  }
  if (n0 == 0 || n1 == 0) {
    lcc_release(assign);
    lcc_release(labs);
    return 0;
  }
  const int bg = n0 >= n1 ? 0 : 1;
  const double separation = lcc_delta_e(centers[0], centers[1]);
  const double fraction = (double)(bg == 0 ? n1 : n0) / n;
  if (fraction < 0.02 || separation < 12) {
    lcc_release(assign);
    lcc_release(labs);
    return 0;
  }
  for (int i = 0; i < n; i++) if (assign[i] != bg) foreground[i] = 1;
  lcc_release(assign);
  lcc_release(labs);
  return 1;
}

typedef struct {
  uint8_t *bytes;
  int len;
  int cap;
  int current;
  int used;
} BitWriter;

static void bw_bit(BitWriter *w, int bit) {
  w->current = (w->current << 1) | (bit & 1);
  w->used++;
  if (w->used == 8) {
    if (w->len >= w->cap) {
      w->cap = w->cap ? w->cap * 2 : 64;
      w->bytes = realloc(w->bytes, (size_t)w->cap);
    }
    w->bytes[w->len++] = (uint8_t)(w->current & 0xff);
    w->current = 0;
    w->used = 0;
  }
}

static void bw_bits(BitWriter *w, int value, int n) {
  for (int i = n - 1; i >= 0; i--) bw_bit(w, (value >> i) & 1);
}

static uint8_t *bw_finish(BitWriter *w, int *len) {
  if (w->used > 0) {
    if (w->len >= w->cap) {
      w->cap = w->cap ? w->cap * 2 : 64;
      w->bytes = realloc(w->bytes, (size_t)w->cap);
    }
    w->bytes[w->len++] = (uint8_t)((w->current << (8 - w->used)) & 0xff);
  }
  *len = w->len;
  return w->bytes;
}

static void whiten(uint8_t *bytes, int len, int seed) {
  uint32_t state = (uint32_t)((uint32_t)seed * 0x9e3779b9u + 0x85ebca6bu);
  if (state == 0) state = 0x1a2b3c4du;
  for (int i = 0; i < len; i++) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    bytes[i] ^= (uint8_t)(state & 0xff);
  }
}

static int parse_payload(const uint8_t *bytes, int len, uint8_t **payload, int *payload_len) {
  if (len < 13) return 0;
  if (bytes[0] != 0x4c || bytes[1] != 0x43 || bytes[2] != 1) return 0;
  const uint32_t plen = ((uint32_t)bytes[5] << 24) | ((uint32_t)bytes[6] << 16) | ((uint32_t)bytes[7] << 8) | bytes[8];
  const uint32_t crc = ((uint32_t)bytes[9] << 24) | ((uint32_t)bytes[10] << 16) | ((uint32_t)bytes[11] << 8) | bytes[12];
  if (plen > (uint32_t)(len - 13)) return 0;
  if (lcc_crc32(bytes + 13, (int)plen) != crc) return 0;
  uint8_t *out = lcc_alloc(plen ? plen : 1);
  if (!out) return 0;
  if (plen) memcpy(out, bytes + 13, plen);
  *payload = out;
  *payload_len = (int)plen;
  return 1;
}

static const double ECCS[4] = { 0.20, 0.30, 0.35, 0.40 };

static void store_rgb(uint8_t *dst, const int rgb[3]) {
  dst[0] = (uint8_t)rgb[0];
  dst[1] = (uint8_t)rgb[1];
  dst[2] = (uint8_t)rgb[2];
}

static void warp_module_row(const LccImage *image, const LccFound *found, int module_row, int step, int n_modules, uint8_t *dst) {
  const int width = n_modules * step;
  for (int ly = 0; ly < step; ly++) {
    const double v = module_row + (ly + 0.5) / (double)step;
    uint8_t *row = dst + (size_t)ly * (size_t)width * 3;
    if (found->has_h) {
      const double u0 = 0.5 / (double)step;
      const double du = 1.0 / (double)step;
      double numx = found->H[0] * u0 + found->H[1] * v + found->H[2];
      double numy = found->H[3] * u0 + found->H[4] * v + found->H[5];
      double den = found->H[6] * u0 + found->H[7] * v + found->H[8];
      const double dnumx = found->H[0] * du;
      const double dnumy = found->H[3] * du;
      const double dden = found->H[6] * du;
      int px = 0;
      for (; px + 1 < width; px += 2) {
        const double den1 = den + dden;
        int a[3] = { 255, 255, 255 };
        int b[3] = { 255, 255, 255 };
        if (fabs(den) >= 1e-12 && fabs(den1) >= 1e-12) {
          lcc_sample_bilinear2(image, numx / den, numy / den, (numx + dnumx) / den1, (numy + dnumy) / den1, a, b);
        }
        store_rgb(row + (size_t)px * 3, a);
        store_rgb(row + (size_t)(px + 1) * 3, b);
        numx += dnumx * 2;
        numy += dnumy * 2;
        den += dden * 2;
      }
      if (px < width) {
        int a[3] = { 255, 255, 255 };
        if (fabs(den) >= 1e-12) lcc_sample_bilinear(image, numx / den, numy / den, a);
        store_rgb(row + (size_t)px * 3, a);
      }
    } else {
      const double du = found->s / (double)step;
      double x = found->origin_x + (0.5 / (double)step) * found->s;
      const double y = found->origin_y + v * found->s;
      int px = 0;
      for (; px + 1 < width; px += 2) {
        int a[3], b[3];
        lcc_sample_bilinear2(image, x, y, x + du, y, a, b);
        store_rgb(row + (size_t)px * 3, a);
        store_rgb(row + (size_t)(px + 1) * 3, b);
        x += du * 2;
      }
      if (px < width) {
        int a[3];
        lcc_sample_bilinear(image, x, y, a);
        store_rgb(row + (size_t)px * 3, a);
      }
    }
  }
}

static int decode_found(
  const LccImage *image,
  const LccVariant *variant,
  const LccFound *found,
  uint8_t **payload,
  int *payload_len,
  LccDecodeMeta *meta
) {
  LccLayout probe;
  const LccPaletteInfo *l1 = lcc_palette("L1", 0);
  if (!l1 || !lcc_make_layout(l1, found->version, &probe)) return LCC_ERR;
  FormatInfo fmt;
  if (!read_format(image, found, variant, &probe, &fmt)) {
    lcc_layout_free(&probe);
    return LCC_ERR;
  }
  lcc_layout_free(&probe);
  if (fmt.constraint) return LCC_UNSUPPORTED;
  const char *name = layer_name_of(&fmt);
  if (!name) return LCC_ERR;
  const LccPaletteInfo *palette = lcc_palette(name, fmt.harmony);
  if (!palette) return LCC_ERR;
  LccLayout layout;
  if (!lcc_make_layout(palette, found->version, &layout)) return LCC_ERR;
  Illum illum;
  build_illum(image, found, &layout, &illum);
  Calibrator cal;
  build_calibrator(palette, &layout, image, found, &illum, &cal);

  const int D = layout.data_count;
  if (meta) {
    meta->version = found->version;
    meta->N = layout.N;
    meta->module_size = found->s;
    meta->data_count = D;
    meta->format_blocks = layout.blocks;
    meta->shape_set = palette->shape_set > 0 ? palette->shape_set : 1;
    strncpy(meta->layer, palette->name, sizeof(meta->layer) - 1);
  }
  int *symbols = lcc_alloc((size_t)D * sizeof(int));
  if (!symbols) {
    lcc_layout_free(&layout);
    return LCC_ERR;
  }
  const int patterns = palette->shape_set > 1;
  const int shape_set = palette->shape_set > 1 ? palette->shape_set : 1;
  int grid_n = 0;
  int line = 0;
  int inset = 0;
  uint8_t *masks[33] = { 0 };
  int *grid = NULL;
  if (patterns) {
    grid_n = (int)lcc_js_round(found->s > 0 ? found->s : 12);
    if (grid_n < 8) grid_n = 8;
    if (grid_n > 16) grid_n = 16;
    const int line_px = (int)lcc_js_round(found->s / 8.0);
    const int inset_px = (int)lcc_js_round(found->s / 16.0);
    line = (int)lcc_js_round((double)(line_px < 1 ? 1 : line_px) * grid_n / found->s);
    inset = (int)lcc_js_round((double)(inset_px < 1 ? 1 : inset_px) * grid_n / found->s);
    if (line < 1) line = 1;
    if (inset < 1) inset = 1;
    for (int s = 1; s < shape_set; s++) {
      masks[s] = lcc_alloc((size_t)grid_n * grid_n);
      shape_mask(s, grid_n, line, inset, masks[s]);
    }
    grid = lcc_alloc((size_t)grid_n * grid_n * 3 * sizeof(int));
  }
  int step = 0;
  int plane_stride = 0;
  double *planes = NULL;
  uint8_t *band = NULL;
  int *order = NULL;
  const int model_n = 16;
  int model_stride = 0;
  double *planes_model = NULL;
  if (patterns) {
    const int count = grid_n * grid_n;
    plane_stride = (count + 1) & ~1;
    step = grid_n * 2;
    planes = lcc_alloc((size_t)(shape_set - 1) * 9 * (size_t)plane_stride * sizeof(double));
    band = lcc_alloc((size_t)step * (size_t)layout.N * (size_t)step * 3);
    order = lcc_alloc((size_t)D * sizeof(int));
    if (!grid || !planes || !band || !order) {
      for (int s = 1; s < shape_set; s++) lcc_release(masks[s]);
      lcc_release(grid);
      lcc_release(planes);
      lcc_release(band);
      lcc_release(order);
      lcc_release(symbols);
      lcc_layout_free(&layout);
      return LCC_ERR;
    }
    for (int s = 1; s < shape_set; s++) {
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          double *dst = planes + (((size_t)(s - 1) * 9 + (size_t)((dy + 1) * 3 + (dx + 1))) * (size_t)plane_stride);
          for (int y = 0; y < grid_n; y++) {
            for (int x = 0; x < grid_n; x++) {
              const int tx = x + dx;
              const int ty = y + dy;
              const double m = tx >= 0 && ty >= 0 && tx < grid_n && ty < grid_n ? masks[s][ty * grid_n + tx] : 0;
              dst[y * grid_n + x] = m;
            }
          }
        }
      }
    }
    if (shape_set <= 8 && found->s >= 12.0) {
      const int model_count = model_n * model_n;
      model_stride = (model_count + 1) & ~1;
      planes_model = lcc_alloc((size_t)7 * 9 * (size_t)model_stride * sizeof(double));
      uint8_t *templ = lcc_alloc((size_t)model_n * model_n);
      if (!planes_model || !templ) {
        lcc_release(planes_model);
        lcc_release(templ);
        for (int s = 1; s < shape_set; s++) lcc_release(masks[s]);
        lcc_release(grid);
        lcc_release(planes);
        lcc_release(band);
        lcc_release(order);
        lcc_release(symbols);
        lcc_layout_free(&layout);
        return LCC_ERR;
      }
      int line_m = (int)lcc_js_round(model_n / 8.0);
      int inset_m = (int)lcc_js_round(model_n / 16.0);
      if (line_m < 1) line_m = 1;
      if (inset_m < 1) inset_m = 1;
      for (int s = 1; s < 8; s++) {
        shape_mask(s, model_n, line_m, inset_m, templ);
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            double *dst = planes_model +
              (((size_t)(s - 1) * 9 + (size_t)((dy + 1) * 3 + (dx + 1))) * (size_t)model_stride);
            for (int y = 0; y < model_n; y++) {
              for (int x = 0; x < model_n; x++) {
                const int tx = x + dx;
                const int ty = y + dy;
                dst[y * model_n + x] = tx >= 0 && ty >= 0 && tx < model_n && ty < model_n
                  ? templ[ty * model_n + tx] : 0;
              }
            }
          }
        }
      }
      lcc_release(templ);
    }
    for (int i = 0; i < D; i++) order[i] = i;
    for (int a = 1; a < D; a++) {
      const int key = order[a];
      const int key_row = layout.data_rc[key * 2];
      int b = a;
      while (b > 0 && layout.data_rc[order[b - 1] * 2] > key_row) {
        order[b] = order[b - 1];
        b--;
      }
      order[b] = key;
    }
  }
  const int sharpen = found->s > 0 && found->s < 12;
  const int band_w = patterns ? layout.N * step : 0;
  int loaded_row = -1;
  for (int k = 0; k < D; k++) {
    const int i = patterns ? order[k] : k;
    const int row = layout.data_rc[i * 2];
    const int col = layout.data_rc[i * 2 + 1];
    if (!patterns) {
      int raw[3], rgb[3];
      raw_sample(image, found, row, col, raw);
      normalize_rgb(&illum, raw, row, col, rgb);
      symbols[i] = classify_color(&cal, palette, rgb, found->threshold);
      continue;
    }
    if (row != loaded_row) {
      warp_module_row(image, found, row, step, layout.N, band);
      loaded_row = row;
    }
    for (int gy = 0; gy < grid_n; gy++) {
      for (int gx = 0; gx < grid_n; gx++) {
        int acc[3] = { 0, 0, 0 };
        for (int tv = 0; tv < 2; tv++) {
          for (int tu = 0; tu < 2; tu++) {
            const int px = col * step + gx * 2 + tu;
            const int py = gy * 2 + tv;
            const uint8_t *sample = band + ((size_t)py * (size_t)band_w + (size_t)px) * 3;
            int raw[3] = { sample[0], sample[1], sample[2] };
            int rgb[3];
            normalize_rgb(&illum, raw, row, col, rgb);
            acc[0] += rgb[0];
            acc[1] += rgb[1];
            acc[2] += rgb[2];
          }
        }
        const int p = (gy * grid_n + gx) * 3;
        grid[p] = acc[0] / 4;
        grid[p + 1] = acc[1] / 4;
        grid[p + 2] = acc[2] / 4;
      }
    }
    int majority[3];
    const int shape = match_shape(
      grid, grid_n, planes, plane_stride, sharpen, majority,
      planes_model, model_stride, shape_set, row, col
    );
    int background[3];
    if (shape == 0) {
      background[0] = majority[0];
      background[1] = majority[1];
      background[2] = majority[2];
    } else {
      refine_background(grid, shape, grid_n, line, inset, background);
    }
    const int color = classify_color(&cal, palette, background, found->threshold);
    symbols[i] = shape * palette->palette_size + color;
  }
  for (int s = 1; s < shape_set; s++) lcc_release(masks[s]);
  lcc_release(grid);
  lcc_release(planes);
  lcc_release(planes_model);
  lcc_release(band);
  lcc_release(order);

  BitWriter writer = { 0 };
  const int bits_per = palette->bits;
  for (int i = 0; i < D; i++) {
    if (strcmp(palette->name, "L1") == 0) bw_bit(&writer, symbols[i] & 1);
    else bw_bits(&writer, symbols[i], bits_per);
  }
  int nbytes = 0;
  uint8_t *packed = bw_finish(&writer, &nbytes);
  const int capacity_bits = strcmp(palette->name, "L1") == 0 ? D : D * bits_per;
  const int S = capacity_bits / 8;
  if (S <= 0 || nbytes < S) {
    free(packed);
    lcc_release(symbols);
    lcc_layout_free(&layout);
    return LCC_ERR;
  }
  const double ecc = ECCS[fmt.ecc_index < 4 ? fmt.ecc_index : 0];
  uint8_t *rs = NULL;
  int rs_len = 0;
  int corrected = 0;
  if (!lcc_rs_decode_blocks(packed, S, ecc, &rs, &rs_len, &corrected)) {
    free(packed);
    lcc_release(symbols);
    lcc_layout_free(&layout);
    return LCC_ERR;
  }
  free(packed);
  whiten(rs, rs_len, fmt.seed);
  uint8_t *out = NULL;
  int out_len = 0;
  if (!parse_payload(rs, rs_len, &out, &out_len)) {
    lcc_release(rs);
    lcc_release(symbols);
    lcc_layout_free(&layout);
    return LCC_ERR;
  }
  lcc_release(rs);
  lcc_release(symbols);
  memset(meta, 0, sizeof(*meta));
  meta->status = LCC_OK;
  meta->version = found->version;
  meta->N = layout.N;
  meta->module_size = found->s;
  meta->ecc = ecc;
  meta->corrected = corrected;
  meta->palette_size = palette->palette_size;
  meta->min_delta_e = palette->min_delta_e;
  meta->constraint = 0;
  meta->harmony = fmt.harmony;
  meta->seed = fmt.seed;
  meta->shape_set = palette->shape_set > 0 ? palette->shape_set : 1;
  meta->bits_per_module = bits_per;
  meta->format_blocks = layout.blocks;
  meta->data_count = D;
  meta->rs_symbols = S;
  meta->rank_count = palette->rank_count;
  meta->max_rank_diff = palette->max_rank_diff;
  meta->calibration = cal.type;
  strncpy(meta->layer, palette->name, sizeof(meta->layer) - 1);
  strncpy(meta->palette_mode, fmt.palette_mode, sizeof(meta->palette_mode) - 1);
  lcc_layout_free(&layout);
  *payload = out;
  *payload_len = out_len;
  return LCC_OK;
}

int lcc_debug_decode_forced(
  const LccImage *image,
  const LccFound *found,
  const char *variant_name,
  uint8_t **payload,
  int *payload_len,
  LccDecodeMeta *meta
) {
  LccPrep prep;
  if (!lcc_prep_init(&prep, image)) return LCC_ERR;
  LccVariant variant;
  if (!lcc_variant_build(&prep, variant_name, &variant)) {
    lcc_prep_free(&prep);
    return LCC_ERR;
  }
  LccFound local = *found;
  local.threshold = lcc_threshold_at(&variant, image->width / 2.0, image->height / 2.0);
  const int status = decode_found(image, &variant, &local, payload, payload_len, meta);
  lcc_variant_free(&variant);
  lcc_prep_free(&prep);
  return status;
}

static int try_name(
  const LccImage *image,
  LccPrep *prep,
  const char *name,
  int perspective,
  uint8_t **payload,
  int *payload_len,
  LccDecodeMeta *meta
) {
  if (g_dbg_capture) g_dbg_count = 0;
  LccVariant variant;
  if (!lcc_variant_build(prep, name, &variant)) return LCC_ERR;
  LccFound found;
  const int ok = perspective
    ? lcc_detect_perspective(image, &variant, &found)
    : lcc_detect_axis(image, &variant, &found);
  int status = LCC_ERR;
  if (ok) status = decode_found(image, &variant, &found, payload, payload_len, meta);
  lcc_variant_free(&variant);
  return status;
}

static int decode_image_impl(const LccImage *image, int mode, uint8_t **payload, int *payload_len, LccDecodeMeta *meta, int persp_limit) {
  if (!image || !image->data || image->width <= 0 || image->height <= 0) return LCC_BAD_INPUT;
  LccPrep prep;
  if (!lcc_prep_init(&prep, image)) return LCC_ERR;
  int saw_constraint = 0;
  if (mode == 0 || mode == 1) {
    for (size_t i = 0; i < sizeof(AXIS_NAMES) / sizeof(AXIS_NAMES[0]); i++) {
      const int status = try_name(image, &prep, AXIS_NAMES[i], 0, payload, payload_len, meta);
      if (status == LCC_OK) {
        lcc_prep_free(&prep);
        return LCC_OK;
      }
      if (status == LCC_UNSUPPORTED) saw_constraint = 1;
    }
  }
  if (mode == 0 || mode == 2) {
    for (size_t i = 0; i < sizeof(PERSP_NAMES) / sizeof(PERSP_NAMES[0]); i++) {
      if ((int)i >= persp_limit) break;
      const int status = try_name(image, &prep, PERSP_NAMES[i], 1, payload, payload_len, meta);
      if (status == LCC_OK) {
        lcc_prep_free(&prep);
        return LCC_OK;
      }
      if (status == LCC_UNSUPPORTED) saw_constraint = 1;
    }
  }
  lcc_prep_free(&prep);
  return saw_constraint ? LCC_UNSUPPORTED : LCC_ERR;
}

static int detect_camera_frame(const LccImage *image, LccFound *found, int *variant_index) {
  int factor = 1;
  while (image->width / factor > 960 || image->height / factor > 960) factor++;
  uint8_t *scaled = NULL;
  LccImage view = *image;
  if (factor > 1) {
    const int w = image->width / factor;
    const int h = image->height / factor;
    if (w < 32 || h < 32) return 0;
    scaled = lcc_alloc((size_t)w * (size_t)h * 3);
    if (!scaled) return 0;
    lcc_downscale_box(image->data, image->width, image->height, factor, scaled);
    view.width = w;
    view.height = h;
    view.data = scaled;
  }
  LccPrep prep;
  if (!lcc_prep_init(&prep, &view)) {
    lcc_release(scaled);
    return 0;
  }
  int ok = 0;
  if (variant_index) *variant_index = -1;
  for (size_t i = 0; i < sizeof(PERSP_NAMES) / sizeof(PERSP_NAMES[0]); i++) {
    LccVariant variant;
    if (!lcc_variant_build(&prep, PERSP_NAMES[i], &variant)) continue;
    ok = lcc_detect_perspective(&view, &variant, found);
    lcc_variant_free(&variant);
    if (ok) {
      if (variant_index) *variant_index = (int)i;
      break;
    }
  }
  lcc_prep_free(&prep);
  if (ok && factor > 1) {
    if (found->has_h) {
      found->H[6] /= factor;
      found->H[7] /= factor;
      found->H[8] /= factor;
    }
    found->origin_x *= factor;
    found->origin_y *= factor;
    found->s *= factor;
  }
  lcc_release(scaled);
  return ok;
}

static int decode_known(const LccImage *image, const LccFound *found, const char *name, uint8_t **payload, int *payload_len, LccDecodeMeta *meta) {
  LccPrep prep;
  if (!lcc_prep_init(&prep, image)) return LCC_ERR;
  LccVariant variant;
  if (!lcc_variant_build(&prep, name, &variant)) {
    lcc_prep_free(&prep);
    return LCC_ERR;
  }
  LccFound local = *found;
  local.threshold = lcc_threshold_at(&variant, image->width / 2.0, image->height / 2.0);
  const int status = decode_found(image, &variant, &local, payload, payload_len, meta);
  lcc_variant_free(&variant);
  lcc_prep_free(&prep);
  return status;
}

static void found_from_det(const LccDet *det, LccFound *found) {
  memset(found, 0, sizeof(*found));
  found->version = det->version;
  found->N = det->N;
  found->s = det->s;
  found->score = det->score;
  found->has_h = det->has_h;
  memcpy(found->H, det->H, sizeof(found->H));
  found->origin_x = det->origin_x;
  found->origin_y = det->origin_y;
}

static int scan_frames_impl(
  const LccImage *frames,
  int count,
  uint8_t **payload,
  int *payload_len,
  LccDecodeMeta *meta
) {
  if (!frames || count <= 0 || count > 8) return LCC_BAD_INPUT;
  LccDet *dets = lcc_alloc((size_t)count * sizeof(LccDet));
  int *variants = lcc_alloc((size_t)count * sizeof(int));
  if (!dets || !variants) {
    lcc_release(dets);
    lcc_release(variants);
    return LCC_ERR;
  }
  memset(dets, 0, (size_t)count * sizeof(LccDet));
  int any = 0;
  for (int i = 0; i < count; i++) {
    LccFound found;
    memset(&found, 0, sizeof(found));
    variants[i] = -1;
    if (!frames[i].data || !detect_camera_frame(&frames[i], &found, &variants[i])) continue;
    dets[i].valid = 1;
    dets[i].version = found.version;
    dets[i].N = found.N;
    dets[i].score = found.score;
    dets[i].has_h = found.has_h;
    memcpy(dets[i].H, found.H, sizeof(found.H));
    dets[i].origin_x = found.origin_x;
    dets[i].origin_y = found.origin_y;
    dets[i].s = found.s;
    any = 1;
  }
  if (!any) {
    lcc_release(dets);
    lcc_release(variants);
    return LCC_ERR;
  }
  uint8_t *rgb = NULL;
  int width = 0, height = 0, used = 0, stacked = 0, version = 0, N = 0, module = 0, quiet = 0, source = -1;
  double noise = 0;
  const int stack_status = lcc_stack_frames(
    frames, dets, count, 4, 0, 1400, 257,
    &rgb, &width, &height, &used, &stacked, &noise, &version, &N, &module, &quiet, &source
  );
  if (stack_status != LCC_OK || !rgb || source < 0 || source >= count) {
    lcc_release(rgb);
    lcc_release(dets);
    lcc_release(variants);
    return stack_status == LCC_OK ? LCC_ERR : stack_status;
  }
  int status;
  if (!stacked) {
    LccFound found;
    found_from_det(&dets[source], &found);
    const int variant = variants[source];
    const char *name = variant >= 0 ? PERSP_NAMES[variant] : PERSP_NAMES[0];
    status = decode_known(&frames[source], &found, name, payload, payload_len, meta);
  } else {
    LccFound axis;
    memset(&axis, 0, sizeof(axis));
    axis.version = version;
    axis.N = N;
    axis.s = module;
    axis.origin_x = quiet * module - 0.5;
    axis.origin_y = quiet * module - 0.5;
    axis.axis = 1;
    LccImage image = { width, height, rgb };
    status = decode_known(&image, &axis, AXIS_NAMES[0], payload, payload_len, meta);
  }
  lcc_release(rgb);
  lcc_release(dets);
  lcc_release(variants);
  return status;
}

int lcc_decode_image(const LccImage *image, int mode, uint8_t **payload, int *payload_len, LccDecodeMeta *meta) {
  const int status = decode_image_impl(image, mode, payload, payload_len, meta, 12);
  if (status == LCC_OK || !image || mode == 1) return status;
  LccImage balanced;
  memset(&balanced, 0, sizeof(balanced));
  if (!lcc_white_balance_copy(image, &balanced)) return status;
  const int retry = decode_image_impl(&balanced, mode, payload, payload_len, meta, 12);
  lcc_release((void *)balanced.data);
  return retry;
}

int lcc_scan_frames(
  const LccImage *frames,
  int count,
  uint8_t **payload,
  int *payload_len,
  LccDecodeMeta *meta
) {
  const int status = scan_frames_impl(frames, count, payload, payload_len, meta);
  if (status == LCC_OK || !frames || count <= 0 || count > 8) return status;
  LccImage balanced[8];
  memset(balanced, 0, sizeof(balanced));
  int n = 0;
  for (int i = 0; i < count; i++) {
    if (lcc_white_balance_copy(&frames[i], &balanced[n])) n++;
  }
  if (n == 0) return status;
  const int retry = scan_frames_impl(balanced, n, payload, payload_len, meta);
  for (int i = 0; i < n; i++) lcc_release((void *)balanced[i].data);
  if (retry == LCC_OK) return retry;
  for (int i = 0; i < count; i++) {
    const int full = decode_image_impl(&frames[i], 2, payload, payload_len, meta, 10);
    if (full == LCC_OK) return full;
  }
  return retry;
}
