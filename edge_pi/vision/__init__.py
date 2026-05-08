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
