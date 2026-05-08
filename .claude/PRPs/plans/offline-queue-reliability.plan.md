# Plan: Offline Queue + Reliability (PRD Phase 8)

## Summary
Stop losing adherence data on backend outage. Add a SQLite-backed FIFO queue on the Pi that wraps `report_intake` + `report_temperature` so every telemetry event is durably written to local disk *before* the HTTP POST. A drained-on-each-cycle replay reads `posted=false` rows and POSTs them; on success the row is marked `posted=true`. A refuse-to-dispense gate at the top of each cycle aborts the cycle when the oldest unflushed event is older than `OFFLINE_MAX_AGE_SECONDS` (default 1 h) — `BENCH_MODE=1` bypasses the gate so Phase 6 numbers stay reproducible. A new `scripts/chaos_offline.py` simulates 50 cycles with monkeypatched `requests` outages and asserts the queue accumulates during the outage and drains on recovery, with **no row marked `pill_taken=true` from stub mode** (HI-012 invariant carried into the queue).

Stdlib `sqlite3` only — no new deps.

## User Story
As the **PharmGuard ops team**, I want **the Pi to durably buffer adherence + temperature events through backend outages and replay them on reconnect**, so that **a 30-minute network blip never silently loses a dose record and a long outage refuses to dispense rather than dispense without telemetry**.

## Problem → Solution
**Today**: `report_intake` POSTs once and drops the row on `requests.RequestException`. `report_temperature` swallows the exception with a `log.warning`. There is no buffer, no replay, no outage-detection gate. A backend reboot during a dose silently loses the record.
**After**: Both reporters enqueue to `~/.pharmguard/queue.db` first (durable WAL-mode write), then POST. POST success → mark posted. POST failure → row sits in queue. A `_replay_drain()` at the top of each cycle pulls up to 20 unposted rows and re-POSTs them; on success they're marked posted. A separate `oldest_age_seconds()` check decides if the queue has been stuck too long → refuse the cycle.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 8 — Offline queue + reliability
- **Estimated Files**: 7 (1 new queue module, 1 storage __init__, 1 config update, 1 main.py update, 1 .env.example update, 1 new chaos script, plus plan + report)
- **Estimated Lines**: ~600 LOC net (queue module ~150, main.py +90, chaos script ~180, config + env ~20)

---

## UX Design

Internal change — no user-facing UX transformation. New CLI: `python3 scripts/chaos_offline.py --cycles 50`.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `report_intake` | POST once; drop on exception | enqueue local row → POST → on 2xx mark posted | durable |
| `report_temperature` | POST once; warn on exception | enqueue local row → POST → on 2xx mark posted | durable |
| Top of each cycle | (none) | replay-drain a small batch from queue; if `oldest_age > OFFLINE_MAX_AGE_SECONDS` AND not `BENCH_MODE`, skip cycle | gated |
| `~/.pharmguard/queue.db` | did not exist | SQLite WAL file, kind/payload/posted/created_at | new |
| `scripts/chaos_offline.py` | did not exist | injects timed network outages, asserts no falsified telemetry | new |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `edge_pi/main.py` | full file | Cycle structure with HI-012 / Phase 4 / Phase 5 / Phase 6 sentinels; `report_intake` + `report_temperature` are the wrap targets |
| P0 | `edge_pi/config.py` | full file | `_Settings` dataclass + lazy proxy — pattern for adding `OFFLINE_*` env keys |
| P0 | `backend/app/api/logs.py` | full file | `create_log` payload contract; no natural-key dedup → 2-phase commit on Pi |
| P0 | `.claude/PRPs/plans/completed/end-to-end-bench-loop.plan.md` | "Patterns to Mirror" | CONFIG_PATTERN_PI, BENCH_SCRIPT_PATTERN, sentinel-comment + env-gated optional behavior |
| P0 | `.claude/PRPs/plans/completed/dual-camera-refactor.plan.md` | "STUB_FAIL_LOUD_PATTERN" | Module-level `STUB_ALLOWED` + `is_stub` property mirror |
| P1 | `edge_pi/hardware/magazine.py` | 24-58 | STUB_FAIL_LOUD reference for queue init failure |
| P1 | `edge_pi/hardware/temp_sensor.py` | full file | Stub-mode never invents a value pattern — queue must inherit |
| P1 | `edge_pi/scripts/bench_e2e.py` | full | BENCH_SCRIPT_PATTERN for chaos_offline.py shape |
| P2 | `edge_pi/.env.example` | full | Where the new env keys land |
| P2 | `CLAUDE.md` | "Edge Pi" + HI-012 | Stub-mode invariant — the queue must never POST `pill_taken=true` from stub |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| SQLite WAL mode | https://www.sqlite.org/wal.html | `PRAGMA journal_mode=WAL` for concurrent reads + durable writes; survives crashes between `BEGIN` and `COMMIT` |
| Python `sqlite3` thread-safety | https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection | Connections aren't safe across threads by default; we keep a single connection in the cycle thread (no replay thread) |
| `synchronous=NORMAL` with WAL | https://www.sqlite.org/pragma.html#pragma_synchronous | `NORMAL + WAL` is the correct durability pairing — `FULL` is overkill for our event rate |

---

## Patterns to Mirror

### NAMING_CONVENTION (Pi modules)
```python
# SOURCE: edge_pi/hardware/temp_sensor.py:1-20
"""Tray temperature sensor — DS18B20 over 1-wire."""
from __future__ import annotations
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)
```
Rule: `from __future__ import annotations` at top; module docstring; module-level `log = logging.getLogger(__name__)`; PascalCase class; snake_case methods; positional log formatters never f-strings.

### CONFIG_PATTERN_PI
```python
# SOURCE: edge_pi/config.py:42-99
@dataclass(frozen=True)
class _Settings:
    BACKEND_URL: str
    DEVICE_TOKEN: str
    POLL_INTERVAL_S: float
    STUB_MODE: bool
    DISPENSER_ID: str
    BENCH_MODE: bool
    BENCH_LOG_PATH: str

def _load() -> _Settings:
    backend_url = _require("BACKEND_URL")
    ...
    bench_mode = os.environ.get("BENCH_MODE", "0") == "1"
    bench_log_path = os.environ.get("BENCH_LOG_PATH", "/tmp/bench_e2e.csv")
    return _Settings(...)
```
Rule: optional fields use `os.environ.get(name, default)`; required fields use `_require`. New optional fields land at the bottom of the dataclass + `_load()` to keep diffs minimal.

### STUB_FAIL_LOUD_PATTERN
```python
# SOURCE: edge_pi/hardware/magazine.py:24-58
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"

class Magazine:
    def __init__(self) -> None:
        try:
            import RPi.GPIO as GPIO
            ...
            self._is_stub = False
        except Exception as e:
            if STUB_ALLOWED:
                log.warning("GPIO unavailable — stub mode (PHARMGUARD_STUB=1)")
                self._is_stub = True
            else:
                raise RuntimeError("...") from e
```
Rule: when init fails, refuse to run unless `PHARMGUARD_STUB=1`. The queue does NOT need this guard for SQLite (stdlib always works), BUT the queue must propagate the **stub flag at enqueue time** — every event row carries an `is_stub` flag so the replay loop can suppress `pill_taken=true` POSTs from stub mode (HI-012 in the queue).

### TEMPERATURE_STUB_PATTERN (key for HI-012 in the queue)
```python
# SOURCE: edge_pi/hardware/temp_sensor.py:63-72
def read_celsius(self) -> float | None:
    """Return the latest temperature in C, or None if the read failed.

    Stub mode returns a constant safe-room value (22 C). Never invents an
    over-threshold reading.
    """
    if self._is_stub:
        return STUB_TEMP_C
```
Rule: stub never invents over-threshold telemetry. The queue must NOT post `pill_taken=true` for any row that was enqueued from stub mode. Concrete: every `enqueue` carries an `is_stub` column; `_replay_drain` skips rows where `kind="intake"` AND `is_stub=1` AND `payload.pill_taken == True` (in practice main.py never enqueues that combo because the stub branch forces `pill_taken_actual=False`, but the queue enforces the rule defensively).

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/main.py many call sites
log.info("Cycle complete — pill_taken=%s", pill_taken_actual)
log.warning("temperature post failed: %s", exc)
```
Rule: positional formatters; `info` for state transitions, `warning` for soft failures, `exception` for unexpected exceptions inside `try/except`.

### BENCH_SCRIPT_PATTERN
```python
# SOURCE: edge_pi/scripts/bench_e2e.py:1-25
#!/usr/bin/env python3
"""End-to-end bench: 200 happy-path cycles on real Pi 5, metrics report."""
from __future__ import annotations
import argparse, logging, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
```
Rule: shebang; module docstring with PRD reference; argparse with sensible defaults; insert parent dir on `sys.path`. `chaos_offline.py` follows this exactly.

### SENTINEL_COMMENT_PATTERN
```python
# SOURCE: edge_pi/main.py:98-121, 203-220, 225-235, 290-322
# ── Phase 6: end-to-end bench instrumentation ─────────────────────────────
...
# ── /Phase 6 ──────────────────────────────────────────────────────────────
```
Rule: every cross-phase block is bracketed by `# ── Phase N: …` / `# ── /Phase N ──` so subsequent phases can merge in isolation. Phase 8 wraps its cycle additions in `# ── Phase 8: …` / `# ── /Phase 8 ──`.

### TEST_STRUCTURE
N/A — repo has no test framework. Validation = py_compile + queue round-trip + textual regression + chaos script.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `edge_pi/storage/__init__.py` | CREATE | Package init for the new storage module |
| `edge_pi/storage/queue.py` | CREATE | SQLite-backed FIFO queue (`OfflineQueue` class). Stdlib only. |
| `edge_pi/config.py` | UPDATE | Add `OFFLINE_QUEUE_PATH`, `OFFLINE_MAX_AGE_SECONDS`, `OFFLINE_REPLAY_INTERVAL_S` |
| `edge_pi/.env.example` | UPDATE | Document the 3 new env keys with safety comments |
| `edge_pi/main.py` | UPDATE | Wrap `report_intake` + `report_temperature` to enqueue first; add cycle-start replay drain + refuse-to-dispense gate; bracket all changes with Phase 8 sentinels |
| `edge_pi/scripts/chaos_offline.py` | CREATE | Simulates network outages, asserts no falsified telemetry |
| `.claude/PRPs/plans/offline-queue-reliability.plan.md` | CREATE | This plan |
| `.claude/PRPs/reports/offline-queue-reliability-report.md` | CREATE | Implementation report |

### Module location decision
**`edge_pi/storage/queue.py`** chosen over `edge_pi/queue_/queue.py`:
- `storage` reads as the thing the queue *is* (a durable disk-backed log) rather than the data structure (`queue_` collides visually with stdlib `queue`).
- Future Phase 9/10 work (e.g. local credential store, model-weight checksums) naturally lands under `edge_pi/storage/` without further reshuffling.
- Consistent with existing `edge_pi/hardware/`, `edge_pi/vision/` package naming — singular noun, no trailing underscore.

## NOT Building

- **Per-event UUID dedup column on `adherence_logs`** — would require a backend migration. Phase 8 is Pi-only per the constraint. **Known limitation**: a Pi crash between POST-200 and `mark_sent` produces a duplicate row on replay. Documented; deferred.
- **Threaded replay** — adds a second sqlite3 connection + lock complexity for no measurable benefit; we drain a small batch at the *top* of each cycle, which already runs at `POLL_INTERVAL_S` cadence.
- **Backpressure / circuit-breaker on the network** — the refuse-to-dispense gate is the simple bound; we don't need more.
- **Queue compaction / VACUUM** — at one row per cycle (`POLL_INTERVAL_S=30`) the queue grows ~100 rows/hour. Operator-side `sqlite3 queue.db "DELETE FROM events WHERE posted=1 AND created_at < strftime('%s','now','-7 days');"` is acceptable hygiene.
- **WebSocket integration** — the existing `/api/logs/ws` broadcast at `backend/app/api/logs.py` already publishes when `create_log` runs. Replayed rows go through `create_log`, so WS delivery is automatic — no Pi-side change needed.
- **Backend changes of any kind** — Phase 8 keeps backend touch zero.
- **Cleanup of orphaned bench rows in queue** — bench is `BENCH_MODE=1` (gate bypassed); orchestrator zeros the seed rows; queue rows that POSTed successfully self-mark.

---

## Step-by-Step Tasks

### Task 1: Create `edge_pi/storage/__init__.py`
- **ACTION**: New empty package init.
- **IMPLEMENT**:
  ```python
  """On-Pi storage primitives. Stdlib-only (no DB drivers)."""
  ```
- **MIRROR**: Existing `edge_pi/vision/__init__.py` re-export style.
- **IMPORTS**: None.
- **GOTCHA**: Don't re-export `OfflineQueue` from here — keep imports explicit at call sites for clarity.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile storage/__init__.py
  ```

### Task 2: Create `edge_pi/storage/queue.py`
- **ACTION**: Implement the SQLite-backed FIFO queue.
- **IMPLEMENT**: see code in the file (full implementation in Task 2 of the report). Key shape:
  ```python
  class OfflineQueue:
      def __init__(self, db_path: str | Path) -> None: ...
      def enqueue(self, kind: str, payload: dict, is_stub: bool = False) -> int: ...
      def peek_batch(self, limit: int = 20) -> list[tuple[int, str, dict, bool]]: ...
      def mark_sent(self, row_ids: list[int]) -> None: ...
      def pending_count(self) -> int: ...
      def oldest_age_seconds(self) -> float | None: ...
      def close(self) -> None: ...
  ```
  Schema:
  ```sql
  CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      is_stub INTEGER NOT NULL DEFAULT 0,
      posted INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_events_unposted ON events(posted, created_at);
  ```
  Connection setup:
  ```python
  self._conn = sqlite3.connect(str(self.db_path), isolation_level=None)
  self._conn.row_factory = sqlite3.Row
  self._conn.execute("PRAGMA journal_mode=WAL")
  self._conn.execute("PRAGMA synchronous=NORMAL")
  ```
- **MIRROR**: NAMING_CONVENTION, LOGGING_PATTERN, STUB_FAIL_LOUD_PATTERN (carry-over via `is_stub` column).
- **IMPORTS**: stdlib only (`json`, `logging`, `sqlite3`, `time`, `pathlib`, `typing`).
- **GOTCHA**:
  - `isolation_level=None` makes each statement autocommit — combined with WAL + NORMAL, every `enqueue` is durable on return.
  - `check_same_thread` is default `True` — we never use a thread, but if a future contributor adds one they'll get a clear `ProgrammingError` instead of silent corruption.
  - `peek_batch` does not lock; `mark_sent` is the only mutation between peek and mark, and it's atomic.
  - `is_stub` column lets the replay loop carry forward HI-012: the queue itself does not assert; main.py is the source of truth, but the column exists for forensic auditing.
  - `enqueue` validates `kind in ("intake", "temperature")` and raises ValueError on unknown.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile storage/queue.py
  python3 -c "
  from storage.queue import OfflineQueue
  import tempfile, pathlib
  d = pathlib.Path(tempfile.mkdtemp()) / 'q.db'
  q = OfflineQueue(d)
  a = q.enqueue('intake', {'patient_id': 1, 'slot': 0, 'pill_taken': False}, is_stub=False)
  b = q.enqueue('temperature', {'value_c': 22.0}, is_stub=True)
  c = q.enqueue('intake', {'patient_id': 2, 'slot': 1, 'pill_taken': True}, is_stub=False)
  assert q.pending_count() == 3
  batch = q.peek_batch(limit=10)
  assert [r[0] for r in batch] == [a, b, c]
  assert batch[1][3] is True  # is_stub flag round-trips
  q.mark_sent([a, b])
  assert q.pending_count() == 1
  assert q.oldest_age_seconds() is not None
  q.close()
  print('queue round-trip OK')
  "
  ```

### Task 3: Add `OFFLINE_*` settings to `edge_pi/config.py`
- **ACTION**: Edit `edge_pi/config.py`. Add 3 new optional fields.
- **IMPLEMENT**:
  - Add to `_Settings` dataclass after `BENCH_LOG_PATH`:
    ```python
    OFFLINE_QUEUE_PATH: str
    OFFLINE_MAX_AGE_SECONDS: float
    OFFLINE_REPLAY_INTERVAL_S: float
    ```
  - Add to `_load()` after `bench_log_path`:
    ```python
    offline_queue_path = os.environ.get(
        "OFFLINE_QUEUE_PATH",
        str(Path.home() / ".pharmguard" / "queue.db"),
    )
    offline_max_age = float(os.environ.get("OFFLINE_MAX_AGE_SECONDS", "3600"))
    offline_replay_interval = float(os.environ.get("OFFLINE_REPLAY_INTERVAL_S", "30"))
    ```
  - Pass all 3 into the `_Settings(...)` constructor.
  - Top-of-file `from pathlib import Path` import (currently only `os` and `dataclass` are imported).
- **MIRROR**: CONFIG_PATTERN_PI.
- **IMPORTS**: `from pathlib import Path`.
- **GOTCHA**:
  - `Path.home()` resolves to `pi`'s home on the Pi (`/home/pi`); on dev mac it resolves to the dev user's home. The `.pharmguard/` parent is created lazily by `OfflineQueue.__init__`.
  - Defaults match the constraint: 1 h max age, 30 s replay interval.
  - `validate()` does NOT need to gate on these — they have safe defaults; missing env is allowed.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile config.py
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  python3 -c "from config import settings; settings.validate(); print(settings.OFFLINE_QUEUE_PATH); print(settings.OFFLINE_MAX_AGE_SECONDS); print(settings.OFFLINE_REPLAY_INTERVAL_S)"
  ```

### Task 4: Document new env keys in `edge_pi/.env.example`
- **ACTION**: Append the new keys with safety comments.
- **IMPLEMENT**: Append at the end:
  ```
  # ── Phase 8: offline queue + reliability ──
  # Local SQLite buffer for adherence + temperature events. The Pi enqueues
  # every event durably BEFORE attempting POST, then replays unposted rows on
  # each cycle. If the oldest unposted row exceeds OFFLINE_MAX_AGE_SECONDS,
  # the cycle refuses to dispense (HI-012 extension — never falsify
  # adherence on a long outage). BENCH_MODE=1 bypasses the gate so Phase 6
  # numbers stay reproducible.
  OFFLINE_QUEUE_PATH=/home/pi/.pharmguard/queue.db
  OFFLINE_MAX_AGE_SECONDS=3600
  OFFLINE_REPLAY_INTERVAL_S=30
  ```
- **MIRROR**: existing `.env.example` comment style — sentinel header + safety-first comment.
- **GOTCHA**: keep `"0"`/`"1"` truthy semantics consistent across the file (these are floats so just numeric literals).

### Task 5: Wrap `report_intake` + `report_temperature` and add the cycle-top drain + gate in `edge_pi/main.py`
- **ACTION**: Edit `edge_pi/main.py` — minimal-diff wrap, all changes bracketed by `# ── Phase 8 …` / `# ── /Phase 8 ──` sentinels so Phase 9 work merges cleanly.
- **IMPLEMENT**:
  - Add to top imports: `from storage.queue import OfflineQueue`.
  - Add a module-level singleton accessor (after `session: requests.Session | None = None`):
    ```python
    # ── Phase 8: offline queue + reliability ─────────────────────────────────
    offline_queue: OfflineQueue | None = None
    # ── /Phase 8 ─────────────────────────────────────────────────────────────
    ```
  - Replace `report_intake` body with the 2-phase commit. Keep the function name + first positional args byte-identical so call sites don't change; add keyword-only `is_stub: bool = False`.
  - Replace `report_temperature` body the same way; same `is_stub` keyword-only param.
  - Add a module-level `_replay_drain()` helper after `report_temperature`. It:
    - Calls `offline_queue.peek_batch(limit=20)`.
    - For each row, refuses to post if `is_stub=True` AND `kind=="intake"` AND `payload["pill_taken"] is True` (HI-012 defensive).
    - POSTs to `/api/logs/` for `intake` and `/api/alerts/temperature` for `temperature`.
    - Breaks the loop on first non-2xx / RequestException to avoid hammering a degraded backend.
    - Calls `mark_sent(sent_ids)` at end.
  - Inside `run()`, immediately after `session = _build_session()`:
    ```python
    # ── Phase 8: open the offline queue ──
    global offline_queue
    offline_queue = OfflineQueue(settings.OFFLINE_QUEUE_PATH)
    log.info("Offline queue: %d pending events at startup", offline_queue.pending_count())
    # ── /Phase 8 ──
    ```
  - At the **very top** of the `while True:` loop body (BEFORE the existing Phase 5 temperature block), add:
    ```python
    # ── Phase 8: replay drain + refuse-to-dispense gate ──
    _replay_drain()
    age = offline_queue.oldest_age_seconds()
    if age is not None and age > settings.OFFLINE_MAX_AGE_SECONDS and not settings.BENCH_MODE:
        log.warning(
            "Refusing dispense — oldest unposted event %.0fs old (> %.0fs); backend unreachable?",
            age, settings.OFFLINE_MAX_AGE_SECONDS,
        )
        time.sleep(settings.OFFLINE_REPLAY_INTERVAL_S)
        continue
    # ── /Phase 8 ──
    ```
  - Update the call sites to pass `is_stub=hardware_stubbed`:
    - `report_temperature(value_c)` → `report_temperature(value_c, is_stub=hardware_stubbed)`.
    - `report_intake(patient_id, slot, verified=pill_taken_actual)` → `report_intake(patient_id, slot, verified=pill_taken_actual, is_stub=hardware_stubbed)`.
- **MIRROR**: SENTINEL_COMMENT_PATTERN, LOGGING_PATTERN, CONFIG_PATTERN_PI.
- **IMPORTS**: `from storage.queue import OfflineQueue`.
- **GOTCHA**:
  - **HI-012 invariant**: `is_stub=hardware_stubbed` flows through to the queue row; replay defensive check rejects any `pill_taken=true` from stub.
  - **BENCH_MODE bypass**: the refuse-to-dispense gate is conditional on `not settings.BENCH_MODE` so the Phase 6 200-cycle bench keeps running even if a transient queue blip happens during a chaos rehearsal.
  - Phase 4 + Phase 5 + Phase 6 sentinel comments stay byte-identical — Phase 8 sentinels go *outside* them at the cycle-top, plus the helper definitions live in the module-level area between `report_temperature` and `_BENCH_FIELDS`.
  - The drain `break`s on first non-2xx / RequestException — don't keep hammering a degraded backend.
  - `_replay_drain` only POSTs; it never enqueues. The HTTP path is read-only on the queue except for `mark_sent` at the end.
  - `report_intake` and `report_temperature` keep the same name + first positional args so any other future caller doesn't break. The new `is_stub` is keyword-only with a safe default of `False`.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile main.py
  ```

### Task 6: Create `edge_pi/scripts/chaos_offline.py`
- **ACTION**: New chaos test scaffolding.
- **IMPLEMENT**: Top-level shape — runs a tight in-process loop that calls a local `report_intake` + `report_temperature` (mirrors of main.py) while monkeypatching `requests.Session.post` to simulate outages. Asserts:
  1. Every event is enqueued before the POST attempt (durability).
  2. During the outage, the queue accumulates monotonically.
  3. After the outage, replay drains the queue.
  4. No row tagged `is_stub=True` for kind='intake' with `pill_taken=true` is ever marked posted (HI-012 in the queue).

  The script does NOT import `main.py` (so it runs on dev mac without cv2/mediapipe). It inlines the 2-phase commit + drain logic.
- **MIRROR**: BENCH_SCRIPT_PATTERN, sentinel-comment style.
- **IMPORTS**: stdlib + `requests` (already in Pi `requirements.txt`) + `unittest.mock.MagicMock` (stdlib).
- **GOTCHA**:
  - Script accesses `queue._conn` for the final HI-012 audit. That's intentional: the queue API is replay-oriented; an audit needs raw SQL.
  - The script deletes the queue + WAL/SHM sidecars at start so reruns are deterministic.
  - The script always passes `is_stub=True` to `report_intake` (mirrors a stub-mode dev box) AND always passes `pill_taken=False` (mirrors what main.py forces).
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile scripts/chaos_offline.py
  python3 scripts/chaos_offline.py --cycles 50 --outage-start 10 --outage-end 30
  # Expect: Result: PASS, post-outage pending: 0
  ```

### Task 7: Local validation suite (textual regression + queue round-trip)
- **ACTION**: Static analysis + runtime checks on all changed files. Mirrors Phase 6's approach — no cv2/mediapipe needed.
- **IMPLEMENT**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi

  # 1. py_compile every changed Pi file
  python3 -m py_compile config.py main.py storage/__init__.py storage/queue.py scripts/chaos_offline.py

  # 2. Settings round-trip
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  python3 -c "from config import settings; settings.validate(); print(settings.OFFLINE_QUEUE_PATH); print(settings.OFFLINE_MAX_AGE_SECONDS); print(settings.OFFLINE_REPLAY_INTERVAL_S)"

  # 3. Queue round-trip (see Task 2 VALIDATE block)

  # 4. Textual regression on main.py — Phase 8 sentinels present, prior-phase sentinels intact
  python3 -c "
  src = open('main.py').read()
  assert '# ── Phase 8: offline queue + reliability ──' in src or '# ── Phase 8: offline queue + reliability ─' in src
  assert '# ── /Phase 8 ──' in src
  assert '# ── Phase 5: tray temperature sample ──' in src
  assert '# ── Phase 6: end-to-end bench instrumentation ─' in src
  assert '# ── /Phase 6 ──' in src
  assert 'is_stub=hardware_stubbed' in src
  assert 'OfflineQueue' in src
  assert '_replay_drain' in src
  print('main.py textual regression OK')
  "

  # 5. FSM constants — intake_monitor.py untouched
  python3 -c "
  src = open('vision/intake_monitor.py').read()
  for n in ('STEP_1_HAND','STEP_2_TILT','STEP_3_LEVEL','STEP_4_MOUTH','STEP_5_TONGUE'):
      assert n in src
  print('FSM constants intact (textual)')
  "

  # 6. Chaos script
  python3 scripts/chaos_offline.py --cycles 50 --outage-start 10 --outage-end 30
  ```
- **MIRROR**: Phase 6 validation suite.
- **GOTCHA**: dev mac lacks `cv2`/`mediapipe`/`ultralytics` — same constraint Phases 2/3/6 hit. Substituted by textual regression on `main.py` and `vision/intake_monitor.py`. Live `import main` smoke is deferred to operator on Pi.

### Task 8: Operator-attested Pi run
- **ACTION**: Operator drives the chaos test on real Pi 5 hardware to confirm SQLite+WAL works on the Pi filesystem and the queue path resolves under `/home/pi/.pharmguard/`.
- **IMPLEMENT**:
  ```bash
  cd ~/IDP_PharmGuard/edge_pi
  # 1. Confirm queue path
  python3 -c "from config import settings; print(settings.OFFLINE_QUEUE_PATH)"
  # 2. Run chaos test in /tmp (avoid touching prod queue)
  PHARMGUARD_STUB=1 \
    BACKEND_URL=http://localhost:1 \
    DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
    OFFLINE_QUEUE_PATH=/tmp/chaos_queue.db \
    python3 scripts/chaos_offline.py --cycles 50 --outage-start 10 --outage-end 30
  # 3. Live-fire with the systemd service:
  #    sudo systemctl restart pharmguard
  #    journalctl -u pharmguard -f &
  #    (operator workstation) yank network for ~2 min, watch for "row N retained for replay" log lines
  #    restore network, watch for "replay drained N/M rows"
  #    confirm no falsified pill_taken=true in adherence_logs
  ```
- **MIRROR**: Phase 4 / Phase 6 operator-run patterns.
- **GOTCHA**:
  - `OFFLINE_MAX_AGE_SECONDS=3600` — operator must wait >1 h to trigger refuse-to-dispense gate, OR set `OFFLINE_MAX_AGE_SECONDS=120` in `.env` for the test and revert after.
  - Don't run the chaos script against the production queue path — explicit `OFFLINE_QUEUE_PATH=/tmp/chaos_queue.db` keeps it sandboxed.
- **VALIDATE**: chaos script exits 0 with `Result: PASS`. Operator verifies via journalctl tail that real outage → replay path works.

---

## Testing Strategy

Repo has no test framework. Validation = py_compile + queue round-trip + textual regression + chaos-script self-test (passes on dev mac) + Pi operator attestation.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `storage/queue.py` compiles | `python3 -m py_compile storage/queue.py` | exit 0 | normal |
| Queue round-trip | enqueue 3, peek, mark 2 sent, count = 1 | `queue round-trip OK` | normal |
| Settings round-trip | `OFFLINE_*` defaults flow through `_LazySettings` | prints 3 values | normal |
| Chaos test, no outage | `--cycles 50 --outage-start 1000 --outage-end 1001` | pending == 0 throughout | sanity |
| Chaos test, mid-outage | `--cycles 50 --outage-start 10 --outage-end 30` | accumulates 10–30, drains by end | yes |
| Chaos test, full outage | `--cycles 50 --outage-start 0 --outage-end 50` | accumulates 100, never drains, FAIL printed | yes |
| Refuse-to-dispense gate | manually create queue row with `created_at = time.time() - 7200` | next cycle skips schedule fetch | yes |
| BENCH_MODE bypass | `BENCH_MODE=1` + same stale-row setup | cycle proceeds (gate bypassed) | yes |
| HI-012 in queue | enqueue `is_stub=True intake pill_taken=true`, run drain | `mark_sent` is NOT called for that row | yes (defensive) |
| Phase 4/5/6 sentinels intact | grep | all sentinels found byte-for-byte | yes |
| FSM constants intact | grep | STEP_1..5 present in `intake_monitor.py` | yes |

### Edge Cases Checklist
- [x] Empty queue — `peek_batch` returns `[]`, `oldest_age_seconds` returns `None`, `_replay_drain` is no-op.
- [x] Maximum size input — payload is JSON; Pi events are <500 bytes.
- [x] Invalid types — `enqueue` validates `kind`; corrupt JSON in `peek_batch` is logged + skipped.
- [x] Concurrent access — single thread; `check_same_thread=True` (default) traps misuse.
- [x] Network failure — entire purpose. Queue accumulates; drain breaks on first failure.
- [x] Permission denied — queue path under `~/.pharmguard/` — `mkdir(parents=True, exist_ok=True)` creates it.
- [x] Stub mode — `is_stub` flag round-trips through the row; defensive guard blocks `pill_taken=true` posts at replay.
- [x] Crash mid-POST — 2-phase commit: a crash between POST-200 and `mark_sent` produces a duplicate (documented limitation).
- [x] Crash mid-enqueue — sqlite3 autocommit + WAL = either fully durable or never existed.

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/edge_pi
python3 -m py_compile config.py main.py storage/__init__.py storage/queue.py scripts/chaos_offline.py
```
EXPECT: zero output, exit 0.

### Settings Smoke
See Task 7 step 2.

### Queue Round-Trip
See Task 2 VALIDATE block.

### Sentinel Regression Guard
See Task 7 step 4 + 5.

### Chaos Test (dev mac)
```bash
python3 scripts/chaos_offline.py --cycles 50 --outage-start 10 --outage-end 30
```
EXPECT: `Result: PASS`, `post-outage pending: 0`.

### Frontend Build
N/A — Phase 8 is Pi-only.

### Pi Operator Run
See Task 8.

### Manual Validation Checklist
- [ ] `edge_pi/storage/queue.py` exists with `OfflineQueue` class.
- [ ] `edge_pi/storage/__init__.py` exists.
- [ ] `edge_pi/config.py` exposes 3 new settings.
- [ ] `edge_pi/.env.example` documents all three keys.
- [ ] `edge_pi/main.py` wraps reporters for 2-phase commit.
- [ ] `edge_pi/main.py` cycle has Phase 8 sentinel block at top of loop.
- [ ] `edge_pi/scripts/chaos_offline.py` exits 0 on dev mac.
- [ ] FSM constants byte-identical.
- [ ] Phase 4/5/6 sentinel comments byte-identical.
- [ ] Pi operator-attested PASS.

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] `py_compile` clean across all changed Pi files.
- [ ] Queue round-trip succeeds.
- [ ] Chaos test on dev mac: `Result: PASS`, post-outage pending = 0.
- [ ] HI-012 carry-over verified.
- [ ] Phase 4/5/6 sentinels + `vision/intake_monitor.py` byte-identical to today.
- [ ] Refuse-to-dispense gate bypassed by `BENCH_MODE=1`.
- [ ] No new entries in `requirements.txt`.

## Completion Checklist
- [ ] Code follows discovered patterns (NAMING, CONFIG, STUB_FAIL_LOUD, LOGGING, BENCH_SCRIPT, SENTINEL_COMMENT).
- [ ] Backend untouched.
- [ ] Queue is durable (WAL + autocommit).
- [ ] 2-phase commit limitation documented.
- [ ] Phase 8 sentinels bracket all main.py edits.
- [ ] PRD Phase 8 row update + plan archive deferred to orchestrator.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Crash between POST-200 and `mark_sent` produces duplicate `adherence_logs` rows on replay | M | M | Documented as known limitation; fix in future via per-event UUID + backend dedup column (deferred per constraint) |
| SQLite WAL files (`-wal`, `-shm`) get corrupted after a power-cut | L | M | WAL is crash-safe by design; sqlite3 self-recovers. If corrupted: operator deletes `~/.pharmguard/queue.db*` losing only unposted rows |
| Refuse-to-dispense gate fires after a long outage that already drained | L | M | Gate reads `oldest_age_seconds` of UNPOSTED rows; once drain succeeds, the next cycle proceeds |
| BENCH_MODE bypass leaks into production | L | H | `.env.example` documents the bypass; Phase 6 already documents the cleanup step |
| `is_stub` flag added to enqueue but call site forgets to pass it | M | M | Default is `False` (safe — no falsification possible); main.py call sites updated explicitly |
| `~/.pharmguard/` directory perms wrong on first run as root vs user | L | L | `mkdir(parents=True, exist_ok=True)` + Pi runs pharmguard.service as `pi` |
| `_replay_drain` blocks the cycle on slow backend | L | L | Per-row timeout=10s; drain breaks on first non-2xx |
| Chaos script run against production queue accidentally | M | M | Default `--queue-path /tmp/chaos_queue.db`; documented in operator step Task 8 |
| Backend `create_log` returns 200 but writes nothing | L | M | Out of scope; backend hardening is its own work |

## Notes
- **Backend diff = 0**: Phase 8 is purely Pi-side. Replays POST to existing `/api/logs/` and `/api/alerts/temperature` endpoints unchanged.
- **No new dependencies**: stdlib `sqlite3` is sufficient.
- **2-phase commit (option B per constraint)**: row exists durably with `posted=0` before POST; `posted=1` only on a 2xx. Crash mid-POST → replay → duplicate. Future may add per-event UUID + backend dedup.
- **HI-012 carry-over**: every queue row records `is_stub`. Replay refuses to post stub-tagged `intake` rows with `pill_taken=true`. main.py also forces `pill_taken_actual=False` in stub mode (defense-in-depth).
- **Phase 4/5/6 sentinels**: byte-identical. Phase 8 wraps its additions in its own `# ── Phase 8 …` / `# ── /Phase 8 ──` brackets, allowing parallel Phase 9 work to merge cleanly.
- **`vision/intake_monitor.py`**: not touched. FSM constants byte-identical regression-checked.
- **PRD update + plan archive**: deferred to orchestrator per constraint.

Sources:
- [SQLite WAL mode](https://www.sqlite.org/wal.html)
- [Python sqlite3 docs](https://docs.python.org/3/library/sqlite3.html)
- [SQLite synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous)
