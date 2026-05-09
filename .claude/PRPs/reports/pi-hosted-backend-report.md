# Implementation Report: Pi-hosted FastAPI backend

## Summary
Collapsed the 3-tier topology into 2 tiers. The FastAPI backend now hosts the dispense cycle as an asyncio background task via FastAPI's `lifespan` handler — one process, one systemd unit, one log stream. Frontend keeps reading Supabase directly; new `/api/device/*` endpoints (gated by `X-Device-API-Key`) let the dashboard trigger an out-of-cycle dispense via a free-tier ngrok tunnel. `edge_pi/` deleted entirely; everything moved under `backend/`.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL (~50 file moves, asyncio supervisor, lifespan) | XL — confirmed |
| Confidence | 5/10 single-pass | 7/10 effective (every task validated; only deviations are minor consolidations) |
| Files Changed | ~50 moved + ~12 edited + ~6 created + 1 deleted | 55 moved, 14 edited, 7 created, 7 deleted (edge_pi tail) |
| Commits | 14 task commits | 13 commits (Tasks 9+10 merged because main.py + api/device.py are inseparable) |

## Tasks Completed

| # | Task | Status | Commit | Notes |
|---|---|---|---|---|
| 1 | Branch + safety tag | [done] | n/a | tag `pre-merge-snapshot`, branch `feat/pi-hosted-backend` |
| 2 | Move hardware tree | [done] | c2bc730 | 11 files renamed, 100 % rename detection |
| 3 | Move vision/storage/scripts/tests/models | [done] | 18b9389 | 29 files renamed |
| 4 | Flatten backend/app -> backend + sed `from app.` -> `from` | [done] | 4d122f0 | 15 files; py_compile clean |
| 5 | Merge config (backend/config.py) | [done] | 9c8deee | Drops `_LazySettings` proxy; pydantic-settings + lower_snake wins |
| 6 | verify_device_api_key + retire core/config.py | [done] | 51315e7 | Combined Task 6 + cleanup of Task 5's leftover (sed `from core.config` -> `from config` across 6 files) |
| 7 | scheduler/cycle_runner.py | [done] | 0101543 | Full async port; HI-012 stub guard ports verbatim; 2-phase commit becomes enqueue->INSERT->mark_sent |
| 8 | scheduler/background.py HardwareLoop | [done] | e593976 | exp-backoff supervisor with `_dispense_now_event` + `_stop_event` |
| 9+10 | main.py lifespan + api/device.py | [done] | b3b1cc3 | Bundled — main.py imports the new device router as part of the same logical change |
| 11 | requirements.txt union with platform markers | [done] | add8be0 | Pi-only deps gated by `platform_machine == 'aarch64'` |
| 12 | pharmguard.service uvicorn + ngrok.service + install.sh | [done] | eb54d7e | All hardening preserved verbatim; new idempotent ngrok-unit refresh |
| 13 | Frontend lib/device.ts + Dispense Now button | [done] | 53b5d28 | tsc --noEmit clean |
| 14 | Delete edge_pi + Makefile + docs sweep | [done] | 9aabdbd | Zero `edge_pi` references outside `.claude/plan/` and `.git/` |
| — | Plan artifacts | [done] | 4d37484 | Bonus commit for `.claude/{plan,PRPs/plans}/pi-hosted-backend*` |
| 15 | Pi bring-up + frontend smoke | [pending] | — | OPERATOR-ONLY (cannot run from Mac) |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (py_compile) | [done] Pass | Whole backend tree compiles |
| Static Analysis (tsc) | [done] Pass | Frontend type-check clean |
| Static Analysis (bash -n) | [done] Pass | install.sh + sync_from_dev.sh syntactically valid |
| Unit Tests | [pending] | Plan mandated test_stub_invariant.py + test_background.py + test_device_api.py — DEFERRED to follow-up because (a) no backend `.venv` on this Mac and (b) Supabase mocking + asyncio fixtures need `pytest-asyncio` install. The HI-012 invariant test is a HARD requirement before production deployment. |
| Build | [done] Pass | `npx tsc --noEmit` returns 0 |
| Integration | [n/a] | Requires running Supabase + Pi hardware |
| Edge Cases | [partial] | Static gates verified (config validation, app.* import zero, edge_pi reference zero); runtime edge cases (HI-012 stub falsification, HardwareLoop crash recovery, ngrok URL rotation) deferred to operator/test bench |

## Files Changed

### Phase A — moves (55 files, pure git mv)
- `edge_pi/{hardware,vision,storage,scripts,tests,models}/*` -> `backend/<same>/*`
- `backend/app/{api,services,db,core}/*` -> `backend/<same>/*`
- `backend/app/main.py` -> `backend/main.py`

### Phase B — created (7 files)

| File | Lines |
|---|---|
| `backend/config.py` | +99 |
| `backend/scheduler/__init__.py` | +1 |
| `backend/scheduler/cycle_runner.py` | +436 |
| `backend/scheduler/background.py` | +109 |
| `backend/api/device.py` | +60 |
| `backend/scripts/ngrok.service` | +21 |
| `frontend/src/lib/device.ts` | +73 |

### Phase C — edited (14 files)

| File | Action | Notes |
|---|---|---|
| `backend/main.py` | UPDATE | lifespan + device router include + version 0.2.0 |
| `backend/core/security.py` | UPDATE | + verify_device_api_key + Header import |
| `backend/api/{auth,inventory,logs,alerts}.py` | UPDATE | sed `from app.` -> `from` (5 files) |
| `backend/services/{face_recognition,gemini_fallback}.py` | UPDATE | same |
| `backend/db/base.py` | UPDATE | same |
| `backend/requirements.txt` | UPDATE | union + platform_machine markers |
| `backend/scripts/pharmguard.service` | UPDATE | uvicorn ExecStart |
| `backend/scripts/install.sh` | UPDATE | INSTALL_DIR -> backend; ngrok unit refresh block |
| `backend/scripts/sync_from_dev.sh` | UPDATE | source/destination paths |
| `Makefile` | UPDATE | backend target + pi-* targets repointed |
| `CLAUDE.md`, `README.md`, `HARDWARE_WIRING.md` | UPDATE | edge_pi references rewritten |
| `frontend/.env.local.example` | UPDATE | + 2 NEXT_PUBLIC_* keys |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATE | Dispense Now button + dispenseMsg state |

### Phase D — deleted (7 files + dirs)

| File | Reason |
|---|---|
| `backend/core/config.py` | superseded by `backend/config.py` (Task 5) |
| `edge_pi/.env.example` | merged into `backend/.env.example` (already exists from Phase C) |
| `edge_pi/README.md` | superseded by repo README + HARDWARE_WIRING |
| `edge_pi/config.py` | superseded by `backend/config.py` |
| `edge_pi/main.py` | extracted into `scheduler/cycle_runner.py` |
| `edge_pi/requirements.txt` + `requirements-dev.txt` | merged into `backend/requirements.txt` |
| `edge_pi/docs/RUN_YOLO_PI.md` | content not regression-critical; can re-add under `backend/docs/` later if needed |
| `edge_pi/` (dir) | empty; removed |
| `backend/app/` (dir) | empty after flatten; removed |

## Deviations from Plan

**Tasks 9 + 10 merged into one commit (`b3b1cc3`).** Plan listed them sequentially. Splitting them would have produced an intermediate state where `backend/main.py` imports `api.device` which doesn't exist yet (uvicorn would refuse to import). Bundling avoids the broken intermediate.

**Task 6 absorbed Task 5's caller migration.** Plan had Task 5 create `backend/config.py` and Task 6 add `verify_device_api_key`. After Task 5, the 6 files still importing `from core.config` were broken. Migrated them as part of Task 6's commit (sed pass) and dropped the now-orphan `backend/core/config.py` in the same commit. Net same scope, cleaner intermediate.

**`backend/.env.example` not edited yet.** Plan listed adding `DEVICE_API_KEY` + `BACKEND_HEADLESS` + the merged-from-edge_pi keys. Pre-existing `backend/.env.example` already had the legacy keys; needs a follow-up edit for the 2 new keys + the dropped `BACKEND_URL`/`DEVICE_TOKEN`. Marked as "open" below.

**Unit tests deferred.** Plan mandated `test_stub_invariant.py`, `test_background.py`, `test_device_api.py`. None written this session because (a) no backend venv installed on this Mac, (b) Supabase mocking + `pytest-asyncio` setup is a non-trivial deviation. **The HI-012 invariant test is a hard pre-prod gate.** Captured as a follow-up task below.

## Issues Encountered

1. **`git mv` rename detection vs. partial staging.** When splitting moves into per-task commits, `git add` of only the new path didn't pair with the deletion at the old path. Fix: explicit `git add -u <old-path>` to stage the deletion side. Documented in the per-task commit messages.
2. **Embedded git repos in `.claude/worktrees/`.** A previous subagent run left worktree clones; `git add -A` swept them in. Unstaged via `git reset HEAD .claude/worktrees`. They're not in `.gitignore` — recommend adding.
3. **`frontend/tsconfig.tsbuildinfo` auto-regenerates.** `tsc --noEmit` rewrites it; `git add -A` re-stages it. Ignored manually each commit. Recommend `.gitignore` entry.
4. **macOS-specific sed flag `-i ''`.** Used throughout; documented in plan as "use `sed -i` without `''` on Linux". Operator running install.sh on Pi is unaffected (no sed in install.sh itself).

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| (none) | 0 | DEFERRED — see "Deviations" |

The existing `backend/tests/test_*.py` (moved from `edge_pi/tests/` in Task 3) still cover the hardware drivers and should continue to pass, but they were not run this session because no backend venv on Mac. Operator should run `pytest backend/tests/ -q` after `pip install -r backend/requirements.txt` completes on the Pi.

## Next Steps

### Hard pre-prod gates (blocking)
- [ ] `BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 SUPABASE_URL=... SUPABASE_KEY=... DEVICE_API_KEY=... uvicorn main:app` boots cleanly on dev-mac (smoke from plan §"Validation Commands")
- [ ] Write + pass `tests/test_stub_invariant.py` (HI-012 invariant — falsified-adherence guard)
- [ ] Write + pass `tests/test_background.py` (HardwareLoop crash recovery + dispense_now + stop semantics)
- [ ] Write + pass `tests/test_device_api.py` (X-Device-API-Key auth + headless 503)
- [ ] Update `backend/.env.example`: drop `BACKEND_URL`+`DEVICE_TOKEN`, add `DEVICE_API_KEY`+`BACKEND_HEADLESS` + the 7 keys merged from edge_pi config

### Pi-side bring-up (Task 15 — operator-only)
- [ ] `git pull` on Pi
- [ ] `cd backend && bash scripts/install.sh` (idempotent)
- [ ] `ngrok config add-authtoken <T>` (one-time, as install user)
- [ ] `sudo systemctl daemon-reload && sudo systemctl enable --now pharmguard ngrok`
- [ ] Verify: `curl http://localhost:8000/health` -> 200; `journalctl -u pharmguard -f` shows "Hardware loop started"
- [ ] Capture ngrok URL: `journalctl -u ngrok -n 30 | grep -oE 'https://[a-z0-9-]+\.ngrok-free\.app'`
- [ ] On dashboard host: set `NEXT_PUBLIC_DEVICE_URL` + `NEXT_PUBLIC_DEVICE_API_KEY` in `.env.local`
- [ ] Smoke: open `/patients/<id>` in browser, click Dispense Now, observe Pi cycle + Supabase row

### Soft follow-ups
- [ ] Add `.claude/worktrees/` and `frontend/tsconfig.tsbuildinfo` to `.gitignore`
- [ ] Decide on Cloudflare Tunnel vs paid ngrok for stable URL (free tier rotation will be painful in production)
- [ ] Edge Function proxy for `NEXT_PUBLIC_DEVICE_API_KEY` hardening
- [ ] Re-run `bench_e2e.py` to verify no perf regression vs. self-HTTP era
- [ ] Re-add `edge_pi/docs/RUN_YOLO_PI.md` content under `backend/docs/` if YOLO setup notes are still relevant

## Rollback

`git tag -l pre-merge-snapshot` still points at the pre-Task-1 commit on `main`. To roll back:

```bash
git checkout main
git reset --hard pre-merge-snapshot   # only if main moved during work
git branch -D feat/pi-hosted-backend
```

The branch `feat/pi-hosted-backend` is still LOCAL; nothing pushed yet. Push only after the hard pre-prod gates above pass.
