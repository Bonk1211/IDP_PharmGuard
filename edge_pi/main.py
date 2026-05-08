"""
PharmGuard Edge — Raspberry Pi main loop.

Cycle:
  1. Authenticate patient via face recognition
  2. Rotate magazine to the scheduled slot
  3. Eject the pill
  4. Verify pill was taken (vision)
  5. Report telemetry to backend
"""

import csv
import logging
import sys
import time
from pathlib import Path

import requests

from config import settings
from hardware.diverter import Diverter
from hardware.drawer_lock import DrawerLock
from hardware.ejector import Ejector
from hardware.magazine import Magazine
from hardware.temp_sensor import TempSensor
from vision import CameraSource, IntakeMonitor, LivenessDetector, PillVerifier, open_camera

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


# Module-level session — reused across all backend calls so we get connection
# pooling and a single place to set the auth header. Built lazily in `run()`
# after `settings.validate()` so import-time has no side effects.
session: requests.Session | None = None

# ── Phase 8: offline queue + reliability ─────────────────────────────────
# Single durable buffer for both intake + temperature events. Initialised
# in run() once settings have been validated, just like `session`. The
# replay loop is in-cycle (top of `while True`), not a thread — keeps the
# sqlite3 connection single-threaded and avoids a second connection +
# lock for no measurable benefit at our event rate.
offline_queue: OfflineQueue | None = None
# ── /Phase 8 ─────────────────────────────────────────────────────────────


def _build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {settings.DEVICE_TOKEN}"})
    return s


def authenticate_patient(detector: LivenessDetector) -> dict | None:
    """Capture a live (post-blink) face crop, send to backend, return patient or None."""
    assert session is not None, "session not initialized; call run() first"
    crop_bytes = detector.capture_live_face(timeout_s=15.0)
    if crop_bytes is None:
        log.warning("No live face captured")
        return None
    resp = session.post(
        f"{settings.BACKEND_URL}/api/auth/verify-face",
        files={"file": ("face.jpg", crop_bytes, "image/jpeg")},
        timeout=10,
    )
    if resp.status_code == 200:
        return resp.json()
    log.warning("Authentication failed (%d): %s", resp.status_code, resp.text)
    return None


def report_intake(
    patient_id: int, slot: int, verified: bool, *, is_stub: bool = False
) -> None:
    """POST an adherence log to the backend, durably queueing first.

    Phase 8: enqueue first → POST → mark posted on 2xx. On any failure,
    the row stays in the queue and the next-cycle drain retries it.
    HI-012: ``is_stub`` flag round-trips into the queue row so the
    replay loop can refuse to post falsified telemetry.
    """
    assert session is not None, "session not initialized; call run() first"
    assert offline_queue is not None, "offline_queue not initialized"
    payload: dict = {
        "patient_id": patient_id,
        "slot": slot,
        "pill_taken": verified,
    }
    if settings.DISPENSER_ID:
        payload["dispenser_id"] = settings.DISPENSER_ID
    row_id = offline_queue.enqueue("intake", payload, is_stub=is_stub)
    try:
        resp = session.post(
            f"{settings.BACKEND_URL}/api/logs/",
            json=payload,
            timeout=10,
        )
        if 200 <= resp.status_code < 300:
            offline_queue.mark_sent([row_id])
        else:
            log.warning(
                "intake post non-2xx (%d); row %d retained for replay",
                resp.status_code,
                row_id,
            )
    except requests.RequestException as exc:
        log.warning(
            "intake post failed: %s; row %d retained for replay", exc, row_id
        )


def report_temperature(value_c: float, *, is_stub: bool = False) -> None:
    """POST a temperature sample to the backend, durably queueing first.

    Phase 8: same 2-phase commit as ``report_intake``. ``is_stub``
    propagates through the queue row for forensic auditing; the backend
    treats stub temperatures as below-threshold so no alerts are forged.
    """
    assert session is not None, "session not initialized; call run() first"
    assert offline_queue is not None, "offline_queue not initialized"
    payload: dict = {"value_c": value_c}
    if settings.DISPENSER_ID:
        payload["dispenser_id"] = settings.DISPENSER_ID
    row_id = offline_queue.enqueue("temperature", payload, is_stub=is_stub)
    try:
        resp = session.post(
            f"{settings.BACKEND_URL}/api/alerts/temperature",
            json=payload,
            timeout=5,
        )
        if 200 <= resp.status_code < 300:
            offline_queue.mark_sent([row_id])
        else:
            log.warning(
                "temperature post non-2xx (%d); row %d retained for replay",
                resp.status_code,
                row_id,
            )
    except requests.RequestException as exc:
        log.warning(
            "temperature post failed: %s; row %d retained for replay",
            exc,
            row_id,
        )


# ── Phase 8: replay drain ────────────────────────────────────────────────
_REPLAY_BATCH_LIMIT = 20


def _replay_drain() -> None:
    """Replay up to ``_REPLAY_BATCH_LIMIT`` unposted rows.

    Called at the top of each cycle. Stops on the first non-2xx /
    RequestException to avoid hammering a degraded backend — the next
    cycle picks up where this one left off.

    HI-012 in the queue: rows tagged ``is_stub=True`` for kind=='intake'
    with ``pill_taken=true`` are NEVER posted. main.py forces False in
    stub mode but this guard is defensive against future regressions.
    """
    assert session is not None and offline_queue is not None
    batch = offline_queue.peek_batch(limit=_REPLAY_BATCH_LIMIT)
    if not batch:
        return
    sent_ids: list[int] = []
    for row_id, kind, payload, is_stub in batch:
        # HI-012 defensive guard.
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
        if kind == "intake":
            url = f"{settings.BACKEND_URL}/api/logs/"
        elif kind == "temperature":
            url = f"{settings.BACKEND_URL}/api/alerts/temperature"
        else:
            log.error(
                "queue row %d: unknown kind %r — leaving in queue",
                row_id,
                kind,
            )
            continue
        try:
            resp = session.post(url, json=payload, timeout=10)
            if 200 <= resp.status_code < 300:
                sent_ids.append(row_id)
            else:
                log.warning(
                    "replay row %d non-2xx (%d); will retry",
                    row_id,
                    resp.status_code,
                )
                break  # backend looks unhealthy; stop draining this cycle
        except requests.RequestException as exc:
            log.warning("replay row %d failed: %s; will retry", row_id, exc)
            break
    if sent_ids:
        offline_queue.mark_sent(sent_ids)
        log.info("replay drained %d/%d rows", len(sent_ids), len(batch))
# ── /Phase 8 ─────────────────────────────────────────────────────────────


# ── Phase 6: end-to-end bench instrumentation ─────────────────────────────
_BENCH_FIELDS = (
    "cycle", "patient_id", "slot",
    "t_schedule_ms", "t_auth_ms", "t_rotate_ms", "t_eject_ms",
    "t_pillid_ms", "t_diverter_ms", "t_drawer_ms",
    "t_log_ms", "t_total_ms",
    "pill_taken",
)


def _open_bench_writer():
    """Open the BENCH_LOG_PATH CSV for append. Returns None when bench off."""
    if not settings.BENCH_MODE:
        return None
    path = Path(settings.BENCH_LOG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    f = path.open("a", newline="")
    w = csv.DictWriter(f, fieldnames=_BENCH_FIELDS)
    if new:
        w.writeheader()
    w._fh = f  # stash for flush() per cycle
    return w
# ── /Phase 6 ──────────────────────────────────────────────────────────────


def run() -> None:
    global session, offline_queue

    # Fail fast on misconfig before touching hardware.
    try:
        settings.validate()
    except RuntimeError as exc:
        log.error("Config validation failed: %s", exc)
        sys.exit(2)

    session = _build_session()

    # ── Phase 8: open the offline queue ──
    # Durable buffer for intake + temperature events. Created lazily so
    # `python3 -m py_compile main.py` and stub-mode imports stay clean.
    offline_queue = OfflineQueue(settings.OFFLINE_QUEUE_PATH)
    log.info(
        "Offline queue: %d pending events at startup",
        offline_queue.pending_count(),
    )
    # ── /Phase 8 ──

    # Reachability probe — warn but don't abort (Pi must boot offline-tolerant).
    # Backend WebSocket future-auth: append `?token=<DEVICE_TOKEN>` query param.
    try:
        health = session.get(f"{settings.BACKEND_URL}/health", timeout=5)
        if health.status_code != 200:
            log.warning(
                "Backend health probe returned %d at %s",
                health.status_code,
                settings.BACKEND_URL,
            )
    except requests.RequestException as exc:
        log.warning("Backend unreachable at startup (%s): %s", settings.BACKEND_URL, exc)

    magazine = Magazine()
    ejector = Ejector()
    diverter = Diverter()
    drawer_lock = DrawerLock()
    temp_sensor = TempSensor()

    # HI-012: Refuse to run as if hardware were real when it isn't.
    hardware_stubbed = (
        magazine.is_stub
        or ejector.is_stub
        or diverter.is_stub
        or drawer_lock.is_stub
        or temp_sensor.is_stub
    )
    if hardware_stubbed:
        if not settings.STUB_MODE:
            log.error(
                "Hardware initialization degraded (magazine.is_stub=%s, "
                "ejector.is_stub=%s, diverter.is_stub=%s, drawer_lock.is_stub=%s, "
                "temp_sensor.is_stub=%s) but PHARMGUARD_STUB is not set. "
                "Refusing to run — telemetry would be falsified.",
                magazine.is_stub,
                ejector.is_stub,
                diverter.is_stub,
                drawer_lock.is_stub,
                temp_sensor.is_stub,
            )
            sys.exit(1)
        log.warning(
            "STUB MODE: hardware not real — pill_taken will always be reported "
            "False. DO NOT use this build in production."
        )

    # Open dual cameras (only when hardware is real). Same fail-loud rule as
    # HI-012: if a camera fails to open and we are NOT in stub mode, refuse to
    # run rather than silently degrade the vision pipeline.
    cam_a: CameraSource | None = None
    cam_b: CameraSource | None = None
    if not hardware_stubbed:
        try:
            cam_a = open_camera(0)  # tray top-down (pill ID)
            cam_b = open_camera(1)  # patient-facing (swallow FSM)
        except Exception:
            log.exception("Camera initialization failed")
            if not settings.STUB_MODE:
                sys.exit(3)
            log.warning(
                "STUB MODE: camera unavailable — vision verifies will be skipped"
            )

    verifier = PillVerifier(camera=cam_a)
    monitor = IntakeMonitor(camera=cam_b)
    liveness = LivenessDetector(camera=cam_b)

    # ── Phase 6: bench-mode safety + writer ────────────────────────────────
    # BENCH_MODE refuses to run on stubbed hardware — falsified telemetry
    # would invalidate the bench numbers (HI-012 extension).
    if settings.BENCH_MODE and hardware_stubbed:
        log.error(
            "BENCH_MODE=1 but hardware is stubbed — bench numbers would be invalid."
        )
        sys.exit(4)

    bench_writer = _open_bench_writer()
    cycle_n = 0
    if bench_writer is not None:
        log.warning(
            "BENCH_MODE=1 — writing per-cycle metrics to %s. "
            "Face ID + swallow are MOCKED. Restart with BENCH_MODE=0 for production.",
            settings.BENCH_LOG_PATH,
        )
    # ── /Phase 6 ──────────────────────────────────────────────────────────

    log.info("PharmGuard Edge started — waiting for schedule triggers")

    while True:
        # ── Phase 8: replay drain + refuse-to-dispense gate ──────────────
        # Replay before doing anything else so a brief outage doesn't
        # accumulate beyond one cycle. The refuse gate reads the oldest
        # UNPOSTED row's age — once drain succeeds, the next cycle
        # proceeds. BENCH_MODE bypasses so Phase 6 numbers stay
        # reproducible even if a queue blip happens during a chaos
        # rehearsal.
        _replay_drain()
        age = offline_queue.oldest_age_seconds()
        if (
            age is not None
            and age > settings.OFFLINE_MAX_AGE_SECONDS
            and not settings.BENCH_MODE
        ):
            log.warning(
                "Refusing dispense — oldest unposted event %.0fs old "
                "(> %.0fs); backend unreachable?",
                age,
                settings.OFFLINE_MAX_AGE_SECONDS,
            )
            time.sleep(settings.OFFLINE_REPLAY_INTERVAL_S)
            continue
        # ── /Phase 8 ──────────────────────────────────────────────────────

        # ── Phase 5: tray temperature sample ──────────────────────────────
        # One sample per loop tick; backend decides if it crosses threshold
        # and inserts an `over_temperature` alert. Stub mode returns a safe
        # 22 C constant so HI-012 invariant holds.
        try:
            value_c = temp_sensor.read_celsius()
            if value_c is not None:
                # Phase 8: tag stub origin so replay can audit/skip.
                report_temperature(value_c, is_stub=hardware_stubbed)
        except Exception:
            log.exception("temperature sample failed")
        # ── /Phase 5 ──────────────────────────────────────────────────────

        # TODO: Replace with real schedule lookup from backend
        # For now, a simple polling loop placeholder
        try:
            t0 = time.perf_counter()
            params = {"dispenser_id": settings.DISPENSER_ID} if settings.DISPENSER_ID else None
            resp = session.get(
                f"{settings.BACKEND_URL}/api/inventory/next-dispense",
                params=params,
                timeout=5,
            )
            t_schedule = time.perf_counter()
            if resp.status_code != 200:
                time.sleep(settings.POLL_INTERVAL_S)
                continue

            task = resp.json()  # {"patient_id", "slot", "medication"}
            patient_id = task["patient_id"]
            slot = task["slot"]

            log.info("Dispensing slot %d for patient %d", slot, patient_id)

            # Right-patient gate: capture a live face on cam_b, verify against
            # backend, and only proceed if the matched patient_id equals the
            # scheduled one. Stub-mode skips this entirely (no falsified
            # telemetry: pill_taken=False forced below).
            # ── Phase 6: BENCH_MODE mocks Face ID — synthetic match so the
            # right-patient gate passes without 200 real blink+capture cycles.
            if settings.BENCH_MODE:
                auth = {"patient_id": patient_id, "name": "bench", "distance": 0.0}
            else:
                auth = None if hardware_stubbed else authenticate_patient(liveness)
            t_auth = time.perf_counter()
            # ── /Phase 6 ──
            if not hardware_stubbed and auth is None:
                log.warning(
                    "Skipping cycle: authentication failed for slot %d", slot
                )
                time.sleep(settings.POLL_INTERVAL_S)
                continue
            if auth is not None and auth.get("patient_id") != patient_id:
                log.warning(
                    "Authenticated patient_id=%s does not match scheduled %d; skipping cycle",
                    auth.get("patient_id"),
                    patient_id,
                )
                time.sleep(settings.POLL_INTERVAL_S)
                continue

            magazine.rotate_to(slot)
            t_rotate = time.perf_counter()
            ejector.push()
            t_eject = time.perf_counter()

            # --- Phase 4: diverter + drawer-lock -------------------------------
            # Drawer unlocks ONLY when right-patient gate (Phase 3, above) AND
            # pill-ID verification (confirm_tray_empty) both pass. Any failure
            # routes the pill through the diverter to the reject bin and leaves
            # the drawer locked. HI-012: stubbed hardware never reports
            # pill_taken=True, so the unlock branch is unreachable in stub mode.
            if hardware_stubbed:
                pill_taken_actual = False
                t_pillid = t_diverter = t_drawer = t_eject
                log.info(
                    "Stub mode: skipping vision verify, diverter, drawer_lock, swallow watch"
                )
            else:
                pill_id_pass = verifier.confirm_tray_empty()
                t_pillid = time.perf_counter()
                if pill_id_pass:
                    diverter.deliver()
                    t_diverter = time.perf_counter()
                    drawer_lock.hold_unlocked()
                    t_drawer = time.perf_counter()
                    pill_taken_actual = True
                    # Phase 6: bench mocks the swallow watch (60 s × 200 = 200 min)
                    if not settings.BENCH_MODE:
                        monitor.watch_for_swallow(timeout_s=60)
                else:
                    log.warning(
                        "Pill-ID verification failed; routing to reject bin"
                    )
                    diverter.reject()
                    t_diverter = time.perf_counter()
                    t_drawer = t_diverter
                    pill_taken_actual = False
            # --- /Phase 4 ------------------------------------------------------

            # Phase 8: tag stub origin so replay can audit/skip falsified
            # pill_taken=true rows (HI-012 defensive carry-over).
            report_intake(
                patient_id,
                slot,
                verified=pill_taken_actual,
                is_stub=hardware_stubbed,
            )
            t_log = time.perf_counter()
            log.info("Cycle complete — pill_taken=%s", pill_taken_actual)

            # ── Phase 6: per-cycle metrics row ──
            if bench_writer is not None:
                cycle_n += 1
                bench_writer.writerow({
                    "cycle": cycle_n,
                    "patient_id": patient_id,
                    "slot": slot,
                    "t_schedule_ms": (t_schedule - t0) * 1000.0,
                    "t_auth_ms":     (t_auth - t_schedule) * 1000.0,
                    "t_rotate_ms":   (t_rotate - t_auth) * 1000.0,
                    "t_eject_ms":    (t_eject - t_rotate) * 1000.0,
                    "t_pillid_ms":   (t_pillid - t_eject) * 1000.0,
                    "t_diverter_ms": (t_diverter - t_pillid) * 1000.0,
                    "t_drawer_ms":   (t_drawer - t_diverter) * 1000.0,
                    "t_log_ms":      (t_log - t_drawer) * 1000.0,
                    "t_total_ms":    (t_log - t0) * 1000.0,
                    "pill_taken":    pill_taken_actual,
                })
                bench_writer._fh.flush()
            # ── /Phase 6 ──

        except Exception:
            log.exception("Error in main loop")

        time.sleep(settings.POLL_INTERVAL_S)


if __name__ == "__main__":
    run()
