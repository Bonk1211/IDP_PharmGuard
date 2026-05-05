"""Shared pytest fixtures for edge_pi tests.

Tests run cross-platform (Mac/Linux dev boxes have no RPi.GPIO);
the stub_env / prod_env fixtures flip PHARMGUARD_STUB so we can
exercise both fail-loud and degraded paths without real hardware.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterator
from unittest.mock import MagicMock

import pytest

# Make `edge_pi/` importable as the package root for `hardware.*` imports.
EDGE_PI_ROOT = Path(__file__).resolve().parent.parent
if str(EDGE_PI_ROOT) not in sys.path:
    sys.path.insert(0, str(EDGE_PI_ROOT))


def _reload_hardware_modules() -> None:
    # Module-level STUB_ALLOWED is captured at import; drop cached modules
    # so the next import re-reads PHARMGUARD_STUB from the patched env.
    for mod in ("hardware.magazine", "hardware.ejector"):
        sys.modules.pop(mod, None)


@pytest.fixture
def stub_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("PHARMGUARD_STUB", "1")
    _reload_hardware_modules()
    yield
    _reload_hardware_modules()


@pytest.fixture
def prod_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("PHARMGUARD_STUB", "0")
    _reload_hardware_modules()
    yield
    _reload_hardware_modules()


@pytest.fixture
def gpio_mock(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Inject a fake `RPi.GPIO` module so hardware __init__ takes the real path.

    Returned MagicMock is the GPIO module itself; tests can read .output.call_args_list
    to assert pin toggling behavior.
    """
    fake = MagicMock()
    fake.BCM = "BCM"
    fake.OUT = "OUT"
    fake.HIGH = 1
    fake.LOW = 0
    # PWM() returns a sub-mock so .start / .ChangeDutyCycle work.
    fake.PWM.return_value = MagicMock()

    fake_pkg = MagicMock()
    fake_pkg.GPIO = fake
    monkeypatch.setitem(sys.modules, "RPi", fake_pkg)
    monkeypatch.setitem(sys.modules, "RPi.GPIO", fake)
    _reload_hardware_modules()
    return fake


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip time.sleep in the stepping loop so tests run instantly."""
    import time as _time

    monkeypatch.setattr(_time, "sleep", lambda _s: None)
