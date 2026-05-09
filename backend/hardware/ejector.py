"""
Pill ejector — 28BYJ-48 unipolar stepper driven through a ULN2003 board.

Public API matches the original servo version: ``Ejector()`` constructs,
``push()`` runs one full eject motion, ``cleanup()`` releases pins.
Internally we sequence 4 GPIO outputs (IN1..IN4) through the half-step
sequence, drive ``EJECT_STEPS`` half-steps forward, hold briefly, then
return to the start position.

Wiring (28BYJ-48 + ULN2003 board):
    ULN2003 IN1 -> Pi BCM 5  (phys 29)
    ULN2003 IN2 -> Pi BCM 6  (phys 31)
    ULN2003 IN3 -> Pi BCM 16 (phys 36)
    ULN2003 IN4 -> Pi BCM 26 (phys 37)
    ULN2003 +   -> External 5V (NOT Pi 5V — stall current ~250 mA)
    ULN2003 GND -> External 5V GND AND Pi GND

Tune ``EJECT_STEPS`` once the slider mechanism is built. 28BYJ-48 in
half-step mode is 4096 steps / revolution — typical eject motion is
1/8 turn (512 steps) or whatever rotation the slider-cam needs.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# GPIO BCM pins for ULN2003 IN1..IN4. None of these conflict with the
# magazine STEP/DIR/EN (17/27/22), the drawer servo on BCM 18 (PWM0),
# or the DHT11 on BCM 4.
PIN_IN1 = 5
PIN_IN2 = 6
PIN_IN3 = 16
PIN_IN4 = 26
_PINS = (PIN_IN1, PIN_IN2, PIN_IN3, PIN_IN4)

# 28BYJ-48 half-step sequence (8 phases). Half-step gives smoother
# motion + higher torque than full-step at this load.
_HALF_STEP = (
    (1, 0, 0, 1),
    (1, 0, 0, 0),
    (1, 1, 0, 0),
    (0, 1, 0, 0),
    (0, 1, 1, 0),
    (0, 0, 1, 0),
    (0, 0, 1, 1),
    (0, 0, 0, 1),
)

# Number of half-steps per push. 28BYJ-48 is 4096 half-steps/rev; tune
# mechanically. 512 = 1/8 turn — adjust for the actual slider geometry.
EJECT_STEPS = 512
# Inter-step delay. 1 ms is near the practical max speed; 2 ms is gentler.
STEP_DELAY_S = 0.002

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class Ejector:
    def __init__(self) -> None:
        self.gpio: Any = None
        self._is_stub: bool = False
        self._step_idx: int = 0  # tracks current half-step phase
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            # initial=GPIO.LOW required on Pi 5 + rpi-lgpio 0.6 (see magazine.py).
            for pin in _PINS:
                GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)
            self.gpio = GPIO
            self._is_stub = False
            log.info(
                "Ejector 28BYJ-48 initialized on IN1=%d IN2=%d IN3=%d IN4=%d",
                *_PINS,
            )
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
                self.gpio = None
                self._is_stub = True
            else:
                raise RuntimeError(
                    "Ejector: GPIO init failed; "
                    "set PHARMGUARD_STUB=1 to allow stub mode"
                ) from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def _set_phase(self, phase: tuple[int, int, int, int]) -> None:
        for pin, value in zip(_PINS, phase):
            self.gpio.output(pin, value)

    def _step(self, n_steps: int, *, forward: bool) -> None:
        """Advance ``n_steps`` half-steps in the chosen direction."""
        direction = 1 if forward else -1
        for _ in range(n_steps):
            self._step_idx = (self._step_idx + direction) % len(_HALF_STEP)
            self._set_phase(_HALF_STEP[self._step_idx])
            time.sleep(STEP_DELAY_S)

    def push(self) -> None:
        """Drive the slider forward then back to the rest position.

        Total motion: ``EJECT_STEPS`` half-steps forward + same backward.
        Pins are de-energised after the return so the coils don't burn.
        """
        if self._is_stub:
            log.debug("stub: would push")
            return

        log.info("Ejecting pill (%d half-steps)", EJECT_STEPS)
        self._step(EJECT_STEPS, forward=True)
        self._step(EJECT_STEPS, forward=False)
        # De-energise — the ULN2003 + 28BYJ-48 hold position by detent
        # well enough at rest, and leaving coils energised heats the
        # motor + wastes ~150 mA continuous.
        for pin in _PINS:
            self.gpio.output(pin, 0)

    def cleanup(self) -> None:
        if self.gpio is None:
            return
        try:
            for pin in _PINS:
                self.gpio.output(pin, 0)
            self.gpio.cleanup(list(_PINS))
        except Exception:
            log.exception("Ejector cleanup failed (continuing)")
