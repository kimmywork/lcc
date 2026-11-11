#!/usr/bin/env python3
"""Generate finder-center heatmap training data from the clean LCC corpus."""

from __future__ import annotations

import argparse
import math
import multiprocessing as mp
import random
from pathlib import Path

import numpy as np
from PIL import Image

from synth import augment, load_manifest

INPUT = 192
STRIDE = 4
HEAT = INPUT // STRIDE


def _one(args):
    idx, clean_root, seed, difficulty = args
    # Each worker gets its own manifest handle to avoid pickling large arrays.
    clean = load_manifest(Path(clean_root))
    rng = random.Random(seed)
    src = clean[idx % len(clean)]
    w = rng.randrange(520, 860)
    h = rng.randrange(440, 860)
    arr, centers = augment(src, rng, out_size=(w, h), difficulty=difficulty)
    gray = np.asarray(Image.fromarray(arr).convert("L").resize((INPUT, INPUT), Image.BILINEAR), dtype=np.uint8)
    # Empty scene: keep the frame but no heatmap.
    if rng.random() < 0.12:
        return gray, np.zeros((HEAT, HEAT), dtype=np.float16), np.zeros((3, 2), dtype=np.float32), 0
    sx = INPUT / w
    sy = INPUT / h
    pts = centers * np.array([sx, sy], dtype=np.float64)
    heat = np.zeros((HEAT, HEAT), dtype=np.float32)
    yy, xx = np.mgrid[0:HEAT, 0:HEAT].astype(np.float32)
    for x, y in pts:
        cx = x / STRIDE - 0.5
        cy = y / STRIDE - 0.5
        sigma = 1.15
        heat = np.maximum(heat, np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma * sigma)))
    return gray, heat.astype(np.float16), pts.astype(np.float32), 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", default="training/corpus/clean")
    ap.add_argument("--out", default="training/corpus/finder.npz")
    ap.add_argument("--count", type=int, default=6400)
    ap.add_argument("--val", type=int, default=800)
    ap.add_argument("--seed", type=int, default=99)
    ap.add_argument("--workers", type=int, default=max(1, mp.cpu_count() - 1))
    args = ap.parse_args()

    total = args.count + args.val
    jobs = []
    for i in range(total):
        difficulty = (i % 20) / 19.0
        jobs.append((i, args.clean, args.seed + i * 7919, difficulty))

    xs = np.zeros((total, INPUT, INPUT), dtype=np.uint8)
    hs = np.zeros((total, HEAT, HEAT), dtype=np.float16)
    cs = np.zeros((total, 3, 2), dtype=np.float32)
    vs = np.zeros(total, dtype=np.uint8)
    with mp.Pool(args.workers) as pool:
        for i, (gray, heat, centers, valid) in enumerate(pool.imap_unordered(_one, jobs, chunksize=8)):
            xs[i] = gray
            hs[i] = heat
            cs[i] = centers
            vs[i] = valid
            if (i + 1) % 200 == 0:
                print(f"\r{i + 1}/{total}", end="", flush=True)
    print()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        x=xs[: args.count],
        heat=hs[: args.count],
        centers=cs[: args.count],
        valid=vs[: args.count],
        x_val=xs[args.count :],
        heat_val=hs[args.count :],
        centers_val=cs[args.count :],
        valid_val=vs[args.count :],
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
