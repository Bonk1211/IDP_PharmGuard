"""Bench-test the ejector 28BYJ-48 stepper (ULN2003 on BCM 5/6/16/26).

Run on the Pi only.

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/backend && source .venv/bin/activate
    sudo -E .venv/bin/python hardware/test_ejector.py

Repeats the push (forward + return) cycle 3 times. push() de-energises
coils between cycles so the motor doesn't overheat.

Expected: 3 clean rotations forward + back. Quiet operation between cycles.
Fail modes:
  * No movement -> ULN2003 +5V supply not connected, or external 5V GND
    not tied to Pi GND. Use a multimeter on IN1..IN4 — should toggle.
  * Stalls / loud buzzing -> step rate too fast or 5V sagging. Increase
    STEP_DELAY_S in ejector.py, or use a beefier 5V PSU (>= 1A).
  * Coils get hot at rest -> push() didn't de-energise; verify the
    de-energise loop at the bottom of push() runs.
  * Direction reversed -> swap any 2 of the 4 IN pins.
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hardware.ejector import Ejector  # noqa: E402


def main() -> int:
    if os.environ.get("PHARMGUARD_STUB") == "1":
        print("WARNING: PHARMGUARD_STUB=1 — motor will not move in stub mode.")
        print()

    cycles = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    ej = Ejector()
    try:
        print(f"is_stub = {ej.is_stub}")
        for i in range(1, cycles + 1):
            print(f">> push cycle {i}/{cycles}")
            ej.push()
            time.sleep(1.0)
    finally:
        ej.cleanup()

    print()
    print("RESULT: clean rotations on every cycle? PASS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
