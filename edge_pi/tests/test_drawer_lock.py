"""Tests for hardware.drawer_lock (HI-012 fail-loud + fail-safe lock default)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def test_init_raises_in_prod_mode(prod_env: None) -> None:
    from hardware.drawer_lock import DrawerLock

    with pytest.raises(RuntimeError, match="PHARMGUARD_STUB=1"):
        DrawerLock()


def test_init_succeeds_as_stub(stub_env: None) -> None:
    from hardware.drawer_lock import DrawerLock

    d = DrawerLock()
    assert d.is_stub is True
    assert d.gpio is None
    assert d.is_unlocked is False


def test_unlock_lock_round_trip_in_stub(stub_env: None) -> None:
    from hardware.drawer_lock import DrawerLock

    d = DrawerLock()
    assert d.is_unlocked is False
    d.unlock()
    assert d.is_unlocked is True
    d.lock()
    assert d.is_unlocked is False


def test_init_drives_pin_low_failsafe(
    prod_env: None, gpio_mock: MagicMock
) -> None:
    from hardware.drawer_lock import PIN_SOLENOID, DrawerLock

    d = DrawerLock()
    assert not d.is_stub

    # First write to PIN_SOLENOID after setup must be LOW (fail-safe lock).
    first_solenoid = next(
        c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_SOLENOID
    )
    assert first_solenoid.args[1] == gpio_mock.LOW


def test_unlock_drives_high_then_lock_drives_low(
    prod_env: None, gpio_mock: MagicMock
) -> None:
    from hardware.drawer_lock import PIN_SOLENOID, DrawerLock

    d = DrawerLock()
    gpio_mock.output.reset_mock()

    d.unlock()
    d.lock()

    pin_writes = [
        c.args[1] for c in gpio_mock.output.call_args_list if c.args[0] == PIN_SOLENOID
    ]
    assert pin_writes == [gpio_mock.HIGH, gpio_mock.LOW]
    assert d.is_unlocked is False


def test_hold_unlocked_locks_after_duration(
    prod_env: None, gpio_mock: MagicMock, no_sleep: None
) -> None:
    from hardware.drawer_lock import PIN_SOLENOID, DrawerLock

    d = DrawerLock()
    gpio_mock.output.reset_mock()

    d.hold_unlocked(duration_s=0.0)

    pin_writes = [
        c.args[1] for c in gpio_mock.output.call_args_list if c.args[0] == PIN_SOLENOID
    ]
    assert pin_writes == [gpio_mock.HIGH, gpio_mock.LOW]
    assert d.is_unlocked is False
