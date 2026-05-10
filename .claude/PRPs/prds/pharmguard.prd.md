# PharmGuard — Bedside AI Vision Medicine Dispenser

## Problem Statement

Hospital "last-mile" medication delivery in isolation wards forces nurses into repeated PPE-cycled bedside visits, leaves cheeking/non-adherence undetected, and creates real-time inventory blackouts the moment drugs leave the central pharmacy. Cost of inaction: nurse PPE fatigue + airborne-pathogen exposure, unverified ingestion (especially psychiatric/TB), and diversion/expiry losses on controlled substances.

## Evidence

- **Assumption — needs validation through clinical interviews.** No primary user research cited in source PRD. Recommend ≥5 ward-nurse + ≥2 hospital-pharmacist interviews before V1 freeze.
- COVID-era PPE shortage and nurse-burnout literature widely documented but not directly cited in this PRD — flag for evidence pack.
- Non-adherence rate for oral meds in inpatient psychiatric and TB wards reported up to 30–50% in published reviews — TBD-cite.
- Existing automated dispensing cabinets (Omnicell, Pyxis MedStation) are **ward-level** not bedside, so the bedside zero-touch gap is structurally real.

## Proposed Solution

A bedside-form-factor (footprint <600 cm²) dispenser combining a 10-slot rotating magazine (NEMA 17 stepper) with an in-line slider-crank ejector, **dual-camera** vision on a Raspberry Pi 5 (one cam for pill-ID/spotter, one cam for hand-to-mouth + swallow FSM), and Face ID unlock of a secured collection drawer. Telemetry streams over HTTP + WebSocket into Supabase-backed FastAPI for real-time dashboards. Chosen over central-dispenser-plus-nurse-runner because the latter cannot remove the physical handover step that drives PPE burn and missed-swallow blind spots.

## Key Hypothesis

We believe **a zero-touch bedside dispenser with dual-camera ingestion verification** will **eliminate routine nurse-patient physical handovers and detect cheeking** for **isolation-ward inpatients on multi-drug regimens**.
We'll know we're right when **(a) ≥95% of scheduled doses are dispensed + ingestion-verified without nurse presence at the bedside, and (b) the system logs ≥99% pill-ID accuracy with <0.1% false-positive rate over a 14-day bench/simulation run.**

## What We're NOT Building

- **Clinical trials on human patients** — V1 is a bench/simulation prototype.
- **EHR integration (Epic / Cerner / HL7-FHIR)** — defer until post-prototype.
- **FDA / MDR / Malaysian MDA medical-device certification** — out of scope; design choices should not preclude later certification but the cert work itself is V2+.
- **Liquid / injectable / refrigerated medications** — solid oral unit-dose only.
- **Multi-tenant hospital deployment** — single-device single-patient-bay V1.
- **Cloud-hosted backend** — V1 backend runs on the Supabase free tier + a local FastAPI dev box; production hosting deferred.
- **Emergency override / manual eject UI** — V2; nurse override path needs separate safety review.

## Success Metrics

| Metric | Target | How Measured |
|---|---|---|
| Pill-ID classification accuracy | > 99% | Bench test: 1,000-pill labelled run across 10 SKU classes |
| False-positive rate (wrong-pill marked correct) | < 0.1% | Same bench run, confusion-matrix analysis |
| Fail-safe reliability (no unverified pill reaches drawer) | 100% | Adversarial run: 200 forced-fault injections (broken pill, wrong slot, occluded cam) |
| End-to-end latency: schedule trigger → pill in drawer | < 8 s | Wall-clock per cycle, n=200 |
| YOLO inference latency on Pi 5 CPU | < 200 ms | `time.perf_counter` around `verifier.verify()`, p95 |
| Database write latency (Pi → Supabase) | < 500 ms | p95 from `report_intake` POST |
| BOM cost | < RM 1,000 | Procurement spreadsheet, prototype quantity 1 |
| Average power draw | < 15 W | Inline USB-C power meter, 1-hr active cycle |
| Footprint | < 600 cm² | CAD bounding-box of base plate |

> Note: PRD's original "<15 ms inference" and ">120 pills/min" targets are **stretch / aspirational** and require a hardware accelerator (Hailo-8L or Coral USB) to be added to BOM. V1 ships the relaxed CPU targets above.

## Open Questions

**Resolved since 2026-05-08** (kept for trail):
- [x] Face ID enrollment location → dashboard (`/patients/[id]/enroll`); embeddings stored in `patients.face_embedding`. Consent + biometric-storage policy still TBD before pilot.
- [x] Camera architecture → dual CSI via `picamera2` / rpicam-vid (`backend/vision/camera.py:RpicamSource` fan-out). USB fallback path retained for dev.
- [x] Expiry tracking column → `medications.expiry_date DATE` (migration 0001).
- [x] Multi-device fleet → `dispenser_id text` on `patients`, `medications`, `adherence_logs`, `alerts` (migrations 0001 + 0004).
- [x] Offline tolerance → SQLite `OfflineQueue` (`backend/storage/queue.py`) + replay loop + refuse-to-dispense after `OFFLINE_MAX_AGE_SECONDS`.
- [x] Diverter flap and drawer-lock → shipped (`backend/hardware/drawer_lock.py`, single-chute design supersedes the diverter; pill-ID fail leaves the drawer locked).
- [x] Face ID liveness → blink/EAR detector (`backend/vision/liveness.py`); printed-photo path documented.

**Still open**:
- [ ] Cheeking detection acceptance threshold: what counts as "ingestion verified"? Need clinical SME to sign off on the 3-step FSM (READY → SWALLOW → DONE) thresholds.
- [ ] Drug interaction / dose-validation logic — handled by pharmacy upstream, or echoed in `medications` table as a hard guardrail?
- [ ] Temperature-sensor action on excursion: alert only, or lock drawer? Endpoint exists; behavioural rule not finalised.
- [ ] Authoritative pill SKU list and labelled training set — still absent. Without it, the 99% accuracy target is a forecast.
- [ ] **RLS disabled** on `alerts`, `agent_briefs`, `agent_flags` (Supabase advisor flag). Acceptable for prototype but must be re-enabled with policies before any multi-tenant deploy.
- [ ] **Schedule timezone** — `medications.schedule_at` is server-local TIME; cross-timezone deploy needs explicit timezone column or store as UTC offset.
- [ ] **`/admin` auth scaling** — single shared `X-Device-API-Key` works for one operator. Multi-user audit trail (who pressed Eject, who set schedule) requires per-user identities.
- [ ] **ngrok URL rotation** — free-tier rotates on Pi reboot, breaking `NEXT_PUBLIC_DEVICE_URL`. Pilot must move to a fixed-domain tunnel (paid ngrok / Cloudflare Tunnel).
- [ ] **Brief cost ceiling** — Gemini brief runs 2× daily by default; no token-budget guardrail. Add a daily-cost cap + retry-budget before pilot.
- [ ] **Manual-vs-schedule conflict resolution** — if operator presses Dispense Now within seconds of `schedule_at` matching, both fire and the second hits "no pending dispense". Acceptable noise; document or queue.

---

## Users & Context

**Primary User — Isolation-Ward Patient (Adult)**
- **Who**: Adult patient in airborne-precaution isolation (TB, COVID-19, MDRO) on a multi-drug oral regimen, capable of self-administering pills but barred from physical caregiver contact.
- **Current behavior**: Waits for PPE-donned nurse to deliver pre-poured cup; nurse observes ingestion through PPE visor.
- **Trigger**: Scheduled dose time on the medication chart.
- **Success state**: Patient receives correct pill, ingests it, the system logs the swallow — **no nurse enters the room** for routine doses.

**Secondary User — Ward Nurse**
- **Who**: RN responsible for 4–8 isolation beds.
- **Current behavior**: Repeated don/doff PPE per dose, manual MAR charting, eyeball-verifies swallow.
- **Trigger**: System-flagged exception (failed ingestion, low stock, hardware fault) — *not* routine doses.
- **Success state**: Receives only exceptions; routine adherence is auto-logged on the dashboard.

**Tertiary User — Pharmacist / Admin**
- **Who**: Hospital pharmacy lead managing controlled-substance audit.
- **Current behavior**: Reconciles ward stock against MAR after each shift.
- **Trigger**: Low-stock or expiry alert; weekly audit.
- **Success state**: Real-time inventory + immutable adherence log eliminates blind spots between central pharmacy and bedside.

**Job to Be Done**
When **a scheduled dose is due for an isolated patient**, I want to **deliver the right pill to the right patient and confirm ingestion without entering the room**, so I can **prevent cross-infection, prove adherence, and free nurse time for higher-acuity work**.

**Non-Users**
- Outpatient / community pharmacy — different form factor, different regulations.
- Pediatric / cognitively-impaired patients — Face ID + self-admin assumption breaks; explicitly out of scope V1.
- Liquid / injectable / refrigerated drugs — different mechanism class.
- General-ward (non-isolation) patients — value prop weaker; central cabinets already serve them.

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|---|---|---|
| Must | 10-slot rotating magazine + slider-crank ejector | Core mechanical contract; everything downstream depends on it |
| Must | YOLO pill-ID via primary CSI camera | "Right drug, right dose" verification — already partially built (`edge_pi/vision/pill_verifier.py`) |
| Must | MediaPipe swallow-FSM via secondary camera | "Right ingestion" — closes the adherence loop, already prototyped (`edge_pi/vision/intake_monitor.py`) |
| Must | Face ID unlock of secured drawer | "Right patient" zero-touch auth; replaces stub at `backend/app/api/auth.py:11` (currently 501) |
| Must | Real-time telemetry to Supabase + WS broadcast to dashboard | Already in place (`backend/app/api/logs.py`, WS at `/api/logs/ws`); extend with new events |
| Must | Device-token auth on every Pi → backend call | Already wired (`backend/app/core/security.py::verify_device_token`); reuse for new endpoints |
| Must | Stub-mode safety guard — refuse to log "pill_taken" without real hardware | Already enforced at `edge_pi/main.py:87-104`; preserve through refactor |
| Should | Diverter flap (reject path for broken / wrong pill) | Increases fail-safe coverage; new GPIO + new `hardware/diverter.py` |
| Should | Expiry-date + low-stock alerts | Schema migration on `medications` table; cron-tick endpoint |
| Should | Internal temperature sensor + alert thresholds | DS18B20 or BME280 over I²C/1-wire; alert via WS |
| Should | Gemini Vision fallback when YOLO confidence low | Service stub already exists (`backend/app/services/gemini_fallback.py`) — finish parsing |
| Could | Offline log queue on Pi (SQLite or JSONL) for backend outage | Today the POST drops on failure |
| Could | Audio prompt to patient ("please swallow now") | UX nicety; not safety-critical |
| Could | Multi-device fleet support (`dispenser_id` column) | Defer until 2nd device exists |
| Did | Pi-hosted FastAPI + ngrok-tunnelled dashboard | Phase 0 — backend now runs on the same Pi as the cycle |
| Did | Clinician assistant chat + scheduled brief (Gemini) | Phase 11 — `/agent` page + `BriefCard`; brief scheduler runs 2×/day default |
| Did | Proactive flag detection + human-in-loop resolve | Phase 12 — heuristic + Gemini detector populates `agent_flags`; `FlagsPanel` ack/resolve/dismiss |
| Did | Floor map dashboard + SWR auto-refresh | Phase 13 — SVG floor plan replaces stat cards; deduped fetches across panels |
| Did | Admin hardware control panel | Phase 14 — `/admin` reset/eject/drawer/snapshot/logs/operations triggers |
| Did | Manual-only by default + per-slot daily schedule | Phase 15 — `manual_dispense_only=True`; cycle idle until trigger or `schedule_at` matches the current minute |
| Won't | EHR / HL7-FHIR integration | Out of scope V1 |
| Won't | FDA/MDA certification work | Out of scope V1 |
| Won't | Liquid / injectable handling | Out of scope V1 |
| Won't | Patient-facing touchscreen UI | Zero-touch is the whole point |

### MVP Scope

The minimum to test the hypothesis:

1. Pi 5 + dual-cam rig dispenses a scheduled pill from one of 10 slots.
2. Camera A confirms pill identity vs. expected SKU; rejects if mismatch.
3. Drawer unlocks only after Face ID match against enrolled patient.
4. Camera B runs the 5-step swallow FSM; logs `pill_taken=true/false` to `adherence_logs`.
5. Dashboard shows event in real time via the existing WS stream.

That is the smallest end-to-end loop that proves "zero-touch correct dispensing + verified ingestion" on a single bench setup. Temperature, expiry, diverter, and offline queue can all wait.

### User Flow

1. **Schedule fires** → Pi polls `/api/inventory/next-dispense` (already implemented at `backend/app/api/inventory.py:24`).
2. **Patient approaches** → Camera B captures face → Pi POSTs to `/api/auth/verify-face` (currently 501 — needs implementation).
3. **Magazine rotates** → `Magazine.rotate_to(slot)` (`edge_pi/hardware/magazine.py:55`).
4. **Ejector pushes** → `Ejector.push()` (`edge_pi/hardware/ejector.py:43`).
5. **Camera A verifies** → `PillVerifier.verify()`; on mismatch → diverter flap rejects (new module).
6. **Drawer unlocks** → solenoid GPIO toggle (new module).
7. **Patient takes pill** → Camera B runs `IntakeMonitor` swallow FSM (`edge_pi/vision/intake_monitor.py`).
8. **Pi POSTs** → `/api/logs/` with `pill_taken` boolean (`backend/app/api/logs.py:20`).
9. **Dashboard updates live** via the existing `/api/logs/ws` broadcast.

---

## Technical Approach

**Feasibility**: **MEDIUM** overall.
- Hardware (magazine, ejector, GPIO via `rpi-lgpio` shim) — HIGH; already prototyped on Pi 5.
- Vision pipelines — HIGH for individual modules, MEDIUM for **dual-camera** simultaneous capture; current code assumes a single camera shared between modules and uses lazy init.
- Face ID with liveness — MEDIUM; backend stub exists, real model + enrolment flow + spoof defence is unbuilt.
- Sub-200 ms YOLO inference on Pi 5 CPU — HIGH (achievable with quantized YOLOv8n / nano weights).
- Sub-15 ms inference and >120 pills/min — LOW without an accelerator; deferred to stretch.
- BOM ≤ RM 1,000 — MEDIUM; tight once you add 2 cameras + Face ID camera + temp sensor + solenoid + diverter servo on top of the Pi 5 + NEMA 17 + driver.

**Architecture Notes**
- Three-tier already defined in `CLAUDE.md`: `edge_pi/` (Pi-side), `backend/` (FastAPI on Supabase), `frontend/` (Next.js dashboard).
- All backend access from Pi is over HTTP + a single device token (`backend/app/core/security.py::verify_device_token`); WebSocket auth uses query-param token (`backend/app/api/logs.py:50-67`).
- Supabase service-role key is **backend-only**; frontend uses anon key. The Pi never holds a Supabase or Gemini key — it speaks to the backend.
- Vision modules currently share one camera with lazy init (`edge_pi/vision/pill_verifier.py`, `edge_pi/vision/intake_monitor.py`). Going dual-cam means refactoring each to take an explicit camera handle (`Picamera2(camera_num=0)` / `camera_num=1`) injected at construction.
- Stub-mode fail-loud guard (`edge_pi/main.py:87-104`) must be preserved through every refactor — the rule is "if hardware is fake, never log `pill_taken=true`."
- `BACKEND_URL` is configured via `edge_pi/config.py` (already moved out of hardcoded `localhost`); Pi uses an env-driven settings module.
- Authoritative behavioural spec for the swallow FSM is `ml/swallow/main5.py` per `CLAUDE.md`; preserve the Step-4 inverted-logic invariant.

**Technical Risks**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pi 5 cannot drive 2 CSI cams + YOLO + MediaPipe at once without thermal throttling | M | Active cooling case; benchmark p95 under sustained load before locking the dual-cam decision |
| Face ID model footprint + accuracy tradeoff on Pi CPU | M | Run face encoding on backend (Pi sends a face crop, already wired at `edge_pi/main.py:33-46`); only liveness check stays Pi-side |
| Photo-spoof defeats Face ID (printed photo of patient) | M | Add blink-detection or NIR camera for liveness; document residual risk if deferred |
| YOLO confidence collapses on real pills outside training distribution | H | Gemini fallback already scaffolded; require an authoritative labelled training set before claiming 99% |
| Slider-crank jams on softgel / odd-shaped pills | M | Restrict V1 to flat round/oval tablets; document mechanical envelope |
| BOM creep blows RM 1,000 once 2 cams + temp sensor + solenoid + diverter added | H | Track BOM as a live spreadsheet; cut Could/Should items first if over budget |
| Backend outage drops adherence logs (no Pi-side queue today) | M | Add SQLite buffer on Pi as a Could-have; refuse to dispense if backend unreachable for >N minutes |
| Multi-pill-per-dose ambiguity (one slot = one drug, but a dose may be multiple pills) | M | Confirm dose semantics in `medications` schema; may require a `pills_per_dose` column |
| Supabase free-tier rate limits in production | L | Migrate to paid tier before pilot |
| `RPi.GPIO` "fix" attempt undoes the `rpi-lgpio` shim | M | Documented in `CLAUDE.md`; codify in CONTRIBUTING + CI lint if added |

---

## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: phases that can run concurrently (e.g., "with 3" or "-")
  DEPENDS: phases that must complete first (e.g., "1, 2" or "-")
  PRP: link to generated plan file once created
-->

| # | Phase | Description | Status | Parallel | Depends | PRP Plan |
|---|---|---|---|---|---|---|
| 0 | Pi-hosted backend reorg | Move FastAPI from dev box onto the Pi; ngrok-tunnel the dashboard to it; consolidate `edge_pi/` into `backend/` | complete | - | - | [completed/pi-hosted-backend.plan.md](../plans/completed/pi-hosted-backend.plan.md) · [report](../reports/pi-hosted-backend-report.md) |
| 1 | Schema + telemetry hardening | Add `dispenser_id`, `expiry_date`, `pills_per_dose` columns; harden `/api/logs` + `/api/inventory` for new fields | complete | with 2 | - | [completed/schema-telemetry-hardening.plan.md](../plans/completed/schema-telemetry-hardening.plan.md) · [report](../reports/schema-telemetry-hardening-report.md) |
| 2 | Dual-camera refactor | Refactor `pill_verifier` + `intake_monitor` to accept injected camera handles; verify two CSI cams on Pi 5 simultaneously | complete (code; Pi hardware bench is the operator-attested validation) | with 1 | - | [completed/dual-camera-refactor.plan.md](../plans/completed/dual-camera-refactor.plan.md) · [report](../reports/dual-camera-refactor-report.md) |
| 3 | Face ID end-to-end | Replace 501 stub at `/api/auth/verify-face`; add enrolment endpoint + liveness check on Pi | complete (code; Pi live spoof test is the operator-attested validation) | - | 1 | [completed/face-id-end-to-end.plan.md](../plans/completed/face-id-end-to-end.plan.md) · [report](../reports/face-id-end-to-end-report.md) |
| 4 | Diverter + drawer-lock hardware | New `hardware/diverter.py` + `hardware/drawer_lock.py`; wire into `main.py` cycle | complete (code; Pi adversarial bench is the operator-attested validation) | with 5 | 2 | [completed/diverter-drawer-lock.plan.md](../plans/completed/diverter-drawer-lock.plan.md) · [report](../reports/diverter-drawer-lock-report.md) |
| 5 | Sensor + alerts | Temperature sensor module + expiry/low-stock alert endpoints + WS broadcast | complete (code; cron + Pi temp sensor is the operator-attested validation) | with 4 | 1 | [completed/sensors-alerts.plan.md](../plans/completed/sensors-alerts.plan.md) · [report](../reports/sensors-alerts-report.md) |
| 6 | End-to-end bench loop | Stitch all modules in `edge_pi/main.py`; run scripted 200-cycle bench; record metrics | complete (code; Pi 200-cycle run is the operator-attested validation) | - | 3, 4 | [completed/end-to-end-bench-loop.plan.md](../plans/completed/end-to-end-bench-loop.plan.md) · [report](../reports/end-to-end-bench-loop-report.md) |
| 7 | Frontend dashboard surfaces | Add adherence-log live feed, alert panel, slot-status grid in `frontend/src/app/` | complete | with 6 | 1 | [completed/dashboard-surfaces.plan.md](../plans/completed/dashboard-surfaces.plan.md) · [report](../reports/dashboard-surfaces-report.md) |
| 8 | Offline queue + reliability | SQLite buffer for adherence logs; reconnect/replay logic; chaos test | complete (code; Pi chaos test is the operator-attested validation) | - | 6 | [completed/offline-queue-reliability.plan.md](../plans/completed/offline-queue-reliability.plan.md) · [report](../reports/offline-queue-reliability-report.md) |
| 9 | Accuracy validation | Run 1,000-pill labelled bench; record confusion matrix; document residual gap to 99% target | complete (harness; labelled dataset + Pi run is the operator-attested validation) | - | 6 | [completed/accuracy-validation.plan.md](../plans/completed/accuracy-validation.plan.md) · [report](../reports/accuracy-validation-report.md) |
| 10 | Pilot-ready packaging | `make pi-sync` polish, systemd hardening, install.sh idempotency, BOM lockdown | complete (code; fresh-Pi <30 min stopwatch is the operator-attested validation) | - | 8, 9 | [completed/pilot-ready-packaging.plan.md](../plans/completed/pilot-ready-packaging.plan.md) · [report](../reports/pilot-ready-packaging-report.md) |
| 11 | Clinician assistant (Gemini) | `/api/agent/chat` + `/api/agent/brief`; FastAPI lifespan-spawned brief scheduler at configurable hours; dashboard `BriefCard` + `/agent` chat page | complete | with 12 | 1 | [completed/agentic-clinician-assistant.plan.md](../plans/completed/agentic-clinician-assistant.plan.md) · [report](../reports/agentic-clinician-assistant-report.md) |
| 12 | Proactive flag detection + human-in-loop resolve | `agent_flags` table + heuristic + Gemini detector; `FlagsPanel` with ack/resolve/dismiss + optimistic UI; partial-unique fingerprint for dedup | complete | with 11 | 11 | [completed/agent-flag-resolve-loop.plan.md](../plans/completed/agent-flag-resolve-loop.plan.md) · [report](../reports/agent-flag-resolve-loop-report.md) |
| 13 | Dashboard floor map + UX redesign | Stylised SVG floor plan (Common Room ×6 + ICU isolation) replaces stat cards; SWR cache + auto-refresh across panels; `lib/date.ts` shared helpers | complete | with 12 | 7 | [completed/dashboard-floor-map.plan.md](../plans/completed/dashboard-floor-map.plan.md) · [report](../reports/dashboard-floor-map-report.md) |
| 14 | Admin hardware control panel | `/admin` page with reset/eject/drawer/snapshot/logs/brief-now/detect-now; in-memory log ring buffer; `app.state.hardware_lock` shared between cycle and manual ops | complete | - | 7, 11 | [completed/admin-hardware-control-panel.plan.md](../plans/completed/admin-hardware-control-panel.plan.md) · [report](../reports/admin-hardware-control-panel-report.md) |
| 15 | Manual + scheduled dispense modes | `manual_dispense_only` flag default-on (cycle idle until trigger); `medications.schedule_at TIME`; per-slot daily auto-fire via `next_scheduled_dispense()` tick; `/admin` schedule editor | complete (inline implementation; no plan artefact) | - | 14 | — |

### Phase Details

**Phase 1: Schema + telemetry hardening**
- **Goal**: Make the data model fit the real product, not the demo.
- **Scope**: Migrations on `medications` (add `dispenser_id`, `expiry_date`, `pills_per_dose`) and `adherence_logs` (add `dispenser_id`, optional `confidence_score`); update Pydantic models in `backend/app/api/inventory.py` + `backend/app/api/logs.py`; smoke-test via `mcp__supabase__apply_migration`.
- **Success signal**: Existing endpoints still pass curl smoke; new columns visible via Supabase; Pi continues to write logs without error.

**Phase 2: Dual-camera refactor**
- **Goal**: Eliminate the single-camera assumption.
- **Scope**: Refactor `edge_pi/vision/pill_verifier.py` + `edge_pi/vision/intake_monitor.py` to take an injected camera handle; preserve lazy init; preserve the Step-4 inverted-logic invariant in the swallow FSM; benchmark two CSI cams running simultaneously on a Pi 5 under load.
- **Success signal**: `make pi-models` passes; both cams produce frames in parallel; p95 frame interval < 100 ms per cam under simultaneous load.

**Phase 3: Face ID end-to-end**
- **Goal**: Replace the 501 stub with a real "right patient" check.
- **Scope**: Choose face-recognition stack (InsightFace / face_recognition); add enrolment endpoint (multipart upload from dashboard); store face embeddings in Supabase; implement `/api/auth/verify-face` doing cosine-distance match; add Pi-side liveness check (blink detection minimum); update `edge_pi/main.py::authenticate_patient` to pass the liveness frame.
- **Success signal**: ≥99% true-positive on a 50-face enrollment bench; printed-photo spoof rejected.

**Phase 4: Diverter + drawer-lock hardware**
- **Goal**: Close the fail-safe and zero-touch gaps.
- **Scope**: New `edge_pi/hardware/diverter.py` (servo flap, on-failure reject path) + `edge_pi/hardware/drawer_lock.py` (solenoid); allocate GPIO pins; extend `Magazine.is_stub` pattern to both new modules; integrate into `main.py` cycle so the drawer never unlocks unless pill-ID and Face ID both pass.
- **Success signal**: 200-cycle adversarial test — every wrong-pill or failed-Face-ID event hits the reject path; drawer never opens on fail.

**Phase 5: Sensor + alerts**
- **Goal**: Cover environmental + inventory alerts called out in the PRD.
- **Scope**: Add I²C/1-wire temperature sensor; new endpoint `/api/alerts/`; cron-tick or scheduled job for expiry + low-stock checks; WS broadcast to dashboard.
- **Success signal**: Forced expiry / low-stock / over-temperature events surface on the dashboard within 5 s.

**Phase 6: End-to-end bench loop**
- **Goal**: First defensible "it works end-to-end" demo.
- **Scope**: Script a 200-cycle automated bench run; capture all metrics from the Success Metrics table; produce a metrics report.
- **Success signal**: Schedule → drawer → swallow → log loop passes 200/200 with metrics within targets (or with documented gaps and root causes).

**Phase 7: Frontend dashboard surfaces**
- **Goal**: Make the system legible to nurses and pharmacists.
- **Scope**: Live adherence feed (consume `/api/logs/ws`), alerts panel, slot-status grid, simple Face-ID enrolment screen; respect existing `lib/api.ts` vs `lib/supabase.ts` pattern split.
- **Success signal**: Nurse can answer "did patient X take their last dose?" in <5 s on the dashboard.

**Phase 8: Offline queue + reliability**
- **Goal**: Stop losing adherence data on backend outage.
- **Scope**: Local SQLite or JSONL queue on Pi; replay loop on reconnect; refuse-to-dispense rule once outage > N minutes; chaos test: yank network during a cycle and verify no falsified telemetry.
- **Success signal**: Network-outage chaos test produces zero lost or falsified `adherence_logs`.

**Phase 9: Accuracy validation**
- **Goal**: Honest measurement of the 99% / <0.1% targets.
- **Scope**: Acquire / build labelled pill dataset (≥10 SKUs × ≥100 samples); run confusion matrix; document residual gap; if gap exists, retrain or expand training set under `ml/pill_detector/`; promote new weights into `edge_pi/models/` per `CLAUDE.md` workflow.
- **Success signal**: Documented confusion matrix; pass/fail per metric; signed-off accuracy gap report.

**Phase 10: Pilot-ready packaging**
- **Goal**: Make a fresh Pi bootable in <30 minutes.
- **Scope**: Idempotent `scripts/install.sh`; systemd unit hardening (restart limits, journald rotation); `make pi-sync` polish; final BOM spreadsheet locked; `.env.example` for both Pi and backend.
- **Success signal**: A second Pi flashed, synced, and running the full cycle in <30 minutes from a clean image.

### Parallelism Notes

- Phase 1 (schema) and Phase 2 (dual-cam refactor) touch independent layers (Postgres + Pydantic vs. Pi vision modules) — fully parallel.
- Phase 4 (hardware) and Phase 5 (sensors) share `edge_pi/hardware/` but in disjoint files; with care they can run in parallel.
- Phase 6 (bench) and Phase 7 (dashboard) are independent: bench writes data, dashboard reads it; parallel-safe.
- Phase 9 (accuracy) only blocks the *claim* of 99% — it can run in parallel with Phase 8 (offline queue) since they touch different parts of the stack.
- Phase 3 (Face ID) blocks Phase 6 (bench) because the bench loop needs a working `/verify-face`; do not start the bench before Phase 3 lands.

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Compute platform | Raspberry Pi 5 | Pi 4, Jetson Nano | Match existing repo (`rpi-lgpio` shim, picamera2); Pi 5 has 2 CSI lanes for dual-cam; Jetson breaks BOM |
| Camera architecture | Dual cam (per PRD) | Single cam time-sliced | PRD requirement; pill-ID and swallow-FSM run on different geometries (top-down vs. patient-facing) |
| Inference latency target | <200 ms CPU (V1), <15 ms aspirational | <15 ms with Hailo/Coral | Honest Pi 5 CPU number; accelerator breaks BOM ≤ RM 1,000 |
| Face ID scope | Real Face ID in V1 | Keep stub, defer to V2 | "Right patient" is core to the zero-touch hypothesis; cannot defer |
| GPIO library | `rpi-lgpio` shim under `RPi.GPIO` import | `gpiozero` rewrite | Pi 5 / Bookworm compatibility; preserves existing `hardware/` modules — see `CLAUDE.md` |
| Backend auth (device) | Static device token (HTTPBearer) | mTLS, OAuth | Already implemented (`backend/app/core/security.py`); good enough for prototype |
| Fallback pill ID | Gemini Vision via backend (not direct from Pi) | Direct Gemini call from Pi | Pi never holds the Gemini key; matches `CLAUDE.md` security boundary |
| Database | Supabase (Postgres + RLS + Storage) | Self-hosted Postgres | Already wired throughout; free tier sufficient for prototype |
| Inference framework | Ultralytics YOLO (`.pt` weights, CPU) | TFLite / ONNX | Existing `models/spotter.pt` already in repo; switch only if latency target slips |
| Mechanism | In-line slider-crank, NEMA 17 stepper | Gravity-fed dispenser | PRD requirement; jam-free positive displacement vs. bridging risk |
| Stub-mode policy | Fail-loud refuse-to-run; never log `pill_taken=true` from stub | Silent stub | Already enforced (`edge_pi/main.py:87-104`); preserve through every refactor |
| Backend hosting | Pi runs FastAPI + ngrok tunnel; dashboard speaks to Pi over HTTPS | Separate dev-box backend; cloud backend | Removes a hop, keeps cameras + cycle in one process; trade-off is ngrok URL rotation on free tier |
| Agent stack | Gemini 2.5 Flash via `google.generativeai` (function-calling) | OpenAI / local LLM | Free tier suffices for prototype; on-device LLM blows BOM; Anthropic not yet wired |
| Flag dedup | Postgres `UNIQUE INDEX agent_flags_open_fingerprint_uniq WHERE status='open'` | App-level dedup | DB-level guarantee even on concurrent insert; insert-then-catch-23505 idiom |
| Cycle default | `manual_dispense_only=True`; cycle waits for trigger or schedule tick | Auto-poll quantity>0 every 30 s | Fresh-Pi boot would otherwise drain the magazine before an operator is at the dashboard |
| Schedule shape | One `medications.schedule_at TIME` per slot (daily) | Multiple times per day; cron expressions | Simplest UX; matches `<input type="time">`; multi-time can layer later via separate table |
| Admin auth | Same `X-Device-API-Key` as the cycle endpoints | Per-user OAuth, role-based perms | Prototype-grade; documented as scaling gap |
| Hardware mutex | Single `app.state.hardware_lock = asyncio.Lock()` shared by cycle and `/api/device/*` manual ops | Pause/resume signal, separate locks per device | Fair (FIFO) serialisation; manual ops queue while a cycle is mid-flight |
| Logs surface | In-process ring buffer (`backend/core/log_ring.py`, deque maxlen=500) on `/api/device/logs` | journalctl shell-out; persistent log table | No subprocess, no SSH; survives only as long as uvicorn (acceptable) |

---

## Research Summary

**Market Context**
- Existing automated dispensing is **ward-level** (Omnicell XT, Pyxis MedStation, BD Rowa) — none is bedside zero-touch with vision-based ingestion verification. Bedside gap is structurally real.
- Consumer/home pillboxes (Hero, MedMinder, Pillo) verify *dispensing* but not *swallowing*; they assume cooperative outpatient users, not isolation-ward.
- AiCure (smartphone-based ingestion verification) is the closest analogue on the swallow-verification side, but it is software-only and depends on the patient holding the phone — opposite of zero-touch.
- Pediatric / cognitively-impaired and liquid-formulation segments are uncovered by any of the above and remain out of scope here.

**Technical Context (from this repo, with file:line refs)**
- `edge_pi/main.py` — full polling loop with device-token auth, stub-mode fail-loud guard at lines 87–104, face-auth call at lines 33–46.
- `edge_pi/hardware/magazine.py:55` (`rotate_to`) and `edge_pi/hardware/ejector.py:43` (`push`) — proven mechanism control with `RPi.GPIO`-via-`rpi-lgpio` shim. Stub-mode safety pattern is shared.
- `edge_pi/vision/pill_verifier.py` (119 lines, YOLO + lazy init) and `edge_pi/vision/intake_monitor.py` (303 lines, MediaPipe FaceMesh+Hands FSM) — both modules **share a single camera today**; dual-cam refactor is required for the PRD's dual-cam architecture.
- `backend/app/main.py` mounts three routers (`auth`, `inventory`, `logs`) under `/api/*`; same convention applies to any new router (e.g. `/api/alerts/`).
- `backend/app/api/logs.py:50-67` — WebSocket broadcast to dashboard already implemented with query-param device-token auth.
- `backend/app/api/auth.py:11` — `/verify-face` currently raises 501; primary unblocker for the Face ID phase.
- `backend/app/services/gemini_fallback.py` — Gemini Vision scaffolded with TODO at the response-parse step; finish parsing before relying on it.
- `frontend/src/lib/api.ts` (FastAPI) and `frontend/src/lib/supabase.ts` (direct) — two access paths already coexist; preserve the surrounding-code-decides convention.
- `.mcp.json` wires Supabase MCP at project `wqijdqclqhybhdtgsznf` — use `mcp__supabase__*` tools for schema work, not raw SQL.
- No CI / no test suite today (`CLAUDE.md`). Phase 6 / Phase 9 bench scripts will likely be the first executable verification in the repo.

---

*Generated: 2026-05-08*
*Last refreshed: 2026-05-10 — Phases 0–15 complete; operator-attested Pi validations remain (see individual reports)*
*Status: ACTIVE — prototype shipped; pilot validation pending (see remaining Open Questions)*
