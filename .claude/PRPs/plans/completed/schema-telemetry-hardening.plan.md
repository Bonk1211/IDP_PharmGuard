# Plan: Schema + Telemetry Hardening (PRD Phase 1)

## Summary
Additive migration on the Supabase `medications` and `adherence_logs` tables — add `dispenser_id`, `expiry_date`, `pills_per_dose` to medications, and `dispenser_id`, `confidence_score` to adherence_logs. Update Pydantic models in `backend/app/api/inventory.py` and `backend/app/api/logs.py` so the new fields round-trip end-to-end. No frontend changes required for this phase; new fields are optional everywhere.

## User Story
As the **PharmGuard backend**, I want **the data model to carry per-dispenser identity, expiry, dose-multiplicity, and per-event confidence**, so that **future Face ID, alerts, dashboards, and multi-device fleet phases have a stable schema to build on**.

## Problem → Solution
Today the schema is single-device implicit and lossy: there is no `dispenser_id`, no `expiry_date`, no `pills_per_dose`, no per-log `confidence_score`. Phase 3 (Face ID), Phase 5 (alerts), Phase 7 (dashboard surfaces), and Phase 9 (accuracy validation) all depend on these fields. This phase makes the schema fit the product without breaking any existing call site.

## Metadata
- **Complexity**: Small
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 1 — Schema + telemetry hardening
- **Estimated Files**: 6 changed + 1 new (7 total)
- **Estimated Lines**: ~120 LOC + 1 SQL migration

---

## UX Design

Internal change — no user-facing UX transformation. Frontend continues to render exactly what it renders today; new columns are optional and unused at the UI layer in this phase.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Pi `POST /api/logs/` | `{patient_id, slot, pill_taken}` | `{patient_id, slot, pill_taken, dispenser_id?, confidence_score?}` | new fields optional |
| Pi `GET /api/inventory/next-dispense` | returns `{patient_id, slot, medication}` | adds optional `expiry_date`, `pills_per_dose`, `dispenser_id` | additive |
| Caregiver `PUT /api/inventory/{slot}` | `{medication_name, quantity, patient_id}` | adds optional `expiry_date`, `pills_per_dose`, `dispenser_id` | additive |
| Frontend `lib/api.ts` types | unchanged | one optional field added per type | non-breaking |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/app/api/inventory.py` | 1–88 | Where SlotUpdate Pydantic model lives + the 4 endpoints that must accept new fields |
| P0 | `backend/app/api/logs.py` | 1–86 | Where IntakeLog Pydantic model lives + WS broadcast that emits new fields |
| P0 | `backend/app/db/base.py` | 1–13 | Singleton client — confirms there is no ORM; all writes go through Supabase JSON |
| P0 | `backend/app/core/security.py` | 30–60 | Device-token dep — every new endpoint must use it |
| P0 | `frontend/src/lib/api.ts` | 1–180 | Source-of-truth TypeScript types for `Patient`, `SlotInfo`, `IntakeRecord`; mirrors live schema |
| P1 | `frontend/src/components/IntakeLog.tsx` | 18–30 | Realtime channel binds to `adherence_logs` INSERT — confirms columns must remain backward-compatible |
| P1 | `frontend/src/components/DispenserOverview.tsx` | 30–150 | Renders slots filtered by `(patient_id, slot)` — confirms slot is **per-patient** in current schema |
| P1 | `edge_pi/main.py` | 47–60 | `report_intake` POST shape — needs widening to send `dispenser_id` once available |
| P1 | `edge_pi/config.py` | 38–110 | Frozen settings dataclass + `validate()` — pattern to mirror when adding `DISPENSER_ID` env |
| P2 | `backend/app/services/gemini_fallback.py` | 1–39 | Where future `confidence_score` may originate when YOLO falls back to Gemini |
| P2 | `CLAUDE.md` | all | Tier boundaries — Pi never holds Supabase or Gemini key; backend is the only writer |
| P2 | `.mcp.json` | all | Confirms Supabase MCP project = `wqijdqclqhybhdtgsznf`; use `mcp__supabase__apply_migration` |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Supabase ALTER TABLE without downtime | https://supabase.com/docs/guides/database/postgres/migrations | Adding NULL-able columns is online and lock-free in Postgres 14+ — no maintenance window needed |
| Postgres `ADD COLUMN IF NOT EXISTS` | https://www.postgresql.org/docs/current/sql-altertable.html | `IF NOT EXISTS` makes the migration idempotent — safe to re-run |
| Supabase MCP `apply_migration` | https://supabase.com/docs/guides/api/mcp | Migration is named, persisted in `supabase_migrations.schema_migrations`, and replayable |
| Pydantic v2 optional fields | https://docs.pydantic.dev/latest/concepts/fields/ | Use `field: type \| None = None` for "may be present, may be NULL" — what Supabase round-trips |

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: backend/app/api/inventory.py:1-15
"""Inventory endpoints — manage the 10-slot magazine per dispenser."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.security import verify_device_token
from app.db.base import get_supabase

router = APIRouter()


class SlotUpdate(BaseModel):
    medication_name: str
    quantity: int
    patient_id: int
```
Rule: snake_case fields on Pydantic models, PascalCase model name, module-level `router = APIRouter()`, every state-changing endpoint takes `Depends(verify_device_token)`.

### ERROR_HANDLING
```python
# SOURCE: backend/app/api/inventory.py:60-65
@router.put("/{slot}", dependencies=[Depends(verify_device_token)])
async def update_slot(slot: int, data: SlotUpdate):
    if slot < 0 or slot > 9:
        raise HTTPException(status_code=400, detail="Slot must be 0-9")
```
Rule: validate inputs at the top of the handler, raise `HTTPException` with explicit `status_code` and a short `detail` string — do not catch and re-wrap library errors unless adding signal.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/hardware/magazine.py:8, 50-58
log = logging.getLogger(__name__)
# ...
log.info("Magazine GPIO initialized")
log.warning("GPIO unavailable — stub mode (PHARMGUARD_STUB=1)")
```
Rule: module-level `log = logging.getLogger(__name__)`; use `log.info/warning/error` directly — pass args as positional formatters, not f-strings.

### DATA_ACCESS_PATTERN
```python
# SOURCE: backend/app/api/logs.py:23-30
@router.post("/", dependencies=[Depends(verify_device_token)])
async def create_log(log: IntakeLog):
    sb = get_supabase()
    result = (
        sb.table("adherence_logs")
        .insert(log.model_dump())
        .execute()
    )
    record = result.data[0]
```
Rule: lazy singleton via `get_supabase()`, fluent chain `.table(name).insert/select/update.execute()`, dump Pydantic with `.model_dump()` (Pydantic v2). Do NOT instantiate `create_client` anywhere else.

### UPSERT_PATTERN
```python
# SOURCE: backend/app/api/inventory.py:67-86
result = sb.table("medications").select("id").eq("slot", slot).execute()
payload = {
    "name": data.medication_name,
    "slot": slot,
    "quantity": data.quantity,
    "patient_id": data.patient_id,
}
if result.data:
    resp = sb.table("medications").update(payload).eq("slot", slot).execute()
else:
    resp = sb.table("medications").insert(payload).execute()
return resp.data[0] if resp.data else payload
```
Rule: select-then-update-or-insert (the codebase does NOT use Postgres `upsert()`). Preserve when adding new fields.

### WS_BROADCAST_PATTERN
```python
# SOURCE: backend/app/api/logs.py:32-40
for ws in _ws_clients[:]:
    try:
        await ws.send_json(record)
    except Exception:
        _ws_clients.remove(ws)
```
Rule: iterate over a copy, fail-safe remove on send error — preserve when broadcasting the wider record.

### CONFIG_PATTERN_BACKEND
```python
# SOURCE: backend/app/core/config.py:5-18
class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_key: str = ""
    secret_key: str = "dev-secret-change-in-production"
    gemini_api_key: str = ""
    device_tokens: str = ""

    model_config = {"env_file": ".env"}
```
Rule: lowercase snake_case fields with empty-string defaults, `pydantic_settings.BaseSettings`, env loaded from `backend/.env`.

### CONFIG_PATTERN_PI
```python
# SOURCE: edge_pi/config.py:42-110
@dataclass(frozen=True)
class _Settings:
    BACKEND_URL: str
    DEVICE_TOKEN: str
    POLL_INTERVAL_S: float
    STUB_MODE: bool

def _load() -> _Settings:
    backend_url = _require("BACKEND_URL")
    device_token = _require("DEVICE_TOKEN")
    ...
    return _Settings(...)
```
Rule: Pi side uses **frozen dataclass + lazy `_LazySettings` proxy + `_require()` helper**, not pydantic-settings. Mirror this when widening.

### TYPE_DEFINITION_FRONTEND
```ts
// SOURCE: frontend/src/lib/api.ts:13-22
export interface SlotInfo {
  id: number;
  slot: number;
  name: string | null;
  description: string | null;
  quantity: number;
  patient_id: number;
  patient?: Patient | null;
}
```
Rule: `interface` over `type`; nullable columns as `T | null`; optional joins as `?: T | null`. New columns must be added with `| null` to keep existing row reads non-breaking.

### TEST_STRUCTURE
N/A — repo has no test suite (`CLAUDE.md`: "There is **no test suite** in this repo yet"). Validation is manual (curl + Supabase row inspection) for this phase.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/migrations/0001_phase1_schema_hardening.sql` | CREATE | Idempotent ALTER TABLE script — single source of truth for the schema delta; replayable via Supabase SQL editor or MCP |
| `backend/app/api/inventory.py` | UPDATE | Extend `SlotUpdate` model + `update_slot` payload + `next_dispense` response with new optional fields |
| `backend/app/api/logs.py` | UPDATE | Extend `IntakeLog` model + `create_log` insert with `dispenser_id` + `confidence_score` |
| `backend/app/core/config.py` | UPDATE | Add `default_dispenser_id: str = "dispenser-001"` so single-device deploys keep working without env change |
| `frontend/src/lib/api.ts` | UPDATE | Add the new optional fields to `SlotInfo` and `IntakeRecord` so `select("*")` reads round-trip cleanly into TypeScript |
| `edge_pi/config.py` | UPDATE | Add optional `DISPENSER_ID` env (default empty); pass it on log POSTs once supplied |
| `edge_pi/main.py` | UPDATE | Include `dispenser_id` in `report_intake` payload when set |

## NOT Building

- **Backfilling existing rows** with a real `dispenser_id` — Phase 1 leaves them NULL; multi-device fleet support is a separate Could-have item from PRD.
- **Fixing the `(patient_id, slot)` composite-key mismatch** between backend (`inventory.py:60` filters by `slot` only) and frontend (`api.ts:fetchSlotsByPatient` uses both). Documented as a known issue; deliberately out of scope to keep the migration purely additive.
- **`/api/alerts/` endpoint or expiry/low-stock cron** — that is PRD Phase 5.
- **Frontend UI for editing expiry / dose** — Phase 7.
- **RLS policy changes** — leave row-level security untouched; new columns inherit the table's existing policy.
- **Renaming columns** — additive only, never rename in this phase.
- **Pi-side queue / offline buffer** — Phase 8.
- **Confidence-score wiring from YOLO output** — placeholder column only; producer side ships in Phase 9.

---

## Step-by-Step Tasks

### Task 1: Author idempotent SQL migration
- **ACTION**: Create `backend/migrations/0001_phase1_schema_hardening.sql`.
- **IMPLEMENT**:
  ```sql
  -- Phase 1: schema + telemetry hardening (PRD .claude/PRPs/prds/pharmguard.prd.md)
  -- Idempotent: safe to re-run.

  ALTER TABLE public.medications
      ADD COLUMN IF NOT EXISTS dispenser_id    text,
      ADD COLUMN IF NOT EXISTS expiry_date     date,
      ADD COLUMN IF NOT EXISTS pills_per_dose  integer NOT NULL DEFAULT 1;

  ALTER TABLE public.medications
      DROP CONSTRAINT IF EXISTS medications_pills_per_dose_positive;
  ALTER TABLE public.medications
      ADD CONSTRAINT medications_pills_per_dose_positive
          CHECK (pills_per_dose >= 1) NOT VALID;
  ALTER TABLE public.medications
      VALIDATE CONSTRAINT medications_pills_per_dose_positive;

  CREATE INDEX IF NOT EXISTS medications_dispenser_id_idx
      ON public.medications (dispenser_id);
  CREATE INDEX IF NOT EXISTS medications_expiry_date_idx
      ON public.medications (expiry_date);

  ALTER TABLE public.adherence_logs
      ADD COLUMN IF NOT EXISTS dispenser_id      text,
      ADD COLUMN IF NOT EXISTS confidence_score  real;

  ALTER TABLE public.adherence_logs
      DROP CONSTRAINT IF EXISTS adherence_logs_confidence_score_range;
  ALTER TABLE public.adherence_logs
      ADD CONSTRAINT adherence_logs_confidence_score_range
          CHECK (confidence_score IS NULL OR (confidence_score >= 0.0 AND confidence_score <= 1.0)) NOT VALID;
  ALTER TABLE public.adherence_logs
      VALIDATE CONSTRAINT adherence_logs_confidence_score_range;

  CREATE INDEX IF NOT EXISTS adherence_logs_dispenser_id_idx
      ON public.adherence_logs (dispenser_id);
  ```
- **MIRROR**: No existing migrations file exists — this seeds the convention. Place under `backend/migrations/` so future phases follow the `0002_*`, `0003_*` numbering.
- **IMPORTS**: N/A (SQL).
- **GOTCHA**: `pills_per_dose` defaults to 1; PG12+ rewrites this metadata-only (no table rewrite), confirmed by Postgres docs. `DROP CONSTRAINT IF EXISTS` precedes ADD so re-running with a tweaked predicate is safe.
- **VALIDATE**: SQL parses cleanly; if a local PG is available, `psql -f backend/migrations/0001_phase1_schema_hardening.sql` against a scratch DB. Otherwise rely on the MCP apply step.

### Task 2: Apply migration via Supabase MCP
- **ACTION**: Call `mcp__supabase__apply_migration` with `name="phase1_schema_hardening"` and the SQL body from Task 1.
- **IMPLEMENT**: One MCP call. **Fallback** when MCP times out (intermittent in this session): paste the SQL into the Supabase Studio SQL editor for project `wqijdqclqhybhdtgsznf` and run it there. The file under `backend/migrations/` remains the source of truth either way.
- **MIRROR**: `.mcp.json` declares `wqijdqclqhybhdtgsznf` as the only Supabase project — no project-id ambiguity.
- **IMPORTS**: N/A.
- **GOTCHA**: Supabase MCP applied migrations land in `supabase_migrations.schema_migrations` — re-applying the same name is a no-op only if SQL hash matches; if you change the SQL after a partial failure, append a numeric suffix (`phase1_schema_hardening_v2`) rather than mutating the original.
- **VALIDATE**: `mcp__supabase__list_tables` (verbose=true) shows the new columns + constraints + indexes on both tables. If MCP unavailable, run in SQL editor:
  ```sql
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_name in ('medications','adherence_logs')
    and column_name in ('dispenser_id','expiry_date','pills_per_dose','confidence_score')
  order by table_name, column_name;
  ```
  Expect 5 rows.

### Task 3: Extend `IntakeLog` Pydantic model
- **ACTION**: Edit `backend/app/api/logs.py`.
- **IMPLEMENT**:
  - Update `IntakeLog` (currently lines 14–18) to:
    ```python
    class IntakeLog(BaseModel):
        patient_id: int
        slot: int
        pill_taken: bool
        dispenser_id: str | None = None
        confidence_score: float | None = None
    ```
  - In `create_log` (line 22), no body change needed — `log.model_dump()` already serialises all fields. The Supabase insert will include the new columns automatically because they exist in the table after Task 2.
  - The WS broadcast (`for ws in _ws_clients[:]: await ws.send_json(record)`) already forwards the full row — new fields propagate to frontend listeners with no further change.
- **MIRROR**: DATA_ACCESS_PATTERN, WS_BROADCAST_PATTERN.
- **IMPORTS**: No new imports required.
- **GOTCHA**: Pydantic v2 `model_dump()` includes `None` values by default — that is **desired** here so a NULL is written, not a missing key. If you switch to `model_dump(exclude_none=True)` the migration's NOT-NULL-default invariants still hold, but you lose the ability to explicitly clear `confidence_score` after a re-write.
- **VALIDATE**:
  ```bash
  curl -X POST http://localhost:8000/api/logs/ \
    -H "Authorization: Bearer $DEVICE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"patient_id":1,"slot":0,"pill_taken":true,"dispenser_id":"dispenser-001","confidence_score":0.92}'
  ```
  Expect 200 with the inserted row including `dispenser_id` and `confidence_score`. Repeat without those two fields — also expect 200 with NULLs persisted.

### Task 4: Extend `SlotUpdate` model + `update_slot` payload + `next_dispense` response
- **ACTION**: Edit `backend/app/api/inventory.py`.
- **IMPLEMENT**:
  - Update `SlotUpdate` (lines 12–15) to:
    ```python
    class SlotUpdate(BaseModel):
        medication_name: str
        quantity: int
        patient_id: int
        expiry_date: str | None = None       # ISO-8601 YYYY-MM-DD; Postgres casts text → date
        pills_per_dose: int = 1
        dispenser_id: str | None = None
    ```
  - In `update_slot` (lines 67–86), extend the `payload` dict:
    ```python
    payload = {
        "name": data.medication_name,
        "slot": slot,
        "quantity": data.quantity,
        "patient_id": data.patient_id,
        "expiry_date": data.expiry_date,
        "pills_per_dose": data.pills_per_dose,
        "dispenser_id": data.dispenser_id,
    }
    ```
  - In `next_dispense` (lines 24–46), widen the response when present:
    ```python
    return {
        "patient_id": med["patient_id"],
        "slot": med["slot"],
        "medication": med["name"],
        "expiry_date": med.get("expiry_date"),
        "pills_per_dose": med.get("pills_per_dose", 1),
        "dispenser_id": med.get("dispenser_id"),
    }
    ```
- **MIRROR**: NAMING_CONVENTION, UPSERT_PATTERN, ERROR_HANDLING (the existing `slot < 0 or slot > 9` guard stays untouched).
- **IMPORTS**: No new imports.
- **GOTCHA**:
  - `pills_per_dose` is `NOT NULL DEFAULT 1` at the DB level — the Pydantic default of `1` matches and prevents a constraint violation on legacy clients.
  - `expiry_date` is sent as a string. Supabase Python client passes it through as JSON; Postgres casts text → date implicitly when the target column is `date`. Pass `null` (not `""`) to clear it.
  - The `(patient_id, slot)` mismatch in `update_slot`'s lookup is **NOT fixed in this phase** — see NOT Building.
- **VALIDATE**:
  ```bash
  curl -X PUT http://localhost:8000/api/inventory/3 \
    -H "Authorization: Bearer $DEVICE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"medication_name":"Metformin","quantity":30,"patient_id":1,"expiry_date":"2026-12-01","pills_per_dose":2,"dispenser_id":"dispenser-001"}'
  curl -H "Authorization: Bearer $DEVICE_TOKEN" http://localhost:8000/api/inventory/next-dispense
  ```
  Expect both responses to include `expiry_date`, `pills_per_dose`, `dispenser_id`.

### Task 5: Add `default_dispenser_id` to backend settings
- **ACTION**: Edit `backend/app/core/config.py`.
- **IMPLEMENT**:
  ```python
  class Settings(BaseSettings):
      supabase_url: str = ""
      supabase_key: str = ""
      secret_key: str = "dev-secret-change-in-production"
      gemini_api_key: str = ""
      device_tokens: str = ""
      default_dispenser_id: str = "dispenser-001"

      model_config = {"env_file": ".env"}
  ```
  No call sites use it yet; it is reserved for Phase 5 alert routing and Phase 7 dashboard scoping. Document the env var in `backend/.env.example` (create if absent) as `DEFAULT_DISPENSER_ID=dispenser-001`.
- **MIRROR**: CONFIG_PATTERN_BACKEND.
- **IMPORTS**: None.
- **GOTCHA**: `pydantic-settings` lower-cases env keys by default, so `DEFAULT_DISPENSER_ID` in the env file maps to `default_dispenser_id` on the model.
- **VALIDATE**:
  ```bash
  cd backend && python -c "from app.core.config import settings; print(settings.default_dispenser_id)"
  ```
  Expect `dispenser-001` (or whatever the env file holds).

### Task 6: Extend frontend types
- **ACTION**: Edit `frontend/src/lib/api.ts`.
- **IMPLEMENT**:
  ```ts
  export interface SlotInfo {
    id: number;
    slot: number;
    name: string | null;
    description: string | null;
    quantity: number;
    patient_id: number;
    expiry_date: string | null;       // YYYY-MM-DD
    pills_per_dose: number;            // defaults to 1 from DB
    dispenser_id: string | null;
    patient?: Patient | null;
  }

  export interface IntakeRecord {
    id: number;
    patient_id: number;
    slot: number;
    pill_taken: boolean;
    timestamp: string;
    dispenser_id: string | null;
    confidence_score: number | null;
    patient?: Patient | null;
  }
  ```
- **MIRROR**: TYPE_DEFINITION_FRONTEND.
- **IMPORTS**: None new.
- **GOTCHA**: Components that consume these interfaces (e.g. `DispenserOverview.tsx`, `IntakeLog.tsx`) only pick fields they already use — adding fields is non-breaking. Do **not** edit those components in this phase.
- **VALIDATE**: `cd frontend && npm run lint` — expect zero new errors. `npm run build` — expect green build.

### Task 7: Pi-side `DISPENSER_ID` env wiring
- **ACTION**: Edit `edge_pi/config.py` and `edge_pi/main.py`.
- **IMPLEMENT**:
  - In `_Settings` (around line 47 of `edge_pi/config.py`) add a new field:
    ```python
    DISPENSER_ID: str
    ```
  - In `_load()` add (do NOT use `_require()` — keep optional):
    ```python
    dispenser_id = os.environ.get("DISPENSER_ID", "")
    return _Settings(
        BACKEND_URL=backend_url,
        DEVICE_TOKEN=device_token,
        POLL_INTERVAL_S=poll_interval,
        STUB_MODE=stub_mode,
        DISPENSER_ID=dispenser_id,
    )
    ```
  - In `edge_pi/main.py::report_intake` (lines 47–60) widen the JSON body:
    ```python
    payload = {
        "patient_id": patient_id,
        "slot": slot,
        "pill_taken": verified,
    }
    if settings.DISPENSER_ID:
        payload["dispenser_id"] = settings.DISPENSER_ID
    session.post(
        f"{settings.BACKEND_URL}/api/logs/",
        json=payload,
        timeout=10,
    )
    ```
- **MIRROR**: CONFIG_PATTERN_PI — never instantiate `_Settings` directly outside `_load()`; use `_LazySettings` proxy.
- **IMPORTS**: No new imports.
- **GOTCHA**: `DISPENSER_ID` deliberately defaults to empty so `settings.validate()` does not start enforcing it — Phase 1 ships *capability*, not *requirement*. Phase 5 / Phase 8 can promote it to required later.
- **VALIDATE**:
  ```bash
  cd edge_pi
  PHARMGUARD_STUB=1 BACKEND_URL=https://localhost \
  DEVICE_TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')" \
  DISPENSER_ID=dispenser-001 \
  python3 -c "from config import settings; settings.validate(); print(settings.DISPENSER_ID)"
  ```
  Expect `dispenser-001` printed; no exception raised.

### Task 8: End-to-end smoke
- **ACTION**: Run a full Pi → backend → Supabase → dashboard cycle in stub mode.
- **IMPLEMENT**:
  1. Apply migration (Task 2 done).
  2. `make backend` (uvicorn).
  3. `cd edge_pi && PHARMGUARD_STUB=1 BACKEND_URL=http://localhost:8000 DEVICE_TOKEN=$T DISPENSER_ID=dispenser-001 python main.py` for one schedule tick — expect a row in `adherence_logs` with `dispenser_id='dispenser-001'`, `confidence_score=NULL`, `pill_taken=false` (stub mode forces false).
  4. `make frontend` and load `/` — expect the IntakeLog component to render the new row without console errors.
- **MIRROR**: Stub-mode safety guard in `edge_pi/main.py:87-104` — preserve. Never log `pill_taken=true` from stub.
- **IMPORTS**: None.
- **GOTCHA**: Stub mode flips `pill_taken` to `False` regardless of vision result — expected and required. Dashboard shows the row with the false flag, which is the desired safe behaviour.
- **VALIDATE**: Inspect the Supabase row via SQL editor:
  ```sql
  select id, patient_id, slot, pill_taken, dispenser_id, confidence_score, timestamp
  from adherence_logs order by id desc limit 5;
  ```
  Expect `dispenser_id='dispenser-001'` on the new rows; older rows unchanged with `dispenser_id IS NULL`.

---

## Testing Strategy

Repo has no test framework configured (`CLAUDE.md`). Validation is curl + SQL inspection, captured in each task's VALIDATE block.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Migration idempotency | Run SQL twice via SQL editor | First run: schema added. Second run: zero changes, zero errors. | yes |
| Backwards-compat insert | POST `/api/logs/` without new fields | 200, row inserted with NULLs in new columns | yes (legacy client) |
| Forward-compat insert | POST with `dispenser_id` + `confidence_score` | 200, both values persisted | normal |
| Boundary: confidence outside [0,1] | POST `confidence_score=1.5` | DB rejects via CHECK constraint, FastAPI returns 500 (acceptable for phase 1) | yes |
| Boundary: pills_per_dose=0 | PUT inventory with `pills_per_dose=0` | DB rejects via CHECK constraint | yes |
| Stub-mode safety preserved | Pi runs with `PHARMGUARD_STUB=1` | All adherence_logs rows have `pill_taken=false` | yes |
| Frontend type round-trip | `npm run build` after `lib/api.ts` edit | Zero TS errors | normal |
| WS broadcast carries new fields | Open `/api/logs/ws`, post a log | WS message includes `dispenser_id` + `confidence_score` keys | normal |

### Edge Cases Checklist
- [x] Empty input — legacy client without new fields still succeeds (defaults / NULLs).
- [x] Maximum size input — `dispenser_id` is `text`; no length cap added in phase 1 (acceptable).
- [x] Invalid types — `confidence_score` outside [0,1] rejected by DB CHECK; Pydantic does NOT pre-validate range in phase 1 (acceptable; Phase 9 hardens).
- [x] Concurrent access — additive ALTER TABLE is online; no lock contention expected.
- [x] Network failure — Pi-side POST already drops on failure (logged warning); Phase 8 owns the queue work.
- [x] Permission denied — RLS unchanged; existing policies inherit to new columns automatically.

---

## Validation Commands

### Static Analysis
```bash
cd frontend && npm run lint
cd frontend && npm run build
```
EXPECT: Zero new errors / warnings.

### Backend Smoke (no test runner, manual curl)
```bash
cd backend && uvicorn app.main:app --reload --port 8000 &
SERVER=$!
sleep 2
TOKEN="$(grep '^DEVICE_TOKENS=' .env | cut -d= -f2- | cut -d, -f1)"
curl -fsS -H "Authorization: Bearer $TOKEN" http://localhost:8000/health
curl -fsS -X POST http://localhost:8000/api/logs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"patient_id":1,"slot":0,"pill_taken":false,"dispenser_id":"dispenser-001","confidence_score":0.91}'
kill $SERVER
```
EXPECT: `health` returns `{"status":"ok"}`; the POST returns the inserted row JSON with `dispenser_id` and `confidence_score`.

### Database Validation
```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name in ('medications','adherence_logs')
  and column_name in ('dispenser_id','expiry_date','pills_per_dose','confidence_score')
order by table_name, column_name;

select conname from pg_constraint
where conrelid in ('public.medications'::regclass, 'public.adherence_logs'::regclass)
  and contype = 'c'
order by conname;
```
EXPECT: 5 column rows + both constraint rows present.

### Browser Validation
```bash
make frontend    # next dev on :3000
```
EXPECT: Dashboard at `http://localhost:3000/` loads. After a stub-mode Pi run, the IntakeLog feed shows the new row with no console errors.

### Manual Validation Checklist
- [ ] Migration applied: list_tables verbose output or SQL editor query shows new columns.
- [ ] `backend/migrations/0001_phase1_schema_hardening.sql` committed.
- [ ] Legacy POST without new fields still returns 200 (Edge case 1).
- [ ] New POST with all fields returns 200 and persists values (Task 3 VALIDATE).
- [ ] `npm run build` is green (Task 6 VALIDATE).
- [ ] `edge_pi/config.py` accepts `DISPENSER_ID` env or runs without it (Task 7 VALIDATE).
- [ ] WebSocket message at `/api/logs/ws` carries `dispenser_id` + `confidence_score`.
- [ ] Stub-mode safety guard still triggers when GPIO unavailable + `PHARMGUARD_STUB` unset.
- [ ] PRD Phase 1 status updated from `pending` → `in-progress` (then to `complete` after sign-off).

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] Migration is idempotent (second run is a no-op).
- [ ] Existing API contracts unchanged (legacy clients keep working without new fields).
- [ ] New fields round-trip Pi → backend → Supabase → frontend.
- [ ] No type errors / build regressions.
- [ ] Stub-mode safety guard preserved and verified.
- [ ] PRD `pharmguard.prd.md` Phase 1 row updated with this plan path in the **PRP Plan** column and status flipped to `in-progress`.

## Completion Checklist
- [ ] Code follows discovered patterns (NAMING_CONVENTION, DATA_ACCESS_PATTERN, UPSERT_PATTERN, CONFIG_PATTERN_*, TYPE_DEFINITION_FRONTEND).
- [ ] Error handling matches codebase style (HTTPException with explicit status; no broad except).
- [ ] Logging follows codebase conventions (`log = logging.getLogger(__name__)`).
- [ ] No hardcoded `dispenser_id` outside the default config value.
- [ ] No unnecessary scope additions (composite-key fix, alerts, RLS — all deferred).
- [ ] PRD updated.
- [ ] Plan self-contained — no codebase searching required during implementation.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Supabase MCP keeps timing out, blocking automated migration apply | M | Low | Fallback path documented (Task 2): paste SQL into Supabase Studio. Migration file is the source of truth either way. |
| `pills_per_dose NOT NULL DEFAULT 1` triggers table rewrite on older Postgres | L | Low | Supabase runs PG15+; `ADD COLUMN ... DEFAULT` is metadata-only since PG11. |
| Frontend type widening breaks existing components | L | Low | New fields added with `\| null`; components destructure only what they use. `npm run build` is the gate. |
| `(patient_id, slot)` composite-key mismatch surfaces during smoke | M | Low | Documented in NOT Building — phase 1 stays additive. Track as follow-up; do not fix here. |
| Pi `.env` lacks `DISPENSER_ID` after this lands | H | Low | Optional with empty default — Pi `validate()` does not enforce it. Phase 5/8 can promote to required. |
| `confidence_score` CHECK constraint returns 500 instead of 400 on bad input | L | Low | Range is the spec ([0,1]); tighten Pydantic in Phase 9 to surface a 400 instead of a 500. |

## Notes
- Repo has no migrations directory yet. This plan creates `backend/migrations/0001_*.sql` as the new convention; future phases (Phase 3 Face ID embeddings, Phase 5 alerts) should follow the `NNNN_<short_name>.sql` numbering.
- Supabase MCP project ref `wqijdqclqhybhdtgsznf` is hardcoded in `.mcp.json` — no environment selection needed.
- Pi-side config uses a different pattern (frozen dataclass) than backend config (pydantic-settings) **by design** — preserve.
- Pre-existing bug in `backend/app/api/inventory.py:60-86`: `update_slot` filters by `slot` only, while frontend uses `(patient_id, slot)` composite. Tracked, deferred — fixing it inside Phase 1 would expand scope and risk the additive-only invariant.
- After this plan ships, update `pharmguard.prd.md` Phase 1 row to:
  ```
  | 1 | Schema + telemetry hardening | ... | in-progress | with 2 | - | .claude/PRPs/plans/schema-telemetry-hardening.plan.md |
  ```
