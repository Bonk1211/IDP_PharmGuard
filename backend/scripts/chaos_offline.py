#!/usr/bin/env python3
"""Chaos test: offline-queue durability under simulated network outages.

Phase 8 (offline queue + reliability). Runs N cycles in-process,
monkeypatching ``requests.Session.post`` to raise ConnectionError for a
configurable window.

Asserts:
  1. Every event is enqueued before the POST attempt (durability).
  2. During the outage, the queue accumulates monotonically.
  3. After the outage, replay drains the queue.
  4. No row tagged ``is_stub=True`` for kind='intake' with
     ``pill_taken=true`` is ever marked posted (HI-012 in the queue).

This script does NOT import ``main.py`` -- it inlines the 2-phase
commit + drain logic so it runs on a dev mac without cv2/mediapipe.

Operator usage on the Pi (avoid clobbering the production queue):
    PHARMGUARD_STUB=1 \\
        BACKEND_URL=http://localhost:1 \\
        DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \\
        OFFLINE_QUEUE_PATH=/tmp/chaos_queue.db \\
        python3 scripts/chaos_offline.py --cycles 50 \\
            --outage-start 10 --outage-end 30
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from storage.queue import OfflineQueue  # noqa: E402

log = logging.getLogger(__name__)


class _FakeResponse:
    """Minimal stand-in for requests.Response (status_code only)."""

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.text = "OK" if 200 <= status_code < 300 else "FAIL"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycles", type=int, default=50)
    ap.add_argument(
        "--outage-start",
        type=int,
        default=10,
        help="cycle at which network outage begins",
    )
    ap.add_argument(
        "--outage-end",
        type=int,
        default=30,
        help="cycle at which network outage ends (exclusive)",
    )
    ap.add_argument("--queue-path", default="/tmp/chaos_queue.db")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    qpath = Path(args.queue_path)
    # Drop any existing queue + WAL/SHM sidecars so reruns are deterministic.
    for p in (
        qpath,
        qpath.with_suffix(qpath.suffix + "-wal"),
        qpath.with_suffix(qpath.suffix + "-shm"),
    ):
        if p.exists():
            p.unlink()

    queue = OfflineQueue(qpath)

    # Build a fake session: post() returns 200 normally, raises during outage.
    session = MagicMock(spec=requests.Session)
    cycle: dict[str, int] = {"n": 0}

    def fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        if args.outage_start <= cycle["n"] < args.outage_end:
            raise requests.ConnectionError("simulated outage")
        return _FakeResponse(200)

    session.post.side_effect = fake_post

    # Inline 2-phase commit driver (mirror of main.py::report_intake).
    def report_intake(payload: dict, is_stub: bool) -> None:
        rid = queue.enqueue("intake", payload, is_stub=is_stub)
        try:
            r = session.post("http://x/api/logs/", json=payload, timeout=10)
            if 200 <= r.status_code < 300:
                queue.mark_sent([rid])
        except requests.RequestException:
            pass  # row stays in queue -- exactly what we want to assert

    def report_temperature(payload: dict, is_stub: bool) -> None:
        rid = queue.enqueue("temperature", payload, is_stub=is_stub)
        try:
            r = session.post(
                "http://x/api/alerts/temperature", json=payload, timeout=5
            )
            if 200 <= r.status_code < 300:
                queue.mark_sent([rid])
        except requests.RequestException:
            pass

    def replay_drain() -> None:
        batch = queue.peek_batch(limit=20)
        if not batch:
            return
        sent: list[int] = []
        for row_id, kind, payload, is_stub in batch:
            # HI-012 defensive guard.
            if (
                is_stub
                and kind == "intake"
                and payload.get("pill_taken") is True
            ):
                continue
            try:
                url = (
                    "http://x/api/logs/"
                    if kind == "intake"
                    else "http://x/api/alerts/temperature"
                )
                r = session.post(url, json=payload, timeout=10)
                if 200 <= r.status_code < 300:
                    sent.append(row_id)
                else:
                    break
            except requests.RequestException:
                break
        if sent:
            queue.mark_sent(sent)

    # Run cycles, alternating intake (pill_taken=false in stub) + temperature.
    pending_during_outage: list[int] = []
    pending_after: list[int] = []
    for n in range(args.cycles):
        cycle["n"] = n
        replay_drain()
        # In stub mode, pill_taken=False is forced (mirrors main.py HI-012).
        report_intake(
            {"patient_id": 1, "slot": n % 10, "pill_taken": False},
            is_stub=True,
        )
        report_temperature({"value_c": 22.0}, is_stub=True)
        pc = queue.pending_count()
        if args.outage_start <= n < args.outage_end:
            pending_during_outage.append(pc)
        elif n >= args.outage_end:
            pending_after.append(pc)

    # Final drain passes -- give replay enough cycles to fully drain the
    # backlog (each call drains 20 rows; outage of 20 cycles produces 40
    # rows so 2 passes is enough but 10 is safe).
    for _ in range(10):
        replay_drain()
        if queue.pending_count() == 0:
            break

    # ── Assertions ──
    ok = True

    # (1) Queue accumulated monotonically during the outage.
    monotonic = all(
        pending_during_outage[i] >= pending_during_outage[i - 1]
        for i in range(1, len(pending_during_outage))
    )
    log.info("outage-window pending counts: %s", pending_during_outage)
    if not monotonic:
        log.error("FAIL: queue did not accumulate monotonically during outage")
        ok = False
    if pending_during_outage and pending_during_outage[-1] == 0:
        log.error("FAIL: queue did not retain any rows during outage")
        ok = False

    # (2) Queue drained after the outage (final pending == 0).
    final = queue.pending_count()
    log.info("post-outage final pending: %d", final)
    if final != 0:
        log.error(
            "FAIL: queue did not drain after recovery; %d rows left", final
        )
        ok = False

    # (3) HI-012 in the queue: no stub-mode intake row with
    # pill_taken=true was ever posted. The script never enqueues that
    # combo, but the check guards against future regressions.
    cur = queue._conn.execute(
        "SELECT id, kind, payload_json, is_stub, posted FROM events"
    )
    bad: list[int] = []
    for r in cur.fetchall():
        if r["is_stub"] == 1 and r["kind"] == "intake" and r["posted"] == 1:
            payload = json.loads(r["payload_json"])
            if payload.get("pill_taken") is True:
                bad.append(int(r["id"]))
    if bad:
        log.error(
            "FAIL: HI-012 violation -- stub intake pill_taken=true was "
            "posted: %s",
            bad,
        )
        ok = False
    else:
        log.info("HI-012 check: no falsified telemetry posted")

    print(f"\nResult: {'PASS' if ok else 'FAIL'}")
    print(f"  cycles run:           {args.cycles}")
    print(
        f"  outage window:        cycles "
        f"[{args.outage_start}, {args.outage_end})"
    )
    peak = max(pending_during_outage) if pending_during_outage else 0
    print(f"  peak pending:         {peak}")
    print(f"  post-outage pending:  {final}")
    queue.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
