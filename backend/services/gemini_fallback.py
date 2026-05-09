"""
Gemini Vision API fallback for pill identification.

Used when the local YOLO models fail or have low confidence.
"""

import logging

from config import settings

log = logging.getLogger(__name__)


async def identify_pill(image_bytes: bytes) -> dict | None:
    """
    Send a pill image to Google Gemini for identification.
    Returns {"name": str, "confidence": float} or None.
    """
    if not settings.gemini_api_key:
        log.warning("GEMINI_API_KEY not set — fallback unavailable")
        return None

    try:
        import google.generativeai as genai

        genai.configure(api_key=settings.gemini_api_key)
        model = genai.GenerativeModel("gemini-1.5-flash")

        response = model.generate_content(
            [
                "Identify this pill. Return only the medication name and your confidence (0-1).",
                {"mime_type": "image/jpeg", "data": image_bytes},
            ]
        )
        # TODO: Parse structured response
        return {"raw_response": response.text}
    except Exception:
        log.exception("Gemini fallback failed")
        return None
