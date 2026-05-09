"""Bench-test the ejector SG90 servo (BCM 18 / hardware PWM0).

Run on the Pi only. END-STOPS MUST BE FITTED — SG90 burns out under
sustained stall.

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/edge_pi && source .venv/bin/activate
    python hardware/test_ejector.py

Repeats the push-then-rest cycle 3 times (push() already returns servo
to rest internally — see ejector.py:55-66).

Expected: 3 clean swing-and-return motions.
Fail modes:
  * Twitches, doesn't reach end -> 5 V rail sagging. Move SG90 V+ off Pi
    pin 2 onto an external 5 V PSU (still tie GND to Pi GND).
  * Jitters at rest -> soft-PWM jitter. Confirm signal IS on BCM 18
    (physical pin 12) AND `dtparam=i2s=off` (default on Bookworm/Trixie).
  * No movement at all -> signal pin wrong, OR ext 5V GND not tied to Pi GND.
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
    print("RESULT: clean swings on every cycle? PASS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
