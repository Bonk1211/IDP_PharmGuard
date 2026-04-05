"""
Pill verification using a two-stage YOLO pipeline.

Stage 1 (Spotter) — YOLOv11: Detects whether a pill is present in the tray.
Stage 2 (Expert)  — YOLOv8:  Classifies the pill type for medication matching.
"""

import logging

log = logging.getLogger(__name__)

# Model paths — place .pt files in edge_pi/models/
SPOTTER_MODEL = "models/spotter_yolov11.pt"
EXPERT_MODEL = "models/expert_yolov8.pt"


class PillVerifier:
    def __init__(self) -> None:
        self.spotter = None
        self.expert = None
        self._load_models()

    def _load_models(self) -> None:
        try:
            from ultralytics import YOLO

            self.spotter = YOLO(SPOTTER_MODEL)
            self.expert = YOLO(EXPERT_MODEL)
            log.info("Vision models loaded")
        except Exception:
            log.warning("Could not load YOLO models — running in stub mode")

    def detect_pill(self, frame) -> list[dict]:
        """Run the spotter model on a camera frame. Returns list of detections."""
        if self.spotter is None:
            return []
        results = self.spotter(frame, verbose=False)
        detections = []
        for r in results:
            for box in r.boxes:
                detections.append(
                    {
                        "class": int(box.cls[0]),
                        "confidence": float(box.conf[0]),
                        "bbox": box.xyxy[0].tolist(),
                    }
                )
        return detections

    def classify_pill(self, frame) -> str | None:
        """Run the expert classifier on a cropped pill image."""
        if self.expert is None:
            return None
        results = self.expert(frame, verbose=False)
        if results and results[0].probs is not None:
            top_class = int(results[0].probs.top1)
            return results[0].names[top_class]
        return None

    def confirm_tray_empty(self) -> bool:
        """Capture a frame and check that no pill remains in the tray."""
        # TODO: Capture frame from tray camera
        log.info("Checking tray — stub: assuming empty")
        return True
