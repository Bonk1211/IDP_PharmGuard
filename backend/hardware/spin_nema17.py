"""Continuously rotate the NEMA 17 stepper via the A4988 driver.

Wiring matches hardware/magazine.py (BCM 17 STEP, 27 DIR, 22 ENABLE).
Run on the Pi only. Stop the service first so it doesn't fight us for GPIO:

    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/backend && source .venv/bin/activate
    python hardware/spin_nema17.py                  # forward, default speed
    python hardware/spin_nema17.py --dir reverse    # other direction
    python hardware/spin_nema17.py --delay 0.001    # faster (smaller = faster)

Press Ctrl+C to stop. ENABLE is driven HIGH on exit to release the coils.
"""

from __future__ import annotations

import argparse
import sys
import time

PIN_STEP = 17
PIN_DIR = 27
PIN_ENABLE = 22

DEFAULT_STEP_DELAY_S = 0.002


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        choices=("forward", "reverse"),
        default="forward",
        help="rotation direction (default: forward)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_STEP_DELAY_S,
        help=(
            "seconds between step pulses; smaller = faster. "
            f"default {DEFAULT_STEP_DELAY_S}"
        ),
    )
    args = parser.parse_args()

    if args.delay <= 0:
        print("ERROR: --delay must be > 0", file=sys.stderr)
        return 2

    try:
        import RPi.GPIO as GPIO
    except Exception as e:
        print(f"ERROR: could not import RPi.GPIO ({e}). Run on the Pi.", file=sys.stderr)
        return 1

    GPIO.setmode(GPIO.BCM)
    GPIO.setup(PIN_STEP, GPIO.OUT, initial=GPIO.LOW)
    GPIO.setup(PIN_DIR, GPIO.OUT, initial=GPIO.LOW)
    GPIO.setup(PIN_ENABLE, GPIO.OUT, initial=GPIO.LOW)

    GPIO.output(PIN_DIR, GPIO.HIGH if args.dir == "forward" else GPIO.LOW)
    GPIO.output(PIN_ENABLE, GPIO.LOW)  # A4988 is active-low enable

    print(f"Spinning {args.dir} at delay={args.delay}s/step. Ctrl+C to stop.")
    try:
        while True:
            GPIO.output(PIN_STEP, GPIO.HIGH)
            GPIO.output(PIN_STEP, GPIO.LOW)
            time.sleep(args.delay)
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        try:
            GPIO.output(PIN_ENABLE, GPIO.HIGH)  # release coils
        except Exception:
            pass
        GPIO.cleanup([PIN_STEP, PIN_DIR, PIN_ENABLE])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
