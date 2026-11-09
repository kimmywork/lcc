#!/usr/bin/env python3
"""Generate QR comparison images for the README.

Requires `segno` (pip install segno); this is only for documentation, not
for the LCC codec itself.
"""

from pathlib import Path

import segno

CASES = [
    ("hello_world", "Hello World!", 512),
    ("quick_brown_fox", "The quick brown fox jumps over the lazy dog.", 512),
    ("lorem_ipsum", Path("examples/lorem_ipsum.txt").read_text(encoding="utf-8"), 512),
    ("heart_sutra", Path("examples/心经.txt").read_text(encoding="utf-8"), 1024),
]

out_dir = Path("demo_outputs")
out_dir.mkdir(parents=True, exist_ok=True)

for name, text, target in CASES:
    qr = segno.make(text, error="m", micro=False)
    size = qr.symbol_size(border=4)[0]
    scale = max(1, target // size)
    path = out_dir / f"qr_{name}.png"
    qr.save(path, scale=scale, border=4)
    print(
        f"{name}: QR v{qr.version} {size}x{size} modules, scale={scale}, "
        f"{len(text.encode('utf-8'))} bytes -> {path}"
    )
