"""Pill spotter: confirms the dispensing tray is empty after ejection."""

from __future__ import annotations

import logging
import time

import numpy as np
from ultralytics import YOLO

from vision.camera import CameraSource, open_camera

log = logging.getLogger(__name__)

EMPTY_FRAME_STREAK = 3


class PillVerifier:
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

    def _ensure_model(self) -> None:
        if self._model is None:
            log.info("Loading YOLO spotter from %s", self.model_path)
            self._model = YOLO(self.model_path)

    def _ensure_camera(self) -> None:
        if self._source is not None:
            return
        self._source = open_camera(self.camera_index)

    def _read_frame(self) -> np.ndarray | None:
        return self._source.read_frame() if self._source is not None else None

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
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
