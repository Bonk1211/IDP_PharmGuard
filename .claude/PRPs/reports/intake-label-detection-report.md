# Implementation Report: Intake Label Detection (AWS Rekognition DetectLabels)

## Summary
Added a Layer-2 verification step on top of the MediaPipe FSM. During the intake watch window, a `ThreadPoolExecutor`-driven sampler grabs cam_b frames every ~1.5 s, calls AWS Rekognition `DetectLabels`, and aggregates seen labels onto `IntakeMonitor._state`. `watch_for_swallow` now returns True only when BOTH MediaPipe completes AND at least one required label (bottle/cup/pill/...) is observed. The new terminal state `missing_labels` distinguishes "mimed swallow" from genuine timeout. Kill-switch `INTAKE_LABEL_ENABLED=0` restores MediaPipe-only behavior.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | 9/10 — landed cleanly |
| Files Changed | ~8 | 9 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extend `Settings` (AWS + label) | Complete | Added `aws_region`, `aws_access_key_id`, `aws_secret_access_key`, `intake_label_*` + `intake_label_required_set` property |
| 2 | Update `.env.example` + `requirements.txt` | Complete | Added AWS + INTAKE_LABEL_* env block; added `boto3>=1.34.0` |
| 3 | Create `services/label_detector.py` | Complete | Lazy boto3 client + JPEG encoder + `detect_labels()` wrapper |
| 4 | Extend `IntakeMonitor` with label sampler | Complete | `ThreadPoolExecutor` sampler, gate logic, `mediapipe_complete` flag, new `missing_labels` terminal |
| 5 | Update `cycle_runner` gate | Complete | `pill_taken_actual` now derives from `watch_for_swallow` return; warns on terminal failure |
| 6 | Extend frontend `IntakeState` type | Complete | Widened `result` union + 5 new fields |
| 7 | Render Layer 2 label panel + missing_labels copy | Complete | New `Layer2LabelPanel` component, updated `cam1Footer` |
| 8 | Validate (lint, dry-run, import) | Complete | `tsc --noEmit` zero errors; headless `/api/device/intake` returns new fields |
| 9 | Write report + archive plan | Complete | This report; plan moved to `completed/` |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (tsc) | Pass | `npx tsc --noEmit` zero errors |
| Lint | Skipped | `next lint` is deprecated and prompts interactive ESLint setup — out of scope |
| Backend Imports | Pass | `from services.label_detector import ...`, `from vision.intake_monitor import ...`, `from scheduler.cycle_runner import ...` all clean |
| Unit Tests | N/A | No test suite exists in repo (per CLAUDE.md) |
| Integration (headless dry-run) | Pass | `GET /api/device/intake` returns full shape including `labels_seen`/`labels_seen_at`/`labels_required`/`labels_satisfied`/`mediapipe_complete` |
| Build | N/A | Not run — tsc is the strictest gate without a build profile |
| Edge Cases | Manual | Documented in plan; awaiting Pi hardware deploy |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `backend/config.py` | UPDATED | +22 |
| `backend/.env.example` | UPDATED | +17 |
| `backend/requirements.txt` | UPDATED | +3 |
| `backend/services/label_detector.py` | CREATED | +94 |
| `backend/vision/intake_monitor.py` | UPDATED | +119 / -6 |
| `backend/scheduler/cycle_runner.py` | UPDATED | +14 / -3 |
| `backend/api/device.py` | UPDATED | +9 |
| `frontend/src/lib/device.ts` | UPDATED | +12 / -1 |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATED | +132 / -6 |

## Deviations from Plan

- **Task 2 scope expansion**: the plan listed `.env.example` only; bundled `requirements.txt` boto3 addition into the same task to keep the AWS-bootstrap step atomic.
- **Task 5 gate placement**: plan moved `pill_taken_actual = True` after `watch_for_swallow`, but kept the existing bench-mode short-circuit so accuracy benchmarks aren't blocked by missing AWS keys (no real intake happens in bench mode anyway).
- **device.py headless fallback**: not explicitly listed in the plan's "Files to Change" — discovered during dry-run that the headless idle state in `api/device.py:380` hard-codes a state dict separate from `_initial_state()`. Added new keys to keep the IntakeState type contract consistent in headless mode.
- **Frontend lint skipped**: `next lint` is deprecated in Next.js and prompts interactive ESLint migration. tsc covered the type-safety check; lint left as a follow-up.

## Issues Encountered

- **Wrong Python at first import**: dev-mac has both system Python 3.10 and the project venv. First `python -c "..."` hit the system interpreter without `cv2`. Resolved by `source .venv/bin/activate` before each backend smoke check.
- **Background uvicorn TERM exit 143**: harmless — that's `SIGTERM` from `kill` after the dry-run probe.
- **Plan referenced face-verify plan deps**: face-verify plan (`patient-face-verify-rekognition.plan.md`) hadn't been implemented yet, but it owns the AWS settings. Per user choice, AWS settings + boto3 were added in this plan instead so face-verify can layer on later without duplicating fields.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| — | 0 | No test suite in repo |

## Manual Smoke (headless dev-mac)

```bash
curl -s -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8765/api/device/intake | jq .
```
Returns dict with `result=null`, `labels_seen=[]`, `labels_required=[]`, `labels_satisfied=false`, `mediapipe_complete=false`. Shape matches the frontend `IntakeState` type.

## Next Steps

- [ ] Set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `backend/.env` on the Pi.
- [ ] `make pi-sync HOST=pi@<host>` to deploy.
- [ ] On the Pi: `sudo systemctl restart pharmguard` and run one real intake holding a water bottle in cam 1. Confirm log line `Intake: PASSED (mediapipe + labels=['bottle'])`.
- [ ] Run a negative test: same intake without any bottle/cup → expect `missing_labels`, `pill_taken=false` in `adherence_logs`.
- [ ] Set up AWS CloudWatch billing alarm at $5/day.
- [ ] Implement `patient-face-verify-rekognition.plan.md` to add Layer-1 face verification (Step 0 gate). Now unblocked since AWS settings live in `config.py` already.
- [ ] Optional: `/code-review` → `/prp-commit` → `/prp-pr` to ship the change.
