# Implementation Report: Admin Hardware Control Panel

## Summary
Added a `/admin` page that gives an operator full hardware + ops control over the Pi-hosted backend without SSH. Five new backend endpoints (`/api/device/eject`, `/api/device/drawer`, `/api/device/snapshot`, `/api/device/logs`, `/api/agent/flags/detect`) plus an in-process logging ring buffer and an `asyncio.Lock` shared between the cycle loop and manual ops. One frontend page with four sections (System, Hardware, Operations, Logs), plus a Navbar entry.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium-Large | Medium-Large |
| Confidence | 7/10 | Hit on first build, no rework |
| Files Changed | 9 (3 created, 6 updated) | 9 (3 created, 6 updated) |
| `/admin` bundle | < 8 kB | 5.37 kB / 170 kB First Load |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | `core/log_ring.py` ring-buffer handler | Complete | Smoke-tested (records captured) |
| 2 | Install handler + create lock in lifespan | Complete | Lock created BEFORE HardwareLoop spawns |
| 3 | Wrap cycle's hardware blocks in lock | Complete | Both magazine+ejector AND drawer.hold_unlocked covered |
| 4 | `POST /api/device/eject` | Complete | Body `{slot:int}` Pydantic-validated |
| 5 | `POST /api/device/drawer` | Complete | Returns updated `is_unlocked` |
| 6 | `GET /api/device/snapshot?cam=` | Complete | `Response(content=jpeg, media_type="image/jpeg")` |
| 7 | `GET /api/device/logs?n=` | Complete | Reads from ring buffer; works in headless mode |
| 8 | `POST /api/agent/flags/detect` | Complete | Calls `detect_and_persist_flags` with 60 s timeout |
| 9 | Extend `lib/device.ts` + add `is_unlocked` field | Complete | New types: `EjectResult`, `DrawerResult`, `LogRecord` |
| 10 | `triggerFlagDetection` in `lib/agent.ts` | Complete | |
| 11 | `/admin` page | Complete | 4 sections + status banner + log tail |
| 12 | Navbar "Admin" entry | Complete | |
| 13 | `/status` payload includes `is_unlocked` | Complete | Both headless and live branches |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (tsc) | Pass | Zero type errors |
| Backend syntax (ast.parse) | Pass | All 6 touched files parse |
| Ring-buffer smoke | Pass | Captured 2/2 emitted records |
| Build (`next build`) | Pass | 9 routes generated; `/admin` 5.37 kB |
| Unit Tests | N/A | No test framework configured (per CLAUDE.md) |
| Pi browser test | Pending | Operator step — see Next Steps |

## Files Changed

| File | Action | Notes |
|---|---|---|
| `backend/core/log_ring.py` | CREATED | +63 LOC; thread-safe ring with `Lock` |
| `backend/main.py` | UPDATED | +2 lines lifespan setup + 1 line HardwareLoop arg |
| `backend/api/device.py` | UPDATED | +4 routes (eject, drawer, snapshot, logs) + `is_unlocked` in /status |
| `backend/api/agent.py` | UPDATED | +1 route (`/flags/detect`) |
| `backend/scheduler/cycle_runner.py` | UPDATED | `hardware_lock` attr + 2 wrapped blocks (magazine+ejector, drawer) |
| `backend/scheduler/background.py` | UPDATED | Optional `hardware_lock` ctor arg, propagated to state |
| `frontend/src/lib/device.ts` | UPDATED | +4 client functions + types; `DeviceStatus.is_unlocked` |
| `frontend/src/lib/agent.ts` | UPDATED | +`triggerFlagDetection` + type |
| `frontend/src/app/admin/page.tsx` | CREATED | +400 LOC; 4 sections, status banner, log tail |
| `frontend/src/components/Navbar.tsx` | UPDATED | +1 NAV_ITEMS entry |

## Deviations from Plan
**One minor deviation**: Plan code samples used `state.drawer` for the drawer attribute name; the actual `CycleState` field is `state.drawer_lock` (verified via reading `cycle_runner.py`). Endpoint code uses the correct name (`getattr(state, "drawer_lock", None)`).

The lock-wiring approach in cycle_runner uses a `state.hardware_lock` instance attribute (set by `HardwareLoop.start` before `state.init()`) rather than directly accessing `app.state.hardware_lock`. This avoids leaking FastAPI's `app` reference into the cycle layer. Functionally equivalent — both manual endpoints and the cycle acquire the SAME `asyncio.Lock` instance created in `main.py:lifespan`.

## Issues Encountered
None blocking. GateGuard pre-edit hook required fact restatement before each Write/Edit (no rejections). One minor smoke-test miss: `logging.info()` requires the root logger to be at INFO level, which production already does via `basicConfig` but the standalone smoke test had to add it explicitly.

## Tests Written
N/A — repo has no test framework. Plan's manual test matrix is left to operator browser run on the Pi.

## Next Steps
- [ ] Operator: `make pi-sync HOST=pi@<host>` then `sudo systemctl restart pharmguard`. Then visit `/admin` in dashboard.
- [ ] Manual click-through of test matrix (vacant headless 503s, eject latency, drawer state pill, snapshot inline JPEG, log tail growth, brief/detect toasts).
- [ ] Concurrency check: trigger eject mid-cycle and verify lock fairness (no GPIO collision).
- [ ] Future enhancement candidates explicitly excluded by this plan: journalctl viewer, log filtering/search/download, audit trail, role-based perms, runtime stub-mode toggle, snapshot quality slider.
