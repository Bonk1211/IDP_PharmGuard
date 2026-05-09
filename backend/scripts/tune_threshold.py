#!/usr/bin/env python3
"""Sweep YOLO confidence threshold to pick a value meeting PRD Phase 9 targets.

Walks the labelled dataset once per threshold value (0.30 ... 0.80 in 0.05
steps by default) and prints accuracy and FPR at each threshold. Operator
picks the threshold that meets PRD targets and edits
``PillVerifier.conf_thresh`` (or passes it to the constructor) accordingly.

Reuses ``discover_dataset`` and ``predict_one`` from ``bench_accuracy`` so
the threshold sweep and the headline bench share the same inference path.

Output: markdown table to stdout, plus a "Best threshold" line. Exit 1
when no threshold meets BOTH PRD targets on the supplied dataset.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts._bench_helpers import (  # noqa: E402
    confusion_matrix,
    overall_accuracy,
    overall_fpr,
)
from scripts.bench_accuracy import discover_dataset, predict_one  # noqa: E402

log = logging.getLogger(__name__)

ACCURACY_TARGET = 0.99
FPR_TARGET = 0.001


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dataset", required=True, help="Path to labelled dataset root")
    ap.add_argument(
        "--model",
        default="models/pill_detector.pt",
        help="Path to YOLO .pt weights (default: models/pill_detector.pt)",
    )
    ap.add_argument("--start", type=float, default=0.30)
    ap.add_argument("--stop", type=float, default=0.80)
    ap.add_argument("--step", type=float, default=0.05)
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
    )

    # Imported inside main so --help works on machines without ultralytics.
    from ultralytics import YOLO  # noqa: WPS433

    root = Path(args.dataset).resolve()
    if not root.is_dir():
        log.error("Dataset root not found: %s", root)
        return 2

    classes = discover_dataset(root)
    if not classes:
        log.error("No class folders with images found under %s", root)
        return 2
    labels = sorted(classes.keys())
    total = sum(len(v) for v in classes.values())
    log.info("Loaded %d classes / %d images", len(classes), total)

    log.info("Loading YOLO from %s", args.model)
    model = YOLO(args.model)

    thresholds: list[float] = []
    x = args.start
    while x <= args.stop + 1e-9:
        thresholds.append(round(x, 4))
        x += args.step

    print()
    print("| threshold | accuracy | FPR | acc_pass | fpr_pass |")
    print("|---|---|---|---|---|")
    best: tuple[float, float, float] | None = None  # (thresh, acc, fpr)
    for thresh in thresholds:
        rows: list[tuple[str, str]] = []
        for true_label in labels:
            for img_path in classes[true_label]:
                pred_label, _ = predict_one(model, img_path, thresh)
                rows.append((true_label, pred_label))
        matrix = confusion_matrix(rows)
        _, _, acc = overall_accuracy(matrix)
        fpr = overall_fpr(matrix, labels)
        acc_pass = acc >= ACCURACY_TARGET
        fpr_pass = fpr < FPR_TARGET
        marker_a = "PASS" if acc_pass else "FAIL"
        marker_f = "PASS" if fpr_pass else "FAIL"
        print(
            f"| {thresh:.2f} | {acc:.4f} | {fpr:.4f} | {marker_a} | {marker_f} |"
        )
        if acc_pass and fpr_pass and (best is None or acc > best[1]):
            best = (thresh, acc, fpr)

    print()
    if best is None:
        print("No threshold meets BOTH PRD targets on this dataset / model.")
        return 1
    print(
        f"Best threshold: {best[0]:.2f}  (accuracy={best[1]:.4f}, FPR={best[2]:.4f})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
