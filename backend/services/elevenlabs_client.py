"""ElevenLabs text-to-speech wrapper for the dispenser's nurse voice.

Used by ``POST /api/device/tts`` to synthesize short spoken prompts during the
guided demo (face-centering instruction + post-auth greeting). Returns raw MP3
bytes the dashboard browser plays.

Mirrors ``services/label_detector.py`` soft-fail posture: a missing key or any
network failure surfaces as ``{"audio": None, "error": str}``, never a raise, so
the demo degrades to text-only instead of crashing a round.
"""

from __future__ import annotations

import logging

from config import settings

log = logging.getLogger(__name__)

_BASE = "https://api.elevenlabs.io/v1/text-to-speech"


def synthesize(
    text: str,
    voice_id: str | None = None,
    model_id: str | None = None,
) -> dict:
    """Synthesize ``text`` to MP3 via ElevenLabs.

    Returns ``{"audio": bytes | None, "error": str | None}``. Soft-fail: any
    failure (missing key, network, non-2xx) returns ``audio=None`` with the
    error message — never raises, so the caller can degrade to text-only.
    """
    if not settings.elevenlabs_api_key:
        return {"audio": None, "error": "ELEVENLABS_API_KEY not set"}
    vid = voice_id or settings.elevenlabs_voice_id
    mid = model_id or settings.elevenlabs_model_id
    import requests  # lazy — keep import-time side-effect-free

    try:
        r = requests.post(
            f"{_BASE}/{vid}",
            params={"output_format": settings.elevenlabs_output_format},
            headers={
                "xi-api-key": settings.elevenlabs_api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={"text": text, "model_id": mid},
            timeout=15,
        )
        r.raise_for_status()
    except Exception as exc:  # ConnectionError, HTTPError (401/4xx/5xx), etc.
        log.warning("ElevenLabs synthesize failed: %s", exc)
        return {"audio": None, "error": str(exc)}
    return {"audio": r.content, "error": None}
