"""Uniform camera source: wraps Picamera2, rpicam-vid subprocess, or cv2.VideoCapture behind read_frame() / close()."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from typing import Protocol, runtime_checkable

import cv2
import numpy as np

try:
    from picamera2 import Picamera2  # type: ignore[import-not-found]

    _HAS_PICAMERA2 = True
except ImportError:
    _HAS_PICAMERA2 = False


def _has_rpicam() -> bool:
    """rpicam-vid is shipped with Raspberry Pi OS Bookworm+; check at runtime."""
    return shutil.which("rpicam-vid") is not None


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


class RpicamSource:
    """Spawn rpicam-vid → MJPEG/TCP → cv2.VideoCapture.

    Workaround for Trixie + cp312 venv where the system python3-libcamera
    bindings aren't ABI-compatible with the venv's Python. rpicam-vid is
    the libcamera CLI; cv2 reads its MJPEG stream over TCP.
    """

    BASE_PORT = 8888

    def __init__(
        self,
        cam_num: int,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
        framerate: int = 15,
    ) -> None:
        if not _has_rpicam():
            raise RuntimeError("rpicam-vid not on PATH")
        self._cam_num = cam_num
        self._port = self.BASE_PORT + cam_num
        cmd = [
            "rpicam-vid",
            "--camera", str(cam_num),
            "-n", "-t", "0",
            "--codec", "mjpeg",
            "-q", "70",
            "--width", str(width),
            "--height", str(height),
            "--framerate", str(framerate),
            "-l",
            "-o", f"tcp://0.0.0.0:{self._port}",
        ]
        log.info("RpicamSource spawning: %s", " ".join(cmd))
        self._proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
        url = f"tcp://localhost:{self._port}"
        self._cap: cv2.VideoCapture | None = None
        for attempt in range(30):
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            if cap.isOpened():
                ok, _ = cap.read()
                if ok:
                    self._cap = cap
                    log.info(
                        "RpicamSource opened (cam_num=%d, port=%d, %dx%d)",
                        cam_num, self._port, width, height,
                    )
                    return
                cap.release()
            time.sleep(0.5)
        # Couldn't connect to the rpicam-vid stream — kill the subprocess
        if self._proc.poll() is None:
            self._proc.terminate()
        raise RuntimeError(
            f"RpicamSource: cv2 failed to open tcp://localhost:{self._port} after 15s"
        )

    def read_frame(self) -> np.ndarray | None:
        if self._cap is None:
            return None
        ok, frame = self._cap.read()
        return frame if ok else None

    def close(self) -> None:
        try:
            if self._cap is not None:
                self._cap.release()
        except Exception:
            log.exception("RpicamSource cv2 release failed (continuing)")
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()


def open_camera(
    cam_num: int,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
) -> CameraSource:
    """Open a CSI camera (preferred) with rpicam-vid + cv2 fallback chain.

    Backend tried in order:
      1. Picamera2Source — direct libcamera bindings (when picamera2 is
         importable in the active Python; works on Bookworm + system py3).
      2. RpicamSource — rpicam-vid subprocess piping MJPEG over TCP into
         cv2 (works on Trixie + cp312 venv where libcamera Python bindings
         aren't ABI-compatible).
      3. Cv2Source — direct V4L2 (USB cameras only; CSI cameras on Pi 5
         won't appear here once libcamera owns them).

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
                    "Picamera2 open failed for cam_num=%d (%s); trying rpicam-vid",
                    cam_num, exc,
                )
            else:
                raise
    if _has_rpicam():
        try:
            return RpicamSource(cam_num, width, height)
        except Exception as exc:
            log.warning(
                "RpicamSource open failed for cam_num=%d (%s); trying direct cv2",
                cam_num, exc,
            )
    try:
        return Cv2Source(cam_num)
    except Exception as exc:
        raise RuntimeError(
            f"open_camera: no working backend for cam_num={cam_num}"
        ) from exc
