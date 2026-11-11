#!/usr/bin/env python3
"""Generate paired low/high-resolution shape-module residuals."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from sr_common import GRID, TARGET, make_sample


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="training/corpus/sr.npz")
    ap.add_argument("--count", type=int, default=40000)
    ap.add_argument("--eval", type=int, default=4000)
    ap.add_argument("--hard", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    total = args.count + args.eval + args.hard
    x = np.zeros((total, 1, GRID, GRID), dtype=np.float32)
    x_native = np.zeros((total, 16, 16), dtype=np.float32)
    grid_n = np.zeros(total, dtype=np.int16)
    y = np.zeros((total, 1, TARGET, TARGET), dtype=np.float32)
    shape = np.zeros(total, dtype=np.int64)
    module = np.zeros(total, dtype=np.int16)
    contrast = np.zeros(total, dtype=np.float32)
    peak = np.zeros(total, dtype=np.float32)
    for i in range(total):
        s = make_sample(rng, hard=(i >= args.count + args.eval))
        x[i, 0] = s.x
        n = s.grid_n
        x_native[i, :n, :n] = s.x_native
        grid_n[i] = n
        y[i, 0] = s.y
        shape[i] = s.shape
        module[i] = s.module_size
        contrast[i] = s.contrast
        peak[i] = s.peak
        if (i + 1) % 2000 == 0:
            print(f"\r{i + 1}/{total}", end="", flush=True)
    print()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        x=x[: args.count],
        x_native=x_native[: args.count],
        grid_n=grid_n[: args.count],
        y=y[: args.count],
        shape=shape[: args.count],
        module=module[: args.count],
        contrast=contrast[: args.count],
        peak=peak[: args.count],
        x_eval=x[args.count : args.count + args.eval],
        x_native_eval=x_native[args.count : args.count + args.eval],
        grid_n_eval=grid_n[args.count : args.count + args.eval],
        y_eval=y[args.count : args.count + args.eval],
        shape_eval=shape[args.count : args.count + args.eval],
        module_eval=module[args.count : args.count + args.eval],
        contrast_eval=contrast[args.count : args.count + args.eval],
        peak_eval=peak[args.count : args.count + args.eval],
        x_hard=x[args.count + args.eval :],
        x_native_hard=x_native[args.count + args.eval :],
        grid_n_hard=grid_n[args.count + args.eval :],
        y_hard=y[args.count + args.eval :],
        shape_hard=shape[args.count + args.eval :],
        module_hard=module[args.count + args.eval :],
        contrast_hard=contrast[args.count + args.eval :],
        peak_hard=peak[args.count + args.eval :],
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
