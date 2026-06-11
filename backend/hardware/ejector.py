"""
Pill ejector — MG996R continuous-rotation servo on 50 Hz PWM.

Public API matches the previous stepper version so callers (cycle
runner, device API, bench scripts) need no changes:

  Ejector()
  .is_stub            -> bool
  .push()             -> one eject motion (forward, then ALWAYS return home)
  .home()             -> run just the return-home stroke (idempotent)
  .get_calibration()  -> current servo motion params as a dict
  .set_calibration()  -> update + persist params (operator calibration)
  .cleanup()          -> stop PWM + free pin

Continuous-rotation servos read pulse WIDTH as speed+direction, not
angle: ~1500 us = stop, >1500 = one way, <1500 = the other. Further
from 1500 = faster. They have NO absolute-position feedback, so the
pusher is returned "home" purely by driving the reverse stroke for the
same duration as the forward stroke. Because that is open-loop, the
return-home stroke is run in a ``finally`` so it executes even when the
forward stroke is interrupted — the pusher is never left extended to
foul the next magazine rotation (see hardware/interlock.py).

Motion parameters are operator-tunable at runtime (dashboard Advanced
tab -> /api/device/calibration) and persisted to CALIBRATION_PATH so a
hand-calibrated servo survives restarts. Defaults below command full
drive for ONE short stroke — distance from 1500 us sets how hard the
controller drives the motor (near-center values like 1600/1400 stall
under load), and move_s sets stroke length (~1 s ≈ one revolution at
full drive):
  FWD = 2000 us   REV = 1000 us   STOP = 1500 us
  MOVE = 1.0 s    REV_MOVE = 1.2 s    PAUSE = 1.0 s
The return stroke has its OWN duration (rev_move_s) because the
open-loop return often needs longer than the push (friction, load,
direction asymmetry). Slightly overdriving the return is safe when the
pusher has a mechanical home stop — it guarantees a full re-seat.
fwd_us and rev_us MUST be on opposite sides of 1500 — if both sit on
the same side the "return home" stroke drives forward again and the
pusher never comes back. If it spins the wrong way, swap fwd_us/rev_us.
If it creeps while "stopped", trim stop_us in ~5 us (0.1 % duty) steps.

Wiring (MG996R on hardware-PWM-capable BCM 13 / phys 33):
    Signal (orange/white) -> Pi BCM 13 (phys 33)
    V+     (red)          -> external 5-6 V (NOT Pi 5 V — stall ~2.5 A)
    GND    (brown/black)  -> external supply GND AND Pi GND
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, fields, replace
from pathlib import Path
from typing import Any

from hardware.interlock import ACTUATOR_LOCK, SETTLE_S

log = logging.getLogger(__name__)

# MG996R signal pin. Hardware-PWM-capable, free now that the ULN2003
# stepper (BCM 5/6/16/26) and the drawer SG90 (BCM 18) are gone.
PIN_SERVO = 13
PWM_HZ = 50


# Pulse-us -> duty-% at 50 Hz: duty = pulse_us / (1e6 / PWM_HZ) * 100
#   1500 us -> 7.5 %   (STOP)
#   2000 us -> 10.0 %  (FORWARD — further from 1500 = faster/stronger)
#   1000 us -> 5.0 %   (REVERSE)
def _us_to_duty(pulse_us: float) -> float:
    return pulse_us / (1_000_000 / PWM_HZ) * 100.0


# Full-drive, single-short-stroke defaults (see module docstring).
# Operators override these via set_calibration(); overrides persist to
# CALIBRATION_PATH and are reloaded on next boot.
DEFAULT_FWD_US = 2000.0
DEFAULT_REV_US = 1000.0
DEFAULT_STOP_US = 1500.0
DEFAULT_MOVE_S = 1.0
DEFAULT_REV_MOVE_S = 1.2
DEFAULT_PAUSE_S = 1.0

# Safety bounds — a bad calibration must never command an out-of-range
# pulse or an absurd stroke length. Mirrored by the API pydantic Fields.
US_MIN, US_MAX = 1000.0, 2000.0
MOVE_S_MIN, MOVE_S_MAX = 0.1, 30.0
PAUSE_S_MIN, PAUSE_S_MAX = 0.0, 10.0

# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"

# Per-device calibration file. Pi-local (calibration is physical to one
# machine), env-overridable, mirrors config.offline_queue_path resolution.
CALIBRATION_PATH = os.environ.get(
    "EJECTOR_CALIBRATION_PATH",
    str(Path.home() / ".pharmguard" / "ejector_calibration.json"),
)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


@dataclass
class EjectorCalibration:
    """Operator-tunable servo motion parameters.

    fwd_us / rev_us : pulse width for the forward (eject) and return
        (home) strokes. STOP is ``stop_us``. move_s is how long the
        forward stroke is driven; rev_move_s is how long the return
        stroke is driven (often needs to exceed move_s to fully re-seat
        the pusher), so rev_us + rev_move_s together set the homing
        motion.
    """

    fwd_us: float = DEFAULT_FWD_US
    rev_us: float = DEFAULT_REV_US
    stop_us: float = DEFAULT_STOP_US
    move_s: float = DEFAULT_MOVE_S
    rev_move_s: float = DEFAULT_REV_MOVE_S
    pause_s: float = DEFAULT_PAUSE_S

    def clamped(self) -> "EjectorCalibration":
        return EjectorCalibration(
            fwd_us=_clamp(self.fwd_us, US_MIN, US_MAX),
            rev_us=_clamp(self.rev_us, US_MIN, US_MAX),
            stop_us=_clamp(self.stop_us, US_MIN, US_MAX),
            move_s=_clamp(self.move_s, MOVE_S_MIN, MOVE_S_MAX),
            rev_move_s=_clamp(self.rev_move_s, MOVE_S_MIN, MOVE_S_MAX),
            pause_s=_clamp(self.pause_s, PAUSE_S_MIN, PAUSE_S_MAX),
        )

    @classmethod
    def from_dict(cls, d: dict) -> "EjectorCalibration":
        """Build from a (possibly partial) dict, ignoring unknown keys and
        falling back to defaults for anything missing. Always clamped."""
        known = {f.name for f in fields(cls)}
        merged = {
            k: float(d[k]) for k in known if k in d and d[k] is not None
        }
        return replace(cls(), **merged).clamped()

    def to_dict(self) -> dict:
        return asdict(self)


def _load_calibration() -> EjectorCalibration:
    """Read persisted calibration, or fall back to defaults. Never raises."""
    try:
        with open(CALIBRATION_PATH) as fh:
            data = json.load(fh)
        cal = EjectorCalibration.from_dict(data)
        log.info("Ejector calibration loaded from %s: %s", CALIBRATION_PATH, cal.to_dict())
        return cal
    except FileNotFoundError:
        log.info("No ejector calibration at %s — using defaults", CALIBRATION_PATH)
        return EjectorCalibration()
    except Exception:
        log.exception("Failed to read ejector calibration; using defaults")
        return EjectorCalibration()


def _save_calibration(cal: EjectorCalibration) -> None:
    """Persist calibration atomically (write temp + rename)."""
    path = Path(CALIBRATION_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w") as fh:
        json.dump(cal.to_dict(), fh, indent=2)
    tmp.replace(path)


class Ejector:
    def __init__(self) -> None:
        self.gpio: Any = None
        self.pwm: Any = None
        self._is_stub: bool = False
        # Load persisted calibration before touching GPIO so the boot-to-STOP
        # pulse uses the operator-trimmed stop value.
        self.cal: EjectorCalibration = _load_calibration()
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
            self.pwm.ChangeDutyCycle(_us_to_duty(self.cal.stop_us))
            time.sleep(self.cal.pause_s)
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

    def _drive(self, pulse_us: float, hold_s: float) -> None:
        """Hold a PWM pulse width for hold_s seconds (continuous-servo speed cmd)."""
        self.pwm.ChangeDutyCycle(_us_to_duty(pulse_us))
        time.sleep(hold_s)

    def _return_home_locked(self) -> None:
        """Drive the reverse stroke that brings the pusher back to home.

        Lock-free internal — the caller MUST already hold ACTUATOR_LOCK.
        Ends with PWM at 0 (no pulses -> servo fully stops, no creep) and a
        settle pause so the magazine cannot start rotating while the pusher
        is still coasting back.
        """
        try:
            self._drive(self.cal.rev_us, self.cal.rev_move_s)
            self._drive(self.cal.stop_us, self.cal.pause_s)
        finally:
            self.pwm.ChangeDutyCycle(0)
        time.sleep(SETTLE_S)

    def push(self) -> None:
        """One eject motion: forward stroke, then ALWAYS a return-home stroke.

        The return-home runs in a ``finally`` so it executes even if the
        forward stroke is interrupted — the pusher is never left extended.
        Holds ACTUATOR_LOCK for the whole motion so the magazine stepper
        cannot rotate while the pusher is mid-stroke (interlock.py).
        """
        if self._is_stub:
            log.debug("stub: would push")
            return

        log.info(
            "Ejecting pill (MG996R fwd %.1fs @ %.0fus, then home rev %.1fs @ %.0fus)",
            self.cal.move_s, self.cal.fwd_us, self.cal.rev_move_s, self.cal.rev_us,
        )
        with ACTUATOR_LOCK:
            try:
                # Forward stroke — extend the pusher to eject the pill.
                self._drive(self.cal.fwd_us, self.cal.move_s)
                self._drive(self.cal.stop_us, self.cal.pause_s)
            finally:
                # Return-home stroke ALWAYS runs — even if the forward stroke
                # raised partway — so the pusher returns to its initial
                # position after every dispense and can never be left
                # extended to jam the next magazine rotation.
                self._return_home_locked()

    def home(self) -> None:
        """Run just the return-home (reverse) stroke.

        Idempotent — safe to call any time the pusher might be off home: at
        startup to establish a known datum, or as a manual recovery from the
        dashboard. No-op in stub mode.
        """
        if self._is_stub:
            log.debug("stub: would home")
            return
        log.info("Homing ejector (rev %.1fs @ %.0fus)", self.cal.rev_move_s, self.cal.rev_us)
        with ACTUATOR_LOCK:
            self._return_home_locked()

    def set_pulse(self, pulse_us: float) -> float:
        """Live-drive (jog): hold ``pulse_us`` on the signal line until the
        next set_pulse()/release_pulse() call.

        Powers the dashboard's potentiometer-style slider — each slider move
        lands here and the servo follows in real time. On a positional servo
        the pulse maps to an angle; on this continuous-rotation MG996R it maps
        to speed+direction (stop_us = stand still), so the caller is expected
        to release_pulse() when the operator lets go of the slider.

        Returns the clamped pulse actually applied. Raises RuntimeError if
        another actuator motion (eject stroke / magazine rotation) is in
        flight — jogging mid-stroke would violate the interlock.
        """
        pulse = _clamp(float(pulse_us), US_MIN, US_MAX)
        if self._is_stub:
            log.debug("stub: would jog to %.0fus", pulse)
            return pulse
        # Non-blocking probe only — the duty cycle persists after release,
        # which is exactly what lets the slider behave like a held knob.
        if not ACTUATOR_LOCK.acquire(blocking=False):
            raise RuntimeError("Actuators busy — wait for the current motion to finish")
        try:
            self.pwm.ChangeDutyCycle(_us_to_duty(pulse))
        finally:
            ACTUATOR_LOCK.release()
        return pulse

    def release_pulse(self) -> None:
        """End a jog: drop PWM to 0 so the servo gets no pulses at all.

        For the continuous MG996R this is a true stop (no creep); a
        positional servo simply loses holding torque and stays put.
        Idempotent and safe to call even if no jog is active.
        """
        if self._is_stub:
            log.debug("stub: would release jog")
            return
        self.pwm.ChangeDutyCycle(0)

    def get_calibration(self) -> dict:
        """Current servo motion parameters."""
        return self.cal.to_dict()

    def set_calibration(self, **updates: float) -> dict:
        """Merge ``updates`` into the current calibration, clamp, persist,
        and apply to this live instance. Returns the new calibration dict.

        Unknown keys are ignored; omitted keys keep their current value.
        Takes effect on the next push()/home() — no restart needed.
        """
        new = EjectorCalibration.from_dict({**self.cal.to_dict(), **updates})
        self.cal = new
        _save_calibration(new)
        log.info("Ejector calibration updated: %s", new.to_dict())
        return new.to_dict()

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
