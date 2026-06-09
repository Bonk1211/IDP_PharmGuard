"""Lazy DeepSeek client for the clinician assistant.

DeepSeek's API is OpenAI chat-completions compatible, so we use the ``openai``
SDK pointed at the DeepSeek base URL. One client per process, created lazily so
import-time stays side-effect-free.

Raises RuntimeError when DEEPSEEK_API_KEY is unset so api/agent.py maps it to a
503 (the clinician assistant is opt-in).
"""

from __future__ import annotations

import logging

from config import settings

log = logging.getLogger(__name__)

_client = None  # openai client (pointed at DeepSeek) cache


def get_client():
    """Lazy-init the OpenAI-compatible DeepSeek client. ONE per process."""
    global _client
    if _client is not None:
        return _client
    if not settings.deepseek_api_key:
        raise RuntimeError(
            "DEEPSEEK_API_KEY not set — agent endpoints unavailable. "
            "Set it in backend/.env to enable the clinician assistant."
        )
    from openai import OpenAI  # lazy import

    _client = OpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    log.info(
        "agent: DeepSeek client ready (base=%s model=%s)",
        settings.deepseek_base_url,
        settings.deepseek_model,
    )
    return _client
