"""Synthetic LCC camera frames built from the Node encoder corpus.

The generator intentionally keeps the ground-truth payload and finder centers so
the same code can build finder training data and decode benchmarks.
"""

from __future__ import annotations

import io
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


@dataclass
class Clean:
    path: Path
    width: int
    height: int
    payload: str
    layer: str
    version: int
    N: int
    module_size: int
    quiet_zone: int
    finders: np.ndarray

    @property
    def image(self) -> np.ndarray:
        raw = np.fromfile(self.path, dtype=np.uint8)
        return raw.reshape(self.height, self.width, 3)


def load_manifest(root: Path) -> list[Clean]:
    data = json.loads((root / "manifest.json").read_text())
    out = []
    for s in data["samples"]:
        out.append(
            Clean(
                path=root / s["file"],
                width=s["width"],
                height=s["height"],
                payload=s["payload"],
                layer=s["layer"],
                version=s["version"],
                N=s["N"],
                module_size=s["moduleSize"],
                quiet_zone=s["quietZone"],
                finders=np.array(s["finders"], dtype=np.float64),
            )
        )
    return out


def _homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    rows = []
    for (x, y), (u, v) in zip(src, dst):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    A = np.asarray(rows, dtype=np.float64)
    _, _, vt = np.linalg.svd(A)
    H = vt[-1].reshape(3, 3)
    return H / H[2, 2]


def apply_h(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    p = np.concatenate([pts, np.ones((len(pts), 1))], axis=1)
    q = p @ H.T
    return q[:, :2] / q[:, 2:3]


def _background(rng: random.Random, w: int, h: int) -> Image.Image:
    kind = rng.randrange(4)
    if kind == 0:
        value = rng.randrange(90, 245)
        return Image.new("RGB", (w, h), (value, value, value))
    # Smooth random low-frequency background.
    small = np.zeros((8, 8, 3), dtype=np.float32)
    base = np.array(
        [rng.randrange(40, 210), rng.randrange(40, 210), rng.randrange(40, 210)],
        dtype=np.float32,
    )
    small[:] = base
    small += np.random.default_rng(rng.randrange(1 << 30)).normal(0, 18, small.shape)
    img = Image.fromarray(np.clip(small, 0, 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    return img


def augment(
    clean: Clean,
    rng: random.Random,
    *,
    out_size: tuple[int, int] | None = None,
    difficulty: float | None = None,
    keep_labels: bool = True,
    return_meta: bool = False,
):
    """Return (rgb uint8 HxWx3, finder centers in output pixels or None).

    With return_meta=True the return value becomes (rgb, centers, meta), where
    meta carries the image homography and the module-space homography used by
    the canonical stacker.
    """
    src = clean.image
    sw, sh = clean.width, clean.height
    if out_size is None:
        base = rng.randrange(720, 1400)
        out_size = (base, base)
    ow, oh = out_size
    if difficulty is None:
        difficulty = rng.random()

    pad = 0.18 + 0.24 * rng.random()
    margin = int(min(ow, oh) * pad)
    x0, y0 = margin, margin
    x1, y1 = ow - margin, oh - margin
    jitter = 0.06 + 0.16 * difficulty
    quad = np.array(
        [
            [x0 + rng.uniform(-jitter, jitter) * (x1 - x0), y0 + rng.uniform(-jitter, jitter) * (y1 - y0)],
            [x1 + rng.uniform(-jitter, jitter) * (x1 - x0), y0 + rng.uniform(-jitter, jitter) * (y1 - y0)],
            [x1 + rng.uniform(-jitter, jitter) * (x1 - x0), y1 + rng.uniform(-jitter, jitter) * (y1 - y0)],
            [x0 + rng.uniform(-jitter, jitter) * (x1 - x0), y1 + rng.uniform(-jitter, jitter) * (y1 - y0)],
        ],
        dtype=np.float64,
    )
    # Rotate the quad around its center a little.
    angle = rng.uniform(-0.20, 0.20) * difficulty
    c = np.array([(x0 + x1) / 2, (y0 + y1) / 2])
    ca, sa = math.cos(angle), math.sin(angle)
    R = np.array([[ca, -sa], [sa, ca]])
    quad = (quad - c) @ R.T + c

    srcq = np.array([[0, 0], [sw, 0], [sw, sh], [0, sh]], dtype=np.float64)
    H = _homography(srcq, quad)
    Hinv = np.linalg.inv(H)
    Hinv = Hinv / Hinv[2, 2]
    coeffs = (
        Hinv[0, 0], Hinv[0, 1], Hinv[0, 2],
        Hinv[1, 0], Hinv[1, 1], Hinv[1, 2],
        Hinv[2, 0], Hinv[2, 1], Hinv[2, 2],
    )

    rgba = Image.fromarray(src, "RGB").convert("RGBA")
    warped = rgba.transform(
        (ow, oh), Image.PERSPECTIVE, coeffs, resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0)
    )
    bg = _background(rng, ow, oh).convert("RGBA")
    frame = Image.alpha_composite(bg, warped)

    # Blur: Gaussian, stronger when modules are small.
    small_module = clean.module_size <= 14
    blur = rng.uniform(0.0, 0.8 + 1.8 * difficulty) + (1.2 if small_module else 0.0)
    if blur > 0.15:
        frame = frame.filter(ImageFilter.GaussianBlur(blur))

    arr = np.asarray(frame.convert("RGB"), dtype=np.float32)

    # Directional motion blur (simple horizontal/vertical smearing).
    if rng.random() < 0.25:
        k = rng.randrange(2, 8)
        axis = rng.randrange(2)
        kernel = np.zeros((k, k), dtype=np.float32)
        if axis == 0:
            kernel[k // 2, :] = 1.0 / k
        else:
            kernel[:, k // 2] = 1.0 / k
        from scipy.ndimage import convolve

        arr = np.stack([convolve(arr[:, :, c], kernel, mode="nearest") for c in range(3)], axis=2)

    # Screen-like moire / banding.
    if rng.random() < 0.20:
        yy, xx = np.mgrid[0:oh, 0:ow]
        period = rng.uniform(7, 30)
        phase = rng.uniform(0, math.tau)
        band = 1.0 + rng.uniform(0.02, 0.10) * np.sin(xx / period + phase)
        arr *= band[:, :, None]

    # Per-channel cast and exposure.
    gains = np.array([rng.uniform(0.82, 1.12) for _ in range(3)], dtype=np.float32)
    bias = np.array([rng.uniform(-14, 14) for _ in range(3)], dtype=np.float32)
    arr = arr * gains + bias

    # Sensor noise.
    sigma = rng.uniform(0, 5 + 16 * difficulty)
    if sigma > 0.2:
        arr += np.random.default_rng(rng.randrange(1 << 30)).normal(0, sigma, arr.shape)

    arr = np.clip(arr, 0, 255).astype(np.uint8)

    # JPEG compression.
    quality = int(max(25, 92 - 60 * difficulty + rng.uniform(-8, 8)))
    if rng.random() < 0.85:
        bio = io.BytesIO()
        Image.fromarray(arr).save(bio, format="JPEG", quality=quality)
        arr = np.asarray(Image.open(io.BytesIO(bio.getvalue())).convert("RGB"), dtype=np.uint8)

    centers = apply_h(H, clean.finders) if keep_labels else None
    if not return_meta:
        return arr, centers

    # H maps clean-image pixels to the augmented frame. LccFound.H maps symbol
    # module coordinates (including the quiet zone offset) to frame pixels.
    s = clean.module_size
    qz = clean.quiet_zone
    T = np.array([[s, 0, qz * s], [0, s, qz * s], [0, 0, 1]], dtype=np.float64)
    H_module = H @ T
    return arr, centers, {
        "homography": H.tolist(),
        "homographyModule": H_module.tolist(),
        "sourceWidth": sw,
        "sourceHeight": sh,
    }


def save_manifest(root: Path, samples: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps({"samples": samples}, indent=2))
