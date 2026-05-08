"""Patient swallow verification — ported from ml/swallow/main5.py.

Runs a 5-step pose state machine over MediaPipe FaceMesh + Hands landmarks,
accumulating temporally-smoothed confidence per step. Each step must be held
above REQUIRED_CONFIDENCE for its target duration before the FSM advances.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

import cv2
import mediapipe as mp
import numpy as np

from vision.camera import CameraSource, open_camera

log = logging.getLogger(__name__)

# ---- Thresholds ported from main5.py ----
REQUIRED_CONFIDENCE = 0.85
POSE_HOLD_TIME = 1.5
INSPECTION_HOLD_TIME = 3.0
SMOOTHING_ALPHA = 0.3

PILL_HSV_LOWER = np.array([100, 150, 50])
PILL_HSV_UPPER = np.array([140, 255, 255])
TONGUE_HSV_LOWER = np.array([160, 50, 50])
TONGUE_HSV_UPPER = np.array([180, 255, 255])

# Anthropometric model points for solvePnP head pose
MODEL_POINTS = np.array(
    [
        (0.0, 0.0, 0.0),          # Nose tip      (1)
        (0.0, -330.0, -65.0),     # Chin          (152)
        (-225.0, 170.0, -135.0),  # Left eye      (33)
        (225.0, 170.0, -135.0),   # Right eye     (263)
        (-150.0, -150.0, -125.0), # Left mouth    (61)
        (150.0, -150.0, -125.0),  # Right mouth   (291)
    ],
    dtype="double",
)

_STEP_ORDER = (
    "STEP_1_HAND",
    "STEP_2_TILT",
    "STEP_3_LEVEL",
    "STEP_4_MOUTH",
    "STEP_5_TONGUE",
)


def _sigmoid(x: float, x0: float, k: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-k * (x - x0)))
    except OverflowError:
        return 0.0 if x < x0 else 1.0


def _dist(p1: Any, p2: Any, w: int, h: int) -> float:
    return math.hypot((p2.x - p1.x) * w, (p2.y - p1.y) * h)


class IntakeMonitor:
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

    # ---- camera ----
    def _ensure_camera(self) -> None:
        if self._source is not None:
            return
        self._source = open_camera(self.camera_index)

    def _read_frame(self) -> np.ndarray | None:
        return self._source.read_frame() if self._source is not None else None

    # ---- pose & confidence calculators (ported from main5.py) ----
    def _head_pitch(self, lms: list[Any], w: int, h: int) -> float:
        image_points = np.array(
            [
                (lms[1].x * w, lms[1].y * h),
                (lms[152].x * w, lms[152].y * h),
                (lms[33].x * w, lms[33].y * h),
                (lms[263].x * w, lms[263].y * h),
                (lms[61].x * w, lms[61].y * h),
                (lms[291].x * w, lms[291].y * h),
            ],
            dtype="double",
        )
        focal = float(w)
        cam_matrix = np.array(
            [[focal, 0, w / 2], [0, focal, h / 2], [0, 0, 1]], dtype="double"
        )
        ok, rvec, tvec = cv2.solvePnP(
            MODEL_POINTS,
            image_points,
            cam_matrix,
            np.zeros((4, 1)),
            flags=cv2.SOLVEPNP_ITERATIVE,
        )
        if not ok:
            return 0.0
        rmat, _ = cv2.Rodrigues(rvec)
        _, _, _, _, _, _, euler = cv2.decomposeProjectionMatrix(np.hstack((rmat, tvec)))
        return float(euler.flatten()[0])

    def _conf_hand_to_mouth(
        self, lms: list[Any], hand_lms: list[Any] | None, w: int, h: int
    ) -> float:
        if not hand_lms:
            return 0.0
        upper_lip = lms[13]
        best = 0.0
        for hand in hand_lms:
            d = _dist(upper_lip, hand.landmark[8], w, h)
            best = max(best, _sigmoid(max(0.0, 400.0 - d), 250, 0.05))
        return best

    def _conf_tilt(self, lms: list[Any], w: int, h: int) -> float:
        return _sigmoid(self._head_pitch(lms, w, h), 25, 0.4)

    def _conf_level(self, lms: list[Any], w: int, h: int) -> float:
        return _sigmoid(-self._head_pitch(lms, w, h), -10, 0.4)

    def _conf_mouth_open(self, lms: list[Any], w: int, h: int) -> float:
        hz = _dist(lms[61], lms[291], w, h)
        if hz == 0:
            return 0.0
        vt = _dist(lms[13], lms[14], w, h)
        return _sigmoid(vt / hz, 0.35, 15)

    def _mouth_roi(self, lms: list[Any], w: int, h: int) -> tuple[int, int, int, int]:
        xs = [int(lms[i].x * w) for i in (61, 291, 0, 17)]
        ys = [int(lms[i].y * h) for i in (61, 291, 0, 17)]
        b = 15
        return (
            max(0, min(xs) - b),
            max(0, min(ys) - b),
            min(w, max(xs) + b),
            min(h, max(ys) + b),
        )

    def _pill_in_mouth(self, frame: np.ndarray, lms: list[Any], w: int, h: int) -> bool:
        x0, y0, x1, y1 = self._mouth_roi(lms, w, h)
        roi = frame[y0:y1, x0:x1]
        if roi.size == 0:
            return False
        mask = cv2.inRange(
            cv2.cvtColor(roi, cv2.COLOR_BGR2HSV), PILL_HSV_LOWER, PILL_HSV_UPPER
        )
        return cv2.countNonZero(mask) > 15

    def _tongue_lifted(self, frame: np.ndarray, lms: list[Any], w: int, h: int) -> bool:
        y_mid = (int(lms[13].y * h) + int(lms[14].y * h)) // 2
        x0, y0, x1, y1 = self._mouth_roi(lms, w, h)
        roi = frame[y0:y1, x0:x1]
        if roi.size == 0:
            return False
        mask = cv2.inRange(
            cv2.cvtColor(roi, cv2.COLOR_BGR2HSV), TONGUE_HSV_LOWER, TONGUE_HSV_UPPER
        )
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return False
        c = max(contours, key=cv2.contourArea)
        m = cv2.moments(c)
        if m["m00"] <= 0:
            return False
        cy = int(m["m01"] / m["m00"]) + y0
        return cy < y_mid

    # ---- main FSM ----
    def _raw_confidence(
        self,
        step: str,
        frame: np.ndarray,
        lms: list[Any],
        hand_lms: list[Any] | None,
        w: int,
        h: int,
    ) -> float:
        if step == "STEP_1_HAND":
            return self._conf_hand_to_mouth(lms, hand_lms, w, h)
        if step == "STEP_2_TILT":
            return self._conf_tilt(lms, w, h)
        if step == "STEP_3_LEVEL":
            return self._conf_level(lms, w, h)
        if step == "STEP_4_MOUTH":
            return self._conf_mouth_open(lms, w, h)
        if step == "STEP_5_TONGUE":
            mouth = self._conf_mouth_open(lms, w, h)
            if mouth >= REQUIRED_CONFIDENCE and not self._tongue_lifted(frame, lms, w, h):
                return 0.0
            return mouth
        return 0.0

    def watch_for_swallow(self, timeout_s: float = 60.0) -> bool:
        """Run the 5-step swallow FSM. Returns True on completion, False on timeout."""
        try:
            self._ensure_camera()
        except Exception:
            log.exception("Intake camera initialization failed")
            return False

        deadline = time.time() + timeout_s
        step_idx = 0
        smoothed = 0.0
        timer_start = 0.0

        while time.time() < deadline:
            frame = self._read_frame()
            if frame is None:
                time.sleep(0.02)
                continue
            frame = cv2.flip(frame, 1)
            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            face_res = self._face_mesh.process(rgb)
            hand_res = self._hands.process(rgb)

            if not face_res.multi_face_landmarks:
                timer_start = 0.0
                continue

            lms = face_res.multi_face_landmarks[0].landmark
            hand_lms = hand_res.multi_hand_landmarks
            step = _STEP_ORDER[step_idx]

            raw = self._raw_confidence(step, frame, lms, hand_lms, w, h)
            smoothed = (1 - SMOOTHING_ALPHA) * smoothed + SMOOTHING_ALPHA * raw

            target = INSPECTION_HOLD_TIME if step == "STEP_4_MOUTH" else POSE_HOLD_TIME

            if smoothed >= REQUIRED_CONFIDENCE:
                # STEP 4 inspection: mouth open, but pill must NOT be visible.
                if step == "STEP_4_MOUTH" and self._pill_in_mouth(frame, lms, w, h):
                    timer_start = time.time()  # reset; pill still in mouth
                    continue
                if timer_start == 0.0:
                    timer_start = time.time()
                if time.time() - timer_start >= target:
                    log.info("Swallow FSM step complete: %s", step)
                    timer_start = 0.0
                    smoothed = 0.0
                    step_idx += 1
                    if step_idx >= len(_STEP_ORDER):
                        log.info("Swallow verification SUCCESS")
                        return True
            else:
                timer_start = 0.0

        log.warning("Swallow verification timed out after %.1fs", timeout_s)
        return False

    def close(self) -> None:
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
        self._face_mesh.close()
        self._hands.close()
