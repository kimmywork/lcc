#include "lcc_internal.h"

#include <math.h>

static double srgb_to_linear(double v) {
  const double c = v / 255.0;
  if (c <= 0.04045) return c / 12.92;
  return pow((c + 0.055) / 1.055, 2.4);
}

static double lab_f(double t) {
  const double d = 6.0 / 29.0;
  if (t > d * d * d) return cbrt(t);
  return t / (3.0 * d * d) + 4.0 / 29.0;
}

void lcc_rgb_to_lab(const int rgb[3], double lab[3]) {
  const double R = srgb_to_linear(rgb[0]);
  const double G = srgb_to_linear(rgb[1]);
  const double B = srgb_to_linear(rgb[2]);
  const double x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const double y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const double z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  const double fx = lab_f(x / 0.95047);
  const double fy = lab_f(y / 1.0);
  const double fz = lab_f(z / 1.08883);
  lab[0] = 116.0 * fy - 16.0;
  lab[1] = 500.0 * (fx - fy);
  lab[2] = 200.0 * (fy - fz);
}

double lcc_delta_e(const double *a, const double *b) {
  const double dl = a[0] - b[0];
  const double da = a[1] - b[1];
  const double db = a[2] - b[2];
  return sqrt(dl * dl + da * da + db * db);
}

double lcc_luminance(const int rgb[3]) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
