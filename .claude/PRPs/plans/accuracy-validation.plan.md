# Plan: Accuracy Validation Harness (PRD Phase 9)

## Summary
Build the **harness** that turns the PRD's >99% accuracy / <0.1% FPR claim into a measured, defensible number. Operator supplies a labelled directory `dataset/<sku_label>/<image>.jpg` (>=10 SKUs * >=100 images each); the harness walks the directory, runs the on-device YOLO model from `edge_pi/models/spotter.pt` (or `pill_detector.pt`) on every image, builds a confusion matrix, and renders a Pass/Fail markdown report against PRD Phase 9 targets. Add a calibration script that sweeps `conf_thresh` so the operator can pick the threshold that meets PRD targets. Add an opt-in shape on `PillVerifier._has_pill` that returns `(bool, confidence)` so `report_intake` can populate the existing `adherence_logs.confidence_score` column (added in Phase 1) - caregiver dashboards see real distributions in production. The 1,000-pill labelled run is operator-attested; the harness is what lands today.

## User Story
As the **PharmGuard engineering team**, I want **a one-command accuracy bench that consumes a labelled directory and produces a confusion-matrix-backed Pass/Fail report against PRD pill-ID targets**, so that **the >99% / <0.1% FPR claim becomes a measurement instead of a forecast, and any model promotion (`ml/pill_detector/*.pt` -> `edge_pi/models/`) is gated by a re-runnable accuracy report**.

## Problem -> Solution
**Today**: PRD Phase 9 targets (`>99%` pill-ID accuracy, `<0.1%` FPR) have no validation harness. `PillVerifier.confirm_tray_empty` only returns `bool` - confidence is discarded, so `adherence_logs.confidence_score` (Phase 1 column with a `[0,1]` CHECK) is never populated. There is no labelled-set walker, no confusion matrix code, and no operator-runnable script that says "your current weights pass / fail PRD targets at threshold X."
**After**: A new `edge_pi/scripts/bench_accuracy.py` walks a class-folder dataset, runs YOLO on each image, records `(true_label, predicted_label, predicted_confidence)`, computes per-class precision/recall + overall accuracy + FPR, and writes a timestamped markdown report. `PillVerifier` gains an opt-in `return_confidence=True` kwarg on `_has_pill` and `confirm_tray_empty` so callers can read the highest-conf observation; `report_intake` POSTs it as `confidence_score`. A `tune_threshold.py` calibration sweep prints precision/recall across thresholds 0.30...0.80 in 0.05 steps. A confusion-matrix helper extends the existing `_bench_helpers.py` (Phase 6) with stdlib-only utilities.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 9 - Accuracy validation
- **Estimated Files**: 6 (3 new Pi scripts + 1 helper extension + 1 PillVerifier instrumentation + 1 main.py confidence telemetry + 1 gitignore)
- **Estimated Lines**: ~400 LOC

---

## UX Design

Internal operator tooling. New CLIs:

```bash
python3 scripts/bench_accuracy.py --dataset /path/to/dataset --model models/pill_detector.pt
python3 scripts/tune_threshold.py --dataset /path/to/dataset --model models/pill_detector.pt
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `PillVerifier._has_pill(frame)` | returns `bool` | also accepts `return_confidence=True` -> `(bool, float)` | additive kwarg; default unchanged |
| `PillVerifier.confirm_tray_empty(timeout_s)` | returns `bool` | also accepts `return_confidence=True` -> `(bool, float)` | additive kwarg; max conf seen |
| Pi `report_intake(patient_id, slot, verified)` | POSTs `{patient_id, slot, pill_taken, dispenser_id?}` | also accepts optional `confidence` arg -> adds `confidence_score` to body when present | additive |
| `edge_pi/main.py` cycle | discards YOLO confidence | records highest conf during `confirm_tray_empty`, passes to `report_intake` | bracketed by `# Phase 9 ...` sentinels |
| New CLI: `bench_accuracy.py` | did not exist | walks labelled dir, builds confusion matrix, writes markdown report | new |
| New CLI: `tune_threshold.py` | did not exist | sweeps `conf_thresh`, prints precision/recall table | new |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `CLAUDE.md` | full | Tier boundaries - Pi never holds Supabase or Gemini keys; `ml/` -> `edge_pi/models/` is the deploy path |
| P0 | `edge_pi/vision/pill_verifier.py` | full | `_has_pill` confidence-threshold loop; lazy-init; conf_thresh defaults to 0.5 |
| P0 | `edge_pi/scripts/_bench_helpers.py` | full | Phase 6 helper to extend with `confusion_matrix` + `render_confusion` |
| P0 | `edge_pi/scripts/bench_dual_cam.py` | full | BENCH_SCRIPT_PATTERN - argparse + Pass/Fail print + exit code |
| P0 | `edge_pi/scripts/bench_e2e.py` | full | Markdown report writer + sys.path bootstrap pattern |
| P0 | `.claude/PRPs/plans/completed/end-to-end-bench-loop.plan.md` | full | Sentinel-comment pattern for `# Phase N ...` blocks in main.py |
| P0 | `backend/app/api/logs.py` | 15-21 | `IntakeLog.confidence_score: float \| None` already exists |
| P0 | `backend/migrations/0001_phase1_schema_hardening.sql` | 26-37 | `adherence_logs.confidence_score real` with `[0,1]` CHECK already shipped |
| P1 | `edge_pi/main.py` | 65-80, 297-347 | `report_intake` signature + per-cycle write site (Phase 6 sentinels live here) |
| P1 | `ml/pill_detector/yolo_detect.py` | 165-205 | YOLO output parsing (`results[0].boxes`, `.cls`, `.conf`) - mirror in harness |
| P2 | `.claude/PRPs/prds/pharmguard.prd.md` | Success Metrics row 1-2 | The two PRD targets the harness measures |

## External Documentation
No external research required - Ultralytics YOLO API already used in repo; stdlib-only metrics.

---

## Patterns to Mirror

### NAMING_CONVENTION (Pi script)
```python
# SOURCE: edge_pi/scripts/bench_dual_cam.py:1-25
#!/usr/bin/env python3
"""Bench accuracy of pill-ID YOLO against a labelled dataset (PRD Phase 9)."""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts._bench_helpers import confusion_matrix, render_confusion  # noqa: E402
```
Rule: shebang; PRD-referenced module docstring; argparse with sensible defaults; stdlib-only outside ultralytics; `sys.path.insert` for `vision.*` / `scripts.*` imports.

### DATASET_LAYOUT (new spec, this plan)
```
<dataset_root>/
  <sku_label_1>/
    img_001.jpg
    img_002.jpg
    ...
  <sku_label_2>/
    ...
```
Rule: directory name == ground-truth label (case-sensitive). Operator must supply >=10 SKU folders * >=100 images each (PRD Phase 9 requirement). Recommended size: short side >=640 px so YOLO has consistent input. Image extensions: `.jpg`, `.jpeg`, `.png`, `.bmp` (matches `ml/pill_detector/yolo_detect.py:47`).

### YOLO_PARSE_PATTERN (mirror)
```python
# SOURCE: ml/pill_detector/yolo_detect.py:164-187
results = model(frame, verbose=False)
detections = results[0].boxes
for i in range(len(detections)):
    classidx = int(detections[i].cls.item())
    classname = labels[classidx]
    conf = detections[i].conf.item()
```
Rule: pick the **highest-confidence** detection per image - that's the predicted SKU. If no detection above threshold -> predicted = `"<no_detection>"`.

### CONFIDENCE_INSTRUMENTATION (new)
```python
# SOURCE: edge_pi/vision/pill_verifier.py - opt-in kwarg
def _has_pill(self, frame, *, return_confidence=False):
    ...
    if return_confidence:
        return (best_seen >= self.conf_thresh, best_seen)
    return best_seen >= self.conf_thresh
```
Rule: **opt-in kwarg, default unchanged** - every existing caller (`confirm_tray_empty` internal use, no external callers in repo) keeps the bool-return contract. Avoid sibling methods because the inference cost would double if the verify path called both.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/main.py:30 + scripts/bench_e2e.py:35
log = logging.getLogger(__name__)
log.info("Processed %d/%d images for class %s", n, total, label)
```
Rule: positional formatters, never f-strings.

### MAIN_PY_SENTINEL_BLOCK (mirror Phase 6)
```python
# SOURCE: edge_pi/main.py:262-269 (Phase 6 BENCH_MODE block)
# Phase 9: capture YOLO confidence
pill_id_pass, pill_conf = verifier.confirm_tray_empty(return_confidence=True)
# /Phase 9
```
Rule: `# Phase 9 ...` open + `# /Phase 9` close around every Phase 9 block in `main.py` so orchestrator can resolve merges with parallel Phase 8 work cleanly. (The actual file uses box-drawing characters in the sentinel banners.)

### TEST_STRUCTURE
N/A - repo has no test framework. Validation = py_compile + synthetic confusion-matrix smoke + Pi-hardware operator-attested run.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `edge_pi/vision/pill_verifier.py` | UPDATE | Add `return_confidence` kwarg to `_has_pill` + `confirm_tray_empty`; backwards-compat preserved |
| `edge_pi/main.py` | UPDATE | Capture `pill_conf` during `confirm_tray_empty`; pass to `report_intake`. Single Phase-9-sentinel'd block |
| `edge_pi/scripts/_bench_helpers.py` | UPDATE | Add `confusion_matrix(rows)` + `render_confusion(matrix, labels)` stdlib helpers |
| `edge_pi/scripts/bench_accuracy.py` | CREATE | Walks labelled dataset; runs YOLO; writes timestamped Pass/Fail markdown report |
| `edge_pi/scripts/tune_threshold.py` | CREATE | Sweeps conf_thresh 0.30...0.80; prints precision/recall table per threshold |
| `.gitignore` | UPDATE | Add `ml/**/test_data/` so any local synthetic test data the operator drops doesn't get committed |

## NOT Building

- **Real labelled pill photos in this commit** - environment cannot acquire them. Harness lands; operator runs against real data.
- **Retraining pipeline** - out of scope; if accuracy gap exists after operator run, retraining is a follow-up using existing `ml/pill_detector/yolo_detect.py` infrastructure.
- **New backend route** - `confidence_score` column already exists from Phase 1; existing `POST /api/logs/` already accepts the field via `IntakeLog.confidence_score`.
- **DB migration** - Phase 1 already shipped `adherence_logs.confidence_score real` with `[0,1]` CHECK.
- **Backend-side accuracy aggregation** - Phase 9 measures the Pi-side classifier; backend dashboards (Phase 7) already have the column to surface.
- **Frontend dashboard for accuracy reports** - operator reads the markdown file directly.
- **CI integration** - operator-only; CI cannot run YOLO without weights + labelled data.
- **Per-image bounding-box visualization** - text-only report; visualization is a follow-up.
- **Unit tests for the harness** - repo has no test framework; smoke + py_compile only.

---

## Step-by-Step Tasks

### Task 1: Extend `PillVerifier` with optional confidence return
- **ACTION**: Edit `edge_pi/vision/pill_verifier.py`.
- **IMPLEMENT**: opt-in `return_confidence` kwarg on `_has_pill` + `confirm_tray_empty`; default behavior unchanged.
- **MIRROR**: CONFIDENCE_INSTRUMENTATION pattern (opt-in kwarg).
- **IMPORTS**: None new.
- **GOTCHA**: Default behavior must be byte-equivalent for callers using `confirm_tray_empty(timeout_s=X)` with no kwarg.
- **VALIDATE**: `python3 -m py_compile vision/pill_verifier.py`

### Task 2: Capture confidence in `edge_pi/main.py` and report it
- **ACTION**: Edit `edge_pi/main.py`. Bracket every change with Phase 9 sentinels so Phase 8 (offline queue) can merge cleanly.
- **IMPLEMENT**:
  - Update `report_intake` signature to accept optional `confidence`. When non-None, include `"confidence_score": float(confidence)` in the POST body.
  - In the cycle body, capture `pill_conf` via the new kwarg and pass to `report_intake`. In stub branch, set `pill_conf = None`. Phase 4 sentinel comments stay byte-identical.
- **MIRROR**: MAIN_PY_SENTINEL_BLOCK, LOGGING_PATTERN.
- **IMPORTS**: None new.
- **GOTCHA**:
  - Phase 4 + Phase 5 + Phase 6 sentinel comments stay **byte-identical**. Only insert Phase 9 sentinel pairs around new code.
  - `pill_conf` must be defined in **both** branches of `if hardware_stubbed:` so the `report_intake` call site doesn't `NameError`.
  - HI-012 invariant: stub branch reports `verified=False` and `confidence=None` - backend inserts `NULL` into `confidence_score`; the `[0,1]` CHECK passes (constraint allows NULL).
  - `IntakeLog.confidence_score` Pydantic field already accepts `float | None`.
- **VALIDATE**: py_compile + sentinel grep.

### Task 3: Extend `_bench_helpers.py` with confusion-matrix utilities
- **ACTION**: Edit `edge_pi/scripts/_bench_helpers.py`. Append after existing Phase 6 helpers.
- **IMPLEMENT**: `NO_DETECTION_LABEL = "<no_detection>"`; `confusion_matrix(rows)` returns `dict[(true,pred), int]`; `render_confusion(matrix, labels)` returns markdown table; `per_class_stats(matrix, labels)` returns `{label: {tp,fp,fn,support,precision,recall}}`; `overall_accuracy(matrix)` returns `(correct, total, acc)`; `overall_fpr(matrix, labels)` returns `(wrong-pill-marked-correct) / total`, **excluding `<no_detection>` from numerator** (those are missed detections, not FPs).
- **MIRROR**: `summarise` style - small, pure-stdlib NamedTuple/dict returns; no side effects.
- **IMPORTS**: `from collections import Counter`, `from typing import Iterable`.
- **GOTCHA**:
  - Phase 6's `summarise`, `read_csv`, `render_report` stay byte-identical. New code is appended after a section banner.
  - `NO_DETECTION_LABEL` is a sentinel. Operators must not name a real SKU `<no_detection>`.
- **VALIDATE**: synthetic-data smoke (see Task 7).

### Task 4: Create `edge_pi/scripts/bench_accuracy.py`
- **ACTION**: New script.
- **IMPLEMENT**: argparse with `--dataset`, `--model`, `--conf-thresh`, `--report`. Walks `<root>/<label>/*.{jpg,jpeg,png,bmp}`, runs YOLO via `ultralytics.YOLO(args.model)(str(image_path), verbose=False)`, picks **highest-confidence** detection per image, falls back to `NO_DETECTION_LABEL`. Builds confusion matrix + per-class stats + overall accuracy + FPR. Logs `under-spec` warning if dataset breaches PRD floor (`PRD_MIN_SKUS=10`, `PRD_MIN_PER_CLASS=100`). Writes timestamped markdown report `bench_accuracy_<YYYYMMDD-HHMMSS>.md` (UTC) to cwd or `--report` path. Pass = `accuracy >= 0.99 AND fpr < 0.001`.
- **MIRROR**: BENCH_SCRIPT_PATTERN, NAMING_CONVENTION, YOLO_PARSE_PATTERN.
- **IMPORTS**: stdlib + `ultralytics` (already in `requirements.txt`).
- **GOTCHA**:
  - `from ultralytics import YOLO` is **inside `main()`** so `--help` works on machines without ultralytics installed (dev-mac compatibility).
  - PRD's accuracy ">99%" interpreted as `>= 0.99` (boundary case PASS).
  - PRD's FPR "<0.1%" interpreted as strictly less than `0.001`.
  - When the dataset is smaller than PRD floor, the script proceeds and tags the report `under-spec`.
- **VALIDATE**: py_compile + `--help` smoke.

### Task 5: Create `edge_pi/scripts/tune_threshold.py`
- **ACTION**: New script.
- **IMPLEMENT**: argparse with `--dataset`, `--model`, `--start=0.30`, `--stop=0.80`, `--step=0.05`. Reuses `bench_accuracy.discover_dataset` + `predict_one` so threshold logic is single-sourced. Loops the dataset once per threshold, prints markdown table `| threshold | accuracy | FPR | acc_pass | fpr_pass |`. Returns 1 if no threshold meets BOTH PRD targets.
- **MIRROR**: BENCH_SCRIPT_PATTERN.
- **IMPORTS**: shared with bench_accuracy.
- **GOTCHA**:
  - `args.stop + 1e-9` for float-safe loop bound.
  - N images * M thresholds - 1k*11 = 11k inferences (~3-5 min on Pi 5 CPU).
- **VALIDATE**: py_compile + `--help` smoke.

### Task 6: Add `ml/**/test_data/` to `.gitignore`
- **ACTION**: Edit `.gitignore`.
- **IMPLEMENT**: append `ml/**/test_data/` to the "ML training assets" block.
- **MIRROR**: existing `ml/**/Medicine_Images/` line.
- **GOTCHA**: large datasets must not be committed (CLAUDE.md). This pattern lets operators drop a labelled set under `ml/pill_detector/test_data/` without polluting git.
- **VALIDATE**: `git check-ignore -v ml/pill_detector/test_data/foo.jpg` reports the rule.

### Task 7: Local validation suite
- **ACTION**: Static analysis + synthetic-data smoke + constants regression + sentinel regression.
- **IMPLEMENT**:
  - `python3 -m py_compile` on `vision/pill_verifier.py`, `main.py`, `scripts/_bench_helpers.py`, `scripts/bench_accuracy.py`, `scripts/tune_threshold.py`.
  - Synthetic 9-pair confusion matrix smoke checks: `accuracy = 6/9`, `fpr = 2/9`, per-class `tp`/`fp` consistent.
  - Constants regression: grep `vision/intake_monitor.py` for `STEP_1_HAND..STEP_5_TONGUE` and `REQUIRED_CONFIDENCE = 0.85`.
  - Sentinel regression: grep `main.py` for Phase 4/5/6/9 sentinels (all open + close pairs).
  - `--help` smoke for both new scripts.
- **MIRROR**: Phase 6 validation suite - py_compile + textual regression + script `--help` smoke.
- **GOTCHA**: dev mac lacks `cv2`/`ultralytics` for many imports - same constraint Phase 2/3/6 hit. We avoid `import vision.pill_verifier` at smoke time; py_compile is enough.

### Task 8: Operator-attested Pi run (handoff only)
- **ACTION**: Operator drives the bench on real Pi 5 + a labelled dataset.
- **IMPLEMENT**:
  ```bash
  cd ~/IDP_PharmGuard/edge_pi
  python3 scripts/bench_accuracy.py \
      --dataset /path/to/labelled/photos \
      --model models/pill_detector.pt \
      --conf-thresh 0.5

  # If a gap exists, sweep:
  python3 scripts/tune_threshold.py \
      --dataset /path/to/labelled/photos \
      --model models/pill_detector.pt
  ```
- **GOTCHA**:
  - Operator must supply >=10 SKU folders * >=100 images each to satisfy PRD floor.
  - If accuracy gap is large, operator retrains via `ml/pill_detector/yolo_detect.py` infrastructure and promotes new weights to `edge_pi/models/pill_detector.pt` per CLAUDE.md.
  - The report file is plain markdown; operator commits it (or attaches to PRD report) as the signed-off accuracy artefact.
- **VALIDATE**: report markdown contains `**Overall**: PASS` (or operator documents the gap and remediation).

---

## Testing Strategy

Repo has no test framework. Validation = py_compile + synthetic-data smoke + Pi-hardware operator attestation.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `confusion_matrix` synthetic | 9 hand-built `(true,pred)` pairs | diagonal counts match expected | normal |
| `per_class_stats` | same 9 pairs | precision/recall match hand calculation | normal |
| `overall_accuracy` | same 9 pairs | `(6, 9, 6/9)` | normal |
| `overall_fpr` | same 9 pairs | `2/9` (excludes `<no_detection>`) | yes |
| `render_confusion` no `<no_detection>` | A/B/C only | `<no_detection>` column NOT added | normal |
| `render_confusion` with `<no_detection>` | includes 1 missed | `<no_detection>` column added | yes |
| `bench_accuracy.py --help` | no env | usage printed; ultralytics not loaded | yes |
| `tune_threshold.py --help` | no env | usage printed | yes |
| Pi `confirm_tray_empty` default | `confirm_tray_empty(timeout_s=5.0)` | returns `bool` (byte-equivalent) | regression |
| Pi `confirm_tray_empty` with `return_confidence` | kwarg | returns `(bool, float)` | new |
| `main.py` Phase 4/5/6 sentinels | grep | all present byte-identical | regression |
| `intake_monitor.py` constants | grep | all step names + `REQUIRED_CONFIDENCE = 0.85` intact | invariant |
| `report_intake` without confidence | call with `confidence=None` (default) | POST body has no `confidence_score` key | regression |
| `report_intake` with confidence | call with `confidence=0.87` | POST body includes `"confidence_score": 0.87` | new |

### Edge Cases Checklist
- [x] Empty dataset - `discover_dataset` returns `{}`; script logs error and exits 2.
- [x] Image with no detections at all - predicted label = `<no_detection>`; counts as miss, not as FP.
- [x] Unrelabeled class folder (typo in true label) - script trusts the directory name; operator owns label hygiene.
- [x] PRD floor breach - script proceeds with `under-spec` warning, doesn't refuse.
- [x] Mismatch between dataset class names and YOLO `.names` - surfaces as off-diagonal in the confusion matrix.
- [x] All-same-label dataset (single class) - `overall_fpr` returns 0; per-class precision/recall computed only for that label.
- [x] Stub mode on Pi - `report_intake` gets `confidence=None`; backend stores NULL; `[0,1]` CHECK passes (constraint allows NULL).

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/edge_pi
python3 -m py_compile vision/pill_verifier.py main.py \
    scripts/_bench_helpers.py scripts/bench_accuracy.py scripts/tune_threshold.py
```

### Synthetic Confusion-Matrix Smoke
See Task 7 step 2. EXPECT: `confusion-matrix smoke OK` + valid markdown table printed.

### Constants Regression
See Task 7 step 3. EXPECT: `FSM constants intact`.

### Script `--help`
EXPECT: usage lines containing `--dataset`.

### Sentinel Regression
EXPECT: `Phase 4/5/6/9 sentinels all present`.

### Frontend Build
N/A - no frontend impact.

### Pi Operator Run
See Task 8. EXPECT: report markdown with `**Overall**: PASS` (or documented gap + remediation plan).

### Manual Validation Checklist
- [ ] `vision/pill_verifier.py::_has_pill` accepts `return_confidence=True`; default behavior unchanged.
- [ ] `vision/pill_verifier.py::confirm_tray_empty` accepts `return_confidence=True`; default behavior unchanged.
- [ ] `edge_pi/main.py` Phase 9 sentinel pairs present; Phase 4/5/6 sentinels byte-identical.
- [ ] `edge_pi/main.py::report_intake` accepts optional `confidence` kwarg.
- [ ] `edge_pi/scripts/_bench_helpers.py` exports `confusion_matrix`, `render_confusion`, `per_class_stats`, `overall_accuracy`, `overall_fpr`, `NO_DETECTION_LABEL`.
- [ ] `edge_pi/scripts/bench_accuracy.py` exists with `--dataset`, `--model`, `--conf-thresh`, `--report`, `--help`.
- [ ] `edge_pi/scripts/tune_threshold.py` exists with `--dataset`, `--model`, `--start`, `--stop`, `--step`, `--help`.
- [ ] `.gitignore` includes `ml/**/test_data/`.
- [ ] FSM constants from Phase 3 regression-pass.
- [ ] No new dependencies added.

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] `confidence_score` populated in `adherence_logs` when YOLO observation is available; null otherwise.
- [ ] Synthetic confusion-matrix smoke passes (`6/9 = 0.667 accuracy, 2/9 FPR`).
- [ ] FSM constants regression-pass (Phase 3 invariant).
- [ ] `_has_pill` default-return is byte-equivalent to pre-Phase-9 behavior.
- [ ] Phase 4 + Phase 5 + Phase 6 sentinel comments byte-identical.
- [ ] PRD Phase 9 row updated by orchestrator (operator step, not this commit).

## Completion Checklist
- [ ] Pi follows existing patterns (BENCH_SCRIPT_PATTERN, NAMING, LOGGING, opt-in kwarg pattern).
- [ ] No new dependencies on Pi.
- [ ] No new backend route, no new migration.
- [ ] Phase 4/5/6 sentinels in `main.py` byte-identical.
- [ ] HI-012 invariant: stub-mode reports `confidence=None`; `[0,1]` CHECK still passes (NULL allowed).
- [ ] Operator-attested run is doc'd in handoff.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Operator labels a SKU `<no_detection>` | L | M | Script reserves the sentinel; documented in plan |
| YOLO `.names` doesn't include the operator's label vocabulary | H | M | Mismatch surfaces in the confusion matrix; operator picks the right `.pt` (`pill_detector.pt` vs `spotter.pt`) |
| `predict_one` reads images via Ultralytics - relies on cv2 under the hood | M | L | cv2 is already a Pi dep (`opencv-python-headless`); operator runs on Pi anyway |
| Bench takes hours on a 10k-image dataset | M | L | Operator splits into smaller runs; or runs on a workstation with the same `.pt` |
| `report_intake` confidence breaks the `[0,1]` CHECK if YOLO returns >1.0 | L | M | YOLO confidence is bounded `[0,1]` by softmax; defensive `float(confidence)` cast |
| Phase 8 (offline queue) writes the same `report_intake` site -> merge conflict | M | M | Phase 9 changes are bracketed by Phase 9 sentinels; Phase 8 should bracket its own changes the same way |
| Phase 8 extends `_bench_helpers.py` simultaneously | L | L | Phase 9 appends after a section banner; Phase 8 can append after another |
| Threshold sweep slow on Pi 5 CPU | M | L | Document; operator can constrain `--start/--stop/--step` |
| Operator forgets PRD floor (>=10 SKUs * >=100 images) | H | M | Script logs `under-spec` warning and tags the report |

## Notes
- **Harness-only PR**: real numbers come from operator on real labelled data. Mirrors Phase 6 (bench landed; operator attests).
- **No deps added** - stdlib + existing `ultralytics`.
- **No migration** - `adherence_logs.confidence_score` shipped in Phase 1.
- **No backend route changes** - `IntakeLog.confidence_score` already accepts the field.
- **No frontend changes** - caregiver dashboard already has the column to surface (Phase 7 is a follow-up if surfacing the distribution becomes a priority).
- **Phase 4/5/6 sentinels**: stay byte-identical. Only Phase 9 sentinel pairs are introduced.
- **Phase 8 merge consideration**: if Phase 8 lands an offline queue around `report_intake`, both phases bracket their changes with phase-named sentinels so the orchestrator can merge cleanly.
- After this plan ships, orchestrator updates `pharmguard.prd.md` Phase 9 row to `in-progress (code complete; Pi labelled-set bench pending operator)`.

Sources:
- Internal patterns only - no external research required.
