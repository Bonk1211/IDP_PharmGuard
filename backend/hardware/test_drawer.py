"""Bench-test the drawer-lock SG90 servo (BCM 18 / hardware PWM0).

Run on the Pi only. Drawer mechanism PHYSICALLY DETACHED so the latch
arm doesn't bind on anything during the swing.

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/backend && source .venv/bin/activate
    sudo -E .venv/bin/python hardware/test_drawer.py

Expected: visible servo arm rotation to UNLOCK angle, hold 2 s, return
to LOCK angle.
Fail modes:
  * No movement -> servo V+ on Pi 5V (sagging); use ext 5V PSU. Or
    signal pin wrong (must be BCM 18 = phys 12).
  * Stalls / buzzes at end -> end-stop preventing full rotation; reduce
    UNLOCK_DUTY or adjust mounting angle.
  * Drifts mid-cycle -> coils being de-energised mid-motion. Increase
    SERVO_SETTLE_S in drawer_lock.py.
  * Reverses direction -> swap LOCK_DUTY <-> UNLOCK_DUTY.
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hardware.drawer_lock import DrawerLock  # noqa: E402


def main() -> int:
    if os.environ.get("PHARMGUARD_STUB") == "1":
        print("WARNING: PHARMGUARD_STUB=1 — solenoid test is meaningless in stub mode.")
        print()

    lock = DrawerLock()
    try:
        print(f"is_stub = {lock.is_stub}")
        print(">> unlock (energise 2 s)")
        lock.unlock()
        time.sleep(2)
        print(">> lock")
        lock.lock()
        time.sleep(0.5)
    finally:
        lock.cleanup()

    print()
    print("RESULT: heard two clicks? PASS. silent? check wiring.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
