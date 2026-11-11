#!/usr/bin/env python3
"""Train the small finder-center heatmap network."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

INPUT = 192
STRIDE = 4
HEAT = INPUT // STRIDE


class FinderNet(nn.Module):
    def __init__(self, width: int = 24):
        super().__init__()
        self.c1 = nn.Conv2d(1, 8, 3, stride=2, padding=1)
        self.c2 = nn.Conv2d(8, 16, 3, stride=2, padding=1)
        self.c3 = nn.Conv2d(16, width, 3, stride=2, padding=1)
        self.c4 = nn.Conv2d(width, width, 3, padding=1)
        self.c5 = nn.Conv2d(width, 24, 3, padding=1)
        self.c6 = nn.Conv2d(24, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = F.relu(self.c1(x))
        z = F.relu(self.c2(z))
        z = F.relu(self.c3(z))
        z = F.relu(self.c4(z))
        z = F.relu(self.c5(z))
        z = F.interpolate(z, scale_factor=2, mode="bilinear", align_corners=False)
        return self.c6(z)


def peaks_from_logits(logits: torch.Tensor, threshold: float = 0.25):
    heat = torch.sigmoid(logits[:, 0])
    pooled = F.max_pool2d(heat[:, None], 3, stride=1, padding=1)[:, 0]
    mask = (heat >= pooled) & (heat >= threshold)
    out = []
    for i in range(heat.shape[0]):
        ys, xs = torch.nonzero(mask[i], as_tuple=True)
        if len(xs) == 0:
            out.append(torch.zeros((0, 2), dtype=torch.float32))
            continue
        scores = heat[i, ys, xs]
        order = torch.argsort(scores, descending=True)
        picked = []
        for j in order.tolist():
            p = torch.stack([xs[j].float(), ys[j].float()])
            if all(float((p - q).pow(2).sum()) > 6.0 ** 2 for q in picked):
                picked.append(p)
            if len(picked) == 3:
                break
        out.append(torch.stack(picked) if picked else torch.zeros((0, 2), dtype=torch.float32))
    return out, heat


def evaluate(model: nn.Module, x: np.ndarray, centers: np.ndarray, valid: np.ndarray, device: str):
    model.eval()
    correct = 0
    total = 0
    dists = []
    with torch.no_grad():
        for i in range(0, len(x), 64):
            xb = torch.from_numpy(x[i : i + 64, None].astype(np.float32) / 255.0).to(device)
            logits = model(xb)
            pk, _ = peaks_from_logits(logits)
            for b, pts in enumerate(pk):
                idx = i + b
                total += 1
                if not valid[idx]:
                    if len(pts) == 0:
                        correct += 1
                    continue
                if len(pts) < 3:
                    continue
                gt = torch.from_numpy(centers[idx] / STRIDE - 0.5)
                # Greedy nearest matching.
                remaining = list(range(3))
                ds = []
                for p in pts.tolist():
                    best = min(remaining, key=lambda j: (p[0] - gt[j, 0]) ** 2 + (p[1] - gt[j, 1]) ** 2)
                    d = float(torch.dist(torch.tensor(p), gt[best])) * STRIDE
                    ds.append(d)
                    remaining.remove(best)
                mean_d = sum(ds) / len(ds)
                dists.append(mean_d)
                if len(remaining) == 0 and max(ds) <= 9.0:
                    correct += 1
    return correct / max(1, total), (float(np.mean(dists)) if dists else 0.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/corpus/finder.npz")
    ap.add_argument("--out", default="training/models/finder.pt")
    ap.add_argument("--epochs", type=int, default=26)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--width", type=int, default=24)
    args = ap.parse_args()

    d = np.load(args.data)
    x = d["x"]
    heat = d["heat"].astype(np.float32)
    xv = d["x_val"]
    hv = d["heat_val"]
    cv = d["centers_val"]
    vv = d["valid_val"]

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = FinderNet(args.width).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    n = len(x)
    rng = np.random.default_rng(3)
    for epoch in range(args.epochs):
        model.train()
        order = rng.permutation(n)
        total_loss = 0.0
        total = 0
        for i in range(0, n, args.batch):
            idx = order[i : i + args.batch]
            xb = torch.from_numpy(x[idx, None].astype(np.float32) / 255.0).to(device)
            hb = torch.from_numpy(heat[idx, None]).to(device)
            logits = model(xb)
            loss = F.binary_cross_entropy_with_logits(logits, hb, pos_weight=torch.tensor(24.0, device=device))
            opt.zero_grad()
            loss.backward()
            opt.step()
            total_loss += float(loss.detach()) * len(idx)
            total += len(idx)
        sched.step()
        if (epoch + 1) % 2 == 0 or epoch == 0:
            acc, dist = evaluate(model, xv, cv, vv, device)
            print(f"epoch {epoch + 1:02d} loss {total_loss / total:.4f} recall {acc * 100:.2f}% mean_err {dist:.2f}px")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "width": args.width,
            "input": INPUT,
            "stride": STRIDE,
        },
        out,
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
