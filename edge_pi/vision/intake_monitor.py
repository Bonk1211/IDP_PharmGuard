"""
Patient intake monitoring — face detection and swallow confirmation.

Uses the patient-facing camera to verify the patient has taken the pill.
"""

import logging
import time

log = logging.getLogger(__name__)


class IntakeMonitor:
    def __init__(self) -> None:
        self.camera = None
        self._init_camera()

    def _init_camera(self) -> None:
        try:
            from picamera2 import Picamera2

            self.camera = Picamera2(1)  # Second camera (index 1)
            log.info("Intake camera initialized")
        except Exception:
            log.warning("Intake camera unavailable — running in stub mode")

    def capture_face(self):
        """Capture a single frame from the patient-facing camera."""
        if self.camera is None:
            return None
        # TODO: Implement actual capture
        return None

    def watch_for_swallow(self, timeout_s: int = 60) -> bool:
        """
        Monitor the patient for up to `timeout_s` seconds to confirm
        they have swallowed the medication.

        Returns True if swallow action detected, False on timeout.
        """
        log.info("Watching for swallow confirmation (timeout=%ds)", timeout_s)
        deadline = time.time() + timeout_s

        while time.time() < deadline:
            frame = self.capture_face()
            if frame is None:
                time.sleep(1)
                continue

            # TODO: Run swallow-detection model on frame
            # For now, stub returns True after brief wait
            time.sleep(2)
            log.info("Swallow confirmed (stub)")
            return True

        log.warning("Swallow confirmation timed out")
        return False
