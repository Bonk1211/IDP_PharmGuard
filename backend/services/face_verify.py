"""AWS Rekognition CompareFaces wrapper for patient identity verification.

Used by ``POST /api/device/verify_face`` to confirm the patient at cam_b
matches the stored reference photo before the drawer can unlock. The
endpoint downloads the patient's ``face_reference_url`` (Supabase Storage
public URL), grabs one cam_b frame, encodes both as JPEG, and calls
``compare_faces`` here.

boto3 client is lazy-loaded so import-time stays side-effect-free:
- BACKEND_HEADLESS=1 dev-mac never pays the import cost
- Missing AWS creds surface as a per-call soft-fail (error string in
  response), not a boot-time crash.

The module-level ``_client`` is thread-safe per boto3 docs and is
distinct from the cached client in ``services/label_detector.py`` so the
two services can be enabled / disabled independently.
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

from config import settings

log = logging.getLogger(__name__)

_client = None  # boto3 rekognition client cache


def _get_client():
    """Lazy-init boto3 rekognition client. ONE per process."""
    global _client
    if _client is not None:
        return _client
    import boto3  # lazy import — avoids ~300ms cost when feature unused

    _client = boto3.client(
        "rekognition",
        region_name=settings.aws_region,
        # Empty strings → None so boto3 falls back to env / shared creds.
        aws_access_key_id=settings.aws_access_key_id or None,
        aws_secret_access_key=settings.aws_secret_access_key or None,
    )
    return _client


def encode_frame_jpeg(frame: np.ndarray, quality: int = 85) -> bytes:
    """Encode an OpenCV ndarray to JPEG bytes.

    cam_b is opened with ``output_format='rgb'`` (cycle_runner.py:118) for
    MediaPipe. Rekognition + cv2.imencode want BGR — convert here. Skipping
    the convert ships red/blue-swapped JPEGs to AWS and similarity tanks.
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


def compare_faces(
    source_jpeg: bytes,
    target_jpeg: bytes,
    threshold: float = 80.0,
) -> dict:
    """Call Rekognition CompareFaces (source = reference photo, target = live).

    Returns:
        ``{"match": bool, "similarity": float | None, "error": str | None}``

    - ``match`` is True when at least one face in target meets ``threshold``.
    - ``similarity`` is the best match's similarity score (0-100), or 0.0
      when faces are detected on both sides but none reach the threshold,
      or None on AWS error.
    - ``error`` carries the AWS exception message on failure (caller
      shows it to the operator).

    AWS quirks:
    - InvalidParameterException is returned when no face is detected in
      either image (e.g. cam_b sees an empty chair). Treated as soft-fail.
    - ImageTooLargeException at 5 MB+. Caller should keep JPEG quality
      <= 85 on a 640x480 frame.
    """
    try:
        resp = _get_client().compare_faces(
            SourceImage={"Bytes": source_jpeg},
            TargetImage={"Bytes": target_jpeg},
            SimilarityThreshold=float(threshold),
            QualityFilter="AUTO",
        )
    except Exception as exc:  # ClientError, EndpointConnectionError, etc.
        log.warning("Rekognition CompareFaces failed: %s", exc)
        return {"match": False, "similarity": None, "error": str(exc)}

    matches = resp.get("FaceMatches") or []
    if not matches:
        return {"match": False, "similarity": 0.0, "error": None}
    best = max(float(m.get("Similarity", 0.0)) for m in matches)
    return {"match": best >= threshold, "similarity": best, "error": None}
