#include "lcc_encode_internal.h"

#include <string.h>

/* Canonical order mirrors src/constants.js. */
static const LccEncodeLayer LAYERS[] = {
  { "G10", "L1",   0, 0, 2,   2,  1, 0.20, 0, 0,  -1, 0, 0, 1,  4 },
  { "G20", "L2a",  1, 0, 4,   4,  2, 0.20, 1, 0,  -1, 0, 0, 1,  4 },
  { "G30", "L2b",  2, 0, 8,   8,  3, 0.30, 1, 0,  -1, 0, 0, 1,  4 },
  { "C40", "L3c",  3, 1, 0,  16,  4, 0.35, 0, 0,  -1, 0, 0, 1,  4 },
  { "C50", "L3d",  4, 1, 0,  32,  5, 0.40, 0, 0,  -1, 0, 0, 1,  4 },
  { "C60", "L4e",  5, 1, 0,  64,  6, 0.40, 1, 0,  -1, 0, 0, 1,  4 },
  { "C80", "L4f",  6, 1, 0, 256,  8, 0.40, 1, 0,  -1, 0, 0, 1,  4 },

  { "C30", "L3b",  7, 1, 0,   8,  3, 0.30, 0, 1,  0, 0, 0, 2,  8 },
  { "C20", NULL,   7, 1, 0,   4,  2, 0.20, 0, 1,  1, 1, 1, 2,  8 },
  { "C23", NULL,   7, 1, 0,   4,  5, 0.20, 0, 8,  1, 1, 2, 2, 12 },

  { "G13", "L1s",  7, 0, 2,   2,  4, 0.20, 0, 8,  1, 0, 0, 2, 12 },
  { "G23", "L2s",  7, 0, 4,   4,  5, 0.20, 0, 8,  2, 0, 0, 2, 12 },
  { "G33", NULL,   7, 0, 8,   8,  6, 0.30, 0, 8,  2, 0, 1, 2, 12 },
  { "C33", "L3s",  7, 1, 0,   8,  6, 0.30, 0, 8,  3, 0, 0, 2, 12 },
  { "C35", NULL,   7, 1, 0,   8,  8, 0.30, 0, 32, 3, 0, 1, 2, 16 },
  { "C43", "L3t",  7, 1, 0,  16,  7, 0.35, 0, 8,  3, 1, 0, 2, 16 },
  { "C53", NULL,   7, 1, 0,  32,  8, 0.35, 0, 8,  2, 1, 1, 2, 16 },
  { "C63", NULL,   7, 1, 0,  64,  9, 0.40, 0, 8,  2, 1, 2, 2, 16 },
  { "C83", NULL,   7, 1, 0, 256, 11, 0.40, 0, 8,  2, 1, 3, 4, 16 },

  { "G15", "L1u",  7, 0, 2,   2,  6, 0.20, 0, 32, 0, 1, 1, 2, 16 },
  { "G25", NULL,   7, 0, 4,   4,  7, 0.20, 0, 32, 0, 1, 3, 2, 16 },
  { "G35", "L2u",  7, 0, 8,   8,  8, 0.30, 0, 32, 0, 1, 2, 2, 16 },
  { "C25", NULL,   7, 1, 0,   4,  7, 0.30, 0, 32, 1, 1, 3, 2, 16 },
  { "C45", NULL,   7, 1, 0,  16,  9, 0.35, 0, 32, 3, 1, 1, 2, 16 },
  { "C55", "L3u",  7, 1, 0,  32, 10, 0.35, 0, 32, 0, 1, 0, 2, 16 },
  { "C65", "L4eS", 7, 1, 0,  64, 11, 0.40, 0, 32, 1, 1, 0, 2, 16 },
  { "C85", "L4fS", 7, 1, 0, 256, 13, 0.40, 0, 32, 2, 1, 0, 4, 16 },
};

int lcc_encode_layer_count(void) {
  return (int)(sizeof(LAYERS) / sizeof(LAYERS[0]));
}

const LccEncodeLayer *lcc_encode_layer_by_index(int index) {
  if (index < 0 || index >= lcc_encode_layer_count()) return NULL;
  return &LAYERS[index];
}

const LccEncodeLayer *lcc_encode_layer(const char *name) {
  if (!name) return NULL;
  for (int i = 0; i < lcc_encode_layer_count(); i++) {
    if (strcmp(LAYERS[i].name, name) == 0) return &LAYERS[i];
    if (LAYERS[i].legacy && strcmp(LAYERS[i].legacy, name) == 0) return &LAYERS[i];
  }
  return NULL;
}
