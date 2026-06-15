"""Unit tests for services/telegram_notifier.send_alert.

Covers the soft-fail contract (no raises) and the success path, with
``requests.post`` monkeypatched so no network call is made. ``requests`` is
imported lazily inside ``send_alert``, so patching the global ``requests.post``
covers it (the lazy import resolves to the same module object).
"""

from __future__ import annotations

import pytest

from services import telegram_notifier as tn


def test_config_unset_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tn.settings, "telegram_bot_token", "", raising=False)
    monkeypatch.setattr(tn.settings, "telegram_chat_id", "", raising=False)
    out = tn.send_alert("hi")
    assert out["ok"] is False
    assert "TELEGRAM_BOT_TOKEN" in out["error"]


def test_upstream_error_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tn.settings, "telegram_bot_token", "t", raising=False)
    monkeypatch.setattr(tn.settings, "telegram_chat_id", "c", raising=False)

    class _Boom:
        def raise_for_status(self) -> None:
            raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr("requests.post", lambda *a, **k: _Boom())
    out = tn.send_alert("hi")
    assert out["ok"] is False
    assert isinstance(out["error"], str) and "401" in out["error"]


def test_error_redacts_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tn.settings, "telegram_bot_token", "sekret-token", raising=False)
    monkeypatch.setattr(tn.settings, "telegram_chat_id", "c", raising=False)

    class _Boom:
        def raise_for_status(self) -> None:
            raise RuntimeError(
                "404 for url: https://api.telegram.org/botsekret-token/sendMessage"
            )

    monkeypatch.setattr("requests.post", lambda *a, **k: _Boom())
    out = tn.send_alert("hi")
    assert "sekret-token" not in out["error"]
    assert "***" in out["error"]


def test_escape_html() -> None:
    assert tn.escape_html("Vit C <500mg> & co") == "Vit C &lt;500mg&gt; &amp; co"


def test_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tn.settings, "telegram_bot_token", "t", raising=False)
    monkeypatch.setattr(tn.settings, "telegram_chat_id", "c", raising=False)

    class _OK:
        def raise_for_status(self) -> None:
            return None

    monkeypatch.setattr("requests.post", lambda *a, **k: _OK())
    out = tn.send_alert("hi")
    assert out == {"ok": True, "error": None}
