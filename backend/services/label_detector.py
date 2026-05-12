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


def detect_labels(
    jpeg_bytes: bytes,
    min_confidence: float = 70.0,
    max_labels: int = 30,
) -> dict:
    """Call Rekognition DetectLabels on a single JPEG frame.

    Returns:
        ``{"labels": [{"name": str, "confidence": float}], "error": str | None}``

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

    out = [
        {
            "name": lbl.get("Name"),
            "confidence": float(lbl.get("Confidence", 0.0)),
        }
        for lbl in resp.get("Labels") or []
    ]
    return {"labels": out, "error": None}
