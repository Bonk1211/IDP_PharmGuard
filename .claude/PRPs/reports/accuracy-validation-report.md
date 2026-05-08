# Implementation Report: Accuracy Validation Harness (PRD Phase 9)

## Summary
Built the operator-runnable harness that turns the PRD's >99% accuracy / <0.1% FPR claim into a measurement. Operator drops a labelled `<dataset>/<sku_label>/<image>.{jpg,jpeg,png,bmp}` directory; `edge_pi/scripts/bench_accuracy.py` walks it, runs YOLO from `edge_pi/models/pill_detector.pt`, builds a confusion matrix, and writes a timestamped markdown Pass/Fail report. `tune_threshold.py` sweeps `conf_thresh` 0.30-0.80 to help the operator pick a threshold that meets PRD targets. `_bench_helpers.py` got an append-only Phase 9 section: `confusion_matrix`, `render_confusion`, `per_class_stats`, `overall_accuracy`, `overall_fpr`, `NO_DETECTION_LABEL`. `PillVerifier._has_pill` and `confirm_tray_empty` gained an opt-in `return_confidence=True` kwarg (default-False, byte-equivalent to pre-Phase-9 callers); `report_intake` now optionally posts `confidence_score`. Phase 4/5/6 sentinels in `main.py` stay byte-identical; Phase 9 changes are bracketed by their own sentinel pairs so Phase 8 can merge cleanly. **Real 1,000-pill labelled bench is operator-attested - the environment cannot acquire pill photos.**

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 7/10 | 9/10 (every smoke green; sentinel regression confirms Phase 4/5/6 byte-equivalent) |
| Files Changed | 6 | 6 (+ plan + report) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `PillVerifier` opt-in confidence return | Complete | Both `_has_pill` and `confirm_tray_empty` accept `return_confidence=True`; default-False preserves bool-return contract |
| 2 | `main.py` confidence telemetry | Complete | `report_intake` gained optional `confidence` kwarg -> `confidence_score` POST field; cycle defines `pill_conf` in both stub and real branches; 4 Phase 9 sentinel pairs |
| 3 | `_bench_helpers.py` confusion-matrix utilities | Complete | Appended after Phase 6 helpers; `summarise`/`read_csv`/`render_report` byte-equivalent |
| 4 | `bench_accuracy.py` | Complete | argparse with `--dataset`, `--model`, `--conf-thresh`, `--report`; YOLO inside main() so `--help` works on dev mac; PRD floor warning + `under-spec` report tag |
| 5 | `tune_threshold.py` | Complete | Reuses `discover_dataset` + `predict_one` from bench_accuracy; sweeps 0.30-0.80 in 0.05 steps; exits 1 when no threshold meets both PRD targets |
| 6 | `.gitignore` `ml/**/test_data/` | Complete | `git check-ignore` confirms `ml/pill_detector/test_data/foo.jpg` is excluded |
| 7 | Validation suite | Complete | py_compile clean (5 files), confusion-matrix synthetic smoke (6/9 acc + 2/9 FPR), FSM constants intact, sentinel regression (Phase 4/5/6/9), `--help` smoke, Phase 6 helper regression |
| 8 | Pi operator bench run | **Blocked - operator step** | Requires real labelled pill photos (>=10 SKUs * >=100 images) |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Pi Python (`py_compile`) | Pass | `vision/pill_verifier.py`, `main.py`, `scripts/_bench_helpers.py`, `scripts/bench_accuracy.py`, `scripts/tune_threshold.py` |
| Confusion-matrix synthetic smoke | Pass | 9 hand-built pairs -> `accuracy=6/9=0.667`, `FPR=2/9=0.222`, per-class TP/FP/FN matches by-hand calc |
| `render_confusion` includes `<no_detection>` column | Pass | sentinel column appended only when present in the matrix |
| `bench_accuracy.py --help` | Pass | usage + `--dataset` flag printed without loading ultralytics |
| `tune_threshold.py --help` | Pass | usage + `--dataset` flag printed without loading ultralytics |
| Phase 4/5/6/9 sentinels in `main.py` | Pass | All Phase 4/5/6 sentinels byte-identical; 4 Phase 9 open + 4 close pairs balanced |
| FSM constants regression | Pass | `STEP_1_HAND..STEP_5_TONGUE` + `REQUIRED_CONFIDENCE = 0.85` byte-identical in `vision/intake_monitor.py` |
| Phase 6 helper regression | Pass | `summarise([10,50,100,150,200])` returns same Stat as Phase 6 report; `render_report` still emits PASS/FAIL |
| `.gitignore` test_data exclusion | Pass | `git check-ignore -v ml/pill_detector/test_data/foo.jpg` reports the rule fired |
| Backend `IntakeLog.confidence_score` field | Pass (no change) | Already accepts `float \| None` from Phase 1; `[0,1]` CHECK already in migration |
| Stub-mode `import main` | **Deferred** | Dev mac lacks `cv2`/`mediapipe`/`ultralytics`; same constraint Phases 2/3/6 hit. Substituted by py_compile + textual sentinel regression. |
| Pi hardware live accuracy bench | **Deferred** | Requires real labelled pill photos - operator-attested only |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `edge_pi/vision/pill_verifier.py` | UPDATED | +50 / -10 (opt-in `return_confidence` kwarg on `_has_pill` + `confirm_tray_empty`) |
| `edge_pi/main.py` | UPDATED | +21 / -2 (optional `confidence` kwarg on `report_intake`; capture `pill_conf` in cycle; Phase 9 sentinel pairs) |
| `edge_pi/scripts/_bench_helpers.py` | UPDATED | +98 / -2 (Phase 9 section: `NO_DETECTION_LABEL`, `confusion_matrix`, `render_confusion`, `per_class_stats`, `overall_accuracy`, `overall_fpr`) |
| `edge_pi/scripts/bench_accuracy.py` | CREATED | +250 (walks labelled dir, runs YOLO, builds confusion matrix, writes timestamped Pass/Fail markdown report) |
| `edge_pi/scripts/tune_threshold.py` | CREATED | +110 (sweeps `conf_thresh` 0.30-0.80; reuses bench_accuracy helpers) |
| `.gitignore` | UPDATED | +2 (`ml/**/test_data/` for operator-supplied labelled benches) |
| `.claude/PRPs/plans/accuracy-validation.plan.md` | CREATED | +320 (plan file) |

## Deviations from Plan

- **`predict_one` returns the highest-conf detection above threshold** rather than the first-above-threshold. The plan-side narrative said "highest" but the YOLO_PARSE_PATTERN snippet from `ml/pill_detector/yolo_detect.py` could read either way. Highest-conf is the right call for accuracy measurement (it minimizes spurious low-conf labels) and matches PRD's "right pill" semantics. No code-time deviation - plan was always this way.
- **`bench_accuracy.py` writes UTC timestamp** (`datetime.now(timezone.utc)`) rather than local time, so reports from different bench machines collate in chronological order regardless of TZ. Plan named `bench_accuracy_<timestamp>.md`; no contradiction.
- **`predict_one` uses `r.names.get(cls_idx, str(cls_idx))`** with `dict.get` rather than indexing - defensive against YOLO weights with sparse `.names` dicts. Mirrors how the existing `ml/pill_detector/yolo_detect.py` reads labels.
- **Stub-mode `import main` smoke skipped on dev mac** (cv2/mediapipe/ultralytics absent) - substituted by py_compile + textual sentinel regression. Same approach as Phase 2/3/6 reports.
- **Initial implementation ran in parent repo, not the worktree** - first pass of edits accidentally landed in `/Users/limjiale/IDP_PharmGuard/` rather than the worktree at `/Users/limjiale/IDP_PharmGuard/.claude/worktrees/agent-a27ee31f15cd3cc96/`. Reverted parent-repo changes (`git checkout`) and re-applied to the correct worktree paths. The validation suite was re-run on worktree paths after the move.

## Issues Encountered

1. **GateGuard fact-forcing hook** fired on every Edit/Write/Create as in prior phases. Each gate was answered with explicit fact lists drawn from the actual repo (callers, glob results, data structure, verbatim user instructions). No actual blockers - gates passed second-try in every case.
2. **Worktree path confusion (caught + recovered)** - first round of edits hit the parent repo. Reverted with `git checkout -- ...` + `rm` for new files, then re-applied to the worktree. Final state: parent repo clean, worktree has all changes on its branch.
3. **No actual implementation blockers** - every task landed first-try after the gate pass.

## Tests Written

None - repo has no test framework. The closest thing is the synthetic confusion-matrix smoke that runs in the Task 7 validation block; it verifies the metric helpers against a hand-calculated 9-pair input.

## Open Handoff Items

To finish Phase 9 the user must:

1. **Acquire a labelled dataset** (`>=10 SKUs * >=100 images each`, per PRD Phase 9). Layout:
   ```
   /path/to/labelled_pills/
     amoxicillin_500/
       img_001.jpg
       img_002.jpg
       ...
     paracetamol_500/
       ...
     <8+ more SKU folders>
   ```
   The operator can stage this anywhere; if you keep it in-repo, drop it under `ml/pill_detector/test_data/` (gitignored).

2. **On the Pi (or workstation with ultralytics + the .pt weights)** - run the headline bench:
   ```bash
   cd ~/IDP_PharmGuard/edge_pi
   python3 scripts/bench_accuracy.py \
       --dataset /path/to/labelled_pills \
       --model models/pill_detector.pt \
       --conf-thresh 0.5
   ```
   This writes `bench_accuracy_<UTC_TS>.md` to cwd with the confusion matrix + per-class precision/recall + overall PASS/FAIL against the PRD targets.

3. **If a gap exists** - run the threshold sweep:
   ```bash
   python3 scripts/tune_threshold.py \
       --dataset /path/to/labelled_pills \
       --model models/pill_detector.pt
   ```
   Pick the threshold the table flags as `PASS` for both accuracy and FPR. Update `PillVerifier(conf_thresh=<value>)` at the construction site in `edge_pi/main.py` if the new value differs from the current `0.5` default.

4. **If no threshold meets PRD targets** - operator retrains via `ml/pill_detector/yolo_detect.py` infrastructure (training data under `ml/pill_detector/Medicine_Images/` per CLAUDE.md), promotes the new weights to `edge_pi/models/pill_detector.pt`, then re-runs `bench_accuracy.py` to confirm pass. Per CLAUDE.md ("Promoting a new training run to the Pi"):
   ```bash
   cp ml/pill_detector/my_model.pt edge_pi/models/pill_detector.pt
   git add edge_pi/models/pill_detector.pt
   git commit -m "models: retrain pill_detector to meet PRD Phase 9 targets"
   make pi-sync HOST=pi@<host>
   ```

5. **Attach the report** - the `bench_accuracy_<UTC_TS>.md` file is the signed-off accuracy artefact for PRD Phase 9. Operator commits it (or attaches to the orchestrator's PRD report).

6. **In production** (Pi running normal cycle, not bench) - `report_intake` will now POST `confidence_score` to `adherence_logs` whenever YOLO produced an observation. Caregiver dashboards (Phase 7) can surface the distribution as a follow-up; the column already exists from Phase 1. Stub mode reports `confidence=None` -> backend stores NULL -> `[0,1]` CHECK passes (constraint allows NULL). HI-012 invariant intact.

## Next Steps
- [ ] User: stage a labelled pill dataset (>=10 SKUs * >=100 images each).
- [ ] User: run `bench_accuracy.py` on Pi 5; capture the markdown report.
- [ ] User: if accuracy gap, run `tune_threshold.py`; if still gap, retrain + promote weights per CLAUDE.md.
- [ ] User: orchestrator updates PRD Phase 9 row to `complete` after operator attestation.
- [ ] After Phase 9 passes: only Phases 8 (offline queue) and 10 (pilot-ready packaging) remain.
