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
| NEMA 17 stepper motor | 1 | Phase 2 mech | magazine rotation | TBD | TBD | TBD | 1.8°/step, 200 steps/rev |
| A4988 or DRV8825 driver | 1 | Phase 2 mech | NEMA 17 driver | TBD | TBD | TBD | DRV8825 preferred (more headroom) |
| Servo (ejector — slider-crank) | 1 | Phase 2 mech | SG90 / MG996R class | TBD | TBD | TBD | torque sized for slider-crank load |
| Servo (diverter flap) | 1 | Phase 4 | reject-bin gate | TBD | TBD | TBD | SG90 sufficient |
| Solenoid (drawer lock) | 1 | Phase 4 | 12 V latch solenoid | TBD | TBD | TBD | needs flyback diode + dedicated 12 V rail |
| Pi Camera Module 3 (or v2) — cam 0 | 1 | Phase 2 | tray top-down (pill ID) | TBD | TBD | TBD | NoIR not required |
| Pi Camera Module 3 (or v2) — cam 1 | 1 | Phase 2 | patient-facing (swallow / liveness) | TBD | TBD | TBD | wide-angle helps Step-1 hand detection |
| DS18B20 1-wire temperature sensor | 1 | Phase 5 | tray temperature | TBD | TBD | TBD | + 4.7 kΩ pull-up |
| 10-slot magazine (3D-printed, PLA / PETG) | 1 | Phase 2 mech | rotates over ejector | TBD (in-house) | TBD | TBD | injection-molded for hygiene compliance is V2+ |
| Slider-crank linkage + push-rod | 1 | Phase 2 mech | actuated by ejector servo | TBD (in-house) | TBD | TBD | |
| Diverter flap + reject bin | 1 | Phase 4 | servo-actuated flap | TBD (in-house) | TBD | TBD | |
| Lockable drawer + face plate | 1 | Phase 4 | solenoid-released | TBD | TBD | TBD | |
| Power distribution (12 V buck for solenoid + 5 V for Pi) | 1 | core | dual-rail | TBD | TBD | TBD | |
| Wiring + connectors | lot | core | DuPont / JST / 18 AWG for solenoid | TBD | TBD | TBD | |
| Enclosure | 1 | core | bedside footprint < 600 cm² | TBD (in-house) | TBD | TBD | |
| **TOTAL** | | | | | | **TBD** | target: < RM 1,000 |

## Notes

- Components marked **in-house** are 3D-printed or fabricated in lab — material cost only.
- Phase 9 may ship a Hailo-8L or Coral USB accelerator if YOLO p95 misses the <200 ms target on Pi 5 CPU. **Adding either would push BOM past RM 1,000** — track in PRD risk register.
- Phase 4 risk callout: solenoid + dedicated 12 V rail + flyback diode is the trickiest electrical item; double-check before procurement.

## Out of scope

- Frontend / cloud hosting — billed separately.
- Spare parts inventory — not in V1 BOM.
- Tooling (3D printer filament, soldering iron, etc.) — assumed available.
