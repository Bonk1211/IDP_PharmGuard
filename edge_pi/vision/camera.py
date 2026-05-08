"""Uniform camera source: wraps Picamera2 or cv2.VideoCapture behind read_frame() / close()."""

from __future__ import annotations

import logging
import os
from typing import Protocol, runtime_checkable

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

# Default capture geometry — moderate to avoid the known dual-cam max-resolution
# failure documented at https://github.com/raspberrypi/picamera2/issues/1035.
DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 480


@runtime_checkable
class CameraSource(Protocol):
    """Read-one-frame interface. Both Picamera2Source and Cv2Source implement it."""

    def read_frame(self) -> np.ndarray | None: ...

    def close(self) -> None: ...


class Picamera2Source:
    def __init__(
        self,
        cam_num: int,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
    ) -> None:
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
        # picamera2 RGB888 -> BGR for cv2/ultralytics consistency.
        return cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

    def close(self) -> None:
        try:
            self._cam.stop()
            self._cam.close()
        except Exception:
            log.exception("Picamera2Source close failed (continuing)")


class Cv2Source:
    """Wrap an existing cv2.VideoCapture (or open one by index/url)."""

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


def open_camera(
    cam_num: int,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
) -> CameraSource:
    """Open a CSI camera (preferred) with cv2 fallback.

    Stub mode does NOT silently return dummy frames — that would falsify
    telemetry per CLAUDE.md. Stub mode only changes log level on the
    first-fallback path.
    """
    if _HAS_PICAMERA2:
        try:
            return Picamera2Source(cam_num, width, height)
        except Exception as exc:
            if _STUB_ALLOWED:
                log.warning(
                    "Picamera2 open failed for cam_num=%d (%s); trying cv2",
                    cam_num,
                    exc,
                )
            else:
                raise
    try:
        return Cv2Source(cam_num)
    except Exception as exc:
        raise RuntimeError(
            f"open_camera: no working backend for cam_num={cam_num}"
        ) from exc
