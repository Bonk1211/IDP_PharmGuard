"""Tests for hardware.diverter (HI-012 fail-loud + servo PWM transitions)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def test_init_raises_in_prod_mode(prod_env: None) -> None:
    from hardware.diverter import Diverter

    with pytest.raises(RuntimeError, match="PHARMGUARD_STUB=1"):
        Diverter()


def test_init_succeeds_as_stub(stub_env: None) -> None:
    from hardware.diverter import Diverter

    d = Diverter()
    assert d.is_stub is True
    assert d.pwm is None


def test_deliver_and_reject_noop_in_stub_mode(stub_env: None) -> None:
    from hardware.diverter import Diverter

    d = Diverter()
    d.deliver()  # must not raise
    d.reject()  # must not raise


def test_reject_drives_servo_through_reject_then_deliver_duty(
    prod_env: None, gpio_mock: MagicMock, no_sleep: None
) -> None:
    from hardware.diverter import DELIVER_DUTY, REJECT_DUTY, Diverter

    d = Diverter()
    assert not d.is_stub

    pwm = gpio_mock.PWM.return_value
    pwm.ChangeDutyCycle.reset_mock()
    d.reject()

    duties = [c.args[0] for c in pwm.ChangeDutyCycle.call_args_list]
    # reject() sweeps to REJECT, returns to DELIVER, then silences the line.
    assert duties == [REJECT_DUTY, DELIVER_DUTY, 0]


def test_deliver_drives_servo_to_deliver_duty(
    prod_env: None, gpio_mock: MagicMock, no_sleep: None
) -> None:
    from hardware.diverter import DELIVER_DUTY, Diverter

    d = Diverter()
    pwm = gpio_mock.PWM.return_value
    pwm.ChangeDutyCycle.reset_mock()
    d.deliver()

    duties = [c.args[0] for c in pwm.ChangeDutyCycle.call_args_list]
    assert duties == [DELIVER_DUTY, 0]
