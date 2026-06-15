"""Telegram caregiver-alert client (send-only bot).

Used by the dispense cycle (failed dose), the flag detector (new
warning/critical flags), and ``POST /api/device/notify`` (guided-flow
wrong-pill / operator-marked miss) to push a message to the configured
caregiver chat.

Mirrors ``services/elevenlabs_client.py`` soft-fail posture: missing config or
any network failure surfaces as ``{"ok": False, "error": str}``, never a raise,
so a Telegram outage can never break a dispense cycle or a demo round.
"""

from __future__ import annotations

import logging

from config import settings

log = logging.getLogger(__name__)

_BASE = "https://api.telegram.org"


def escape_html(s: str) -> str:
    """Escape text interpolated into parse_mode=HTML messages.

    Telegram rejects the whole message (400 "can't parse entities") on stray
    ``< > &``, which would silently drop the alert under the soft-fail
    contract — so callers must escape med names, flag titles, and any
    operator-entered text.
    """
    import html

    return html.escape(s, quote=False)


def send_alert(text: str) -> dict:
    """Send ``text`` to the configured caregiver chat.

    Returns ``{"ok": bool, "error": str | None}``. Soft-fail: missing config,
    network errors, and non-2xx all return ok=False with the error message —
    never raises, so callers (the dispense cycle!) can't be broken by Telegram.
    """
    if not settings.telegram_bot_token or not settings.telegram_chat_id:
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set"}
    import requests  # lazy — keep import-time side-effect-free

    try:
        r = requests.post(
            f"{_BASE}/bot{settings.telegram_bot_token}/sendMessage",
            json={
                "chat_id": settings.telegram_chat_id,
                "text": text,
                "parse_mode": "HTML",
            },
            timeout=10,
        )
        r.raise_for_status()
    except Exception as exc:  # ConnectionError, HTTPError (401/4xx/5xx), etc.
        # requests embeds the request URL — token included — in exception
        # text. Redact before it reaches the logs (the ring buffer is served
        # to the dashboard via /api/device/logs) or callers' error details.
        err = str(exc).replace(settings.telegram_bot_token, "***")
        log.warning("Telegram send_alert failed: %s", err)
        return {"ok": False, "error": err}
    return {"ok": True, "error": None}
