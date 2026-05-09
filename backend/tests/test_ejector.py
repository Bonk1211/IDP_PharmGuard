"""Tests for hardware.ejector (HI-012 fail-loud)."""

from __future__ import annotations

import pytest


def test_init_raises_in_prod_mode(prod_env: None) -> None:
    from hardware.ejector import Ejector

    with pytest.raises(RuntimeError, match="PHARMGUARD_STUB=1"):
        Ejector()


def test_init_succeeds_as_stub(stub_env: None) -> None:
    from hardware.ejector import Ejector

    ej = Ejector()
    assert ej.is_stub is True
    assert ej.pwm is None


def test_push_noop_in_stub_mode(stub_env: None) -> None:
    from hardware.ejector import Ejector

    ej = Ejector()
    ej.push()  # must not raise
