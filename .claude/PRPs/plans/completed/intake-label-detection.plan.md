# Plan: Intake Label Detection — AWS Rekognition DetectLabels (Layer 2 over MediaPipe)

## Summary
Add a second verification layer to the intake watch step. While MediaPipe FSM runs on cam 1 (face/hand geometry), a parallel sampler grabs frames every ~1.5 s, calls AWS Rekognition `DetectLabels`, and aggregates seen labels. Intake is **hard-gated**: confirmation requires BOTH MediaPipe pass AND at least one expected label (bottle/cup/pill) seen during the window.

## User Story
As a caregiver, I want the intake check to require not just face/hand motion but also visible evidence of typical pill-taking objects (water bottle, cup, pill in hand), so a patient miming the motion without actually taking a pill is rejected.

## Problem → Solution
MediaPipe pass alone proves only "hand approached mouth, mouth closed, mouth opened empty" — defeatable by miming. → DetectLabels adds object-presence evidence; hard gate combines both signals before logging `pill_taken=True`.

## Why not Streaming Video / Kinesis
- AWS Rekognition Streaming Video is **deprecated for new customers** (per AWS docs).
- Even where available, Stream Processor `ConnectedHomeSettings` only emits PERSON / PET / PACKAGE — no Bottle / Cup / Pill / Drink labels.
- Bottle/cup/pill require synchronous `DetectLabels` (or Custom Labels). KVS would add infra with zero gating benefit.

User-confirmed pivot: **DetectLabels polling, no KVS**. KVS path deferred — see "Future Extensions".

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: standalone, follows `patient-face-verify-rekognition.plan.md`
- **Estimated Files**: ~8

---

## UX Design

### Before (step 3 "Verify")
```
┌── AI INTAKE CHECK ──────────┐  ┌── Cam 1 · Patient ──┐
│ Step 2/3 SWALLOW            │  │ [MJPEG + FaceMesh]  │
│ Confidence ████████░░ 78%   │  │                     │
│ Hold ██████░░░░ 60%         │  │                     │
└─────────────────────────────┘  └─────────────────────┘
```

### After
```
┌── AI INTAKE CHECK ──────────┐  ┌── Cam 1 · Patient ──┐
│ Step 2/3 SWALLOW            │  │ [MJPEG + FaceMesh]  │
│ Confidence ████████░░ 78%   │  │                     │
│ Hold ██████░░░░ 60%         │  │                     │
├── Layer 2 · OBJECT EVIDENCE ┤  └─────────────────────┘
│ ✓ Bottle    last 1.2s ago   │
│ ✓ Cup       last 4.0s ago   │
│ ─ Pill      not seen        │
│ Required: bottle|cup|pill   │
│ Layer 2: 2/1 ✓              │
└─────────────────────────────┘
Result on done: MediaPipe ✓ · Labels ✓ → PASS
                MediaPipe ✓ · Labels ✗ → MISSING_LABELS
                MediaPipe ✗            → TIMEOUT
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Step 3 panel | MediaPipe FSM only | + Live label readout | Updates from same `/api/device/intake` poll (no new endpoint) |
| `result` field | `"passed" \| "timeout" \| null` | + `"missing_labels"` | New terminal state when MediaPipe passes but no required labels seen |
| Cycle log | `pill_taken=mediapipe_passed` | `pill_taken = mediapipe_passed AND labels_satisfied` | Hard gate enforced in `cycle_runner.run_cycle` |
| `confidence_score` on log | EMA from MediaPipe | Same | Label set NOT averaged into confidence; surfaced separately |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/vision/intake_monitor.py` | 60-95, 200-298 | `_initial_state`, `process_frame` — where new state fields + label-check branch live |
| P0 | `backend/vision/intake_monitor.py` | 300-340 | `watch_for_swallow` loop — where label sampler runs alongside FSM |
| P0 | `backend/scheduler/cycle_runner.py` | 397-441 | Cycle calls `watch_for_swallow` then writes `pill_taken_actual` to DB — gate point |
| P0 | `backend/api/device.py` | 368-398 | `intake_state` endpoint — extend response with `labels_seen` |
| P0 | `backend/config.py` | 56-79 | Settings shape; add `intake_label_*` fields |
| P0 | `frontend/src/lib/device.ts` | 37-59 | `IntakeState` type — extend with labels fields |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 718-740 | Step 3 render block — where Layer 2 panel inserts |
| P1 | `.claude/PRPs/plans/patient-face-verify-rekognition.plan.md` | Tasks 3-6 | AWS settings + boto3 lazy-client pattern (REUSE) |
| P1 | `backend/api/device.py` | 167-266 | Frame-encode + boto3 wrap pattern (`verify_pill` shape) |
| P2 | `backend/vision/camera.py` | 124-263 | RpicamSource multi-consumer fan-out — confirm second frame reader safe |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Rekognition DetectLabels | https://docs.aws.amazon.com/rekognition/latest/APIReference/API_DetectLabels.html | `Image={"Bytes": jpeg}`, `MinConfidence` (default 55), `MaxLabels` (default 100). Response `.Labels[].Name` + `.Confidence`. Free-tier 5000 images/mo first 12 months; then $0.001/image (us-east-1). |
| boto3 detect_labels | https://docs.aws.amazon.com/boto3/latest/reference/services/rekognition/client/detect_labels.html | `client.detect_labels(Image={"Bytes": b}, MinConfidence=70, MaxLabels=30, Features=["GENERAL_LABELS"])` |
| Label taxonomy | https://docs.aws.amazon.com/rekognition/latest/dg/samples/AmazonRekognitionLabels_v3.0.zip | Standard labels include `Bottle`, `Cup`, `Mug`, `Drink`, `Drinking`, `Water Bottle`, `Pill`, `Hand`, `Person`, `Finger` |
| Streaming Video deprecation | https://docs.aws.amazon.com/rekognition/latest/dg/rekognition-availability-changes.html | "Streaming Video and Bulk Image Analysis is no longer available to new customers" |

---

## Patterns to Mirror

### BOTO3_LAZY_CLIENT
// SOURCE: see `services/face_verify.py` from `patient-face-verify-rekognition.plan.md`
```python
_client = None
def _get_client():
    global _client
    if _client is not None:
        return _client
    import boto3  # lazy
    _client = boto3.client("rekognition",
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id or None,
        aws_secret_access_key=settings.aws_secret_access_key or None,
    )
    return _client
```
Reuse boto3 default session; one cached client per module is fine.

### THREAD_POOL_SUBMIT_NONBLOCKING
// SOURCE: backend/vision/intake_monitor.py:316-326 (existing while-loop polling shape)
```python
while time.time() < deadline:
    frame = self._read_frame()
    if frame is None:
        time.sleep(0.02)
        continue
    frame = cv2.flip(frame, 1)
    self.process_frame(frame)
    ...
    time.sleep(0.05)
```
Per-tick loop already exists. Hook in: every Nth tick, `pool.submit(_label_call, frame.copy())`. Submit is non-blocking; results land in `_state["labels_seen"]` asynchronously.

### STATE_LOCK
// SOURCE: backend/vision/intake_monitor.py:182-202
```python
self._lock = threading.Lock()
def get_state(self) -> dict:
    with self._lock:
        return dict(self._state)
```
All `_state` mutations (including from label-callback threads) must hold `self._lock`.

### ENDPOINT_RESPONSE_PASSTHROUGH
// SOURCE: backend/api/device.py:368-398
```python
@router.get("/intake")
async def intake_state(request: Request):
    ...
    return monitor.get_state()
```
`/api/device/intake` returns the dict verbatim. Adding new keys to `_state` automatically surfaces them to the frontend — no endpoint change.

### TYPESCRIPT_STATE_EXTEND
// SOURCE: frontend/src/lib/device.ts:43-59
```typescript
export type IntakeState = {
  running: boolean;
  step_index: number;
  ...
};
```
Pure additive extension; existing consumers unaffected.

### CYCLE_GATE
// SOURCE: backend/scheduler/cycle_runner.py:420-431
```python
await asyncio.to_thread(state.monitor.watch_for_swallow, 60)
...
pill_taken_actual = True
```
`watch_for_swallow` returns bool; cycle currently maps `True → pill_taken=True`. Tighten: `pill_taken_actual = mediapipe_pass and labels_satisfied`, with `labels_satisfied` reflected via the monitor's terminal `result`.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/services/label_detector.py` | CREATE | Wrap boto3 `detect_labels`, JPEG encode, label aggregation utility |
| `backend/vision/intake_monitor.py` | UPDATE | Extend state with label fields, spawn sampler in `watch_for_swallow`, gate final `result` |
| `backend/api/device.py` | UPDATE (minor) | Passthrough already works; verify shape only |
| `backend/config.py` | UPDATE | Add `intake_label_required`, `intake_label_min_confidence`, `intake_label_poll_interval_s`, `intake_label_enabled` |
| `backend/.env.example` | UPDATE | Document new label vars |
| `backend/scheduler/cycle_runner.py` | UPDATE | Update log line + comment; `pill_taken_actual` now derives from `watch_for_swallow` return + monitor result |
| `frontend/src/lib/device.ts` | UPDATE | Extend `IntakeState` type with `labels_seen / labels_required / labels_satisfied / mediapipe_complete`; widen `result` union |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | New `Layer2LabelPanel` inside step-3 view; `missing_labels` toast + footer copy |

## NOT Building

- KVS streaming, Stream Processor, Custom Labels project, on-device YOLO label model.
- Per-label heatmaps / bbox overlay on cam 1 (only label *names* surface, not boxes).
- Persisting label history to DB (`labels_seen` is in-memory only; only the binary `labels_satisfied` flag feeds the gate).
- Adapting label thresholds per patient.
- Retry/backoff on Rekognition throttling beyond boto3 defaults.

---

## Step-by-Step Tasks

### Task 1: Extend `Settings`
- **ACTION**: Update `backend/config.py`
- **IMPLEMENT**:
  ```python
  # Layer-2 intake object detection (AWS Rekognition DetectLabels)
  intake_label_required: str = "Bottle,Cup,Mug,Drink,Drinking,Pill"  # CSV
  intake_label_min_confidence: float = 70.0  # 0-100
  intake_label_poll_interval_s: float = 1.5
  intake_label_enabled: bool = True  # kill-switch
  ```
  Add `@property def intake_label_required_set(self) -> set[str]:` returning `{x.strip().lower() for x in self.intake_label_required.split(",") if x.strip()}`.
- **MIRROR**: CONFIG_SETTINGS pattern from face-verify plan
- **GOTCHA**: Reuse `aws_region` / `aws_access_key_id` / `aws_secret_access_key` from face-verify plan — do NOT duplicate. If face-verify plan not yet merged, add those fields here.
- **VALIDATE**: `python -c "from config import settings; print(settings.intake_label_required_set)"`

### Task 2: Update `.env.example`
- **ACTION**: Append under AWS block:
  ```dotenv
  # ─── Layer-2 intake label detection (DetectLabels) ───
  INTAKE_LABEL_ENABLED=1
  # CSV — any one match (case-insensitive) is enough for the hard gate.
  INTAKE_LABEL_REQUIRED=Bottle,Cup,Mug,Drink,Drinking,Pill
  INTAKE_LABEL_MIN_CONFIDENCE=70
  # Seconds between DetectLabels calls during intake window. 1.5s × 60s window ≈ 40 calls × $0.001 = ~$0.04/round.
  INTAKE_LABEL_POLL_INTERVAL_S=1.5
  ```

### Task 3: Create `backend/services/label_detector.py`
- **ACTION**: New service module
- **IMPLEMENT**:
  ```python
  """AWS Rekognition DetectLabels for intake object evidence."""
  from __future__ import annotations
  import logging
  import cv2
  import numpy as np
  from config import settings

  log = logging.getLogger(__name__)
  _client = None

  def _get_client():
      global _client
      if _client is not None:
          return _client
      import boto3
      _client = boto3.client("rekognition",
          region_name=settings.aws_region,
          aws_access_key_id=settings.aws_access_key_id or None,
          aws_secret_access_key=settings.aws_secret_access_key or None,
      )
      return _client

  def encode_frame_jpeg(frame: np.ndarray, quality: int = 75) -> bytes:
      """RGB or BGR ndarray → JPEG bytes. cam_b emits RGB."""
      bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if frame.ndim == 3 else frame
      ok, jpeg = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
      if not ok:
          raise RuntimeError("JPEG encode failed")
      return jpeg.tobytes()

  def detect_labels(jpeg_bytes: bytes,
                    min_confidence: float = 70.0,
                    max_labels: int = 30) -> dict:
      """Returns {labels: [{name, confidence}], error: str|None}."""
      try:
          resp = _get_client().detect_labels(
              Image={"Bytes": jpeg_bytes},
              MinConfidence=float(min_confidence),
              MaxLabels=int(max_labels),
              Features=["GENERAL_LABELS"],
          )
      except Exception as exc:
          log.warning("DetectLabels failed: %s", exc)
          return {"labels": [], "error": str(exc)}
      out = [
          {"name": lbl.get("Name"), "confidence": float(lbl.get("Confidence", 0.0))}
          for lbl in resp.get("Labels") or []
      ]
      return {"labels": out, "error": None}
  ```
- **MIRROR**: BOTO3_LAZY_CLIENT
- **GOTCHA**:
  - cam_b is RGB → must convert to BGR before `cv2.imencode`.
  - `MaxLabels=30` keeps payload small; default 100 wastes bandwidth.
  - DON'T pass `MinConfidence` lower than 50 — false positives flood.

### Task 4: Extend `IntakeMonitor` state + sampler
- **ACTION**: Edit `backend/vision/intake_monitor.py`
- **IMPLEMENT**:
  1. Extend `_initial_state()`:
     ```python
     return {
         ...existing...
         "labels_seen": [],            # ordered unique list (most recent last)
         "labels_seen_at": {},         # {label_name_lower: epoch_seconds}
         "labels_required": [],        # snapshot from settings, exposed for UI
         "labels_satisfied": False,
         "mediapipe_complete": False,
     }
     ```
  2. In `__init__`, add:
     ```python
     from concurrent.futures import ThreadPoolExecutor
     self._label_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="intake-labels")
     self._last_label_submit: float = 0.0
     ```
  3. In `process_frame`, when FSM completes (existing `next_idx >= len(_STEPS)` branch ~line 279), DO NOT set `result="passed"` directly. Instead:
     ```python
     self._state["mediapipe_complete"] = True
     self._state["ended_at"] = time.time()
     # result stays None until labels also pass OR watch_for_swallow times out
     ```
     Also: if `intake_label_enabled` is False, immediately set `result="passed"` (kill-switch path) so behaviour matches today.
  4. Add helper:
     ```python
     def _maybe_submit_label_call(self, frame: np.ndarray) -> None:
         from config import settings
         if not settings.intake_label_enabled:
             return
         now = time.time()
         if now - self._last_label_submit < settings.intake_label_poll_interval_s:
             return
         self._last_label_submit = now
         frame_copy = frame.copy()
         self._label_pool.submit(self._run_label_call, frame_copy)

     def _run_label_call(self, frame: np.ndarray) -> None:
         from services.label_detector import detect_labels, encode_frame_jpeg
         from config import settings
         try:
             jpeg = encode_frame_jpeg(frame)
         except Exception:
             log.exception("label encode failed")
             return
         resp = detect_labels(jpeg,
             min_confidence=settings.intake_label_min_confidence,
         )
         if resp["error"]:
             return
         required = settings.intake_label_required_set  # lowercased set
         now = time.time()
         with self._lock:
             seen_at = self._state["labels_seen_at"]
             seen_list = self._state["labels_seen"]
             for lbl in resp["labels"]:
                 nm = (lbl["name"] or "").strip()
                 if not nm:
                     continue
                 key = nm.lower()
                 if key not in seen_at:
                     seen_list.append(nm)
                 seen_at[key] = now
             matched = required & set(seen_at.keys())
             self._state["labels_satisfied"] = bool(matched)
             # If mediapipe already complete and labels just satisfied → pass
             if self._state["mediapipe_complete"] and self._state["labels_satisfied"] \
                and self._state["result"] is None:
                 self._state["result"] = "passed"
                 self._state["running"] = False
                 log.info("Intake: PASSED (mediapipe + labels=%s)", sorted(matched))
     ```
  5. In `watch_for_swallow`, inject:
     ```python
     from config import settings
     with self._lock:
         self._state["labels_required"] = sorted(settings.intake_label_required_set)
     ...
     while time.time() < deadline:
         frame = self._read_frame()
         ...
         frame = cv2.flip(frame, 1)
         self.process_frame(frame)
         self._maybe_submit_label_call(frame)
         with self._lock:
             if self._state["result"] == "passed":
                 return True
         time.sleep(0.05)
     # Timeout:
     with self._lock:
         if self._state["mediapipe_complete"] and not self._state["labels_satisfied"]:
             self._state["result"] = "missing_labels"
         else:
             self._state["result"] = "timeout"
         self._state["ended_at"] = time.time()
         self._state["running"] = False
     return False
     ```
  6. In `close`: shutdown pool with `self._label_pool.shutdown(wait=False, cancel_futures=True)`.
- **MIRROR**: STATE_LOCK, THREAD_POOL_SUBMIT_NONBLOCKING
- **GOTCHA**:
  - **Frame copy is required** — `frame_copy = frame.copy()` before submit, because RpicamSource may mutate the original in place.
  - Pool size 2 is enough; DetectLabels typically 200-400 ms round-trip.
  - Don't await the futures — let them fire-and-forget. Pool shutdown on close drops in-flight.
  - When AWS keys missing, `detect_labels` returns `error != None` and labels never satisfy → intake will end as `missing_labels` even on real swallow. Surface clearly in env-example.
  - `running` must flip to False on terminal state so /api/device/intake clients stop polling.

### Task 5: No /api/device/intake endpoint change required
- **ACTION**: Verify only — `intake_state` already returns `monitor.get_state()` (device.py:398), so new keys propagate automatically.
- **VALIDATE**: `curl /api/device/intake` after intake run shows `labels_seen`, `labels_required`, `labels_satisfied`, `mediapipe_complete`.

### Task 6: Update cycle log + gate mapping
- **ACTION**: Edit `backend/scheduler/cycle_runner.py` ~line 420-431
- **IMPLEMENT**: Map the bool return + terminal state to `pill_taken_actual`:
  ```python
  if not settings.bench_mode:
      mediapipe_pass = await asyncio.to_thread(state.monitor.watch_for_swallow, 60)
      result = state.monitor.get_state().get("result")
      pill_taken_actual = mediapipe_pass  # watch_for_swallow only returns True on passed
      if not pill_taken_actual:
          log.warning(
              "Intake gate failed (result=%s) — pill_taken stays False", result,
          )
  ```
- **GOTCHA**: Today's code sets `pill_taken_actual = True` BEFORE `watch_for_swallow`. Move that assignment to AFTER, contingent on the gate result. Re-check current diff before edit.
- **VALIDATE**: Cycle dry-run logs the gate state on failure.

### Task 7: Extend frontend `IntakeState` type
- **ACTION**: Edit `frontend/src/lib/device.ts`
- **IMPLEMENT**:
  ```typescript
  export type IntakeState = {
    /* ...existing... */
    result: "passed" | "timeout" | "missing_labels" | null;  // extended
    labels_seen: string[];
    labels_seen_at: Record<string, number>;
    labels_required: string[];
    labels_satisfied: boolean;
    mediapipe_complete: boolean;
  };
  ```
- **MIRROR**: TYPESCRIPT_STATE_EXTEND
- **VALIDATE**: `npm run lint` zero errors.

### Task 8: Render Layer 2 panel + new failure copy
- **ACTION**: Edit `frontend/src/app/dispensers/[id]/page.tsx`
- **IMPLEMENT**:
  1. Find `AIIntakeCheck` block under `viewIdx === 3` (~line 731). Below it, render a `Layer2LabelPanel`:
     ```tsx
     <Layer2LabelPanel intake={intake} now={now} />
     ```
     Component shows: required labels list with ✓/─ next to each (✓ when label name lowercased is in `Object.keys(intake.labels_seen_at)`), seconds since each match, plus aggregate `labels_satisfied`.
  2. Update `cam1Footer` mapping to handle `"missing_labels"`:
     ```typescript
     const cam1Footer = intake?.running
       ? `${intake.instruction} · ${Math.round((intake.hold_progress ?? 0) * 100)}%`
       : intake?.result === "passed"
       ? "✓ Intake confirmed"
       : intake?.result === "missing_labels"
       ? "✗ No bottle/cup/pill seen"
       : intake?.result === "timeout"
       ? "✗ Intake timed out"
       : "Idle";
     ```
  3. Hard-gate the existing "Confirm" button in step 3 to require `intake?.result === "passed"`; show distinct toast when `result === "missing_labels"`.
- **GOTCHA**: Existing dashboard treats `intake.result === "passed"` as final OK. With the new gate, "passed" can only arrive AFTER labels satisfy — so existing gates still work, just take longer. UI must NOT advance stepIdx based on `mediapipe_complete` alone.
- **VALIDATE**: Visual smoke — hold a bottle into cam 1 during intake; ✓ appears next to "Bottle" within 1-2 s.

### Task 9: Validate cost guardrail
- **ACTION**: Confirm sampler can't fire when intake idle
- **IMPLEMENT**: `_maybe_submit_label_call` is only invoked from `watch_for_swallow`'s loop. No useEffect or polling path on the dashboard calls it. Hard rule: ZERO DetectLabels calls when `intake.running === false`.
- **VALIDATE**: AWS billing alert at $5/day; monitor first week.

### Task 10: Pi deploy
- **ACTION**: Sync + restart
- **IMPLEMENT**:
  ```bash
  make pi-sync HOST=pi@<host>
  ssh pi@<host> 'sudo systemctl restart pharmguard && journalctl -u pharmguard -f | grep -E "intake|label"'
  ```
- **VALIDATE**: Run one intake cycle holding a water bottle — log line `Intake: PASSED (mediapipe + labels=['bottle'])`.

---

## Testing Strategy

No test suite exists (per CLAUDE.md). Manual matrix only.

### Manual Test Matrix
| Test | Input | Expected | Edge |
|---|---|---|---|
| Happy path | Patient swallows pill with water bottle visible | MediaPipe pass + ≥1 label match → `result=passed`, `pill_taken=True` | No |
| Mime only | Patient mimes motion, no bottle/cup/pill in frame | MediaPipe pass + no labels → `result=missing_labels`, `pill_taken=False` | Yes |
| Bottle but no swallow | Patient holds bottle, no FSM completion | timeout → `mediapipe_complete=False`, `result=timeout` | Yes |
| AWS keys missing | Empty `AWS_ACCESS_KEY_ID` | `detect_labels` errors silently logged; labels never satisfy → `missing_labels` after timeout | Yes |
| `INTAKE_LABEL_ENABLED=0` | Kill-switch off | Sampler skipped; `process_frame` sets `result="passed"` on MediaPipe complete → MediaPipe-only behavior | Yes |
| Rekognition throttling | Many concurrent intake cycles | boto3 default backoff; some calls fail; gate falls back to `missing_labels` if labels truly never seen | Yes |
| Off-list label only | Frame shows "Person", "Hand" only (no Bottle/Cup/Pill) | `labels_satisfied=False` | Yes |

---

## Validation Commands

### Backend import
```bash
cd backend
python -c "from services.label_detector import detect_labels; from vision.intake_monitor import IntakeMonitor; print('ok')"
```
EXPECT: `ok`, no boto3 import yet.

### Dry-run with kill-switch off
```bash
cd backend
BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 INTAKE_LABEL_ENABLED=0 uvicorn main:app --port 8000
curl -s -H 'X-Device-API-Key: '"$DEVICE_API_KEY" localhost:8000/api/device/intake | jq .
```
EXPECT: response includes new fields `labels_seen=[]`, `labels_required=[]`, `labels_satisfied=false`, `mediapipe_complete=false`.

### Frontend lint
```bash
cd frontend && npm run lint
```
EXPECT: zero errors.

### Pi end-to-end
```bash
# on Pi
sudo systemctl restart pharmguard
journalctl -u pharmguard -f | grep -E 'DetectLabels|Intake'
```
EXPECT: `Intake: PASSED (mediapipe + labels=['bottle'])` on a real intake.

### Manual Validation
- [ ] Settings load: `labels_required_set` populated from CSV.
- [ ] Dry-run /intake response includes new keys.
- [ ] Frontend lint passes.
- [ ] Real intake with bottle → PASSED.
- [ ] Real intake without bottle → missing_labels.
- [ ] AWS keys missing → never hangs (timeout → missing_labels).

---

## Acceptance Criteria
- [ ] `IntakeMonitor._state` carries `labels_seen / labels_seen_at / labels_required / labels_satisfied / mediapipe_complete`.
- [ ] `watch_for_swallow` returns True iff both MediaPipe FSM and labels satisfy.
- [ ] Cycle logs `pill_taken=False` when intake ends `missing_labels`.
- [ ] Frontend renders live label panel during step 3.
- [ ] Kill-switch `INTAKE_LABEL_ENABLED=0` restores MediaPipe-only flow.
- [ ] No new DetectLabels calls when intake not running (cost guard).
- [ ] No regression in MediaPipe-only path with kill-switch off.

## Completion Checklist
- [ ] Lazy boto3 import (no boot cost on dev-mac).
- [ ] Frame copy before pool.submit (no concurrent-mutation bugs).
- [ ] All `_state` mutations under `self._lock`.
- [ ] `confidence_score` on adherence_logs unchanged (only the binary gate changes).
- [ ] CLAUDE.md not edited.
- [ ] No new test infra.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AWS Rekognition latency >2 s under load | Medium | Labels arrive late → false `missing_labels` on tight 60 s window | Pool size 2, allow stale match within last 30 s, extend window to 90 s if needed |
| False-positive labels ("Bottle" on shampoo) | Medium | Patient passes without taking pill | Tighten `INTAKE_LABEL_MIN_CONFIDENCE` to 80; require ≥2 distinct matches |
| Cost blow-up if sampler leaks | Low | Surprise AWS bill | Hard guard: sampler only inside `watch_for_swallow`; AWS billing alert |
| Rekognition deprecation expands | Low | Service goes away | Kill-switch + fallback to MediaPipe-only is one env var away |
| Throttling under multi-Pi deploy | Low | Some calls dropped | boto3 default retries; deeper backoff is out of scope |
| Cam 1 lighting too dark | Medium | Labels fail to fire | Tune `MinConfidence` per site; expose threshold to env (already done) |

## Future Extensions (NOT in scope)

- **KVS + Stream Processor** (deferred): if AWS account is grandfathered for streaming, Pi can `kvssink` cam 1 to a Kinesis Video Stream, archive intake clips in S3, and run a separate `CONNECTED_HOME` stream processor for PERSON-presence sanity check. Still need `DetectLabels` for bottle/cup/pill — KVS adds archival, not gating.
- **Custom Labels project**: train Rekognition Custom Labels on labeled pill/cup/bottle dataset for higher accuracy. ~$1/hr endpoint cost. Plug into `label_detector.py` as alternative client.
- **On-device YOLO** for object presence: zero AWS cost, ~150 ms/frame on Pi 5. Would replace `services/label_detector.py` with a local model.
- **Per-patient required-labels override**: extend `patients` table with an `intake_label_required text[]` column.
- **Persist label timeline to DB**: store `labels_seen_at` snapshot on each `adherence_logs` row for clinician review.

## Notes
- cam_b is opened with `output_format="rgb"` (cycle_runner.py:118). `encode_frame_jpeg` converts to BGR before `cv2.imencode`. Skip the convert → red/blue channels swap → labels degrade silently.
- Label *names* from Rekognition use Title Case (`"Water Bottle"`, `"Cup"`). Lowercase both sides when comparing to `intake_label_required_set`.
- `labels_seen_at` map exposes recency, so the UI can show "last seen 1.2 s ago" and grey out stale entries.
- The existing pattern of `intake.result === "passed"` advancing `stepIdx` to 4 still works; no change to step-bar logic, just the *meaning* of `passed` is now stricter.
- Combine with `patient-face-verify-rekognition.plan.md` — both share AWS creds and the boto3 client pattern. Merge order doesn't matter; the two services are independent.
