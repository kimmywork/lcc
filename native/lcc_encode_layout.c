#include "lcc_encode_internal.h"

#include <math.h>
#include <string.h>

static int version_to_size(int version) {
  return 21 + 4 * (version - 1);
}

static int next_pow2(int n) {
  int p = 1;
  while (p < n) p *= 2;
  return p;
}

static void hilbert_d2xy(int n, int d, int *x, int *y) {
  int t = d;
  int xx = 0;
  int yy = 0;
  for (int s = 1; s < n; s *= 2) {
    const int rx = 1 & (t / 2);
    const int ry = 1 & (t ^ rx);
    if (ry == 0) {
      if (rx == 1) {
        xx = s - 1 - xx;
        yy = s - 1 - yy;
      }
      const int tmp = xx;
      xx = yy;
      yy = tmp;
    }
    xx += s * rx;
    yy += s * ry;
    t /= 4;
  }
  *x = xx;
  *y = yy;
}

static int calibration_sample_count(const LccPaletteInfo *p, int N) {
  if (!p || strcmp(p->name, "G10") == 0 || p->kind == 0) return 0;
  if (p->shape_set > 0) {
    const int count = p->palette_size;
    if (count <= 8) return count;
    return N < 33 ? 8 : count;
  }
  if (strcmp(p->name, "C40") == 0) return 16;
  if (strcmp(p->name, "C50") == 0) return N < 33 ? 16 : 32;
  if (strcmp(p->name, "C60") == 0) return N < 33 ? 16 : N < 57 ? 32 : 64;
  if (strcmp(p->name, "C80") == 0) return N < 33 ? 16 : N < 57 ? 64 : 256;
  return 0;
}

static int sample_indices(const LccPaletteInfo *p, int N, int *out, int cap) {
  const int count = calibration_sample_count(p, N);
  if (count <= 0) return 0;
  const int n = count < p->palette_size ? count : p->palette_size;
  if (n >= p->palette_size) {
    const int m = p->palette_size < cap ? p->palette_size : cap;
    for (int i = 0; i < m; i++) out[i] = i;
    return m;
  }
  uint8_t *used = lcc_alloc((size_t)p->palette_size);
  if (!used) return 0;
  int selected = 0;
  out[selected++] = 0;
  used[0] = 1;
  if (p->palette_size > 1 && selected < cap) {
    out[selected++] = 1;
    used[1] = 1;
  }
  while (selected < n && selected < cap) {
    int best = -1;
    double best_d = -1;
    for (int i = 0; i < p->palette_size; i++) {
      if (used[i]) continue;
      double min_d = INFINITY;
      double lab[3];
      lcc_rgb_to_lab((const int[]){ p->rgb[i * 3], p->rgb[i * 3 + 1], p->rgb[i * 3 + 2] }, lab);
      for (int s = 0; s < selected; s++) {
        double other[3];
        lcc_rgb_to_lab((const int[]){ p->rgb[out[s] * 3], p->rgb[out[s] * 3 + 1], p->rgb[out[s] * 3 + 2] }, other);
        const double d = lcc_delta_e(lab, other);
        if (d < min_d) min_d = d;
      }
      if (min_d > best_d) {
        best_d = min_d;
        best = i;
      }
    }
    if (best < 0) break;
    out[selected++] = best;
    used[best] = 1;
  }
  lcc_release(used);
  return selected;
}

static int finder_cell(int r, int c) {
  if (r == 0 || r == 6 || c == 0 || c == 6) return 0;
  if (r == 3 && c == 3) return 0;
  return 1;
}

static void set_symbol(LccEncodeLayout *l, int N, int r, int c, int symbol) {
  if (r < 0 || c < 0 || r >= N || c >= N) return;
  const int i = r * N + c;
  l->fixed[i] = (int16_t)symbol;
  l->has_fixed_color[i] = 0;
  l->has_fixed_shape[i] = 0;
  l->fixed_shape[i] = -1;
}

static void set_color(LccEncodeLayout *l, int N, int r, int c, const uint8_t rgb[3]) {
  if (r < 0 || c < 0 || r >= N || c >= N) return;
  const int i = r * N + c;
  l->fixed[i] = -1;
  l->has_fixed_color[i] = 1;
  l->fixed_color[i * 3] = rgb[0];
  l->fixed_color[i * 3 + 1] = rgb[1];
  l->fixed_color[i * 3 + 2] = rgb[2];
  l->has_fixed_shape[i] = 0;
  l->fixed_shape[i] = -1;
}

static void set_shape(LccEncodeLayout *l, int N, int r, int c, int shape, const uint8_t rgb[3]) {
  if (r < 0 || c < 0 || r >= N || c >= N) return;
  const int i = r * N + c;
  l->fixed[i] = -1;
  l->has_fixed_color[i] = 1;
  l->fixed_color[i * 3] = rgb[0];
  l->fixed_color[i * 3 + 1] = rgb[1];
  l->fixed_color[i * 3 + 2] = rgb[2];
  l->has_fixed_shape[i] = 1;
  l->fixed_shape[i] = (int8_t)shape;
}

void lcc_encode_layout_free(LccEncodeLayout *layout) {
  if (!layout) return;
  lcc_release(layout->data_rc);
  lcc_release(layout->fixed);
  lcc_release(layout->fixed_color);
  lcc_release(layout->has_fixed_color);
  lcc_release(layout->fixed_shape);
  lcc_release(layout->has_fixed_shape);
  memset(layout, 0, sizeof(*layout));
}

int lcc_encode_layout_build(const LccPaletteInfo *palette, int version, LccEncodeLayout *layout) {
  if (!palette || !layout || version < 1 || version > 100) return 0;
  memset(layout, 0, sizeof(*layout));
  const int N = version_to_size(version);
  layout->version = version;
  layout->N = N;
  layout->black_symbol = palette->black_index;
  layout->white_symbol = palette->white_index;

  const size_t cells = (size_t)N * (size_t)N;
  uint8_t *mask = lcc_alloc(cells);
  layout->fixed = lcc_alloc(cells * sizeof(int16_t));
  layout->fixed_color = lcc_alloc(cells * 3);
  layout->has_fixed_color = lcc_alloc(cells);
  layout->fixed_shape = lcc_alloc(cells);
  layout->has_fixed_shape = lcc_alloc(cells);
  int *coords = lcc_alloc(cells * 2 * sizeof(int));
  if (!mask || !layout->fixed || !layout->fixed_color || !layout->has_fixed_color ||
      !layout->fixed_shape || !layout->has_fixed_shape || !coords) {
    lcc_release(mask);
    lcc_encode_layout_free(layout);
    return 0;
  }
  for (size_t i = 0; i < cells; i++) {
    layout->fixed[i] = -1;
    layout->fixed_shape[i] = -1;
  }

  const int black = palette->black_index;
  const int white = palette->white_index;

  /* Finders + separators. */
  const int finders[3][2] = { { 0, 0 }, { 0, N - 7 }, { N - 7, 0 } };
  for (int f = 0; f < 3; f++) {
    const int fr = finders[f][0];
    const int fc = finders[f][1];
    for (int r = 0; r < 8; r++) {
      for (int c = 0; c < 8; c++) {
        const int rr = fr == 0 ? r : N - 8 + r;
        const int cc = fc == 0 ? c : N - 8 + c;
        set_symbol(layout, N, rr, cc, white);
        mask[rr * N + cc] = 1;
      }
    }
    for (int r = 0; r < 7; r++) {
      for (int c = 0; c < 7; c++) {
        set_symbol(layout, N, fr + r, fc + c, finder_cell(r, c) == 0 ? black : white);
        mask[(fr + r) * N + (fc + c)] = 1;
      }
    }
  }

  /* Timing patterns. */
  for (int c = 8; c <= N - 9; c++) {
    set_symbol(layout, N, 6, c, c % 2 == 0 ? black : white);
    mask[6 * N + c] = 1;
  }
  for (int r = 8; r <= N - 9; r++) {
    set_symbol(layout, N, r, 6, r % 2 == 0 ? black : white);
    mask[r * N + 6] = 1;
  }

  layout->blocks = N < 25 ? 1 : N < 57 ? 2 : 3;
  layout->rows_per_copy = layout->blocks * 2;
  layout->cols_per_copy = 8;

  if (N >= 25) {
    const int base = N - 7;
    for (int r = 0; r < 7; r++) {
      for (int c = 0; c < 7; c++) {
        set_symbol(layout, N, base + r, base + c, white);
        mask[(base + r) * N + (base + c)] = 1;
      }
    }
    for (int r = 0; r < 5; r++) {
      for (int c = 0; c < 5; c++) {
        const int is_black = r == 0 || r == 4 || c == 0 || c == 4 || (r == 2 && c == 2);
        set_symbol(layout, N, base + 1 + r, base + 1 + c, is_black ? black : white);
        mask[(base + 1 + r) * N + (base + 1 + c)] = 1;
      }
    }
    layout->copy_count = 2;
    layout->copy_row[0] = 8;
    layout->copy_col[0] = N - layout->cols_per_copy;
    layout->copy_row[1] = N - 8;
    layout->copy_col[1] = 8;
  } else {
    layout->copy_count = 2;
    for (int copy = 0; copy < 2; copy++) {
      layout->copy_row[copy] = N - (2 - copy) * layout->rows_per_copy;
      layout->copy_col[copy] = N - layout->cols_per_copy;
    }
  }
  for (int copy = 0; copy < layout->copy_count; copy++) {
    for (int r = 0; r < layout->rows_per_copy; r++) {
      for (int c = 0; c < layout->cols_per_copy; c++) {
        const int rr = layout->copy_row[copy] + r;
        const int cc = layout->copy_col[copy] + c;
        set_symbol(layout, N, rr, cc, white);
        mask[rr * N + cc] = 1;
      }
    }
  }

  /* Calibration hub. */
  if (strcmp(palette->name, "G10") != 0) {
    const int palette_count = calibration_sample_count(palette, N);
    const int palette_side = palette_count == 0 ? 0 : (int)ceil(sqrt((double)palette_count));
    const int gray_levels = palette->kind == 0 ? palette->levels : 16;
    const int gray_side = (int)ceil(sqrt((double)gray_levels));
    const int shape_count = palette->shape_set > 1 ? palette->shape_set : 0;
    const int shape_side = shape_count == 0 ? 0 : (int)ceil(sqrt((double)shape_count));
    int hub_h = gray_side > palette_side ? gray_side : palette_side;
    if (shape_side > hub_h) hub_h = shape_side;
    const int hub_w = gray_side + palette_side + shape_side + 2;
    const int hub_hh = hub_h + 2;
    const int hub_row = (N - hub_hh) / 2;
    const int hub_col = (N - hub_w) / 2;

    for (int r = 0; r < hub_hh; r++) {
      for (int c = 0; c < hub_w; c++) {
        const int edge = r == 0 || r == hub_hh - 1 || c == 0 || c == hub_w - 1;
        if (!edge) continue;
        const int corner = (r == 0 || r == hub_hh - 1) && (c == 0 || c == hub_w - 1);
        const int symbol = corner ? black : white;
        set_symbol(layout, N, hub_row + r, hub_col + c, symbol);
        mask[(hub_row + r) * N + (hub_col + c)] = 1;
      }
    }

    const uint8_t *gray_src = palette->kind == 0 ? palette->rgb : palette->gray_rgb;
    for (int i = 0; i < gray_levels && i < 16; i++) {
      const int r = hub_row + 1 + i / gray_side;
      const int c = hub_col + 1 + (i % gray_side);
      const uint8_t rgb[3] = { gray_src[i * 3], gray_src[i * 3 + 1], gray_src[i * 3 + 2] };
      set_color(layout, N, r, c, rgb);
      mask[r * N + c] = 1;
    }

    if (palette_side > 0) {
      int indices[256];
      const int nidx = sample_indices(palette, N, indices, 256);
      for (int i = 0; i < nidx; i++) {
        const int r = hub_row + 1 + i / palette_side;
        const int c = hub_col + 1 + gray_side + (i % palette_side);
        set_symbol(layout, N, r, c, indices[i]);
        mask[r * N + c] = 1;
      }
      for (int i = nidx; i < palette_side * palette_side; i++) {
        const int r = hub_row + 1 + i / palette_side;
        const int c = hub_col + 1 + gray_side + (i % palette_side);
        set_symbol(layout, N, r, c, white);
        mask[r * N + c] = 1;
      }
    }

    if (shape_side > 0) {
      for (int i = 0; i < shape_count; i++) {
        const int r = hub_row + 1 + i / shape_side;
        const int c = hub_col + 1 + gray_side + palette_side + (i % shape_side);
        const uint8_t black_rgb[3] = { 0, 0, 0 };
        set_shape(layout, N, r, c, i, black_rgb);
        mask[r * N + c] = 1;
      }
      for (int i = shape_count; i < shape_side * shape_side; i++) {
        const int r = hub_row + 1 + i / shape_side;
        const int c = hub_col + 1 + gray_side + palette_side + (i % shape_side);
        set_symbol(layout, N, r, c, white);
        mask[r * N + c] = 1;
      }
    }
  }

  const int p2 = next_pow2(N);
  int data_count = 0;
  for (int d = 0; d < p2 * p2; d++) {
    int x, y;
    hilbert_d2xy(p2, d, &x, &y);
    if (x >= N || y >= N) continue;
    if (mask[y * N + x]) continue;
    coords[data_count * 2] = y;
    coords[data_count * 2 + 1] = x;
    data_count++;
  }
  layout->data_rc = coords;
  layout->data_count = data_count;
  int function_count = 0;
  for (size_t i = 0; i < cells; i++) {
    if (mask[i]) function_count++;
    else if (layout->fixed[i] != -1 || layout->has_fixed_color[i]) function_count++;
  }
  /* Every cell is either masked (function) or data. */
  layout->function_count = (int)cells - data_count;
  (void)function_count;
  lcc_release(mask);
  return 1;
}
