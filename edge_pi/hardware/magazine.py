"""
10-slot magazine rotation via stepper motor (A4988 / DRV8825 driver).

GPIO pin assignments are configured for a Raspberry Pi 4/5.
"""

import logging
import time

log = logging.getLogger(__name__)

# GPIO BCM pin assignments
PIN_STEP = 17
PIN_DIR = 27
PIN_ENABLE = 22

STEPS_PER_SLOT = 200  # Adjust based on gear ratio and micro-stepping
STEP_DELAY_S = 0.001
TOTAL_SLOTS = 10


class Magazine:
    def __init__(self) -> None:
        self.current_slot = 0
        self.gpio = None
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            GPIO.setup(PIN_STEP, GPIO.OUT)
            GPIO.setup(PIN_DIR, GPIO.OUT)
            GPIO.setup(PIN_ENABLE, GPIO.OUT)
            GPIO.output(PIN_ENABLE, GPIO.LOW)  # Enable driver
            self.gpio = GPIO
            log.info("Magazine GPIO initialized")
        except Exception:
            log.warning("GPIO unavailable — running in stub mode")

    def rotate_to(self, target_slot: int) -> None:
        """Rotate the magazine to the given slot (0-9)."""
        if target_slot < 0 or target_slot >= TOTAL_SLOTS:
            raise ValueError(f"Slot must be 0-{TOTAL_SLOTS - 1}, got {target_slot}")

        delta = (target_slot - self.current_slot) % TOTAL_SLOTS
        steps = delta * STEPS_PER_SLOT
        log.info(
            "Rotating from slot %d -> %d (%d steps)",
            self.current_slot,
            target_slot,
            steps,
        )

        if self.gpio is not None:
            self.gpio.output(PIN_DIR, self.gpio.HIGH)
            for _ in range(steps):
                self.gpio.output(PIN_STEP, self.gpio.HIGH)
                time.sleep(STEP_DELAY_S)
                self.gpio.output(PIN_STEP, self.gpio.LOW)
                time.sleep(STEP_DELAY_S)

        self.current_slot = target_slot

    def home(self) -> None:
        """Return the magazine to slot 0 (home position)."""
        self.rotate_to(0)

    def cleanup(self) -> None:
        if self.gpio is not None:
            self.gpio.cleanup()
