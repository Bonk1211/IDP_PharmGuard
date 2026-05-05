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
from vision.pill_verifier import PillVerifier
from vision.intake_monitor import IntakeMonitor
from hardware.magazine import Magazine
from hardware.ejector import Ejector

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


def authenticate_patient(face_crop_path: str) -> dict | None:
    """Send a face crop to the backend and return patient info or None."""
    assert session is not None, "session not initialized; call run() first"
    with open(face_crop_path, "rb") as f:
        resp = session.post(
            f"{settings.BACKEND_URL}/api/auth/verify-face",
            files={"file": ("face.jpg", f, "image/jpeg")},
            timeout=10,
        )
    if resp.status_code == 200:
        return resp.json()
    log.warning("Authentication failed: %s", resp.text)
    return None


def report_intake(patient_id: int, slot: int, verified: bool) -> None:
    """POST an adherence log to the backend."""
    assert session is not None, "session not initialized; call run() first"
    session.post(
        f"{settings.BACKEND_URL}/api/logs/",
        json={
            "patient_id": patient_id,
            "slot": slot,
            "pill_taken": verified,
        },
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
    verifier = PillVerifier()
    monitor = IntakeMonitor()

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
