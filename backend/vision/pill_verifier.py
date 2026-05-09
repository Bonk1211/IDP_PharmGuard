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

    def _has_pill(self, frame: np.ndarray, *, return_confidence: bool = False):
        """Return whether the frame shows a pill above ``conf_thresh``.

        Default: returns ``bool``. With ``return_confidence=True``, returns
        ``(bool, float)`` where the float is the highest detection confidence
        observed in this frame (regardless of threshold). Phase 9 added the
        opt-in shape so callers can populate
        ``adherence_logs.confidence_score`` without changing the existing
        bool-return contract.
        """
        assert self._model is not None
        results = self._model(frame, verbose=False)
        best_conf = 0.0
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                c = float(box.conf[0])
                if c > best_conf:
                    best_conf = c
        passed = best_conf >= self.conf_thresh
        if return_confidence:
            return passed, best_conf
        return passed

    def confirm_tray_empty(self, timeout_s: float = 5.0, *, return_confidence: bool = False):
        """Return True once `EMPTY_FRAME_STREAK` consecutive empty frames are seen.

        Default: returns ``bool``. With ``return_confidence=True``, returns
        ``(bool, float)`` where the float is the maximum YOLO confidence seen
        across all frames polled in this call. Useful for downstream telemetry
        (Phase 9) — the highest observation captures the strongest pill-like
        evidence the tray showed during verification, even if the streak
        eventually went empty.
        """
        self._ensure_model()
        try:
            self._ensure_camera()
        except Exception:
            log.exception("Tray camera initialization failed")
            if return_confidence:
                return False, 0.0
            return False

        deadline = time.time() + timeout_s
        empty_streak = 0
        max_conf = 0.0
        while time.time() < deadline:
            frame = self._read_frame()
            if frame is None:
                time.sleep(0.05)
                continue
            has_pill, conf = self._has_pill(frame, return_confidence=True)
            if conf > max_conf:
                max_conf = conf
            if has_pill:
                empty_streak = 0
            else:
                empty_streak += 1
                if empty_streak >= EMPTY_FRAME_STREAK:
                    log.info(
                        "Tray confirmed empty (%d consecutive frames, max_conf=%.3f)",
                        empty_streak,
                        max_conf,
                    )
                    if return_confidence:
                        return True, max_conf
                    return True
        log.warning("Tray-empty confirmation timed out after %.1fs", timeout_s)
        if return_confidence:
            return False, max_conf
        return False

    def close(self) -> None:
        if self._source is not None and self._owns_source:
            self._source.close()
        self._source = None
