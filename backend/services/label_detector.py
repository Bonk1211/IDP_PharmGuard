"""AWS Rekognition DetectLabels wrapper for Layer-2 intake object evidence.

Used by ``vision/intake_monitor.py`` to detect bottle/cup/pill/drink objects
in cam_b frames during the swallow window. The result is aggregated into
``IntakeMonitor._state["labels_seen"]`` and combined with the MediaPipe FSM
verdict as a hard gate (see .claude/PRPs/plans/intake-label-detection.plan.md).

boto3 client is lazy-loaded so import-time stays side-effect-free:
- BACKEND_HEADLESS=1 dev-mac never pays the import cost
- Missing AWS creds surface as a per-call soft-fail (error string in response),
  not a boot-time crash. Intake then falls back to ``missing_labels``.

The single module-level ``_client`` is safe to share across the
ThreadPoolExecutor workers in ``IntakeMonitor`` — boto3 clients are
thread-safe per docs.
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

from config import settings

log = logging.getLogger(__name__)

_client = None  # boto3 client cache, populated on first call


def _get_client():
    """Lazy-init boto3 rekognition client. ONE per process."""
    global _client
    if _client is not None:
        return _client
    import boto3  # lazy — avoids 300ms+ import cost when feature unused

    _client = boto3.client(
        "rekognition",
        region_name=settings.aws_region,
        # Pass None when empty so boto3 falls back to env / shared creds.
        aws_access_key_id=settings.aws_access_key_id or None,
        aws_secret_access_key=settings.aws_secret_access_key or None,
    )
    return _client


def encode_frame_jpeg(frame: np.ndarray, quality: int = 75) -> bytes:
    """Encode an OpenCV ndarray to JPEG bytes.

    cam_b is opened with ``output_format='rgb'`` (cycle_runner.py:118) for
    MediaPipe. Rekognition + cv2.imencode want BGR — convert here. Skipping
    the convert ships red/blue-swapped JPEGs to AWS and labels degrade silently.
    """
    bgr = (
        cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        if frame.ndim == 3 and frame.shape[2] == 3
        else frame
    )
    ok, jpeg = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return jpeg.tobytes()


def encode_thumbnail_b64(
    frame: np.ndarray,
    bbox: dict | None = None,
    max_w: int = 240,
    quality: int = 60,
    pad: float = 0.08,
) -> str:
    """Downscaled base64 JPEG proof thumbnail — cropped to the object.

    ``bbox`` is a Rekognition BoundingBox (ratios 0..1: Left/Top/Width/Height)
    relative to ``frame``. When given, the frame is cropped to just that
    object (with a small ``pad`` margin) so the proof shows the cup/bottle/pill
    itself, not the whole scene. When ``None`` the full frame is used.

    Kept small (≤max_w wide, low quality) because these are folded into the
    intake-state dict that the dashboard polls ~1×/s. Same RGB→BGR handling as
    ``encode_frame_jpeg``.
    """
    import base64

    img = frame
    if bbox and frame.ndim >= 2:
        h, w = frame.shape[0], frame.shape[1]
        left = float(bbox.get("Left", 0.0))
        top = float(bbox.get("Top", 0.0))
        bw = float(bbox.get("Width", 0.0))
        bh = float(bbox.get("Height", 0.0))
        # Expand by `pad` of the box size on each side, clamped to the frame.
        x1 = max(0, int(round((left - bw * pad) * w)))
        y1 = max(0, int(round((top - bh * pad) * h)))
        x2 = min(w, int(round((left + bw * (1 + pad)) * w)))
        y2 = min(h, int(round((top + bh * (1 + pad)) * h)))
        if x2 > x1 and y2 > y1:
            img = frame[y1:y2, x1:x2]

    if img.ndim == 3 and img.shape[1] > max_w:
        scale = max_w / float(img.shape[1])
        img = cv2.resize(
            img, (max_w, max(1, int(round(img.shape[0] * scale)))),
            interpolation=cv2.INTER_AREA,
        )
    bgr = (
        cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        if img.ndim == 3 and img.shape[2] == 3
        else img
    )
    ok, jpeg = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("thumbnail JPEG encode failed")
    return base64.b64encode(jpeg.tobytes()).decode("ascii")


def detect_labels(
    jpeg_bytes: bytes,
    min_confidence: float = 70.0,
    max_labels: int = 30,
) -> dict:
    """Call Rekognition DetectLabels on a single JPEG frame.

    Returns:
        ``{"labels": [{"name": str, "confidence": float,
                       "bbox": {"Left","Top","Width","Height"} | None}],
           "error": str | None}``

    ``bbox`` is the highest-confidence object instance's bounding box (ratios
    0..1) for that label, or ``None`` when Rekognition reports no instances
    (e.g. scene labels like "Indoors"). Used to crop a proof thumbnail down to
    just the detected object.

    On any AWS failure (missing creds, throttling, network), returns an
    empty labels list with the error message. Caller must treat
    ``error != None`` as a soft-fail (no labels recorded) — DON'T raise.
    """
    try:
        resp = _get_client().detect_labels(
            Image={"Bytes": jpeg_bytes},
            MinConfidence=float(min_confidence),
            MaxLabels=int(max_labels),
            Features=["GENERAL_LABELS"],
        )
    except Exception as exc:  # ClientError, EndpointConnectionError, etc.
        log.warning("DetectLabels failed: %s", exc)
        return {"labels": [], "error": str(exc)}

    out = []
    for lbl in resp.get("Labels") or []:
        instances = lbl.get("Instances") or []
        bbox = None
        if instances:
            best = max(
                instances, key=lambda inst: float(inst.get("Confidence", 0.0))
            )
            bbox = best.get("BoundingBox") or None
        out.append(
            {
                "name": lbl.get("Name"),
                "confidence": float(lbl.get("Confidence", 0.0)),
                "bbox": bbox,
            }
        )
    return {"labels": out, "error": None}
