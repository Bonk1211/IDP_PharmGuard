"""
Tray temperature sensor — DHT11 over a single GPIO data line.

Wiring (BCM 23, physical pin 16):
    DHT11 VCC  -> Pi 3V3 (pin 1)
    DHT11 DATA -> Pi BCM 23 (pin 16)  + 10 kohm pull-up to 3V3
    DHT11 GND  -> Pi GND  (pin 9)

(Was BCM 4 originally; moved because Pi 5 kernel can claim BCM 4 for
w1-gpio / camera-i2c overlays, leaving lgpio with 'GPIO busy'. BCM 23
is plain GPIO with no peripheral aliasing — free since we removed the
solenoid drawer-lock.)

DHT11 quirks vs DS18B20:
  * Bit-banged single-wire protocol; we use adafruit-circuitpython-dht which
    drives libgpiod for precise pulse timing on the Pi 5.
  * 1 C resolution, +/- 2 C accuracy. Below DS18B20's +/- 0.5 C — adequate
    for the 30 C tray-overheat threshold but not for clinical-grade telemetry.
  * Max read rate ~1 Hz. Reading more often raises RuntimeError.
  * ~10 % of reads fail with a checksum / timing error; retry up to 3 times
    before returning None. Backend treats None as "no datum", not as cold.

STUB_FAIL_LOUD: refuses to construct on dev hosts (no GPIO) unless
PHARMGUARD_STUB=1. Stub mode returns the same canned value every read; the
backend treats it as below-threshold so no alerts are forged. HI-012
invariant preserved.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# BCM 23 / physical pin 16. Re-using the pin freed when we dropped the
# solenoid drawer-lock — plain GPIO, no peripheral aliasing.
DHT_BCM_PIN = 23
STUB_TEMP_C = 22.0  # safe-room value; below the 30 C default backend threshold
READ_RETRIES = 3
RETRY_BACKOFF_S = 1.1  # DHT11 needs ~1 s between successful reads

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class TempSensor:
    """DHT11 reader. Public interface preserved from the DS18B20 version."""

    def __init__(self) -> None:
        self._sensor: Any = None
        self._is_stub: bool = False
        self._init_device()

    def _init_device(self) -> None:
        try:
            import adafruit_dht
            import board

            # board.D23 = BCM 23. Keep this attribute name in sync with
            # DHT_BCM_PIN above — adafruit-blinka exposes board.D0 .. D27.
            self._sensor = adafruit_dht.DHT11(board.D23, use_pulseio=False)
            self._is_stub = False
            log.info("DHT11 initialized on BCM %d", DHT_BCM_PIN)
            return
        except Exception as exc:
            if STUB_ALLOWED:
                log.warning(
                    "DHT11 unavailable (%s) — stub mode (PHARMGUARD_STUB=1)",
                    exc,
                )
                self._sensor = None
                self._is_stub = True
                return
            raise RuntimeError(
                f"TempSensor: DHT11 init failed ({exc}); set PHARMGUARD_STUB=1 "
                "to allow stub mode, or check the data-line pull-up."
            )

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def read_celsius(self) -> float | None:
        """Return the latest temperature in C, or None if all retries failed.

        Stub mode returns a constant safe-room value (22 C). Never invents an
        over-threshold reading. A None return means "no datum this cycle" —
        the caller (main.py) is expected to skip the temp report, NOT to
        synthesize a fallback value.
        """
        if self._is_stub:
            log.debug("stub: would read DHT11")
            return STUB_TEMP_C

        assert self._sensor is not None  # set by _init_device when not stub
        last_exc: Exception | None = None
        for attempt in range(1, READ_RETRIES + 1):
            try:
                value = self._sensor.temperature
                if value is None:
                    last_exc = RuntimeError("DHT11 returned None")
                else:
                    return float(value)
            except RuntimeError as exc:
                # adafruit_dht raises RuntimeError on checksum / timing fails.
                last_exc = exc
            if attempt < READ_RETRIES:
                time.sleep(RETRY_BACKOFF_S)

        log.warning("DHT11 read failed after %d attempts: %s", READ_RETRIES, last_exc)
        return None
