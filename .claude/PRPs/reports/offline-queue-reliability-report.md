# Implementation Report: Offline Queue + Reliability (PRD Phase 8)

## Summary
Stop losing adherence data on backend outage. Built a SQLite-backed FIFO queue at `edge_pi/storage/queue.py` (stdlib `sqlite3` only, WAL + autocommit) and wrapped both `report_intake` and `report_temperature` in `edge_pi/main.py` so every event is durably written to local disk *before* the HTTP POST. A new `_replay_drain()` helper is called at the top of every cycle; on success the row is marked posted, on failure the row stays. A refuse-to-dispense gate (`oldest_age_seconds() > OFFLINE_MAX_AGE_SECONDS`, default 1 h) prevents the Pi from running blind through a long outage; `BENCH_MODE=1` bypasses the gate so Phase 6 numbers stay reproducible. New `edge_pi/scripts/chaos_offline.py` simulates 50 cycles with timed outages, asserts the queue accumulated monotonically during the outage and drained to 0 after recovery, and verifies the HI-012 invariant (no `pill_taken=true` from stub mode is ever marked posted). Pi operator chaos run on real hardware (Task 8) is the only remaining step.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 7/10 | 9/10 (chaos PASS, queue round-trip green, all sentinels intact, zero backend diff) |
| Files Changed | 6 (+ plan + report) | 6 (+ plan + report) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `edge_pi/storage/__init__.py` | Complete | Empty package init, docstring only |
| 2 | `edge_pi/storage/queue.py` (`OfflineQueue` class) | Complete | WAL + autocommit + `is_stub` column for HI-012 carry-over |
| 3 | `edge_pi/config.py` adds `OFFLINE_*` settings | Complete | 3 fields with safe defaults; `validate()` unchanged |
| 4 | `edge_pi/.env.example` documentation | Complete | Phase 8 sentinel + safety comments |
| 5 | `edge_pi/main.py` instrumentation | Complete | Module-level `offline_queue`, wrapped reporters, `_replay_drain`, cycle-top drain + refuse gate, `is_stub=hardware_stubbed` at both call sites |
| 6 | `edge_pi/scripts/chaos_offline.py` | Complete | `--cycles`, `--outage-start`, `--outage-end`, `--queue-path`; chmod +x |
| 7 | Local validation suite | Complete | py_compile clean, queue round-trip, settings round-trip, textual regression on `main.py` + FSM constants intact, chaos PASS |
| 8 | Pi operator attestation | **Blocked — operator step** | Real Pi 5 chaos + journalctl tail required |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Pi Python (`py_compile`) | Pass | `config.py`, `main.py`, `storage/__init__.py`, `storage/queue.py`, `scripts/chaos_offline.py` |
| Settings round-trip | Pass | `OFFLINE_QUEUE_PATH`, `OFFLINE_MAX_AGE_SECONDS=3600.0`, `OFFLINE_REPLAY_INTERVAL_S=30.0` flow through `_LazySettings.validate()` |
| Queue round-trip | Pass | enqueue 3 (mixed kinds + stub flag), peek = ordered, mark_sent 2, pending == 1, oldest_age in [0, 5) seconds, ValueError on bad kind |
| Chaos test (50 cycles, outage [10, 30)) | Pass | `Result: PASS`, peak pending=40 (2 events × 20 cycles), post-outage pending=0 |
| Chaos edge: no outage | Pass | pending=0 throughout, Result: PASS |
| Chaos edge: full outage | Pass-as-expected-FAIL | 20 rows stuck (correct — no recovery happened); HI-012 still PASS |
| `main.py` textual regression | Pass | 4 Phase 8 sentinel pairs present; Phase 4 + 5 + 6 sentinels byte-identical; `is_stub=hardware_stubbed` at exactly 2 call sites; `OfflineQueue` + `_replay_drain` + `OFFLINE_MAX_AGE_SECONDS` + `BENCH_MODE` bypass all present |
| FSM constants regression | Pass | `STEP_1_HAND` ... `STEP_5_TONGUE` intact in `vision/intake_monitor.py`; file unmodified per `git status` |
| Stub-mode `import main` smoke | **Deferred** | Dev mac lacks `cv2`/`mediapipe`/`ultralytics`; same constraint Phases 2/3/6 hit. Substituted by textual regression. |
| Pi hardware live chaos | **Deferred** | Operator-attested only |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `edge_pi/storage/__init__.py` | CREATED | +7 (docstring only) |
| `edge_pi/storage/queue.py` | CREATED | +175 (class + schema + 6 public methods) |
| `edge_pi/config.py` | UPDATED | +18 (3 fields + 3 env reads + Path import) |
| `edge_pi/.env.example` | UPDATED | +11 (Phase 8 sentinel + 3 keys + safety comments) |
| `edge_pi/main.py` | UPDATED | +180 / -14 (wrapped reporters + module-level `offline_queue` + `_replay_drain` helper + cycle-top drain + refuse-to-dispense gate + `is_stub=hardware_stubbed` at 2 call sites) |
| `edge_pi/scripts/chaos_offline.py` | CREATED | +231 |
| `.claude/PRPs/plans/offline-queue-reliability.plan.md` | CREATED | plan-of-record |
| `.claude/PRPs/reports/offline-queue-reliability-report.md` | CREATED | this file |

**Module-location decision**: `edge_pi/storage/queue.py` chosen over `edge_pi/queue_/queue.py`:
- `storage` reads as the thing the queue *is* (a durable disk-backed log) rather than the data structure (`queue_` collides visually with stdlib `queue`).
- Future Phase 9/10 work (e.g. local credential store, model-weight checksums) naturally lands under `edge_pi/storage/`.
- Consistent with existing `edge_pi/hardware/`, `edge_pi/vision/` package naming — singular noun, no trailing underscore.

**Replay-loop design decision**: in-cycle drain at top of `while True`, NOT a thread.
- Single sqlite3 connection (no `check_same_thread=False`, no per-connection lock).
- Drains at `POLL_INTERVAL_S` cadence, which already matches the natural rhythm of the cycle.
- Simpler — no thread lifecycle, no shutdown coordination.
- The drain `break`s on first non-2xx / RequestException to avoid hammering a degraded backend; the next cycle picks up where this one left off.

## Deviations from Plan

- **Initial main.py edit duplicated the module-level Phase 8 sentinel block** — first edit failed the GateGuard hook but landed anyway, then the retry landed the same block again. Detected by `wc -l` and a `count('offline_queue: OfflineQueue | None = None') == 1` regression check; fixed in a follow-up Edit. Final state has exactly one module-level Phase 8 sentinel block (4 sentinel pairs total: module-level, `run()` init, cycle-top drain+gate, helper definition).
- **Chaos script's final-drain loop runs up to 10 passes** rather than 2 — defensive against future increases to `_REPLAY_BATCH_LIMIT` or longer outage windows.
- **Stayed on `worktree-agent-a7aa48c8f45c98567`** branch per the worktree convention; ready to commit but not pushed.

## Issues Encountered

1. **Path import landed on second pass only** — first compound Edit-block applied the dataclass + `_load()` updates but skipped the import line. Fixed by a separate Edit. `python3 -c "from config import settings"` then surfaced `NameError: name 'Path' is not defined`, which made the missed edit obvious.
2. **GateGuard fact-forcing hook** continued to fire on every Edit/Write as in prior phases. User-tolerated; facts re-presented per call.
3. **No actual implementation blockers** — every task landed first-or-second-try.

## Tests Written

None as pytest cases — repo has no test framework. The new `chaos_offline.py` is the closest thing to an integration test:
- Functional self-test: 50 cycles, asserts queue accumulation + drain + HI-012.
- Runs on dev mac (no cv2/mediapipe needed; inlines the 2-phase commit driver).
- Operator can run on Pi 5 with `OFFLINE_QUEUE_PATH=/tmp/chaos_queue.db` to keep prod queue clean.

## Open Handoff Items

To finish Phase 8 the user must:

1. **On the Pi** — sync the worktree:
   ```bash
   make pi-sync HOST=pi@<host>
   ssh pi@<host>
   ```

2. **Confirm settings flow** on the Pi:
   ```bash
   cd ~/IDP_PharmGuard/edge_pi
   python3 -c "from config import settings; print(settings.OFFLINE_QUEUE_PATH, settings.OFFLINE_MAX_AGE_SECONDS, settings.OFFLINE_REPLAY_INTERVAL_S)"
   ```

3. **Run the chaos test in /tmp** (avoid touching prod queue):
   ```bash
   PHARMGUARD_STUB=1 \
     BACKEND_URL=http://localhost:1 \
     DEVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))') \
     OFFLINE_QUEUE_PATH=/tmp/chaos_queue.db \
     python3 scripts/chaos_offline.py --cycles 50 --outage-start 10 --outage-end 30
   ```
   Expected: `Result: PASS`, post-outage pending = 0.

4. **Live-fire test with the systemd service**:
   ```bash
   sudo systemctl restart pharmguard
   journalctl -u pharmguard -f
   # In another window: yank network for ~2 min
   #   tail should show "row N retained for replay" log lines
   # Restore network:
   #   tail should show "replay drained N/M rows"
   # Confirm via Supabase that no row with pill_taken=true was inserted
   # from the stub-mode tail (HI-012)
   ```

5. **(Optional) shorten the gate for quick refuse-to-dispense test**:
   ```bash
   # Temporarily set in .env:
   OFFLINE_MAX_AGE_SECONDS=120
   # Restart, yank network 3+ minutes, watch for:
   #   "Refusing dispense — oldest unposted event 180s old (> 120s); ..."
   # Restore .env to 3600 after.
   ```

6. **Flip PRD Phase 8 status** to `complete` after operator attestation. Orchestrator handles.

## Known Limitations

- **Duplicate-on-crash**: per the constraint (option B 2-phase commit), a Pi crash between POST-200 and `mark_sent` produces a duplicate row on backend on replay. Documented in the queue module docstring + plan. Future fix is per-event UUID + backend dedup column.
- **Backend `create_log` returns 200 but writes nothing**: out of scope; backend hardening is its own work.
- **WAL/SHM sidecars after power-cut**: SQLite self-recovers; if corrupted, operator deletes `~/.pharmguard/queue.db*` losing only unposted rows.

## Next Steps
- [ ] User: run chaos on Pi 5, attest PASS.
- [ ] User: live-fire test with real network yank.
- [ ] User: commit + push when ready (commit already prepared on worktree branch).
- [ ] After Phase 8 passes: only Phases 9 (accuracy validation) and 10 (pilot-ready packaging) remain.
