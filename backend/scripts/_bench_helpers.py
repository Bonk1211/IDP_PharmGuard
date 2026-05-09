"""Metrics helpers for bench scripts — pure stdlib.

Phase 6 added ``summarise`` / ``read_csv`` / ``render_report`` for the
end-to-end latency bench. Phase 9 appends confusion-matrix utilities for the
accuracy bench (``bench_accuracy.py`` + ``tune_threshold.py``).
"""

from __future__ import annotations

import csv
import statistics
from collections import Counter
from pathlib import Path
from typing import Iterable, NamedTuple


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


# ──────────────────────────────────────────────────────────────────────
# Phase 9: confusion-matrix helpers (stdlib only)
# ──────────────────────────────────────────────────────────────────────

NO_DETECTION_LABEL = "<no_detection>"


def confusion_matrix(rows: Iterable[tuple[str, str]]) -> dict[tuple[str, str], int]:
    """Build a confusion matrix from ``(true_label, predicted_label)`` pairs.

    Returns a dict keyed by ``(true, pred)`` with frequency counts. Use the
    ``NO_DETECTION_LABEL`` sentinel for images where YOLO produced no
    above-threshold detection.
    """
    m: Counter[tuple[str, str]] = Counter()
    for true, pred in rows:
        m[(true, pred)] += 1
    return dict(m)


def render_confusion(matrix: dict[tuple[str, str], int], labels: list[str]) -> str:
    """Render a confusion matrix as a markdown table.

    Rows = true labels (in ``labels`` order). Columns = predicted labels
    (same order, plus ``NO_DETECTION_LABEL`` if any predictions used it).
    """
    cols = list(labels)
    if any(p == NO_DETECTION_LABEL for (_, p) in matrix.keys()):
        cols.append(NO_DETECTION_LABEL)
    header = "| true \\ pred | " + " | ".join(cols) + " |"
    sep = "|---" * (len(cols) + 1) + "|"
    out = [header, sep]
    for true in labels:
        row = [true]
        for pred in cols:
            row.append(str(matrix.get((true, pred), 0)))
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def per_class_stats(
    matrix: dict[tuple[str, str], int], labels: list[str]
) -> dict[str, dict[str, float]]:
    """Per-class precision, recall, support.

    precision = TP / (TP + FP across all true≠label rows predicted as label)
    recall    = TP / (TP + FN across all label-row predictions ≠ label)
    """
    out: dict[str, dict[str, float]] = {}
    for label in labels:
        tp = matrix.get((label, label), 0)
        fp = sum(c for (t, p), c in matrix.items() if p == label and t != label)
        fn = sum(c for (t, p), c in matrix.items() if t == label and p != label)
        support = tp + fn
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        out[label] = {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "support": support,
            "precision": precision,
            "recall": recall,
        }
    return out


def overall_accuracy(matrix: dict[tuple[str, str], int]) -> tuple[int, int, float]:
    """Return ``(correct, total, accuracy)``."""
    correct = sum(c for (t, p), c in matrix.items() if t == p)
    total = sum(matrix.values())
    acc = correct / total if total else 0.0
    return correct, total, acc


def overall_fpr(matrix: dict[tuple[str, str], int], labels: list[str]) -> float:
    """Wrong-pill-marked-as-correct rate.

    PRD's "false positive" = the dispenser said "pill X" when the real pill
    was Y (Y ≠ X) and Y is itself a real SKU. ``NO_DETECTION_LABEL`` is
    excluded from the numerator — those are missed detections, not FPs.
    Denominator is the total number of predictions in the matrix.
    """
    total = sum(matrix.values())
    if not total:
        return 0.0
    label_set = set(labels)
    fp = sum(c for (t, p), c in matrix.items() if t != p and p in label_set)
    return fp / total
