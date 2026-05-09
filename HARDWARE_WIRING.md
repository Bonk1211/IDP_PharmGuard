# PharmGuard hardware wiring plan

Pin map derived from current source. Authoritative sources:

| Component | File | Pin constant |
|---|---|---|
| Magazine stepper (NEMA17 + A4988) | `backend/hardware/magazine.py:15-18` | `PIN_STEP=17`, `PIN_DIR=27`, `PIN_ENABLE=22` |
| Ejector stepper (28BYJ-48 + ULN2003) | `backend/hardware/ejector.py:34-38` | `PIN_IN1=5`, `PIN_IN2=6`, `PIN_IN3=16`, `PIN_IN4=26` |
| Drawer-lock servo (SG90) | `backend/hardware/drawer_lock.py:42` | `PIN_SERVO=18` (hardware PWM0) |
| Pill / intake cams | `backend/vision/camera.py` | CSI ports CAM0 + CAM1 |

If a pin constant changes in code, update this file in the same commit.

### Operator BOM in hand

| Part | Role | Notes |
|---|---|---|
| 17HS8401 NEMA 17 + A4988 driver | Magazine rotation | 1.7 A/phase, 0.43 Nm holding torque, 1.8°/step (200 step/rev) |
| 28BYJ-48 (5 V) + ULN2003 board | Ejector slider drive | 4-pin half-step sequence; rotates the cam that pushes a pill out of the slot |
| SG90 micro servo | Drawer latch | One servo arm, two angles (LOCK / UNLOCK). 50 Hz hardware PWM |

No diverter (single-chute design — pill-ID fail keeps the drawer locked).

---

## 1. Pi 5 GPIO header (40-pin)

BCM <-> physical pin mapping for every pin we drive:

| BCM | Phys | Header role | Project use | Direction | Notes |
|----:|----:|---|---|---|---|
| 3V3 | 1 | 3V3 power | (unused — sensors removed) | - | Do NOT power servo / 28BYJ-48 from this rail |
| 5V  | 2  | 5V power  | (unused — SG90 + ULN2003 use ext 5V) | - | Pi 5V is for the Pi itself |
| GND | 6,9,14,20,25,30,34,39 | Ground | Common ground for ALL subsystems | - | Tie every PSU GND back here |
| 5   | 29 | GPIO        | ULN2003 IN1 (28BYJ-48 ejector) | OUT | 1 of 4 stepper coils |
| 6   | 31 | GPIO        | ULN2003 IN2 (28BYJ-48 ejector) | OUT | 2 of 4 stepper coils |
| 16  | 36 | GPIO        | ULN2003 IN3 (28BYJ-48 ejector) | OUT | 3 of 4 stepper coils |
| 17  | 11 | GPIO        | A4988 STEP (NEMA17 magazine) | OUT | 5 us pulses |
| 18  | 12 | PWM0 (HW)   | SG90 drawer-lock servo signal | PWM 50 Hz | hardware PWM channel 0 |
| 22  | 15 | GPIO        | A4988 ENABLE (NEMA17 magazine) | OUT | active-low -> driven LOW = enabled |
| 26  | 37 | GPIO        | ULN2003 IN4 (28BYJ-48 ejector) | OUT | 4 of 4 stepper coils |
| 27  | 13 | GPIO        | A4988 DIR (NEMA17 magazine) | OUT | HIGH = forward (slot index +) |

Free / unused: BCM 4 (kernel can claim for w1-gpio / camera-i2c), BCM 13 (was diverter PWM1), BCM 23 (was DHT11 — sensor removed). Reserve hardware PWM0 (BCM 18) for the servo — software PWM jitters and the SG90 will twitch.

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
              +-- 5V 3A buck (or 2nd PSU) --> ULN2003 +5V (28BYJ-48)
                                              SG90 V+ (drawer servo)

   ALL GROUNDS TIED -> Pi GND (any of pins 6/9/14/20/25/30/34/39)
```

Reasons:

- NEMA 17 stalls at >1 A. Backfeeding through the Pi rail browns the SoC.
- SG90 servos pull 500-700 mA on stall; 28BYJ-48 ~250 mA continuous. Pi 5V can't share without voltage sag.
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

### 3.2 Ejector — 28BYJ-48 stepper + ULN2003 driver board

| ULN2003 pin | Connect to |
|---|---|
| IN1 | Pi physical 29 (BCM 5) |
| IN2 | Pi physical 31 (BCM 6) |
| IN3 | Pi physical 36 (BCM 16) |
| IN4 | Pi physical 37 (BCM 26) |
| +5V | external 5 V rail (NOT Pi 5V) |
| GND | external 5 V GND **and** Pi GND |
| Motor connector | 5-pin JST keyed plug from 28BYJ-48 — only fits one way |

Driver tunables (`backend/hardware/ejector.py`):

- `EJECT_STEPS = 512` — 1/8 turn in half-step mode (4096 half-steps/rev). Tune mechanically once the slider geometry is built.
- `STEP_DELAY_S = 0.002` — gentle, near practical max speed. Increase to 0.003-0.005 if the motor stalls/skips.

`push()` runs `EJECT_STEPS` half-steps forward, then the same backward, then de-energises all 4 coils. De-energising at rest is essential — leaving coils on heats the motor and wastes ~150 mA continuous.

### 3.3 Drawer lock — SG90 servo arm (BCM 18 / hardware PWM0)

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

1. **Pi alone** boots. `pinctrl get 17,27,22,18,5,6,16,26` returns `ip` / `op` cleanly.
2. **Drawer servo** wired (latch arm detached so it can swing freely). `sudo -E .venv/bin/python hardware/test_drawer.py` shows visible rotation LOCK -> UNLOCK -> LOCK.
4. **A4988 Vref** set with motor disconnected. Then plug 17HS8401.
5. **One magazine rotation** in REPL: `Magazine().rotate_to(1)` — smooth rotation forward + back.
6. **28BYJ-48 ejector** wired. `sudo -E .venv/bin/python hardware/test_ejector.py` rotates the motor 3 cycles.
7. **CSI cameras** plugged. `rpicam-hello --list-cameras` shows imx219 + imx708.
8. **Full service**: `sudo -E .venv/bin/python main.py` (or systemd) and watch logs.

Stub mode (`PHARMGUARD_STUB=1`) skips every wiring failure with warnings — only flip it back to `0` once **every** subsystem above has been individually proved.

---

## 5. Conflict / contention check

| Risk | Mitigation |
|---|---|
| BCM 18 is also I2S — leave I2S disabled in raspi-config | Default Bookworm/Trixie config is fine; do not `dtparam=i2s=on` |
| `RPi.GPIO` setmode is global — re-entrant `GPIO.cleanup()` in one driver wipes the others | Each driver guards its own pin only; do **not** add bare `GPIO.cleanup()` calls |
| Stepper, 28BYJ-48, and servo PSUs sharing one cheap 5V/12V combo brick | OK if rated >3 A on the 5 V leg AND has separate windings; otherwise stepper pulses inject noise into the servo PWM |
| 28BYJ-48 coils overheat at rest | `ejector.py:push()` de-energises all 4 coils after each cycle |

---

## 6. Quick BCM-pin reference card

```
   3V3 (1)  (2)  5V
    SDA (3)  (4)  5V
    SCL (5)  (6)  GND
    -  (7)  (8)  TXD
        GND (9) (10) RXD
   STEP (11)(12) DRAWER       <- BCM 17 mag STEP / BCM 18 drawer servo (PWM0)
    DIR (13)(14) GND          <- BCM 27 mag DIR
    EN  (15)(16) -            <- BCM 22 mag EN
   3V3 (17)(18) -
    -  (19)(20) GND
    -  (21)(22) -
    -  (23)(24) -
        GND (25)(26) -
    -  (27)(28) -
   IN1 (29)(30) GND          <- BCM 5 ejector IN1
   IN2 (31)(32) -            <- BCM 6 ejector IN2
    -  (33)(34) GND
    -  (35)(36) IN3          <- BCM 16 ejector IN3
   IN4 (37)(38) -            <- BCM 26 ejector IN4
        GND (39)(40) -
```

---

## 7. After-wiring code checks

Before flipping the service back on:

```bash
# 1. confirm pin constants haven't drifted
grep -RnE "PIN_STEP|PIN_DIR|PIN_ENABLE|PIN_SERVO|PIN_IN[1-4]" backend/hardware/

# 2. dry-run each driver with stub OFF
sudo -E .venv/bin/python hardware/test_drawer.py
sudo -E .venv/bin/python hardware/test_magazine.py
sudo -E .venv/bin/python hardware/test_ejector.py

# 3. dual-cam bench
sudo -E .venv/bin/python scripts/bench_dual_cam.py --duration 15
```

If any subsystem refuses to construct with `PHARMGUARD_STUB=0`, the wiring is wrong — fix it; do **not** set `PHARMGUARD_STUB=1` to mask the failure (HI-012 invariant).
