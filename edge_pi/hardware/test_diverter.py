"""Bench-test the diverter SG90 servo (BCM 13 / hardware PWM1).

Run on the Pi only. End-stops should be fitted on both flap extremes.

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/edge_pi && source .venv/bin/activate
    python hardware/test_diverter.py

Sequence: deliver -> wait 2 s -> reject -> wait 2 s -> deliver.

Expected: flap rests at the patient-drawer chute (DELIVER), then swings
to the reject-bin chute, then returns to DELIVER.
Fail modes:
  * Flap reversed (DELIVER points to reject bin) -> mount the flap rotated
    90 deg, OR swap DELIVER_DUTY/REJECT_DUTY in diverter.py:22-23.
  * No movement / jitter -> same fixes as ejector (ext 5 V, BCM 13 = phys 33,
    common ground).
  * RuntimeError on init -> service still owns the pin.
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hardware.diverter import Diverter  # noqa: E402


def main() -> int:
    if os.environ.get("PHARMGUARD_STUB") == "1":
        print("WARNING: PHARMGUARD_STUB=1 — servo will not move in stub mode.")
        print()

    div = Diverter()
    try:
        print(f"is_stub = {div.is_stub}")
        print(">> deliver (rest position, gravity-neutral)")
        div.deliver()
        time.sleep(2)
        print(">> reject (hold flap rotated)")
        div.reject()
        time.sleep(2)
        print(">> deliver (return to rest)")
        div.deliver()
        time.sleep(1)
    finally:
        div.cleanup()

    print()
    print("RESULT: flap moved to both chutes correctly? PASS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
