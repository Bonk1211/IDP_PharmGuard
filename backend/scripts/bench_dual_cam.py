#!/usr/bin/env python3
"""Bench two CSI cameras running simultaneously on Pi 5.

Records frame intervals on each camera over --duration seconds, prints
mean fps + p50 + p95 + max interval per camera. PRD Phase 2 success
signal: p95 frame interval < 100 ms per camera under simultaneous load.
"""
from __future__ import annotations

import argparse
import logging
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.camera import open_camera  # noqa: E402


def bench_one_pass(duration_s: float, width: int, height: int) -> dict[str, dict[str, float]]:
    cam_a = open_camera(0, width, height)
    cam_b = open_camera(1, width, height)
    intervals: dict[str, list[float]] = {"cam0": [], "cam1": []}
    try:
        deadline = time.time() + duration_s
        last_a = time.perf_counter()
        last_b = time.perf_counter()
        while time.time() < deadline:
            fa = cam_a.read_frame()
            now = time.perf_counter()
            if fa is not None:
                intervals["cam0"].append((now - last_a) * 1000.0)
                last_a = now
            fb = cam_b.read_frame()
            now = time.perf_counter()
            if fb is not None:
                intervals["cam1"].append((now - last_b) * 1000.0)
                last_b = now
    finally:
        cam_a.close()
        cam_b.close()

    def summarise(samples: list[float]) -> dict[str, float]:
        if not samples:
            return {"n": 0, "fps": 0.0, "p50_ms": 0.0, "p95_ms": 0.0, "max_ms": 0.0}
        samples_sorted = sorted(samples)
        return {
            "n": len(samples),
            "fps": 1000.0 / statistics.mean(samples),
            "p50_ms": samples_sorted[len(samples_sorted) // 2],
            "p95_ms": samples_sorted[int(len(samples_sorted) * 0.95)],
            "max_ms": samples_sorted[-1],
        }

    return {k: summarise(v) for k, v in intervals.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--duration", type=float, default=10.0)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    results = bench_one_pass(args.duration, args.width, args.height)
    print(f"\nDual-cam bench ({args.duration:.1f}s, {args.width}x{args.height}):")
    target_p95 = 100.0
    ok = True
    for cam, s in results.items():
        marker = "PASS" if s["p95_ms"] < target_p95 else "FAIL"
        print(
            f"  {cam}: n={int(s['n']):5d}  fps={s['fps']:6.1f}  "
            f"p50={s['p50_ms']:6.1f}ms  p95={s['p95_ms']:6.1f}ms  "
            f"max={s['max_ms']:7.1f}ms  [{marker}]"
        )
        ok = ok and s["p95_ms"] < target_p95
    print(f"\nResult: {'PASS' if ok else 'FAIL'} (target: p95 < {target_p95:.0f} ms per cam)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
