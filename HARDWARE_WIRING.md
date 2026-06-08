# PharmGuard hardware wiring plan

Pin map derived from current source. Authoritative sources:

| Component | File | Pin constant |
|---|---|---|
| Magazine stepper (NEMA17 + A4988) | `backend/hardware/magazine.py:15-18` | `PIN_STEP=17`, `PIN_DIR=27`, `PIN_ENABLE=22` |
| Ejector servo (MG996R continuous rotation) | `backend/hardware/ejector.py` | `PIN_SERVO=13` (hardware PWM1) |
| Drawer-lock servo (SG90) — **demo only** | `backend/hardware/drawer_lock.py:42` | `PIN_SERVO=18` (hardware PWM0); no longer driven by the dispense cycle |
| Pill / intake cams | `backend/vision/camera.py` | CSI ports CAM0 + CAM1 |

If a pin constant changes in code, update this file in the same commit.

> **Ejector rewrite pending.** The MG996R port (stepper → continuous-rotation servo,
> `PIN_IN1..4=5/6/16/26` → `PIN_SERVO=13`) is specified in
> `.claude/PRPs/plans/ejector-mg996r-continuous-servo.plan.md` but **not yet applied to
> `ejector.py`** — the code still has the 28BYJ-48 constants. This doc reflects the target
> wiring; a `grep PIN_IN` will still hit the old code until the plan is implemented.
> The drawer change *is* already in code: `cycle_runner.py` no longer drives the SG90.

### Operator BOM in hand

| Part | Role | Notes |
|---|---|---|
| 17HS8401 NEMA 17 + A4988 driver | Magazine rotation | 1.7 A/phase, 0.43 Nm holding torque, 1.8°/step (200 step/rev) |
| MG996R continuous-rotation servo | Ejector slider drive | 50 Hz PWM sets speed+direction (~1500 us stop, 1600 fwd, 1400 rev); rotates the cam/slider that pushes a pill out of the slot |
| SG90 micro servo | Drawer latch — **demo only** | One servo arm, two angles (LOCK / UNLOCK), 50 Hz PWM. Removed from the dispense cycle; the dashboard lock/unlock button is now a dummy demo toggle |

No diverter (single-chute design). The drawer lock is no longer part of the dispense
control flow — a pill-ID fail simply leaves the rejected pill in the chute for the
operator to remove.

---

## 1. Pi 5 GPIO header (40-pin)

BCM <-> physical pin mapping for every pin we drive:

| BCM | Phys | Header role | Project use | Direction | Notes |
|----:|----:|---|---|---|---|
| 3V3 | 1 | 3V3 power | (unused — sensors removed) | - | Do NOT power servos from this rail |
| 5V  | 2  | 5V power  | (unused — servos use ext 5-6V) | - | Pi 5V is for the Pi itself |
| GND | 6,9,14,20,25,30,34,39 | Ground | Common ground for ALL subsystems | - | Tie every PSU GND back here |
| 13  | 33 | PWM1 (HW)   | MG996R ejector servo signal | PWM 50 Hz | hardware PWM channel 1 |
| 17  | 11 | GPIO        | A4988 STEP (NEMA17 magazine) | OUT | 5 us pulses |
| 18  | 12 | PWM0 (HW)   | SG90 drawer servo signal — **demo only** | PWM 50 Hz | not driven by the cycle; bench/demo |
| 22  | 15 | GPIO        | A4988 ENABLE (NEMA17 magazine) | OUT | active-low -> driven LOW = enabled |
| 27  | 13 | GPIO        | A4988 DIR (NEMA17 magazine) | OUT | HIGH = forward (slot index +) |

Free / unused: BCM 4 (kernel can claim for w1-gpio / camera-i2c), BCM 5/6/16/26 (freed — were the 28BYJ-48 ejector ULN2003), BCM 23 (was DHT11 — sensor removed). BCM 13 (PWM1) now drives the MG996R ejector; BCM 18 (PWM0) stays reserved for the SG90 drawer (demo). Continuous servos tolerate software-PWM jitter, but using the two hardware PWM channels keeps both servos clean.

CSI camera ports (separate ribbon connectors, NOT the 40-pin header):

| Port | Camera | Purpose |
|---|---|---|
| CAM0 | imx219 (Camera Module v2) | Pill ID — over the catch tray |
| CAM1 | imx708 (Camera Module 3) | Intake (swallow FSM) — patient-facing |

`vision/camera.py` opens cam_num 0 first, then 1. Match the ribbon to the role.

---

## 2. Power architecture

Three separate rails, common ground.

```
   Wall PSU --+-- Pi 5 USB-C 5V/5A ---------> Pi 5 (logic, cameras)
              |
              +-- Stepper PSU 12V 2A --> A4988 VMOT (NEMA17)
              |
              +-- 5-6V 3A buck (or 2nd PSU) --> MG996R V+ (ejector servo)
                                                SG90 V+ (drawer servo, demo)

   ALL GROUNDS TIED -> Pi GND (any of pins 6/9/14/20/25/30/34/39)
```

Reasons:

- NEMA 17 stalls at >1 A. Backfeeding through the Pi rail browns the SoC.
- MG996R stalls at ~2.5 A; SG90 pulls 500-700 mA on stall. Pi 5V can't share without browning out — give the MG996R its own 5-6V/3A leg.
- Common ground is non-negotiable: GPIO logic is referenced to Pi GND. Floating ext PSU = sporadic glitches you will misdiagnose for weeks.

---

## 3. Subsystem wiring

### 3.1 Magazine — 17HS8401 NEMA 17 + A4988

The 17HS8401 is a 200-step/rev (1.8°/step) bipolar with **1.7 A/phase** rated current. Pololu A4988 max is ~2 A with cooling — set the limiter to ~1.0–1.2 A for safe long-duty operation.

Driver pins (Pololu A4988 BOB pinout):

| Driver pin | Connect to |
|---|---|
| VMOT | 12 V stepper PSU + |
| GND (motor) | stepper PSU GND (also tied to Pi GND) |
| VDD | Pi 3V3 (pin 1) |
| GND (logic) | Pi GND |
| STEP | Pi physical 11 (BCM 17) |
| DIR | Pi physical 13 (BCM 27) |
| EN  | Pi physical 15 (BCM 22) |
| RESET <-> SLEEP | jumper together (always awake) |
| MS1/MS2/MS3 | leave open = full step. 200 steps/rev matches `STEPS_PER_SLOT=200` (placeholder — see note below) |
| 1A 1B 2A 2B | 17HS8401 four wires. Black/Green = coil A, Red/Blue = coil B (typical Usongshine wiring). Verify with multimeter: ~1.5 ohm between same-coil pins. |

Add 100 uF electrolytic across VMOT<->GND right at the driver. Skip it and the driver browns out on first step.

**Vref calc for 17HS8401:** Pololu A4988 formula `Vref = Imax * 8 * Rsense`. With 0.05 ohm sense resistors (most common A4988 BOB) and 1.0 A target -> `Vref ~ 0.40 V`. With 0.1 ohm -> `Vref ~ 0.80 V`. Read the silkscreen on YOUR board's sense resistor (R100 = 0.1 ohm, R050 = 0.05 ohm) before trusting either number. Measure with motor disconnected, USB power only.

**Note on `STEPS_PER_SLOT=200`** (`magazine.py:20`): 200 = one full revolution. For a 10-slot magazine the geometry is one slot = 36° = 20 full steps. The current value rotates the motor a full turn per slot — fine if there's a 10:1 reduction belt/gear, otherwise tune down to ~20 once the mechanism is built. Update the constant in code, not in this doc.

### 3.2 Ejector — MG996R continuous-rotation servo (BCM 13 / hardware PWM1)

| MG996R wire | Connect to |
|---|---|
| Signal (orange/white) | Pi physical 33 (BCM 13) |
| V+ (red) | external 5-6 V rail (NOT Pi 5V — stall ~2.5 A) |
| GND (brown/black) | external rail GND **and** Pi GND |

A continuous-rotation servo reads pulse WIDTH as speed + direction, not angle: ~1500 us = stop, >1500 = one way, <1500 = the other. Further from 1500 = faster. Mirrors the bench-validated Arduino sketch (`writeMicroseconds`).

Driver tunables (`backend/hardware/ejector.py`), as 50 Hz duty %:

- `STOP_DUTY = 7.5` (1500 us) — neutral / stop.
- `FWD_DUTY = 8.0` (1600 us) — forward stroke.
- `REV_DUTY = 7.0` (1400 us) — return stroke.
- `MOVE_S = 7.5`, `PAUSE_S = 1.0` — Arduino `MOVE_MS` / `PAUSE_MS` in seconds.

`push()` drives FWD for `MOVE_S`, STOP for `PAUSE_S`, REV for `MOVE_S`, STOP for `PAUSE_S`, then sets duty 0 so the servo receives no pulses and fully stops. Ending at duty 0 is essential: a continuous servo left at a slightly-off STOP duty creeps forever.

If it spins the wrong way, swap `FWD_DUTY` <-> `REV_DUTY`. If it creeps while "stopped", trim `STOP_DUTY` in 0.1 % steps.

### 3.3 Drawer lock — SG90 servo arm (BCM 18 / hardware PWM0) — demo only

> **Demo only.** The SG90 is no longer part of the dispense control flow:
> `cycle_runner.py` no longer constructs `DrawerLock` or unlocks during a dispense.
> The dashboard lock/unlock button calls `/api/device/drawer`, which now flips an
> in-memory flag (no servo). Wire this only if you physically demo the latch via
> `hardware/test_drawer.py`. The boot-to-LOCK / `ChangeDutyCycle(0)` behavior below
> applies only when `DrawerLock()` is actually constructed (i.e. the bench test).

| SG90 wire | Connect to |
|---|---|
| Signal (orange) | Pi physical 12 (BCM 18) |
| V+ (red) | external 5 V rail (NOT Pi 5V — SG90 stall current spikes) |
| GND (brown) | external 5 V GND **and** Pi GND |

Duty cycles (`drawer_lock.py:43-44`): `LOCK_DUTY=7.5` (~90deg, latch engaged), `UNLOCK_DUTY=12.5` (~180deg, latch disengaged). Adjust both if the servo doesn't fully engage / disengage your specific latch geometry.

After every move, the driver calls `ChangeDutyCycle(0)` so the coils don't sing or burn between cycles. The arm holds position by the servo's internal gearbox detent.

**Fail-safe note**: install a spring-return latch so a dead servo drifts to LOCK by physical bias. The driver also drives to LOCK at boot, but a physical default is the real safety net.

### 3.4 Cameras

CSI ribbons go straight into CAM0 / CAM1 on the Pi 5 board. No GPIO wiring. `vision/camera.py` falls back from `Picamera2Source` -> `RpicamSource` (rpicam-vid + cv2) -> `Cv2Source`. Both ribbon orientations: contacts toward the HDMI side.

---

## 4. Bring-up order

Follow this sequence on the bench. Each step is a kill-switch — stop if it fails.

1. **Pi alone** boots. `pinctrl get 17,27,22,18,13` returns `ip` / `op` cleanly.
2. **A4988 Vref** set with motor disconnected. Then plug 17HS8401.
3. **One magazine rotation** in REPL: `Magazine().rotate_to(1)` — smooth rotation forward + back.
4. **MG996R ejector** wired (slider cam detached so it can spin freely). `sudo -E .venv/bin/python hardware/test_ejector.py` runs 3 fwd/rev cycles, servo silent between.
5. **Drawer servo** (optional — demo only) wired with latch arm detached. `sudo -E .venv/bin/python hardware/test_drawer.py` shows visible rotation LOCK -> UNLOCK -> LOCK.
6. **CSI cameras** plugged. `rpicam-hello --list-cameras` shows imx219 + imx708.
7. **Full service**: `sudo -E .venv/bin/python main.py` (or systemd) and watch logs.

Stub mode (`PHARMGUARD_STUB=1`) skips every wiring failure with warnings — only flip it back to `0` once **every** subsystem above has been individually proved.

---

## 5. Conflict / contention check

| Risk | Mitigation |
|---|---|
| BCM 18 is also I2S — leave I2S disabled in raspi-config | Default Bookworm/Trixie config is fine; do not `dtparam=i2s=on` |
| `RPi.GPIO` setmode is global — re-entrant `GPIO.cleanup()` in one driver wipes the others | Each driver guards its own pin only; do **not** add bare `GPIO.cleanup()` calls |
| Stepper + 2 servos sharing one cheap 5V/12V combo brick | Give the MG996R its own 5-6V/3A leg; stepper pulses inject noise into servo PWM, and the MG996R's ~2.5 A stall sags a shared rail |
| MG996R creeps while "stopped" | `ejector.py:push()` ends at `ChangeDutyCycle(0)`; trim `STOP_DUTY` if it still drifts |

---

## 6. Quick BCM-pin reference card

```
   3V3 (1)  (2)  5V
    SDA (3)  (4)  5V
    SCL (5)  (6)  GND
    -  (7)  (8)  TXD
        GND (9) (10) RXD
   STEP (11)(12) DRAWER       <- BCM 17 mag STEP / BCM 18 drawer servo (PWM0, demo)
    DIR (13)(14) GND          <- BCM 27 mag DIR
    EN  (15)(16) -            <- BCM 22 mag EN
   3V3 (17)(18) -
    -  (19)(20) GND
    -  (21)(22) -
    -  (23)(24) -
        GND (25)(26) -
    -  (27)(28) -
    -  (29)(30) GND
    -  (31)(32) -
  EJECT (33)(34) GND          <- BCM 13 MG996R ejector servo (PWM1)
    -  (35)(36) -
    -  (37)(38) -
        GND (39)(40) -
```

---

## 7. After-wiring code checks

Before flipping the service back on:

```bash
# 1. confirm pin constants haven't drifted (PIN_SERVO now = ejector 13 + drawer 18)
grep -RnE "PIN_STEP|PIN_DIR|PIN_ENABLE|PIN_SERVO" backend/hardware/

# 2. dry-run each driver with stub OFF
sudo -E .venv/bin/python hardware/test_magazine.py
sudo -E .venv/bin/python hardware/test_ejector.py
sudo -E .venv/bin/python hardware/test_drawer.py   # optional — demo only

# 3. dual-cam bench
sudo -E .venv/bin/python scripts/bench_dual_cam.py --duration 15
```

If any subsystem refuses to construct with `PHARMGUARD_STUB=0`, the wiring is wrong — fix it; do **not** set `PHARMGUARD_STUB=1` to mask the failure (HI-012 invariant).
