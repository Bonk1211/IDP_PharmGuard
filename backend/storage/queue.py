"""SQLite-backed FIFO queue for adherence + telemetry events.

Phase 8 (offline queue + reliability). Wraps a single sqlite3 connection
in WAL mode. The queue is single-writer, single-reader from the main.py
cycle thread -- no replay thread, so no per-connection lock needed.

Schema:
    events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,             -- 'intake' | 'temperature'
        payload_json TEXT NOT NULL,     -- JSON-serialised dict POSTed to backend
        is_stub INTEGER NOT NULL DEFAULT 0,
        posted INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL        -- time.time() UTC seconds
    )

HI-012 carry-over: each row records ``is_stub`` at enqueue time. Stub-mode
rows for ``intake`` with ``pill_taken=true`` MUST be blocked at replay
(defensive; main.py also forces ``pill_taken_actual=False`` in stub).

2-phase commit (per the constraint): write row with posted=0; POST; on 2xx
set posted=1. A crash between POST-200 and the UPDATE replays the row,
producing a duplicate on the backend. Documented limitation; future fix
is per-event UUID + backend dedup column.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_VALID_KINDS = ("intake",)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    is_stub INTEGER NOT NULL DEFAULT 0,
    posted INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_unposted ON events(posted, created_at);
"""


class OfflineQueue:
    """Durable FIFO queue for Pi -> backend telemetry.

    Use one instance per process. Open in main.py after settings are
    validated; pass through to the report_intake / report_temperature
    helpers and the cycle-top _replay_drain.
    """

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False because the Pi-hosted FastAPI refactor
        # (scheduler/cycle_runner.py) wraps queue ops in `asyncio.to_thread`,
        # so the connection ends up handed between the main asyncio thread
        # and worker threads in the default executor. Concurrent access is
        # NOT a concern because the HardwareLoop supervisor serializes every
        # cycle pass — only one queue op runs at a time.
        # isolation_level=None makes each statement autocommit -- combined
        # with WAL + NORMAL, every enqueue is durable on return.
        self._conn = sqlite3.connect(
            str(self.db_path), isolation_level=None, check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        # WAL + NORMAL is the correct durability pairing for high write rate.
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(_SCHEMA)
        log.info(
            "OfflineQueue opened at %s (pending=%d)",
            self.db_path,
            self.pending_count(),
        )

    def enqueue(
        self,
        kind: str,
        payload: dict[str, Any],
        is_stub: bool = False,
    ) -> int:
        """Append a row. Returns the new row id. Durable on return.

        Raises ValueError on unknown ``kind`` -- callers must use one of
        ``intake`` or ``temperature``.
        """
        if kind not in _VALID_KINDS:
            raise ValueError(
                f"unknown kind: {kind!r} (expected one of {_VALID_KINDS})"
            )
        now = time.time()
        cur = self._conn.execute(
            "INSERT INTO events(kind, payload_json, is_stub, posted, created_at) "
            "VALUES (?, ?, ?, 0, ?)",
            (
                kind,
                json.dumps(payload, separators=(",", ":")),
                1 if is_stub else 0,
                now,
            ),
        )
        row_id = cur.lastrowid
        # Autocommit means the row is durable when this returns. No
        # explicit COMMIT is needed.
        assert row_id is not None
        return int(row_id)

    def peek_batch(
        self, limit: int = 20
    ) -> list[tuple[int, str, dict[str, Any], bool]]:
        """Return up to ``limit`` oldest unposted rows.

        Does NOT mark anything. Tuple shape:
            (row_id, kind, payload_dict, is_stub_bool)
        """
        rows = self._conn.execute(
            "SELECT id, kind, payload_json, is_stub FROM events "
            "WHERE posted = 0 ORDER BY id ASC LIMIT ?",
            (limit,),
        ).fetchall()
        out: list[tuple[int, str, dict[str, Any], bool]] = []
        for r in rows:
            try:
                payload = json.loads(r["payload_json"])
            except json.JSONDecodeError:
                log.exception(
                    "queue row %d has corrupt JSON; skipping",
                    r["id"],
                )
                continue
            out.append(
                (int(r["id"]), str(r["kind"]), payload, bool(r["is_stub"]))
            )
        return out

    def mark_sent(self, row_ids: list[int]) -> None:
        """Mark rows as posted. Idempotent. No-op on empty list."""
        if not row_ids:
            return
        placeholders = ",".join("?" for _ in row_ids)
        self._conn.execute(
            f"UPDATE events SET posted = 1 WHERE id IN ({placeholders})",
            row_ids,
        )

    def pending_count(self) -> int:
        """Number of rows with posted=0."""
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM events WHERE posted = 0"
        ).fetchone()
        return int(row["n"]) if row is not None else 0

    def oldest_age_seconds(self) -> float | None:
        """Age of the oldest unposted row in seconds, or None if empty."""
        row = self._conn.execute(
            "SELECT MIN(created_at) AS t FROM events WHERE posted = 0"
        ).fetchone()
        if row is None or row["t"] is None:
            return None
        return max(0.0, time.time() - float(row["t"]))

    def close(self) -> None:
        """Close the underlying connection. Idempotent."""
        try:
            self._conn.close()
        except sqlite3.Error:
            log.exception("OfflineQueue close failed (continuing)")
