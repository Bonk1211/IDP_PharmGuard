"""Liveness detection: confirm a real person via MediaPipe FaceMesh blink (EAR).

EAR (Eye Aspect Ratio) drops below a closed threshold and recovers above an
open threshold within a small window — that's a blink, and a printed photo
cannot do it. Returns the face crop bytes captured at the moment of blink
recovery, or None on timeout.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

import cv2
import mediapipe as mp

from vision.camera import CameraSource, open_camera

log = logging.getLogger(__name__)

# MediaPipe FaceMesh 6-point indices for EAR per eye (refine_landmarks=True).
RIGHT_EYE_EAR = (33, 160, 158, 133, 153, 144)
LEFT_EYE_EAR = (362, 385, 387, 263, 373, 380)

EAR_CLOSED = 0.20
EAR_OPEN = 0.25
CROP_PADDING = 30


def _dist(p1: Any, p2: Any, w: int, h: int) -> float:
    return math.hypot((p2.x - p1.x) * w, (p2.y - p1.y) * h)


def _ear(lms: list[Any], idx: tuple[int, int, int, int, int, int], w: int, h: int) -> float:
    p1, p2, p3, p4, p5, p6 = (lms[i] for i in idx)
    v = _dist(p2, p6, w, h) + _dist(p3, p5, w, h)
    hz = 2.0 * _dist(p1, p4, w, h)
    return (v / hz) if hz > 0 else 0.0


def _face_bbox(lms: list[Any], w: int, h: int) -> tuple[int, int, int, int]:
    xs = [int(p.x * w) for p in lms]
    ys = [int(p.y * h) for p in lms]
    return (
        max(0, min(xs) - CROP_PADDING),
        max(0, min(ys) - CROP_PADDING),
        min(w, max(xs) + CROP_PADDING),
        min(h, max(ys) + CROP_PADDING),
    )


class LivenessDetector:
    """Run MediaPipe on cam_b until a confirmed blink, then return JPEG bytes."""

    def __init__(self, camera_index: int = 1, camera: CameraSource | None = None) -> None:
        self.camera_index = camera_index
        self._source: CameraSource | None = camera
        self._owns_source = camera is None
        self._face_mesh = mp.solutions.face_mesh.FaceMesh(
            max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
        )

    def _ensure_camera(self) -> None:
        if self._source is not None:
            return
        self._source = open_camera(self.camera_index)

    def capture_live_face(self, timeout_s: float = 15.0) -> bytes | None:
        """Block until a blink is observed; return JPEG-encoded face crop bytes.

        Returns None if no blink confirmed within timeout_s.
        """
        try:
            self._ensure_camera()
        except Exception:
            log.exception("Liveness camera initialization failed")
            return None

        deadline = time.time() + timeout_s
        eyes_were_closed = False

        while time.time() < deadline:
            frame = self._source.read_frame() if self._source else None
            if frame is None:
                time.sleep(0.02)
                continue
            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            face_res = self._face_mesh.process(rgb)
            if not face_res.multi_face_landmarks:
                eyes_were_closed = False
                continue
            lms = face_res.multi_face_landmarks[0].landmark
            ear = (_ear(lms, RIGHT_EYE_EAR, w, h) + _ear(lms, LEFT_EYE_EAR, w, h)) / 2.0

            if ear < EAR_CLOSED:
                eyes_were_closed = True
            elif eyes_were_closed and ear > EAR_OPEN:
                log.info("Blink confirmed (EAR transition)")
                x0, y0, x1, y1 = _face_bbox(lms, w, h)
                crop = frame[y0:y1, x0:x1]
                if crop.size == 0:
                    return None
                ok, buf = cv2.imencode(".jpg", crop)
                return buf.tobytes() if ok else None

        log.warning("Liveness timed out after %.1fs", timeout_s)
        return None

    def close(self) -> None:
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
        self._face_mesh.close()
