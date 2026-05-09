"""Bench-test the DHT11 tray-temp sensor (BCM 4).

Run on the Pi only. From edge_pi/ with the venv active and the
pharmguard service stopped:

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/edge_pi && source .venv/bin/activate
    python hardware/test_dht11.py

Expected: 3 temperature reads, each a number in 18-32 C, ~2 s apart.
Fail modes:
  * temp_c = None repeatedly -> missing 10 kohm pull-up, swapped DATA/GND, dead module.
  * RuntimeError on init -> `pip install -r requirements.txt` (adafruit-circuitpython-dht missing).
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hardware.temp_sensor import TempSensor  # noqa: E402


def main() -> int:
    if os.environ.get("PHARMGUARD_STUB") == "1":
        print("WARNING: PHARMGUARD_STUB=1 — readings will be the canned stub value.")
        print("         `unset PHARMGUARD_STUB` for a real hardware test.")
        print()

    sensor = TempSensor()
    print(f"is_stub = {sensor.is_stub}")

    failed = 0
    for i in range(1, 4):
        value = sensor.read_celsius()
        print(f"  read {i}: temp_c = {value}")
        if value is None:
            failed += 1
        time.sleep(2)

    print()
    if sensor.is_stub:
        print("RESULT: stub mode (not a real hardware test)")
        return 0
    if failed == 0:
        print("RESULT: PASS — DHT11 wired correctly.")
        return 0
    print(f"RESULT: FAIL — {failed}/3 reads returned None. Check pull-up and wiring.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
