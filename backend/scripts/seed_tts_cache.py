#!/usr/bin/env python3
"""Pre-render the fixed nurse-voice lines to the Supabase "tts-cache" bucket.

The guided round speaks a handful of lines that NEVER change (the face-centering
prompt + the three swallow-FSM step prompts). Re-synthesizing them on every
round burns ElevenLabs quota and adds latency. This script synthesizes each one
ONCE via the existing ElevenLabs client and uploads the MP3 to a public Supabase
Storage bucket; the dashboard then plays them straight from the Supabase CDN
(see ``speakStatic`` / ``STATIC_TTS`` in frontend/src/lib/device.ts).

Run it once (and again whenever you edit a line below or change the voice id):

    cd backend
    .venv/bin/python scripts/seed_tts_cache.py            # synth + upload all
    .venv/bin/python scripts/seed_tts_cache.py --dry-run  # print plan, no calls

Requires backend/.env to have SUPABASE_URL + SUPABASE_KEY (service_role) and
ELEVENLABS_API_KEY set. Idempotent: uploads with upsert, so re-runs overwrite.

IMPORTANT: keep SLUG_TEXT in sync with STATIC_TTS in
frontend/src/lib/device.ts — that map is the live-synth fallback for the same
slugs; if the words drift, a cache hit and a cache miss will say different
things.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import settings  # noqa: E402
from db.base import get_supabase  # noqa: E402
from services.elevenlabs_client import synthesize  # noqa: E402

log = logging.getLogger(__name__)

BUCKET = "tts-cache"

# slug -> exact text. MUST match STATIC_TTS in frontend/src/lib/device.ts.
SLUG_TEXT: dict[str, str] = {
    "centering": (
        "Hi there. Please make sure your face is centered in the camera "
        "so I can recognize you."
    ),
    "intake-ready": (
        "Whenever you're ready, gently bring your hand up to your mouth "
        "and take the pill."
    ),
    "intake-insert": (
        "Now open wide and place the pill in your mouth."
    ),
    "intake-swallow": (
        "That's good. Now close your mouth and swallow for me, nice and easy."
    ),
    "intake-done": (
        "Almost there — open your mouth so I can see it's all gone. "
        "You're doing great."
    ),
}


def _ensure_bucket(sb) -> None:
    """Create the public ``tts-cache`` bucket if it doesn't already exist."""
    try:
        sb.storage.get_bucket(BUCKET)
        log.info("bucket %r already exists", BUCKET)
        return
    except Exception:
        # get_bucket raises when the bucket is missing — fall through to create.
        pass
    sb.storage.create_bucket(
        BUCKET,
        options={"public": True, "allowed_mime_types": ["audio/mpeg"]},
    )
    log.info("created public bucket %r", BUCKET)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be synthesized/uploaded without calling APIs.",
    )
    args = ap.parse_args()

    if args.dry_run:
        for slug, text in SLUG_TEXT.items():
            print(f"[dry-run] {slug}.mp3  <-  {text!r}")
        return 0

    if not settings.elevenlabs_api_key:
        log.error("ELEVENLABS_API_KEY not set in backend/.env — nothing to do.")
        return 1
    if not settings.supabase_url or not settings.supabase_key:
        log.error("SUPABASE_URL / SUPABASE_KEY not set in backend/.env.")
        return 1

    sb = get_supabase()
    _ensure_bucket(sb)

    failures = 0
    for slug, text in SLUG_TEXT.items():
        out = synthesize(text)
        if out["audio"] is None:
            log.error("synth failed for %s: %s", slug, out["error"])
            failures += 1
            continue
        path = f"{slug}.mp3"
        sb.storage.from_(BUCKET).upload(
            path,
            out["audio"],
            {"content-type": "audio/mpeg", "upsert": "true"},
        )
        url = sb.storage.from_(BUCKET).get_public_url(path)
        log.info("uploaded %s (%d bytes) -> %s", path, len(out["audio"]), url)

    if failures:
        log.error("%d line(s) failed — re-run after fixing.", failures)
        return 1
    log.info("done: %d cached lines in bucket %r", len(SLUG_TEXT), BUCKET)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
