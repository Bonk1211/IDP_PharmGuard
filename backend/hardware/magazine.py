"""
10-slot magazine rotation via stepper motor (A4988 / DRV8825 driver).

GPIO pin assignments are configured for a Raspberry Pi 4/5.
"""

import logging
import os
import time
from typing import Any

from hardware.interlock import ACTUATOR_LOCK, SETTLE_S

log = logging.getLogger(__name__)

# GPIO BCM pin assignments
PIN_STEP = 17
# PIN_DIR convention: HIGH = forward (increasing slot index), LOW = reverse.
PIN_DIR = 27
PIN_ENABLE = 22

STEPS_PER_SLOT = 20  # Adjust based on gear ratio and micro-stepping
# Half-period between STEP edges. Matches test_magazine.py exactly —
# HIGH-sleep-LOW-sleep gives a 1 ms HIGH width which the A4988 + Pi 5
# rpi-lgpio shim reliably latches. The previous HIGH-LOW-sleep pattern
# left HIGH at s\ub-µs (back-to-back GPIO writes) and the motor missed
# steps / didn't move at all on bench.
STEP_DELAY_S = 5e-3
TOTAL_SLOTS = 10

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class Magazine:
    def __init__(self) -> None:
        self.current_slot: int = 0
        self.gpio: Any = None
        self._is_stub: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            # initial=GPIO.LOW required on Pi 5 + rpi-lgpio 0.6: without
            # an explicit initial value the shim calls lgpio.gpio_read on
            # a not-yet-claimed line, raising 'GPIO not allocated'.
            GPIO.setup(PIN_STEP, GPIO.OUT, initial=GPIO.LOW)
            GPIO.setup(PIN_DIR, GPIO.OUT, initial=GPIO.LOW)
            GPIO.setup(PIN_ENABLE, GPIO.OUT, initial=GPIO.LOW)
            GPIO.output(PIN_ENABLE, GPIO.LOW)  # Enable driver
            self.gpio = GPIO
            self._is_stub = False
            log.info("Magazine GPIO initialized")
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
                self.gpio = None
                self._is_stub = True
            else:
                raise RuntimeError(
                    "Magazine: GPIO init failed; "
                    "set PHARMGUARD_STUB=1 to allow stub mode"
                ) from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def rotate_to(self, target_slot: int) -> None:
        """Rotate the magazine to the given slot (0-9)."""
        if target_slot < 0 or target_slot >= TOTAL_SLOTS:
            raise ValueError(
                f"Slot must be 0-{TOTAL_SLOTS - 1}, got {target_slot}"
            )

        # Shortest-path: pick whichever direction needs fewer steps.
        forward = (target_slot - self.current_slot) % TOTAL_SLOTS
        reverse = TOTAL_SLOTS - forward
        if forward <= reverse:
            direction = "forward"
            slot_delta = forward
        else:
            direction = "reverse"
            slot_delta = reverse
        steps = slot_delta * STEPS_PER_SLOT

        log.info(
            "Rotating from slot %d -> %d (%s, %d steps)",
            self.current_slot,
            target_slot,
            direction,
            steps,
        )

        if self._is_stub:
            log.debug("stub: would rotate to slot %d", target_slot)
            self.current_slot = target_slot
            return

        # Real hardware path. Hold ACTUATOR_LOCK for the full motion so the
        # ejector servo cannot push while the magazine is turning — both
        # moving together fouls the pusher against the magazine wall and
        # jams the mechanism (see hardware/interlock.py). Leave current_slot
        # untouched until the loop completes so a mid-step exception leaves
        # the magazine re-homable.
        with ACTUATOR_LOCK:
            self.gpio.output(
                PIN_DIR,
                self.gpio.HIGH if direction == "forward" else self.gpio.LOW,
            )
            # HIGH-sleep-LOW-sleep matches test_magazine.py — the only pulse
            # pattern that actually drives the motor on Pi 5 + rpi-lgpio. Do
            # NOT collapse this back to a single sleep: the back-to-back
            # HIGH/LOW write left STEP HIGH for too short a window and the
            # A4988 silently dropped steps.
            for _ in range(steps):
                self.gpio.output(PIN_STEP, self.gpio.HIGH)
                time.sleep(STEP_DELAY_S)
                self.gpio.output(PIN_STEP, self.gpio.LOW)
                time.sleep(STEP_DELAY_S)

            self.current_slot = target_slot

            # Let the magazine come fully to rest before releasing the
            # interlock, so the ejector cannot start its stroke while the
            # stepper is still settling.
            time.sleep(SETTLE_S)

    def home(self) -> None:
        """Return the magazine to slot 0 (home position)."""
        self.rotate_to(0)

    def cleanup(self) -> None:
        # Scope cleanup to OUR pins. A bare GPIO.cleanup() globally
        # wipes setmode + every other driver's claimed pins, causing
        # sibling cleanups (Ejector, DrawerLock) to fail with
        # "Please set pin numbering mode" + 'NoneType' PWM handle errors.
        if self.gpio is not None:
            try:
                self.gpio.cleanup([PIN_STEP, PIN_DIR, PIN_ENABLE])
            except Exception:
                log.exception("Magazine cleanup failed (continuing)")
