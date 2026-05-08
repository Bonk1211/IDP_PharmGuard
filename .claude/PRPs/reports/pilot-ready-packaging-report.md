# Implementation Report: Pilot-Ready Packaging (PRD Phase 10)

## Summary
Final code phase of the PharmGuard PRD — packaging + ops polish, no Pi-runtime changes. Hardened `pharmguard.service` (restart limits + journald rate limits + security flags + resource ceilings); shipped a system-wide journald drop-in capping the journal at 100 MB; rewrote `install.sh` to be fully idempotent (hash-checked unit refresh, never-overwrite `.env` seed, `chmod +x` for new bench scripts, `~/.pharmguard/` queue dir); polished `sync_from_dev.sh` excludes (`.env` + `*.csv`); added `make pi-bootstrap HOST=...` umbrella for one-shot fresh-Pi setup; created `BOM.md` skeleton at repo root; audited every `.env.example` (Pi + backend + frontend) against code-consumed env keys and reconciled the 3 Phase-5 backend gaps. Pi-hardware <30 min bootstrap is the only outstanding step (operator-attested).

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | 9/10 (all static + audit checks first-try green) |
| Files Changed | 9 | 9 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Harden `pharmguard.service` | Complete | Restart limits, log rate limits, 7 security flags, 4 resource ceilings; `__INSTALL_DIR__` sentinel preserved |
| 2 | Create `journald.conf.d-pharmguard.conf` drop-in | Complete | `SystemMaxUse=100M`, `SystemKeepFree=100M`, `RuntimeMaxUse=50M` |
| 3 | Harden `install.sh` | Complete | Hash-checked unit refresh, `.env` never-overwrite seed, `chmod +x` 5 new scripts, `~/.pharmguard/` mkdir, journald drop-in cmp-based refresh, fixed stale `DEVICE_ID` → `DEVICE_TOKEN` |
| 4 | Polish `sync_from_dev.sh` | Complete | `--delete-after`, exclude `.env` + `*.csv`, hint at `make pi-bootstrap` |
| 5 | Add `make pi-bootstrap HOST=...` | Complete | rsync → ssh+install.sh → ssh+enable. Errors on missing `HOST`. Uses `enable` not `enable --now` (operator must edit `.env` first). |
| 6 | Create `BOM.md` | Complete | 19 procurement rows across Phases 2/4/5 + core; cost columns shipped as `TBD` per plan |
| 7 | `.env.example` audit + reconcile | Complete | Pi (10/10) + frontend (3/3) clean; backend missing 3 Phase-5 keys (`EXPIRY_WARN_DAYS`, `LOW_STOCK_THRESHOLD`, `OVER_TEMP_CELSIUS`) — added |
| 8 | README updates | Complete | Top-level + `edge_pi/README.md` both reference `make pi-bootstrap` + `BOM.md`; stale `DEVICE_ID` and "BACKEND_URL hardcoded" notes fixed; new "Pilot operator scripts" section listing Phase 2/6/8/9 bench harnesses |
| 9 | Validation suite | Complete | All 6 sub-checks green |
| 10 | Operator-attested Pi bootstrap | **Blocked — operator step** | Real Pi 5 + stopwatch <30 min |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Bash syntax (`bash -n`) | Pass | `install.sh` + `sync_from_dev.sh` |
| Makefile dry-run (`make -n pi-bootstrap`) | Pass | All commands print as expected |
| systemd unit hardening (textual) | Pass | 10 invariants present (`__INSTALL_DIR__`, `User=root`, `EnvironmentFile=-`, `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths`, `PrivateTmp`, `StartLimit*`, `MemoryHigh/Max`, `CPUQuota`) |
| Pi env audit | Pass | 10/10 keys documented |
| Backend env audit | Pass | 10/10 fields documented (3 Phase-5 keys reconciled) |
| Frontend env audit | Pass | 3/3 keys documented |
| Pi `py_compile` | Pass | `config.py` + `main.py` clean |
| Pi runtime smoke | N/A | No `.py` changes in this phase |
| Frontend build | N/A | No frontend changes |
| Operator fresh-Pi bootstrap | **Deferred** | Operator-attested |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `edge_pi/scripts/pharmguard.service` | UPDATED | full rewrite, 50 lines (+30 / -1 net) |
| `edge_pi/scripts/journald.conf.d-pharmguard.conf` | CREATED | +12 |
| `edge_pi/scripts/install.sh` | UPDATED | full rewrite, 196 lines (+67 / -0 net) |
| `edge_pi/scripts/sync_from_dev.sh` | UPDATED | +9 / -3 |
| `Makefile` | UPDATED | +18 / -1 |
| `BOM.md` | CREATED | +33 |
| `backend/.env.example` | UPDATED | +8 / -0 (3 Phase-5 keys + comments) |
| `README.md` | UPDATED | +14 / -3 |
| `edge_pi/README.md` | UPDATED | +60 / -28 (rewrite First-time Setup + Configuration; new Pilot scripts section) |

## Deviations from Plan

- **Plan listed `__USER__` as a systemd-unit invariant to preserve** — verified the original 19-line service never used `__USER__`; only `__INSTALL_DIR__` was substituted. The new hardened unit is the same. Dropped `__USER__` from the regression check; left the install.sh substitution intact (defensive — harmless when the placeholder is absent; useful if a future unit reintroduces it).
- **`edge_pi/README.md` already existed** (180 lines) — plan said "create if missing"; updated in place instead. Preserved existing Hardware / GPIO / Run / Troubleshooting sections; rewrote First-time Setup + Configuration; added Pilot operator scripts section.
- **OpenAPI / build smokes skipped** — Phase 10 ships no Python or TypeScript surface, so backend boot probe + `next build` were unnecessary.
- **Stayed on `main`** per established session pattern.

## Issues Encountered

1. **Initial systemd-unit regression check failed on `__USER__`** — neither the old nor new unit references it; install.sh has a no-op substitution. Dropped from the invariant list. Code unchanged.
2. **GateGuard fact-forcing hook fired on every Edit/Write** as in prior phases. User-tolerated; no code impact.
3. **Pi env audit regex initially missed `OFFLINE_QUEUE_PATH`** — Phase 8's multi-line `os.environ.get(\n  "OFFLINE_QUEUE_PATH",\n  ...)`. Verified by direct grep that the key is consumed; audit regex tightened to `re.MULTILINE`.
4. **No actual implementation blockers** — every task landed first-try after the GateGuard pass.

## Tests Written

None — repo has no test framework. Validation = bash syntax + Makefile dry-run + textual hardening regression + env-audit regex + Pi `py_compile`.

## Open Handoff Items

To finish Phase 10 the operator must:

1. **Flash a clean Raspberry Pi OS Bookworm 64-bit** image to a Pi 5 with cam 0 + cam 1 attached.
2. **Set up ssh-key auth** from dev machine to Pi.
3. **Stopwatch the bootstrap**:
   ```bash
   time make pi-bootstrap HOST=pi@<host>
   ```
   PRD success signal: < 30 min from `make pi-bootstrap` start to `pharmguard.service` ready-to-run.
4. **Edit `.env` on the Pi** (the seed copy is a placeholder):
   ```bash
   ssh pi@<host> "nano ~/IDP_PharmGuard/edge_pi/.env"
   ```
   Fill `BACKEND_URL`, `DEVICE_TOKEN`, `DISPENSER_ID`. Add the same `DEVICE_TOKEN` to the backend's `DEVICE_TOKENS` env on its host.
5. **Start the service**:
   ```bash
   ssh pi@<host> "sudo systemctl restart pharmguard"
   ssh pi@<host> "journalctl -u pharmguard -f"
   ```
6. **Idempotency test**: re-run `make pi-bootstrap` on the configured Pi. Expect log lines: `Existing .env preserved (not overwritten)`, `Queue directory already exists`, `systemd unit unchanged — skipping daemon-reload`, `journald drop-in unchanged`.
7. **Restart-storm test**: blank out `DEVICE_TOKEN`, restart service, watch journald — service should hit `failed (start-limit-hit)` after 5 restarts in 60 s.
8. **Long-soak journal cap**: leave the service running for a day; confirm `journalctl --disk-usage` plateaus at ~100 MB.
9. **Commit + push** the Phase 10 change set when satisfied.
10. **Flip PRD Phase 10 to `complete`** after the operator stopwatch passes.

## Next Steps
- [ ] User: run `make pi-bootstrap` on a fresh Pi 5; stopwatch < 30 min.
- [ ] User: idempotency + restart-storm + journal-cap soak tests.
- [ ] User: commit + push when ready.
- [ ] After Phase 10 attests: **all 10 PRD phases merged.** Remaining work is operator-attested Pi/dataset handoffs across Phases 2, 3, 4, 5, 6, 7, 8, 9, 10 — no more code phases left.
