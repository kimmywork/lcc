#include "lcc_internal.h"

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

static int sample_count(const LccPaletteInfo *p, int N) {
  if (!p || strcmp(p->name, "L1") == 0 || p->kind == 0) return 0;
  if (p->shape_set > 0) {
    const int count = p->palette_size;
    if (count <= 8) return count;
    return N < 33 ? 8 : count;
  }
  if (strcmp(p->name, "L3c") == 0) return 16;
  if (strcmp(p->name, "L3d") == 0) return N < 33 ? 16 : 32;
  if (strcmp(p->name, "L4e") == 0) return N < 33 ? 16 : N < 57 ? 32 : 64;
  if (strcmp(p->name, "L4f") == 0) return N < 33 ? 16 : N < 57 ? 64 : 256;
  return 0;
}

static void lab_at(const LccPaletteInfo *p, int i, double lab[3]) {
  lab[0] = p->lab[i * 3];
  lab[1] = p->lab[i * 3 + 1];
  lab[2] = p->lab[i * 3 + 2];
}

static int sample_indices(const LccPaletteInfo *p, int N, int *out, int cap) {
  const int count = sample_count(p, N);
  if (count <= 0) return 0;
  const int n = count < p->palette_size ? count : p->palette_size;
  if (n >= p->palette_size) {
    for (int i = 0; i < p->palette_size && i < cap; i++) out[i] = i;
    return p->palette_size < cap ? p->palette_size : cap;
  }
  uint8_t *used = lcc_alloc((size_t)p->palette_size);
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
      lab_at(p, i, lab);
      for (int s = 0; s < selected; s++) {
        double other[3];
        lab_at(p, out[s], other);
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

static void mark(uint8_t *mask, int N, int r, int c) {
  if (r < 0 || c < 0 || r >= N || c >= N) return;
  mask[r * N + c] = 1;
}

void lcc_layout_free(LccLayout *layout) {
  lcc_release(layout->data_rc);
  layout->data_rc = NULL;
}

int lcc_make_layout(const LccPaletteInfo *palette, int version, LccLayout *layout) {
  memset(layout, 0, sizeof(*layout));
  const int N = version_to_size(version);
  layout->version = version;
  layout->N = N;
  uint8_t *mask = lcc_alloc((size_t)N * N);
  if (!mask) return 0;

  for (int f = 0; f < 3; f++) {
    const int row = f == 2 ? N - 7 : 0;
    const int col = f == 1 ? N - 7 : 0;
    for (int r = 0; r < 8; r++) {
      for (int c = 0; c < 8; c++) {
        const int rr = row == 0 ? r : N - 8 + r;
        const int cc = col == 0 ? c : N - 8 + c;
        mark(mask, N, rr, cc);
      }
    }
  }

  for (int c = 8; c <= N - 9; c++) mark(mask, N, 6, c);
  for (int r = 8; r <= N - 9; r++) mark(mask, N, r, 6);

  layout->blocks = N < 25 ? 1 : N < 57 ? 2 : 3;
  const int rows = layout->blocks * 2;
  if (N >= 25) {
    layout->has_alignment = 1;
    const int base = N - 7;
    for (int r = 0; r < 7; r++) {
      for (int c = 0; c < 7; c++) mark(mask, N, base + r, base + c);
    }
    layout->copy_count = 2;
    layout->copy_row[0] = 8;
    layout->copy_col[0] = N - 8;
    layout->copy_row[1] = N - 8;
    layout->copy_col[1] = 8;
  } else {
    layout->copy_count = 2;
    for (int copy = 0; copy < 2; copy++) {
      layout->copy_row[copy] = N - (2 - copy) * rows;
      layout->copy_col[copy] = N - 8;
    }
  }
  for (int copy = 0; copy < layout->copy_count; copy++) {
    for (int r = 0; r < rows; r++) {
      for (int c = 0; c < 8; c++) mark(mask, N, layout->copy_row[copy] + r, layout->copy_col[copy] + c);
    }
  }

  if (strcmp(palette->name, "L1") != 0) {
    const int palette_count = sample_count(palette, N);
    const int palette_side = palette_count == 0 ? 0 : (int)ceil(sqrt((double)palette_count));
    const int gray_levels = palette->kind == 0 ? palette->levels : 16;
    const int gray_side = (int)ceil(sqrt((double)gray_levels));
    const int shape_count = palette->shape_set > 1 ? palette->shape_set : 0;
    const int shape_side = shape_count == 0 ? 0 : (int)ceil(sqrt((double)shape_count));
    const int hub_w = gray_side + palette_side + shape_side + 2;
    const int hub_h = (gray_side > palette_side ? gray_side : palette_side);
    const int hub_h2 = hub_h > shape_side ? hub_h : shape_side;
    const int hub_hh = hub_h2 + 2;
    const int hub_row = (N - hub_hh) / 2;
    const int hub_col = (N - hub_w) / 2;
    for (int r = 0; r < hub_hh; r++) {
      for (int c = 0; c < hub_w; c++) {
        const int edge = r == 0 || r == hub_hh - 1 || c == 0 || c == hub_w - 1;
        if (edge) mark(mask, N, hub_row + r, hub_col + c);
      }
    }
    const uint8_t *gray_src = palette->kind == 0 ? palette->rgb : palette->gray_rgb;
    layout->gray_count = gray_levels;
    for (int i = 0; i < gray_levels && i < 16; i++) {
      const int r = hub_row + 1 + i / gray_side;
      const int c = hub_col + 1 + (i % gray_side);
      mark(mask, N, r, c);
      layout->gray_row[i] = r;
      layout->gray_col[i] = c;
      layout->gray_rgb[i][0] = gray_src[i * 3];
      layout->gray_rgb[i][1] = gray_src[i * 3 + 1];
      layout->gray_rgb[i][2] = gray_src[i * 3 + 2];
    }
    if (palette_side > 0) {
      int indices[256];
      const int nidx = sample_indices(palette, N, indices, 256);
      layout->palette_count = nidx;
      for (int i = 0; i < nidx; i++) {
        const int r = hub_row + 1 + i / palette_side;
        const int c = hub_col + 1 + gray_side + (i % palette_side);
        mark(mask, N, r, c);
        layout->pal_row[i] = r;
        layout->pal_col[i] = c;
        const int symbol = indices[i];
        layout->pal_rgb[i][0] = palette->rgb[symbol * 3];
        layout->pal_rgb[i][1] = palette->rgb[symbol * 3 + 1];
        layout->pal_rgb[i][2] = palette->rgb[symbol * 3 + 2];
      }
      for (int i = nidx; i < palette_side * palette_side; i++) {
        const int r = hub_row + 1 + i / palette_side;
        const int c = hub_col + 1 + gray_side + (i % palette_side);
        mark(mask, N, r, c);
      }
    }
    if (shape_side > 0) {
      for (int i = 0; i < shape_count; i++) {
        const int r = hub_row + 1 + i / shape_side;
        const int c = hub_col + 1 + gray_side + palette_side + (i % shape_side);
        mark(mask, N, r, c);
      }
      for (int i = shape_count; i < shape_side * shape_side; i++) {
        const int r = hub_row + 1 + i / shape_side;
        const int c = hub_col + 1 + gray_side + palette_side + (i % shape_side);
        mark(mask, N, r, c);
      }
    }
  }

  const int p2 = next_pow2(N);
  int *coords = lcc_alloc((size_t)N * N * 2 * sizeof(int));
  int data_count = 0;
  if (!coords) {
    lcc_release(mask);
    return 0;
  }
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
  lcc_release(mask);
  return 1;
}
