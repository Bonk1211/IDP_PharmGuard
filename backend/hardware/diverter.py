"""
Diverter flap — servo that routes the ejected pill to either the patient
drawer (DELIVER) or the reject bin (REJECT). Acts as the mechanical
fail-safe when pill-ID verification fails.

GPIO pin: BCM 13 (Pi 5 hardware PWM channel PWM1).
"""

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# GPIO BCM pin for servo PWM (hardware PWM channel PWM1 on Pi 5).
PIN_SERVO = 13

# Servo duty cycles (50 Hz). 2.5 % approx 0 deg, 7.5 % approx 90 deg, 12.5 %
# approx 180 deg. Geometry assumes the flap rests at DELIVER (gravity-neutral)
# and rotates outward to REJECT only when actively driven.
DELIVER_DUTY = 7.5   # neutral / patient-drawer chute
REJECT_DUTY = 12.5   # rotated / reject-bin chute
MOVE_DURATION_S = 0.4
HOLD_DURATION_S = 0.6  # long enough for the pill to clear the flap

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class Diverter:
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
            log.info("Diverter servo initialized")
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
                self.pwm = None
                self._is_stub = True
            else:
                raise RuntimeError(
                    "Diverter: GPIO init failed; "
                    "set PHARMGUARD_STUB=1 to allow stub mode"
                ) from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def deliver(self) -> None:
        """Hold the flap at the patient-drawer chute (default-neutral)."""
        if self._is_stub:
            log.debug("stub: would set diverter to DELIVER")
            return

        log.info("Diverter -> DELIVER")
        self.pwm.ChangeDutyCycle(DELIVER_DUTY)
        time.sleep(MOVE_DURATION_S)
        self.pwm.ChangeDutyCycle(0)

    def reject(self) -> None:
        """Sweep the flap to the reject bin and return to neutral.

        Called when pill-ID verification fails. Holds the REJECT angle
        long enough for the dropped pill to clear the flap, then snaps
        back to DELIVER so the next dispense is gravity-neutral.
        """
        if self._is_stub:
            log.debug("stub: would reject pill")
            return

        log.info("Diverter -> REJECT (pill rejected)")
        self.pwm.ChangeDutyCycle(REJECT_DUTY)
        time.sleep(HOLD_DURATION_S)
        self.pwm.ChangeDutyCycle(DELIVER_DUTY)
        time.sleep(MOVE_DURATION_S)
        self.pwm.ChangeDutyCycle(0)

    def cleanup(self) -> None:
        if self.pwm is not None:
            self.pwm.stop()
