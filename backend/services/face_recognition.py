"""Face recognition service: 128-D embedding + Euclidean distance match.

Library: face_recognition (dlib, ResNet-34). One embedding per patient,
stored as a real[] of length 128 in patients.face_embedding.
"""

from __future__ import annotations

import io
import logging

log = logging.getLogger(__name__)

EMBEDDING_DIM = 128


def compute_embedding(image_bytes: bytes) -> list[float] | None:
    """Compute a 128-D face embedding from raw image bytes.

    Returns None if zero faces or >1 face detected (caller renders 400).
    Lazy-imports face_recognition + numpy so backend cold-start is cheap.
    """
    try:
        import face_recognition  # heavy; lazy
        import numpy as np
        from PIL import Image
    except ImportError:
        log.exception("face_recognition import failed")
        return None

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        arr = np.array(img)
        encodings = face_recognition.face_encodings(arr)
    except Exception:
        log.exception("face_encodings failed")
        return None

    if len(encodings) != 1:
        log.warning("Expected 1 face, got %d", len(encodings))
        return None
    return encodings[0].astype(float).tolist()


def match_embedding(
    probe: list[float],
    candidates: list[tuple[int, list[float]]],
    tolerance: float = 0.6,
) -> tuple[int, float] | None:
    """Find the closest candidate by Euclidean distance.

    candidates: list of (patient_id, embedding) tuples.
    Returns (patient_id, distance) of the closest match below tolerance, or None.
    """
    if not candidates:
        return None
    try:
        import numpy as np
    except ImportError:
        log.exception("numpy import failed")
        return None

    probe_arr = np.array(probe, dtype=float)
    best: tuple[int, float] | None = None
    for pid, emb in candidates:
        emb_arr = np.array(emb, dtype=float)
        dist = float(np.linalg.norm(probe_arr - emb_arr))
        if dist < tolerance and (best is None or dist < best[1]):
            best = (pid, dist)
    return best
