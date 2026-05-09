# PharmGuard hardware wiring plan

Pin map derived from current source. Authoritative sources:

| Component | File | Pin constant |
|---|---|---|
| Magazine stepper | `backend/hardware/magazine.py:15-18` | `PIN_STEP=17`, `PIN_DIR=27`, `PIN_ENABLE=22` |
| Ejector servo | `backend/hardware/ejector.py:15` | `PIN_SERVO=18` |
| Diverter servo | `backend/hardware/diverter.py:17` | `PIN_SERVO=13` |
| Drawer solenoid | `backend/hardware/drawer_lock.py:17` | `PIN_SOLENOID=23` |
| Tray temp DHT11 | `backend/hardware/temp_sensor.py:33` | `DHT_BCM_PIN=4` (single GPIO, no 1-wire overlay) |
| Pill / intake cams | `backend/vision/camera.py` | CSI ports CAM0 + CAM1 |

### Operator BOM in hand

| Part | Role | Notes |
|---|---|---|
| 17HS8401 NEMA 17 + A4988 driver | Magazine rotation | 1.7 A/phase, 0.43 Nm holding torque, 1.8°/step (200 step/rev) |
| SG90 micro servo (x2) | Ejector + diverter | One on BCM 18 (PWM0), one on BCM 13 (PWM1) |
| DHT11 | Tray temperature | Replaced DS18B20; library `adafruit-circuitpython-dht` already in `requirements.txt` |
| 28BYJ-48 + ULN2003 | **Spare** | Not wired in current build. Too low torque (~34 mNm) for the magazine. Save for future revs. |

If a pin constant changes in code, update this file in the same commit.

---

## 1. Pi 5 GPIO header (40-pin)

BCM <-> physical pin mapping for every pin we drive:

| BCM | Phys | Header role | Project use | Direction | Notes |
|----:|----:|---|---|---|---|
| 3V3 | 1 | 3V3 power | DS18B20 VDD + 4.7 kohm pull-up | - | Do NOT power servos/solenoid from this rail |
| 5V  | 2  | 5V power  | (unused - servos use ext 5V) | - | Pi 5 5V is for the Pi itself |
| GND | 6,9,14,20,25,30,34,39 | Ground | Common ground for ALL subsystems | - | Tie every PSU GND back here |
| 4   | 7  | GPIO        | DHT11 DATA | IN/OUT | bit-banged via `adafruit-circuitpython-dht`; 10 kohm pull-up to 3V3 |
| 17  | 11 | GPIO        | Stepper driver `STEP` | OUT | 5 us pulses, see `magazine.py:102-104` |
| 18  | 12 | PWM0 (HW)   | Ejector servo signal | PWM 50 Hz | hardware PWM channel 0 |
| 27  | 13 | GPIO        | Stepper driver `DIR` | OUT | HIGH = forward (slot index +) |
| 22  | 15 | GPIO        | Stepper driver `ENABLE` | OUT | active-low -> driven LOW = enabled |
| 23  | 16 | GPIO        | Solenoid MOSFET gate | OUT | HIGH = unlocked, LOW = locked (fail-safe) |
| 13  | 33 | PWM1 (HW)   | Diverter servo signal | PWM 50 Hz | hardware PWM channel 1 |

Free pins on header: everything not listed. Reserve PWM0/PWM1 for the two servos - software PWM on `RPi.GPIO`/`rpi-lgpio` jitters and SG90/MG90 will twitch.

CSI camera ports (separate ribbon connectors, NOT the 40-pin header):

| Port | Camera | Purpose |
|---|---|---|
| CAM0 | imx219 (Camera Module v2) | Pill ID - over the catch tray |
| CAM1 | imx708 (Camera Module 3) | Intake (swallow FSM) - patient-facing |

`vision/camera.py` opens cam_num 0 first, then 1. Match the ribbon to the role.

---

## 2. Power architecture

Three separate rails, common ground.

```
   Wall PSU --+-- Pi 5 USB-C 5V/5A ---------> Pi 5 (logic, cameras)
              |
              +-- Stepper PSU 12V 2A --> A4988/DRV8825 VMOT
              |
              +-- Servo / Solenoid 5V 3A buck (or 2nd PSU) --> servo V+, MOSFET drain side

   ALL GROUNDS TIED -> Pi GND (any of pins 6/9/14/20/25/30/34/39)
```

Reasons:

- NEMA 17 stalls at >1 A. Backfeeding through the Pi rail browns the SoC.
- SG90/MG90 servos pull 500-800 mA on stall. Pi 5 5V cannot share without voltage sag.
- Common ground is non-negotiable: GPIO logic is referenced to Pi GND. Floating servo/stepper PSU = sporadic glitches you will misdiagnose for weeks.

---

## 3. Subsystem wiring

### 3.1 Magazine - 17HS8401 NEMA 17 + A4988

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

### 3.2 Ejector servo (SG90 linear push) - BCM 18

| SG90 wire | Connect to |
|---|---|
| Signal (orange) | Pi physical 12 (BCM 18) |
| V+ (red) | external 5 V rail (NOT Pi 5V — SG90 stall current spikes) |
| GND (brown) | external 5 V GND **and** Pi GND |

Code drives 2.5 % / 7.5 % duty at 50 Hz (`ejector.py:62-66`). 7.5 % ~ 1.5 ms ~ 90deg push, 2.5 % ~ 0.5 ms ~ rest. Mechanical end-stops on both extremes prevent stall-burn if the slider crank jams. SG90s burn out under sustained stall — the end-stops are non-optional.

### 3.3 Diverter servo (SG90 flap) - BCM 13

Same wiring pattern as the ejector SG90 but signal to physical 33.

Duty cycles (`diverter.py:22-23`): `DELIVER_DUTY=7.5` (neutral chute), `REJECT_DUTY=12.5` (rejected-bin chute). Mount the flap so DELIVER is the gravity-neutral rest position - that way a power loss with `ChangeDutyCycle(0)` leaves good pills going to the patient drawer, not the reject bin.

### 3.4 Drawer solenoid - BCM 23

Logic-level N-channel MOSFET (e.g. AO3400, IRLZ44N) or 5 V relay module:

```
   Pi BCM 23 --[1 kohm]-- Gate --+ MOSFET +-- Drain -- Solenoid -- 12V/5V solenoid PSU+
                  Source --------+--------+
                       |
                       +-- Pi GND + solenoid PSU GND

   Flyback diode (1N4007) across solenoid coil, cathode -> PSU+, anode -> drain.
```

Pin behaviour (`drawer_lock.py:43, 76, 87`):

- Boot -> LOW -> solenoid de-energised -> drawer **locked** (fail-safe).
- Unlock -> HIGH for `DRAWER_OPEN_S=10 s`, then LOW.

Without the flyback diode the back-EMF on every relock will eventually kill the MOSFET.

### 3.5 DHT11 temperature sensor

The 3-pin DHT11 module variant has the 10 kohm pull-up already on board (look for the SMD resistor next to the VCC pin). The bare 4-pin sensor needs an external pull-up — add 10 kohm between DATA and 3V3.

```
   3V3 (pin 1) --+-- DHT11 VCC (+)
                 |
                 +-- [10 kohm] -- DHT11 DATA -- Pi physical 7 (BCM 4)
                 |   (skip if 3-pin module — pull-up is on the PCB)
                 +
                GND ----------- DHT11 GND (-) -- Pi GND (pin 9)
```

**No `dtoverlay`** required — DHT11 is bit-banged via libgpiod. Just enable the python lib:

```bash
# already pinned in backend/requirements.txt:
#   adafruit-circuitpython-dht>=4.0.0,<5.0.0
.venv/bin/pip install -r backend/requirements.txt
```

Verify after wiring (with the venv active):

```bash
PHARMGUARD_STUB=0 python -c "from hardware.temp_sensor import TempSensor; t=TempSensor(); print('temp_c =', t.read_celsius())"
```

Expected: a number between ~20 and ~30 (room temperature). DHT11 returns `None` on a checksum miss; the reader retries 3 times with ~1 s backoff (`temp_sensor.py:READ_RETRIES`). Persistent `None` -> wiring fault (no pull-up, swapped data/GND, or DEAD module).

### 3.6 Cameras

CSI ribbons go straight into CAM0 / CAM1 on the Pi 5 board. No GPIO wiring. `vision/camera.py` falls back from `Picamera2Source` -> `RpicamSource` (rpicam-vid + cv2) -> `Cv2Source`. Both ribbon orientations: contacts toward the HDMI side.

---

## 4. Bring-up order

Follow this sequence on the bench. Each step is a kill-switch - stop if it fails.

1. **Pi alone** boots. `pinctrl get 17,27,22,18,13,23,4` returns `ip` / `op` cleanly.
2. **DHT11** wired. `python -c "from hardware.temp_sensor import TempSensor; print(TempSensor().read_celsius())"` returns a number, not `None`.
3. **Solenoid + MOSFET** wired (drawer mechanically removed). `gpioset gpiochip4 23=1` for 1 s clicks the coil. Diode in place.
4. **Stepper driver** Vref set with motor disconnected. Then connect motor.
5. **One full magazine rotation** via a python REPL:
   ```python
   from hardware.magazine import Magazine
   m = Magazine(); m.rotate_to(1); m.rotate_to(0); m.cleanup()
   ```
6. **Ejector servo** wired. End-stops fitted before powering.
   ```python
   from hardware.ejector import Ejector
   Ejector().push()
   ```
7. **Diverter servo** same pattern. Confirm DELIVER position is gravity-neutral.
8. **Cameras** connected last (so a previous step's smoke doesn't fall on a CSI ribbon). `rpicam-hello --list-cameras` shows imx219 + imx708.
9. **Full service**: `PHARMGUARD_STUB=0 sudo systemctl start pharmguard` and watch `journalctl -u pharmguard -f`.

Stub mode (`PHARMGUARD_STUB=1`) skips every wiring failure with warnings - only flip it back to `0` once **every** subsystem above has been individually proved.

---

## 5. Conflict / contention check

| Risk | Mitigation |
|---|---|
| BCM 18 and BCM 13 are also I2S - leave I2S disabled in raspi-config | Default Bookworm/Trixie config is fine; do not `dtparam=i2s=on` |
| DHT11 is bit-banged on BCM 4 — preempted by other GPIO consumers | Don't put any other driver on BCM 4. If you ever swap back to DS18B20 you'll also need `dtoverlay=w1-gpio` in `/boot/firmware/config.txt` |
| `RPi.GPIO` setup is global - re-entrant `GPIO.cleanup()` in one driver wipes the others | Each driver guards its own pin only; do **not** add bare `GPIO.cleanup()` calls |
| Stepper and servo PSUs sharing one cheap 5V/12V combo brick | OK if rated >3 A on the 5 V leg AND has separate windings; otherwise stepper pulses inject noise into servo PWM |
| Solenoid coil back-EMF | Flyback diode 1N4007 across coil. Non-negotiable. |

---

## 6. Quick BCM-pin reference card

```
   3V3 (1)  (2)  5V
    SDA (3)  (4)  5V
    SCL (5)  (6)  GND
   DHT (7)  (8)  TXD          <- BCM 4 = DHT11 DATA
        GND (9) (10) RXD
   STEP (11)(12) EJECT-PWM    <- BCM 17 stepper STEP / BCM 18 ejector PWM
    DIR (13)(14) GND          <- BCM 27 stepper DIR
    EN  (15)(16) DRAWER       <- BCM 22 stepper EN / BCM 23 drawer solenoid
   3V3 (17)(18) -
    -  (19)(20) GND
    -  (21)(22) -
    -  (23)(24) -
        GND (25)(26) -
    -  (27)(28) -
    -  (29)(30) GND
    -  (31)(32) -
    -  (33)(34) GND          <- BCM 13 diverter PWM
    -  (35)(36) -
    -  (37)(38) -
        GND (39)(40) -
```

---

## 7. After-wiring code checks

Before flipping the service back on:

```bash
# 1. confirm pin constants haven't drifted
grep -RnE "PIN_STEP|PIN_DIR|PIN_ENABLE|PIN_SERVO|PIN_SOLENOID" backend/hardware/

# 2. dry-run each driver with stub OFF
PHARMGUARD_STUB=0 .venv/bin/python -c "from hardware.drawer_lock import DrawerLock; d=DrawerLock(); d.unlock(); d.lock(); d.cleanup()"

# 3. dual-cam bench
.venv/bin/python scripts/bench_dual_cam.py --duration 15
```

If any subsystem refuses to construct with `PHARMGUARD_STUB=0`, the wiring is wrong - fix it; do **not** set `PHARMGUARD_STUB=1` to mask the failure (HI-012 invariant).
