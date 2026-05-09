"""
Slider-crank ejector mechanism — pushes the pill out of the magazine slot.

Supports servo (PWM) or DC motor control via GPIO.
"""

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# GPIO BCM pin for servo PWM
PIN_SERVO = 18
PUSH_DURATION_S = 0.5

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class Ejector:
    def __init__(self) -> None:
        self.pwm: Any = None
        self._is_stub: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            # initial=GPIO.LOW required on Pi 5 + rpi-lgpio 0.6 (see magazine.py).
            GPIO.setup(PIN_SERVO, GPIO.OUT, initial=GPIO.LOW)
            self.pwm = GPIO.PWM(PIN_SERVO, 50)  # 50 Hz for servo
            self.pwm.start(0)
            self._is_stub = False
            log.info("Ejector servo initialized")
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
                self.pwm = None
                self._is_stub = True
            else:
                raise RuntimeError(
                    "Ejector: GPIO init failed; "
                    "set PHARMGUARD_STUB=1 to allow stub mode"
                ) from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def push(self) -> None:
        """Actuate the slider-crank to eject the pill."""
        if self._is_stub:
            log.debug("stub: would push")
            return

        log.info("Ejecting pill")
        self.pwm.ChangeDutyCycle(7.5)  # Move to push position
        time.sleep(PUSH_DURATION_S)
        self.pwm.ChangeDutyCycle(2.5)  # Return to rest
        time.sleep(PUSH_DURATION_S)
        self.pwm.ChangeDutyCycle(0)

    def cleanup(self) -> None:
        if self.pwm is not None:
            self.pwm.stop()
