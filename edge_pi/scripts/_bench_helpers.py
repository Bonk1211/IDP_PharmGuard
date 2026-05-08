"""Metrics helpers for bench_e2e.py — pure stdlib."""

from __future__ import annotations

import csv
import statistics
from pathlib import Path
from typing import NamedTuple


class Stat(NamedTuple):
    n: int
    mean: float
    p50: float
    p95: float
    max: float


def summarise(samples: list[float]) -> Stat:
    if not samples:
        return Stat(0, 0.0, 0.0, 0.0, 0.0)
    s = sorted(samples)
    return Stat(
        n=len(samples),
        mean=statistics.mean(samples),
        p50=s[len(s) // 2],
        p95=s[int(len(s) * 0.95)],
        max=s[-1],
    )


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open() as f:
        return list(csv.DictReader(f))


def render_report(stats: dict[str, Stat], targets: dict[str, float]) -> str:
    """Markdown table: column | n | mean | p50 | p95 | max | target | pass."""
    lines = [
        "| metric | n | mean | p50 | p95 | max | target | pass |",
        "|---|---|---|---|---|---|---|---|",
    ]
    ok = True
    for col, st in stats.items():
        target = targets.get(col)
        if target is None:
            passed = "—"
        else:
            passed = "PASS" if st.p95 < target else "FAIL"
            ok = ok and st.p95 < target
        target_str = f"<{target}" if target is not None else "—"
        lines.append(
            f"| {col} | {st.n} | {st.mean:.1f} | {st.p50:.1f} | "
            f"{st.p95:.1f} | {st.max:.1f} | {target_str} | {passed} |"
        )
    lines.append("")
    lines.append(f"**Overall**: {'PASS' if ok else 'FAIL'}")
    return "\n".join(lines)
