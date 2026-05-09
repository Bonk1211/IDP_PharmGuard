"""
Drawer lock — solenoid that holds the patient collection drawer closed.
Energise (HIGH) to unlock; de-energise (LOW) to lock.
Fail-safe default: power loss => drawer stays locked.

GPIO pin: BCM 23 (free generic GPIO; no PWM needed).
"""

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# GPIO BCM pin driving the MOSFET / relay -> solenoid coil.
PIN_SOLENOID = 23

# How long the drawer is held unlocked per dispense. Long enough for the
# patient to pull the drawer open against the spring; the patient closes
# it manually before the next cycle.
DRAWER_OPEN_S = 10.0

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class DrawerLock:
    def __init__(self) -> None:
        self.gpio: Any = None
        self._is_stub: bool = False
        self._is_unlocked: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            # Fail-safe default: drawer stays locked at boot. Patient must
            # never see an open drawer just because the Pi power-cycled.
            # initial=GPIO.LOW required on Pi 5 + rpi-lgpio 0.6 (see magazine.py)
            # AND it serves as the locked-state default for HI-012 fail-safe.
            GPIO.setup(PIN_SOLENOID, GPIO.OUT, initial=GPIO.LOW)
            self.gpio = GPIO
            self._is_stub = False
            log.info("DrawerLock GPIO initialized (locked)")
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
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
        """Energise the solenoid so the patient can pull the drawer open."""
        if self._is_stub:
            log.debug("stub: would unlock drawer")
            self._is_unlocked = True
            return

        log.info("DrawerLock -> UNLOCK")
        self.gpio.output(PIN_SOLENOID, self.gpio.HIGH)
        self._is_unlocked = True

    def lock(self) -> None:
        """De-energise the solenoid; spring-loaded latch re-engages."""
        if self._is_stub:
            log.debug("stub: would lock drawer")
            self._is_unlocked = False
            return

        log.info("DrawerLock -> LOCK")
        self.gpio.output(PIN_SOLENOID, self.gpio.LOW)
        self._is_unlocked = False

    def hold_unlocked(self, duration_s: float = DRAWER_OPEN_S) -> None:
        """Convenience: unlock for `duration_s`, then re-lock.

        The patient pulls the drawer during this window; closing it is a
        manual action. After `duration_s` the solenoid de-energises and
        the spring-loaded latch re-engages on the next close. The
        try/finally guarantees we re-lock even if `time.sleep` is
        interrupted (KeyboardInterrupt, signal).
        """
        self.unlock()
        try:
            time.sleep(duration_s)
        finally:
            self.lock()

    def cleanup(self) -> None:
        if self.gpio is not None:
            # Belt-and-braces: explicitly de-energise before global cleanup.
            try:
                self.gpio.output(PIN_SOLENOID, self.gpio.LOW)
            except Exception:
                log.exception("DrawerLock: failed to drive pin LOW on cleanup")
            self.gpio.cleanup(PIN_SOLENOID)
