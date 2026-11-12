#!/usr/bin/env python3
"""Axis-aligned degraded shape-layer frames: isolates shape decoding from finder detection."""

from __future__ import annotations

import argparse
import io
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from synth import load_manifest, save_manifest

LEGACY_LAYER_ALIASES = {
    "L1s": "G13",
    "L2s": "G23",
    "L3s": "C33",
    "L3t": "C43",
}

SHAPE_LAYERS = ("G13", "G23", "C33", "C43")


def degrade(arr: np.ndarray, rng: random.Random, difficulty: float) -> np.ndarray:
    img = Image.fromarray(arr)
    blur = rng.uniform(0.2, 2.8) * (0.5 + difficulty)
    img = img.filter(ImageFilter.GaussianBlur(blur))
    out = np.asarray(img, dtype=np.float32)
    gains = np.array([rng.uniform(0.88, 1.08) for _ in range(3)], dtype=np.float32)
    bias = np.array([rng.uniform(-8, 8) for _ in range(3)], dtype=np.float32)
    out = out * gains + bias
    out += np.random.default_rng(rng.randrange(1 << 30)).normal(0, 3 + 8 * difficulty, out.shape)
    out = np.clip(out, 0, 255).astype(np.uint8)
    bio = io.BytesIO()
    Image.fromarray(out).save(bio, format="JPEG", quality=int(90 - 45 * difficulty))
    return np.asarray(Image.open(io.BytesIO(bio.getvalue())).convert("RGB"), dtype=np.uint8)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", default="training/corpus/clean")
    ap.add_argument("--out", default="training/corpus/blur_shape")
    ap.add_argument("--count", type=int, default=240)
    ap.add_argument("--seed", type=int, default=4242)
    args = ap.parse_args()
    clean = [
        c for c in load_manifest(Path(args.clean))
        if LEGACY_LAYER_ALIASES.get(c.layer, c.layer) in SHAPE_LAYERS
    ]
    if not clean:
        raise SystemExit(
            "no " + ", ".join(SHAPE_LAYERS) + " samples in " + str(args.clean) +
            "; regenerate the clean corpus or check its manifest"
        )
    rng = random.Random(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    samples = []
    for i in range(args.count):
        src = clean[i % len(clean)]
        difficulty = (i % 10) / 9.0
        arr = degrade(src.image, rng, difficulty)
        name = f"blur-{i:04d}.rgb"
        arr.tofile(out / name)
        h, w = arr.shape[:2]
        samples.append(
            {
                "file": name,
                "width": w,
                "height": h,
                "payload": src.payload,
                "layer": LEGACY_LAYER_ALIASES.get(src.layer, src.layer),
                "version": src.version,
                "N": src.N,
                "moduleSize": src.module_size,
                "difficulty": difficulty,
            }
        )
        if (i + 1) % 25 == 0:
            print(f"\r{i + 1}/{args.count}", end="", flush=True)
    save_manifest(out, samples)
    print(f"\nwrote {len(samples)} frames to {out}")


if __name__ == "__main__":
    main()
