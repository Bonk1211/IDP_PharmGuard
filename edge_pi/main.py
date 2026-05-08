"""
PharmGuard Edge — Raspberry Pi main loop.

Cycle:
  1. Authenticate patient via face recognition
  2. Rotate magazine to the scheduled slot
  3. Eject the pill
  4. Verify pill was taken (vision)
  5. Report telemetry to backend
"""

import sys
import time
import logging

import requests

from config import settings
from hardware.ejector import Ejector
from hardware.magazine import Magazine
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


def report_intake(patient_id: int, slot: int, verified: bool) -> None:
    """POST an adherence log to the backend."""
    assert session is not None, "session not initialized; call run() first"
    payload: dict = {
        "patient_id": patient_id,
        "slot": slot,
        "pill_taken": verified,
    }
    if settings.DISPENSER_ID:
        payload["dispenser_id"] = settings.DISPENSER_ID
    session.post(
        f"{settings.BACKEND_URL}/api/logs/",
        json=payload,
        timeout=10,
    )


def run() -> None:
    global session

    # Fail fast on misconfig before touching hardware.
    try:
        settings.validate()
    except RuntimeError as exc:
        log.error("Config validation failed: %s", exc)
        sys.exit(2)

    session = _build_session()

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

    # HI-012: Refuse to run as if hardware were real when it isn't.
    hardware_stubbed = magazine.is_stub or ejector.is_stub
    if hardware_stubbed:
        if not settings.STUB_MODE:
            log.error(
                "Hardware initialization degraded (magazine.is_stub=%s, "
                "ejector.is_stub=%s) but PHARMGUARD_STUB is not set. Refusing "
                "to run — telemetry would be falsified.",
                magazine.is_stub,
                ejector.is_stub,
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

    log.info("PharmGuard Edge started — waiting for schedule triggers")

    while True:
        # TODO: Replace with real schedule lookup from backend
        # For now, a simple polling loop placeholder
        try:
            resp = session.get(
                f"{settings.BACKEND_URL}/api/inventory/next-dispense", timeout=5
            )
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
            auth = None if hardware_stubbed else authenticate_patient(liveness)
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
            ejector.push()

            # HI-012: never let a stubbed run claim a pill was actually taken.
            if hardware_stubbed:
                pill_taken_actual = False
                log.info("Stub mode: skipping vision verify + swallow watch")
            else:
                pill_taken_actual = verifier.confirm_tray_empty()
                if pill_taken_actual:
                    monitor.watch_for_swallow(timeout_s=60)

            report_intake(patient_id, slot, verified=pill_taken_actual)
            log.info("Cycle complete — pill_taken=%s", pill_taken_actual)

        except Exception:
            log.exception("Error in main loop")

        time.sleep(settings.POLL_INTERVAL_S)


if __name__ == "__main__":
    run()
