"""Bench-test the ejector MG996R continuous-rotation servo (signal on BCM 13).

Run on the Pi only.

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/backend && source .venv/bin/activate
    sudo -E .venv/bin/python hardware/test_ejector.py [cycles]

Repeats push() (forward 7.5s, stop, reverse 7.5s, stop) N times (default 3).
push() drives PWM to 0 between cycles so the servo fully stops.

Expected: clean forward + reverse sweep each cycle; servo silent between cycles.
Fail modes:
  * No movement -> servo V+ not on external 5-6V, or supply GND not tied to
    Pi GND. MG996R stall is ~2.5A; never power it from the Pi 5V rail.
  * Spins wrong way -> swap FWD_DUTY <-> REV_DUTY in ejector.py.
  * Creeps while "stopped" -> trim STOP_DUTY (1500us) in 0.1% steps in ejector.py.
  * Jitter/buzz -> 5V sag under load; use a beefier PSU (>= 3A).
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hardware.ejector import Ejector  # noqa: E402


def main() -> int:
    if os.environ.get("PHARMGUARD_STUB") == "1":
        print("WARNING: PHARMGUARD_STUB=1 — servo will not move in stub mode.")
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
    print("RESULT: clean fwd/rev sweeps on every cycle? PASS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
