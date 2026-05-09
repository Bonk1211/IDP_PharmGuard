"""Bench-test the magazine stepper (17HS8401 + A4988, BCM 17/27/22).

Run on the Pi only. Set A4988 Vref FIRST with motor disconnected
(0.4 V on R050 sense or 0.8 V on R100 sense for ~1 A).

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/edge_pi && source .venv/bin/activate
    python hardware/test_magazine.py

Default: rotates to slot 1, waits 1 s, rotates back to slot 0.
Override: `python hardware/test_magazine.py 3` rotates to slot 3 then home.

Expected: smooth rotation in one direction, then smooth rotation back.
Fail modes:
  * Whining + vibrating, no rotation -> coil pairs miswired. Use multimeter,
    pins ~1.5 ohm apart belong to the same coil.
  * Jerks but stalls -> Vref too low, OR VMOT < 12 V.
  * Driver hot/smoke -> Vref TOO HIGH; power off, redo Vref calc.
  * Reverses your expected direction -> swap one coil pair (e.g. 1A<->1B).
  * RuntimeError on init -> service still running, OR another driver
    already called GPIO.setmode with a different mode.
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hardware.magazine import Magazine  # noqa: E402


def main() -> int:
    if os.environ.get("PHARMGUARD_STUB") == "1":
        print("WARNING: PHARMGUARD_STUB=1 — stepper will not move in stub mode.")
        print()

    target = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    if not 0 <= target <= 9:
        print(f"ERROR: target slot {target} out of range 0..9")
        return 2

    mag = Magazine()
    try:
        print(f"is_stub = {mag.is_stub}")
        print(f">> rotate to slot {target}")
        mag.rotate_to(target)
        time.sleep(1)
        print(">> rotate back to slot 0")
        mag.rotate_to(0)
        time.sleep(0.5)
    finally:
        mag.cleanup()

    print()
    print("RESULT: smooth rotations both ways? PASS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
