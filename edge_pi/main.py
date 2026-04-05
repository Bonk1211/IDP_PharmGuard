"""
PharmGuard Edge — Raspberry Pi main loop.

Cycle:
  1. Authenticate patient via face recognition
  2. Rotate magazine to the scheduled slot
  3. Eject the pill
  4. Verify pill was taken (vision)
  5. Report telemetry to backend
"""

import time
import logging

import requests

from vision.pill_verifier import PillVerifier
from vision.intake_monitor import IntakeMonitor
from hardware.magazine import Magazine
from hardware.ejector import Ejector

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

BACKEND_URL = "http://localhost:8000"
POLL_INTERVAL_S = 30


def authenticate_patient(face_crop_path: str) -> dict | None:
    """Send a face crop to the backend and return patient info or None."""
    with open(face_crop_path, "rb") as f:
        resp = requests.post(
            f"{BACKEND_URL}/api/auth/verify-face",
            files={"file": ("face.jpg", f, "image/jpeg")},
            timeout=10,
        )
    if resp.status_code == 200:
        return resp.json()
    log.warning("Authentication failed: %s", resp.text)
    return None


def report_intake(patient_id: int, slot: int, verified: bool) -> None:
    """POST an adherence log to the backend."""
    requests.post(
        f"{BACKEND_URL}/api/logs/",
        json={
            "patient_id": patient_id,
            "slot": slot,
            "pill_taken": verified,
        },
        timeout=10,
    )


def run() -> None:
    magazine = Magazine()
    ejector = Ejector()
    verifier = PillVerifier()
    monitor = IntakeMonitor()

    log.info("PharmGuard Edge started — waiting for schedule triggers")

    while True:
        # TODO: Replace with real schedule lookup from backend
        # For now, a simple polling loop placeholder
        try:
            resp = requests.get(
                f"{BACKEND_URL}/api/inventory/next-dispense", timeout=5
            )
            if resp.status_code != 200:
                time.sleep(POLL_INTERVAL_S)
                continue

            task = resp.json()  # {"patient_id", "slot", "medication"}
            patient_id = task["patient_id"]
            slot = task["slot"]

            log.info("Dispensing slot %d for patient %d", slot, patient_id)

            magazine.rotate_to(slot)
            ejector.push()

            pill_taken = verifier.confirm_tray_empty()
            if pill_taken:
                monitor.watch_for_swallow(timeout_s=60)

            report_intake(patient_id, slot, verified=pill_taken)
            log.info("Cycle complete — pill_taken=%s", pill_taken)

        except Exception:
            log.exception("Error in main loop")

        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    run()
