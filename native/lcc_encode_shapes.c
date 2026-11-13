#include "lcc_encode_internal.h"

#include <math.h>

static double js_round(double x) {
  return floor(x + 0.5);
}

typedef struct {
  double x0, y0, x1, y1;
} Segment;

typedef struct {
  Segment seg[8];
  int seg_count;
  Segment fill[4];
  int fill_count;
} ShapeGeometry;

static void add_seg(ShapeGeometry *g, double x0, double y0, double x1, double y1) {
  if (g->seg_count >= 8) return;
  g->seg[g->seg_count].x0 = x0;
  g->seg[g->seg_count].y0 = y0;
  g->seg[g->seg_count].x1 = x1;
  g->seg[g->seg_count].y1 = y1;
  g->seg_count++;
}

static void add_fill(ShapeGeometry *g, double x0, double y0, double x1, double y1) {
  if (g->fill_count >= 4) return;
  g->fill[g->fill_count].x0 = x0;
  g->fill[g->fill_count].y0 = y0;
  g->fill[g->fill_count].x1 = x1;
  g->fill[g->fill_count].y1 = y1;
  g->fill_count++;
}

static double distance_to_segment(double px, double py, const Segment *s) {
  const double dx = s->x1 - s->x0;
  const double dy = s->y1 - s->y0;
  const double len2 = dx * dx + dy * dy;
  if (len2 == 0) return hypot(px - s->x0, py - s->y0);
  double t = ((px - s->x0) * dx + (py - s->y0) * dy) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const double x = s->x0 + t * dx;
  const double y = s->y0 + t * dy;
  return hypot(px - x, py - y);
}

static void shape_geometry(int shape, int size, double inset, ShapeGeometry *g) {
  g->seg_count = 0;
  g->fill_count = 0;
  const double lo = inset;
  const double hi = size - inset;
  const double mid = size / 2.0;
  const double square_inset = fmax(inset, size >= 4 ? js_round(size / 4.0) : size / 4.0);
  const double slo = square_inset;
  const double shi = size - square_inset;
  const double gap = fmax(inset, size * 0.08);

  switch (shape) {
    case 1: add_seg(g, lo, hi, hi, lo); break;
    case 2: add_seg(g, lo, lo, hi, hi); break;
    case 3:
      add_seg(g, lo, hi, hi, lo);
      add_seg(g, lo, lo, hi, hi);
      break;
    case 4:
      add_seg(g, lo, mid, hi, mid);
      add_seg(g, mid, lo, mid, hi);
      break;
    case 5: add_seg(g, lo, mid, hi, mid); break;
    case 6: add_seg(g, mid, lo, mid, hi); break;
    case 7:
      add_seg(g, slo, slo, shi, slo);
      add_seg(g, shi, slo, shi, shi);
      add_seg(g, shi, shi, slo, shi);
      add_seg(g, slo, shi, slo, slo);
      break;
    case 8:
      add_seg(g, lo, mid, hi, lo);
      add_seg(g, lo, mid, hi, hi);
      break;
    case 9:
      add_seg(g, hi, mid, lo, lo);
      add_seg(g, hi, mid, lo, hi);
      break;
    case 10:
      add_seg(g, mid, hi, lo, lo);
      add_seg(g, mid, hi, hi, lo);
      break;
    case 11:
      add_seg(g, mid, lo, lo, hi);
      add_seg(g, mid, lo, hi, hi);
      break;
    case 12:
      add_seg(g, lo, mid, hi, mid);
      add_seg(g, lo, mid, mid, lo);
      add_seg(g, lo, mid, mid, hi);
      break;
    case 13:
      add_seg(g, mid, lo, mid, hi);
      add_seg(g, mid, lo, lo, mid);
      add_seg(g, mid, lo, hi, mid);
      break;
    case 14:
      add_seg(g, lo, mid, hi, mid);
      add_seg(g, hi, mid, mid, lo);
      add_seg(g, hi, mid, mid, hi);
      break;
    case 15:
      add_seg(g, mid, lo, mid, hi);
      add_seg(g, mid, hi, lo, mid);
      add_seg(g, mid, hi, hi, mid);
      break;
    case 16:
      add_seg(g, lo, lo, hi, hi);
      add_seg(g, lo, lo, lo, mid);
      add_seg(g, lo, lo, mid, lo);
      break;
    case 17:
      add_seg(g, lo, hi, hi, lo);
      add_seg(g, hi, lo, hi, mid);
      add_seg(g, hi, lo, mid, lo);
      break;
    case 18:
      add_seg(g, lo, lo, hi, hi);
      add_seg(g, hi, hi, hi, mid);
      add_seg(g, hi, hi, mid, hi);
      break;
    case 19:
      add_seg(g, hi, lo, lo, hi);
      add_seg(g, lo, hi, lo, mid);
      add_seg(g, lo, hi, mid, hi);
      break;
    case 20: add_fill(g, lo, lo, mid - gap, mid - gap); break;
    case 21: add_fill(g, mid + gap, lo, hi, mid - gap); break;
    case 22: add_fill(g, lo, mid + gap, mid - gap, hi); break;
    case 23: add_fill(g, mid + gap, mid + gap, hi, hi); break;
    case 24:
      add_seg(g, lo, mid, hi, mid);
      add_seg(g, mid, mid, mid, hi);
      break;
    case 25:
      add_seg(g, mid, lo, mid, hi);
      add_seg(g, mid, mid, hi, mid);
      break;
    case 26:
      add_seg(g, mid, lo, mid, hi);
      add_seg(g, lo, mid, mid, mid);
      break;
    case 27:
      add_seg(g, lo, mid, hi, mid);
      add_seg(g, mid, lo, mid, mid);
      break;
    case 28:
      add_seg(g, lo, hi, hi, lo);
      add_seg(g, mid, mid, lo, lo);
      break;
    case 29:
      add_seg(g, lo, hi, hi, lo);
      add_seg(g, mid, mid, hi, hi);
      break;
    case 30:
      add_seg(g, lo, lo, hi, hi);
      add_seg(g, mid, mid, hi, lo);
      break;
    case 31:
      add_seg(g, lo, lo, hi, hi);
      add_seg(g, mid, mid, lo, hi);
      break;
    default:
      break;
  }
}

static int shape_line_width(int size) {
  const int v = (int)js_round(size / 8.0);
  return v > 1 ? v : 1;
}

static int shape_inset(int size) {
  const int v = (int)js_round(size / 16.0);
  return v > 1 ? v : 1;
}

void lcc_encode_shape_mask(int shape, int size, uint8_t *mask) {
  if (!mask || size <= 0) return;
  if (shape <= 0 || shape >= 32) {
    for (int i = 0; i < size * size; i++) mask[i] = 0;
    return;
  }
  ShapeGeometry g;
  shape_geometry(shape, size, shape_inset(size), &g);
  const double half = fmax(0.5, shape_line_width(size) / 2.0);
  for (int y = 0; y < size; y++) {
    const double py = y + 0.5;
    for (int x = 0; x < size; x++) {
      const double px = x + 0.5;
      int on = 0;
      for (int i = 0; i < g.fill_count; i++) {
        const Segment *f = &g.fill[i];
        if (px >= f->x0 && px <= f->x1 && py >= f->y0 && py <= f->y1) {
          on = 1;
          break;
        }
      }
      if (!on) {
        for (int i = 0; i < g.seg_count; i++) {
          if (distance_to_segment(px, py, &g.seg[i]) <= half) {
            on = 1;
            break;
          }
        }
      }
      mask[y * size + x] = (uint8_t)(on ? 1 : 0);
    }
  }
}

void lcc_encode_foreground(const int background[3], int foreground[3]) {
  const int candidates[3][3] = {
    { 255 - background[0], 255 - background[1], 255 - background[2] },
    { 0, 0, 0 },
    { 255, 255, 255 },
  };
  double bg[3];
  lcc_rgb_to_lab(background, bg);
  double best = -1;
  int best_index = 0;
  for (int i = 0; i < 3; i++) {
    double lab[3];
    lcc_rgb_to_lab(candidates[i], lab);
    const double d = lcc_delta_e(bg, lab);
    if (d > best) {
      best = d;
      best_index = i;
    }
  }
  foreground[0] = candidates[best_index][0];
  foreground[1] = candidates[best_index][1];
  foreground[2] = candidates[best_index][2];
}
