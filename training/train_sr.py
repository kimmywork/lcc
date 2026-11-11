#!/usr/bin/env python3
"""Train the shape-layer 2x residual super-resolution CNN.

The model is deliberately tiny: four 3x3 convolutions and a bilinear skip. It
takes the decoder's 16x16 normalized luminance residual and predicts a 32x32
clean residual. The loss combines pixel reconstruction with the downstream
NCC template decision, so the model is judged on shape recovery rather than
natural-image PSNR.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from sr_common import GRID, SHAPES, TARGET, templates


class SRNet(nn.Module):
    def __init__(self, width: int = 16):
        super().__init__()
        self.c1 = nn.Conv2d(1, width, 3, padding=1)
        self.c2 = nn.Conv2d(width, width, 3, padding=1)
        self.c3 = nn.Conv2d(width, width, 3, padding=1)
        self.c4 = nn.Conv2d(width, 1, 3, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = F.relu(self.c1(x))
        z = F.relu(self.c2(z))
        z = F.relu(self.c3(z))
        z = F.interpolate(z, scale_factor=2, mode="bilinear", align_corners=False)
        z = self.c4(z)
        base = F.interpolate(x, scale_factor=2, mode="bilinear", align_corners=False)
        return base + z


def ncc_scores(pred: torch.Tensor, tmpl: torch.Tensor) -> torch.Tensor:
    b = pred.shape[0]
    a = pred.reshape(b, -1)
    a = a - a.mean(dim=1, keepdim=True)
    t = tmpl.reshape(tmpl.shape[0], -1)
    t = t - t.mean(dim=1, keepdim=True)
    num = a @ t.T
    den = torch.sqrt((a * a).sum(dim=1, keepdim=True) * (t * t).sum(dim=1)[None, :] + 1e-8)
    return num / den


def evaluate(model: nn.Module, x: np.ndarray, y: np.ndarray, shape: np.ndarray, device: str):
    model.eval()
    tmpl = torch.from_numpy(templates(TARGET)).to(device)
    correct = 0
    total = 0
    with torch.no_grad():
        for i in range(0, len(x), 512):
            xb = torch.from_numpy(x[i : i + 512]).to(device)
            sb = torch.from_numpy(shape[i : i + 512]).to(device)
            out = model(xb)
            scores = ncc_scores(out, tmpl).abs()
            # Blank gate on the predicted residual magnitude.
            energy = out.flatten(1).abs().max(dim=1).values
            pred = scores.argmax(dim=1)
            pred = torch.where(energy < 0.35, torch.zeros_like(pred), pred)
            best = scores.max(dim=1).values
            pred = torch.where(best < 0.32, torch.zeros_like(pred), pred)
            correct += int((pred == sb).sum())
            total += int(sb.numel())
    return correct / max(1, total)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/corpus/sr.npz")
    ap.add_argument("--out", default="training/models/sr.pt")
    ap.add_argument("--epochs", type=int, default=36)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1.5e-3)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--hard-repeat", type=int, default=8)
    args = ap.parse_args()

    d = np.load(args.data)
    x = np.concatenate([d["x"], np.repeat(d["x_hard"], args.hard_repeat, axis=0)], axis=0)
    y = np.concatenate([d["y"], np.repeat(d["y_hard"], args.hard_repeat, axis=0)], axis=0)
    shape = np.concatenate([d["shape"], np.repeat(d["shape_hard"], args.hard_repeat)], axis=0)
    # A small amount of hard data stays in evaluation; keep training/eval disjoint
    # by using the provided eval splits only.
    x_eval, y_eval, s_eval = d["x_eval"], d["y_eval"], d["shape_eval"]
    x_hard, y_hard, s_hard = d["x_hard"], d["y_hard"], d["shape_hard"]

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    # MPS does not support all float64 paths used by the NCC loss; float32 is
    # enough for this small model.
    model = SRNet(args.width).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    tmpl = torch.from_numpy(templates(TARGET)).to(device)

    n = len(x)
    rng = np.random.default_rng(7)
    for epoch in range(args.epochs):
        model.train()
        order = rng.permutation(n)
        total_loss = 0.0
        total = 0
        for i in range(0, n, args.batch):
            idx = order[i : i + args.batch]
            xb = torch.from_numpy(x[idx]).to(device)
            yb = torch.from_numpy(y[idx]).to(device)
            sb = torch.from_numpy(shape[idx]).to(device)
            out = model(xb)
            mse = F.mse_loss(out, yb)
            cos = 1 - F.cosine_similarity(out.flatten(1), yb.flatten(1), dim=1).mean()
            scores = ncc_scores(out, tmpl).abs()
            mask = sb > 0
            if bool(mask.any()):
                ce = F.cross_entropy(scores[mask], sb[mask])
            else:
                ce = out.sum() * 0
            blank = sb == 0
            blank_loss = out[blank].abs().mean() if bool(blank.any()) else out.sum() * 0
            loss = mse + 0.5 * cos + 0.15 * ce + 0.8 * blank_loss
            opt.zero_grad()
            loss.backward()
            opt.step()
            total_loss += float(loss.detach()) * len(idx)
            total += len(idx)
        sched.step()
        if (epoch + 1) % 2 == 0 or epoch == 0:
            a_eval = evaluate(model, x_eval, y_eval, s_eval, device)
            a_hard = evaluate(model, x_hard, y_hard, s_hard, device)
            print(
                f"epoch {epoch + 1:02d} loss {total_loss / total:.4f} "
                f"eval {a_eval * 100:.2f}% hard {a_hard * 100:.2f}%"
            )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "width": args.width,
            "grid": GRID,
            "target": TARGET,
        },
        out,
    )
    print(f"wrote {out}")
    print(
        f"final eval {evaluate(model, x_eval, y_eval, s_eval, device) * 100:.2f}% "
        f"hard {evaluate(model, x_hard, y_hard, s_hard, device) * 100:.2f}%"
    )


if __name__ == "__main__":
    main()
