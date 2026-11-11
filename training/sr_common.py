"""Shared synthetic module generator for the shape-layer super-resolution test.

The decoder turns each module into a small luminance-residual grid. Shape layers
add one of eight strokes on top of a background colour. The generator below
renders a high-resolution module, degrades it to the grid the C decoder sees,
and keeps the clean high-resolution residual as the SR target.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates, shift as nd_shift

SHAPES = 8
GRID = 16
TARGET = 32


def _segments(shape: int, size: float, inset: float):
    lo = inset
    hi = size - inset
    mid = size / 2.0
    square = max(inset, round(size / 4.0))
    slo = square
    shi = size - square
    if shape == 1:
        return [(lo, hi, hi, lo)]
    if shape == 2:
        return [(lo, lo, hi, hi)]
    if shape == 3:
        return [(lo, hi, hi, lo), (lo, lo, hi, hi)]
    if shape == 4:
        return [(lo, mid, hi, mid), (mid, lo, mid, hi)]
    if shape == 5:
        return [(lo, mid, hi, mid)]
    if shape == 6:
        return [(mid, lo, mid, hi)]
    if shape == 7:
        return [
            (slo, slo, shi, slo),
            (shi, slo, shi, shi),
            (shi, shi, slo, shi),
            (slo, shi, slo, slo),
        ]
    return []


def _dist_seg(px, py, x1, y1, x2, y2):
    dx = x2 - x1
    dy = y2 - y1
    len2 = dx * dx + dy * dy
    if len2 == 0:
        return np.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / len2
    t = np.clip(t, 0, 1)
    return np.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def shape_mask(shape: int, size: int, line: int | None = None, inset: int | None = None) -> np.ndarray:
    if line is None:
        line = max(1, round(size / 8))
    if inset is None:
        inset = max(1, round(size / 16))
    m = np.zeros((size, size), dtype=np.float32)
    if shape <= 0:
        return m
    segs = _segments(shape, size, inset)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    px = xx + 0.5
    py = yy + 0.5
    half = max(0.5, line / 2.0)
    for x1, y1, x2, y2 in segs:
        m = np.maximum(m, (_dist_seg(px, py, x1, y1, x2, y2) <= half).astype(np.float32))
    return m


def _resize(img: np.ndarray, size: int, order: int = 1) -> np.ndarray:
    h, w = img.shape
    yy = (np.arange(size) + 0.5) * h / size - 0.5
    xx = (np.arange(size) + 0.5) * w / size - 0.5
    gy, gx = np.meshgrid(yy, xx, indexing="ij")
    return map_coordinates(img, [gy, gx], order=order, mode="nearest")


def _normalize(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32)
    x = x - x.mean()
    std = x.std()
    if std < 1e-6:
        return np.zeros_like(x)
    return x / std


@dataclass
class ModuleSample:
    x: np.ndarray       # GRID x GRID normalized low-res residual (SR input)
    x_native: np.ndarray  # grid_n x grid_n residual as the current decoder sees it
    grid_n: int
    y: np.ndarray       # TARGET x TARGET normalized high-res residual
    shape: int
    module_size: int
    contrast: float
    blur: float
    peak: float


def make_sample(rng: np.random.Generator, shape: int | None = None, hard: bool = False) -> ModuleSample:
    if shape is None:
        shape = int(rng.integers(0, SHAPES))
    if hard:
        module_size = int(rng.integers(6, 14))
    else:
        module_size = int(rng.integers(8, 25))
    grid_n = int(np.clip(round(module_size), 8, 16))

    # Background and foreground luminance, with either polarity.
    bg = float(rng.uniform(55, 205))
    contrast = float(rng.uniform(15, 55)) if hard else float(rng.uniform(18, 120))
    if rng.random() < 0.5:
        contrast = -contrast
    fg = float(np.clip(bg + contrast, 0, 255))

    # High-resolution clean residual (64 -> 32).
    hi_n = 64
    mask_hi = shape_mask(shape, hi_n, max(1, round(hi_n / 8)), max(1, round(hi_n / 16)))
    # Misalignment at the high-resolution render.
    amt = 2.4 if hard else 1.6
    dy = float(rng.uniform(-amt, amt))
    dx = float(rng.uniform(-amt, amt))
    mask_hi = nd_shift(mask_hi, (dy, dx), order=1, mode="constant", cval=0.0)
    hi_blur = float(rng.uniform(0.2, 1.8)) if hard else float(rng.uniform(0.0, 1.2))
    if hi_blur > 0.05:
        mask_hi = gaussian_filter(mask_hi, hi_blur, mode="nearest")
    hi = mask_hi * (fg - bg)
    target = _resize(hi, TARGET, order=1)
    y = _normalize(target)

    # Low-resolution capture: render at the true module size, blur, then
    # resample to the grid the C decoder builds.
    s = module_size
    mask_s = shape_mask(shape, s, max(1, round(s / 8)), max(1, round(s / 16)))
    mask_s = nd_shift(mask_s, (dy * s / hi_n, dx * s / hi_n), order=1, mode="constant", cval=0.0)
    blur = float(rng.uniform(1.4, 3.6)) if hard else float(rng.uniform(0.0, 1.6))
    if blur > 0.05:
        # Blur in output pixel units, then converted to the module's pixels.
        mask_s = gaussian_filter(mask_s, blur * s / 16.0, mode="nearest")
    low = mask_s * (fg - bg)
    low = _resize(low, grid_n, order=1)

    # C decoder estimates the background from the module border.
    border = np.concatenate([low[0], low[-1], low[1:-1, 0], low[1:-1, -1]])
    level = float(np.median(border))
    lower = low - level
    noise = float(rng.uniform(8, 26)) if hard else float(rng.uniform(0, 7))
    if noise > 0.05:
        lower = lower + rng.normal(0, noise, lower.shape)
    peak = float(np.abs(lower).max())
    # The current decoder matches at grid_n x grid_n. The SR branch resamples
    # the same residual to a fixed 16x16 input.
    x_native = _normalize(lower)
    x = _normalize(_resize(lower, GRID, order=1))
    # Very low contrast: keep the input weak so the blank gate can reject it.
    if abs(contrast) < 20:
        x *= abs(contrast) / 20.0
        x_native *= abs(contrast) / 20.0
    return ModuleSample(
        x=x,
        x_native=x_native,
        grid_n=grid_n,
        y=y,
        shape=shape,
        module_size=module_size,
        contrast=contrast,
        blur=blur,
        peak=peak,
    )


def templates(size: int = TARGET) -> np.ndarray:
    out = np.zeros((SHAPES, size, size), dtype=np.float32)
    for s in range(SHAPES):
        out[s] = shape_mask(s, size, max(1, round(size / 8)), max(1, round(size / 16)))
    return out


def ncc_map(pred: np.ndarray, tmpl: np.ndarray) -> float:
    a = pred.reshape(-1).astype(np.float64)
    b = tmpl.reshape(-1).astype(np.float64)
    a = a - a.mean()
    b = b - b.mean()
    den = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    if den < 1e-9:
        return 0.0
    return float((a * b).sum() / den)


def _sharpen(res: np.ndarray) -> np.ndarray:
    n = res.shape[0]
    blurred = np.zeros_like(res)
    for y in range(n):
        for x in range(n):
            y0, y1 = max(0, y - 1), min(n, y + 2)
            x0, x1 = max(0, x - 1), min(n, x + 2)
            blurred[y, x] = res[y0:y1, x0:x1].mean()
    return res + 0.8 * (res - blurred)


def classify_baseline(
    x: np.ndarray,
    grid_n: int | None = None,
    *,
    sharpen: bool | None = None,
    abs_score: bool = False,
) -> int:
    # What the decoder does today: match at the native grid resolution.
    n = grid_n or x.shape[-1]
    if grid_n is not None and x.shape[-1] != grid_n:
        x = _resize(x, grid_n, order=1)
    if np.abs(x).max() < 0.35:
        return 0
    if sharpen is None:
        sharpen = n < 12
    if sharpen:
        x = _sharpen(x)
    tmpl = templates(n)
    scores = [0.0]
    for s in range(1, SHAPES):
        v = ncc_map(x, tmpl[s])
        scores.append(abs(v) if abs_score else v)
    best = int(np.argmax(scores))
    return best if scores[best] >= 0.32 else 0


def classify_sr(pred: np.ndarray, *, abs_score: bool = True) -> int:
    if np.abs(pred).max() < 0.35:
        return 0
    tmpl = templates(TARGET)
    scores = [0.0]
    for s in range(1, SHAPES):
        v = ncc_map(pred, tmpl[s])
        scores.append(abs(v) if abs_score else v)
    best = int(np.argmax(scores))
    return best if scores[best] >= 0.32 else 0
