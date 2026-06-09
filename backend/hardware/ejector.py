"""
Pill ejector — MG996R continuous-rotation servo on 50 Hz PWM.

Public API matches the previous stepper version so callers (cycle
runner, device API, bench scripts) need no changes:

  Ejector()
  .is_stub  -> bool
  .push()   -> one eject motion (forward, stop, reverse, stop)
  .cleanup() -> stop PWM + free pin

Mirrors the bench-validated Arduino sketch (Servo.writeMicroseconds):
  FWD_PWM  = 1600 us   REV_PWM = 1400 us   STOP_PWM = 1500 us
  MOVE_MS  = 7500      PAUSE_MS = 1000
Continuous-rotation servos read pulse WIDTH as speed+direction, not
angle: ~1500 us = stop, >1500 = one way, <1500 = the other. Further
from 1500 = faster. If it spins the wrong way, swap FWD_DUTY/REV_DUTY.
If it creeps while "stopped", trim STOP_DUTY in 0.1 % steps.

Wiring (MG996R on hardware-PWM-capable BCM 13 / phys 33):
    Signal (orange/white) -> Pi BCM 13 (phys 33)
    V+     (red)          -> external 5-6 V (NOT Pi 5 V — stall ~2.5 A)
    GND    (brown/black)  -> external supply GND AND Pi GND
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from hardware.interlock import ACTUATOR_LOCK, SETTLE_S

log = logging.getLogger(__name__)

# MG996R signal pin. Hardware-PWM-capable, free now that the ULN2003
# stepper (BCM 5/6/16/26) is gone and the drawer SG90 owns BCM 18.
PIN_SERVO = 13
PWM_HZ = 50


# Pulse-us -> duty-% at 50 Hz: duty = pulse_us / (1e6 / PWM_HZ) * 100
#   1500 us -> 7.5 %   (STOP)
#   1600 us -> 8.0 %   (FORWARD — further from 1500 = faster)
#   1400 us -> 7.0 %   (REVERSE)
def _us_to_duty(pulse_us: float) -> float:
    return pulse_us / (1_000_000 / PWM_HZ) * 100.0


STOP_DUTY = _us_to_duty(1500)
FWD_DUTY = _us_to_duty(1600)
REV_DUTY = _us_to_duty(1400)

# Arduino MOVE_MS / PAUSE_MS, in seconds.
MOVE_S = 7.5
PAUSE_S = 1.0

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class Ejector:
    def __init__(self) -> None:
        self.gpio: Any = None
        self.pwm: Any = None
        self._is_stub: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            # initial=GPIO.LOW required on Pi 5 + rpi-lgpio 0.6 (see magazine.py).
            GPIO.setup(PIN_SERVO, GPIO.OUT, initial=GPIO.LOW)
            self.pwm = GPIO.PWM(PIN_SERVO, PWM_HZ)
            self.pwm.start(0)
            self.gpio = GPIO
            self._is_stub = False
            # Boot to a known STOP, then silence so the servo doesn't creep.
            self.pwm.ChangeDutyCycle(STOP_DUTY)
            time.sleep(PAUSE_S)
            self.pwm.ChangeDutyCycle(0)
            log.info("Ejector MG996R initialized on BCM %d (stopped)", PIN_SERVO)
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
                self.pwm = None
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

    def _drive(self, duty: float, hold_s: float) -> None:
        """Hold a PWM duty for hold_s seconds (continuous-servo speed cmd)."""
        self.pwm.ChangeDutyCycle(duty)
        time.sleep(hold_s)

    def push(self) -> None:
        """One eject motion: forward, stop, reverse, stop.

        Mirrors one iteration of the Arduino loop(): FWD for MOVE_S, STOP
        for PAUSE_S, REV for MOVE_S, STOP for PAUSE_S. Ends with PWM at 0
        so the servo receives no pulses and fully stops (no creep).
        """
        if self._is_stub:
            log.debug("stub: would push")
            return

        log.info("Ejecting pill (MG996R fwd/rev %.1fs each)", MOVE_S)
        # Hold ACTUATOR_LOCK for the full stroke so the magazine stepper
        # cannot rotate while the pusher is extended — both moving together
        # fouls the pusher against the magazine wall and jams the mechanism
        # (see hardware/interlock.py).
        with ACTUATOR_LOCK:
            try:
                self._drive(FWD_DUTY, MOVE_S)
                self._drive(STOP_DUTY, PAUSE_S)
                self._drive(REV_DUTY, MOVE_S)
                self._drive(STOP_DUTY, PAUSE_S)
            finally:
                # Always silence the line, even if interrupted, so a continuous
                # servo never keeps spinning on an unattended STOP-creep.
                self.pwm.ChangeDutyCycle(0)
            # Let the servo fully coast to rest before releasing the
            # interlock, so the magazine cannot start rotating while the
            # pusher is still returning.
            time.sleep(SETTLE_S)

    def cleanup(self) -> None:
        if self.pwm is not None:
            try:
                self.pwm.ChangeDutyCycle(0)
                self.pwm.stop()
            except Exception:
                log.exception("Ejector PWM stop failed (continuing)")
        if self.gpio is not None:
            try:
                self.gpio.cleanup(PIN_SERVO)
            except Exception:
                log.exception("Ejector cleanup failed (continuing)")
