#!/usr/bin/env python3
"""E1: oracle-erasure upper bound from forced-alignment C residuals.

Reads the version-3 E1 dump (expected/C symbols per module) and compares:
  - hard errors-only RS budget: 2*error_bytes <= parity
  - oracle erasure budget: erased_bytes <= parity
where a byte is erased if any module touching it is wrong.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

DTYPE = np.dtype([
    ("sample", "<i4"), ("module", "<i4"), ("row", "<i4"), ("col", "<i4"),
    ("gridN", "<i4"), ("expectedShape", "<i4"), ("cShape", "<i4"),
    ("expectedSymbol", "<i4"), ("cSymbol", "<i4"), ("res", "<f4", (256,)),
])


def blocks_for(total: int, ecc: float):
    nb = max(1, math.ceil(total / 255))
    base = total // nb
    rem = total % nb
    blocks = []
    for i in range(nb):
        n = base + (1 if i < rem else 0)
        parity = max(1, min(n - 1, math.floor(n * ecc + 0.5)))
        blocks.append((n, n - parity, parity))
    max_n = max(b[0] for b in blocks)
    byte_block = [-1] * total
    p = 0
    for col in range(max_n):
        for bi, (n, _k, _p) in enumerate(blocks):
            if col < n:
                byte_block[p] = bi
                p += 1
    return blocks, byte_block


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/corpus/e1_residuals/residuals.bin")
    ap.add_argument("--manifest", default="training/corpus/e1_residuals/manifest.json")
    args = ap.parse_args()

    d = np.fromfile(args.data, dtype=DTYPE, offset=12)
    manifest = json.loads(Path(args.manifest).read_text())["samples"]
    by_sample = defaultdict(list)
    for rec in d:
        by_sample[int(rec["sample"])].append(rec)

    results = []
    for si, sample in enumerate(manifest):
        recs = by_sample.get(si, [])
        if not recs:
            continue
        bits = int(sample["bitsPerModule"])
        data_count = int(sample["dataCount"])
        by_module = {int(r["module"]): r for r in recs}
        if len(by_module) < data_count:
            # Missing modules: conservative skip for now.
            results.append({"layer": sample["layer"], "status": sample["status"], "skipped": True,
                            "records": len(by_module), "dataCount": data_count})
            continue
        total_bytes = (data_count * bits) // 8
        exp_bits = np.zeros(total_bytes * 8, dtype=np.uint8)
        got_bits = np.zeros(total_bytes * 8, dtype=np.uint8)
        wrong_modules = []
        for idx in range(data_count):
            r = by_module.get(idx)
            if r is None:
                exp_bits[:] = 0
                break
            e = int(r["expectedSymbol"])
            c = int(r["cSymbol"])
            pos = idx * bits
            diff = False
            for j in range(bits):
                sh = bits - 1 - j
                if pos + j >= len(exp_bits):
                    continue
                exp_bits[pos + j] = (e >> sh) & 1
                got_bits[pos + j] = (c >> sh) & 1
                if exp_bits[pos + j] != got_bits[pos + j]:
                    diff = True
            if diff:
                wrong_modules.append(idx)
        exp_bytes = np.packbits(exp_bits).tobytes()
        got_bytes = np.packbits(got_bits).tobytes()
        error_bytes = np.frombuffer(
            bytes(1 if a != b else 0 for a, b in zip(exp_bytes, got_bytes)),
            dtype=np.uint8,
        )
        erasure_bytes = np.zeros(total_bytes, dtype=np.uint8)
        for idx in wrong_modules:
            a = (idx * bits) // 8
            b = (idx * bits + bits - 1) // 8
            erasure_bytes[a:b + 1] = 1
        blocks, byte_block = blocks_for(total_bytes, float(sample["ecc"]))
        hard_ok = True
        oracle_ok = True
        hard_u = 0.0
        oracle_u = 0.0
        for bi, (n, k, parity) in enumerate(blocks):
            idxs = [p for p in range(total_bytes) if byte_block[p] == bi]
            e = int(error_bytes[idxs].sum())
            s = int(erasure_bytes[idxs].sum())
            hard_ok = hard_ok and (2 * e <= parity)
            oracle_ok = oracle_ok and (s <= parity)
            hard_u = max(hard_u, (2 * e) / parity)
            oracle_u = max(oracle_u, s / parity)
        results.append({
            "layer": sample["layer"],
            "status": sample["status"],
            "skipped": False,
            "bits": bits,
            "dataCount": data_count,
            "wrongModules": len(wrong_modules),
            "totalBytes": total_bytes,
            "hardOk": hard_ok,
            "oracleOk": oracle_ok,
            "hardU": hard_u,
            "oracleU": oracle_u,
        })

    ok = [r for r in results if not r.get("skipped")]
    print(f"samples {len(results)} usable {len(ok)} skipped {len(results)-len(ok)}")
    print(f"C actual status=0: {sum(1 for r in results if r['status']==0)}")
    print(f"hard pass: {sum(1 for r in ok if r['hardOk'])}/{len(ok)}")
    print(f"oracle pass: {sum(1 for r in ok if r['oracleOk'])}/{len(ok)}")
    for layer in sorted({r["layer"] for r in ok}):
        rows = [r for r in ok if r["layer"] == layer]
        print(f"{layer:5s} n={len(rows):2d} hard={sum(r['hardOk'] for r in rows):2d} "
              f"oracle={sum(r['oracleOk'] for r in rows):2d} "
              f"meanHardU={np.mean([r['hardU'] for r in rows]):.2f} "
              f"meanOracleU={np.mean([r['oracleU'] for r in rows]):.2f}")
    print("details:")
    for r in results:
        if r.get("skipped"):
            print(f"  {r['layer']} skipped records={r['records']}/{r['dataCount']}")
        else:
            print(f"  {r['layer']:5s} status={r['status']} wrong={r['wrongModules']:4d}/{r['dataCount']:4d} "
                  f"hard={'Y' if r['hardOk'] else 'n'} oracle={'Y' if r['oracleOk'] else 'n'} "
                  f"Uhard={r['hardU']:.2f} Uora={r['oracleU']:.2f}")


if __name__ == "__main__":
    main()
