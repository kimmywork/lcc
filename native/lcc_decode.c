#include "lcc_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
    if (fmt->shape_layer_id == 3 && fmt->shape_ext) return "L3t";
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
      double x, y;
      point_at(found, black_rc[k][0], black_rc[k][1], &x, &y);
      int rgb[3];
      lcc_sample_image(image, x, y, 1, rgb);
      br += rgb[0];
      bg += rgb[1];
      bb += rgb[2];
    }
    for (int k = 0; k < nw; k++) {
      double x, y;
      point_at(found, white_rc[k][0], white_rc[k][1], &x, &y);
      int rgb[3];
      lcc_sample_image(image, x, y, 1, rgb);
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
  int chromatic = spread > 12;
  if (chromatic) {
    int ok = 1;
    for (int ch = 0; ch < 3; ch++) {
      int nb = 0, nw = 0;
      if (!fit_field(rows, cols, black_ch[ch], n, illum->black_ch[ch], &nb)) ok = 0;
      if (!fit_field(rows, cols, white_ch[ch], n, illum->white_ch[ch], &nw)) ok = 0;
    }
    illum->chromatic = ok;
  }
}

static int clamp_byte(int v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

static void normalize_rgb(const Illum *illum, const int rgb[3], int row, int col, int out[3]) {
  if (!illum->chromatic || illum->nfit < 3) {
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
  double segs[4][4];
  int nseg = 0;
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
  }
  const double half = line / 2.0 > 0.5 ? line / 2.0 : 0.5;
  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) {
      int on = 0;
      for (int s = 0; s < nseg; s++) {
        if (dist_seg(x + 0.5, y + 0.5, segs[s][0], segs[s][1], segs[s][2], segs[s][3]) <= half) {
          on = 1;
          break;
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
  int *symbols = lcc_alloc((size_t)D * sizeof(int));
  if (!symbols) {
    lcc_layout_free(&layout);
    return LCC_ERR;
  }
  const int patterns = palette->shape_set > 1;
  int grid_n = 0;
  int line = 0;
  int inset = 0;
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
  }
  for (int i = 0; i < D; i++) {
    const int row = layout.data_rc[i * 2];
    const int col = layout.data_rc[i * 2 + 1];
    if (!patterns) {
      int raw[3], rgb[3];
      raw_sample(image, found, row, col, raw);
      normalize_rgb(&illum, raw, row, col, rgb);
      symbols[i] = classify_color(&cal, palette, rgb, found->threshold);
      continue;
    }
    int *grid = lcc_alloc((size_t)grid_n * grid_n * 3 * sizeof(int));
    for (int gy = 0; gy < grid_n; gy++) {
      for (int gx = 0; gx < grid_n; gx++) {
        const double u = (gx + 0.5) / grid_n;
        const double v = (gy + 0.5) / grid_n;
        double x, y;
        if (found->has_h) apply_h(found->H, col + u, row + v, &x, &y);
        else {
          x = found->origin_x + (col + u) * found->s;
          y = found->origin_y + (row + v) * found->s;
        }
        int raw[3], rgb[3];
        lcc_sample_bilinear(image, x, y, raw);
        normalize_rgb(&illum, raw, row, col, rgb);
        const int p = (gy * grid_n + gx) * 3;
        grid[p] = rgb[0];
        grid[p + 1] = rgb[1];
        grid[p + 2] = rgb[2];
      }
    }
    uint8_t *fg = lcc_alloc((size_t)grid_n * grid_n);
    cluster_shape(grid, grid_n * grid_n, fg);
    const int shape = classify_shape(fg, grid_n, line, inset);
    int background[3];
    refine_background(grid, shape, grid_n, line, inset, background);
    const int color = classify_color(&cal, palette, background, found->threshold);
    symbols[i] = shape * palette->palette_size + color;
    lcc_release(grid);
    lcc_release(fg);
  }

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

static int try_name(
  const LccImage *image,
  LccPrep *prep,
  const char *name,
  int perspective,
  uint8_t **payload,
  int *payload_len,
  LccDecodeMeta *meta
) {
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

int lcc_decode_image(const LccImage *image, int mode, uint8_t **payload, int *payload_len, LccDecodeMeta *meta) {
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
