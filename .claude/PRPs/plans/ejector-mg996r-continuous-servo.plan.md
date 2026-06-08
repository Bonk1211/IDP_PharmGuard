# Plan: Ejector — swap 28BYJ-48 stepper → MG996R continuous-rotation servo

## Summary
Re-implement `backend/hardware/ejector.py` to drive an **MG996R continuous-rotation
servo** via 50 Hz PWM instead of the current 28BYJ-48 stepper + ULN2003. Behavior
mirrors the supplied Arduino sketch: drive forward at 1600 µs for 7.5 s, stop 1 s,
reverse at 1400 µs for 7.5 s, stop 1 s. The public `Ejector` API
(`__init__` / `is_stub` / `push()` / `cleanup()`) is **unchanged**, so no call-site
edits are required — only the class internals and pin wiring change.

## User Story
As a **PharmGuard hardware integrator**, I want the **pill ejector driven by an
MG996R continuous-rotation servo using the same PWM timings as my bench-validated
Arduino sketch**, so that **the dispense cycle ejects pills with the new mechanism
without touching any of the upstream control logic**.

## Problem → Solution
**Current**: `Ejector` steps a 28BYJ-48 through `_HALF_STEP` on BCM 5/6/16/26 (ULN2003),
512 half-steps forward + 512 back per `push()`.
**Desired**: `Ejector` sends 50 Hz PWM to one signal pin driving an MG996R continuous
servo — `push()` runs the Arduino `loop()` body once (FWD → STOP → PAUSE → REV → STOP).

## Metadata
- **Complexity**: Small
- **Source PRD**: N/A (free-form, from supplied Arduino sketch)
- **PRD Phase**: N/A
- **Estimated Files**: 2 (rewrite `ejector.py`, doc-refresh `test_ejector.py`)

---

## UX Design

### Before
N/A — internal/hardware change. No user-facing UI.

### After
N/A — internal/hardware change. Dashboard "Dispense" still calls the same
`POST /api/device/eject` → `state.ejector.push()` path; only the actuator differs.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `Ejector.push()` runtime | ~2 s (512×2 ms ×2) | ~17 s (7.5 s + 1 s + 7.5 s + 1 s) | Tunable via `MOVE_S` / `PAUSE_S`. Flagged in Risks. |
| Wiring | ULN2003 IN1–4 on BCM 5/6/16/26 | 1 PWM signal on BCM 13 + external 5 V | Servo V+ on external 5 V, NOT Pi 5 V (stall ~2.5 A) |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `backend/hardware/drawer_lock.py` | 42–177 | **The pattern to clone.** Identical servo-PWM lifecycle: `GPIO.PWM(pin, 50)` → `start(0)` → `ChangeDutyCycle(x)` → `time.sleep` → `ChangeDutyCycle(0)`; stub fallback; scoped cleanup. |
| P0 (critical) | `backend/hardware/ejector.py` | 1–142 | File being rewritten. Preserve public API (`is_stub`, `push`, `cleanup`), `STUB_ALLOWED` import-time read, log style. |
| P1 (important) | `backend/hardware/magazine.py` | 43–55, 126–135 | Pi 5 + rpi-lgpio gotchas: `initial=GPIO.LOW` on `setup`, and scoped `GPIO.cleanup([pins])` (never bare `cleanup()`). |
| P1 (important) | `backend/scheduler/cycle_runner.py` | 87–102, 376–391 | Call sites: `Ejector()` init, `is_stub` gate, `push()` under `hardware_lock`. Confirms API contract that must NOT change. |
| P2 (reference) | `backend/api/device.py` | 117–138 | `manual_eject` calls `state.ejector.push()` under `hardware_lock`. No change needed. |
| P2 (reference) | `backend/hardware/test_ejector.py` | 1–57 | Bench harness to doc-refresh (calls `Ejector()/push()/cleanup()/is_stub` — all still valid). |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| MG996R continuous-rotation control | Standard hobby-servo 50 Hz PWM | Pulse width sets *speed+direction*, not angle: ~1500 µs = stop, >1500 = one way, <1500 = other. Matches supplied sketch (1600/1500/1400). |
| Pulse-µs → duty-% at 50 Hz | period = 1e6/50 = 20000 µs | `duty% = pulse_µs / 20000 × 100 = pulse_µs / 200`. So 1500→7.5 %, 1600→8.0 %, 1400→7.0 %. |
| rpi-lgpio `GPIO.PWM` | `requirements.txt:36` (`rpi-lgpio>=0.6`) | Drop-in `RPi.GPIO` shim already proven on BCM 18 in `drawer_lock.py`. Software-timed PWM; jitter is fine for a continuous servo (no hold-angle precision needed). |

> No further external research needed — this reuses the established internal
> `drawer_lock.py` servo pattern.

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: backend/hardware/drawer_lock.py:51-74
PIN_SERVO = 18
LOCK_DUTY = 2.5
UNLOCK_DUTY = 12.5
SERVO_SETTLE_S = 0.8
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"
```
→ Module-level UPPER_SNAKE constants; `STUB_ALLOWED` read once at import.

### SERVO_PWM_LIFECYCLE
```python
# SOURCE: backend/hardware/drawer_lock.py:85-100
GPIO.setmode(GPIO.BCM)
GPIO.setup(PIN_SERVO, GPIO.OUT, initial=GPIO.LOW)   # initial= required on Pi 5
self.pwm = GPIO.PWM(PIN_SERVO, 50)                  # 50 Hz hobby servo
self.pwm.start(0)
self.pwm.ChangeDutyCycle(LOCK_DUTY)
time.sleep(SERVO_SETTLE_S)
self.pwm.ChangeDutyCycle(0)                         # de-energise / silence
```

### STUB_FALLBACK
```python
# SOURCE: backend/hardware/ejector.py:85-96
except Exception as e:
    if STUB_ALLOWED:
        log.warning("GPIO unavailable — stub mode (PHARMGUARD_STUB=1)")
        self.gpio = None
        self._is_stub = True
    else:
        raise RuntimeError(
            "Ejector: GPIO init failed; set PHARMGUARD_STUB=1 to allow stub mode"
        ) from e
```

### STUB_GUARD_IN_ACTION
```python
# SOURCE: backend/hardware/drawer_lock.py:123-128
def unlock(self) -> None:
    if self._is_stub:
        log.debug("stub: would unlock drawer")
        self._is_unlocked = True
        return
    ...
```
→ Every motion method early-returns in stub mode (HI-012: never falsify hardware action).

### SCOPED_CLEANUP
```python
# SOURCE: backend/hardware/drawer_lock.py:163-177  + magazine.py:126-135
def cleanup(self) -> None:
    if self.pwm is not None:
        try:
            self.pwm.ChangeDutyCycle(0)
            self.pwm.stop()
        except Exception:
            log.exception("... PWM stop failed (continuing)")
    if self.gpio is not None:
        try:
            self.gpio.cleanup(PIN_SERVO)   # scoped — NEVER bare cleanup()
        except Exception:
            log.exception("... cleanup failed (continuing)")
```

### TEST_HARNESS
```python
# SOURCE: backend/hardware/test_ejector.py:34-52
ej = Ejector()
try:
    print(f"is_stub = {ej.is_stub}")
    for i in range(1, cycles + 1):
        ej.push()
        time.sleep(1.0)
finally:
    ej.cleanup()
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/hardware/ejector.py` | REWRITE | Replace stepper internals with MG996R PWM; keep public API identical. |
| `backend/hardware/test_ejector.py` | UPDATE | Refresh docstring + fail-modes (stepper → servo); API calls unchanged. |

## NOT Building
- **No changes to** `scheduler/cycle_runner.py`, `api/device.py`, `tests/conftest.py` — public `Ejector` API is preserved, so they keep working untouched.
- **No** new config/env var for pin or timings — constants live in `ejector.py` like every other hardware module (tune in-file, matching `EJECT_STEPS`/`LOCK_DUTY` precedent).
- **No** continuous free-running loop — `push()` runs the Arduino `loop()` body **once** (one eject); repetition is the bench script's job (mirrors how the stepper `push()` was one motion).
- **No** async/threading changes — callers already wrap `push()` in `asyncio.to_thread`.
- **No** removal of `drawer_lock.py` BCM 18 usage — new ejector uses a **different** pin (BCM 13) to avoid any claim collision.

---

## Step-by-Step Tasks

### Task 1: Rewrite `ejector.py` module header + constants
- **ACTION**: Replace the stepper docstring and the `_HALF_STEP`/`PIN_INx`/`EJECT_STEPS`/`STEP_DELAY_S` constants with MG996R servo equivalents.
- **IMPLEMENT**:
  ```python
  """
  Pill ejector — MG996R continuous-rotation servo on 50 Hz PWM.

  Public API matches the previous stepper version so callers (cycle
  runner, device API, bench scripts) need no changes:

    Ejector()
    .is_stub  -> bool
    .push()   -> one eject motion (forward, stop, reverse, stop)
    .cleanup() -> stop PWM + free pin

  Mirrors the bench-validated Arduino sketch (Servo.writeMicroseconds):
    FWD_PWM  = 1600 us   REV_PWM = 1400 us   STOP_PWM = 1500 us
    MOVE_MS  = 7500      PAUSE_MS = 1000
  Continuous-rotation servos read pulse WIDTH as speed+direction, not
  angle: ~1500 us = stop, >1500 = one way, <1500 = the other. Further
  from 1500 = faster. If it spins the wrong way, swap FWD_DUTY/REV_DUTY.
  If it creeps while "stopped", trim STOP_DUTY in 0.1 % steps.

  Wiring (MG996R on hardware-PWM-capable BCM 13 / phys 33):
      Signal (orange/white) -> Pi BCM 13 (phys 33)
      V+     (red)          -> external 5-6 V (NOT Pi 5 V — stall ~2.5 A)
      GND    (brown/black)  -> external supply GND AND Pi GND
  """

  from __future__ import annotations

  import logging
  import os
  import time
  from typing import Any

  log = logging.getLogger(__name__)

  # MG996R signal pin. Hardware-PWM-capable, free now that the ULN2003
  # stepper (BCM 5/6/16/26) is gone and the drawer SG90 owns BCM 18.
  PIN_SERVO = 13
  PWM_HZ = 50

  # Pulse-us -> duty-% at 50 Hz: duty = pulse_us / (1e6 / PWM_HZ) * 100
  #   1500 us -> 7.5 %   (STOP)
  #   1600 us -> 8.0 %   (FORWARD — further from 1500 = faster)
  #   1400 us -> 7.0 %   (REVERSE)
  def _us_to_duty(pulse_us: float) -> float:
      return pulse_us / (1_000_000 / PWM_HZ) * 100.0

  STOP_DUTY = _us_to_duty(1500)
  FWD_DUTY = _us_to_duty(1600)
  REV_DUTY = _us_to_duty(1400)

  # Arduino MOVE_MS / PAUSE_MS, in seconds.
  MOVE_S = 7.5
  PAUSE_S = 1.0

  STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"
  ```
- **MIRROR**: NAMING_CONVENTION + the pulse→duty note from External Documentation.
- **IMPORTS**: `logging`, `os`, `time`, `typing.Any` (same as current file — drop nothing else needed).
- **GOTCHA**: Keep `STUB_ALLOWED` at module top, read **once** at import — `conftest.py:_reload_hardware_modules` pops `hardware.ejector` from `sys.modules` so the next import re-reads the patched env. Do not move it into `__init__`.
- **VALIDATE**: `python -c "from hardware.ejector import STOP_DUTY, FWD_DUTY, REV_DUTY; print(STOP_DUTY, FWD_DUTY, REV_DUTY)"` prints `7.5 8.0 7.0`.

### Task 2: Rewrite `Ejector.__init__` + `_init_gpio` for PWM
- **ACTION**: Replace the 4-pin output setup with a single PWM channel, cloning `drawer_lock.py`.
- **IMPLEMENT**:
  ```python
  class Ejector:
      def __init__(self) -> None:
          self.gpio: Any = None
          self.pwm: Any = None
          self._is_stub: bool = False
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
              self.pwm.ChangeDutyCycle(STOP_DUTY)
              time.sleep(PAUSE_S)
              self.pwm.ChangeDutyCycle(0)
              log.info("Ejector MG996R initialized on BCM %d (stopped)", PIN_SERVO)
          except Exception as e:
              if STUB_ALLOWED:
                  log.warning("GPIO unavailable — stub mode (PHARMGUARD_STUB=1)")
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
  ```
- **MIRROR**: SERVO_PWM_LIFECYCLE + STUB_FALLBACK.
- **IMPORTS**: none new.
- **GOTCHA**: `initial=GPIO.LOW` is **required** on Pi 5 / rpi-lgpio 0.6 — without it the shim reads an unclaimed line and raises "GPIO not allocated" (`magazine.py:45-50`). Keep `self.pwm` attribute name so `cleanup()` mirrors `drawer_lock`.
- **VALIDATE**: `PHARMGUARD_STUB=1 python -c "from hardware.ejector import Ejector; e=Ejector(); print(e.is_stub)"` prints `True` and does not raise.

### Task 3: Rewrite `Ejector.push()` to the Arduino motion
- **ACTION**: Replace the half-step forward/back with the FWD→STOP→PAUSE→REV→STOP sequence.
- **IMPLEMENT**:
  ```python
  def _drive(self, duty: float, hold_s: float) -> None:
      """Hold a PWM duty for hold_s seconds (continuous-servo speed cmd)."""
      self.pwm.ChangeDutyCycle(duty)
      time.sleep(hold_s)

  def push(self) -> None:
      """One eject motion: forward, stop, reverse, stop.

      Mirrors one iteration of the Arduino loop(): FWD for MOVE_S, STOP
      for PAUSE_S, REV for MOVE_S, STOP for PAUSE_S. Ends with PWM at 0
      so the servo receives no pulses and fully stops (no creep).
      """
      if self._is_stub:
          log.debug("stub: would push")
          return

      log.info("Ejecting pill (MG996R fwd/rev %.1fs each)", MOVE_S)
      try:
          self._drive(FWD_DUTY, MOVE_S)
          self._drive(STOP_DUTY, PAUSE_S)
          self._drive(REV_DUTY, MOVE_S)
          self._drive(STOP_DUTY, PAUSE_S)
      finally:
          # Always silence the line, even if interrupted, so a continuous
          # servo never keeps spinning on an unattended STOP-creep.
          self.pwm.ChangeDutyCycle(0)
  ```
- **MIRROR**: SERVO_PWM_LIFECYCLE (duty → sleep → duty=0) + STUB_GUARD_IN_ACTION.
- **IMPORTS**: none new.
- **GOTCHA**: `try/finally` around the moves guarantees `ChangeDutyCycle(0)` runs on `KeyboardInterrupt`/signal — a continuous servo left at a slightly-off STOP duty will *creep forever*. This is the continuous-servo analog of `drawer_lock.hold_unlocked`'s try/finally.
- **VALIDATE**: stub-mode `push()` logs `stub: would push` and returns instantly (no `time.sleep`); real-mode is exercised in Task 5.

### Task 4: Rewrite `Ejector.cleanup()`
- **ACTION**: Replace the 4-pin de-energise + `cleanup([_PINS])` with PWM stop + scoped pin free.
- **IMPLEMENT**:
  ```python
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
  ```
- **MIRROR**: SCOPED_CLEANUP.
- **IMPORTS**: none new.
- **GOTCHA**: Pass `PIN_SERVO` to `GPIO.cleanup(...)`. A bare `GPIO.cleanup()` resets the global mode and breaks sibling `Magazine`/`DrawerLock` cleanups (`magazine.py:126-135`).
- **VALIDATE**: stub-mode `Ejector().cleanup()` does not raise (both `pwm` and `gpio` are `None`).

### Task 5: Doc-refresh `test_ejector.py`
- **ACTION**: Update the module docstring + fail-mode bullets from stepper/ULN2003 to MG996R servo. **Leave the `main()` body unchanged** — it only uses `Ejector()/is_stub/push()/cleanup()`.
- **IMPLEMENT** (docstring replacement):
  ```python
  """Bench-test the ejector MG996R continuous-rotation servo (signal on BCM 13).

  Run on the Pi only.

      sudo systemctl stop pharmguard
      cd ~/IDP_PharmGuard/backend && source .venv/bin/activate
      sudo -E .venv/bin/python hardware/test_ejector.py [cycles]

  Repeats push() (forward 7.5s, stop, reverse 7.5s, stop) N times (default 3).
  push() drives PWM to 0 between cycles so the servo fully stops.

  Expected: clean forward + reverse sweep each cycle; servo silent between cycles.
  Fail modes:
    * No movement -> servo V+ not on external 5-6V, or supply GND not tied to
      Pi GND. MG996R stall is ~2.5A; never power it from the Pi 5V rail.
    * Spins wrong way -> swap FWD_DUTY <-> REV_DUTY in ejector.py.
    * Creeps while "stopped" -> trim STOP_DUTY (1500us) in 0.1% steps in ejector.py.
    * Jitter/buzz -> 5V sag under load; use a beefier PSU (>= 3A).
  """
  ```
- **MIRROR**: TEST_HARNESS (the existing `main()` already matches; do not touch it).
- **IMPORTS**: none.
- **GOTCHA**: The line 36 warning string says "servo will not move in stub mode" — already correct for a servo, leave it.
- **VALIDATE**: `python -c "import ast; ast.parse(open('hardware/test_ejector.py').read())"` parses clean.

---

## Testing Strategy

> Repo has **no automated test suite** (per CLAUDE.md — `pytest` not configured).
> Validation is import/compile checks on the dev host + a manual bench run on the Pi.

### Unit Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `_us_to_duty(1500/1600/1400)` | constants | `7.5 / 8.0 / 7.0` | No |
| `Ejector()` under `PHARMGUARD_STUB=1` | no GPIO | `is_stub == True`, no raise | Yes (no hardware) |
| `Ejector()` no GPIO, no stub | no GPIO | raises `RuntimeError` | Yes (fail-loud) |
| `push()` in stub | — | returns instantly, logs `stub: would push` | Yes |
| `cleanup()` in stub | — | no raise (`pwm`/`gpio` None) | Yes |

### Edge Cases Checklist
- [x] No GPIO + stub allowed → degraded stub (no raise)
- [x] No GPIO + stub disallowed → `RuntimeError` (HI-012 fail-loud)
- [x] `push()` interrupted mid-move → `finally` drives duty 0 (no creep)
- [x] `cleanup()` called twice / after stub init → idempotent, no raise
- [ ] Concurrent access — N/A: callers serialize via `app.state.hardware_lock` (`cycle_runner.py:381`, `device.py:131`)

---

## Validation Commands

### Static Analysis / Import
```bash
cd /Users/limjiale/IDP_PharmGuard/backend
python -m py_compile hardware/ejector.py hardware/test_ejector.py
```
EXPECT: exit 0, no output.

```bash
cd /Users/limjiale/IDP_PharmGuard/backend
PHARMGUARD_STUB=1 python -c "
from hardware.ejector import Ejector, STOP_DUTY, FWD_DUTY, REV_DUTY
assert (STOP_DUTY, FWD_DUTY, REV_DUTY) == (7.5, 8.0, 7.0), (STOP_DUTY, FWD_DUTY, REV_DUTY)
e = Ejector(); assert e.is_stub is True
e.push(); e.cleanup()
print('OK')
"
```
EXPECT: `OK` (stub path: constructs, push no-ops, cleanup clean).

### Downstream contract (no call-site changes)
```bash
cd /Users/limjiale/IDP_PharmGuard/backend
PHARMGUARD_STUB=1 python -c "
import scheduler.cycle_runner as c, api.device as d
print('imports OK')
"
```
EXPECT: `imports OK` — confirms `from hardware.ejector import Ejector` and `state.ejector.push` consumers still resolve.

### Manual Validation (Pi only)
- [ ] Wire MG996R: signal → BCM 13 (phys 33), V+ → external 5–6 V, GND common with Pi.
- [ ] `sudo systemctl stop pharmguard`
- [ ] `sudo -E .venv/bin/python hardware/test_ejector.py 3` → 3 clean fwd/rev cycles, silent between.
- [ ] If wrong direction → swap `FWD_DUTY`/`REV_DUTY`; if creeps at stop → trim `STOP_DUTY`.
- [ ] `sudo systemctl start pharmguard`; trigger a dispense; confirm cycle completes and `t_eject_ms` is logged.

---

## Acceptance Criteria
- [ ] `ejector.py` drives MG996R via 50 Hz PWM; `push()` = FWD 7.5 s → STOP 1 s → REV 7.5 s → STOP 1 s, ending at duty 0.
- [ ] Public API (`Ejector`, `is_stub`, `push`, `cleanup`) byte-for-byte compatible — zero edits in `cycle_runner.py` / `device.py` / `conftest.py`.
- [ ] Stub mode + fail-loud behavior preserved (HI-012).
- [ ] All Validation Commands pass on the dev host.
- [ ] `test_ejector.py` docstring reflects the servo.

## Completion Checklist
- [ ] Follows `drawer_lock.py` servo pattern (PWM lifecycle, scoped cleanup, stub guards)
- [ ] `initial=GPIO.LOW` on `setup`; scoped `GPIO.cleanup(PIN_SERVO)`
- [ ] Logging matches module style (`log.info`/`log.warning`/`log.exception`)
- [ ] `STUB_ALLOWED` read once at import
- [ ] No hardcoded duty magic numbers without the µs comment
- [ ] No scope creep (no config var, no async changes, no call-site edits)
- [ ] Self-contained — implementable from this plan alone

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `push()` now blocks ~17 s vs ~2 s → slower dispense cycle | High | Med | Already wrapped in `asyncio.to_thread` (won't block event loop). `MOVE_S`/`PAUSE_S` tunable in-file; lower once mechanism validated. Flag to user. |
| Continuous servo creeps at STOP_DUTY (1500 µs not exact-neutral on this unit) | Med | Med | `push()`/`init`/`cleanup` end at `ChangeDutyCycle(0)` (no pulses → no creep); doc says trim `STOP_DUTY`. |
| BCM 13 conflicts with an undocumented consumer | Low | Med | Grep confirms 13 unused (magazine 17/27/22, drawer 18, DHT11 4, old ejector 5/6/16/26 freed). Swap pin in one constant if needed. |
| rpi-lgpio software PWM jitter | Low | Low | Continuous servo tolerates jitter (no angle hold). Same shim already drives the SG90 fine. |
| Direction inverted vs. mechanism | Med | Low | One-line swap of `FWD_DUTY`/`REV_DUTY`; documented in file + test fail-modes. |

## Notes
- **Why `push()` runs the loop body once, not forever**: the Arduino `loop()` repeats
  because that's a standalone demo. In PharmGuard, one `push()` = one eject; repetition
  is the scheduler's/bench script's job. This preserves the existing stepper semantics
  (its `push()` was also a single forward+return motion).
- **Pin choice BCM 13**: hardware-PWM-capable and free. BCM 18 (PWM0) is documented to
  the dormant `DrawerLock`; using 13 avoids a GPIO-claim collision if a bench script ever
  instantiates both. Any GPIO works (rpi-lgpio software PWM) — change the single
  `PIN_SERVO` constant to re-pin.
- **The old stepper hardware** (28BYJ-48 + ULN2003 on BCM 5/6/16/26) is physically
  replaced; those pins are now free for future use.
