# Implementation Report: End-to-End Bench Loop (PRD Phase 6)

## Summary
Built a 200-cycle happy-path bench harness that drives `edge_pi/main.py` through the full schedule → magazine → eject → pill-ID → diverter → drawer-unlock → log loop on real Pi 5 hardware. `BENCH_MODE=1` env on the Pi turns on per-phase `time.perf_counter()` instrumentation, writes one row per cycle to `BENCH_LOG_PATH` CSV, and short-circuits Face ID + swallow watch (mechanism + YOLO + DB latency stay real). Backend `next_dispense` accepts an optional `?dispenser_id=` query param so the Pi only picks up rows from its bench partition. New `scripts/bench_e2e.py` orchestrator seeds 200 rows, waits for drain, reads the CSV, prints a Pass/Fail markdown report against PRD targets, and cleans up. **Pi hardware operator run (Task 8) is operator-attested and remains the only outstanding step.**

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 7/10 | 8/10 (clean compile + boot probe + tolerant OpenAPI probe all green) |
| Files Changed | 6 | 6 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `next_dispense` optional `dispenser_id` filter | Complete | Backwards-compat preserved; OpenAPI publishes `dispenser_id (in=query, required=False)` |
| 2 | Pi config BENCH_MODE + BENCH_LOG_PATH | Complete | Default off; round-trips via `_LazySettings` |
| 3 | `.env.example` documentation | Complete | Added safety comment about HI-012 / production-cleanup |
| 4 | Pi `main.py` instrumentation | Complete | `_BENCH_FIELDS`, `_open_bench_writer`, per-phase `perf_counter`, bench short-circuits for Face ID + swallow, `params={"dispenser_id": ...}` on schedule poll, `sys.exit(4)` if bench-on-stub |
| 5 | `scripts/_bench_helpers.py` | Complete | `summarise` (n/mean/p50/p95/max), `read_csv`, `render_report` markdown |
| 6 | `scripts/bench_e2e.py` | Complete | `--cycles`, `--cleanup-only`, `--bench-log`, `--wait-seconds`; chmod +x |
| 7 | Validation suite | Complete | py_compile clean (5 files), backend boot + OpenAPI probe green, textual regression on main.py wiring + FSM constants intact |
| 8 | Pi operator bench run | **Blocked — operator step** | Real Pi 5 with cam 0 + cam 1 required |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Backend Python (`py_compile`) | Pass | `app/api/inventory.py` |
| Pi Python (`py_compile`) | Pass | `config.py`, `main.py`, `scripts/bench_e2e.py`, `scripts/_bench_helpers.py` |
| `_bench_helpers.py` functional | Pass | `summarise([10,50,100,150,200])` → p95=200; `render_report` writes correct markdown |
| `bench_e2e.py --help` | Pass | All 6 args printed |
| Pi config round-trip | Pass | `BENCH_MODE=1` + `BENCH_LOG_PATH=/tmp/bench.csv` survive `validate()` |
| Backend boot + OpenAPI | Pass | uvicorn starts; `/api/inventory/next-dispense` exposes optional `dispenser_id` query param |
| `main.py` wiring (textual) | Pass | All Phase 6 sentinels present (`_BENCH_FIELDS`, `_open_bench_writer`, `BENCH_MODE=1 but hardware is stubbed`, `sys.exit(4)`, `time.perf_counter`); HI-012 + Phase 4/5 sentinels + Phase 3 right-patient gate all preserved |
| FSM constants regression | Pass | `REQUIRED_CONFIDENCE=0.85`, `POSE_HOLD_TIME=1.5`, `INSPECTION_HOLD_TIME=3.0`, `SMOOTHING_ALPHA=0.3`, all 5 step names byte-identical |
| Stub-mode `import main` | **Deferred** | Dev mac lacks `cv2`/`mediapipe`/`ultralytics`; same constraint Phases 2/3 hit. Substituted textual smoke. |
| Pi hardware live bench | **Deferred** | Operator-attested only |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `backend/app/api/inventory.py` | UPDATED | +12 / -6 (optional `dispenser_id` query param + filter) |
| `edge_pi/config.py` | UPDATED | +5 (2 fields + 2 env reads) |
| `edge_pi/.env.example` | UPDATED | +6 (BENCH_MODE + BENCH_LOG_PATH with safety comment) |
| `edge_pi/main.py` | UPDATED | +95 / -12 (CSV writer helper + bench-on-stub guard + per-phase perf_counter + Face ID + swallow short-circuits + dispenser_id query param + per-cycle CSV row) |
| `edge_pi/scripts/_bench_helpers.py` | CREATED | +56 |
| `edge_pi/scripts/bench_e2e.py` | CREATED | +130 |

## Deviations from Plan

- **OpenAPI smoke** added beyond plan as a final boot-time sanity check — confirms `dispenser_id` is published as an optional query param. Cheap; useful as a regression guard if the route signature is ever refactored.
- **Stub-mode `import main` smoke skipped on dev mac** (cv2 missing) — substituted by an AST/textual regression check that verifies all Phase 6 sentinels are present AND HI-012 + Phase 3/4/5 invariants survived. Same approach as Phase 2/3.
- **Stayed on `main`** per established session pattern; ready to commit on user request.

## Issues Encountered

1. **OpenAPI introspection script broke on `str | None`** schema — first pass assumed all parameters had a single `type` field. Pydantic emits `anyOf` for optional fields. Fixed the probe to read `name`, `in`, and `required` only.
2. **GateGuard fact-forcing hook** continued to fire on every Edit/Write as in prior phases. User-tolerated.
3. **No actual implementation blockers** — every task landed first-or-second-try after the GateGuard pass.

## Tests Written

None — repo has no test framework. The new bench harness is itself the closest thing to an integration test; it only runs on real Pi hardware.

## Open Handoff Items

To finish Phase 6 the user must:

1. **On the Pi** — set bench env in `~/IDP_PharmGuard/edge_pi/.env`:
   ```
   BENCH_MODE=1
   BENCH_LOG_PATH=/tmp/bench_e2e.csv
   DISPENSER_ID=bench-001
   ```
   Then `sudo systemctl restart pharmguard` and `journalctl -u pharmguard -f` in a tail window.

2. **From the Pi or operator workstation** — make sure `patient_id=1` has no production rows in slots 0-9 (the bench seed will overwrite via the existing `update_slot` upsert by-slot-only). Then:
   ```bash
   cd ~/IDP_PharmGuard/edge_pi
   BACKEND_URL=https://<host> DEVICE_TOKEN=<token> \
       python3 scripts/bench_e2e.py --cycles 200
   ```

3. **Expected output** — markdown table similar to:
   ```
   | metric        | n   | mean | p50 | p95 | max | target | pass |
   |---|---|---|---|---|---|---|---|
   | t_pillid_ms   | 200 |  80  |  78 | 150 | 220 | <200   | PASS |
   | t_log_ms      | 200 |  90  |  85 | 320 | 600 | <500   | PASS |
   | t_total_ms    | 200 | 1500 |1400 |3200 |4800 | <8000  | PASS |
   Overall: PASS
   ```

4. **Cleanup** — restart pharmguard with `BENCH_MODE=0` to return to production. If the bench script crashed mid-run: `python3 scripts/bench_e2e.py --cleanup-only`.

5. **Commit when ready**. Suggested message:
   ```
   feat(phase6): end-to-end bench loop (200-cycle happy-path metrics)

   - BENCH_MODE on the Pi turns on per-phase perf_counter instrumentation
     and writes one row per cycle to BENCH_LOG_PATH CSV. Face ID + swallow
     are mocked so the bench finishes in minutes; mechanism + YOLO + DB
     latency stay real. Bench refuses to run on stubbed hardware.
   - Backend next_dispense gains an optional ?dispenser_id= filter so the
     Pi can isolate to its bench partition. Backwards-compat preserved.
   - scripts/bench_e2e.py orchestrates seed → drain → CSV → Pass/Fail
     markdown report against PRD targets (<200 ms YOLO, <500 ms DB write,
     <8 s e2e). --cleanup-only flag for crash recovery.
   ```

6. **Flip PRD Phase 6 status** to `complete` after operator attestation.

## Next Steps
- [ ] User: run bench on Pi 5, attest Pass.
- [ ] User: commit + push when ready.
- [ ] After Phase 6 passes: only Phases 8 (offline queue), 9 (accuracy validation), and 10 (pilot-ready packaging) remain.
