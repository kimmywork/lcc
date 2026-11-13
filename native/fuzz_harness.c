/*
 * Native robustness harness for the LCC C core.
 *
 * Build with ASan/UBSan via scripts/fuzz-native.sh.  This is a development
 * gate, not part of the shipped codec.
 *
 * Modes:
 *   safe       random packed buffers + consistent random images + benign
 *              multi-frame stacks.  Must run clean under ASan/UBSan.
 *   mismatch   deliberately passes a 64-byte buffer with 1024x1024
 *              dimensions to lcc_api_decode.  The hardened API must reject it
 *              with LCC_BAD_INPUT and no ASan report.
 *   overflow   packed stack input with width*height*3 overflowing to zero.
 *              The hardened parser must reject it cleanly.
 */

#include "lcc.h"
#include "lcc_encode_internal.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t g_state;

static uint32_t next_u32(void) {
  g_state ^= g_state << 13;
  g_state ^= g_state >> 7;
  g_state ^= g_state << 17;
  return (uint32_t)(g_state >> 11);
}

static int rnd_int(int lo, int hi) {
  if (hi <= lo) return lo;
  return lo + (int)(next_u32() % (uint32_t)(hi - lo + 1));
}

static double rnd_double(double scale) {
  return ((double)(next_u32() & 0xffff) / 65535.0 - 0.5) * 2.0 * scale;
}

static void fill_random(uint8_t *buf, size_t n) {
  for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)next_u32();
}

static void put_i32(uint8_t *p, int v) { memcpy(p, &v, 4); }
static void put_f64(uint8_t *p, double v) { memcpy(p, &v, 8); }

static size_t build_stack(
  uint8_t *out,
  int count,
  int frame_w,
  int frame_h,
  int nbytes,
  int quiet,
  int module,
  int max_dimension,
  int det_N,
  int det_version,
  int det_valid
) {
  size_t offset = 0;
  put_i32(out + offset, count); offset += 4;
  put_i32(out + offset, quiet); offset += 4;
  put_i32(out + offset, module); offset += 4;
  put_i32(out + offset, max_dimension); offset += 4;
  put_i32(out + offset, 257); offset += 4;
  for (int i = 0; i < count; i++) {
    put_i32(out + offset, frame_w); offset += 4;
    put_i32(out + offset, frame_h); offset += 4;
    put_i32(out + offset, nbytes); offset += 4;
    if (nbytes > 0) {
      /* Leave the frame deterministic, not random, so image paths see a
         structured pattern instead of uniform noise. */
      for (int p = 0; p < nbytes; p++) out[offset + p] = (uint8_t)((p / 3) % 251);
      offset += (size_t)nbytes;
    }
    put_i32(out + offset, det_valid); offset += 4;
    put_i32(out + offset, det_version); offset += 4;
    put_i32(out + offset, det_N); offset += 4;
    put_f64(out + offset, 1.0); offset += 8;
    put_i32(out + offset, 0); offset += 4;
    for (int h = 0; h < 9; h++) {
      put_f64(out + offset, 0.0);
      offset += 8;
    }
    put_f64(out + offset, 0.0); offset += 8;
    put_f64(out + offset, 0.0); offset += 8;
    put_f64(out + offset, (double)(8 + (i % 8))); offset += 8;
  }
  return offset;
}


static size_t build_scan(uint8_t *out, int count, int frame_w, int frame_h) {
  size_t offset = 0;
  const int nbytes = frame_w * frame_h * 3;
  put_i32(out + offset, count); offset += 4;
  for (int i = 0; i < count; i++) {
    put_i32(out + offset, frame_w); offset += 4;
    put_i32(out + offset, frame_h); offset += 4;
    put_i32(out + offset, nbytes); offset += 4;
    for (int p = 0; p < nbytes; p++) out[offset + p] = (uint8_t)((p / 3 + i) % 251);
    offset += (size_t)nbytes;
  }
  return offset;
}

static void mode_safe(int iterations) {
  uint8_t *rgb = malloc(256 * 256 * 3);
  uint8_t *packed = malloc(1 << 20);
  if (!rgb || !packed) {
    fprintf(stderr, "allocation failed\n");
    exit(2);
  }
  int accepted = 0;
  int decoded = 0;
  int status_counts[8] = {0};
  for (int i = 0; i < iterations; i++) {
    if (i % 3 == 0) {
      const int n = rnd_int(8, 48);
      const int frame = n * n * 3;
      const size_t len = build_stack(
        packed, 2, n, n, frame,
        rnd_int(0, 4), rnd_int(0, 24), rnd_int(100, 1400),
        rnd_int(21, 177), rnd_int(1, 20), 1);
      {
        const int status = lcc_api_stack(packed, (int)len);
        if (status >= 0 && status < 8) status_counts[status]++;
        if (status == LCC_OK) accepted++;
      }
    } else if (i % 3 == 1) {
      const int n = rnd_int(8, 40);
      const size_t len = build_scan(packed, 2, n, n);
      lcc_api_scan(packed, (int)len);
    }
    if (i % 4 == 0) {
      const int w = rnd_int(8, 96);
      const int h = rnd_int(8, 96);
      const int n = w * h * 3;
      fill_random(rgb, (size_t)n);
      const int status = lcc_api_decode(rgb, (size_t)n, w, h, rnd_int(0, 2));
      if (status == LCC_OK) decoded++;
    }
  }
  printf("safe: iterations=%d decoded=%d stacked=%d stack_status=[ok=%d err=%d bad=%d unsupported=%d]\n",
    iterations, decoded, accepted,
    status_counts[LCC_OK], status_counts[LCC_ERR], status_counts[LCC_BAD_INPUT],
    status_counts[LCC_UNSUPPORTED]);
  free(rgb);
  free(packed);
}

static void mode_mismatch(void) {
  uint8_t *small = malloc(64);
  if (!small) exit(2);
  fill_random(small, 64);
  fprintf(stderr, "calling lcc_api_decode with 1024x1024 dims and a 64-byte buffer\n");
  {
    const int status = lcc_api_decode(small, 64, 1024, 1024, 0);
    if (status != LCC_BAD_INPUT) {
      fprintf(stderr, "mismatch probe: expected LCC_BAD_INPUT, got %d\n", status);
      free(small);
      exit(3);
    }
  }
  free(small);
}

static void mode_overflow(void) {
  uint8_t *packed = malloc(1 << 16);
  if (!packed) exit(2);
  /* 65536 * 65536 * 3 overflows a signed 32-bit int to zero, so the
     nbytes check passes while the buffer holds no pixels. */
  const size_t len = build_stack(
    packed, 2, 65536, 65536, 0, 0, 0, 100, 21, 1, 1);
  fprintf(stderr, "calling lcc_api_stack with overflowing frame dimensions (%zu bytes)\n", len);
  {
    const int status = lcc_api_stack(packed, (int)len);
    if (status != LCC_BAD_INPUT) {
      fprintf(stderr, "overflow probe: expected LCC_BAD_INPUT, got %d\n", status);
      free(packed);
      exit(3);
    }
  }
  free(packed);
}


static void mode_hostile(int iterations) {
  uint8_t *packed = malloc(1 << 20);
  if (!packed) exit(2);
  for (int i = 0; i < iterations; i++) {
    const int n = rnd_int(8, 16);
    if (i % 2 == 0) {
      size_t len = build_scan(packed, 2, n, n);
      for (int k = 0; k < 6; k++) {
        const size_t pos = (size_t)rnd_int(0, (int)(len < 100 ? len : 100) - 1);
        packed[pos] = (uint8_t)next_u32();
      }
      lcc_api_scan(packed, (int)len);
    } else {
      size_t len = build_stack(
        packed, 2, n, n, n * n * 3,
        rnd_int(0, 4), rnd_int(0, 24), rnd_int(200, 800),
        rnd_int(21, 120), rnd_int(1, 20), 1);
      for (int k = 0; k < 6; k++) {
        const size_t pos = (size_t)rnd_int(0, (int)(len < 160 ? len : 160) - 1);
        packed[pos] = (uint8_t)next_u32();
      }
      lcc_api_stack(packed, (int)len);
    }
  }
  free(packed);
}


static void mode_encode(int iterations) {
  uint8_t payload[512];
  int ok = 0;
  int rejected = 0;
  for (int i = 0; i < iterations; i++) {
    const LccEncodeLayer *layer = lcc_encode_layer_by_index(rnd_int(0, lcc_encode_layer_count() - 1));
    const int payload_len = rnd_int(0, (int)sizeof(payload));
    for (int j = 0; j < payload_len; j++) payload[j] = (uint8_t)next_u32();
    LccEncodeOptions options;
    memset(&options, 0, sizeof(options));
    options.layer = layer ? layer->name : "G10";
    options.width = rnd_int(64, 2048);
    options.height = rnd_int(64, 2048);
    options.mode = rnd_int(0, 1);
    options.palette_mode = rnd_int(0, 1);
    options.harmony = rnd_int(0, 1);
    options.constraint = rnd_int(-1, 1);
    options.seed = rnd_int(0, 63);
    options.ecc_index = rnd_int(-1, 3);
    options.boost_ecc = rnd_int(0, 1);
    options.min_module = rnd_int(1, 8);
    options.max_module = rnd_int(8, 64);
    options.quiet_zone = rnd_int(0, 6);
    options.min_version = rnd_int(0, 10);
    options.max_version = rnd_int(options.min_version, 40);
    options.module_size = rnd_int(0, 32);
    options.version = rnd_int(0, options.max_version);
    options.compressed = rnd_int(0, 1);
    options.encrypted = rnd_int(0, 1);
    LccEncodeResult result;
    char error[128];
    const int status = lcc_encode_payload(payload, payload_len, &options, &result, error, (int)sizeof(error));
    if (status == LCC_OK) ok++;
    else rejected++;
    lcc_encode_result_free(&result);
  }
  fprintf(stderr, "encode: iterations=%d ok=%d rejected=%d\n", iterations, ok, rejected);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "safe";
  const int iterations = argc > 2 ? atoi(argv[2]) : 300;
  g_state = (argc > 3 ? strtoull(argv[3], NULL, 10) : 1) | 1;
  if (strcmp(mode, "safe") == 0) {
    mode_safe(iterations);
  } else if (strcmp(mode, "mismatch") == 0) {
    mode_mismatch();
  } else if (strcmp(mode, "overflow") == 0) {
    mode_overflow();
  } else if (strcmp(mode, "encode") == 0) {
    mode_encode(iterations);
  } else if (strcmp(mode, "hostile") == 0) {
    mode_hostile(iterations);
  } else {
    fprintf(stderr, "unknown mode: %s\n", mode);
    return 2;
  }
  return 0;
}
