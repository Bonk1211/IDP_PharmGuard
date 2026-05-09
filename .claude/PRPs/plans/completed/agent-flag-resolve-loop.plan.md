# Plan: Agent Flag → Human-in-the-Loop → Resolve

## Summary
Extend the read-only clinician assistant with a proactive flagging surface.
A new `agent_flags` table captures things that need a clinician to look at
(missed-dose streaks, low-confidence intake, low/expiring stock, agent
"notable patterns"). Detection runs at the same local hours as the brief
(hybrid: deterministic heuristics + a Gemini "soft pattern" pass).
Dashboard surfaces open flags; clinician acknowledges or resolves with an
optional note. Agent chat can READ flags via a new tool but cannot
create or resolve them — keeps the read-only invariant.

## User Story
As a nurse/pharmacist, I want the assistant to surface what I should look
at this shift and let me mark each item resolved with a quick note, so I
don't have to interrogate the AI to find what's wrong.

## Problem → Solution
Today: assistant only answers questions. Clinician must know what to ask.
Briefs are markdown blobs — no actionable state, no follow-through.
After: anomalies become rows the clinician can click through, ack, and
resolve with a note that becomes audit history. Briefs cite open flags.

## Metadata
- **Complexity**: Large (DB + scheduler + 2 services + 4 endpoints + 3 frontend pieces)
- **Source PRD**: N/A — extends `agentic-clinician-assistant.plan.md` (already shipped)
- **PRD Phase**: standalone follow-up
- **Estimated Files**: 12 (3 created, 9 updated/extended)

---

## UX Design

### Before
```
┌────────────────────────────────────────────────────┐
│ Dashboard                                          │
│  • Brief card (markdown blob)                      │
│  • Alerts panel (auto-generated low_stock/expiry)  │
│ — clinician reads, mentally tracks what to do —    │
└────────────────────────────────────────────────────┘
```

### After
```
┌────────────────────────────────────────────────────┐
│ Dashboard                                          │
│  • Brief card (cites N open flags)                 │
│  • Flags panel  ← NEW                              │
│      [warn] Patient Aaron — 3 missed doses (24h)   │
│             [Ack] [Resolve…]                       │
│      [info] Slot 4 trending empty by tomorrow      │
│             [Ack] [Resolve…]                       │
│  • Alerts panel (auto low_stock/expiry, unchanged) │
└────────────────────────────────────────────────────┘

Resolve dialog (inline expand, no modal):
┌──────────────────────────────────────┐
│ Resolve flag #4                      │
│ Patient Aaron — 3 missed doses (24h) │
│                                      │
│ Note (optional):                     │
│ [ Called family, next dose 8pm    ]  │
│                                      │
│             [Cancel]  [Resolve]      │
└──────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Dashboard | Brief + Alerts only | Brief + Flags + Alerts | Flags above Alerts |
| Brief content | Markdown bullets | Same + "## Open flags" section | Auto-cites first 5 open flags |
| Agent chat | 5 read tools | 6 read tools (`query_flags`) | No write tools added |
| Scheduler | Brief only | Brief + flag detection | Same interval, sequential |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/api/alerts.py` | 1-180 | Closest existing pattern: insert + list + dashboard wiring |
| P0 | `backend/services/agent_tools.py` | all | Tool registry shape, Pydantic `extra: forbid`, schema sanitiser |
| P0 | `backend/services/agent.py` | 296-358 | `generate_brief` shape — flag detection mirrors its prefetch pattern |
| P0 | `backend/scheduler/brief_scheduler.py` | all | Long-lived crash-safe loop — flag detection runs in the same task |
| P0 | `backend/migrations/0003_alerts.sql` | all | Constraint + index pattern (NOT VALID + VALIDATE dance) |
| P0 | `backend/migrations/0005_agent_briefs.sql` | all | Newest migration — same shape |
| P1 | `frontend/src/components/AlertsPanel.tsx` | all | UI pattern to mirror exactly |
| P1 | `frontend/src/lib/api.ts` | 221-275 | Existing alert types + tolerant fetch (returns `[]` on missing table) |
| P1 | `frontend/src/lib/agent.ts` | all | Add new helpers here (no new file) |
| P2 | `backend/main.py` | 27-92 | Lifespan task spawning — no change needed but understand sequence |

## External Documentation

No new external research. Gemini integration already proven; no new APIs.

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: backend/api/alerts.py:23-29
```python
ALERT_KIND_EXPIRY = "expiry"
ALERT_KIND_LOW_STOCK = "low_stock"

SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_CRITICAL = "critical"
```
→ For flags: `FLAG_KIND_MISSED_STREAK = "missed_streak"`,
`FLAG_KIND_LOW_CONFIDENCE = "low_confidence"`, `FLAG_KIND_TRENDING_EMPTY = "trending_empty"`,
`FLAG_KIND_NOTABLE_PATTERN = "notable_pattern"`.
Statuses: `STATUS_OPEN = "open"`, `STATUS_ACKED = "acked"`, `STATUS_RESOLVED = "resolved"`,
`STATUS_DISMISSED = "dismissed"`.

### MIGRATION_SHAPE
// SOURCE: backend/migrations/0003_alerts.sql + 0005_agent_briefs.sql
```sql
CREATE TABLE IF NOT EXISTS public.<name> ( ... );
ALTER TABLE public.<name>
    DROP CONSTRAINT IF EXISTS <name>_<col>_allowed;
ALTER TABLE public.<name>
    ADD CONSTRAINT <name>_<col>_allowed
        CHECK (<col> IN (...)) NOT VALID;
ALTER TABLE public.<name>
    VALIDATE CONSTRAINT <name>_<col>_allowed;
CREATE INDEX IF NOT EXISTS <name>_<col>_idx ON public.<name> (<col> ...);
```
Always idempotent (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`).

### ERROR_HANDLING (api routes)
// SOURCE: backend/api/agent.py:43-63
```python
try:
    result = await asyncio.wait_for(chat(safe_messages), timeout=60.0)
except asyncio.TimeoutError:
    raise HTTPException(status_code=504, detail="agent took too long (>60 s)")
except RuntimeError as exc:
    raise HTTPException(status_code=503, detail=str(exc))
return result
```

### LOGGING_PATTERN
// SOURCE: backend/api/alerts.py:73-77 + backend/services/agent.py:31
```python
log = logging.getLogger(__name__)
log.info("alert kind=%s severity=%s dispenser=%s", kind, severity, dispenser_id)
```
Single-line `key=value` style. No structured JSON.

### TOOL_REGISTRATION (Gemini tools)
// SOURCE: backend/services/agent_tools.py:223-282
```python
class QueryFlagsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    status: str | None = Field(default=None)
    kind: str | None = Field(default=None)
    limit: int = Field(default=20, ge=1, le=200)

def query_flags(**kwargs) -> list[dict]:
    args = QueryFlagsArgs(**kwargs)
    sb = get_supabase()
    q = sb.table("agent_flags").select("*").order("created_at", desc=True).limit(args.limit)
    if args.status: q = q.eq("status", args.status)
    if args.kind:   q = q.eq("kind", args.kind)
    return q.execute().data or []

TOOLS.append(ToolDef(
    name="query_flags",
    description="List agent-detected flags. Filter by status or kind.",
    args_schema=QueryFlagsArgs,
    fn=query_flags,
))
```

### SCHEDULER_LOOP
// SOURCE: backend/scheduler/brief_scheduler.py:63-106
```python
while True:
    try:
        target_hours = _parse_target_hours(settings.agent_brief_local_hours)
        wait_s = _seconds_until_next_target(target_hours)
        await asyncio.sleep(wait_s)
        # 1) detect flags FIRST so the brief can cite them
        new_flags = await detect_and_persist_flags()
        # 2) then generate the brief, passing open-flag count for citation
        brief = await generate_brief(kind="shift_handover")
        # 3) persist
        await asyncio.to_thread(...)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("scheduler crashed, retry in 60s")
        await asyncio.sleep(60)
```

### FRONTEND_FETCH_TOLERANT
// SOURCE: frontend/src/lib/api.ts:243-275
```ts
export async function fetchAlerts(...): Promise<Alert[]> {
  try {
    const { data, error } = await query;
    if (error) {
      if (error.code === "42P01" || ...) return [];
      throw error;
    }
    return (data ?? []) as Alert[];
  } catch {
    return [];
  }
}
```
Always tolerate a missing table — returns `[]` so the dashboard never breaks.

### COMPONENT_STRUCTURE
// SOURCE: frontend/src/components/AlertsPanel.tsx:65-170
```tsx
export default function AlertsPanel() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetchAlerts().then(setAlerts).finally(() => setLoading(false)); }, []);
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <header>...</header>
      {loading ? <Loading/> : alerts.length === 0 ? <Empty/> :
        alerts.map(a => <Row key={a.id} alert={a} />)}
    </div>
  );
}
```
`rounded-2xl border-sand-200 bg-white p-6` is the shared card chrome.

### TEST_STRUCTURE
No test framework configured — per CLAUDE.md ("don't claim tests pass — there are none to run").
Validate via `python -m py_compile` + targeted `python -c` import smoke + `npx tsc --noEmit`.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/migrations/0006_agent_flags.sql` | CREATE | New table + status/kind constraints + indexes |
| `backend/services/flag_detector.py` | CREATE | Heuristic + Gemini hybrid detection |
| `backend/api/flags.py` | CREATE | GET /, POST /{id}/ack, POST /{id}/resolve, POST /{id}/dismiss |
| `backend/services/agent_tools.py` | UPDATE | Append `query_flags` tool to registry |
| `backend/services/agent.py` | UPDATE | `generate_brief` accepts open-flags list, cites them in user prompt |
| `backend/scheduler/brief_scheduler.py` | UPDATE | Run `detect_and_persist_flags()` before brief |
| `backend/main.py` | UPDATE | `app.include_router(flags.router, prefix="/api/agent/flags", tags=["agent-flags"])` |
| `backend/.env.example` | UPDATE | Document `AGENT_FLAG_MISSED_STREAK_THRESHOLD`, `AGENT_FLAG_LOW_CONFIDENCE_THRESHOLD`, `AGENT_FLAG_GEMINI_ENABLED` |
| `backend/config.py` | UPDATE | Add the three new settings with safe defaults |
| `frontend/src/lib/agent.ts` | UPDATE | Add `AgentFlag` type + `fetchOpenFlags`, `ackFlag`, `resolveFlag`, `dismissFlag` |
| `frontend/src/components/FlagsPanel.tsx` | CREATE | Dashboard component, mirror AlertsPanel structure |
| `frontend/src/app/page.tsx` | UPDATE | Mount FlagsPanel above AlertsPanel |

## NOT Building

- **Notifications/push/email**: flags surface in the dashboard only. No SMS, no Slack, no on-Pi LED.
- **WebSocket push**: alerts.py has it; flags don't need realtime — scheduled detection + dashboard refetch is fine.
- **Per-flag assignment**: no "assign to nurse X" workflow. Anyone with the dashboard can resolve.
- **Auto-resolve**: a flag stays open until a human resolves it. No "stale > 7d auto-close" rule in v1.
- **Resolve via chat**: agent stays read-only. Operator must click the dashboard button.
- **Resolution audit identity**: `resolved_by_user` is recorded as a free-text string from the dashboard (we have no auth identity yet); revisit once auth lands.
- **Flag de-duplication across runs**: detection inserts a fresh row each scheduler tick. Open same-fingerprint flags are deduped at insert time only (see Task 2 GOTCHA). No cross-time merging.

---

## Step-by-Step Tasks

### Task 1: Migration 0006_agent_flags
- **ACTION**: Create the schema.
- **IMPLEMENT**: New file `backend/migrations/0006_agent_flags.sql`:
  ```sql
  -- Phase: agent flag → human-in-the-loop → resolve.
  -- Plan: .claude/PRPs/plans/agent-flag-resolve-loop.plan.md
  -- Idempotent: safe to re-run.

  CREATE TABLE IF NOT EXISTS public.agent_flags (
      id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind               text NOT NULL,
      severity           text NOT NULL DEFAULT 'warning',
      status             text NOT NULL DEFAULT 'open',
      title              text NOT NULL,
      detail             text,
      patient_id         bigint,
      dispenser_id       text,
      slot               smallint,
      fingerprint        text,
      payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
      detected_by        text NOT NULL DEFAULT 'heuristic',
      created_at         timestamptz NOT NULL DEFAULT now(),
      acked_at           timestamptz,
      resolved_at        timestamptz,
      resolved_by_user   text,
      resolution_note    text
  );

  ALTER TABLE public.agent_flags DROP CONSTRAINT IF EXISTS agent_flags_kind_allowed;
  ALTER TABLE public.agent_flags
      ADD CONSTRAINT agent_flags_kind_allowed
          CHECK (kind IN ('missed_streak', 'low_confidence', 'trending_empty',
                          'notable_pattern')) NOT VALID;
  ALTER TABLE public.agent_flags VALIDATE CONSTRAINT agent_flags_kind_allowed;

  ALTER TABLE public.agent_flags DROP CONSTRAINT IF EXISTS agent_flags_status_allowed;
  ALTER TABLE public.agent_flags
      ADD CONSTRAINT agent_flags_status_allowed
          CHECK (status IN ('open', 'acked', 'resolved', 'dismissed')) NOT VALID;
  ALTER TABLE public.agent_flags VALIDATE CONSTRAINT agent_flags_status_allowed;

  ALTER TABLE public.agent_flags DROP CONSTRAINT IF EXISTS agent_flags_severity_allowed;
  ALTER TABLE public.agent_flags
      ADD CONSTRAINT agent_flags_severity_allowed
          CHECK (severity IN ('info', 'warning', 'critical')) NOT VALID;
  ALTER TABLE public.agent_flags VALIDATE CONSTRAINT agent_flags_severity_allowed;

  ALTER TABLE public.agent_flags DROP CONSTRAINT IF EXISTS agent_flags_detected_by_allowed;
  ALTER TABLE public.agent_flags
      ADD CONSTRAINT agent_flags_detected_by_allowed
          CHECK (detected_by IN ('heuristic', 'gemini')) NOT VALID;
  ALTER TABLE public.agent_flags VALIDATE CONSTRAINT agent_flags_detected_by_allowed;

  CREATE INDEX IF NOT EXISTS agent_flags_status_idx
      ON public.agent_flags (status);
  CREATE INDEX IF NOT EXISTS agent_flags_created_at_idx
      ON public.agent_flags (created_at DESC);
  CREATE INDEX IF NOT EXISTS agent_flags_patient_id_idx
      ON public.agent_flags (patient_id);
  -- Partial unique on (fingerprint) WHERE status='open' so re-detecting the
  -- same thing while it's still open does NOT duplicate the row. Once
  -- acked / resolved / dismissed it can be re-flagged.
  CREATE UNIQUE INDEX IF NOT EXISTS agent_flags_open_fingerprint_uniq
      ON public.agent_flags (fingerprint)
      WHERE status = 'open' AND fingerprint IS NOT NULL;
  ```
- **MIRROR**: MIGRATION_SHAPE pattern.
- **IMPORTS**: N/A.
- **GOTCHA**: The partial unique index on `(fingerprint) WHERE status='open'` is the dedup mechanism. Detection MUST set the same fingerprint each run for the same condition (e.g. `f"missed_streak:patient={pid}"`). Without it, every scheduler tick would re-insert the same flag.
- **VALIDATE**: Apply via `mcp__supabase__apply_migration` with name `0006_agent_flags`. Then `mcp__supabase__list_tables` should show `agent_flags`.

### Task 2: services/flag_detector.py
- **ACTION**: Detection module. Hybrid: heuristics + Gemini soft pass.
- **IMPLEMENT**: New file `backend/services/flag_detector.py`. Public API:
  ```python
  async def detect_and_persist_flags() -> dict:
      """Run all detectors, INSERT new flags (open-status fingerprint dedup
      by the unique index — IntegrityError on dup means already-open, ignore).
      Returns {"new_flags": int, "checked_at_iso": str, "by_kind": {...}}.
      """
  ```
  Internals (synchronous functions called via `asyncio.to_thread`):
  - `_detect_missed_streaks(threshold: int) -> list[dict]` — scan adherence_logs in last 24 h, count consecutive `pill_taken=False` per patient, flag if >= threshold.
  - `_detect_low_confidence_intake(threshold: float) -> list[dict]` — scan today's logs, flag where `confidence_score < threshold` AND `pill_taken=true` (system thinks it succeeded but isn't sure).
  - `_detect_trending_empty() -> list[dict]` — meds with quantity in (low_stock_threshold+1, low_stock_threshold+3) where dispenses-today >= remaining (so likely empty within 24 h). Severity=info; the existing alerts pipeline handles hard-low_stock.
  - `_detect_via_gemini(payload: dict, existing_open_kinds: set[str]) -> list[dict]` — single Gemini call with the same prefetch payload `generate_brief` builds, asking for "notable patterns NOT covered by the heuristics above". Output a strict JSON array. Skip if `gemini_api_key` empty OR `agent_flag_gemini_enabled` is False. Cap at 3 flags per call. Severity always `info` for Gemini-only flags.

  Each candidate dict shape:
  ```python
  {
      "kind": str,                  # one of FLAG_KIND_*
      "severity": str,              # info | warning | critical
      "title": str,                 # short, human-readable
      "detail": str | None,
      "patient_id": int | None,
      "dispenser_id": str | None,
      "slot": int | None,
      "fingerprint": str,           # stable id for dedup
      "payload": dict,
      "detected_by": "heuristic" | "gemini",
  }
  ```
  Insert via `sb.table("agent_flags").insert(row).execute()`. Wrap in
  `try / except` — if Supabase raises a unique-constraint violation (open dup)
  treat as "already flagged, skip". Log `flag dedup'd kind=... fingerprint=...`.
- **MIRROR**: SERVICE_PATTERN from `services/agent.py`. Imports + lazy genai pattern from there.
- **IMPORTS**:
  ```python
  import asyncio, json, logging
  from datetime import datetime, timedelta, timezone
  from config import settings
  from db.base import get_supabase
  from services import agent_tools  # for prefetch helpers
  ```
- **GOTCHA**:
  1. Gemini may emit invalid JSON. Wrap with `json.loads` + a tolerant fallback that extracts the first `[...]` block. If still invalid, log + skip.
  2. The unique index swallows duplicates **only when fingerprint is non-null and status='open'**. Always set a fingerprint.
  3. Postgres unique violations come back through supabase-py as a generic exception; check `"23505"` in `str(exc)` rather than catching a specific class.
  4. Heuristics MUST run first and Gemini MUST only see what's already flagged so it doesn't re-emit duplicates. Pass `existing_open_kinds: set[str]` into `_detect_via_gemini`.
- **VALIDATE**:
  ```bash
  cd backend && source .venv/bin/activate && python -c "
  from services.flag_detector import detect_and_persist_flags
  print('module ok')"
  ```

### Task 3: api/flags.py
- **ACTION**: Four endpoints under `/api/agent/flags`.
- **IMPLEMENT**: New file `backend/api/flags.py`:
  ```python
  router = APIRouter(dependencies=[Depends(verify_device_api_key)])

  @router.get("/")
  async def list_flags(
      status: str | None = Query(default="open"),  # default to open!
      limit: int = Query(default=50, ge=1, le=200),
  ):
      sb = get_supabase()
      q = sb.table("agent_flags").select("*").order("created_at", desc=True).limit(limit)
      if status: q = q.eq("status", status)
      result = await asyncio.to_thread(lambda: q.execute())
      return result.data or []

  class ResolveBody(BaseModel):
      note: str | None = Field(default=None, max_length=500)
      resolved_by: str | None = Field(default=None, max_length=80)

  @router.post("/{flag_id}/ack")
  async def ack_flag(flag_id: int):
      # status -> 'acked', acked_at = now()
      ...

  @router.post("/{flag_id}/resolve")
  async def resolve_flag(flag_id: int, body: ResolveBody):
      # status -> 'resolved', resolved_at = now(), resolved_by_user = body.resolved_by,
      # resolution_note = body.note. Return updated row.
      ...

  @router.post("/{flag_id}/dismiss")
  async def dismiss_flag(flag_id: int, body: ResolveBody):
      # status -> 'dismissed' (false-positive). resolution_note still recorded.
      ...
  ```
  Each transition reads the existing row first; if not found 404; if already in a terminal state (resolved/dismissed) raise 409. Use `asyncio.to_thread` for every Supabase call.
- **MIRROR**: ERROR_HANDLING + the existing `api/agent.py` router shape.
- **IMPORTS**:
  ```python
  import asyncio, logging
  from datetime import datetime, timezone
  from fastapi import APIRouter, Depends, HTTPException, Query
  from pydantic import BaseModel, Field
  from core.security import verify_device_api_key
  from db.base import get_supabase
  ```
- **GOTCHA**: supabase-py's `.update().eq("id", ...)` returns `data=[]` when no row matched. Always check `len(result.data) == 0` and raise 404.
- **VALIDATE**: `python -m py_compile api/flags.py`.

### Task 4: Wire flags router in main.py
- **ACTION**: Mount the router.
- **IMPLEMENT**: In `backend/main.py`:
  ```python
  from api import agent, alerts, auth, device, flags, inventory, logs
  ...
  app.include_router(flags.router, prefix="/api/agent/flags", tags=["agent-flags"])
  ```
  Place the import alphabetically; add the include_router line right after `agent.router`.
- **MIRROR**: existing include_router block at `main.py:110-115`.
- **IMPORTS**: see above.
- **GOTCHA**: Keep imports alphabetical — review-friendly + matches the existing block.
- **VALIDATE**: `python -c "from main import app"` (with venv) lists `/api/agent/flags` routes.

### Task 5: Extend agent_tools.py with query_flags
- **ACTION**: Append a new read-only tool to the Gemini registry.
- **IMPLEMENT**: In `backend/services/agent_tools.py`:
  ```python
  class QueryFlagsArgs(BaseModel):
      model_config = {"extra": "forbid"}
      status: str | None = Field(default="open", description="open | acked | resolved | dismissed")
      kind: str | None = Field(default=None, description="missed_streak | low_confidence | trending_empty | notable_pattern")
      patient_id: int | None = Field(default=None)
      limit: int = Field(default=20, ge=1, le=200)

  def query_flags(**kwargs):
      args = QueryFlagsArgs(**kwargs)
      sb = get_supabase()
      q = sb.table("agent_flags").select("*").order("created_at", desc=True).limit(args.limit)
      if args.status:     q = q.eq("status", args.status)
      if args.kind:       q = q.eq("kind", args.kind)
      if args.patient_id: q = q.eq("patient_id", args.patient_id)
      return q.execute().data or []

  TOOLS.append(ToolDef(
      name="query_flags",
      description=(
          "List agent-detected flags (proactive anomalies). Default returns "
          "open flags. Use this when the clinician asks 'what needs my "
          "attention' — start here BEFORE today_summary."
      ),
      args_schema=QueryFlagsArgs,
      fn=query_flags,
  ))
  ```
  Update the system prompt block in `services/agent.py:_SYSTEM_PROMPT_CHAT` to mention `query_flags` first in the tool list.
- **MIRROR**: TOOL_REGISTRATION pattern from `services/agent_tools.py:231-282`.
- **IMPORTS**: already in file.
- **GOTCHA**: `_BY_NAME` dict is built from `TOOLS` at module load. Append the ToolDef BEFORE `_BY_NAME = {t.name: t for t in TOOLS}`. If you append after, dispatch will not find `query_flags`.
- **VALIDATE**: `python -c "from services.agent_tools import build_gemini_tools; print(len(build_gemini_tools()[0]['function_declarations']))"` → 6 (was 5).

### Task 6: Brief cites open flags
- **ACTION**: Inject open-flag count + first 5 titles into the brief payload.
- **IMPLEMENT**: In `backend/services/agent.py:generate_brief`, before building `payload`:
  ```python
  open_flags = await asyncio.to_thread(
      agent_tools.query_flags, status="open", limit=10,
  )
  payload["open_flags"] = open_flags  # first 10
  payload["open_flags_count"] = len(open_flags)
  ```
  Update `_SYSTEM_PROMPT_BRIEF` to add a section requirement:
  ```
  - Add a "## Open flags" section listing the open_flags by title (no IDs).
    If the list is empty write "(none)".
  ```
- **MIRROR**: Existing prefetch block at `services/agent.py:308-327`.
- **IMPORTS**: none new.
- **GOTCHA**: Don't pass the entire flag payload jsonb (could be large); slice payload-light versions when serialising.
- **VALIDATE**: After Task 7 wires detection, manual run of `generate_brief` with at least one flag inserted should produce markdown containing `## Open flags`.

### Task 7: Scheduler runs detection before brief
- **ACTION**: Hook detection into the existing scheduler loop.
- **IMPLEMENT**: In `backend/scheduler/brief_scheduler.py`, replace the body of the `try:` after `await asyncio.sleep(wait_s)`:
  ```python
  log.info("scheduler: running flag detection")
  detect_summary = await detect_and_persist_flags()
  log.info(
      "scheduler: detection done — new=%d by_kind=%s",
      detect_summary["new_flags"],
      detect_summary["by_kind"],
  )

  log.info("scheduler: generating shift_handover brief")
  brief = await generate_brief(kind="shift_handover")
  ...
  ```
  Add `from services.flag_detector import detect_and_persist_flags` at top.
- **MIRROR**: SCHEDULER_LOOP pattern.
- **IMPORTS**: see above.
- **GOTCHA**: Detection is sequential before the brief — if detection raises, the brief still benefits from the broad `except Exception:` retry. Don't try-except *inside* the loop body around detection alone, because then a Gemini outage during detection would silently skip brief generation too. Let it fail loud and the outer retry handles it.
- **VALIDATE**: `python -c "from scheduler.brief_scheduler import brief_scheduler_loop; print('imports ok')"`

### Task 8: Settings + .env.example
- **ACTION**: Add tunables for the heuristic detectors.
- **IMPLEMENT**: In `backend/config.py`, in the agent settings block:
  ```python
  # ── Flag detection thresholds ──────────────────────────────────────────
  agent_flag_missed_streak_threshold: int = 3
  agent_flag_low_confidence_threshold: float = 0.55
  agent_flag_gemini_enabled: bool = True   # turn off the Gemini soft pass without unsetting GEMINI_API_KEY
  ```
  In `backend/.env.example`, append in the agent section:
  ```
  # Detector thresholds (a missed-dose streak <= this many in 24 h does NOT flag).
  AGENT_FLAG_MISSED_STREAK_THRESHOLD=3
  # Confidence below which a successful intake gets a low-confidence flag.
  AGENT_FLAG_LOW_CONFIDENCE_THRESHOLD=0.55
  # Set 0/false to skip the Gemini soft-pattern pass even when GEMINI_API_KEY is set.
  AGENT_FLAG_GEMINI_ENABLED=1
  ```
- **MIRROR**: existing agent section in `.env.example` and `config.py`.
- **IMPORTS**: N/A.
- **GOTCHA**: `pydantic-settings` parses bool-from-string ("0", "false", "no" → False). Don't wrap in custom logic.
- **VALIDATE**: `python -c "from config import settings; print(settings.agent_flag_missed_streak_threshold, settings.agent_flag_gemini_enabled)"` → `3 True`.

### Task 9: lib/agent.ts — flag types + helpers
- **ACTION**: Extend the existing client; do NOT create a new file.
- **IMPLEMENT**: Append to `frontend/src/lib/agent.ts`:
  ```ts
  export type AgentFlagStatus = "open" | "acked" | "resolved" | "dismissed";
  export type AgentFlagKind =
    | "missed_streak"
    | "low_confidence"
    | "trending_empty"
    | "notable_pattern";

  export type AgentFlag = {
    id: number;
    kind: AgentFlagKind;
    severity: "info" | "warning" | "critical";
    status: AgentFlagStatus;
    title: string;
    detail: string | null;
    patient_id: number | null;
    dispenser_id: string | null;
    slot: number | null;
    payload: Record<string, unknown>;
    detected_by: "heuristic" | "gemini";
    created_at: string;
    acked_at: string | null;
    resolved_at: string | null;
    resolved_by_user: string | null;
    resolution_note: string | null;
  };

  export async function fetchOpenFlags(limit = 25): Promise<AgentFlag[]> {
    if (!isAgentConfigured()) return [];
    try {
      const r = await fetch(
        `${baseUrl}/api/agent/flags/?status=open&limit=${limit}`,
        { headers: authHeaders(), cache: "no-store" },
      );
      if (!r.ok) return [];
      return (await r.json()) as AgentFlag[];
    } catch { return []; }
  }

  export async function ackFlag(id: number): Promise<AgentFlag> { ... }
  export async function resolveFlag(id: number, note: string, resolvedBy?: string): Promise<AgentFlag> { ... }
  export async function dismissFlag(id: number, note: string, resolvedBy?: string): Promise<AgentFlag> { ... }
  ```
  Make `isAgentConfigured` exported (it's currently private — change to `export function`).
- **MIRROR**: existing fetch shape in `lib/agent.ts`.
- **IMPORTS**: same as the file already has.
- **GOTCHA**: `isAgentConfigured` is currently `function` (no export). Other call sites would break if you rename — only add `export`. The new helpers should NOT throw on missing config; return [] / a synthesised error string just like the existing `fetchLatestBrief`.
- **VALIDATE**: `cd frontend && npx tsc --noEmit`.

### Task 10: components/FlagsPanel.tsx
- **ACTION**: Dashboard component — list open flags, ack + resolve UX.
- **IMPLEMENT**: New file. Mirror `AlertsPanel` exactly:
  - Container: `rounded-2xl border border-sand-200 bg-white p-6`.
  - Header: same pattern as AlertsPanel (icon + "Flags" + count chip).
  - Each row: severity dot (`severityDot()` from AlertsPanel can be reused — duplicate the helper inline; per CLAUDE.md "three similar lines is better than premature abstraction").
  - Two action buttons per row: `Ack` (primary, calls `ackFlag`) and `Resolve…` (opens an inline expand with a textarea + Resolve button + Dismiss button).
  - Empty state: "No flags right now" + "Detection runs at the brief schedule".
  - State: `useState<AgentFlag[]>` + optimistic remove on ack/resolve/dismiss.
- **MIRROR**: COMPONENT_STRUCTURE pattern; copy AlertsPanel and adapt.
- **IMPORTS**:
  ```tsx
  import { useEffect, useState } from "react";
  import { fetchOpenFlags, ackFlag, resolveFlag, dismissFlag, type AgentFlag } from "@/lib/agent";
  ```
- **GOTCHA**:
  1. `Resolve…` opens INLINE not a modal — keeps the dashboard density right and the existing app has no modal primitive.
  2. After resolve/dismiss, optimistically drop the row from local state. If the API call rejects, refetch.
  3. `Ack` keeps the row visible but moves to bottom and styles muted, OR drops it. Spec the simpler path: drop on ack — clinicians retrieve via "Resolve" status filter if needed (not in v1 UI).
- **VALIDATE**: `npx tsc --noEmit` clean.

### Task 11: Wire FlagsPanel into dashboard
- **ACTION**: Mount above AlertsPanel in the right column.
- **IMPLEMENT**: In `frontend/src/app/page.tsx`:
  ```tsx
  import FlagsPanel from "@/components/FlagsPanel";
  ...
  {/* Right column: Brief + Flags + Alerts + ... */}
  <div className="space-y-6">
    <div className="animate-slide-in-right stagger-2"><BriefCard /></div>
    <div className="animate-slide-in-right stagger-3"><FlagsPanel /></div>
    <div className="animate-slide-in-right stagger-4"><AlertsPanel /></div>
    ...
  </div>
  ```
  Bump downstream stagger numbers by 1.
- **MIRROR**: existing right-column shape in `app/page.tsx:113-123`.
- **IMPORTS**: add the FlagsPanel import alphabetically.
- **GOTCHA**: nothing — straightforward render insertion.
- **VALIDATE**: `npx tsc --noEmit` + visual inspection in dev server.

### Task 12: Apply migration via Supabase MCP + smoke
- **ACTION**: Apply 0006 to the live Supabase project.
- **IMPLEMENT**: Use `mcp__supabase__apply_migration` with name=`0006_agent_flags` and the contents of `backend/migrations/0006_agent_flags.sql`. Then `mcp__supabase__list_tables` to confirm.
- **MIRROR**: same flow as 0005 (already applied successfully).
- **IMPORTS**: N/A.
- **GOTCHA**: MCP `apply_migration` runs DDL on the remote project directly — verify the SQL compiles locally first. There's no rollback; the migration must be idempotent (it is).
- **VALIDATE**: `mcp__supabase__list_tables` shows `agent_flags`. `mcp__supabase__execute_sql` with `SELECT count(*) FROM public.agent_flags` returns 0.

---

## Testing Strategy

### Unit Tests
No framework configured — substitute targeted import + invocation smoke.

| Test | Input | Expected | Edge Case? |
|---|---|---|---|
| `flag_detector` import | — | module loads | — |
| `query_flags` tool dispatch | `{"status":"open"}` | list | — |
| Migration idempotency | apply twice | no error | yes |
| Endpoint auth | request without X-Device-API-Key | 401 | yes |
| List w/ no rows | `GET /api/agent/flags/` | `[]` | yes |
| Resolve missing flag | `POST /api/agent/flags/9999/resolve` | 404 | yes |
| Resolve already-resolved | second call | 409 | yes |
| Dedup test | insert two open rows w/ same fingerprint | second errors w/ `23505` | yes |

### Edge Cases Checklist
- [ ] No flags exist → dashboard shows empty state
- [ ] Detection runs while a flag with same fingerprint already open → unique-index dedup, log says "skip"
- [ ] Gemini returns malformed JSON → log + skip, heuristic flags still inserted
- [ ] `GEMINI_API_KEY` unset → only heuristic detectors run, brief still cites them
- [ ] `AGENT_FLAG_GEMINI_ENABLED=0` → Gemini soft pass skipped even when key is set
- [ ] Resolve with empty note → accepted, `resolution_note=null`
- [ ] Resolve note >500 chars → 422 (Pydantic max_length)
- [ ] Concurrent ack of the same flag → second one returns the existing acked row, no error (idempotent)

---

## Validation Commands

### Static Analysis
```bash
# Backend
cd backend && source .venv/bin/activate && python -m py_compile \
    api/flags.py services/flag_detector.py services/agent_tools.py \
    services/agent.py scheduler/brief_scheduler.py main.py config.py

# Frontend
cd frontend && npx tsc --noEmit
```
EXPECT: Zero errors both sides.

### Module Smoke
```bash
cd backend && source .venv/bin/activate && \
SUPABASE_URL=https://stub.supabase.co SUPABASE_KEY=stub python -c "
from services.flag_detector import detect_and_persist_flags
from services.agent_tools import build_gemini_tools, _BY_NAME
print('tools:', sorted(_BY_NAME.keys()))
assert 'query_flags' in _BY_NAME
print('decls:', len(build_gemini_tools()[0]['function_declarations']))
from api import flags as flags_api
print('routes:', [(sorted(r.methods), r.path) for r in flags_api.router.routes if hasattr(r,'path')])
"
```
EXPECT: `query_flags` in tools, decls=6, four routes printed.

### Database Validation
```bash
# Via MCP after migration:
mcp__supabase__list_tables  # agent_flags present
mcp__supabase__execute_sql  # SELECT * FROM agent_flags LIMIT 1 → empty result, no error
```

### End-to-End on Pi
```bash
# Insert a manual flag for UI testing
mcp__supabase__execute_sql "
INSERT INTO public.agent_flags (kind, severity, status, title, detail, fingerprint, payload)
VALUES ('missed_streak','warning','open','Patient Aaron — 3 missed doses (24h)',
        'Slots 1,3,4 missed since 06:00','missed_streak:patient=1','{}'::jsonb);"

# Then on dashboard:
#  1. Flags panel shows the row
#  2. Click [Resolve…], type note, click Resolve → row disappears
#  3. mcp__supabase__execute_sql confirms status='resolved', resolution_note populated
```

### Manual Validation Checklist
- [ ] Migration applied; `agent_flags` table visible
- [ ] `python -c "from main import app"` (Pi-side venv) lists 4 new routes under `/api/agent/flags`
- [ ] At next configured local hour, scheduler logs "running flag detection" then "generating shift_handover brief"
- [ ] Brief markdown contains "## Open flags" when at least one is open
- [ ] Dashboard FlagsPanel renders, ack & resolve work, optimistic removal smooth
- [ ] Ask the agent "what needs my attention?" — responses cite real flag rows (not invented)

---

## Acceptance Criteria
- [ ] Migration 0006 applied and idempotent
- [ ] Detection runs at brief schedule and dedups via fingerprint unique index
- [ ] Heuristic + Gemini-soft-pass coexist; Gemini disable flag honored
- [ ] Endpoints: list (default open), ack, resolve, dismiss — all behind X-Device-API-Key
- [ ] Agent chat exposes `query_flags`, system prompt mentions it first
- [ ] Brief cites open flags in a "## Open flags" section
- [ ] Dashboard FlagsPanel + Brief integration work end-to-end on staging

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style
- [ ] Logging follows codebase conventions
- [ ] No hardcoded values (thresholds via settings)
- [ ] No tests claimed (none configured)
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gemini returns garbage JSON repeatedly, fills logs | Medium | Low | Tolerant parser + 60 s outer backoff already exists |
| Heuristic false positives flood the panel | Medium | Medium | Configurable thresholds; clinicians can dismiss |
| Fingerprint collisions across kinds | Low | Medium | Always prefix with kind: `f"{kind}:..."` |
| Migration fails on staging | Low | High | Idempotent; verify in MCP first |
| Latency creep — detection + brief now serial | Low | Low | Both already sub-10 s on prior runs; budget is 60 s timeout |
| PHI exposure widened | Low | Medium | Same Gemini surface as briefs; documented in `.env.example` |

## Notes
- Detection identity is `detected_by='heuristic'|'gemini'` — useful for analytics later (e.g., "what % of resolved flags came from Gemini?").
- `resolved_by_user` is free text because we don't have authenticated users yet. When auth lands, change the column to `uuid` referencing `auth.users(id)` and migrate.
- Timestamp columns use `timestamptz` per the rest of the schema. All inserts use `now()` server-side; clients never send `created_at`.
- The partial unique index on `(fingerprint) WHERE status='open'` is the entire dedup story. Test it after migration with two manual inserts of the same fingerprint — second should fail with `23505`.
