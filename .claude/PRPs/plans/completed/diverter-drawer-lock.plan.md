# Plan: Diverter + Drawer-Lock Hardware (PRD Phase 4)

## Summary
Close the fail-safe and zero-touch gaps in the dispenser. Add two new hardware modules in `edge_pi/hardware/`: `diverter.py` (a servo flap that routes a verified-bad pill to a reject bin) and `drawer_lock.py` (a solenoid that holds the patient drawer closed and only releases when the dispense passes both pill-ID *and* Face-ID). Both modules mirror `Magazine`/`Ejector` exactly: `RPi.GPIO` import (preserved through the `rpi-lgpio` shim), `STUB_ALLOWED` env-flag, `_is_stub` property, fail-loud-vs-stub branch on init failure. Wire both into `edge_pi/main.py`'s polling loop so the cycle becomes:

```
Right patient gate (Phase 3) → magazine.rotate_to → ejector.push
  → verifier.confirm_tray_empty   ─── pass ──→ drawer_lock.unlock → wait → drawer_lock.lock
                                  ─── fail ──→ diverter.reject (then back to ARM)
```

The drawer NEVER unlocks unless **both** the right-patient gate AND `confirm_tray_empty()` succeed. On failure (wrong pill detected, tray not empty, etc.) the diverter sweeps the dropped pill into a reject bin, and `pill_taken` is reported as `False`. No backend or frontend changes; this is hardware-only on the Pi tier.

## User Story
As the **PharmGuard Pi runtime**, I want **a physical flap that diverts wrong-pills away from the patient AND a solenoid lock that only releases the drawer on a verified-correct dispense**, so that **a wrong-pill-ID or a wrong-patient-ID event can never deliver a pill to the patient — the failure is mechanical, not advisory**.

## Problem → Solution
**Today**: After `ejector.push()`, the ejected pill enters the drawer chute regardless of pill-ID outcome. There is no diverter, no solenoid lock, no reject bin in code. PRD `Open Questions` line 59 explicitly flags "Diverter flap (reject path) — not yet in `edge_pi/hardware/`. Add servo + GPIO pin allocation." `User Flow` step 5 ("on mismatch → diverter flap rejects (new module)") and step 6 ("Drawer unlocks → solenoid GPIO toggle (new module)") describe the contract that the code does not yet implement.

**After**: Two new hardware modules. `Diverter` is a servo with two angles (DELIVER position vs REJECT position). `DrawerLock` is a digital output that drives a MOSFET → solenoid. Both follow the existing `Magazine`/`Ejector` shape exactly. Pi `main.py` orchestrates them as the final two steps of every cycle. The PRD success signal — "200-cycle adversarial test: every wrong-pill or failed-Face-ID event hits the reject path; drawer never opens on fail" — is delivered as an operator-attested bench script handoff (not run in this worktree).

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 4 — Diverter + drawer-lock hardware
- **Estimated Files**: 6 (2 new hardware modules + main.py wiring + 2 new pytest test files + conftest.py one-line update)
- **Estimated Lines**: ~230 LOC net (diverter ~95, drawer_lock ~85, main.py +25, tests ~50 combined)

---

## UX Design

Internal change — no user-facing UX transformation. The patient still walks up, blinks, and the drawer (or doesn't) opens. Only the *failure mode* becomes visible: a wrong-pill event now mechanically rejects instead of silently delivering.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Pi cycle on pill-ID pass | drawer "opens" (no actual lock) | `drawer_lock.unlock()` for `DRAWER_OPEN_S` then re-locks | physical guarantee |
| Pi cycle on pill-ID fail | pill drops into shared chute; logged as `pill_taken=False` | `diverter.reject()` routes pill to reject bin; drawer stays locked; logged as `pill_taken=False` | physical guarantee |
| Pi cycle on Face-ID fail | already short-circuits `continue` (Phase 3) | unchanged — magazine never rotates, no diversion needed | preserved |
| Pi → backend → DB | unchanged payload | unchanged | hardware-only phase |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `edge_pi/hardware/magazine.py` | 1–116 | Canonical `STUB_ALLOWED`/`_is_stub`/`_init_gpio` pattern; PIN constants at module top; `cleanup()` shape |
| P0 | `edge_pi/hardware/ejector.py` | 1–71 | Servo PWM pattern using `RPi.GPIO.PWM(pin, 50)`; `push()` is the closest analogue for `Diverter.reject()` |
| P0 | `edge_pi/main.py` | 102–200 | Stub-aggregation block (HI-012), Phase 2 dual-cam open, Phase 3 right-patient gate, current cycle structure |
| P0 | `edge_pi/tests/conftest.py` | 1–75 | `stub_env`/`prod_env`/`gpio_mock`/`no_sleep` fixtures; `_reload_hardware_modules()` lists the modules to invalidate |
| P0 | `edge_pi/tests/test_magazine.py` | 1–108 | Test shapes: stub init, prod init fail-loud, gpio_mock-driven prod-path verification |
| P0 | `edge_pi/tests/test_ejector.py` | 1–28 | Test shapes for the servo module (closer to Diverter than Magazine) |
| P0 | `CLAUDE.md` | 63–69 | `RPi.GPIO` via `rpi-lgpio` shim rule — DO NOT switch to `gpiozero` |
| P0 | `.claude/PRPs/prds/pharmguard.prd.md` | 109, 134–143, 197, 222–225, 259–264 | PRD Phase 4 row, Should-have rationale, parallelism notes |
| P1 | `.claude/PRPs/plans/completed/dual-camera-refactor.plan.md` | full | Plan format conventions (mandatory reading, patterns to mirror with SOURCE refs, files-to-change table, step-by-step tasks) |
| P1 | `.claude/PRPs/plans/completed/face-id-end-to-end.plan.md` | full | Plan format conventions; right-patient gate context |
| P1 | `edge_pi/config.py` | 41–93 | `STUB_MODE` settings flag — read by `main.py` to decide whether stubbed init is acceptable |
| P2 | `edge_pi/.env.example` | all | Document env-var conventions; nothing new added in this phase |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Pi 5 BCM pin map (free GPIO inventory) | https://pinout.xyz/ | GPIO 13 = hardware PWM1 (free in this repo), GPIO 23 = generic GPIO (free), GPIO 24 = generic GPIO (free, reserved for Phase 5 sensor budget) |
| Hardware PWM channels on Pi 5 | https://forums.raspberrypi.com/viewtopic.php?t=355440 | Pi 5 supports hardware PWM on GPIO 12/13/18/19. GPIO 18 is taken by Ejector. GPIO 13 = PWM1 channel 1, free. |
| `rpi-lgpio` shim compatibility | https://pypi.org/project/rpi-lgpio/ | Drop-in replacement for `RPi.GPIO` on Pi 5 / Bookworm. `import RPi.GPIO as GPIO` continues to work; `GPIO.PWM(pin, freq)` continues to work. |
| Solenoid drive circuit conventions | https://learn.adafruit.com/adafruit-arduino-lesson-13-dc-motors/transistors | Solenoids are inductive loads driven through a MOSFET/transistor with flyback diode; Pi GPIO toggles HIGH (energise = unlock) → LOW (de-energise = locked, fail-safe default) |
| Servo position convention (50 Hz PWM duty cycle) | https://learn.adafruit.com/adafruit-arduino-lesson-14-servo-motors/the-circuit | 2.5 % duty ≈ 0°, 7.5 % duty ≈ 90°, 12.5 % duty ≈ 180° — same convention as `edge_pi/hardware/ejector.py:62-64` |

---

## Patterns to Mirror

### NAMING_CONVENTION (hardware module top)
```python
# SOURCE: edge_pi/hardware/magazine.py:1-12
"""
10-slot magazine rotation via stepper motor (A4988 / DRV8825 driver).

GPIO pin assignments are configured for a Raspberry Pi 4/5.
"""

import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# GPIO BCM pin assignments
PIN_STEP = 17
```
Rule: module-level docstring; module-level `log = logging.getLogger(__name__)`; PIN constants at module top in BCM numbering; PascalCase class; snake_case methods. New modules MUST follow this exact shape.

### STUB_FAIL_LOUD_PATTERN (the HI-012 invariant)
```python
# SOURCE: edge_pi/hardware/magazine.py:24-58
# Read once at import — flips fail-loud vs. degraded stub behavior.
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


class Magazine:
    def __init__(self) -> None:
        self.current_slot: int = 0
        self.gpio: Any = None
        self._is_stub: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO

            GPIO.setmode(GPIO.BCM)
            GPIO.setup(PIN_STEP, GPIO.OUT)
            ...
            self.gpio = GPIO
            self._is_stub = False
            log.info("Magazine GPIO initialized")
        except Exception as e:
            if STUB_ALLOWED:
                log.warning(
                    "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                )
                self.gpio = None
                self._is_stub = True
            else:
                raise RuntimeError(
                    "Magazine: GPIO init failed; "
                    "set PHARMGUARD_STUB=1 to allow stub mode"
                ) from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub
```
Rule: `STUB_ALLOWED` read once at import; `_init_gpio()` does the try/except; stub branch warns + sets `_is_stub=True`; non-stub branch raises a `RuntimeError` mentioning `PHARMGUARD_STUB=1` (test files grep this string). `is_stub` is a `@property`, not a public attribute. **The two new modules MUST be testable identically with the existing `prod_env`/`stub_env`/`gpio_mock` fixtures.**

### SERVO_PWM_PATTERN
```python
# SOURCE: edge_pi/hardware/ejector.py:28-66
def _init_gpio(self) -> None:
    try:
        import RPi.GPIO as GPIO

        GPIO.setmode(GPIO.BCM)
        GPIO.setup(PIN_SERVO, GPIO.OUT)
        self.pwm = GPIO.PWM(PIN_SERVO, 50)  # 50 Hz for servo
        self.pwm.start(0)
        self._is_stub = False
        log.info("Ejector servo initialized")
    except Exception as e:
        ...

def push(self) -> None:
    if self._is_stub:
        log.debug("stub: would push")
        return

    log.info("Ejecting pill")
    self.pwm.ChangeDutyCycle(7.5)  # Move to push position
    time.sleep(PUSH_DURATION_S)
    self.pwm.ChangeDutyCycle(2.5)  # Return to rest
    time.sleep(PUSH_DURATION_S)
    self.pwm.ChangeDutyCycle(0)
```
Rule: `GPIO.PWM(pin, 50)` for hobby servos; `start(0)`; action method early-returns in stub with `log.debug`; real path moves to action duty cycle, sleeps, returns to rest, then `ChangeDutyCycle(0)` to silence the line. `Diverter` mirrors this directly.

### DIGITAL_OUTPUT_PATTERN (mirror from Magazine.PIN_ENABLE HIGH/LOW)
```python
# SOURCE: edge_pi/hardware/magazine.py:42-43 (digital pin set HIGH/LOW)
GPIO.setup(PIN_ENABLE, GPIO.OUT)
GPIO.output(PIN_ENABLE, GPIO.LOW)  # Enable driver
```
Rule: digital output pins use `GPIO.setup(pin, GPIO.OUT)` then `GPIO.output(pin, GPIO.HIGH/LOW)`. Solenoid drive in `DrawerLock` follows the same shape. Default state at init is **LOW (locked, fail-safe)** — the drawer must never be unlocked at boot.

### CLEANUP_PATTERN
```python
# SOURCE: edge_pi/hardware/magazine.py:113-115
def cleanup(self) -> None:
    if self.gpio is not None:
        self.gpio.cleanup()

# SOURCE: edge_pi/hardware/ejector.py:68-70
def cleanup(self) -> None:
    if self.pwm is not None:
        self.pwm.stop()
```
Rule: idempotent, guarded by `is not None`. New modules expose `cleanup()` even though `main.py` does not currently call it (matching existing parity).

### STUB_AGGREGATION_PATTERN
```python
# SOURCE: edge_pi/main.py:102-120
magazine = Magazine()
ejector = Ejector()

# HI-012: Refuse to run as if hardware were real when it isn't.
hardware_stubbed = magazine.is_stub or ejector.is_stub
if hardware_stubbed:
    if not settings.STUB_MODE:
        log.error(
            "Hardware initialization degraded (magazine.is_stub=%s, "
            "ejector.is_stub=%s) but PHARMGUARD_STUB is not set. Refusing "
            "to run — telemetry would be falsified.",
            magazine.is_stub,
            ejector.is_stub,
        )
        sys.exit(1)
```
Rule: every hardware module's `is_stub` joins the OR; the error-log message lists every module's stub flag; `sys.exit(1)` if any module is stubbed but `PHARMGUARD_STUB=0`. The Phase 4 modules MUST be added to **both** the `or` chain AND the `log.error` formatting tuple.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/hardware/magazine.py:46, 82-88
log.info("Magazine GPIO initialized")
log.info(
    "Rotating from slot %d -> %d (%s, %d steps)",
    self.current_slot,
    target_slot,
    direction,
    steps,
)
```
Rule: positional formatters only, never f-strings; `log.info` for state transitions; `log.warning` for soft failures; `log.debug` for "would do X in stub mode".

### PI_CYCLE_INSERTION_PATTERN (Phase 4 cycle additions)
```python
# CONTEXT: edge_pi/main.py:182-195 — current cycle tail after Phase 3 right-patient gate
magazine.rotate_to(slot)
ejector.push()

if hardware_stubbed:
    pill_taken_actual = False
    log.info("Stub mode: skipping vision verify + swallow watch")
else:
    pill_taken_actual = verifier.confirm_tray_empty()
    if pill_taken_actual:
        monitor.watch_for_swallow(timeout_s=60)
```
Rule: new logic inserts **after** `verifier.confirm_tray_empty()` decides pass/fail and **before** `report_intake()`. Wrap the new block in a sentinel comment `# --- Phase 4: diverter + drawer-lock ---` so future merges (Phase 5 sensor block, Phase 6 bench loop) can locate the boundary without a diff hunt.

### TEST_FIXTURE_PATTERN
```python
# SOURCE: edge_pi/tests/test_magazine.py:94-107 + tests/conftest.py:23-27
def test_init_raises_in_prod_mode_when_gpio_unavailable(prod_env: None) -> None:
    from hardware.magazine import Magazine
    with pytest.raises(RuntimeError, match="PHARMGUARD_STUB=1"):
        Magazine()


def test_init_succeeds_as_stub_when_PHARMGUARD_STUB_set(stub_env: None) -> None:
    from hardware.magazine import Magazine
    mag = Magazine()
    assert mag.is_stub is True
```
Rule: import the module **inside** the test (not at top), so the conftest's `_reload_hardware_modules()` cache-busting works. **`_reload_hardware_modules()` in `conftest.py:23-27` MUST be extended** to invalidate `hardware.diverter` and `hardware.drawer_lock` — otherwise the `STUB_ALLOWED` module-level flag from one test bleeds into the next.

### TEST_STRUCTURE
- `tests/test_diverter.py` mirrors `tests/test_ejector.py` (servo-shape — short test list focused on stub/prod paths).
- `tests/test_drawer_lock.py` mirrors `tests/test_magazine.py`'s digital-pin assertions (verify HIGH/LOW transitions on the solenoid pin via `gpio_mock`).

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `edge_pi/hardware/diverter.py` | CREATE | New servo-flap module. Mirrors `ejector.py` shape exactly (servo PWM, 50 Hz, two duty cycles for DELIVER/REJECT). |
| `edge_pi/hardware/drawer_lock.py` | CREATE | New solenoid module. Digital output pin; HIGH = energised (unlocked), LOW = de-energised (locked, fail-safe default). |
| `edge_pi/main.py` | UPDATE | Instantiate both modules; extend `hardware_stubbed` aggregation; integrate into cycle so drawer unlocks **only** on `(right_patient_gate AND confirm_tray_empty)`; reject path through diverter on tray-not-empty. Wrapped in a `# --- Phase 4: diverter + drawer-lock ---` sentinel block. |
| `edge_pi/tests/test_diverter.py` | CREATE | Mirror `test_ejector.py` — stub/prod paths + `deliver()`/`reject()` smoke. |
| `edge_pi/tests/test_drawer_lock.py` | CREATE | Mirror `test_magazine.py` — stub/prod paths + `unlock()`/`lock()` HIGH/LOW assertions. |
| `edge_pi/tests/conftest.py` | UPDATE | Extend `_reload_hardware_modules()` to invalidate the two new modules. **One-line change.** |

## NOT Building

- **Backend / frontend changes** — Phase 4 is hardware-only on the Pi tier. Telemetry payload (`pill_taken`) does not change. Reject events are NOT logged to the backend in this phase (deferred to Phase 5 alerts or Phase 6 bench).
- **Bench script (200-cycle adversarial test)** — documented as the operator handoff, NOT executed in this worktree (no real hardware here, and the bench runs on a Pi 5 against a real diverter + solenoid). Delivered as a one-page handoff in the report.
- **Reject-bin overflow detection** — out of scope; Phase 5 sensor work is the right place for this.
- **Drawer-open sensor (microswitch / hall)** — operator attests drawer behaviour for V1; sensor-based confirmation deferred.
- **Audible buzzer / LED on reject** — UX polish, not safety-critical; Phase 7 frontend work surfaces reject events instead.
- **Power-loss-safe latch on the drawer** — solenoid de-energises = locked (fail-safe by design); no mechanical latch needed for V1.
- **Configurable diverter angles via env** — hardcoded duty cycles for V1; servo geometry is fixed by the chassis.
- **Multi-pill-per-dose orchestration** — `pills_per_dose` exists in schema (Phase 1) but the dispense loop still dispenses one pill per cycle. Out of scope here.
- **`requirements.txt` changes** — none needed; `RPi.GPIO`/`rpi-lgpio` already pinned for the existing modules.
- **Removing or modifying `intake_monitor.py`** — Step-4 inverted-logic invariant is byte-frozen across phases per `CLAUDE.md`.
- **Editing `magazine.py` or `ejector.py`** — pin constants and behaviour stay frozen.
- **Calling `cleanup()` from `main.py`** — `main.py` runs an infinite loop today with no shutdown path; cleanup hooks come in Phase 10 packaging.

---

## Step-by-Step Tasks

### Task 1: Create `edge_pi/hardware/diverter.py`
- **ACTION**: New servo-flap module with two stable positions (DELIVER + REJECT).
- **IMPLEMENT**:
  ```python
  """
  Diverter flap — servo that routes the ejected pill to either the patient
  drawer (DELIVER) or the reject bin (REJECT). Acts as the mechanical
  fail-safe when pill-ID verification fails.

  GPIO pin: BCM 13 (Pi 5 hardware PWM channel PWM1).
  """

  import logging
  import os
  import time
  from typing import Any

  log = logging.getLogger(__name__)

  # GPIO BCM pin for servo PWM (hardware PWM channel PWM1 on Pi 5).
  PIN_SERVO = 13

  # Servo duty cycles (50 Hz). 2.5 % ≈ 0°, 7.5 % ≈ 90°, 12.5 % ≈ 180°.
  DELIVER_DUTY = 7.5   # neutral / patient-drawer chute
  REJECT_DUTY = 12.5   # rotated / reject-bin chute
  MOVE_DURATION_S = 0.4
  HOLD_DURATION_S = 0.6  # long enough for the pill to clear the flap

  # Read once at import — flips fail-loud vs. degraded stub behavior.
  STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"


  class Diverter:
      def __init__(self) -> None:
          self.pwm: Any = None
          self._is_stub: bool = False
          self._init_gpio()

      def _init_gpio(self) -> None:
          try:
              import RPi.GPIO as GPIO

              GPIO.setmode(GPIO.BCM)
              GPIO.setup(PIN_SERVO, GPIO.OUT)
              self.pwm = GPIO.PWM(PIN_SERVO, 50)  # 50 Hz for servo
              self.pwm.start(0)
              self._is_stub = False
              log.info("Diverter servo initialized")
          except Exception as e:
              if STUB_ALLOWED:
                  log.warning(
                      "GPIO unavailable — stub mode (PHARMGUARD_STUB=1)"
                  )
                  self.pwm = None
                  self._is_stub = True
              else:
                  raise RuntimeError(
                      "Diverter: GPIO init failed; "
                      "set PHARMGUARD_STUB=1 to allow stub mode"
                  ) from e

      @property
      def is_stub(self) -> bool:
          return self._is_stub

      def deliver(self) -> None:
          """Hold the flap at the patient-drawer chute (default-neutral)."""
          if self._is_stub:
              log.debug("stub: would set diverter to DELIVER")
              return

          log.info("Diverter -> DELIVER")
          self.pwm.ChangeDutyCycle(DELIVER_DUTY)
          time.sleep(MOVE_DURATION_S)
          self.pwm.ChangeDutyCycle(0)

      def reject(self) -> None:
          """Sweep the flap to the reject bin and return to neutral."""
          if self._is_stub:
              log.debug("stub: would reject pill")
              return

          log.info("Diverter -> REJECT (pill rejected)")
          self.pwm.ChangeDutyCycle(REJECT_DUTY)
          time.sleep(HOLD_DURATION_S)
          self.pwm.ChangeDutyCycle(DELIVER_DUTY)
          time.sleep(MOVE_DURATION_S)
          self.pwm.ChangeDutyCycle(0)

      def cleanup(self) -> None:
          if self.pwm is not None:
              self.pwm.stop()
  ```
- **MIRROR**: NAMING_CONVENTION, STUB_FAIL_LOUD_PATTERN, SERVO_PWM_PATTERN, CLEANUP_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: stdlib only (`logging`, `os`, `time`, `typing.Any`); `RPi.GPIO` lazy-imported inside `_init_gpio` so dev mac compile passes.
- **GOTCHA**:
  - GPIO 13 is hardware PWM1 on Pi 5; if the operator's Pi has different PWM routing, only this constant changes.
  - `MOVE_DURATION_S` and `HOLD_DURATION_S` are tuned conservatively. Operator can tighten after bench.
  - Returning to DELIVER after a REJECT is intentional — gravity-neutral default leaves the next dispense unaffected if the Pi reboots mid-cycle.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile hardware/diverter.py
  PHARMGUARD_STUB=1 python3 -c "from hardware.diverter import Diverter; d = Diverter(); print('OK', d.is_stub); d.deliver(); d.reject()"
  ```

### Task 2: Create `edge_pi/hardware/drawer_lock.py`
- **ACTION**: New solenoid-driven drawer-lock module.
- **IMPLEMENT**:
  ```python
  """
  Drawer lock — solenoid that holds the patient collection drawer closed.
  Energise (HIGH) to unlock; de-energise (LOW) to lock.
  Fail-safe default: power loss → drawer stays locked.

  GPIO pin: BCM 23 (free generic GPIO; no PWM needed).
  """

  import logging
  import os
  import time
  from typing import Any

  log = logging.getLogger(__name__)

  PIN_SOLENOID = 23
  DRAWER_OPEN_S = 10.0

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
              GPIO.setup(PIN_SOLENOID, GPIO.OUT)
              # Fail-safe default: drawer stays locked at boot.
              GPIO.output(PIN_SOLENOID, GPIO.LOW)
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
          if self._is_stub:
              log.debug("stub: would unlock drawer")
              self._is_unlocked = True
              return
          log.info("DrawerLock -> UNLOCK")
          self.gpio.output(PIN_SOLENOID, self.gpio.HIGH)
          self._is_unlocked = True

      def lock(self) -> None:
          if self._is_stub:
              log.debug("stub: would lock drawer")
              self._is_unlocked = False
              return
          log.info("DrawerLock -> LOCK")
          self.gpio.output(PIN_SOLENOID, self.gpio.LOW)
          self._is_unlocked = False

      def hold_unlocked(self, duration_s: float = DRAWER_OPEN_S) -> None:
          """Unlock for `duration_s`, then re-lock (idempotent fail-safe)."""
          self.unlock()
          try:
              time.sleep(duration_s)
          finally:
              self.lock()

      def cleanup(self) -> None:
          if self.gpio is not None:
              try:
                  self.gpio.output(PIN_SOLENOID, self.gpio.LOW)
              except Exception:
                  log.exception("DrawerLock: failed to drive pin LOW on cleanup")
              self.gpio.cleanup(PIN_SOLENOID)
  ```
- **MIRROR**: NAMING_CONVENTION, STUB_FAIL_LOUD_PATTERN, DIGITAL_OUTPUT_PATTERN, CLEANUP_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: stdlib only.
- **GOTCHA**:
  - Fail-safe LOW immediately after `setup()`.
  - Per-pin `cleanup(PIN_SOLENOID)` (not global) so we don't yank the magazine/ejector pins.
  - `_is_unlocked` is informational only — never trust it as a substitute for the actual GPIO state.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile hardware/drawer_lock.py
  PHARMGUARD_STUB=1 python3 -c "from hardware.drawer_lock import DrawerLock; d = DrawerLock(); print('OK', d.is_stub, d.is_unlocked); d.unlock(); print(d.is_unlocked); d.lock(); print(d.is_unlocked)"
  ```

### Task 3: Wire diverter + drawer-lock into `edge_pi/main.py`
- **ACTION**: Integrate both modules into the polling cycle. Extend the HI-012 stub aggregation. Bracket the new logic with a phase-sentinel comment.
- **IMPLEMENT**:
  - Add hardware imports (alphabetical group):
    ```python
    from hardware.diverter import Diverter
    from hardware.drawer_lock import DrawerLock
    from hardware.ejector import Ejector
    from hardware.magazine import Magazine
    ```
  - In `run()`, instantiate after `Ejector()`:
    ```python
    magazine = Magazine()
    ejector = Ejector()
    diverter = Diverter()
    drawer_lock = DrawerLock()
    ```
  - Extend the stub aggregation block to include all four modules:
    ```python
    hardware_stubbed = (
        magazine.is_stub
        or ejector.is_stub
        or diverter.is_stub
        or drawer_lock.is_stub
    )
    if hardware_stubbed:
        if not settings.STUB_MODE:
            log.error(
                "Hardware initialization degraded (magazine.is_stub=%s, "
                "ejector.is_stub=%s, diverter.is_stub=%s, drawer_lock.is_stub=%s) "
                "but PHARMGUARD_STUB is not set. Refusing to run — telemetry "
                "would be falsified.",
                magazine.is_stub,
                ejector.is_stub,
                diverter.is_stub,
                drawer_lock.is_stub,
            )
            sys.exit(1)
        log.warning(
            "STUB MODE: hardware not real — pill_taken will always be reported "
            "False. DO NOT use this build in production."
        )
    ```
  - Replace the cycle tail with the Phase-4-bracketed version:
    ```python
    magazine.rotate_to(slot)
    ejector.push()

    # --- Phase 4: diverter + drawer-lock -------------------------------
    # Drawer unlocks ONLY when right-patient gate (Phase 3, above) AND
    # pill-ID verification (confirm_tray_empty) both pass. Any failure
    # routes the pill through the diverter to the reject bin and leaves
    # the drawer locked. HI-012: stubbed hardware never reports
    # pill_taken=True, so the unlock branch is unreachable in stub mode.
    if hardware_stubbed:
        pill_taken_actual = False
        log.info("Stub mode: skipping vision verify, diverter, drawer_lock, swallow watch")
    else:
        pill_id_pass = verifier.confirm_tray_empty()
        if pill_id_pass:
            diverter.deliver()
            drawer_lock.hold_unlocked()
            pill_taken_actual = True
            monitor.watch_for_swallow(timeout_s=60)
        else:
            log.warning("Pill-ID verification failed; routing to reject bin")
            diverter.reject()
            pill_taken_actual = False
    # --- /Phase 4 ------------------------------------------------------

    report_intake(patient_id, slot, verified=pill_taken_actual)
    log.info("Cycle complete — pill_taken=%s", pill_taken_actual)
    ```
- **MIRROR**: STUB_AGGREGATION_PATTERN, PI_CYCLE_INSERTION_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: `Diverter` and `DrawerLock` from `hardware.*`.
- **GOTCHA**:
  - **Semantic shift from current code**: previously `pill_taken_actual = verifier.confirm_tray_empty()` directly. The Phase-4 version makes the gate explicit (`pill_id_pass`) and only sets `pill_taken_actual=True` after a successful unlock. The reject branch sets `pill_taken_actual=False`. Net behaviour unchanged for the happy path; reject path is new but `pill_taken=False` was already the existing failure outcome.
  - The right-patient gate (Phase 3) is **upstream** — failure short-circuits with `continue` before the magazine ever rotates. By the time the cycle reaches Phase 4, Face-ID has already passed.
  - HI-012 invariant preserved: stub-mode forces `pill_taken_actual = False` and skips diverter+drawer_lock entirely.
  - Sentinel comments make Phase 5/6 merges trivial.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile main.py
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  python3 -c "import main; print('main imports OK')"
  ```
  Plus textual regression — see Task 7.

### Task 4: Extend `edge_pi/tests/conftest.py` to invalidate the new modules
- **ACTION**: One-line update to `_reload_hardware_modules()` so tests don't bleed `STUB_ALLOWED` between cases.
- **IMPLEMENT**:
  ```python
  def _reload_hardware_modules() -> None:
      for mod in (
          "hardware.magazine",
          "hardware.ejector",
          "hardware.diverter",
          "hardware.drawer_lock",
      ):
          sys.modules.pop(mod, None)
  ```
- **MIRROR**: existing tuple shape.
- **IMPORTS**: none.
- **GOTCHA**: tuple, not list — matches the existing literal type.
- **VALIDATE**:
  ```bash
  python3 -m py_compile /Users/limjiale/IDP_PharmGuard/edge_pi/tests/conftest.py
  ```

### Task 5: Create `edge_pi/tests/test_diverter.py`
- **ACTION**: Mirror `test_ejector.py`. Stub init, prod init fail-loud, gpio_mock-driven prod-path smoke.
- **IMPLEMENT**:
  ```python
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
      d.deliver()
      d.reject()


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
  ```
- **MIRROR**: TEST_FIXTURE_PATTERN, TEST_STRUCTURE.
- **IMPORTS**: `pytest`, `unittest.mock.MagicMock`.
- **GOTCHA**: import-inside-test is mandatory for `_reload_hardware_modules()` to work.
- **VALIDATE**:
  ```bash
  python3 -m py_compile /Users/limjiale/IDP_PharmGuard/edge_pi/tests/test_diverter.py
  ```

### Task 6: Create `edge_pi/tests/test_drawer_lock.py`
- **ACTION**: Mirror `test_magazine.py` shape — verify HIGH/LOW transitions on the solenoid pin.
- **IMPLEMENT**:
  ```python
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
  ```
- **MIRROR**: TEST_FIXTURE_PATTERN, TEST_STRUCTURE.
- **IMPORTS**: `pytest`, `unittest.mock.MagicMock`.
- **GOTCHA**:
  - Fail-safe init test must isolate the *first* write to `PIN_SOLENOID` (LOW from `_init_gpio`) via a generator filter.
  - `no_sleep` lets `hold_unlocked(0)` finish instantly.
- **VALIDATE**:
  ```bash
  python3 -m py_compile /Users/limjiale/IDP_PharmGuard/edge_pi/tests/test_drawer_lock.py
  ```

### Task 7: End-to-end import + stub-mode smoke
- **ACTION**: Verify all changed/created Pi files compile and `main` module imports cleanly in stub mode.
- **IMPLEMENT**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi

  # 1. Module compile
  python3 -m py_compile \
      hardware/diverter.py \
      hardware/drawer_lock.py \
      main.py \
      tests/conftest.py \
      tests/test_diverter.py \
      tests/test_drawer_lock.py

  # 2. Hardware module import smoke (stub)
  PHARMGUARD_STUB=1 python3 -c "
  from hardware.diverter import Diverter
  from hardware.drawer_lock import DrawerLock
  d = Diverter(); l = DrawerLock()
  assert d.is_stub and l.is_stub
  d.deliver(); d.reject()
  l.unlock(); l.lock()
  print('hardware stub smoke OK')
  "

  # 3. main.py stub-mode import
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
  python3 -c "import main; print('main OK')"

  # 4. Wiring regression (textual)
  python3 -c "
  import pathlib
  src = pathlib.Path('main.py').read_text()
  for needle in (
      'from hardware.diverter import Diverter',
      'from hardware.drawer_lock import DrawerLock',
      'diverter = Diverter()',
      'drawer_lock = DrawerLock()',
      'or diverter.is_stub',
      'or drawer_lock.is_stub',
      '# --- Phase 4: diverter + drawer-lock',
      '# --- /Phase 4',
      'diverter.deliver()',
      'diverter.reject()',
      'drawer_lock.hold_unlocked()',
      'pill_id_pass = verifier.confirm_tray_empty()',
  ):
      assert needle in src, needle
  assert 'Refusing to run' in src
  assert 'STUB MODE: hardware not real' in src
  print('Phase 4 wiring intact')
  "
  ```
- **MIRROR**: stub-mode pattern from Phase 2/3.
- **IMPORTS**: stdlib only.
- **GOTCHA**: Block #3 needs Pi-side deps (`cv2`, `mediapipe`, `ultralytics`). On dev mac without these deps, the import will fail at the vision module level — fall back to textual regression block #4 only and document in the report.
- **VALIDATE**: All four blocks succeed where deps are available.

### Task 8: Operator handoff — 200-cycle adversarial bench
- **ACTION**: Document the bench so the operator can run it on real Pi 5 hardware after sync.
- **IMPLEMENT**: Capture in the implementation report (NOT executed in this worktree):
  ```bash
  # 1. Sync to Pi.
  make pi-sync HOST=pi@<host>

  # 2. Confirm pin availability.
  ssh pi@<host> 'gpio readall'

  # 3. Pre-load magazine: slots 0-4 with expected pills, slots 5-9 with
  #    deliberately-wrong pills. Alternate "right patient" / "wrong patient"
  #    Face-ID presentations every 10 cycles.
  ssh pi@<host> 'cd ~/IDP_PharmGuard/edge_pi && \
      BACKEND_URL=https://<host> DEVICE_TOKEN=<token> \
      DISPENSER_ID=dispenser-001 python3 main.py 2>&1 | tee /tmp/phase4_bench.log'

  # 4. After 200 cycles, grep:
  grep -c 'pill_taken=True'  /tmp/phase4_bench.log
  grep -c 'pill_taken=False' /tmp/phase4_bench.log
  grep -c 'Diverter -> REJECT' /tmp/phase4_bench.log
  grep -c 'DrawerLock -> UNLOCK' /tmp/phase4_bench.log
  grep -c 'Skipping cycle: authentication failed' /tmp/phase4_bench.log
  ```
- **MIRROR**: BENCH_HANDOFF_PATTERN from Phase 2 / Phase 3 reports.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - **Acceptance invariant**: `UNLOCK count == pill_taken=True count`.
  - **Reject invariant**: every wrong-pill cycle MUST emit `Diverter -> REJECT`; ZERO `UNLOCK` events on a rejected cycle.
  - Operator can early-abort after 50 cycles if invariants hold.
- **VALIDATE**: Operator-attested.

---

## Testing Strategy

Repo has a partial pytest harness under `edge_pi/tests/`. Phase 4 extends it with two new files. Validation = py_compile + new pytest cases (operator-run) + stub-mode import smoke + Pi-side bench (operator-attested).

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `hardware/diverter.py` compiles | `python3 -m py_compile hardware/diverter.py` | exit 0 | normal |
| `hardware/drawer_lock.py` compiles | `python3 -m py_compile hardware/drawer_lock.py` | exit 0 | normal |
| Diverter prod init without GPIO | dev mac, `PHARMGUARD_STUB=0` | `RuntimeError` with `PHARMGUARD_STUB=1` hint | yes (HI-012) |
| Diverter stub init | stub-mode constructor | no exception, `is_stub=True` | yes |
| DrawerLock prod init without GPIO | dev mac, `PHARMGUARD_STUB=0` | `RuntimeError` with `PHARMGUARD_STUB=1` hint | yes (HI-012) |
| DrawerLock stub init | stub-mode constructor | no exception, `is_stub=True`, `is_unlocked=False` | yes |
| DrawerLock fail-safe LOW at boot | `gpio_mock`, prod-mode init | first `output(PIN_SOLENOID, ...)` call is `LOW` | yes (boot safety) |
| Diverter `reject()` duty sequence | `gpio_mock`, prod mode | `[12.5, 7.5, 0]` | yes (HW behaviour) |
| DrawerLock `unlock()` then `lock()` | `gpio_mock`, prod mode | `[HIGH, LOW]` | yes (HW behaviour) |
| `main.py` Phase 4 wiring text | grep regression | all sentinel strings present | yes (regression) |
| Stub-mode `main` import | `PHARMGUARD_STUB=1 ... python -c "import main"` | no exception | yes (no-cam path) |
| HI-012 quad aggregation | one of four modules stubbed but `STUB_MODE=0` | `sys.exit(1)` with all four `is_stub` values logged | yes (safety) |

### Edge Cases Checklist
- [x] Empty input — N/A; no input parameters.
- [x] Maximum size input — N/A.
- [x] Invalid types — `hold_unlocked(duration_s)` accepts any float; negative passes through to `time.sleep` which raises `ValueError` — acceptable.
- [x] Concurrent access — sequential cycle in `main.py`; no concurrency introduced.
- [x] Network failure — N/A for this phase.
- [x] Permission denied — `RPi.GPIO` raises `RuntimeError` if user lacks `/dev/gpiomem`; bubbled through `_init_gpio` fail-loud.
- [x] Power-loss — drawer locks by default (LOW = de-energised). Verified via `test_init_drives_pin_low_failsafe`.
- [x] Stub mode — both modules support stub init; `pill_taken=False` forced.
- [x] HI-012 — every new `is_stub` joins the OR; the error message lists all four.

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/edge_pi
python3 -m py_compile \
    hardware/diverter.py \
    hardware/drawer_lock.py \
    main.py \
    tests/conftest.py \
    tests/test_diverter.py \
    tests/test_drawer_lock.py
```
EXPECT: zero output, exit 0.

### Stub Module Smoke
```bash
PHARMGUARD_STUB=1 python3 -c "
from hardware.diverter import Diverter
from hardware.drawer_lock import DrawerLock
d, l = Diverter(), DrawerLock()
assert d.is_stub and l.is_stub
d.deliver(); d.reject()
l.unlock(); l.lock()
print('hardware stub smoke OK')
"
```
EXPECT: `hardware stub smoke OK`.

### Stub-Mode Main Import
```bash
cd /Users/limjiale/IDP_PharmGuard/edge_pi
PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
python3 -c "import main; print('main OK')"
```
EXPECT: `main OK` (or fall back to textual regression where deps are absent).

### Wiring Regression Guard
See Task 7 step 4. EXPECT: `Phase 4 wiring intact`.

### Pytest (operator step)
```bash
cd /Users/limjiale/IDP_PharmGuard/edge_pi
python3 -m pytest tests/test_diverter.py tests/test_drawer_lock.py -v
```
EXPECT: all green.

### Pi Hardware Bench (operator step)
See Task 8. EXPECT: `UNLOCK count == pill_taken=True count`; every wrong-pill cycle has matching `Diverter -> REJECT`; no `UNLOCK` on rejected cycles.

### Manual Validation Checklist
- [ ] `edge_pi/hardware/diverter.py` exists with `Diverter`, `PIN_SERVO`, `DELIVER_DUTY`, `REJECT_DUTY`, `STUB_ALLOWED`, `_is_stub`, `is_stub`, `deliver()`, `reject()`, `cleanup()`.
- [ ] `edge_pi/hardware/drawer_lock.py` exists with `DrawerLock`, `PIN_SOLENOID`, `STUB_ALLOWED`, `_is_stub`, `is_stub`, `is_unlocked`, `unlock()`, `lock()`, `hold_unlocked()`, `cleanup()`.
- [ ] `main.py` instantiates both new modules; aggregates all four `is_stub` flags; brackets new logic with phase sentinels.
- [ ] Drawer-unlock branch is gated on `pill_id_pass`; right-patient gate (Phase 3) preserved upstream.
- [ ] `tests/conftest.py` `_reload_hardware_modules()` lists both new modules.
- [ ] `tests/test_diverter.py` and `tests/test_drawer_lock.py` mirror existing test shape.
- [ ] `intake_monitor.py`, `magazine.py`, `ejector.py` byte-identical.
- [ ] No `requirements.txt` changes.
- [ ] PRD Phase 4 row deferred to orchestrator.

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] `py_compile` clean across all changed/created files.
- [ ] Stub-mode `main.py` import passes (or, where deps absent, textual regression passes).
- [ ] HI-012 stub-aggregation includes all four hardware modules.
- [ ] Drawer-lock pin defaults to LOW (locked) at init — verified by test.
- [ ] Diverter `reject()` produces the duty sequence `[REJECT_DUTY, DELIVER_DUTY, 0]` — verified by test.
- [ ] No backend or frontend changes.
- [ ] No edits to `magazine.py`, `ejector.py`, or `intake_monitor.py`.
- [ ] Pi-bench operator handoff documented in the report.

## Completion Checklist
- [ ] Code follows discovered patterns (NAMING, STUB_FAIL_LOUD, SERVO_PWM, DIGITAL_OUTPUT, CLEANUP, LOGGING, STUB_AGGREGATION, PI_CYCLE_INSERTION, TEST_FIXTURE).
- [ ] No silent stub fallbacks — modules refuse to init in production without `PHARMGUARD_STUB=1`.
- [ ] Drawer is locked by default — solenoid pin LOW at boot, LOW after `lock()`, LOW on `cleanup()`.
- [ ] `RPi.GPIO` import preserved (do NOT switch to `gpiozero`; `rpi-lgpio` shim handles Pi 5).
- [ ] No new dependencies in `requirements.txt`.
- [ ] Phase sentinel comments in `main.py` make Phase 5/6 merges trivial.
- [ ] Plan file kept in `.claude/PRPs/plans/` (not archived to `completed/` — orchestrator handles).
- [ ] PRD untouched — orchestrator handles.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| GPIO 13 conflicts with another peripheral on operator's chassis | L | M | Pi 5 PWM1 is broadly free; operator can re-pin via single constant in `diverter.py`. Documented. |
| Solenoid in-rush current browns out the Pi | M | H | Solenoid driven through MOSFET + flyback diode + dedicated 12 V supply (PSU spec, not code). Out of scope here; flagged in BOM review. |
| Drawer-open duration too short / too long for real patients | M | L | `DRAWER_OPEN_S = 10.0` is a tunable constant. Operator adjusts after bench. |
| Diverter geometry misaligned, REJECT angle drops pill into wrong chute | M | H | Constant `REJECT_DUTY = 12.5` exposed; operator tunes during bench. PRD success-signal bench catches this. |
| HI-012 break — someone forgets to add a new `is_stub` to the OR chain | L | H | Sentinel comment + the report's checklist. Future modules MUST update both the OR and the `log.error` tuple. |
| `cleanup()` per-pin vs global cleanup mismatch causes pin-leak | L | L | `DrawerLock.cleanup()` calls `gpio.cleanup(PIN_SOLENOID)` (per-pin); existing modules use global `gpio.cleanup()`. `main.py` doesn't call cleanup today, so the conflict is theoretical until Phase 10. |
| Phase 5 (sensor) edits the same `main.py` cycle and merge-conflicts | M | L | Phase 4 sentinel block localises the change. Phase 5 expected to add sensor reads at the *top* of the loop or as a separate alert thread. |
| Diverter servo "snap-back" jitters mid-cycle | L | L | `MOVE_DURATION_S` + `HOLD_DURATION_S` give the pill time to clear; final `ChangeDutyCycle(0)` silences the line. Same pattern as `Ejector.push()`. |

## Notes
- **Hardware-only phase**: backend payload (`pill_taken: bool`) and frontend dashboard contract are unchanged. A future phase can extend `adherence_logs` with a `rejected_reason` column — out of scope here.
- **HI-012 invariant doubled-down**: the new modules join the `hardware_stubbed` aggregation; they cannot be partially stubbed in production.
- **Pi-side cycle latency increases by `DRAWER_OPEN_S` (10 s) per cycle**. PRD Success Metric "<8 s end-to-end latency: schedule trigger → pill in drawer" is measured *before* the drawer opens — the patient-side wait is intentionally outside that target.
- **GPIO pin choices** — BCM 13 (servo) and BCM 23 (solenoid) — intentionally avoid GPIO 4 (DS18B20 1-wire conventional), GPIO 2/3 (I²C0), and GPIO 12/19 (PWM0/PWM1 ch0) to leave Phase 5 sensors a clean budget.
- **Worktree commit boundary**: this plan + implementation lives on this worktree's branch (the orchestrator owns the branch name). The PRD Phase 4 row stays at `pending` in this worktree; the orchestrator flips it after merge.

Sources:
- [pinout.xyz — Raspberry Pi GPIO map](https://pinout.xyz/)
- [Pi 5 hardware PWM channels — Raspberry Pi Forums](https://forums.raspberrypi.com/viewtopic.php?t=355440)
- [`rpi-lgpio` shim documentation — PyPI](https://pypi.org/project/rpi-lgpio/)
- [Adafruit — driving solenoids with transistors](https://learn.adafruit.com/adafruit-arduino-lesson-13-dc-motors/transistors)
- [Adafruit — servo PWM duty conventions](https://learn.adafruit.com/adafruit-arduino-lesson-14-servo-motors/the-circuit)
