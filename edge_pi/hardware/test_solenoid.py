"""Bench-test the drawer-lock solenoid (BCM 23 -> MOSFET -> coil).

Run on the Pi only. Drawer mechanism PHYSICALLY DETACHED so nothing
slams shut. From edge_pi/ with the venv active, service stopped:

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/edge_pi && source .venv/bin/activate
    python hardware/test_solenoid.py

Expected: audible click on unlock, audible click on lock.
Fail modes:
  * No click -> MOSFET gate not driven; check 1 kohm gate resistor + Pi GND <-> PSU GND tie.
  * One click only / sticks open -> missing flyback diode (1N4007); MOSFET likely damaged.
  * RuntimeError on init -> service still running (it owns the pin).
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
