#!/usr/bin/env python3
"""Train a small shape classifier on the residual grids the C decoder actually sees."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

DTYPE = np.dtype([
    ("sample", "<i4"), ("row", "<i4"), ("col", "<i4"),
    ("gridN", "<i4"), ("expected", "<i4"), ("cshape", "<i4"),
    ("res", "<f4", (256,)),
])


class ShapeNet(nn.Module):
    def __init__(self, width: int = 16):
        super().__init__()
        self.c1 = nn.Conv2d(1, width, 3, padding=1)
        self.c2 = nn.Conv2d(width, width, 3, padding=1)
        self.c3 = nn.Conv2d(width, width, 3, padding=1)
        self.fc = nn.Linear(width * 2, 8)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = F.relu(self.c1(x))
        z = F.relu(self.c2(z))
        z = F.relu(self.c3(z))
        avg = F.adaptive_avg_pool2d(z, 1).flatten(1)
        mx = F.adaptive_max_pool2d(z, 1).flatten(1)
        return self.fc(torch.cat([avg, mx], dim=1))


def load(path: str):
    d = np.fromfile(path, dtype=DTYPE, offset=12)
    return d["res"].reshape(-1, 1, 16, 16), d["expected"].astype(np.int64), d["sample"], d["cshape"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/corpus/c_residuals/residuals.bin")
    ap.add_argument("--out", default="training/models/shape_cls.pt")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=1.5e-3)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--val-every", type=int, default=5)
    args = ap.parse_args()

    x, y, sample, cshape = load(args.data)
    val_mask = (sample % args.val_every) == 0
    xt, yt = x[~val_mask], y[~val_mask]
    xv, yv = x[val_mask], y[val_mask]
    cv = cshape[val_mask]
    print(f"train {len(xt)} val {len(xv)}  C baseline on val {(cv == yv).mean():.4f}")

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = ShapeNet(args.width).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    rng = np.random.default_rng(5)
    for epoch in range(args.epochs):
        model.train()
        order = rng.permutation(len(xt))
        total = 0.0
        for i in range(0, len(xt), args.batch):
            idx = order[i : i + args.batch]
            xb = torch.from_numpy(xt[idx]).to(device)
            yb = torch.from_numpy(yt[idx]).to(device)
            loss = F.cross_entropy(model(xb), yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss.detach()) * len(idx)
        sched.step()
        if (epoch + 1) % 2 == 0 or epoch == 0:
            model.eval()
            correct = 0
            with torch.no_grad():
                for i in range(0, len(xv), 2048):
                    xb = torch.from_numpy(xv[i : i + 2048]).to(device)
                    yb = torch.from_numpy(yv[i : i + 2048]).to(device)
                    correct += int((model(xb).argmax(1) == yb).sum())
            print(f"epoch {epoch + 1:02d} loss {total / len(xt):.4f} val {correct / len(xv) * 100:.2f}%")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "width": args.width, "grid": 16}, out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
