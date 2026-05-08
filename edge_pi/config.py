"""
PharmGuard Edge runtime configuration.

Loads settings from environment variables. systemd's `EnvironmentFile=` already
loads `.env` for the service unit; for dev runs, source the file manually:

    set -a; source .env; set +a

No third-party dependencies — `os.environ` only.

Usage:
    from config import settings
    settings.validate()  # call once at startup; raises RuntimeError if bad
    print(settings.BACKEND_URL)
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


_MISSING_ENV_HINT = "see edge_pi/.env.example"


def _require(name: str) -> str:
    """Read a required env var or raise a friendly RuntimeError."""
    try:
        value = os.environ[name]
    except KeyError as exc:
        raise RuntimeError(
            f"Missing required env: {name} — {_MISSING_ENV_HINT}"
        ) from exc
    if not value:
        raise RuntimeError(
            f"Required env {name} is empty — {_MISSING_ENV_HINT}"
        )
    return value


@dataclass(frozen=True)
class _Settings:
    """Frozen view of runtime settings.

    Construct via `_load()`; never instantiate directly with literals — env is
    the source of truth.
    """

    BACKEND_URL: str
    DEVICE_TOKEN: str
    POLL_INTERVAL_S: float
    STUB_MODE: bool
    DISPENSER_ID: str
    BENCH_MODE: bool
    BENCH_LOG_PATH: str
    # Phase 8: offline queue + reliability
    OFFLINE_QUEUE_PATH: str
    OFFLINE_MAX_AGE_SECONDS: float
    OFFLINE_REPLAY_INTERVAL_S: float

    def validate(self) -> None:
        """Enforce production-safety invariants. Idempotent.

        Rules:
          - If not STUB_MODE: BACKEND_URL must use https://
          - DEVICE_TOKEN must be at least 16 chars
            (secrets.token_urlsafe(32) yields ~43, so this rejects empty /
            obviously-placeholder tokens).
        """
        if not self.STUB_MODE and not self.BACKEND_URL.startswith("https://"):
            raise RuntimeError(
                "BACKEND_URL must be https:// in prod "
                "(set PHARMGUARD_STUB=1 to bypass)"
            )
        if len(self.DEVICE_TOKEN) < 16:
            raise RuntimeError(
                "DEVICE_TOKEN must be >=16 chars; generate one with "
                "`python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`"
            )


def _load() -> _Settings:
    """Build a `_Settings` from the current process environment.

    Kept as a function (not a module-import side-effect) so tests can
    monkeypatch `os.environ` and call `_load()` to rebuild.
    """
    backend_url = _require("BACKEND_URL")
    device_token = _require("DEVICE_TOKEN")
    poll_interval = float(os.environ.get("POLL_INTERVAL_S", "30"))
    stub_mode = os.environ.get("PHARMGUARD_STUB", "0") == "1"
    dispenser_id = os.environ.get("DISPENSER_ID", "")
    bench_mode = os.environ.get("BENCH_MODE", "0") == "1"
    bench_log_path = os.environ.get("BENCH_LOG_PATH", "/tmp/bench_e2e.csv")
    # Phase 8: offline queue + reliability. Defaults are safe-for-prod:
    # 1 h max-age before refuse-to-dispense, 30 s replay cadence, queue
    # under ~/.pharmguard/ so a fresh Pi clone bootstraps without a
    # mkdir step.
    offline_queue_path = os.environ.get(
        "OFFLINE_QUEUE_PATH",
        str(Path.home() / ".pharmguard" / "queue.db"),
    )
    offline_max_age = float(os.environ.get("OFFLINE_MAX_AGE_SECONDS", "3600"))
    offline_replay_interval = float(
        os.environ.get("OFFLINE_REPLAY_INTERVAL_S", "30")
    )
    return _Settings(
        BACKEND_URL=backend_url,
        DEVICE_TOKEN=device_token,
        POLL_INTERVAL_S=poll_interval,
        STUB_MODE=stub_mode,
        DISPENSER_ID=dispenser_id,
        BENCH_MODE=bench_mode,
        BENCH_LOG_PATH=bench_log_path,
        OFFLINE_QUEUE_PATH=offline_queue_path,
        OFFLINE_MAX_AGE_SECONDS=offline_max_age,
        OFFLINE_REPLAY_INTERVAL_S=offline_replay_interval,
    )


class _LazySettings:
    """Lazy proxy so `from config import settings` doesn't crash at import.

    Real env validation/lookup is deferred until first attribute access or an
    explicit `settings.validate()` call. This keeps `python -m py_compile` and
    unit-test imports clean.
    """

    __slots__ = ("_resolved",)

    def __init__(self) -> None:
        self._resolved: _Settings | None = None

    def _resolve(self) -> _Settings:
        if self._resolved is None:
            self._resolved = _load()
        return self._resolved

    def reload(self) -> None:
        """Force re-read of env (useful in tests after monkeypatching)."""
        self._resolved = _load()

    def validate(self) -> None:
        self._resolve().validate()

    # Proxy attribute access through to the underlying frozen dataclass.
    def __getattr__(self, item: str):
        return getattr(self._resolve(), item)


settings = _LazySettings()
