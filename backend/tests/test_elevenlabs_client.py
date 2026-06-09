"""Unit tests for services/elevenlabs_client.synthesize.

Covers the soft-fail contract (no raises) and the success path, with
``requests.post`` monkeypatched so no network call is made. ``requests`` is
imported lazily inside ``synthesize``, so patching the global ``requests.post``
covers it (the lazy import resolves to the same module object).
"""

from __future__ import annotations

import pytest

from services import elevenlabs_client as ec


def test_key_unset_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "", raising=False)
    out = ec.synthesize("hi")
    assert out["audio"] is None
    assert out["error"] == "ELEVENLABS_API_KEY not set"


def test_upstream_error_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "k", raising=False)

    class _Boom:
        content = b""

        def raise_for_status(self) -> None:
            raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr("requests.post", lambda *a, **k: _Boom())
    out = ec.synthesize("hi")
    assert out["audio"] is None
    assert isinstance(out["error"], str) and "401" in out["error"]


def test_success_returns_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "k", raising=False)

    class _OK:
        content = b"ID3audio"

        def raise_for_status(self) -> None:
            return None

    monkeypatch.setattr("requests.post", lambda *a, **k: _OK())
    out = ec.synthesize("hi")
    assert out == {"audio": b"ID3audio", "error": None}
