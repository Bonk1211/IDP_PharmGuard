"""Bench-test the NEMA17 stepper via A4988 on Raspberry Pi.

Python port of the Arduino sketch. Rotates one full revolution one way,
waits 1 s, rotates back, waits 1 s, and repeats until Ctrl+C.

Wiring (BCM):
  STEP -> BCM 17 (physical 11)
  DIR  -> BCM 27 (physical 13)
  EN   -> BCM 22 (physical 15)
  VDD  -> Pi 3V3            GND (logic) -> Pi GND
  VMOT -> 12 V PSU +        GND (motor) -> PSU GND (tied to Pi GND)
  RESET <-> SLEEP jumpered, MS1/MS2/MS3 open (full step).

Set A4988 Vref with the motor disconnected before running
(0.4 V on R050 sense / 0.8 V on R100 sense for ~1 A on a 17HS8401).

Run:
    sudo systemctl stop pharmguard
    cd ~/IDP_PharmGuard/backend && source .venv/bin/activate
    python hardware/test_magazine.py
"""

from __future__ import annotations

import time

import RPi.GPIO as GPIO

STEP_PIN = 17
DIR_PIN = 27
EN_PIN = 22

STEPS_PER_REV = 25
STEP_DELAY = 10e-3  # 1 ms half-period -> 2 ms full step, matches magazine.py


def step_once() -> None:
    GPIO.output(STEP_PIN, GPIO.HIGH)
    time.sleep(STEP_DELAY)
    GPIO.output(STEP_PIN, GPIO.LOW)
    time.sleep(STEP_DELAY)


def rotate(direction: int) -> None:
    GPIO.output(DIR_PIN, GPIO.HIGH if direction else GPIO.LOW)
    for _ in range(STEPS_PER_REV):
        step_once()


def main() -> None:
    GPIO.setmode(GPIO.BCM)
    # initial= required on Pi 5 + rpi-lgpio 0.6 (see magazine.py:46-48).
    GPIO.setup(STEP_PIN, GPIO.OUT, initial=GPIO.LOW)
    GPIO.setup(DIR_PIN, GPIO.OUT, initial=GPIO.LOW)
    GPIO.setup(EN_PIN, GPIO.OUT, initial=GPIO.HIGH)
    GPIO.output(EN_PIN, GPIO.LOW)  # LOW = driver enabled on A4988

    try:
        while True:
            rotate(1)
            time.sleep(1)
            rotate(0)
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        GPIO.output(EN_PIN, GPIO.HIGH)  # disable driver before releasing pins
        GPIO.cleanup()


if __name__ == "__main__":
    main()
