"""Async port of edge_pi/main.py:run().

The body of the old while-loop becomes ``run_cycle(state)`` — one pass.
``HardwareLoop._supervised_loop`` (scheduler/background.py) wraps it in
the equivalent of a while-True with exponential-backoff restart.

All synchronous I/O (GPIO, OpenCV, picamera2, dlib face_recognition,
Supabase HTTP) is wrapped in ``asyncio.to_thread`` so it does not block
the FastAPI event loop. ``time.sleep`` becomes ``await asyncio.sleep``.

The HI-012 stub guard (edge_pi/main.py:295-316) ports verbatim into
``CycleState.init`` — only ``sys.exit(1)`` becomes ``raise RuntimeError``
so FastAPI's lifespan can fail startup cleanly.

The 2-phase commit from edge_pi/main.py:108-126 (enqueue -> POST -> mark)
becomes (enqueue -> Supabase INSERT -> mark). Same defensive HI-012
replay guard at edge_pi/main.py:184-196 ports verbatim.
"""

from __future__ import annotations

import asyncio
import csv
import logging
import time
from pathlib import Path
from typing import Any

from config import settings
from db.base import get_supabase
from hardware.drawer_lock import DrawerLock
from hardware.ejector import Ejector
from hardware.magazine import Magazine
from storage.queue import OfflineQueue
from vision import (
    CameraSource,
    IntakeMonitor,
    PillVerifier,
    open_camera,
)

log = logging.getLogger(__name__)


_BENCH_FIELDS = (
    "cycle", "patient_id", "slot",
    "t_schedule_ms", "t_auth_ms", "t_rotate_ms", "t_eject_ms",
    "t_pillid_ms", "t_drawer_ms",
    "t_log_ms", "t_total_ms",
    "pill_taken",
)

_REPLAY_BATCH_LIMIT = 20


class CycleState:
    """Holds per-process cycle resources. Built once by HardwareLoop.start.

    All hardware/camera/queue handles live here, not at module level, so
    HardwareLoop.stop() can deterministically clean up by walking attributes.
    """

    def __init__(self) -> None:
        self.magazine: Magazine | None = None
        self.ejector: Ejector | None = None
        self.drawer_lock: DrawerLock | None = None
        self.cam_a: CameraSource | None = None
        self.cam_b: CameraSource | None = None
        self.verifier: PillVerifier | None = None
        self.monitor: IntakeMonitor | None = None
        self.queue: OfflineQueue | None = None
        self.bench_writer: csv.DictWriter | None = None
        self._bench_fh = None  # underlying file handle for flush
        self.hardware_stubbed: bool = False
        self.cycle_n: int = 0
        self.last_cycle_summary: dict[str, Any] | None = None  # exposed via /api/device/status
        # Shared with /api/device/* manual endpoints. Set by HardwareLoop
        # before run_cycle is dispatched. None during init / in tests.
        self.hardware_lock: asyncio.Lock | None = None

    async def init(self) -> None:
        """Build all hardware resources. Raises RuntimeError on HI-012 violation.

        Called from HardwareLoop.start, which is called from main.py:lifespan.
        Any RuntimeError raised here aborts FastAPI startup cleanly.
        """
        # Wrap blocking GPIO init in to_thread so we don't block the loop.
        self.magazine = await asyncio.to_thread(Magazine)
        self.ejector = await asyncio.to_thread(Ejector)
        self.drawer_lock = await asyncio.to_thread(DrawerLock)

        # HI-012: refuse to run as if hardware were real when it isn't.
        # Mirror of edge_pi/main.py:295-316 — sys.exit(1) becomes RuntimeError.
        self.hardware_stubbed = (
            self.magazine.is_stub
            or self.ejector.is_stub
            or self.drawer_lock.is_stub
        )
        if self.hardware_stubbed:
            if not settings.pharmguard_stub:
                raise RuntimeError(
                    "Hardware initialization degraded "
                    f"(magazine.is_stub={self.magazine.is_stub}, "
                    f"ejector.is_stub={self.ejector.is_stub}, "
                    f"drawer_lock.is_stub={self.drawer_lock.is_stub}) "
                    "but PHARMGUARD_STUB is not set. "
                    "Refusing to run — telemetry would be falsified."
                )
            log.warning(
                "STUB MODE: hardware not real — pill_taken will always be reported "
                "False. DO NOT use this build in production."
            )

        # Open dual cameras (only when hardware is real). Same fail-loud rule.
        if not self.hardware_stubbed:
            try:
                self.cam_a = await asyncio.to_thread(open_camera, 0)  # tray top-down (BGR for YOLO)
                self.cam_b = await asyncio.to_thread(  # patient-facing (RGB for MediaPipe)
                    open_camera, 1, output_format="rgb"
                )
            except Exception:
                log.exception("Camera initialization failed")
                if not settings.pharmguard_stub:
                    raise RuntimeError("Camera init failed and stub disallowed")
                log.warning(
                    "STUB MODE: camera unavailable — vision verifies will be skipped"
                )

        self.verifier = PillVerifier(camera=self.cam_a)
        self.monitor = IntakeMonitor(camera=self.cam_b)

        # Phase 8: open the offline queue.
        self.queue = await asyncio.to_thread(OfflineQueue, settings.offline_queue_path)
        log.info(
            "Offline queue: %d pending events at startup",
            self.queue.pending_count(),
        )

        # Phase 6: bench-mode safety + writer.
        if settings.bench_mode and self.hardware_stubbed:
            raise RuntimeError(
                "BENCH_MODE=1 but hardware is stubbed — bench numbers would be invalid."
            )
        self.bench_writer, self._bench_fh = _open_bench_writer()
        if self.bench_writer is not None:
            log.warning(
                "BENCH_MODE=1 — writing per-cycle metrics to %s. "
                "Face ID + swallow are MOCKED. Restart with BENCH_MODE=0 for production.",
                settings.bench_log_path,
            )

        log.info("CycleState ready — hardware_stubbed=%s", self.hardware_stubbed)

    async def cleanup(self) -> None:
        """Best-effort resource release. Idempotent."""
        for h in (self.magazine, self.ejector, self.drawer_lock):
            if h is not None:
                try:
                    await asyncio.to_thread(h.cleanup)
                except Exception:
                    log.exception("hardware cleanup failed (continuing)")
        for cam in (self.cam_a, self.cam_b):
            if cam is not None:
                try:
                    await asyncio.to_thread(cam.close)
                except Exception:
                    log.exception("camera close failed (continuing)")
        if self._bench_fh is not None:
            try:
                self._bench_fh.close()
            except Exception:
                pass


def _open_bench_writer():
    """Open the bench_log_path CSV for append. Returns (writer, fh) or (None, None)."""
    if not settings.bench_mode:
        return None, None
    path = Path(settings.bench_log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    fh = path.open("a", newline="")
    w = csv.DictWriter(fh, fieldnames=_BENCH_FIELDS)
    if new:
        w.writeheader()
    return w, fh


async def _next_dispense() -> dict | None:
    """Direct DB query — replaces session.get('/api/inventory/next-dispense').

    Mirrors backend/api/inventory.py:next_dispense body.
    """
    sb = get_supabase()
    def _query():
        q = (
            sb.table("medications")
            .select("*")
            .gt("quantity", 0)
            .not_.is_("patient_id", "null")
        )
        if settings.dispenser_id:
            q = q.eq("dispenser_id", settings.dispenser_id)
        return q.limit(1).execute()
    result = await asyncio.to_thread(_query)
    if not result.data:
        return None
    return _med_row_to_task(result.data[0])


def _med_row_to_task(med: dict) -> dict:
    return {
        "patient_id": med["patient_id"],
        "slot": med["slot"],
        "medication": med["name"],
        "expiry_date": med.get("expiry_date"),
        "pills_per_dose": med.get("pills_per_dose", 1),
        "dispenser_id": med.get("dispenser_id"),
    }


async def next_scheduled_dispense() -> dict | None:
    """Return the med whose `schedule_at` matches the current minute, if any.

    Public so background.py can call it on the manual-mode tick. Returns
    a task dict shaped like _next_dispense's, or None when no match.
    Comparison is HH:MM (seconds dropped) so we match a one-minute window.
    """
    sb = get_supabase()
    def _query():
        q = (
            sb.table("medications")
            .select("*")
            .gt("quantity", 0)
            .not_.is_("patient_id", "null")
            .not_.is_("schedule_at", "null")
        )
        if settings.dispenser_id:
            q = q.eq("dispenser_id", settings.dispenser_id)
        return q.execute()
    result = await asyncio.to_thread(_query)
    rows = result.data or []
    if not rows:
        return None
    from datetime import datetime
    now_hhmm = datetime.now().strftime("%H:%M")
    for med in rows:
        sched = str(med.get("schedule_at") or "")
        if sched[:5] == now_hhmm:
            return _med_row_to_task(med)
    return None


async def _report_intake_direct(
    state: CycleState,
    patient_id: int,
    slot: int,
    *,
    verified: bool,
    confidence: float | None = None,
    is_stub: bool = False,
) -> None:
    """Direct DB write — replaces edge_pi/main.py:80-126 (HTTP self-call).

    Same 2-phase commit shape: enqueue -> INSERT -> mark_sent. Mirrors
    backend/api/logs.py:create_log body for the insert + quantity-decrement.
    """
    assert state.queue is not None
    payload: dict = {
        "patient_id": patient_id,
        "slot": slot,
        "pill_taken": verified,
    }
    if settings.dispenser_id:
        payload["dispenser_id"] = settings.dispenser_id
    if confidence is not None:
        payload["confidence_score"] = float(confidence)
    row_id = await asyncio.to_thread(
        state.queue.enqueue, "intake", payload, is_stub=is_stub
    )
    sb = get_supabase()
    try:
        await asyncio.to_thread(
            lambda: sb.table("adherence_logs").insert(payload).execute()
        )
        # Decrement medication quantity (mirrors backend/api/logs.py:44-49).
        med_q = await asyncio.to_thread(
            lambda: sb.table("medications").select("quantity").eq("slot", slot).execute()
        )
        if med_q.data and med_q.data[0]["quantity"] > 0:
            new_q = med_q.data[0]["quantity"] - 1
            await asyncio.to_thread(
                lambda: sb.table("medications").update({"quantity": new_q}).eq("slot", slot).execute()
            )
        await asyncio.to_thread(state.queue.mark_sent, [row_id])
    except Exception as exc:
        log.warning("intake insert failed: %s; row %d retained for replay", exc, row_id)


async def _replay_drain(state: CycleState) -> None:
    """Replay up to _REPLAY_BATCH_LIMIT unposted rows. HI-012 defensive guard."""
    assert state.queue is not None
    batch = state.queue.peek_batch(limit=_REPLAY_BATCH_LIMIT)
    if not batch:
        return
    sent_ids: list[int] = []
    sb = get_supabase()
    for row_id, kind, payload, is_stub in batch:
        # HI-012 defensive guard — never post a stub-mode pill_taken=true.
        if (
            is_stub
            and kind == "intake"
            and payload.get("pill_taken") is True
        ):
            log.error(
                "queue row %d: stub-mode intake with pill_taken=true — "
                "refusing to post (HI-012)",
                row_id,
            )
            continue
        try:
            if kind == "intake":
                await asyncio.to_thread(
                    lambda p=payload: sb.table("adherence_logs").insert(p).execute()
                )
            else:
                log.error("queue row %d: unknown kind %r", row_id, kind)
                continue
            sent_ids.append(row_id)
        except Exception as exc:
            log.warning("replay row %d failed: %s; will retry", row_id, exc)
            break  # backend looks unhealthy; stop draining this cycle
    if sent_ids:
        await asyncio.to_thread(state.queue.mark_sent, sent_ids)
        log.info("replay drained %d/%d rows", len(sent_ids), len(batch))


async def run_cycle(state: CycleState, task: dict | None = None) -> None:
    """One pass of the dispense loop.

    Mirror of the body of edge_pi/main.py:run() inside its while True.
    Conversions: time.sleep -> asyncio.sleep, blocking I/O -> to_thread.
    Self-HTTP calls -> direct DB writes via the helpers above.

    `task` may be pre-fetched by the caller (e.g. background.py passes
    a scheduled-dispense row when the daily HH:MM matches). When None,
    we fall back to _next_dispense() which picks the first quantity>0 med.
    """
    await _replay_drain(state)
    age = state.queue.oldest_age_seconds()
    if (
        age is not None
        and age > settings.offline_max_age_seconds
        and not settings.bench_mode
    ):
        log.warning(
            "Refusing dispense — oldest unposted event %.0fs old (> %.0fs)",
            age, settings.offline_max_age_seconds,
        )
        return

    t0 = time.perf_counter()
    if task is None:
        task = await _next_dispense()
    t_schedule = time.perf_counter()
    if task is None:
        # No pending dispense — cycle no-ops. Caller waits POLL_INTERVAL_S.
        return

    patient_id = task["patient_id"]
    slot = task["slot"]
    log.info("Dispensing slot %d for patient %d", slot, patient_id)

    # Right-patient gate removed — schedule decides who gets the dispense
    # (single-patient-per-Pi model). t_auth is kept at the schedule time
    # so the bench CSV schema (`t_auth_ms` column) stays stable.
    t_auth = t_schedule

    # Magazine + ejector. Serialized with /api/device/* manual ops via
    # the shared hardware_lock (set by HardwareLoop before run_cycle).
    if state.hardware_lock is not None:
        async with state.hardware_lock:
            await asyncio.to_thread(state.magazine.rotate_to, slot)
            t_rotate = time.perf_counter()
            await asyncio.to_thread(state.ejector.push)
            t_eject = time.perf_counter()
    else:
        await asyncio.to_thread(state.magazine.rotate_to, slot)
        t_rotate = time.perf_counter()
        await asyncio.to_thread(state.ejector.push)
        t_eject = time.perf_counter()

    # Pill-ID + drawer-lock (single-chute design — no diverter).
    # Fail-safe: if pill-ID rejects, drawer stays LOCKED. Pill sits in
    # the chute for the operator to remove. Adherence log records
    # pill_taken=false. Patient never gets a wrong-pill delivery.
    if state.hardware_stubbed:
        pill_taken_actual = False
        pill_conf: float | None = None
        t_pillid = t_drawer = t_eject
        log.info(
            "Stub mode: skipping vision verify, drawer_lock, swallow watch"
        )
    else:
        # confirm_tray_empty(timeout_s=5.0, *, return_confidence=False).
        # Pass return_confidence as kwarg via functools.partial so it's
        # actually keyword (was being passed as positional `timeout_s`,
        # which set timeout=1s AND made the function return a bare bool).
        import functools
        pill_id_pass, pill_conf = await asyncio.to_thread(
            functools.partial(state.verifier.confirm_tray_empty, return_confidence=True)
        )
        t_pillid = time.perf_counter()
        if pill_id_pass:
            if state.hardware_lock is not None:
                async with state.hardware_lock:
                    await asyncio.to_thread(state.drawer_lock.hold_unlocked)
            else:
                await asyncio.to_thread(state.drawer_lock.hold_unlocked)
            t_drawer = time.perf_counter()
            if settings.bench_mode:
                # Bench skips intake verification — keep historic behavior
                # so accuracy runs aren't blocked on a missing face/bottle.
                pill_taken_actual = True
            else:
                # Layer-2 hard gate: watch_for_swallow returns True only when
                # MediaPipe FSM completed AND (Layer-2 disabled OR at least
                # one required label was seen during the window). Anything
                # else lands as pill_taken=False and the cycle reports it.
                pill_taken_actual = await asyncio.to_thread(
                    state.monitor.watch_for_swallow, 60
                )
                if not pill_taken_actual:
                    terminal = state.monitor.get_state().get("result")
                    log.warning(
                        "Intake gate failed (result=%s) — pill_taken stays False",
                        terminal,
                    )
        else:
            log.warning(
                "Pill-ID verification failed (slot=%d, conf=%s); drawer stays "
                "LOCKED. Operator must remove the rejected pill from the chute.",
                slot, pill_conf,
            )
            t_drawer = t_pillid
            pill_taken_actual = False

    # Adherence log (direct DB + queue).
    await _report_intake_direct(
        state,
        patient_id,
        slot,
        verified=pill_taken_actual,
        confidence=pill_conf,
        is_stub=state.hardware_stubbed,
    )
    t_log = time.perf_counter()
    log.info("Cycle complete — pill_taken=%s", pill_taken_actual)

    # Phase 6: per-cycle metrics row.
    if state.bench_writer is not None:
        state.cycle_n += 1
        row = {
            "cycle": state.cycle_n,
            "patient_id": patient_id,
            "slot": slot,
            "t_schedule_ms": (t_schedule - t0) * 1000.0,
            "t_auth_ms": (t_auth - t_schedule) * 1000.0,
            "t_rotate_ms": (t_rotate - t_auth) * 1000.0,
            "t_eject_ms": (t_eject - t_rotate) * 1000.0,
            "t_pillid_ms": (t_pillid - t_eject) * 1000.0,
            "t_drawer_ms": (t_drawer - t_pillid) * 1000.0,
            "t_log_ms": (t_log - t_drawer) * 1000.0,
            "t_total_ms": (t_log - t0) * 1000.0,
            "pill_taken": pill_taken_actual,
        }
        state.bench_writer.writerow(row)
        if state._bench_fh is not None:
            state._bench_fh.flush()

    # Status snapshot for /api/device/status.
    state.last_cycle_summary = {
        "cycle": state.cycle_n,
        "pill_taken": pill_taken_actual,
        "t_total_ms": (t_log - t0) * 1000.0,
    }
