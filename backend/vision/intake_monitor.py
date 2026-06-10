"""Patient intake verification — 4-step game FSM over MediaPipe FaceMesh + Hands.

Replaces the old 5-step HSV-color-based monster (HAND -> TILT -> LEVEL ->
MOUTH -> TONGUE) which depended on the pill being a specific blue colour.
This version uses only face/hand landmark geometry, so it works for any
pill colour and is patient-friendly.

Game flow:
    1. READY    — bring hand close to your mouth.    hold 0.8 s
    2. INSERT   — open your mouth, put the pill in.  hold 0.6 s
    3. SWALLOW  — close your mouth and swallow.      hold 1.2 s
    4. DONE     — open your mouth (empty).           hold 0.8 s

Each step's confidence is EMA-smoothed; once it stays above
``REQUIRED_CONFIDENCE`` for the step's hold duration, the FSM advances.
The state dict is updated every frame and read by /api/device/intake
for the dashboard's live "game panel" UI.

Public API:
    IntakeMonitor()                       -- constructor, lazy-loads mediapipe
    .process_frame(frame)   -> dict       -- one tick; returns state snapshot
    .get_state()            -> dict       -- thread-safe state snapshot
    .reset()                              -- back to step 1, idle status
    .watch_for_swallow(timeout_s) -> bool -- cycle's blocking wrapper
    .close()                              -- release mediapipe + camera
    ._face_mesh / ._hands                 -- exposed for /stream overlay

Thread-safety: state mutations + reads are guarded by self._lock. The
cycle runs watch_for_swallow on an asyncio.to_thread executor; the
/api/device/intake handler reads state from the FastAPI loop. Both
hold the lock while touching `_state`.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

import cv2
import numpy as np

from vision.camera import CameraSource, open_camera

# mediapipe is lazy-loaded inside IntakeMonitor.__init__ — at module
# import time it transitively pulls matplotlib (~10s on Pi 5).

log = logging.getLogger(__name__)

# ---- Tunables ----
REQUIRED_CONFIDENCE = 0.70   # smoothed confidence to trigger the hold timer
SMOOTHING_ALPHA = 0.55       # EMA factor (higher = more responsive, less stable)
HAND_NEAR_MOUTH_PX = 200.0   # absolute distance threshold (640x480 frame)
MOUTH_OPEN_RATIO = 0.30      # mouth-open if vertical/horizontal lip ratio > this
MOUTH_CLOSED_RATIO = 0.10    # mouth-closed if ratio <= this


@dataclass
class StepDef:
    name: str            # short ID used in state dict
    label: str           # human-readable label for UI
    instruction: str     # patient-facing prompt
    hold_s: float        # how long confidence must stay above threshold


# Step 1: READY — hand close to mouth
# Step 2: INSERT — mouth open while putting the pill in
# Step 3: SWALLOW — mouth closed (after the patient swallows)
# Step 4: DONE — mouth open + empty
_STEPS: tuple[StepDef, ...] = (
    StepDef("READY",   "Take the pill",      "Bring your hand close to your mouth",  0.8),
    StepDef("INSERT",  "Put the pill in",    "Open your mouth and place the pill",   0.6),
    StepDef("SWALLOW", "Swallow",            "Close your mouth and swallow",         1.2),
    StepDef("DONE",    "Show empty mouth",   "Open your mouth (empty) to confirm",   0.8),
)


def _initial_state() -> dict:
    return {
        "running": False,
        "step_index": 0,
        "total_steps": len(_STEPS),
        "step_name": _STEPS[0].name,
        "step_label": _STEPS[0].label,
        "instruction": _STEPS[0].instruction,
        "confidence": 0.0,           # EMA of current step's verifier
        "hold_progress": 0.0,        # 0..1 — fraction of hold_s accumulated
        "face_visible": False,
        "hands_count": 0,
        "history": [],               # completed steps with timestamps
        "result": None,              # "passed" | "timeout" | "missing_labels" | None
        "started_at": None,          # epoch seconds
        "ended_at": None,
        "updated_at": time.time(),
        # ── Layer-2 (DetectLabels) state ───────────────────────────────
        "labels_seen": [],           # ordered unique label names as detected
        "labels_seen_at": {},        # {label_lower: epoch_seconds} — recency
        "labels_required": [],       # snapshot of required set for the UI
        "labels_satisfied": False,   # any seen label in the required set?
        "mediapipe_complete": False, # all 3 FSM steps done (regardless of labels)
        "labels_inflight": False,    # a DetectLabels call is currently in-flight
        "labels_last_call_at": None, # epoch seconds of the last DetectLabels return
    }


def _dist_norm(p1: Any, p2: Any, w: int, h: int) -> float:
    return math.hypot((p2.x - p1.x) * w, (p2.y - p1.y) * h)


def _mouth_open_ratio(lms: list[Any], w: int, h: int) -> float:
    """Vertical lip gap / mouth width. ~0 closed, ~0.5+ wide open."""
    horizontal = _dist_norm(lms[61], lms[291], w, h)
    if horizontal == 0:
        return 0.0
    vertical = _dist_norm(lms[13], lms[14], w, h)
    return vertical / horizontal


def _hand_to_mouth(lms: list[Any], hand_lms: list[Any] | None, w: int, h: int) -> float:
    """Smallest pixel distance from any fingertip-like point to the upper lip."""
    if not hand_lms:
        return float("inf")
    upper_lip = lms[13]
    best = float("inf")
    for hand in hand_lms:
        for idx in (4, 8):  # thumb tip + index tip
            d = _dist_norm(upper_lip, hand.landmark[idx], w, h)
            if d < best:
                best = d
    return best


# ---- Per-step verifiers (return 0..1 confidence) ----

def _step_ready(open_ratio: float, hand_d: float) -> float:
    """Confidence the patient is bringing pill+hand to mouth."""
    if hand_d == float("inf"):
        return 0.0
    proximity = max(0.0, 1.0 - hand_d / HAND_NEAR_MOUTH_PX)
    return float(proximity)


def _step_insert(open_ratio: float, hand_d: float) -> float:
    """Confidence the patient has opened mouth to put the pill in."""
    if open_ratio >= MOUTH_OPEN_RATIO:
        return 1.0
    if open_ratio <= MOUTH_CLOSED_RATIO:
        return 0.0
    return float(
        (open_ratio - MOUTH_CLOSED_RATIO)
            / (MOUTH_OPEN_RATIO - MOUTH_CLOSED_RATIO)
    )


def _step_swallow(open_ratio: float, hand_d: float) -> float:
    """Confidence the patient has closed mouth (ready to swallow / swallowing)."""
    if open_ratio <= MOUTH_CLOSED_RATIO:
        return 1.0
    if open_ratio >= MOUTH_OPEN_RATIO:
        return 0.0
    return float(
        1.0 - (open_ratio - MOUTH_CLOSED_RATIO)
            / (MOUTH_OPEN_RATIO - MOUTH_CLOSED_RATIO)
    )


def _step_done(open_ratio: float, hand_d: float) -> float:
    """Confidence the patient has opened mouth (showing it's empty)."""
    if open_ratio >= MOUTH_OPEN_RATIO:
        return 1.0
    if open_ratio <= MOUTH_CLOSED_RATIO:
        return 0.0
    return float(
        (open_ratio - MOUTH_CLOSED_RATIO)
            / (MOUTH_OPEN_RATIO - MOUTH_CLOSED_RATIO)
    )


_VERIFIERS: tuple[Callable[[float, float], float], ...] = (
    _step_ready, _step_insert, _step_swallow, _step_done,
)


class IntakeMonitor:
    def __init__(self, camera_index: int = 1, camera: CameraSource | None = None) -> None:
        self.camera_index = camera_index
        self._source: CameraSource | None = camera
        self._owns_source = camera is None

        # Lazy import — pulls in matplotlib via mediapipe.solutions on the
        # Pi (~10s). Only happens when the cycle actually constructs the
        # monitor (real-hardware path), never under BACKEND_HEADLESS=1.
        import mediapipe as mp

        self._face_mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
        )
        self._hands = mp.solutions.hands.Hands(
            max_num_hands=2, min_detection_confidence=0.5
        )

        self._lock = threading.Lock()
        self._state: dict = _initial_state()
        self._smoothed_conf: float = 0.0
        self._timer_started_at: float = 0.0

        # Layer-2 DetectLabels sampler — submits frames every
        # ``settings.intake_label_poll_interval_s`` to a thread pool while
        # ``watch_for_swallow`` is running. Workers are fire-and-forget;
        # results land in ``_state`` under the lock.
        self._label_pool = ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="intake-labels"
        )
        self._last_label_submit: float = 0.0

    # ---- camera ----
    def _ensure_camera(self) -> None:
        if self._source is not None:
            return
        # MediaPipe consumes RGB. Opening the source RGB-native skips the
        # BGR↔RGB round-trip on every frame (Picamera2Source returns sensor
        # RGB directly; RpicamSource/Cv2Source convert once on read).
        self._source = open_camera(self.camera_index, output_format="rgb")

    def _read_frame(self) -> np.ndarray | None:
        return self._source.read_frame() if self._source is not None else None

    # ---- state ----
    def get_state(self) -> dict:
        with self._lock:
            return dict(self._state)  # shallow copy of top-level keys

    def reset(self) -> None:
        """Reset FSM to step 1, idle status. Called at cycle start."""
        with self._lock:
            self._state = _initial_state()
            self._smoothed_conf = 0.0
            self._timer_started_at = 0.0

    # ---- frame processing ----
    def process_frame(self, frame: np.ndarray) -> dict:
        """One FSM tick. Updates state, returns snapshot.

        Idempotent on terminal state (passed/timeout) — just returns last state.
        """
        with self._lock:
            if self._state["result"] is not None:
                return dict(self._state)
            self._state["updated_at"] = time.time()

        h, w = frame.shape[:2]
        # Source emits RGB when opened with output_format='rgb' (cycle path
        # + standalone _ensure_camera). Fall back to convert if a BGR-native
        # source was injected for tests.
        if getattr(self._source, "output_format", "rgb") == "rgb":
            rgb = frame
        else:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face_res = self._face_mesh.process(rgb)
        hand_res = self._hands.process(rgb)

        face_visible = bool(face_res.multi_face_landmarks)
        hand_lms = hand_res.multi_hand_landmarks if hand_res.multi_hand_landmarks else None
        hands_count = len(hand_lms) if hand_lms else 0

        if not face_visible:
            with self._lock:
                self._state["face_visible"] = False
                self._state["hands_count"] = hands_count
                self._smoothed_conf *= (1.0 - SMOOTHING_ALPHA)  # decay
                self._state["confidence"] = self._smoothed_conf
                self._timer_started_at = 0.0
                self._state["hold_progress"] = 0.0
                return dict(self._state)

        lms = face_res.multi_face_landmarks[0].landmark
        open_ratio = _mouth_open_ratio(lms, w, h)
        hand_d = _hand_to_mouth(lms, hand_lms, w, h)

        with self._lock:
            step_idx = self._state["step_index"]
            verifier = _VERIFIERS[step_idx]
            step_def = _STEPS[step_idx]
            raw = verifier(open_ratio, hand_d)
            self._smoothed_conf = (
                (1.0 - SMOOTHING_ALPHA) * self._smoothed_conf
                + SMOOTHING_ALPHA * raw
            )

            self._state["face_visible"] = True
            self._state["hands_count"] = hands_count
            self._state["confidence"] = self._smoothed_conf

            if self._smoothed_conf >= REQUIRED_CONFIDENCE:
                if self._timer_started_at == 0.0:
                    self._timer_started_at = time.time()
                elapsed = time.time() - self._timer_started_at
                self._state["hold_progress"] = min(1.0, elapsed / step_def.hold_s)
                if elapsed >= step_def.hold_s:
                    # Step complete — advance.
                    self._state["history"].append({
                        "step_index": step_idx,
                        "step_name": step_def.name,
                        "passed_at": time.time(),
                    })
                    log.info("Intake game: step %d (%s) PASSED", step_idx + 1, step_def.name)
                    next_idx = step_idx + 1
                    if next_idx >= len(_STEPS):
                        # MediaPipe FSM complete — Layer-2 gate decides
                        # whether to flip ``result`` to "passed". When
                        # the label layer is disabled OR labels already
                        # satisfied, advance immediately; otherwise wait
                        # for ``_run_label_call`` (or watch_for_swallow's
                        # timeout) to set the terminal state.
                        from config import settings as _s
                        self._state["mediapipe_complete"] = True
                        self._state["ended_at"] = time.time()
                        self._state["hold_progress"] = 1.0
                        if (not _s.intake_label_enabled) or self._state["labels_satisfied"]:
                            self._state["result"] = "passed"
                            self._state["running"] = False
                            log.info("Intake game: COMPLETE (mediapipe%s)",
                                     "" if not _s.intake_label_enabled else " + labels")
                        else:
                            log.info(
                                "Intake: MediaPipe complete — waiting for "
                                "Layer-2 labels (seen=%s)",
                                list(self._state["labels_seen_at"].keys()),
                            )
                    else:
                        next_def = _STEPS[next_idx]
                        self._state["step_index"] = next_idx
                        self._state["step_name"] = next_def.name
                        self._state["step_label"] = next_def.label
                        self._state["instruction"] = next_def.instruction
                        self._state["hold_progress"] = 0.0
                        self._smoothed_conf = 0.0
                        self._timer_started_at = 0.0
            else:
                self._timer_started_at = 0.0
                self._state["hold_progress"] = 0.0

            return dict(self._state)

    # ---- Layer-2 (DetectLabels) sampler ----
    def _maybe_submit_label_call(self, frame: np.ndarray) -> None:
        """Throttled fire-and-forget DetectLabels submission.

        Called from ``watch_for_swallow``'s tick loop. Submits at most one
        call per ``settings.intake_label_poll_interval_s`` and only when
        the label layer is enabled. The frame is copied before submit
        because some camera backends mutate the returned buffer in place.
        """
        from config import settings
        if not settings.intake_label_enabled:
            return
        now = time.time()
        if now - self._last_label_submit < settings.intake_label_poll_interval_s:
            return
        self._last_label_submit = now
        frame_copy = frame.copy()
        try:
            self._label_pool.submit(self._run_label_call, frame_copy)
        except RuntimeError:
            # Pool already shut down (close called mid-cycle). Skip silently.
            return
        with self._lock:
            # Pulse for the HUD on cam 1 — flipped back to False at the
            # end of _run_label_call. Multiple in-flight calls collapse
            # to a single "inflight" pulse; that's fine for the visual.
            self._state["labels_inflight"] = True

    def _run_label_call(self, frame: np.ndarray) -> None:
        """Worker body: encode JPEG, call DetectLabels, fold results into state.

        Soft-fails on AWS error (missing creds, throttling) — labels just
        never get recorded, watch_for_swallow eventually marks the run
        ``missing_labels`` if MediaPipe completed without any match.
        """
        from config import settings
        from services.label_detector import detect_labels, encode_frame_jpeg

        try:
            try:
                jpeg = encode_frame_jpeg(frame)
            except Exception:
                log.exception("label encode failed")
                return
            resp = detect_labels(
                jpeg, min_confidence=settings.intake_label_min_confidence
            )
            if resp["error"]:
                return

            required = settings.intake_label_required_set  # lowercased set
            now = time.time()
            with self._lock:
                seen_at: dict = self._state["labels_seen_at"]
                seen_list: list = self._state["labels_seen"]
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
                # Hard gate: if MediaPipe FSM already completed and labels
                # have just satisfied → flip the run to "passed".
                if (
                    self._state["mediapipe_complete"]
                    and self._state["labels_satisfied"]
                    and self._state["result"] is None
                ):
                    self._state["result"] = "passed"
                    self._state["running"] = False
                    log.info(
                        "Intake: PASSED (mediapipe + labels=%s)",
                        sorted(matched),
                    )
        finally:
            # Always release the inflight pulse, even on error/early return —
            # the HUD relies on this to stop blinking.
            with self._lock:
                self._state["labels_inflight"] = False
                self._state["labels_last_call_at"] = time.time()

    # ---- cycle integration ----
    def watch_for_swallow(self, timeout_s: float = 60.0) -> bool:
        """Run the FSM until completion or timeout. Returns True on success.

        Layer-2 hard gate: success requires BOTH MediaPipe FSM completion
        AND at least one label from ``settings.intake_label_required_set``
        observed during the window. Terminal states:
            "passed"          — both layers OK
            "missing_labels"  — MediaPipe complete but no required label seen
            "timeout"         — MediaPipe never completed
        """
        from config import settings

        try:
            self._ensure_camera()
        except Exception:
            log.exception("Intake camera initialization failed")
            return False

        # Reset state so /api/device/intake reflects this run from step 1.
        self.reset()
        required = sorted(settings.intake_label_required_set)
        with self._lock:
            self._state["running"] = True
            self._state["started_at"] = time.time()
            # Expose required set to the UI even when label layer disabled
            # (empty list signals "no Layer-2 gate" to the dashboard).
            self._state["labels_required"] = required if settings.intake_label_enabled else []

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            frame = self._read_frame()
            if frame is None:
                time.sleep(0.02)
                continue
            frame = cv2.flip(frame, 1)  # mirror for selfie-cam ergonomics
            self.process_frame(frame)
            self._maybe_submit_label_call(frame)
            with self._lock:
                if self._state["result"] == "passed":
                    return True
            time.sleep(0.01)  # tiny yield; MediaPipe inference is the real cap

        # Timeout. Pick the most informative terminal state.
        with self._lock:
            if self._state["mediapipe_complete"] and not self._state["labels_satisfied"]:
                self._state["result"] = "missing_labels"
            else:
                self._state["result"] = "timeout"
            self._state["ended_at"] = time.time()
            self._state["running"] = False
            terminal = self._state["result"]
            last_step = self._state["step_index"]
            last_name = self._state["step_name"]
        log.warning(
            "Intake ended (%s) after %.1fs at step %d (%s) labels_seen=%s",
            terminal, timeout_s, last_step + 1, last_name,
            list(self._state["labels_seen_at"].keys()),
        )
        return False

    def close(self) -> None:
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
        try:
            self._face_mesh.close()
        except Exception:
            pass
        try:
            self._hands.close()
        except Exception:
            pass
        try:
            # Drop in-flight label calls — their results would land in a
            # dead state dict anyway.
            self._label_pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
