"""
Slider-crank ejector mechanism — pushes the pill out of the magazine slot.

Supports servo (PWM) or DC motor control via GPIO.
"""

import logging
import time

log = logging.getLogger(__name__)

# GPIO BCM pin for servo PWM
PIN_SERVO = 18
PUSH_DURATION_S = 0.5


class Ejector:
    def __init__(self) -> None:
        self.pwm = None
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            GPIO.setup(PIN_SERVO, GPIO.OUT)
            self.pwm = GPIO.PWM(PIN_SERVO, 50)  # 50 Hz for servo
            self.pwm.start(0)
            log.info("Ejector servo initialized")
        except Exception:
            log.warning("Servo GPIO unavailable — running in stub mode")

    def push(self) -> None:
        """Actuate the slider-crank to eject the pill."""
        log.info("Ejecting pill")
        if self.pwm is not None:
            self.pwm.ChangeDutyCycle(7.5)  # Move to push position
            time.sleep(PUSH_DURATION_S)
            self.pwm.ChangeDutyCycle(2.5)  # Return to rest
            time.sleep(PUSH_DURATION_S)
            self.pwm.ChangeDutyCycle(0)
        else:
            log.info("Ejector push (stub)")

    def cleanup(self) -> None:
        if self.pwm is not None:
            self.pwm.stop()
