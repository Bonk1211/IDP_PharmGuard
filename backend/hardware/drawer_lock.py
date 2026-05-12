"""
Drawer lock — SG90 servo arm holds / releases the patient drawer latch.

Public API mirrors the previous solenoid version so callers (cycle
runner, bench scripts, tests) need no changes:

  DrawerLock()
  .is_stub          -> bool
  .is_unlocked      -> bool
  .unlock()         -> rotate servo to UNLOCK angle
  .lock()           -> rotate servo back to LOCK angle
  .hold_unlocked(s) -> unlock for s seconds, then lock (try/finally)
  .cleanup()        -> stop PWM + free pin

Wiring (SG90 micro servo on hardware PWM0):
    Signal (orange) -> Pi BCM 18 (phys 12)
    V+     (red)    -> external 5V (NOT Pi 5V — stall ~700 mA)
    GND    (brown)  -> external 5V GND AND Pi GND

50 Hz PWM. SG90 180-degree clones in practice map their full sweep
to roughly 0.5 ms -> 2.5 ms pulses (2.5 % -> 12.5 % duty at 50 Hz),
NOT the textbook 1.0 -> 2.0 ms. Using only 5 %-10 % gives ~90 deg of
travel.

Going past the servo's mechanical end-stop draws stall current -> arm
buzzes / appears stuck. Tune by stepping UNLOCK_DUTY down from 12.5 in
0.5 % steps until the buzz stops; do the same with LOCK_DUTY up from
2.5. The window between LOCK_DUTY and UNLOCK_DUTY is the effective
swing.

If the servo runs the wrong way, swap LOCK_DUTY <-> UNLOCK_DUTY.

Fail-safe:
  * Boot: PWM starts at 0 (servo unpowered, holds last position) +
    immediate move_to LOCK angle. If the previous shutdown was clean
    the servo is already at LOCK; this call is a no-op.
  * Mechanical: install a spring-return latch so a power-off servo
    drifts to LOCK by physical bias.
  * HI-012: cycle never calls unlock() in stub mode — preserved.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# Hardware PWM0 on Pi 5. Free now that the diverter is gone (was on PWM1).
PIN_SERVO = 18

# 50 Hz PWM. SG90 180-deg pulse map:
#   1.0 ms ( 5.0 %) ->   0 deg
#   1.5 ms ( 7.5 %) ->  90 deg
#   2.0 ms (10.0 %) -> 180 deg
# Anything outside 5.0–10.0 % drives the gear into the internal end-stop.
# Leave ~0.5 % margin so unit-to-unit variance doesn't push us past it.
LOCK_DUTY = 2.5    # ~0.5 ms pulse — target 0 deg (latch engaged)
UNLOCK_DUTY = 12.5 # ~2.5 ms pulse — target 180 deg (latch released)
# If unlock buzzes at end-of-travel, step down to 12.0 / 11.5 / 11.0
# until it goes silent. Same for lock: nudge up from 2.5 if it buzzes.

# How long the drawer stays unlocked per dispense.
DRAWER_OPEN_S = 10.0
# Settle time after a duty change so the servo reaches the target angle
# before we drive duty=0 (which de-energises the coils). SG90 sweeps
# ~60 deg in 0.1 s unloaded, so a full ~150 deg swing needs ~0.3 s; add
# margin for load + end-of-travel deceleration.
SERVO_SETTLE_S = 0.8

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class DrawerLock:
    def __init__(self) -> None:
        self.gpio: Any = None
        self.pwm: Any = None
        self._is_stub: bool = False
        self._is_unlocked: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            # initial=GPIO.LOW required on Pi 5 + rpi-lgpio 0.6 (see magazine.py).
            GPIO.setup(PIN_SERVO, GPIO.OUT, initial=GPIO.LOW)
            self.pwm = GPIO.PWM(PIN_SERVO, 50)  # 50 Hz for hobby servos
            self.pwm.start(0)
            self.gpio = GPIO
            self._is_stub = False
            # Drive to LOCK at boot so the drawer is in a known state.
            self.pwm.ChangeDutyCycle(LOCK_DUTY)
            time.sleep(SERVO_SETTLE_S)
            self.pwm.ChangeDutyCycle(0)
            log.info("DrawerLock servo initialized on BCM %d (locked)", PIN_SERVO)
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
                    "DrawerLock: GPIO init failed; "
                    "set PHARMGUARD_STUB=1 to allow stub mode"
                ) from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    @property
    def is_unlocked(self) -> bool:
        return self._is_unlocked

    def unlock(self) -> None:
        """Rotate the servo arm to the UNLOCK angle."""
        if self._is_stub:
            log.debug("stub: would unlock drawer")
            self._is_unlocked = True
            return

        log.info("DrawerLock -> UNLOCK")
        self.pwm.ChangeDutyCycle(UNLOCK_DUTY)
        time.sleep(SERVO_SETTLE_S)
        self.pwm.ChangeDutyCycle(0)  # de-energise so the coils don't sing
        self._is_unlocked = True

    def lock(self) -> None:
        """Rotate the servo arm back to the LOCK angle."""
        if self._is_stub:
            log.debug("stub: would lock drawer")
            self._is_unlocked = False
            return

        log.info("DrawerLock -> LOCK")
        self.pwm.ChangeDutyCycle(LOCK_DUTY)
        time.sleep(SERVO_SETTLE_S)
        self.pwm.ChangeDutyCycle(0)
        self._is_unlocked = False

    def hold_unlocked(self, duration_s: float = DRAWER_OPEN_S) -> None:
        """Convenience: unlock for `duration_s`, then re-lock.

        The patient pulls the drawer during this window; closing it is a
        manual action. After `duration_s` the servo rotates back to the
        LOCK angle. try/finally guarantees we re-lock even if
        time.sleep is interrupted (KeyboardInterrupt, signal).
        """
        self.unlock()
        try:
            time.sleep(duration_s)
        finally:
            self.lock()

    def cleanup(self) -> None:
        if self.pwm is not None:
            try:
                # Final drive-to-lock so we exit in a known state.
                self.pwm.ChangeDutyCycle(LOCK_DUTY)
                time.sleep(SERVO_SETTLE_S)
                self.pwm.ChangeDutyCycle(0)
                self.pwm.stop()
            except Exception:
                log.exception("DrawerLock PWM stop failed (continuing)")
        if self.gpio is not None:
            try:
                self.gpio.cleanup(PIN_SERVO)
            except Exception:
                log.exception("DrawerLock cleanup failed (continuing)")
