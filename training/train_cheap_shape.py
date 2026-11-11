#!/usr/bin/env python3
"""Train a cheap shape classifier on the C decoder's actual residual grids.

Features are the absolute 16x16 residual plus row/column/diagonal projections
and four radial band energies.  A 324->64->8 MLP is ~21k MAC/module, roughly
1/18 of the width-8 CNN.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn
from sklearn.preprocessing import StandardScaler

DTYPE = np.dtype([
    ("sample", "<i4"), ("row", "<i4"), ("col", "<i4"),
    ("gridN", "<i4"), ("expected", "<i4"), ("cshape", "<i4"),
    ("res", "<f4", (256,)),
])


def features(res: np.ndarray) -> np.ndarray:
    """res: [N,256] signed normalized residual -> [N,324] float32."""
    a = np.abs(res.reshape(-1, 16, 16)).astype(np.float32)
    rows = a.sum(axis=2)
    cols = a.sum(axis=1)
    diag = np.zeros((len(a), 31), dtype=np.float32)
    anti = np.zeros((len(a), 31), dtype=np.float32)
    for y in range(16):
        for x in range(16):
            diag[:, y - x + 15] += a[:, y, x]
            anti[:, y + x] += a[:, y, x]
    # linspace(0,30,16) has step 2, so this is exact.
    diag16 = diag[:, ::2]
    anti16 = anti[:, ::2]
    yy, xx = np.mgrid[0:16, 0:16]
    rr = np.sqrt((yy - 7.5) ** 2 + (xx - 7.5) ** 2)
    bands = []
    for lo, hi in [(0, 3), (3, 6), (6, 9), (9, 12)]:
        m = ((rr >= lo) & (rr < hi)).astype(np.float32)
        bands.append((a * a * m).sum(axis=(1, 2)))
    return np.concatenate([
        a.reshape(-1, 256), rows, cols, diag16, anti16, np.stack(bands, axis=1),
    ], axis=1).astype(np.float32)


class CheapShapeNet(nn.Module):
    def __init__(self, in_features: int = 324, hidden: int = 64):
        super().__init__()
        self.fc1 = nn.Linear(in_features, hidden)
        self.fc2 = nn.Linear(hidden, 8)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(F.relu(self.fc1(x)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/corpus/c_residuals/residuals.bin")
    ap.add_argument("--out", default="training/models/cheap_shape.pt")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--val-every", type=int, default=5)
    args = ap.parse_args()

    d = np.fromfile(args.data, dtype=DTYPE, offset=12)
    res = d["res"].astype(np.float32)
    y = d["expected"].astype(np.int64)
    sample = d["sample"]
    f = features(res)
    val = (sample % args.val_every) == 0
    scaler = StandardScaler().fit(f[~val])
    xt = scaler.transform(f[~val]).astype(np.float32)
    xv = scaler.transform(f[val]).astype(np.float32)
    yt, yv = y[~val], y[val]
    cval = d["cshape"][val]
    print(f"train {len(xt)} val {len(xv)} C baseline {(cval == yv).mean():.4f}")

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = CheapShapeNet(f.shape[1], args.hidden).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    xt_t = torch.from_numpy(xt).to(device)
    yt_t = torch.from_numpy(yt).to(device)
    xv_t = torch.from_numpy(xv).to(device)
    yv_t = torch.from_numpy(yv).to(device)

    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(len(xt_t), device=device)
        total = 0.0
        for i in range(0, len(xt_t), args.batch):
            idx = perm[i : i + args.batch]
            loss = F.cross_entropy(model(xt_t[idx]), yt_t[idx])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss.detach()) * len(idx)
        sched.step()
        if (epoch + 1) % 2 == 0 or epoch == 0:
            model.eval()
            correct = 0
            with torch.no_grad():
                for i in range(0, len(xv_t), 8192):
                    correct += int((model(xv_t[i : i + 8192]).argmax(1) == yv_t[i : i + 8192]).sum())
            print(f"epoch {epoch + 1:02d} loss {total / len(xt_t):.4f} val {correct / len(xv_t) * 100:.2f}%")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": model.state_dict(),
        "in_features": int(f.shape[1]),
        "hidden": args.hidden,
        "grid": 16,
        "mean": scaler.mean_.astype(np.float32),
        "scale": scaler.scale_.astype(np.float32),
        "feature_order": "abs256,row16,col16,diag16,anti16,bands4",
    }, out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
