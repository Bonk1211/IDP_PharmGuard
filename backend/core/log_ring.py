"""In-memory ring buffer for recent log records.

Surfaced via GET /api/device/logs so the dashboard can show what the
Pi's just been doing without an SSH/journalctl roundtrip. Survives
only as long as the uvicorn process — by design.
"""
from __future__ import annotations

import logging
from collections import deque
from threading import Lock
from typing import Any, Deque

_MAXLEN_DEFAULT = 500


class RingBufferHandler(logging.Handler):
    def __init__(self, maxlen: int = _MAXLEN_DEFAULT) -> None:
        super().__init__()
        self.records: Deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._lock = Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = {
                "ts": record.created,
                "level": record.levelname,
                "name": record.name,
                "message": record.getMessage(),
            }
            with self._lock:
                self.records.appendleft(entry)
        except Exception:
            self.handleError(record)

    def snapshot(self, n: int | None = None) -> list[dict[str, Any]]:
        with self._lock:
            if n is None or n >= len(self.records):
                return list(self.records)
            return list(self.records)[:n]


_RING: RingBufferHandler | None = None


def install_ring_handler(
    level: int = logging.INFO,
    maxlen: int = _MAXLEN_DEFAULT,
) -> RingBufferHandler:
    global _RING
    if _RING is not None:
        return _RING
    handler = RingBufferHandler(maxlen=maxlen)
    handler.setLevel(level)
    logging.getLogger().addHandler(handler)
    _RING = handler
    return handler


def get_ring() -> RingBufferHandler | None:
    return _RING
