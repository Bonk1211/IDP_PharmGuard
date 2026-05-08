"""
Tray temperature sensor — DS18B20 over 1-wire.

Reads /sys/bus/w1/devices/28-*/w1_slave; no third-party dependency. Enable on
the Pi 5 with `dtoverlay=w1-gpio` in /boot/firmware/config.txt and a 4.7 kohm
pull-up between data and 3V3 (single-sensor wiring).

STUB_FAIL_LOUD: refuses to construct on dev hosts unless PHARMGUARD_STUB=1.
Stub mode returns the same canned value every read; the backend treats it as
below-threshold so no alerts are forged. HI-012 invariant preserved.
"""

from __future__ import annotations

import glob
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

W1_DEVICES_GLOB = "/sys/bus/w1/devices/28-*/w1_slave"
STUB_TEMP_C = 22.0  # safe-room value; below the 30 C default backend threshold

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class TempSensor:
    """DS18B20 1-wire reader. One sensor only; multi-sensor support deferred."""

    def __init__(self) -> None:
        self.device_path: Path | None = None
        self._is_stub: bool = False
        self._init_device()

    def _init_device(self) -> None:
        paths = sorted(glob.glob(W1_DEVICES_GLOB))
        if paths:
            self.device_path = Path(paths[0])
            self._is_stub = False
            log.info("DS18B20 1-wire device found at %s", self.device_path)
            return

        if STUB_ALLOWED:
            log.warning(
                "1-wire device not present at %s — stub mode (PHARMGUARD_STUB=1)",
                W1_DEVICES_GLOB,
            )
            self.device_path = None
            self._is_stub = True
            return

        raise RuntimeError(
            "TempSensor: no 1-wire device under /sys/bus/w1/devices/28-*; "
            "set PHARMGUARD_STUB=1 to allow stub mode"
        )

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def read_celsius(self) -> float | None:
        """Return the latest temperature in C, or None if the read failed.

        Stub mode returns a constant safe-room value (22 C). Never invents an
        over-threshold reading.
        """
        if self._is_stub:
            log.debug("stub: would read DS18B20")
            return STUB_TEMP_C

        assert self.device_path is not None  # set by _init_device when not stub
        try:
            raw = self.device_path.read_text().splitlines()
        except OSError:
            log.exception("Failed to read 1-wire device %s", self.device_path)
            return None

        # File format (current Linux w1-gpio):
        #   <hex bytes> : crc=XX YES
        #   <hex bytes> t=23437
        # Use rfind to be tolerant of legacy / future kernel format drift.
        if len(raw) < 2 or "YES" not in raw[0]:
            log.warning("DS18B20 CRC bad: %r", raw)
            return None
        marker = raw[1].rfind("t=")
        if marker == -1:
            log.warning("DS18B20 unrecognized payload: %r", raw)
            return None
        try:
            millicelsius = int(raw[1][marker + 2:])
        except ValueError:
            log.warning("DS18B20 unparseable payload: %r", raw)
            return None
        return millicelsius / 1000.0
