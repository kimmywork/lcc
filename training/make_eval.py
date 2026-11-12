#!/usr/bin/env python3
"""Build a held-out synthetic camera-frame benchmark from the clean corpus."""

from __future__ import annotations

import argparse
import random
from pathlib import Path

import numpy as np

from synth import augment, load_manifest, save_manifest


def effective_module_size(homography_module, N: int) -> int:
    """Return the output-frame module size in pixels near the symbol center."""
    H = np.asarray(homography_module, dtype=np.float64)

    def project(u: float, v: float) -> np.ndarray:
        w = H[2, 0] * u + H[2, 1] * v + H[2, 2]
        return np.array(
            [
                (H[0, 0] * u + H[0, 1] * v + H[0, 2]) / w,
                (H[1, 0] * u + H[1, 1] * v + H[1, 2]) / w,
            ]
        )

    cx = cy = N / 2.0
    p0 = project(cx, cy)
    pu = project(cx + 1.0, cy)
    pv = project(cx, cy + 1.0)
    return int(round((np.linalg.norm(pu - p0) + np.linalg.norm(pv - p0)) / 2.0))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", default="training/corpus/clean")
    ap.add_argument("--out", default="training/corpus/eval")
    ap.add_argument("--count", type=int, default=300)
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()

    clean = load_manifest(Path(args.clean))
    rng = random.Random(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    samples = []
    for i in range(args.count):
        src = clean[i % len(clean)]
        difficulty = (i % 10) / 9.0
        arr, centers, meta = augment(src, rng, difficulty=difficulty, return_meta=True)
        h, w = arr.shape[:2]
        name = f"frame-{i:04d}.rgb"
        arr.tofile(out / name)
        samples.append(
            {
                "file": name,
                "width": w,
                "height": h,
                "payload": src.payload,
                "layer": src.layer,
                "version": src.version,
                "N": src.N,
                "moduleSize": effective_module_size(meta["homographyModule"], src.N),
                "sourceModuleSize": src.module_size,
                "centers": centers.tolist(),
                "homography": meta["homography"],
                "homographyModule": meta["homographyModule"],
                "homographyModuleFlat": np.asarray(meta["homographyModule"]).reshape(-1).tolist(),
                "difficulty": difficulty,
            }
        )
        if (i + 1) % 25 == 0:
            print(f"\r{i + 1}/{args.count}", end="", flush=True)
    save_manifest(out, samples)
    print(f"\nwrote {len(samples)} frames to {out}")


if __name__ == "__main__":
    main()
