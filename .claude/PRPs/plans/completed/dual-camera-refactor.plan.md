# Plan: Dual-Camera Refactor (PRD Phase 2)

## Summary
Eliminate the single-camera-shared-by-both-modules assumption in `edge_pi/vision/`. Introduce a `CameraSource` Protocol that wraps either `Picamera2(cam_num)` or `cv2.VideoCapture(...)` behind a uniform `read_frame()` / `close()` interface. Refactor `PillVerifier` and `IntakeMonitor` to take an injected `CameraSource | None`. Update `edge_pi/main.py` to open two CSI cameras (cam 0 + cam 1) and inject them. Add a benchmark that measures p95 frame interval per camera under simultaneous load.

## User Story
As the **PharmGuard Pi runtime**, I want **two CSI cameras feeding two independent vision pipelines (pill-ID top-down + swallow-FSM patient-facing) at the same time**, so that **the dispenser can verify the right pill ejected AND verify the patient swallowed it without time-slicing a single camera or stalling either pipeline**.

## Problem → Solution
**Today**: `PillVerifier(camera_index=0)` and `IntakeMonitor(camera_index=1)` each open and own their own camera lazily. `IntakeMonitor` already accepts a `camera: Any | None` injection (used by `scripts/test_intake_monitor.py`), but `PillVerifier` does not. There is also a latent bug — `IntakeMonitor._using_picamera` stays `False` when a `Picamera2` instance is injected, so `_read_frame()` would call `.read()` (which Picamera2 doesn't have) and crash.
**After**: A `CameraSource` Protocol + two concrete wrappers (`Picamera2Source`, `Cv2Source`) live in `edge_pi/vision/camera.py`. Both vision modules accept `camera: CameraSource | None`. `main.py` opens two `Picamera2Source` instances (cam_num 0 and 1) and injects them. The `_using_picamera` boolean dies. The bench script proves both cams hold p95 < 100 ms frame interval under simultaneous load on Pi 5.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 2 — Dual-camera refactor
- **Estimated Files**: 7 (1 new module + 2 vision module rewrites + main.py + 1 new bench + 1 test-script update + 1 `__init__.py`)
- **Estimated Lines**: ~250 LOC net (new camera module ~120, vision-module deltas ~50 each, bench ~80, main.py +20)

---

## UX Design

Internal change — no user-facing UX transformation.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `PillVerifier(...)` constructor | takes `camera_index=0` | adds `camera: CameraSource \| None = None`, keeps `camera_index` for back-compat | injection optional |
| `IntakeMonitor(...)` constructor | takes `camera_index=1, camera: Any \| None` | takes `camera_index=1, camera: CameraSource \| None = None` | type narrowed |
| `edge_pi/main.py` | instantiates both modules with no camera args | opens 2 `Picamera2Source` at startup, injects | only when not stub-mode |
| `scripts/test_intake_monitor.py` | passes raw `cv2.VideoCapture` via `camera=cap` | wraps it: `Cv2Source(cap)` | one-line change |
| Pi → backend → DB | unchanged | unchanged | refactor only |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `edge_pi/vision/pill_verifier.py` | 1–119 | Class to refactor; current internal-camera-init pattern + `_has_pill` + `confirm_tray_empty` |
| P0 | `edge_pi/vision/intake_monitor.py` | 1–303 | Class to refactor; existing partial injection contract; **Step-4 inverted-logic invariant must survive** (around lines 219–260) |
| P0 | `edge_pi/main.py` | 109–123 | Where `PillVerifier()` + `IntakeMonitor()` are constructed; stub-mode guard at line 87-104 must stay intact |
| P0 | `edge_pi/scripts/test_intake_monitor.py` | 75–95 | Confirms current injection contract: `cap = cv2.VideoCapture(...); IntakeMonitor(camera=cap)` |
| P1 | `edge_pi/scripts/test_pill_detector.py` | 1–end | Existing benchmark style — uses `picamera2` + `YOLO` directly; mirror the imports + arg-parsing for the new dual-cam bench |
| P1 | `edge_pi/hardware/magazine.py` | 24–50 | Pattern: `STUB_ALLOWED` env-flag + `_is_stub` property + fail-loud-vs-stub branch on init failure — mirror in CameraSource init |
| P1 | `edge_pi/config.py` | 38–123 | `PHARMGUARD_STUB` env, lazy settings proxy — referenced when deciding whether to open real cams |
| P1 | `ml/swallow/main5.py` | all | Authoritative swallow-FSM spec per `CLAUDE.md` — reference when modifying `IntakeMonitor` to confirm Step-4 inversion preserved |
| P2 | `edge_pi/requirements.txt` | all | `picamera2>=0.3.12,<0.4.0`, `opencv-python-headless>=4.8.0,<5.0.0`, `ultralytics>=8.0.0,<9.0.0` — versions the refactor must keep working |
| P2 | `CLAUDE.md` | "Edge Pi" section | Dual-camera + lazy-init + Step-4 invariant rules |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Dual cameras on Raspberry Pi 5 | https://www.tomshardware.com/raspberry-pi/how-to-use-dual-cameras-on-the-raspberry-pi-5 | Pi 5 has two CSI lanes; create `Picamera2(0)` and `Picamera2(1)` independently in the same process |
| Picamera2 multi-cam at max resolution issue | https://github.com/raspberrypi/picamera2/issues/1035 | Known: simultaneous **max-resolution** capture on both cams can fail with start() error. Mitigation: configure both at moderate resolution (e.g. 640×480 or 1280×720). |
| Multi-camera streaming forum thread | https://forums.raspberrypi.com/viewtopic.php?t=376767 | Stable for video at lower resolutions; same `start()`/`capture_array()` flow as single-cam |
| Picamera2 manual | https://datasheets.raspberrypi.com/camera/picamera2-manual.pdf | `Picamera2(camera_num=N)` selects CSI port; `create_preview_configuration(main={"format":"RGB888"})` matches existing modules |

---

## Patterns to Mirror

### NAMING_CONVENTION (vision modules)
```python
# SOURCE: edge_pi/vision/pill_verifier.py:1, 21
"""Pill spotter: confirms the dispensing tray is empty after ejection."""
log = logging.getLogger(__name__)

class PillVerifier:
    def __init__(self, model_path: str = "models/spotter.pt", camera_index: int = 0, ...) -> None:
```
Rule: module-level docstring; module-level `log = logging.getLogger(__name__)`; PascalCase class; snake_case methods; `_private` for state. Keep imports alphabetised within each group.

### CAMERA_INIT_PATTERN (current; to be replaced)
```python
# SOURCE: edge_pi/vision/intake_monitor.py:91-115
def _ensure_camera(self) -> None:
    if self._cap is not None:
        return
    if _HAS_PICAMERA2:
        cam = Picamera2(self.camera_index)
        cam.configure(cam.create_preview_configuration(main={"format": "RGB888"}))
        cam.start()
        self._cap = cam
        self._using_picamera = True
        log.info("Intake camera initialized via picamera2 (index=%d)", self.camera_index)
    else:
        cap = cv2.VideoCapture(self.camera_index)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open camera index {self.camera_index}")
        self._cap = cap
        log.info("Intake camera initialized via cv2.VideoCapture (index=%d)", self.camera_index)
```
Rule: lazy init, picamera2 preferred with cv2 fallback, RGB→BGR conversion on read. **Bug to fix**: `_using_picamera` is not set when caller injects a Picamera2 instance — the new abstraction removes the bool entirely.

### OWNERSHIP_PATTERN (already partial in IntakeMonitor)
```python
# SOURCE: edge_pi/vision/intake_monitor.py:74-77, 290-300
def __init__(self, camera_index: int = 1, camera: Any | None = None) -> None:
    self._cap: Any | None = camera
    self._owns_camera = camera is None
    ...

def close(self) -> None:
    if self._cap is not None and self._owns_camera:
        # only close if we opened it ourselves
        ...
```
Rule: a module that receives an injected camera does **not** close it on `close()`. Caller (main.py) owns the lifecycle. Replicate this pattern in `PillVerifier`.

### STUB_FAIL_LOUD_PATTERN (mirror from hardware)
```python
# SOURCE: edge_pi/hardware/magazine.py:24-50
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"

class Magazine:
    def __init__(self) -> None:
        try:
            import RPi.GPIO as GPIO
            ...
            self._is_stub = False
        except Exception as e:
            if STUB_ALLOWED:
                log.warning("GPIO unavailable — stub mode (PHARMGUARD_STUB=1)")
                self._is_stub = True
            else:
                raise RuntimeError("Magazine: GPIO init failed; set PHARMGUARD_STUB=1 to allow stub mode") from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub
```
Rule: when hardware init fails, refuse to run unless `PHARMGUARD_STUB=1`. Camera open follows this same pattern — fail loud if neither picamera2 nor cv2 can produce frames AND stub is not set.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/vision/intake_monitor.py:106
log.info("Intake camera initialized via picamera2 (index=%d)", self.camera_index)
log.warning("Swallow verification timed out after %.1fs", timeout_s)
```
Rule: positional formatters, never f-strings; `log.info` for state transitions, `log.warning` for soft failures, `log.exception` (caller-side) for unexpected exceptions.

### MAIN_LOOP_INSTANTIATION_PATTERN
```python
# SOURCE: edge_pi/main.py:109-123
magazine = Magazine()
ejector = Ejector()
verifier = PillVerifier()
monitor = IntakeMonitor()

hardware_stubbed = magazine.is_stub or ejector.is_stub
if hardware_stubbed:
    if not settings.STUB_MODE:
        log.error("Hardware initialization degraded ... Refusing to run")
        sys.exit(1)
    log.warning("STUB MODE: hardware not real — pill_taken will always be reported False.")
```
Rule: instantiate hardware before the cycle loop; aggregate all `is_stub` flags into one `hardware_stubbed`; refuse to run if any module is stubbed but `PHARMGUARD_STUB` env is missing — guarantees telemetry is never falsified. Camera open must extend this rule, not bypass it.

### BENCH_SCRIPT_PATTERN
```python
# SOURCE: edge_pi/scripts/test_pill_detector.py:1-25
#!/usr/bin/env python3
"""Headless smoke test: capture frames from Pi camera, run pill_detector.pt, save annotated frames."""
import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from picamera2 import Picamera2
from ultralytics import YOLO


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=10)
    ap.add_argument("--width", type=int, default=640)
```
Rule: `#!/usr/bin/env python3` shebang, module docstring, argparse with sensible defaults, headless (no `cv2.imshow`), saves artefacts to `/tmp/<name>_out`. Mirror this for `bench_dual_cam.py`.

### TEST_STRUCTURE
N/A — repo has no test framework. Validation is bench-script + manual check.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `edge_pi/vision/camera.py` | CREATE | `CameraSource` Protocol + `Picamera2Source` + `Cv2Source` + `open_camera(cam_num)` factory. Single source of truth for camera lifecycle. |
| `edge_pi/vision/pill_verifier.py` | UPDATE | Accept `camera: CameraSource \| None`; switch `_read_frame` to `self._source.read_frame()`; back-compat by self-opening when no source injected; add `_owns_source`. |
| `edge_pi/vision/intake_monitor.py` | UPDATE | Same refactor; **fix `_using_picamera` bug**; preserve Step-4 inverted-logic invariant; preserve `_face_mesh.close()` + `_hands.close()` cleanup. |
| `edge_pi/vision/__init__.py` | UPDATE | Export `CameraSource`, `open_camera`, etc., so `main.py` can import from `vision`. |
| `edge_pi/main.py` | UPDATE | After stub-mode aggregation, open `cam_a = open_camera(0)` + `cam_b = open_camera(1)` (only when not stub); inject into modules. |
| `edge_pi/scripts/bench_dual_cam.py` | CREATE | New benchmark — opens 2 cams, captures N seconds, records frame intervals, prints p95 per cam + mean fps. PRD success signal: p95 < 100 ms per cam. |
| `edge_pi/scripts/test_intake_monitor.py` | UPDATE | Wrap `cv2.VideoCapture` with `Cv2Source` (one-line) so the test still works after the type narrowing. |

## NOT Building

- **Hailo / Coral accelerator wiring** — PRD marks <15 ms inference as aspirational stretch; out of scope here.
- **Frame-buffer ring or zero-copy IPC** — Phase 2 ships per-call `capture_array()`; ring buffers can come later if profiling shows need.
- **Async / threaded capture** — keep synchronous calls inside each vision class; concurrency between the two pipelines comes from main.py invoking them at different cycle stages.
- **Camera calibration / intrinsics** — Step-4 mouth-ROI and PnP head-pose remain on default focal-length assumption from `ml/swallow/main5.py`.
- **Video recording / encoder pipeline** — `picamera2` H264 encoders aren't needed; refactor stays at `capture_array()` level.
- **Camera auto-recovery on failure mid-run** — if `read_frame()` returns `None`, the existing `time.sleep(0.02–0.05); continue` loops handle transient drops; structural recovery is Phase 8.
- **Dashboard preview / live-view stream** — frontend doesn't render Pi frames in this phase.
- **Test framework** — no pytest infrastructure introduced; validation is the new bench script + existing test scripts.
- **Step-4 logic changes** — preserved exactly; refactor is camera-only.
- **Switch to USB cameras** — CSI assumed; USB fallback via `Cv2Source` exists but is not the primary path.

---

## Step-by-Step Tasks

### Task 1: Create `edge_pi/vision/camera.py`
- **ACTION**: New module defining the camera abstraction.
- **IMPLEMENT**:
  ```python
  """Uniform camera source: wraps Picamera2 or cv2.VideoCapture behind read_frame() / close()."""
  from __future__ import annotations

  import logging
  import os
  from typing import Any, Protocol, runtime_checkable

  import cv2
  import numpy as np

  try:
      from picamera2 import Picamera2  # type: ignore[import-not-found]
      _HAS_PICAMERA2 = True
  except ImportError:
      _HAS_PICAMERA2 = False

  log = logging.getLogger(__name__)

  # Read once at import — same pattern as edge_pi/hardware/magazine.py.
  _STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"

  # Default capture geometry — moderate to avoid the known dual-cam max-res failure
  # documented at https://github.com/raspberrypi/picamera2/issues/1035.
  DEFAULT_WIDTH = 640
  DEFAULT_HEIGHT = 480


  @runtime_checkable
  class CameraSource(Protocol):
      """Read-one-frame interface. Both Picamera2Source and Cv2Source implement it."""
      def read_frame(self) -> np.ndarray | None: ...
      def close(self) -> None: ...


  class Picamera2Source:
      def __init__(self, cam_num: int, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT) -> None:
          if not _HAS_PICAMERA2:
              raise RuntimeError("picamera2 not available")
          self._cam = Picamera2(cam_num)
          self._cam.configure(
              self._cam.create_preview_configuration(
                  main={"format": "RGB888", "size": (width, height)}
              )
          )
          self._cam.start()
          log.info("Picamera2Source opened (cam_num=%d, %dx%d)", cam_num, width, height)

      def read_frame(self) -> np.ndarray | None:
          frame = self._cam.capture_array()
          if frame is None:
              return None
          return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

      def close(self) -> None:
          try:
              self._cam.stop()
              self._cam.close()
          except Exception:
              log.exception("Picamera2Source close failed (continuing)")


  class Cv2Source:
      """Wrap an existing cv2.VideoCapture (or open one by index)."""
      def __init__(self, source: int | str | cv2.VideoCapture):
          if isinstance(source, cv2.VideoCapture):
              self._cap = source
          else:
              self._cap = cv2.VideoCapture(source)
          if not self._cap.isOpened():
              raise RuntimeError(f"Cv2Source: cannot open {source!r}")
          log.info("Cv2Source opened (%r)", source)

      def read_frame(self) -> np.ndarray | None:
          ok, frame = self._cap.read()
          return frame if ok else None

      def close(self) -> None:
          try:
              self._cap.release()
          except Exception:
              log.exception("Cv2Source close failed (continuing)")


  def open_camera(cam_num: int, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT) -> CameraSource:
      """Open a CSI camera (preferred) with cv2 fallback.

      Raises RuntimeError when neither backend is usable. Stub mode does NOT
      silently return dummy frames — that would falsify telemetry. Stub mode
      only changes log level on the first-fallback path.
      """
      if _HAS_PICAMERA2:
          try:
              return Picamera2Source(cam_num, width, height)
          except Exception as exc:
              if _STUB_ALLOWED:
                  log.warning("Picamera2 open failed for cam_num=%d (%s); trying cv2", cam_num, exc)
              else:
                  raise
      try:
          return Cv2Source(cam_num)
      except Exception as exc:
          raise RuntimeError(f"open_camera: no working backend for cam_num={cam_num}") from exc
  ```
- **MIRROR**: STUB_FAIL_LOUD_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: `cv2`, `numpy as np`, optional `picamera2`. No new deps in `requirements.txt`.
- **GOTCHA**:
  - `Protocol` + `runtime_checkable` works on Python ≥3.8; Pi runs 3.11 (per `test_intake_monitor.py` comment).
  - `Picamera2.capture_array()` returns RGB; both vision modules consume BGR — keep the conversion inside the source.
  - Stub mode only changes warning-vs-raise behavior, never silently returns dummy frames.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile vision/camera.py
  python3 -c "from vision.camera import CameraSource, Cv2Source, Picamera2Source, open_camera; print('OK')"
  ```

### Task 2: Refactor `PillVerifier` to use `CameraSource`
- **ACTION**: Edit `edge_pi/vision/pill_verifier.py`.
- **IMPLEMENT**:
  - Delete the `try: from picamera2 import Picamera2` block + `_using_picamera` boolean.
  - Update constructor:
    ```python
    def __init__(
        self,
        model_path: str = "models/spotter.pt",
        camera_index: int = 0,
        conf_thresh: float = 0.5,
        camera: CameraSource | None = None,
    ) -> None:
        self.model_path = model_path
        self.camera_index = camera_index
        self.conf_thresh = conf_thresh
        self._model: YOLO | None = None
        self._source: CameraSource | None = camera
        self._owns_source = camera is None
    ```
  - Replace `_ensure_camera`:
    ```python
    def _ensure_camera(self) -> None:
        if self._source is not None:
            return
        from vision.camera import open_camera
        self._source = open_camera(self.camera_index)
    ```
  - Replace `_read_frame`:
    ```python
    def _read_frame(self) -> np.ndarray | None:
        return self._source.read_frame() if self._source is not None else None
    ```
  - Update `close`:
    ```python
    def close(self) -> None:
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
    ```
  - Top-of-file imports: drop the `picamera2` try-import block; add `from vision.camera import CameraSource`. If `cv2` is no longer used in this module, drop that too.
- **MIRROR**: NAMING_CONVENTION, OWNERSHIP_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: Add `from vision.camera import CameraSource`. Remove `try: from picamera2 import Picamera2`. Audit `cv2` usage — it was only inside the old `_read_frame`.
- **GOTCHA**:
  - `_has_pill` and `confirm_tray_empty` logic must remain byte-identical — the refactor is camera-only.
  - Don't change `EMPTY_FRAME_STREAK` or `conf_thresh` defaults.
  - `_ensure_camera` no longer constructs a Picamera2 directly — `open_camera()` is the single path.
- **VALIDATE**:
  ```bash
  python3 -m py_compile vision/pill_verifier.py
  python3 -c "from vision.pill_verifier import PillVerifier; v = PillVerifier(); print('OK', type(v).__name__)"
  ```

### Task 3: Refactor `IntakeMonitor` to use `CameraSource` and fix the injection bug
- **ACTION**: Edit `edge_pi/vision/intake_monitor.py`.
- **IMPLEMENT**:
  - Delete the top `try: from picamera2 import Picamera2` block + `_using_picamera` field + the conditional in `_read_frame`.
  - Update constructor signature:
    ```python
    def __init__(self, camera_index: int = 1, camera: CameraSource | None = None) -> None:
        self.camera_index = camera_index
        self._source: CameraSource | None = camera
        self._owns_source = camera is None

        self._face_mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
        )
        self._hands = mp.solutions.hands.Hands(
            max_num_hands=2, min_detection_confidence=0.5
        )
    ```
  - Replace `_ensure_camera`:
    ```python
    def _ensure_camera(self) -> None:
        if self._source is not None:
            return
        from vision.camera import open_camera
        self._source = open_camera(self.camera_index)
    ```
  - Replace `_read_frame`:
    ```python
    def _read_frame(self) -> np.ndarray | None:
        return self._source.read_frame() if self._source is not None else None
    ```
  - Update `close`:
    ```python
    def close(self) -> None:
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
        self._face_mesh.close()
        self._hands.close()
    ```
- **MIRROR**: OWNERSHIP_PATTERN, NAMING_CONVENTION.
- **IMPORTS**: Remove `try: from picamera2 import Picamera2` block. Add `from vision.camera import CameraSource`. Keep `cv2`, `mediapipe as mp`, `numpy as np`.
- **GOTCHA**:
  - **Step-4 inverted-logic invariant** — the `_pill_in_mouth` reset branch around line 252 (resets `timer_start = time.time()` instead of advancing) MUST stay bit-for-bit. Refactor TOUCHES `_read_frame` and `__init__` only.
  - `_face_mesh.close()` + `_hands.close()` must run unconditionally on `close()` — those are owned regardless of camera ownership.
  - Don't fuse the camera-close and mediapipe-close paths — they have different ownership rules.
- **VALIDATE**:
  ```bash
  python3 -m py_compile vision/intake_monitor.py
  python3 -c "from vision.intake_monitor import IntakeMonitor, _STEP_ORDER, REQUIRED_CONFIDENCE, POSE_HOLD_TIME, INSPECTION_HOLD_TIME, SMOOTHING_ALPHA; assert _STEP_ORDER == ('STEP_1_HAND','STEP_2_TILT','STEP_3_LEVEL','STEP_4_MOUTH','STEP_5_TONGUE'); assert REQUIRED_CONFIDENCE == 0.85; print('OK')"
  ```

### Task 4: Update `edge_pi/vision/__init__.py`
- **ACTION**: Re-export the new public surface.
- **IMPLEMENT**:
  ```python
  """Vision pipeline: pill spotter, swallow verification, and the camera abstraction."""

  from vision.camera import CameraSource, Cv2Source, Picamera2Source, open_camera
  from vision.intake_monitor import IntakeMonitor
  from vision.pill_verifier import PillVerifier

  __all__ = [
      "CameraSource",
      "Cv2Source",
      "IntakeMonitor",
      "Picamera2Source",
      "PillVerifier",
      "open_camera",
  ]
  ```
- **MIRROR**: existing `__init__.py` style (alphabetised `__all__`).
- **IMPORTS**: re-exports only.
- **GOTCHA**: alphabetical order matters.
- **VALIDATE**:
  ```bash
  python3 -c "from vision import CameraSource, IntakeMonitor, PillVerifier, open_camera; print('OK')"
  ```

### Task 5: Wire dual cameras into `edge_pi/main.py`
- **ACTION**: Edit `edge_pi/main.py` — open 2 cams, inject.
- **IMPLEMENT**:
  - At top of file, change vision imports:
    ```python
    from vision import CameraSource, IntakeMonitor, PillVerifier, open_camera
    ```
  - In `run()`, replace the existing `verifier = PillVerifier(); monitor = IntakeMonitor()` block. Order: first the `Magazine`/`Ejector` instantiation (unchanged), then the `hardware_stubbed` aggregation (unchanged), THEN the camera + module wiring:
    ```python
    cam_a: CameraSource | None = None
    cam_b: CameraSource | None = None
    if not hardware_stubbed:
        try:
            cam_a = open_camera(0)  # tray top-down (pill ID)
            cam_b = open_camera(1)  # patient-facing (swallow FSM)
        except Exception:
            log.exception("Camera initialization failed")
            if not settings.STUB_MODE:
                sys.exit(3)
            log.warning("STUB MODE: camera unavailable — vision verifies will be skipped")

    verifier = PillVerifier(camera=cam_a)
    monitor = IntakeMonitor(camera=cam_b)
    ```
  - Behavior contract:
    - When `hardware_stubbed=False` and both cams open → both injected, full pipeline.
    - When `hardware_stubbed=True` → both `cam_a, cam_b = None`; modules see `camera=None`. Existing `if hardware_stubbed: pill_taken_actual = False` branch (line ~155) means `_ensure_camera` is never called.
    - When `hardware_stubbed=False` but `open_camera` raises and `STUB_MODE=1` → log warning, leave cameras None, modules will `_ensure_camera` lazily and may fail at that point (acceptable in dev).
- **MIRROR**: MAIN_LOOP_INSTANTIATION_PATTERN.
- **IMPORTS**: `from vision import CameraSource, IntakeMonitor, PillVerifier, open_camera`.
- **GOTCHA**:
  - **Stub-mode fail-loud safety must be preserved** (`edge_pi/main.py:87-104`). Camera-open failure is a NEW failure mode — wire it the same way: `sys.exit(3)` if not stub.
  - Don't add a `cam_a.close()` cleanup at end of `run()` — `run()` has no shutdown path today (infinite loop). If atexit/signal handler is added later, that's a separate change.
  - `CameraSource` Protocol typing for `cam_a: CameraSource | None` works at runtime; `runtime_checkable` makes `isinstance(x, CameraSource)` valid.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  DISPENSER_ID=dispenser-001 \
  python3 -c "import main; print('main module imports OK')"
  ```

### Task 6: Create `edge_pi/scripts/bench_dual_cam.py`
- **ACTION**: New benchmark script — proves PRD success signal.
- **IMPLEMENT**:
  ```python
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
          print(f"  {cam}: n={int(s['n']):5d}  fps={s['fps']:6.1f}  "
                f"p50={s['p50_ms']:6.1f}ms  p95={s['p95_ms']:6.1f}ms  max={s['max_ms']:7.1f}ms  [{marker}]")
          ok = ok and s["p95_ms"] < target_p95
      print(f"\nResult: {'PASS' if ok else 'FAIL'} (target: p95 < {target_p95:.0f} ms per cam)")
      return 0 if ok else 1


  if __name__ == "__main__":
      sys.exit(main())
  ```
- **MIRROR**: BENCH_SCRIPT_PATTERN.
- **IMPORTS**: stdlib + `vision.camera.open_camera`.
- **GOTCHA**:
  - The interleaved `read_frame` calls share one thread — that is *intentional*: it measures real Pi behavior under main.py's call pattern, not a parallel-thread upper bound.
  - Default 640×480 avoids the known Picamera2 max-res failure mode for dual cams.
  - On a dev mac (no picamera2, no CSI cams), this script will fail at `open_camera(0)` — that is correct; the bench is Pi-only.
- **VALIDATE**: On Pi 5 hardware:
  ```bash
  cd ~/IDP_PharmGuard/edge_pi && python3 scripts/bench_dual_cam.py --duration 15
  ```
  Expect both cams reporting `p95 < 100ms` and exit 0. On dev machine: `python3 -m py_compile scripts/bench_dual_cam.py`.

### Task 7: Update `edge_pi/scripts/test_intake_monitor.py`
- **ACTION**: Wrap the cv2.VideoCapture in `Cv2Source`.
- **IMPLEMENT**: Around current line 76 (`monitor = IntakeMonitor(camera=cap)`), replace with:
  ```python
  from vision.camera import Cv2Source  # add to imports near the top of the script
  ...
  monitor = IntakeMonitor(camera=Cv2Source(cap))
  ```
  Keep the existing `cap.release()` in the `finally` block — script owns the capture; `Cv2Source(cap)` borrows it (`_owns_source=False`-equivalent because the script never told monitor to own).
- **MIRROR**: existing import-then-instantiate pattern in the script.
- **IMPORTS**: `from vision.camera import Cv2Source`.
- **GOTCHA**: Don't double-close — `cv2.VideoCapture.release()` is idempotent in practice but ownership stays with the script.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile scripts/test_intake_monitor.py
  ```

### Task 8: End-to-end import + stub-mode smoke
- **ACTION**: Verify the whole edge_pi package imports cleanly with the refactor in stub mode.
- **IMPLEMENT**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi

  # 1. Module compile
  python3 -m py_compile vision/camera.py vision/pill_verifier.py vision/intake_monitor.py vision/__init__.py main.py scripts/bench_dual_cam.py scripts/test_intake_monitor.py

  # 2. Import surface
  python3 -c "from vision import CameraSource, Cv2Source, IntakeMonitor, Picamera2Source, PillVerifier, open_camera; print('vision package OK')"

  # 3. Stub-mode main import (cameras NOT opened)
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  python3 -c "import main; print('main OK')"

  # 4. Constants invariant check (no FSM drift)
  python3 -c "
  from vision.intake_monitor import _STEP_ORDER, REQUIRED_CONFIDENCE, POSE_HOLD_TIME, INSPECTION_HOLD_TIME, SMOOTHING_ALPHA
  assert _STEP_ORDER == ('STEP_1_HAND','STEP_2_TILT','STEP_3_LEVEL','STEP_4_MOUTH','STEP_5_TONGUE'), _STEP_ORDER
  assert REQUIRED_CONFIDENCE == 0.85
  assert POSE_HOLD_TIME == 1.5
  assert INSPECTION_HOLD_TIME == 3.0
  assert SMOOTHING_ALPHA == 0.3
  print('FSM constants intact')
  "
  ```
- **MIRROR**: stub-mode pattern from Phase 1's Task 7 validation.
- **IMPORTS**: stdlib only.
- **GOTCHA**:
  - On a dev mac without `picamera2`, `_HAS_PICAMERA2=False` is the expected import path. Stub-mode test (#3) does NOT call `open_camera` because `hardware_stubbed=True` skips it.
  - Constants check (#4) is the regression guard for accidental Step-4 logic damage.
- **VALIDATE**: All four blocks succeed; constants identical to today.

### Task 9: Pi-side dual-cam benchmark (Pi-hardware-only)
- **ACTION**: Operator runs the new bench on a real Pi 5 with two cameras attached.
- **IMPLEMENT**:
  ```bash
  make pi-sync HOST=pi@<host>
  ssh pi@<host>
  cd ~/IDP_PharmGuard/edge_pi
  python3 scripts/bench_dual_cam.py --duration 30
  ```
- **MIRROR**: BENCH_SCRIPT_PATTERN.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - Pi 5 must have **two CSI cables** plugged into cam0 + cam1 connectors and recognised by `libcamera`. Run `rpicam-hello --list-cameras` first to confirm.
  - If only one cam is detected, `open_camera(1)` will fail — bench correctly errors out.
  - Active cooling recommended (PRD risk register flagged thermal throttling under sustained dual-cam load).
- **VALIDATE**: Bench prints `Result: PASS` with both cams `p95 < 100 ms`. If `FAIL`, file findings into the PRD Phase 2 row notes — refactor still ships, but flag for hardware tuning before Phase 6 bench.

---

## Testing Strategy

Repo has no test framework. Validation = py_compile + import surface + constants regression check + the new bench script.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `vision/camera.py` compiles | `python3 -m py_compile vision/camera.py` | exit 0 | normal |
| `CameraSource` Protocol satisfied | `isinstance(Picamera2Source(0), CameraSource)` (Pi) / `isinstance(Cv2Source(0), CameraSource)` (dev) | True | normal |
| Stub-mode main import | `PHARMGUARD_STUB=1 ... python -c "import main"` | no exception | yes (no-cam path) |
| FSM constants invariant | constants assert block | all 5 asserts pass | yes (regression) |
| `IntakeMonitor` no longer crashes when injected with raw `Picamera2` | type narrowed — callers must inject a CameraSource now | static check (mypy-like via runtime annotation) | yes (bug fix) |
| `test_intake_monitor.py` still compiles | `python3 -m py_compile scripts/test_intake_monitor.py` | exit 0 | normal |
| Dual-cam bench (Pi 5) | `bench_dual_cam.py --duration 30` | `Result: PASS`, both cams p95 < 100 ms | yes (success signal) |
| Single-cam fallback (Pi with one cam unplugged) | `open_camera(1)` raises | RuntimeError surfaced | yes (no silent stub) |
| Cv2Source idempotent close | `c = Cv2Source(0); c.close(); c.close()` | second close logs but doesn't raise | yes |

### Edge Cases Checklist
- [x] Empty input — `read_frame()` returns `None` on capture miss; existing loops handle.
- [x] Maximum size input — defaulting to 640×480 dodges the known max-res Pi 5 dual-cam bug.
- [x] Invalid types — `Protocol` + `runtime_checkable` allows isinstance check; injection of wrong type fails fast at first `read_frame()` call.
- [x] Concurrent access — calls are sequential within main.py's cycle; no concurrency introduced.
- [x] Network failure — N/A for this phase.
- [x] Permission denied — `Picamera2(N)` raises if libcamera lacks access; bubbled via `open_camera`.
- [x] Stub mode — main.py never opens cams when `hardware_stubbed=True`; preserved.

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/edge_pi
python3 -m py_compile vision/camera.py vision/pill_verifier.py vision/intake_monitor.py vision/__init__.py main.py scripts/bench_dual_cam.py scripts/test_intake_monitor.py
```
EXPECT: zero output, exit 0.

### Import Surface
```bash
python3 -c "from vision import CameraSource, Cv2Source, IntakeMonitor, Picamera2Source, PillVerifier, open_camera; print('OK')"
```
EXPECT: `OK`.

### Stub-Mode Main Import
```bash
PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
python3 -c "import main; print('main OK')"
```
EXPECT: `main OK`, no traceback.

### FSM Constants Regression Guard
See Task 8 step 4. EXPECT: `FSM constants intact`.

### Frontend Build
N/A — no frontend impact.

### Pi Hardware Bench (operator step)
```bash
make pi-sync HOST=pi@<host>
ssh pi@<host> 'cd ~/IDP_PharmGuard/edge_pi && python3 scripts/bench_dual_cam.py --duration 30'
```
EXPECT: `Result: PASS`, both cams p95 < 100 ms.

### Manual Validation Checklist
- [ ] `vision/camera.py` exists with `CameraSource` Protocol, `Picamera2Source`, `Cv2Source`, `open_camera`.
- [ ] `PillVerifier` constructor accepts `camera: CameraSource | None`.
- [ ] `IntakeMonitor` constructor type-narrowed to `CameraSource | None`.
- [ ] Both modules' `_using_picamera` boolean removed.
- [ ] `main.py` opens 2 cams via `open_camera(0)` + `open_camera(1)` only when not stub.
- [ ] `bench_dual_cam.py` script created.
- [ ] `test_intake_monitor.py` updated to wrap `cv2.VideoCapture` in `Cv2Source`.
- [ ] `vision/__init__.py` re-exports the new public surface.
- [ ] FSM constants identical to today (regression guard).
- [ ] Pi hardware bench reports `Result: PASS`.
- [ ] PRD Phase 2 row flipped to `complete` with plan + (optional) bench-result note.

---

## Acceptance Criteria
- [ ] All 9 tasks completed.
- [ ] `py_compile` clean across all changed files.
- [ ] Import surface intact (`from vision import ...`).
- [ ] Stub-mode main import passes without opening cameras.
- [ ] FSM constants regression guard passes.
- [ ] **Step-4 inverted-logic invariant preserved** — `_pill_in_mouth` resets `timer_start` instead of advancing.
- [ ] Pi hardware bench `bench_dual_cam.py --duration 30` returns `PASS` (operator-attested).
- [ ] PRD Phase 2 row updated.

## Completion Checklist
- [ ] Code follows discovered patterns (NAMING, OWNERSHIP, STUB_FAIL_LOUD, LOGGING, BENCH_SCRIPT, MAIN_LOOP_INSTANTIATION).
- [ ] No silent stub fallbacks — if cameras can't open and `PHARMGUARD_STUB=0`, system refuses to start.
- [ ] No FSM logic drift — only camera plumbing changed.
- [ ] No new dependencies in `requirements.txt`.
- [ ] `_owns_source` ownership rule prevents double-close.
- [ ] PRD updated with this plan path + report path on completion.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pi 5 thermal throttling under simultaneous dual-cam + YOLO + MediaPipe | M | M | Active cooling case; bench at 640×480; if throttling, drop to 480×360 or interleave |
| `Picamera2(0)` + `Picamera2(1)` fails to start at picked resolution | M | L | Documented (issue #1035); default to 640×480 — well under known failure threshold |
| Existing scripts break after refactor | L | L | Only `test_intake_monitor.py` touches the changed surface; updated in Task 7. `test_pill_detector.py` doesn't use `PillVerifier`. |
| `_using_picamera` removal hides a subtle behavior I didn't see | L | M | Constants regression guard + Pi-side bench; if FSM behaves differently, revert and inspect |
| Dev-mac validation grabs the laptop webcam unexpectedly | L | L | Stub-mode validation (`PHARMGUARD_STUB=1`) skips `open_camera` entirely. Task 8 step 3 confirms. |
| Future-`mypy` typing fails on `Protocol` re-export | L | L | `runtime_checkable` declared; explicit re-exports in `__init__.py`. |
| Operator only has one CSI cam and runs bench → fails | M | L | Bench script's `open_camera(1)` raises clearly; bench is Pi-hardware-only and gated behind operator action (Task 9). |

## Notes
- The plan **fixes a latent bug** in `IntakeMonitor` (`_using_picamera` stays `False` when a `Picamera2` is injected, which would crash on the next `read()`). After this plan, callers must inject a `CameraSource`, eliminating the ambiguity.
- The plan is **strictly camera-only**. The 5-step swallow FSM (`_raw_confidence`, the `_pill_in_mouth` reset branch in Step 4, all `_conf_*` helpers, all HSV ranges, `MODEL_POINTS`, `_STEP_ORDER`) is byte-identical before and after.
- `requirements.txt` is unchanged. The refactor reuses `picamera2`, `opencv-python-headless`, `numpy` already pinned.
- After this plan ships, Phase 3 (Face ID end-to-end) can leverage `cam_b`'s `read_frame()` for the liveness check, mirroring this same `CameraSource` injection.
- Update `pharmguard.prd.md` Phase 2 row to:
  ```
  | 2 | Dual-camera refactor | ... | in-progress | with 1 | - | .claude/PRPs/plans/dual-camera-refactor.plan.md |
  ```
  Then to `complete` once Pi hardware bench passes.

Sources:
- [How To Use Dual Cameras on the Raspberry Pi 5 — Tom's Hardware](https://www.tomshardware.com/raspberry-pi/how-to-use-dual-cameras-on-the-raspberry-pi-5)
- [Pi5 with two cameras, max resolution start error — picamera2#1035](https://github.com/raspberrypi/picamera2/issues/1035)
- [Multi camera simultaneous video streaming — Raspberry Pi Forums](https://forums.raspberrypi.com/viewtopic.php?t=376767)
- [Picamera2 Library Manual](https://datasheets.raspberrypi.com/camera/picamera2-manual.pdf)
