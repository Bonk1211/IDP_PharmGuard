#!/usr/bin/env python3
"""Bench accuracy of the on-device pill-ID YOLO against a labelled dataset.

PRD Phase 9 targets:
  - Pill-ID classification accuracy > 99%
  - False-positive rate (wrong pill marked correct) < 0.1%

Dataset layout (operator-supplied):
    <dataset_root>/
      <sku_label_1>/
        *.jpg | *.jpeg | *.png | *.bmp
      <sku_label_2>/
        ...

PRD requires >=10 SKUs * >=100 images each. The script logs a warning and
proceeds when the dataset is smaller (useful for smoke tests). Pass/Fail
vs PRD targets is computed regardless.

Outputs a timestamped markdown report at
``bench_accuracy_<YYYYMMDD-HHMMSS>.md`` in the cwd unless ``--report`` is
passed.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts._bench_helpers import (  # noqa: E402
    NO_DETECTION_LABEL,
    confusion_matrix,
    overall_accuracy,
    overall_fpr,
    per_class_stats,
    render_confusion,
)

log = logging.getLogger(__name__)

IMG_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".JPG", ".JPEG", ".PNG", ".BMP")
ACCURACY_TARGET = 0.99
FPR_TARGET = 0.001
PRD_MIN_SKUS = 10
PRD_MIN_PER_CLASS = 100


def discover_dataset(root: Path) -> dict[str, list[Path]]:
    """Walk ``root`` and return ``{label: [image_paths...]}`` for non-empty dirs."""
    out: dict[str, list[Path]] = {}
    for label_dir in sorted(root.iterdir()):
        if not label_dir.is_dir():
            continue
        imgs = sorted(p for p in label_dir.iterdir() if p.suffix in IMG_EXTS)
        if imgs:
            out[label_dir.name] = imgs
    return out


def predict_one(model, image_path: Path, conf_thresh: float) -> tuple[str, float]:
    """Run YOLO on a single image; return ``(predicted_label, max_confidence)``.

    Picks the highest-confidence detection above ``conf_thresh``. Falls back
    to ``NO_DETECTION_LABEL`` when nothing crosses the threshold.
    """
    results = model(str(image_path), verbose=False)
    best_label: str | None = None
    best_conf = 0.0
    for r in results:
        if r.boxes is None:
            continue
        for i in range(len(r.boxes)):
            conf = float(r.boxes[i].conf.item())
            if conf < conf_thresh:
                continue
            cls_idx = int(r.boxes[i].cls.item())
            cls_name = r.names.get(cls_idx, str(cls_idx))
            if conf > best_conf:
                best_conf = conf
                best_label = cls_name
    if best_label is None:
        return NO_DETECTION_LABEL, best_conf
    return best_label, best_conf


def _build_report(
    *,
    dataset_root: Path,
    model_path: str,
    conf_thresh: float,
    classes: dict[str, list[Path]],
    total_images: int,
    duration: float,
    matrix: dict[tuple[str, str], int],
    conf_log: list[tuple[str, str, str, float]],
    labels: list[str],
    under_spec: bool,
    timestamp: str,
) -> tuple[str, bool]:
    """Render the markdown report. Returns ``(text, overall_pass)``."""
    correct, total, acc = overall_accuracy(matrix)
    fpr = overall_fpr(matrix, labels)
    per_class = per_class_stats(matrix, labels)
    acc_pass = acc >= ACCURACY_TARGET
    fpr_pass = fpr < FPR_TARGET
    overall_pass = acc_pass and fpr_pass

    lines: list[str] = []
    lines.append(f"# Pill-ID Accuracy Bench - {timestamp}")
    lines.append("")
    lines.append(f"- **Dataset**: `{dataset_root}`")
    lines.append(f"- **Model**: `{model_path}`")
    lines.append(f"- **Confidence threshold**: {conf_thresh}")
    lines.append(f"- **Classes**: {len(classes)}  (PRD floor: >={PRD_MIN_SKUS})")
    lines.append(
        f"- **Total images**: {total_images}  (PRD floor: >={PRD_MIN_PER_CLASS} per class)"
    )
    lines.append(
        f"- **Inference duration**: {duration:.1f}s "
        f"({total_images / duration if duration else 0.0:.2f} img/s)"
    )
    if under_spec:
        lines.append(
            "- **Under PRD floor**: yes - run is **under-spec**, treat results as indicative only"
        )
    lines.append("")

    lines.append("## Headline metrics")
    lines.append("")
    lines.append("| metric | value | target | pass |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| accuracy | {acc:.4f} ({correct}/{total}) | >={ACCURACY_TARGET:.2f} | "
        f"{'PASS' if acc_pass else 'FAIL'} |"
    )
    lines.append(
        f"| false-positive rate | {fpr:.4f} | <{FPR_TARGET} | "
        f"{'PASS' if fpr_pass else 'FAIL'} |"
    )
    lines.append("")
    lines.append(f"**Overall**: {'PASS' if overall_pass else 'FAIL'}")
    lines.append("")

    lines.append("## Per-class breakdown")
    lines.append("")
    lines.append("| class | support | TP | FP | FN | precision | recall |")
    lines.append("|---|---|---|---|---|---|---|")
    for label in labels:
        s = per_class[label]
        lines.append(
            f"| {label} | {int(s['support'])} | {int(s['tp'])} | {int(s['fp'])} | "
            f"{int(s['fn'])} | {s['precision']:.4f} | {s['recall']:.4f} |"
        )
    lines.append("")

    lines.append("## Confusion matrix")
    lines.append("")
    lines.append(render_confusion(matrix, labels))
    lines.append("")

    lines.append("## Misclassifications (first 50)")
    lines.append("")
    misses = [c for c in conf_log if c[1] != c[2]]
    if not misses:
        lines.append("_None - every image classified correctly._")
    else:
        lines.append("| image | true | pred | conf |")
        lines.append("|---|---|---|---|")
        for path, t, p, c in misses[:50]:
            lines.append(f"| `{Path(path).name}` | {t} | {p} | {c:.3f} |")
        if len(misses) > 50:
            lines.append("")
            lines.append(f"_...{len(misses) - 50} more not shown._")
    lines.append("")

    return "\n".join(lines), overall_pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dataset", required=True, help="Path to labelled dataset root")
    ap.add_argument(
        "--model",
        default="models/pill_detector.pt",
        help="Path to YOLO .pt weights (default: models/pill_detector.pt)",
    )
    ap.add_argument("--conf-thresh", type=float, default=0.5)
    ap.add_argument(
        "--report",
        default=None,
        help="Output markdown path (default: bench_accuracy_<ts>.md in cwd)",
    )
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
    )

    # Imported inside main so --help works on machines without ultralytics.
    from ultralytics import YOLO  # noqa: WPS433

    dataset_root = Path(args.dataset).resolve()
    if not dataset_root.is_dir():
        log.error("Dataset root not found: %s", dataset_root)
        return 2

    classes = discover_dataset(dataset_root)
    if not classes:
        log.error("No class folders with images found under %s", dataset_root)
        return 2

    total_images = sum(len(v) for v in classes.values())
    labels = sorted(classes.keys())
    log.info(
        "Loaded %d classes / %d images from %s",
        len(classes),
        total_images,
        dataset_root,
    )

    under_sku = len(classes) < PRD_MIN_SKUS
    under_n = any(len(v) < PRD_MIN_PER_CLASS for v in classes.values())
    under_spec = under_sku or under_n
    if under_spec:
        log.warning(
            "Dataset under PRD floor (need >=%d SKUs * >=%d images each); accuracy "
            "numbers will run but the report will mark the run as `under-spec`.",
            PRD_MIN_SKUS,
            PRD_MIN_PER_CLASS,
        )

    log.info("Loading YOLO from %s", args.model)
    model = YOLO(args.model)

    rows: list[tuple[str, str]] = []
    conf_log: list[tuple[str, str, str, float]] = []
    t_start = time.perf_counter()
    for true_label in labels:
        for img_path in classes[true_label]:
            pred_label, conf = predict_one(model, img_path, args.conf_thresh)
            rows.append((true_label, pred_label))
            conf_log.append((str(img_path), true_label, pred_label, conf))
            if len(rows) % 50 == 0:
                log.info("  %d/%d images processed", len(rows), total_images)
    duration = time.perf_counter() - t_start
    log.info(
        "Inference complete: %d images in %.1fs (%.2f img/s)",
        total_images,
        duration,
        total_images / duration if duration else 0.0,
    )

    matrix = confusion_matrix(rows)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    report_text, overall_pass = _build_report(
        dataset_root=dataset_root,
        model_path=args.model,
        conf_thresh=args.conf_thresh,
        classes=classes,
        total_images=total_images,
        duration=duration,
        matrix=matrix,
        conf_log=conf_log,
        labels=labels,
        under_spec=under_spec,
        timestamp=timestamp,
    )

    out_path = (
        Path(args.report)
        if args.report
        else Path.cwd() / f"bench_accuracy_{timestamp}.md"
    )
    out_path.write_text(report_text)
    log.info("Report written to %s", out_path)
    print(report_text)
    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
