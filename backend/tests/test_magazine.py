"""Tests for hardware.magazine (HI-009 shortest-path, HI-012 fail-loud)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def test_rotate_in_bounds(stub_env: None) -> None:
    from hardware.magazine import Magazine

    mag = Magazine()
    mag.rotate_to(3)
    assert mag.current_slot == 3


def test_rotate_negative_raises_value_error(stub_env: None) -> None:
    from hardware.magazine import Magazine

    mag = Magazine()
    with pytest.raises(ValueError):
        mag.rotate_to(-1)


def test_rotate_out_of_range_raises_value_error(stub_env: None) -> None:
    from hardware.magazine import Magazine

    mag = Magazine()
    with pytest.raises(ValueError):
        mag.rotate_to(10)


def test_shortest_path_forward(
    prod_env: None, gpio_mock: MagicMock, no_sleep: None
) -> None:
    from hardware.magazine import PIN_DIR, PIN_STEP, STEPS_PER_SLOT, Magazine

    mag = Magazine()
    assert not mag.is_stub  # gpio_mock made init succeed

    gpio_mock.output.reset_mock()
    mag.rotate_to(3)

    # Direction should be set HIGH (forward) exactly once.
    dir_calls = [c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_DIR]
    assert dir_calls == [((PIN_DIR, gpio_mock.HIGH),)]

    # STEP toggles HIGH+LOW per step → 2 * steps PIN_STEP calls.
    step_calls = [c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_STEP]
    assert len(step_calls) == 2 * 3 * STEPS_PER_SLOT
    assert mag.current_slot == 3


def test_shortest_path_reverse(
    prod_env: None, gpio_mock: MagicMock, no_sleep: None
) -> None:
    from hardware.magazine import PIN_DIR, PIN_STEP, STEPS_PER_SLOT, Magazine

    mag = Magazine()
    gpio_mock.output.reset_mock()

    # 0 -> 7: forward = 7 slots, reverse = 3 slots → reverse wins.
    mag.rotate_to(7)

    dir_calls = [c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_DIR]
    assert dir_calls == [((PIN_DIR, gpio_mock.LOW),)]

    step_calls = [c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_STEP]
    assert len(step_calls) == 2 * 3 * STEPS_PER_SLOT
    assert mag.current_slot == 7


def test_wrap_around_at_boundary(
    prod_env: None, gpio_mock: MagicMock, no_sleep: None
) -> None:
    from hardware.magazine import PIN_DIR, PIN_STEP, STEPS_PER_SLOT, Magazine

    mag = Magazine()
    mag.current_slot = 9
    gpio_mock.output.reset_mock()

    # 9 -> 0: forward = 1 slot, reverse = 9 slots → forward wins.
    mag.rotate_to(0)

    dir_calls = [c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_DIR]
    assert dir_calls == [((PIN_DIR, gpio_mock.HIGH),)]

    step_calls = [c for c in gpio_mock.output.call_args_list if c.args[0] == PIN_STEP]
    assert len(step_calls) == 2 * 1 * STEPS_PER_SLOT
    assert mag.current_slot == 0


def test_init_raises_in_prod_mode_when_gpio_unavailable(prod_env: None) -> None:
    # No gpio_mock fixture → RPi.GPIO import fails on Mac → must raise.
    from hardware.magazine import Magazine

    with pytest.raises(RuntimeError, match="PHARMGUARD_STUB=1"):
        Magazine()


def test_init_succeeds_as_stub_when_PHARMGUARD_STUB_set(stub_env: None) -> None:
    from hardware.magazine import Magazine

    mag = Magazine()
    assert mag.is_stub is True
    assert mag.gpio is None
