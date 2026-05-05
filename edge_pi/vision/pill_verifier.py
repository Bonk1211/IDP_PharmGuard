"""Pill spotter: confirms the dispensing tray is empty after ejection."""

from __future__ import annotations

import logging
import time
from typing import Any

import numpy as np

try:
    from picamera2 import Picamera2  # type: ignore[import-not-found]

    _HAS_PICAMERA2 = True
except ImportError:
    _HAS_PICAMERA2 = False

import cv2
from ultralytics import YOLO

log = logging.getLogger(__name__)

EMPTY_FRAME_STREAK = 3


class PillVerifier:
    def __init__(
        self,
        model_path: str = "models/spotter.pt",
        camera_index: int = 0,
        conf_thresh: float = 0.5,
    ) -> None:
        self.model_path = model_path
        self.camera_index = camera_index
        self.conf_thresh = conf_thresh
        self._model: YOLO | None = None
        self._cap: Any | None = None
        self._using_picamera = False

    def _ensure_model(self) -> None:
        if self._model is None:
            log.info("Loading YOLO spotter from %s", self.model_path)
            self._model = YOLO(self.model_path)

    def _ensure_camera(self) -> None:
        if self._cap is not None:
            return
        if _HAS_PICAMERA2:
            cam = Picamera2(self.camera_index)
            cam.configure(cam.create_preview_configuration(main={"format": "RGB888"}))
            cam.start()
            self._cap = cam
            self._using_picamera = True
            log.info("Tray camera initialized via picamera2 (index=%d)", self.camera_index)
        else:
            cap = cv2.VideoCapture(self.camera_index)
            if not cap.isOpened():
                raise RuntimeError(f"Cannot open camera index {self.camera_index}")
            self._cap = cap
            log.info("Tray camera initialized via cv2.VideoCapture (index=%d)", self.camera_index)

    def _read_frame(self) -> np.ndarray | None:
        if self._cap is None:
            return None
        if self._using_picamera:
            frame = self._cap.capture_array()
            # picamera2 RGB888 -> BGR for ultralytics/cv2 consistency
            return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        ok, frame = self._cap.read()
        return frame if ok else None

    def _has_pill(self, frame: np.ndarray) -> bool:
        assert self._model is not None
        results = self._model(frame, verbose=False)
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                if float(box.conf[0]) >= self.conf_thresh:
                    return True
        return False

    def confirm_tray_empty(self, timeout_s: float = 5.0) -> bool:
        """Return True once `EMPTY_FRAME_STREAK` consecutive empty frames are seen."""
        self._ensure_model()
        try:
            self._ensure_camera()
        except Exception:
            log.exception("Tray camera initialization failed")
            return False

        deadline = time.time() + timeout_s
        empty_streak = 0
        while time.time() < deadline:
            frame = self._read_frame()
            if frame is None:
                time.sleep(0.05)
                continue
            if self._has_pill(frame):
                empty_streak = 0
            else:
                empty_streak += 1
                if empty_streak >= EMPTY_FRAME_STREAK:
                    log.info("Tray confirmed empty (%d consecutive frames)", empty_streak)
                    return True
        log.warning("Tray-empty confirmation timed out after %.1fs", timeout_s)
        return False

    def close(self) -> None:
        if self._cap is None:
            return
        try:
            if self._using_picamera:
                self._cap.stop()
                self._cap.close()
            else:
                self._cap.release()
        finally:
            self._cap = None
