#include "lcc_internal.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static const int FINDER[7][7] = {
  {0, 0, 0, 0, 0, 0, 0},
  {0, 1, 1, 1, 1, 1, 0},
  {0, 1, 1, 1, 1, 1, 0},
  {0, 1, 1, 0, 1, 1, 0},
  {0, 1, 1, 1, 1, 1, 0},
  {0, 1, 1, 1, 1, 1, 0},
  {0, 0, 0, 0, 0, 0, 0},
};

static const int ALIGN5[5][5] = {
  {0, 0, 0, 0, 0},
  {0, 1, 1, 1, 0},
  {0, 1, 0, 1, 0},
  {0, 1, 1, 1, 0},
  {0, 0, 0, 0, 0},
};

static int version_to_size(int version) {
  return 21 + 4 * (version - 1);
}

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

static int compute_h(const double src[4][2], const double dst[4][2], double H[9]) {
  double A[64];
  double b[8];
  memset(A, 0, sizeof(A));
  for (int i = 0; i < 4; i++) {
    const double u = src[i][0];
    const double v = src[i][1];
    const double x = dst[i][0];
    const double y = dst[i][1];
    const int r0 = i * 2;
    const int r1 = r0 + 1;
    A[r0 * 8 + 0] = u;
    A[r0 * 8 + 1] = v;
    A[r0 * 8 + 2] = 1;
    A[r0 * 8 + 6] = -u * x;
    A[r0 * 8 + 7] = -v * x;
    b[r0] = x;
    A[r1 * 8 + 3] = u;
    A[r1 * 8 + 4] = v;
    A[r1 * 8 + 5] = 1;
    A[r1 * 8 + 6] = -u * y;
    A[r1 * 8 + 7] = -v * y;
    b[r1] = y;
  }
  double h[8];
  if (!lcc_solve(A, b, 8, h)) return 0;
  for (int i = 0; i < 8; i++) H[i] = h[i];
  H[8] = 1;
  return 1;
}

static int bit_at(const LccImage *image, const LccVariant *variant, double x, double y) {
  if (!isfinite(x) || !isfinite(y)) return -1;
  int rgb[3];
  lcc_sample_image(image, x, y, 1, rgb);
  const int mx = rgb[0] > rgb[1] ? (rgb[0] > rgb[2] ? rgb[0] : rgb[2]) : (rgb[1] > rgb[2] ? rgb[1] : rgb[2]);
  return mx < lcc_threshold_at(variant, x, y) ? 0 : 1;
}

static double finder_score_h(const double H[9], const LccImage *image, const LccVariant *variant, int row0, int col0) {
  int matches = 0;
  int total = 0;
  for (int r = 0; r < 7; r++) {
    for (int c = 0; c < 7; c++) {
      double x, y;
      apply_h(H, col0 + c + 0.5, row0 + r + 0.5, &x, &y);
      const int bit = bit_at(image, variant, x, y);
      if (bit < 0) continue;
      if (bit == FINDER[r][c]) matches++;
      total++;
    }
  }
  return total == 0 ? 0 : (double)matches / total;
}

static double alignment_score(const double H[9], const LccImage *image, const LccVariant *variant, int N) {
  const int row0 = N - 6;
  const int col0 = N - 6;
  int matches = 0;
  int total = 0;
  for (int r = 0; r < 5; r++) {
    for (int c = 0; c < 5; c++) {
      double x, y;
      apply_h(H, col0 + c + 0.5, row0 + r + 0.5, &x, &y);
      const int bit = bit_at(image, variant, x, y);
      if (bit < 0) continue;
      if (bit == ALIGN5[r][c]) matches++;
      total++;
    }
  }
  return total == 0 ? 0 : (double)matches / total;
}

static double timing_score(const double H[9], const LccImage *image, const LccVariant *variant, int N) {
  int matches = 0;
  int total = 0;
  for (int c = 8; c <= N - 9; c++) {
    double x, y;
    apply_h(H, c + 0.5, 6.5, &x, &y);
    const int bit = bit_at(image, variant, x, y);
    if (bit < 0) continue;
    if (bit == (c % 2 == 0 ? 0 : 1)) matches++;
    total++;
  }
  for (int r = 8; r <= N - 9; r++) {
    double x, y;
    apply_h(H, 6.5, r + 0.5, &x, &y);
    const int bit = bit_at(image, variant, x, y);
    if (bit < 0) continue;
    if (bit == (r % 2 == 0 ? 0 : 1)) matches++;
    total++;
  }
  return total == 0 ? 0 : (double)matches / total;
}

typedef struct {
  double x, y, unit;
} AxisCand;

static int finder_candidates(const uint8_t *mask, int width, int height, int horizontal, AxisCand *out, int cap) {
  int n = 0;
  const int outer = horizontal ? height : width;
  const int inner = horizontal ? width : height;
  for (int a = 0; a < outer; a++) {
    int runs_color[512];
    int runs_start[512];
    int runs_len[512];
    int nr = 0;
    int start = 0;
    int color = horizontal ? mask[a * width] : mask[a];
    for (int b = 1; b < inner; b++) {
      const int v = horizontal ? mask[a * width + b] : mask[b * width + a];
      if (v != color) {
        if (nr < 512) {
          runs_color[nr] = color;
          runs_start[nr] = start;
          runs_len[nr] = b - start;
          nr++;
        }
        start = b;
        color = v;
      }
    }
    if (nr < 512) {
      runs_color[nr] = color;
      runs_start[nr] = start;
      runs_len[nr] = inner - start;
      nr++;
    }
    for (int i = 0; i + 4 < nr; i++) {
      if (runs_color[i] != 1 || runs_color[i + 1] != 0 || runs_color[i + 2] != 1 ||
          runs_color[i + 3] != 0 || runs_color[i + 4] != 1) continue;
      const double lens[5] = {
        runs_len[i], runs_len[i + 1], runs_len[i + 2], runs_len[i + 3], runs_len[i + 4],
      };
      const double total = lens[0] + lens[1] + lens[2] + lens[3] + lens[4];
      const double unit = total / 7.0;
      if (unit < 1) continue;
      const double tol = unit * 0.65 > 1 ? unit * 0.65 : 1;
      if (fabs(lens[0] - unit) > tol || fabs(lens[1] - 2 * unit) > tol || fabs(lens[2] - unit) > tol ||
          fabs(lens[3] - 2 * unit) > tol || fabs(lens[4] - unit) > tol) continue;
      if (n >= cap) continue;
      const double center = runs_start[i] + 3.5 * unit;
      out[n].x = horizontal ? center : a;
      out[n].y = horizontal ? a : center;
      out[n].unit = unit;
      n++;
    }
  }
  return n;
}

static double axis_finder_score(const uint8_t *mask, int width, int height, AxisCand c) {
  int matches = 0;
  int total = 0;
  for (int r = 0; r < 7; r++) {
    for (int c0 = 0; c0 < 7; c0++) {
      const int x = (int)lcc_js_round(c.x + (c0 - 3) * c.unit);
      const int y = (int)lcc_js_round(c.y + (r - 3) * c.unit);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const int bit = mask[y * width + x] ? 0 : 1;
      if (bit == FINDER[r][c0]) matches++;
      total++;
    }
  }
  return total == 0 ? 0 : (double)matches / total;
}

int lcc_detect_axis(const LccImage *image, const LccVariant *variant, LccFound *found) {
  const int width = image->width;
  const int height = image->height;
  AxisCand *row = lcc_alloc(4096 * sizeof(AxisCand));
  AxisCand *col = lcc_alloc(4096 * sizeof(AxisCand));
  AxisCand *centers = lcc_alloc(4096 * sizeof(AxisCand));
  if (!row || !col || !centers) {
    lcc_release(row);
    lcc_release(col);
    lcc_release(centers);
    return 0;
  }
  const int nr = finder_candidates(variant->mask, width, height, 1, row, 4096);
  const int nc = finder_candidates(variant->mask, width, height, 0, col, 4096);
  int ncent = 0;
  for (int i = 0; i < nr; i++) {
    int best = -1;
    double best_d = INFINITY;
    for (int j = 0; j < nc; j++) {
      const double tol = 2.5 * (row[i].unit > col[j].unit ? row[i].unit : col[j].unit);
      const double lim = tol > 2 ? tol : 2;
      const double d = hypot(row[i].x - col[j].x, row[i].y - col[j].y);
      if (d <= lim && d < best_d) {
        best_d = d;
        best = j;
      }
    }
    if (best >= 0 && ncent < 4096) {
      centers[ncent].x = (row[i].x + col[best].x) / 2;
      centers[ncent].y = (row[i].y + col[best].y) / 2;
      centers[ncent].unit = (row[i].unit + col[best].unit) / 2;
      ncent++;
    }
  }
  if (ncent < 3) {
    lcc_release(row);
    lcc_release(col);
    lcc_release(centers);
    return 0;
  }
  int *keep = lcc_alloc((size_t)ncent * sizeof(int));
  int nkeep = 0;
  for (int i = 0; i < ncent; i++) {
    if (axis_finder_score(variant->mask, width, height, centers[i]) >= 0.8) keep[nkeep++] = i;
  }
  if (nkeep < 3) {
    nkeep = ncent;
    for (int i = 0; i < ncent; i++) keep[i] = i;
  }
  AxisCand clusters[256];
  int counts[256];
  int ncl = 0;
  for (int ii = 0; ii < nkeep; ii++) {
    AxisCand c = centers[keep[ii]];
    int found_i = -1;
    for (int k = 0; k < ncl; k++) {
      if (hypot(c.x - clusters[k].x, c.y - clusters[k].y) < 2 * (c.unit > clusters[k].unit ? c.unit : clusters[k].unit)) {
        found_i = k;
        break;
      }
    }
    if (found_i >= 0) {
      const double n = counts[found_i];
      clusters[found_i].x = (clusters[found_i].x * n + c.x) / (n + 1);
      clusters[found_i].y = (clusters[found_i].y * n + c.y) / (n + 1);
      clusters[found_i].unit = (clusters[found_i].unit * n + c.unit) / (n + 1);
      counts[found_i]++;
    } else if (ncl < 256) {
      clusters[ncl] = c;
      counts[ncl] = 1;
      ncl++;
    }
  }
  lcc_release(row);
  lcc_release(col);
  lcc_release(centers);
  lcc_release(keep);
  if (ncl < 3) return 0;
  int tl = 0;
  for (int i = 1; i < ncl; i++) {
    if (clusters[i].x + clusters[i].y < clusters[tl].x + clusters[tl].y) tl = i;
  }
  int tr = -1;
  int bl = -1;
  double best_tr = -INFINITY;
  double best_bl = -INFINITY;
  for (int i = 0; i < ncl; i++) {
    if (i == tl) continue;
    const double trs = clusters[i].x - clusters[i].y;
    const double bls = clusters[i].y - clusters[i].x;
    if (trs > best_tr) {
      best_tr = trs;
      tr = i;
    }
    if (bls > best_bl) {
      best_bl = bls;
      bl = i;
    }
  }
  if (tr < 0 || bl < 0 || tr == bl) return 0;
  if (clusters[tr].x <= clusters[tl].x || clusters[bl].y <= clusters[tl].y) return 0;
  const double s = (clusters[tl].unit + clusters[tr].unit + clusters[bl].unit) / 3.0;
  const int n1 = (int)lcc_js_round((clusters[tr].x - clusters[tl].x) / s) + 7;
  const int n2 = (int)lcc_js_round((clusters[bl].y - clusters[tl].y) / s) + 7;
  if (abs(n1 - n2) > 1) return 0;
  int N = (int)lcc_js_round((n1 + n2) / 2.0);
  int version = (int)lcc_js_round((N - 21) / 4.0) + 1;
  if (version < 1) version = 1;
  if (version > 100) version = 100;
  N = version_to_size(version);
  memset(found, 0, sizeof(*found));
  found->version = version;
  found->N = N;
  found->s = s;
  found->origin_x = clusters[tl].x - 3.5 * s;
  found->origin_y = clusters[tl].y - 3.5 * s;
  found->threshold = lcc_threshold_at(variant, width / 2.0, height / 2.0);
  found->axis = 1;
  found->has_h = 0;
  return 1;
}

typedef struct {
  double x, y, s, area;
} Ring;

static int ring_components(const uint8_t *mask, int width, int height, Ring *out, int cap) {
  const int n = width * height;
  uint8_t *visited = lcc_alloc((size_t)n);
  int *stack = lcc_alloc((size_t)n * sizeof(int));
  if (!visited || !stack) {
    lcc_release(visited);
    lcc_release(stack);
    return 0;
  }
  const int min_side = width < height ? width : height;
  int count = 0;
  for (int start = 0; start < n; start++) {
    if (visited[start] || !mask[start]) continue;
    int sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    int area = 0;
    double sum_x = 0;
    double sum_y = 0;
    int min_x = width, max_x = 0, min_y = height, max_y = 0;
    while (sp > 0) {
      const int p = stack[--sp];
      const int x = p % width;
      const int y = p / width;
      area++;
      sum_x += x;
      sum_y += y;
      if (x < min_x) min_x = x;
      if (x > max_x) max_x = x;
      if (y < min_y) min_y = y;
      if (y > max_y) max_y = y;
      for (int dy = -1; dy <= 1; dy++) {
        const int yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          const int xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const int q = yy * width + xx;
          if (!visited[q] && mask[q]) {
            visited[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    const int bw = max_x - min_x + 1;
    const int bh = max_y - min_y + 1;
    if (area < 20 || bw < 7 || bh < 7) continue;
    const double aspect = (double)bw / bh;
    if (aspect < 0.3 || aspect > 3.2) continue;
    const double fill = (double)area / (bw * bh);
    if (fill < 0.15 || fill > 0.9) continue;
    const double cx = sum_x / area;
    const double cy = sum_y / area;
    const double s = sqrt((double)area / 24.0);
    if (s < 2 || s > min_side / 10.0) continue;
    int white_hits = 0;
    int black_hits = 0;
    int probes = 0;
    for (int a = 0; a < 16; a++) {
      const double angle = (a / 16.0) * 6.283185307179586;
      const int x1 = (int)lcc_js_round(cx + cos(angle) * 1.75 * s);
      const int y1 = (int)lcc_js_round(cy + sin(angle) * 1.75 * s);
      const int x2 = (int)lcc_js_round(cx + cos(angle) * 3.2 * s);
      const int y2 = (int)lcc_js_round(cy + sin(angle) * 3.2 * s);
      if (x1 >= 0 && x1 < width && y1 >= 0 && y1 < height) {
        probes++;
        if (!mask[y1 * width + x1]) white_hits++;
      }
      if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height) {
        if (mask[y2 * width + x2]) black_hits++;
      }
    }
    if (probes < 8) continue;
    if (white_hits < probes * 0.6 || black_hits < probes * 0.6) continue;
    Ring ring = { cx, cy, s, (double)area };
    if (count < cap) {
      out[count++] = ring;
    } else {
      int smallest = 0;
      for (int i = 1; i < count; i++) {
        if (out[i].area < out[smallest].area) smallest = i;
      }
      if (ring.area > out[smallest].area) out[smallest] = ring;
    }
  }
  for (int i = 1; i < count; i++) {
    Ring key = out[i];
    int j = i - 1;
    while (j >= 0 && out[j].area < key.area) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = key;
  }
  lcc_release(visited);
  lcc_release(stack);
  return count;
}

int lcc_detect_perspective(const LccImage *image, const LccVariant *variant, LccFound *found) {
  const int width = image->width;
  const int height = image->height;
  Ring *rings = lcc_alloc(256 * sizeof(Ring));
  if (!rings) return 0;
  int nring = ring_components(variant->mask, width, height, rings, 256);
  if (nring > 10) nring = 10;
  if (nring < 3) {
    lcc_release(rings);
    return 0;
  }
  double corners[4][2];
  int have_corners = 0;
  {
    double min_sum = INFINITY, max_sum = -INFINITY, min_diff = INFINITY, max_diff = -INFINITY;
    int any = 0;
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        if (!variant->mask[y * width + x]) continue;
        any = 1;
        const double s = x + y;
        const double d = x - y;
        if (s < min_sum) {
          min_sum = s;
          corners[0][0] = x;
          corners[0][1] = y;
        }
        if (s > max_sum) {
          max_sum = s;
          corners[1][0] = x;
          corners[1][1] = y;
        }
        if (d < min_diff) {
          min_diff = d;
          corners[2][0] = x;
          corners[2][1] = y;
        }
        if (d > max_diff) {
          max_diff = d;
          corners[3][0] = x;
          corners[3][1] = y;
        }
      }
    }
    have_corners = any;
  }
  if (!have_corners) {
    lcc_release(rings);
    return 0;
  }

  int best_ok = 0;
  double best_total = -INFINITY;
  LccFound best;
  memset(&best, 0, sizeof(best));
  for (int i = 0; i < nring - 2; i++) {
    for (int j = i + 1; j < nring - 1; j++) {
      for (int k = j + 1; k < nring; k++) {
        const int idx[3] = { i, j, k };
        const double d01 = hypot(rings[i].x - rings[j].x, rings[i].y - rings[j].y);
        const double d02 = hypot(rings[i].x - rings[k].x, rings[i].y - rings[k].y);
        const double d12 = hypot(rings[j].x - rings[k].x, rings[j].y - rings[k].y);
        int tl, a, b;
        if (d12 >= d01 && d12 >= d02) {
          tl = idx[0];
          a = idx[1];
          b = idx[2];
        } else if (d02 >= d01 && d02 >= d12) {
          tl = idx[1];
          a = idx[0];
          b = idx[2];
        } else {
          tl = idx[2];
          a = idx[0];
          b = idx[1];
        }
        const int assign[2][2] = { { a, b }, { b, a } };
        for (int pass = 0; pass < 2; pass++) {
          const int tr = assign[pass][0];
          const int bl = assign[pass][1];
          const double cross = (rings[tr].x - rings[tl].x) * (rings[bl].y - rings[tl].y) -
            (rings[tr].y - rings[tl].y) * (rings[bl].x - rings[tl].x);
          if (cross <= 0) continue;
          const double s_top = (rings[tl].s + rings[tr].s) / 2;
          const double s_left = (rings[tl].s + rings[bl].s) / 2;
          const double n1 = hypot(rings[tl].x - rings[tr].x, rings[tl].y - rings[tr].y) / s_top + 7;
          const double n2 = hypot(rings[tl].x - rings[bl].x, rings[tl].y - rings[bl].y) / s_left + 7;
          int version_est = (int)lcc_js_round((((n1 + n2) / 2) - 21) / 4) + 1;
          int v0 = version_est - 3;
          int v1 = version_est + 3;
          if (v0 < 1) v0 = 1;
          if (v1 > 100) v1 = 100;
          for (int v = v0; v <= v1; v++) {
            const int N = version_to_size(v);
            double H[9];
            int have_h = 0;
            int aligned = 0;
            if (N >= 25) {
              const double ex = rings[tr].x + rings[bl].x - rings[tl].x;
              const double ey = rings[tr].y + rings[bl].y - rings[tl].y;
              const double max_d = 0.35 * (hypot(rings[tl].x - rings[tr].x, rings[tl].y - rings[tr].y) >
                hypot(rings[tl].x - rings[bl].x, rings[tl].y - rings[bl].y)
                  ? hypot(rings[tl].x - rings[tr].x, rings[tl].y - rings[tr].y)
                  : hypot(rings[tl].x - rings[bl].x, rings[tl].y - rings[bl].y));
              const double avg_area = (rings[tl].area + rings[tr].area + rings[bl].area) / 3;
              int best_align = -1;
              double best_d = INFINITY;
              for (int c = 0; c < nring; c++) {
                if (c == tl || c == tr || c == bl) continue;
                const double d = hypot(rings[c].x - ex, rings[c].y - ey);
                if (d > max_d) continue;
                if (rings[c].area > 0.95 * avg_area) continue;
                if (d < best_d) {
                  best_d = d;
                  best_align = c;
                }
              }
              if (best_align >= 0) {
                const double src[4][2] = {
                  { 3.5, 3.5 },
                  { N - 3.5, 3.5 },
                  { 3.5, N - 3.5 },
                  { N - 3.5, N - 3.5 },
                };
                const double dst[4][2] = {
                  { rings[tl].x, rings[tl].y },
                  { rings[tr].x, rings[tr].y },
                  { rings[bl].x, rings[bl].y },
                  { rings[best_align].x, rings[best_align].y },
                };
                if (compute_h(src, dst, H)) {
                  have_h = 1;
                  aligned = 1;
                }
              }
            }
            if (!have_h) {
              int used[4] = { 0, 0, 0, 0 };
              double picked[4][2];
              const double targets[3][2] = {
                { rings[tl].x, rings[tl].y },
                { rings[tr].x, rings[tr].y },
                { rings[bl].x, rings[bl].y },
              };
              int ok = 1;
              for (int t = 0; t < 3; t++) {
                int best = -1;
                double best_d = INFINITY;
                for (int c = 0; c < 4; c++) {
                  if (used[c]) continue;
                  const double d = hypot(corners[c][0] - targets[t][0], corners[c][1] - targets[t][1]);
                  if (d < best_d) {
                    best_d = d;
                    best = c;
                  }
                }
                if (best < 0) {
                  ok = 0;
                  break;
                }
                used[best] = 1;
                picked[t][0] = corners[best][0];
                picked[t][1] = corners[best][1];
              }
              if (!ok) continue;
              int br = -1;
              for (int c = 0; c < 4; c++) {
                if (!used[c]) {
                  br = c;
                  break;
                }
              }
              if (br < 0) continue;
              picked[3][0] = corners[br][0];
              picked[3][1] = corners[br][1];
              const double src[4][2] = { { 0, 0 }, { N, 0 }, { 0, N }, { N, N } };
              if (!compute_h(src, picked, H)) continue;
              have_h = 1;
              aligned = 0;
            }
            const double score_tl = finder_score_h(H, image, variant, 0, 0);
            const double score_tr = finder_score_h(H, image, variant, 0, N - 7);
            const double score_bl = finder_score_h(H, image, variant, N - 7, 0);
            double score_a = 1;
            if (aligned) {
              score_a = alignment_score(H, image, variant, N);
              if (score_a < 0.65) continue;
            }
            const double min_score = score_tl < score_tr
              ? (score_tl < score_bl ? (score_tl < score_a ? score_tl : score_a) : (score_bl < score_a ? score_bl : score_a))
              : (score_tr < score_bl ? (score_tr < score_a ? score_tr : score_a) : (score_bl < score_a ? score_bl : score_a));
            if (min_score < 0.65) continue;
            const double score_t = timing_score(H, image, variant, N);
            const double consistency = 1 - (fabs(n1 - n2) / N > 1 ? 1 : fabs(n1 - n2) / N);
            const double total = min_score + 0.5 * score_t + 0.1 * consistency;
            if (!best_ok || total > best_total) {
              best_ok = 1;
              best_total = total;
              memset(&best, 0, sizeof(best));
              best.version = v;
              best.N = N;
              best.s = (rings[tl].s + rings[tr].s + rings[bl].s) / 3;
              best.score = total;
              best.has_h = 1;
              best.axis = 0;
              memcpy(best.H, H, sizeof(H));
              best.threshold = lcc_threshold_at(variant, width / 2.0, height / 2.0);
            }
          }
        }
      }
    }
  }
  lcc_release(rings);
  if (!best_ok) return 0;
  *found = best;
  return 1;
}

/*
 * Finder-network path. It receives three locator centers from a small CNN and
 * searches versions by scoring the 1:2:1:2:1 finders plus the timing rows.
 * This avoids the per-variant connected-component pass on hard frames.
 */
int lcc_detect_finder_net(
  const LccImage *image,
  const uint8_t *gray,
  const LccVariant *variant,
  LccFound *found
) {
  double centers[3][2];
  if (!lcc_finder_centers(gray, image->width, image->height, centers)) return 0;

  int tl = 0;
  for (int i = 1; i < 3; i++) {
    if (centers[i][0] + centers[i][1] < centers[tl][0] + centers[tl][1]) tl = i;
  }
  int tr = -1;
  int bl = -1;
  double best_tr = -INFINITY;
  double best_bl = -INFINITY;
  for (int i = 0; i < 3; i++) {
    if (i == tl) continue;
    const double trs = centers[i][0] - centers[i][1];
    const double bls = centers[i][1] - centers[i][0];
    if (trs > best_tr) {
      best_tr = trs;
      tr = i;
    }
    if (bls > best_bl) {
      best_bl = bls;
      bl = i;
    }
  }
  if (tr < 0 || bl < 0 || tr == bl) return 0;

  const double d_top = hypot(centers[tl][0] - centers[tr][0], centers[tl][1] - centers[tr][1]);
  const double d_left = hypot(centers[tl][0] - centers[bl][0], centers[tl][1] - centers[bl][1]);
  if (d_top < 20 || d_left < 20) return 0;

  int best_ok = 0;
  double best_total = -INFINITY;
  LccFound best;
  memset(&best, 0, sizeof(best));
  for (int version = 1; version <= 100; version++) {
    const int N = version_to_size(version);
    const double src[4][2] = {
      { 3.5, 3.5 },
      { N - 3.5, 3.5 },
      { 3.5, N - 3.5 },
      { N - 3.5, N - 3.5 },
    };
    const double dst[4][2] = {
      { centers[tl][0], centers[tl][1] },
      { centers[tr][0], centers[tr][1] },
      { centers[bl][0], centers[bl][1] },
      { centers[tr][0] + centers[bl][0] - centers[tl][0], centers[tr][1] + centers[bl][1] - centers[tl][1] },
    };
    double H[9];
    if (!compute_h(src, dst, H)) continue;
    const double score_tl = finder_score_h(H, image, variant, 0, 0);
    const double score_tr = finder_score_h(H, image, variant, 0, N - 7);
    const double score_bl = finder_score_h(H, image, variant, N - 7, 0);
    const double min_score = score_tl < score_tr
      ? (score_tl < score_bl ? score_tl : score_bl)
      : (score_tr < score_bl ? score_tr : score_bl);
    if (min_score < 0.65) continue;
    const double score_t = timing_score(H, image, variant, N);
    const double total = min_score + 0.5 * score_t;
    if (!best_ok || total > best_total) {
      best_ok = 1;
      best_total = total;
      memset(&best, 0, sizeof(best));
      best.version = version;
      best.N = N;
      best.s = ((d_top + d_left) / 2.0) / (double)(N - 7);
      best.score = total;
      best.has_h = 1;
      best.axis = 0;
      memcpy(best.H, H, sizeof(H));
      best.threshold = lcc_threshold_at(variant, image->width / 2.0, image->height / 2.0);
    }
  }
  if (!best_ok) return 0;
  *found = best;
  return 1;
}
