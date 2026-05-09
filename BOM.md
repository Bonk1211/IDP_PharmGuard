# PharmGuard Bill of Materials

Procurement-tracking artefact for the Phase 10 pilot build.

PRD target: total prototype BOM **< RM 1,000** (~RM 950 forecast).
Operator owns SKU + price columns; this file is the canonical row list.

| Component | Qty | Phase | Detail | SKU / link | Unit price (RM) | Subtotal (RM) | Notes |
|---|---|---|---|---|---|---|---|
| Raspberry Pi 5 (4 GB or 8 GB) | 1 | core | aarch64 + 2 CSI lanes | TBD | TBD | TBD | 8 GB recommended for headroom |
| Active cooling case | 1 | core | thermal throttling mitigation (Phase 2 risk) | TBD | TBD | TBD | required for sustained dual-cam YOLO |
| USB-C 5 V / 5 A power supply | 1 | core | Pi 5 official PSU | TBD | TBD | TBD | undersized PSU = brownout under load |
| microSD card (32 GB+, A2) | 1 | core | Pi OS Bookworm | TBD | TBD | TBD | A2 class for journald + queue.db throughput |
| 17HS8401 NEMA 17 stepper motor | 1 | Phase 2 mech | magazine rotation | TBD | TBD | TBD | 1.8°/step, 200 steps/rev, 1.7 A/phase |
| A4988 driver | 1 | Phase 2 mech | NEMA 17 driver | TBD | TBD | TBD | Vref ~0.4 V (R050 sense) or ~0.8 V (R100 sense) |
| 28BYJ-48 stepper (5 V) + ULN2003 board | 1 | Phase 2 mech | ejector slider drive | TBD | TBD | TBD | half-step sequence on 4 GPIO; ~250 mA continuous |
| SG90 micro servo | 1 | Phase 4 | drawer-lock latch | TBD | TBD | TBD | 50 Hz hardware PWM on BCM 18 |
| Pi Camera Module v2 — cam 0 | 1 | Phase 2 | tray top-down (pill ID) | TBD | TBD | TBD | imx219 |
| Pi Camera Module 3 — cam 1 | 1 | Phase 2 | patient-facing (swallow FSM) | TBD | TBD | TBD | imx708; wide-angle helps Step-1 hand detection |
| DHT11 temperature + humidity sensor | 1 | Phase 5 | tray temperature | TBD | TBD | TBD | 3-pin module has on-board pull-up; 4-pin needs 10 kΩ |
| 10-slot magazine (3D-printed, PLA / PETG) | 1 | Phase 2 mech | rotates over ejector | TBD (in-house) | TBD | TBD | injection-molded for hygiene compliance is V2+ |
| Slider + cam linkage | 1 | Phase 2 mech | driven by 28BYJ-48 | TBD (in-house) | TBD | TBD | tune EJECT_STEPS once geometry fixed |
| Lockable drawer + spring-return latch | 1 | Phase 4 | servo-arm released | TBD | TBD | TBD | spring-return = fail-safe LOCK on power loss |
| Power distribution (12 V for stepper + 5 V buck for ULN2003 / SG90) | 1 | core | dual-rail | TBD | TBD | TBD | |
| Wiring + connectors | lot | core | DuPont / JST 2.54 / motor wires | TBD | TBD | TBD | |
| Enclosure | 1 | core | bedside footprint < 600 cm² | TBD (in-house) | TBD | TBD | |
| **TOTAL** | | | | | | **TBD** | target: < RM 1,000 |

## Notes

- Components marked **in-house** are 3D-printed or fabricated in lab — material cost only.
- Phase 9 may ship a Hailo-8L or Coral USB accelerator if YOLO p95 misses the <200 ms target on Pi 5 CPU. **Adding either would push BOM past RM 1,000** — track in PRD risk register.
- 28BYJ-48 + ULN2003 is fragile under sustained stall — install end-stops on the slider mechanism so a jam doesn't burn the coils.

## Out of scope

- Frontend / cloud hosting — billed separately.
- Spare parts inventory — not in V1 BOM.
- Tooling (3D printer filament, soldering iron, etc.) — assumed available.
