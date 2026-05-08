# Plan: Sensor + Alerts Pipeline (PRD Phase 5)

## Summary
Add the alerts pipeline that connects the data the system already has (`medications.expiry_date`, `medications.quantity`) plus a new on-device temperature reading to the dashboard within 5 s. This phase introduces:
- A new `alerts` Postgres table (Supabase) with kind/severity/payload columns and RLS-readable rows.
- A new FastAPI router at `/api/alerts/*` mirroring `backend/app/api/logs.py` — including a `verify_device_token`-gated `POST /temperature`, an `POST /scan` operator endpoint that walks `medications` for low-stock + expiring rows, a list endpoint for the dashboard, and a WS endpoint for sub-5s push updates.
- A new `edge_pi/hardware/temp_sensor.py` reading `/sys/bus/w1/devices/28-*/w1_slave` (DS18B20 1-wire, no extra deps), with the same STUB_FAIL_LOUD pattern as `magazine.py`. The Pi loop posts a temperature sample once per cycle; backend decides whether it crosses threshold and creates an over-temperature alert.
- Frontend data-layer only: `Alert` interface + `fetchAlerts()` Supabase helper in `frontend/src/lib/api.ts`. No UI panel — that ships in Phase 7.

WS broadcast policy: a **separate** `_ws_clients` list is added to `alerts.py`. The logs WS contract (each frame = an `adherence_logs` row) is already in production via the `IntakeLog` component subscribing to that wire; co-mingling alert frames there would force every WS consumer to add a discriminator. A new endpoint at `/api/alerts/ws` keeps the contracts disjoint and parallel-safe with Phase 7.

Scheduler approach: **operator-poked `POST /api/alerts/scan`** rather than a backend startup task. Reasons: (1) it is testable without a process loop, (2) it survives backend restarts deterministically, (3) Phase 7's dashboard or any external cron (`crontab`, systemd timer, Supabase scheduled function) can drive it on whatever cadence operations chooses. Plain JSON, no payload required.

## User Story
As a **caregiver / nurse**, I want **the dashboard to surface a pill expiring this week, a slot dropping below 3 pills, or a tray temperature spike — within 5 seconds of the underlying event**, so that **I can act before the patient gets the wrong or unsafe dose**.

## Problem → Solution
**Today**: medications already carry `expiry_date` and `quantity`, but nothing reads them to fire alerts. The Pi has no temperature sensor; over-temperature events would fail silently. The dashboard has no alerts wire.
**After**: a single SQL migration creates `alerts`. A new router produces alert rows from three triggers: scheduled scan (expiry + low-stock), Pi-posted temperature sample crossing threshold, and any direct insert. Every insert WS-broadcasts to dashboard clients within one async hop. Frontend gets a typed read helper for Phase 7 to compose into a UI panel.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 5 — Sensor + alerts
- **Estimated Files**: 8 (1 migration + 1 backend router + 1 main.py mount + 1 backend Settings update + 1 backend env doc + 1 Pi hardware module + 1 Pi main.py block + 1 frontend types/helper)
- **Estimated Lines**: ~480 LOC net

---

## UX Design

### Before
```
medications.expiry_date  ─┐
medications.quantity     ─┤  ⟶ unread, never alerts
Pi tray temperature      ─┘  ⟶ no sensor, no signal
                              dashboard has no alerts wire
```

### After
```
┌──────────────────────────── Pi ────────────────────────────┐
│ temp_sensor.read_celsius()                                 │
│   └─ DS18B20 @ /sys/bus/w1/devices/28-*/w1_slave          │
│   └─ STUB_FAIL_LOUD if PHARMGUARD_STUB!=1                 │
│ POST /api/alerts/temperature {dispenser_id, value_c}       │
│   └─ Authorization: Bearer <DEVICE_TOKEN>                 │
└────────────────┬───────────────────────────────────────────┘
                 │ value_c > threshold
                 ▼
┌──────────────────────────── Backend ───────────────────────┐
│ POST /api/alerts/scan (op-poked, e.g. every 60s)           │
│   └─ scans medications: expiry ≤14d, quantity ≤3           │
│   └─ inserts alert rows (kind=expiry|low_stock)            │
│ POST /api/alerts/temperature                               │
│   └─ inserts alert row (kind=over_temperature)             │
│                                                            │
│ INSERT alerts ─► WS broadcast to /api/alerts/ws clients    │
└────────────────┬───────────────────────────────────────────┘
                 │ <1s after insert
                 ▼
┌──────────────────────────── Frontend ──────────────────────┐
│ fetchAlerts()  ⟶ typed read helper, Phase 7 builds panel  │
└────────────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `POST /api/alerts/temperature` | did not exist | accepts `{dispenser_id?, value_c}`, gated by `verify_device_token`; 200 (alert created or dropped if under threshold) | new |
| `POST /api/alerts/scan` | did not exist | walks medications; returns `{expiry: N, low_stock: M}` count; gated by `verify_device_token` | new |
| `GET /api/alerts/` | did not exist | returns alerts ordered by `created_at desc`; gated by `verify_device_token` | new |
| `WS /api/alerts/ws?token=…` | did not exist | broadcasts every alert row insert; identical auth handshake to logs WS | new |
| Pi loop | one cycle = poll → auth → rotate → eject → vision → log | adds one temp-sample POST per cycle (one localized block) | additive |
| Frontend `lib/api.ts` | no alerts type | exports `Alert` interface + `fetchAlerts()` Supabase reader | additive |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/app/api/logs.py` | 1–86 | Mirror exactly: WS list, `verify_device_token`, broadcast loop, `?token=` WS auth handshake |
| P0 | `backend/app/api/inventory.py` | 1–88 | Source of truth for `medications` columns we walk in scan |
| P0 | `backend/app/main.py` | 1–28 | Router-mounting convention |
| P0 | `backend/app/core/security.py` | 30–60 | `verify_device_token` dep |
| P0 | `backend/app/core/config.py` | 1–22 | Settings convention; threshold env vars added here |
| P0 | `backend/app/db/base.py` | 1–13 | Only path to Supabase |
| P0 | `backend/migrations/0001_phase1_schema_hardening.sql` | all | Migration convention: idempotent ADD/CONSTRAINT/INDEX, header block |
| P0 | `backend/migrations/0002_face_embedding.sql` | all | Migration numbering — next is `0003` |
| P0 | `edge_pi/hardware/magazine.py` | all | STUB_FAIL_LOUD pattern: import-time `STUB_ALLOWED`, `_init` raises unless allowed, `is_stub` property, fail-loud constructor |
| P0 | `edge_pi/hardware/ejector.py` | all | Second example of STUB_FAIL_LOUD; cross-check |
| P0 | `edge_pi/main.py` | 102–200 | Where the temp-sensor sample fits — directly after the existing magazine/ejector init and inside the polling loop, ahead of the next-dispense fetch so a 404 doesn't skip the temp post |
| P0 | `edge_pi/config.py` | 41–93 | Frozen `_Settings` dataclass + `_load()` env lookups; mirror for `TEMP_POLL_INTERVAL_S` if needed (we keep it implicit at one-per-cycle for V1) |
| P0 | `frontend/src/lib/api.ts` | 1–198 | Type and helper conventions (`Alert` mirrors `IntakeRecord`; `fetchAlerts()` mirrors `fetchLogs()`) |
| P1 | `.claude/PRPs/plans/completed/schema-telemetry-hardening.plan.md` | 60–180 | NAMING_CONVENTION, DATA_ACCESS_PATTERN, WS_BROADCAST_PATTERN, MIGRATION_PATTERN |
| P1 | `.claude/PRPs/plans/completed/face-id-end-to-end.plan.md` | 60–230 | Service-layer convention; Pi-side STUB rationale and main-loop wiring strategy |
| P2 | `CLAUDE.md` | full | Tier boundaries: Pi never holds Supabase or Gemini key; backend is the only DB writer |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| DS18B20 1-wire on Pi 5 | https://www.raspberrypi.com/documentation/computers/configuration.html#1-wire | Enable with `dtoverlay=w1-gpio` in `/boot/firmware/config.txt`; sensors enumerate under `/sys/bus/w1/devices/28-*/w1_slave`. Plain text protocol — `cat` the file and parse last line `t=12345` (millicelsius). |
| Supabase realtime + RLS for table reads | https://supabase.com/docs/guides/realtime/postgres-changes | RLS rules govern realtime subscriptions; the new `alerts` table inherits the project's default policy. We don't enable Supabase realtime for V1 — backend WS push is enough. |
| FastAPI WebSockets multi-client | https://fastapi.tiangolo.com/advanced/websockets/#using-depends-and-others | `WebSocket.send_json()` can fail mid-iteration — iterate over a copy and remove on error (already done in `logs.py`). |
| FastAPI BackgroundTasks vs scheduled jobs | https://fastapi.tiangolo.com/tutorial/background-tasks/ | `BackgroundTasks` runs *after* a response; not a scheduler. We chose operator-poked endpoint over `asyncio.create_task` startup loop because the loop dies on uvicorn `--reload` and complicates testing. |

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: backend/app/api/logs.py:1-12
"""Adherence log endpoints — record and query intake events."""

import hmac

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core.config import settings
from app.core.security import verify_device_token
from app.db.base import get_supabase

router = APIRouter()
```
Rule: module docstring, `router = APIRouter()`, snake_case Pydantic field names, PascalCase model names, every state-changing endpoint takes `Depends(verify_device_token)`.

### DATA_ACCESS_PATTERN
```python
# SOURCE: backend/app/api/logs.py:23-35
sb = get_supabase()
result = sb.table("adherence_logs").insert(log.model_dump()).execute()
record = result.data[0]
```
Rule: `get_supabase()` lazy singleton; fluent chain; insert/select/update; never `create_client` elsewhere.

### WS_BROADCAST_PATTERN
```python
# SOURCE: backend/app/api/logs.py:37-43
for ws in _ws_clients[:]:
    try:
        await ws.send_json(record)
    except Exception:
        _ws_clients.remove(ws)
```
Rule: iterate over a copy; remove on send failure; never raise out of the broadcast loop.

### WS_AUTH_PATTERN
```python
# SOURCE: backend/app/api/logs.py:65-88
@router.websocket("/ws")
async def logs_websocket(ws: WebSocket, token: str = Query(...)):
    valid_tokens = settings.device_tokens_set
    if not valid_tokens:
        await ws.close(code=1008); return
    authenticated = any(hmac.compare_digest(token, t) for t in valid_tokens)
    if not authenticated:
        await ws.close(code=1008); return
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        _ws_clients.remove(ws)
```
Rule: `?token=` query param (`HTTPBearer` does not apply to WS); fail-closed when no tokens configured; `hmac.compare_digest`; remove on disconnect.

### STUB_FAIL_LOUD (Pi hardware)
```python
# SOURCE: edge_pi/hardware/magazine.py:24-58
STUB_ALLOWED: bool = os.environ.get("PHARMGUARD_STUB", "0") == "1"

class Magazine:
    def __init__(self) -> None:
        self.gpio: Any = None
        self._is_stub: bool = False
        self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO
            ...
        except Exception as e:
            if STUB_ALLOWED:
                log.warning("GPIO unavailable — stub mode (PHARMGUARD_STUB=1)")
                self._is_stub = True
            else:
                raise RuntimeError("Magazine: GPIO init failed; set PHARMGUARD_STUB=1 to allow stub mode") from e

    @property
    def is_stub(self) -> bool:
        return self._is_stub
```
Rule: read `PHARMGUARD_STUB` once at module import; `is_stub` is a property; constructor fails loud unless explicitly stubbed; HI-012 invariant.

### MIGRATION_PATTERN
```sql
-- SOURCE: backend/migrations/0001_phase1_schema_hardening.sql
-- Phase N: <slug>
-- Plan: .claude/PRPs/plans/...plan.md
-- PRD:  .claude/PRPs/prds/pharmguard.prd.md (Phase N)
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.alerts (...);
CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON public.alerts (created_at DESC);
```
Rule: header block; `IF NOT EXISTS`; idempotent; numbered filename `NNNN_<short_name>.sql`.

### CONFIG_PATTERN_BACKEND
```python
# SOURCE: backend/app/core/config.py
class Settings(BaseSettings):
    supabase_url: str = ""
    ...
    expiry_warn_days: int = 14
    low_stock_threshold: int = 3
    over_temp_celsius: float = 30.0
```
Rule: lowercase snake_case; sensible defaults; `pydantic_settings.BaseSettings`; consumed via `from app.core.config import settings`.

### FRONTEND_API_HELPER_PATTERN
```ts
// SOURCE: frontend/src/lib/api.ts:108-124 (fetchLogs)
export async function fetchLogs(patientId?: number): Promise<IntakeRecord[]> {
  let query = supabase
    .from("adherence_logs")
    .select("*, patient:patients(id, name)")
    .order("timestamp", { ascending: false });
  ...
  if (error) throw error;
  return (data ?? []) as IntakeRecord[];
}
```
Rule: Supabase client direct; typed return; `if (error) throw error;`; `?? []` for null-safety.

### LOGGING_PATTERN
```python
log = logging.getLogger(__name__)
log.info("Created %s alert for dispenser=%s", kind, dispenser_id)
log.warning("Temperature read failed: %s", err)
```
Rule: positional formatters, never f-strings.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/migrations/0003_alerts.sql` | CREATE | New alerts table + indexes (idempotent) |
| `backend/app/api/alerts.py` | CREATE | Router: list, scan, temperature, WS broadcast |
| `backend/app/main.py` | UPDATE | Mount alerts router under `/api/alerts` |
| `backend/app/core/config.py` | UPDATE | Add `expiry_warn_days`, `low_stock_threshold`, `over_temp_celsius` |
| `edge_pi/hardware/temp_sensor.py` | CREATE | DS18B20 1-wire reader with STUB_FAIL_LOUD |
| `edge_pi/main.py` | UPDATE | One delimited block: per-cycle temp sample POST |
| `frontend/src/lib/api.ts` | UPDATE | `Alert` interface + `fetchAlerts()` helper |

## NOT Building
- **Frontend alerts UI panel** — Phase 7 owns dashboard surfaces; this plan ships only data-layer.
- **Backend startup scheduler / asyncio task loop** — chose operator-poked `/scan` instead. See Summary for rationale.
- **Alert deduplication** — caller may insert duplicates (e.g. running `/scan` 60 times in 60 min). Phase 7 may add a "snooze" or "ack" column; V1 keeps the table append-only.
- **Alert acknowledgement / resolved column** — append-only table; resolved-state machine deferred.
- **Email / SMS routing** — delivery channel for severity=high alerts is post-V1.
- **BME280 / I²C humidity sensor** — DS18B20 1-wire only; one sensor satisfies the success metric.
- **Multi-sensor support** — single `temp_sensor.py` reads the first `28-*` device it finds; multi-sensor enumeration deferred.
- **pgvector or partitioning on alerts** — table size is a non-issue at pilot scale.
- **WS reconnection / heartbeat** — Phase 7 will add client-side reconnection; backend keeps the bare receive_text loop from logs.py.
- **Alert filter by patient_id at the SQL level** — `payload jsonb` carries patient_id when applicable; client-side filter is fine for V1.
- **Backend cron job in Supabase** — operator-poked endpoint is the contract. Supabase pg_cron is one valid driver; not bundled in this phase.

---

## Step-by-Step Tasks

### Task 1: Author SQL migration `0003_alerts.sql`
- **ACTION**: Create `backend/migrations/0003_alerts.sql`.
- **MIRROR**: MIGRATION_PATTERN.
- **GOTCHA**: `CREATE TABLE IF NOT EXISTS` is the simplest idempotent path; constraints follow the same `DROP + ADD NOT VALID + VALIDATE` cycle as Phase 1 so a re-run never errors.
- **VALIDATE**: SQL parses; idempotent.

### Task 2: Apply migration via Supabase MCP
- **ACTION**: `mcp__supabase__apply_migration` with name `phase5_alerts`.
- **GOTCHA**: This worktree shares the same Supabase project as main; running this also changes the live DB, which is fine for V1 prototype.
- **VALIDATE**: query `information_schema` for the 6 expected columns.

### Task 3: Extend backend `Settings`
- **ACTION**: Edit `backend/app/core/config.py`.
- **MIRROR**: CONFIG_PATTERN_BACKEND.
- **GOTCHA**: pydantic-settings lowercases env keys; `EXPIRY_WARN_DAYS` → `expiry_warn_days`.

### Task 4: Create `backend/app/api/alerts.py`
- **ACTION**: New router with list / scan / temperature / WS endpoints.
- **MIRROR**: NAMING_CONVENTION, DATA_ACCESS_PATTERN, WS_BROADCAST_PATTERN, WS_AUTH_PATTERN.
- **GOTCHA**:
  - Separate `_ws_clients` list — do NOT import `logs._ws_clients` (would entangle two unrelated wires).
  - `_insert_alert` is `async` so the WS broadcast can await; `scan_inventory` is therefore `async` too.
  - `result.data` may be empty when service-role inserts succeed but RLS hides; defensive fallback.

### Task 5: Mount alerts router in `backend/app/main.py`
- **ACTION**: Edit `backend/app/main.py`.
- **GOTCHA**: keep prefix `/api/alerts` (no trailing slash) — matches `/api/logs`, `/api/inventory`.

### Task 6: Create `edge_pi/hardware/temp_sensor.py`
- **ACTION**: New Pi-side hardware module reading DS18B20 1-wire.
- **MIRROR**: STUB_FAIL_LOUD pattern (magazine.py / ejector.py).
- **GOTCHA**:
  - `glob.glob(...)` returns `[]` on macOS — that's the trigger for stub or fail-loud.
  - Stub returns 22 °C — strictly below the 30 °C default threshold so HI-012 invariant holds (no falsified over-temp).

### Task 7: Wire temp sensor into `edge_pi/main.py`
- **ACTION**: Edit `edge_pi/main.py` — one delimited Phase 5 block at the top of the loop body, plus one import + one constructor + one helper near `report_intake`.
- **GOTCHA**:
  - Place the per-cycle temp block **before** the existing `next-dispense` `try:` so a 404 doesn't skip the sample.
  - The Phase 5 block runs even when `hardware_stubbed` is True — the sensor itself respects HI-012 by returning a safe-room stub value.

### Task 8: Backend boot validation
- **ACTION**: symlink the main repo's `.venv` into the worktree, copy `.env`, then boot uvicorn on a free port and inspect `/openapi.json`.

### Task 9: Frontend types + `fetchAlerts()` helper
- **ACTION**: Append `Alert` type and `fetchAlerts()` to `frontend/src/lib/api.ts`.
- **MIRROR**: FRONTEND_API_HELPER_PATTERN.
- **GOTCHA**: Anonymous-role read of `alerts` requires the same default RLS posture as `medications` and `adherence_logs`.

### Task 10: End-to-end validation
- `python3 -m py_compile` on every backend + Pi file touched.
- `cd frontend && npm run build`.
- Backend boot probe.
- Migration column verification via `mcp__supabase__execute_sql`.

---

## Testing Strategy
Repo has no test framework. Validation = `py_compile` + `npm run build` + curl boot probe + Supabase column check.

### Manual / Smoke Tests
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Migration idempotency | apply `0003_alerts.sql` twice | second run no-ops | yes |
| `POST /temperature` over threshold | `{"value_c": 35}` | 200 `{alert_created: true}`, row inserted | normal |
| `POST /temperature` under threshold | `{"value_c": 22}` | 200 `{alert_created: false}` | normal |
| `POST /temperature` no token | omit header | 401 | yes |
| `POST /scan` with expiring med | seed `expiry_date = today + 7d` | one expiry alert | normal |
| `POST /scan` with low quantity | `quantity = 2` | one low_stock alert | normal |
| `GET /` after scan | | list ordered by created_at desc | normal |
| WS `/ws` | connect, trigger insert | client receives JSON within 1 s | normal |
| WS no token | omit `?token=` | 1008 close | yes |
| Pi temp sample (stub) | `PHARMGUARD_STUB=1` | sensor returns 22 °C; no alert | yes (HI-012) |
| Frontend `fetchAlerts()` | call from a Next.js page | typed array returned | normal |

### Edge Cases Checklist
- [x] Empty input — `POST /scan` with empty `medications` → 200 `{expiry: 0, low_stock: 0, scanned: 0}`.
- [x] Bad `expiry_date` text — log warning, skip; do not 500.
- [x] Quantity NULL — skipped (loop guards on `quantity is not None`).
- [x] Stub-mode Pi over-temp — sensor returns safe value; HI-012 holds.
- [x] WS sender failure — broadcast loop iterates copy and removes on error.
- [x] Re-running `/scan` 60× — duplicates by design; dedupe deferred.
- [x] Concurrent inserts — last-writer wins; alerts is append-only so no conflict.

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/.claude/worktrees/agent-ac2371a9ed919b10b
backend/.venv/bin/python -m py_compile \
    backend/app/api/alerts.py backend/app/main.py backend/app/core/config.py
python3 -m py_compile edge_pi/hardware/temp_sensor.py edge_pi/main.py
```

### Frontend Build
```bash
cd frontend && npm run build
```

### Backend Boot Probe
```bash
cd backend && .venv/bin/uvicorn app.main:app --port 8002 &
sleep 3
curl -fsS http://localhost:8002/health
curl -s http://localhost:8002/openapi.json | python -c "import json,sys; spec=json.load(sys.stdin); print(sorted(p for p in spec['paths'] if '/api/alerts' in p))"
pkill -f 'uvicorn app.main:app --port 8002'
```

### Database Validation
Use `mcp__supabase__execute_sql`:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='alerts' ORDER BY ordinal_position;
```

### Manual Validation Checklist
- [ ] `backend/migrations/0003_alerts.sql` exists and applied.
- [ ] `backend/app/api/alerts.py` exposes list / scan / temperature / ws.
- [ ] `backend/app/main.py` mounts `/api/alerts`.
- [ ] `backend/app/core/config.py` has the three new settings.
- [ ] `edge_pi/hardware/temp_sensor.py` STUB_FAIL_LOUD respected.
- [ ] `edge_pi/main.py` Phase 5 block bracketed by phase-comment delimiters.
- [ ] `frontend/src/lib/api.ts` exports `Alert` + `fetchAlerts`.

---

## Acceptance Criteria
- [ ] All 10 tasks completed.
- [ ] `/api/alerts/scan` produces an alert row when a medication has `expiry_date <= today + 14d` or `quantity <= 3`.
- [ ] `/api/alerts/temperature` produces an alert row only when `value_c > over_temp_celsius`.
- [ ] WS `/api/alerts/ws` delivers the inserted record to a connected client.
- [ ] Stub-mode Pi never produces a real over-temperature alert.
- [ ] No new dependencies in `backend/requirements.txt` or `edge_pi/requirements.txt`.

## Completion Checklist
- [ ] Backend follows discovered patterns (NAMING, DATA_ACCESS, WS_BROADCAST, WS_AUTH, MIGRATION).
- [ ] Pi follows STUB_FAIL_LOUD pattern; `PHARMGUARD_STUB=1` is the only stub gate.
- [ ] Frontend follows FRONTEND_API_HELPER_PATTERN.
- [ ] No `face_recognition` or Gemini dep added.
- [ ] PRD Phase 5 row left untouched (orchestrator updates after parallel agents return).

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 4 also edits `edge_pi/main.py` and merges conflict | M | M | Phase 5 wedge is a single delimited block at the **top** of the loop body; Phase 4 will edit the magazine/diverter/drawer block lower in the loop. Conflict surface is one block of 7 lines plus one import + one constructor + one helper near `report_intake`. |
| 1-wire kernel format drifts | L | L | `rfind("t=")` is robust to both legacy and current `w1-gpio` payloads. |
| Operator forgets to drive `/scan` | M | M | Add a hint in `.env.example` to set up a cron tick; Phase 7 dashboard may add a "Scan now" button. |
| RLS hides `alerts` from anonymous reads | M | M | Acceptable for V1; Phase 7 will harden / loosen RLS as the dashboard ships. |
| WS reconnect storm under flaky network | L | M | Phase 7 owns client-side reconnection. |
| Stub-mode falsifies an over-temp alert | L | H | `STUB_TEMP_C=22.0` < default threshold of 30 °C — HI-012 holds by construction. |
| `fetchAlerts()` requires anon-role select; RLS may forbid | M | L | Documented in NOT Building; Phase 7 sets policy. |

## Notes
- **Sub-5s success signal**: every alert insert calls `await _broadcast(record)` synchronously inside the request handler — the WS frame is sent before the HTTP response returns. End-to-end latency is dominated by the network hop, well under 5 s.
- **Why no alerts deduplication**: V1 chooses simplicity. The dashboard sees the latest 100 alerts; a noisy `/scan` cron hides older, unique alerts off-screen. Phase 7 adds an `acknowledged_at` column and the UI filter.
- **Why `/scan` is not a startup task**: uvicorn `--reload` kills startup tasks every code change; uvicorn workers > 1 each run their own startup task → duplicate alerts. Operator-poked endpoint scales cleanly to multiple uvicorn workers behind a load balancer.
- **Pi temp cadence**: one sample per main-loop tick (`POLL_INTERVAL_S` default 30 s). DS18B20 conversion is ~750 ms; not the bottleneck.
- **HI-012 invariant**: stub mode returns 22 °C constant; no path forges an over-temp event. Verified by inspection.

Sources:
- [Raspberry Pi 1-wire docs](https://www.raspberrypi.com/documentation/computers/configuration.html#1-wire)
- [DS18B20 / Linux w1-gpio reference](https://www.kernel.org/doc/Documentation/w1/slaves/w1_therm)
- [FastAPI WebSockets multi-client tutorial](https://fastapi.tiangolo.com/advanced/websockets/)
- [Postgres `CREATE TABLE IF NOT EXISTS`](https://www.postgresql.org/docs/current/sql-createtable.html)
- [Supabase Postgres changes + RLS](https://supabase.com/docs/guides/realtime/postgres-changes)
