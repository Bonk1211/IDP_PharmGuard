# Plan: Agentic Clinician Assistant — Conversational + Daily Brief

## Summary
Add a Gemini-powered conversational assistant that nurses/pharmacists can ask anything about today's PharmGuard activity ("which patients missed evening doses?", "what expires this week?"). Pair it with auto-generated shift-handover briefs (07:00 + 19:00) persisted to a new `agent_briefs` Supabase table, surfaced as the freshest card on the dashboard home.

## User Story
As a **ward nurse / pharmacist**, I want **to ask the dashboard plain-English questions about today's adherence, alerts, and inventory — and have a fresh brief waiting at every shift change**, so that **I spend less time clicking through tables and more time on patients**.

## Problem → Solution
**Current state**: Dashboard exposes raw tables — adherence logs, alerts, inventory. The clinician has to manually scan, cross-reference, and remember. No way to ask "what's different today?" except by eyeballing rows.

**Desired state**: A chat box on the dashboard answers ad-hoc questions by querying Supabase via Gemini function-calling. A pre-generated brief sits at the top of the home page, refreshed automatically twice a day.

## Metadata
- **Complexity**: **Large** (~11 files, ~700 lines, new Supabase table, new external integration depth, scheduled task)
- **Source PRD**: N/A — operator-driven feature.
- **PRD Phase**: N/A
- **Estimated Files**: 11 (4 new backend, 1 migration, 5 new frontend, 1 home-page edit)
- **Locked decisions** (from clarifying Q&A):
  1. **Conversational chat** — Q&A interface (not just static report)
  2. **Read-only** — no DB writes from the agent
  3. **Gemini API, full PHI** — no anonymization (operator accepted)
  4. **Both scheduled + on-demand** — auto at shift change + manual chat

---

## UX Design

### Before
```
Dashboard home
┌─────────────────────────────────────────────────────────┐
│ Patients table (rows)                                   │
│ Inventory table (rows)                                  │
│ Adherence log (rows)                                    │
│ Alerts panel (rows)                                     │
└─────────────────────────────────────────────────────────┘
```

### After
```
Dashboard home
┌─────────────────────────────────────────────────────────┐
│ ┌─ Today's brief ─────────────────────────  [Refresh] ┐ │
│ │ Updated 19:01 · 2 missed doses · 3 alerts          │ │
│ │ - John Doe missed 18:00 dose (slot 3, conf 0.42)   │ │
│ │ - Slot 7 (Metformin) low stock: 2 left             │ │
│ │ - 2 medications expire in <14 days...              │ │
│ │                                       [Open agent] │ │
│ └────────────────────────────────────────────────────┘ │
│                                                         │
│ Patients table ...                                      │
└─────────────────────────────────────────────────────────┘

/agent page
┌─────────────────────────────────────────────────────────┐
│ Conversations                                           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ You: Which patients missed evening doses this week? │ │
│ │ Assistant: 2 patients had missed evening doses:    │ │
│ │   • John Doe — 3 misses (Mon, Wed, Fri)            │ │
│ │   • Jane Smith — 1 miss (Tue)                      │ │
│ │   Both have status="At Risk" already flagged.      │ │
│ │ ─ used tools: query_adherence, list_patients       │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────── ────────────[ Send → ]─┐ │
│ │ Ask anything about today's activity...             │ │
│ └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Dashboard home | Raw tables only | Brief card at top | Brief = pre-generated markdown; clinician reads, doesn't click |
| Cross-reference questions | Manual table scan | `/agent` chat | Plain-English questions; agent function-calls into Supabase |
| Shift handover | Verbal / paper | `agent_briefs` table | Persistent; previous shifts visible |
| Privacy posture | PHI stays in Supabase | PHI sent to Google Gemini | Acceptance documented in `.env.example` + README |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `backend/services/gemini_fallback.py` | 1-40 | Sole existing Gemini integration. Mirrors lazy-import + `genai.configure(api_key=settings.gemini_api_key)` + model name pattern. Bump model to `gemini-2.0-flash` for function-calling reliability. |
| **P0** | `backend/api/inventory.py` | 1-103 | Canonical APIRouter shape: `Depends(verify_device_token)` (or new agent-side auth), Pydantic body model, `get_supabase()` query. |
| **P0** | `backend/api/device.py` | 1-100 | Router-level `Depends(verify_device_api_key)` (frontend-readable shared secret) is the auth pattern the agent endpoint should mirror — same caller (browser through ngrok). |
| **P0** | `backend/db/base.py` | 1-15 | `get_supabase()` singleton — the only entry point for Supabase reads. |
| **P0** | `backend/main.py` | 30-60 | `lifespan` with `HardwareLoop`. The brief-scheduler task spawns alongside HardwareLoop in the same lifespan, NOT inside it. |
| **P0** | `backend/scheduler/background.py` | 1-110 | HardwareLoop is the architectural sibling. Brief scheduler imitates the supervisor + cancel-on-stop pattern but for a periodic timer. |
| **P1** | `backend/api/alerts.py` | 1-100 | `_insert_alert` + WS broadcast pattern. The brief scheduler's "publish to dashboard" mechanism is similar but optional (we use polling, not WS). |
| **P1** | `backend/migrations/0001_phase1_schema_hardening.sql` | full | Migration shape + `text` / `timestamptz` / index conventions for the new `agent_briefs` table. |
| **P1** | `frontend/src/lib/api.ts` | 1-80 | Frontend Supabase patterns. Reads use `supabase.from(...).select(...)`. |
| **P1** | `frontend/src/lib/device.ts` | 1-50 | `fetchDeviceStatus` shape — JSON fetch with `X-Device-API-Key` header + `?key=...` query fallback. The agent endpoints mirror this. |
| **P2** | `frontend/src/components/AlertsPanel.tsx` | 1-60 | Reference for a card-on-home component that consumes Supabase rows and renders compact UI. |
| **P2** | `backend/services/face_recognition.py` | 17-30 | Lazy-heavy-import idiom — same trick the agent service uses for `google-generativeai`. |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Gemini function calling | `https://ai.google.dev/gemini-api/docs/function-calling` | Pass `tools=[Tool(function_declarations=[...])]` to `GenerativeModel`; loop on `response.candidates[0].content.parts[0].function_call`; respond with `Part.from_function_response(...)` then re-send. |
| Gemini streaming | `https://ai.google.dev/gemini-api/docs/text-generation#streaming` | Optional for chat UX. Use `stream=True` + iterate `response`. Defer to v2 — single-shot first. |
| `google-generativeai` Python pkg | `pip install google-generativeai>=0.8.0` | Already in `backend/requirements.txt`. |
| Pydantic JSON-mode for tool args | (Gemini structured output) | Validate `function_call.args` against Pydantic before passing to tool. Defends against LLM hallucinating fields. |

KEY_INSIGHT: Gemini function-calling rejects parameters with `additionalProperties=true`. Pydantic's `model_json_schema()` adds it by default — strip with `BaseModel.model_config = {"extra": "forbid"}` then post-process.
APPLIES_TO: `backend/services/agent.py` tool schema build.
GOTCHA: `gemini-1.5-flash` (the version in `gemini_fallback.py`) supports function calling but `gemini-2.0-flash` is more reliable. Pin to `2.0-flash` in the agent service; leave `1.5-flash` in `gemini_fallback.py` for pill-ID compatibility.

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: backend/api/inventory.py:1-30  (existing convention)
"""Inventory endpoints — manage the 10-slot magazine per dispenser."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.security import verify_device_token  # OR verify_device_api_key
from db.base import get_supabase

router = APIRouter()

class SlotUpdate(BaseModel):
    medication_name: str
    ...

@router.get("/", dependencies=[Depends(verify_device_token)])
async def list_slots():
    sb = get_supabase()
    result = sb.table("medications").select("*").execute()
    return result.data
```

### SERVICE_PATTERN (lazy heavy import)
```python
# SOURCE: backend/services/face_recognition.py:17-30
def compute_embedding(image_bytes: bytes) -> list[float] | None:
    try:
        import face_recognition  # heavy; lazy
        import numpy as np
    except ImportError:
        log.exception("face_recognition import failed")
        return None
    ...
```

The agent service imports `google.generativeai` lazily on first chat/brief call.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/main.py (project-wide)
log = logging.getLogger(__name__)
log.info("brief generated (%d tools called, %d ms)", n_tools, elapsed_ms)
log.warning("agent: tool %s returned no rows", tool_name)
log.exception("agent: Gemini call failed")
```

### AUTH_DEPENDENCY (frontend caller)
```python
# SOURCE: backend/core/security.py:53-78
async def verify_device_api_key(
    x_device_api_key: str | None = Header(default=None),
    key: str | None = Query(default=None),
) -> None:
    expected = settings.device_api_key
    if not expected:
        raise HTTPException(status_code=503, detail="Device API key not configured")
    candidate = x_device_api_key or key
    if not candidate or not hmac.compare_digest(candidate, expected):
        raise HTTPException(status_code=401, detail="Invalid device API key")
```

The agent router uses the SAME `verify_device_api_key` because the caller is the same — frontend through ngrok.

### SUPABASE_QUERY (read pattern)
```python
# SOURCE: backend/api/inventory.py:39-48
sb = get_supabase()
query = (
    sb.table("medications")
    .select("*")
    .gt("quantity", 0)
    .not_.is_("patient_id", "null")
)
if dispenser_id is not None:
    query = query.eq("dispenser_id", dispenser_id)
result = query.limit(1).execute()
```

### LIFESPAN_TASK (parallel asyncio task)
```python
# SOURCE: backend/main.py:30-55  +  backend/scheduler/background.py:37-55
@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.validate_runtime()
    if settings.backend_headless:
        yield
        return
    loop = HardwareLoop()
    await loop.start()
    app.state.hardware_loop = loop
    # NEW: spawn brief scheduler alongside (NOT inside) HardwareLoop
    brief_task = asyncio.create_task(brief_scheduler_loop(), name="brief_scheduler")
    app.state.brief_task = brief_task
    try:
        yield
    finally:
        brief_task.cancel()
        try:
            await brief_task
        except asyncio.CancelledError:
            pass
        await loop.stop()
```

### TWO_PHASE_PERIODIC (cron-without-cron)
```python
# SOURCE: backend/scheduler/background.py:90-115 (mirror the wait_for + sleep pattern)
async def brief_scheduler_loop():
    while True:
        try:
            await _sleep_until_next_target()  # 07:00 or 19:00 local
            await generate_brief(kind="shift_handover")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("brief scheduler crashed; restarting in 60s")
            await asyncio.sleep(60)
```

### MIGRATION_SHAPE
```sql
-- SOURCE: backend/migrations/0001_phase1_schema_hardening.sql:1-40 (mirror)
CREATE TABLE IF NOT EXISTS public.agent_briefs (
    id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    kind          text NOT NULL CHECK (kind IN ('shift_handover','on_demand')),
    content       text NOT NULL,
    metadata      jsonb,
    generated_at  timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_briefs_generated_at_idx
    ON public.agent_briefs (generated_at DESC);
```

### FRONTEND_FETCH (typed wrapper, header+query auth)
```ts
// SOURCE: frontend/src/lib/device.ts:47-58
export async function fetchDeviceStatus(): Promise<DeviceStatus | null> {
  if (!isDeviceConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/device/status`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as DeviceStatus;
  } catch { return null; }
}
```

The agent client mirrors this for `chatAgent`, `fetchLatestBrief`, etc.

---

## Files to Change

### Phase A — backend (CREATE)

| File | Action | Purpose |
|---|---|---|
| `backend/migrations/0005_agent_briefs.sql` | CREATE | New table; applied via `mcp__supabase__apply_migration` |
| `backend/services/agent.py` | CREATE | Gemini chat client, function-calling loop, brief generator |
| `backend/services/agent_tools.py` | CREATE | 5 read-only tools (Supabase queries) + JSON schemas |
| `backend/api/agent.py` | CREATE | Router: `POST /chat`, `POST /brief`, `GET /briefs/recent` |
| `backend/scheduler/brief_scheduler.py` | CREATE | Asyncio loop firing 07:00 + 19:00 local; persists brief |

### Phase B — backend (UPDATE)

| File | Action | Purpose |
|---|---|---|
| `backend/main.py` | UPDATE | Spawn `brief_scheduler` task in lifespan; include `agent` router |
| `backend/config.py` | UPDATE | Add `agent_model_name`, `agent_brief_local_hours` (e.g. `"7,19"`) |
| `backend/.env.example` | UPDATE | Document new keys + the **PHI-to-Gemini** privacy disclaimer |

### Phase C — frontend (CREATE)

| File | Action | Purpose |
|---|---|---|
| `frontend/src/lib/agent.ts` | CREATE | Typed client (`chatAgent`, `fetchLatestBrief`, types) |
| `frontend/src/components/BriefCard.tsx` | CREATE | Home-dashboard card showing latest brief markdown |
| `frontend/src/components/AgentChat.tsx` | CREATE | Chat UI (message list + input) |
| `frontend/src/app/agent/page.tsx` | CREATE | `/agent` route hosting the chat |

### Phase D — frontend (UPDATE)

| File | Action | Purpose |
|---|---|---|
| `frontend/src/app/page.tsx` | UPDATE | Mount `<BriefCard />` at the top of the home dashboard |

## NOT Building

- **Streaming chat responses** (`stream=True` from Gemini). v1 ships single-shot replies.
- **Agent-side write actions** (acknowledging alerts, sending messages). Read-only per locked decision.
- **Multi-turn memory across sessions** — chat history lives in browser state only; backend is stateless per request.
- **Anonymization layer** — operator opted out. Document in README that PHI travels to Gemini.
- **Rate limiting** — defer until we see real traffic. Gemini's own quota throttles abuse.
- **Brief scheduling at arbitrary times** — only the two configured hours (07/19 local) for v1.
- **WebSocket push for new briefs** — polling on home page is enough.
- **OpenAI / Anthropic providers** — Gemini only.
- **Tests for the LLM responses themselves** — non-deterministic; we test the tool-call wiring + endpoint shape, not the prose quality.

---

## Step-by-Step Tasks

### Task 1: Migration `0005_agent_briefs.sql`
- **ACTION**: Create + apply.
- **IMPLEMENT**:
  ```sql
  CREATE TABLE IF NOT EXISTS public.agent_briefs (
      id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      kind          text NOT NULL CHECK (kind IN ('shift_handover','on_demand')),
      content       text NOT NULL,
      metadata      jsonb,
      generated_at  timestamptz NOT NULL DEFAULT now(),
      created_at    timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS agent_briefs_generated_at_idx
      ON public.agent_briefs (generated_at DESC);
  ```
- **MIRROR**: `backend/migrations/0001_phase1_schema_hardening.sql:1-40`.
- **VALIDATE**: Apply via `mcp__supabase__apply_migration name="0005_agent_briefs"`. Then `mcp__supabase__list_tables schemas=["public"]` confirms `agent_briefs` is present.

### Task 2: `backend/services/agent_tools.py` (5 read-only tools)
- **ACTION**: Define each tool as `(name, description, parameter_schema, callable)`.
- **IMPLEMENT** — five tools:
  - `query_adherence(patient_id?, since_iso?, until_iso?, limit=50, only_missed=False)`
  - `query_alerts(kind?, severity?, since_iso?, limit=50)`
  - `query_medications(dispenser_id?, low_stock_only=False, expires_before_days?)`
  - `list_patients(status?, dispenser_id?)`
  - `today_summary()` — convenience: returns `{n_dispenses, n_pill_taken, n_missed, low_stock_count, expiring_soon_count}`
  - Each function: `def fn(**kwargs) -> list[dict] | dict` — pure read against `get_supabase()`.
  - Schemas declared as Pydantic models with `model_config = {"extra": "forbid"}` so Gemini's strict schema validation passes.
- **MIRROR**: `backend/api/inventory.py:39-48` for the Supabase query shape; `backend/api/alerts.py:84-97` for date-bounded queries.
- **IMPORTS**: `from db.base import get_supabase`, `from datetime import datetime, timezone`, `from pydantic import BaseModel`.
- **GOTCHA**: Gemini's `function_call.args` arrives as `dict-like proto` not JSON. Convert with `dict(args)` before validating.
- **VALIDATE**: `python -c "from services.agent_tools import TOOLS; print([t['name'] for t in TOOLS])"` returns the 5 names. Each tool must work standalone with `today_summary()` returning `{n_dispenses: int, ...}` against an empty DB.

### Task 3: `backend/services/agent.py` (chat + brief)
- **ACTION**: Module with two public callables:
  - `async def chat(messages: list[dict]) -> dict` — function-calling loop
  - `async def generate_brief(kind: str = "shift_handover") -> dict` — single-shot summary
- **IMPLEMENT**:
  - Lazy-import `google.generativeai` (P2 mirror).
  - `_get_model()` builds `GenerativeModel(settings.agent_model_name, tools=[...])` on first call; cache on module.
  - `chat()`: loop max 6 iterations; on each, send messages + tools, inspect response; if `function_call`, dispatch via `agent_tools.dispatch(name, args)`, append `Part.from_function_response(...)`, continue; if text, return `{text, tool_calls: [{name, args, result_summary}, ...]}`.
  - `generate_brief()`: pre-fetch `today_summary()` + `query_alerts(since=last_12h)` + `query_adherence(since=last_12h, only_missed=True)`, stuff into a markdown prompt, single LLM call (no tools), return `{kind, content_markdown, metadata}`.
  - Both record latency + token usage in `metadata`.
- **MIRROR**: `backend/services/gemini_fallback.py:14-39` for the lazy-import + configure pattern; `backend/scheduler/cycle_runner.py:_replay_drain` for the for-loop-with-broad-catch pattern.
- **IMPORTS**: `from config import settings`, `from services.agent_tools import TOOLS, dispatch, build_gemini_tools`, `import asyncio, logging, time`.
- **GOTCHA**: Gemini function-calling can loop forever if the LLM keeps calling tools. Cap at 6 hops; if exceeded, return last text or "I couldn't reach a confident answer".
- **VALIDATE**: `pytest tests/test_agent.py::test_chat_loop_terminates` (with mocked `_get_model` returning canned responses).

### Task 4: `backend/api/agent.py` (router)
- **ACTION**: Three endpoints under `/api/agent/*`, all behind `Depends(verify_device_api_key)`.
- **IMPLEMENT**:
  - `POST /api/agent/chat` body `{messages: [{role: "user"|"assistant"|"system", text: str}]}` → calls `agent.chat(messages)` → `{text: str, tool_calls: list}`. 60s timeout.
  - `POST /api/agent/brief` (admin / scheduler) → calls `agent.generate_brief()` → INSERT into `agent_briefs` → returns the row.
  - `GET /api/agent/briefs/recent?limit=5` → `select * from agent_briefs order by generated_at desc limit ?`.
- **MIRROR**: `backend/api/device.py` router structure; `backend/api/inventory.py:39-60` for Supabase query.
- **IMPORTS**: `from core.security import verify_device_api_key`, `from db.base import get_supabase`, `from services.agent import chat, generate_brief`.
- **GOTCHA**: Don't accept arbitrary `system` messages from the frontend — agent's system prompt is server-controlled. Drop or replace any `role=="system"` in the request.
- **VALIDATE**: `curl` smoke (with `BACKEND_HEADLESS=1` so cycle isn't required):
  ```bash
  curl -X POST -H "X-Device-API-Key: $K" -H "Content-Type: application/json" \
       -d '{"messages":[{"role":"user","text":"What happened today?"}]}' \
       http://localhost:8000/api/agent/chat
  ```
  Expect 200 with JSON `{text, tool_calls}`.

### Task 5: `backend/scheduler/brief_scheduler.py`
- **ACTION**: Asyncio loop firing at the configured hours.
- **IMPLEMENT**:
  ```python
  async def brief_scheduler_loop():
      while True:
          try:
              wait_s = _seconds_until_next_target_hour(settings.agent_brief_local_hours)
              await asyncio.sleep(wait_s)
              brief = await generate_brief(kind="shift_handover")
              # Persist to Supabase
              sb = get_supabase()
              await asyncio.to_thread(
                  lambda: sb.table("agent_briefs").insert({
                      "kind": "shift_handover",
                      "content": brief["content_markdown"],
                      "metadata": brief["metadata"],
                  }).execute()
              )
              log.info("Scheduled brief generated + stored")
          except asyncio.CancelledError:
              raise
          except Exception:
              log.exception("brief scheduler crashed; restarting in 60 s")
              await asyncio.sleep(60)
  ```
- **MIRROR**: `backend/scheduler/background.py:_supervised_loop` (broad-except + backoff).
- **IMPORTS**: `from config import settings`, `from services.agent import generate_brief`, `from db.base import get_supabase`, `import asyncio, logging, datetime`.
- **GOTCHA**: Server timezone matters. Pi may be UTC; operator wants local. Compute targets in `datetime.now().astimezone()` + parse `agent_brief_local_hours = "7,19"` (CSV).
- **VALIDATE**: Force a test run via the on-demand `POST /api/agent/brief` endpoint and confirm a row appears in `agent_briefs`.

### Task 6: `backend/main.py` — wire scheduler + router
- **ACTION**: Include the agent router; spawn `brief_scheduler_loop` in the lifespan.
- **IMPLEMENT**:
  ```python
  from api import agent  # add to existing import line
  ...
  app.include_router(agent.router, prefix="/api/agent", tags=["agent"])
  ...
  # in lifespan, alongside the HardwareLoop:
  from scheduler.brief_scheduler import brief_scheduler_loop
  brief_task = asyncio.create_task(brief_scheduler_loop(), name="brief_scheduler")
  app.state.brief_task = brief_task
  try:
      yield
  finally:
      brief_task.cancel()
      try:
          await brief_task
      except asyncio.CancelledError:
          pass
      ...
  ```
- **MIRROR**: existing lifespan structure in `backend/main.py:30-60`.
- **GOTCHA**: Don't put the brief scheduler INSIDE `HardwareLoop.start` — it has no hardware dependency and should run even when the cycle is idle / re-initialising.
- **VALIDATE**: `BACKEND_HEADLESS=1 uvicorn main:app` boots cleanly; logs show `brief_scheduler` task started.

### Task 7: `backend/config.py` — agent settings
- **ACTION**: Add 2 settings.
- **IMPLEMENT**:
  ```python
  agent_model_name: str = "gemini-2.0-flash"
  agent_brief_local_hours: str = "7,19"   # CSV of local hours (24h) when scheduler fires
  ```
- **MIRROR**: existing setting style in `backend/config.py:35-65`.
- **GOTCHA**: Keep `gemini-1.5-flash` in `gemini_fallback.py` (pill-ID); only the agent uses `2.0-flash`.
- **VALIDATE**: `python -c "from config import settings; print(settings.agent_model_name)"` returns `gemini-2.0-flash`.

### Task 8: `backend/.env.example` — disclosure
- **ACTION**: Document the agent config + the **PHI-to-Gemini** notice.
- **IMPLEMENT**:
  ```
  # ─── Clinician assistant (read-only Gemini agent) ───
  # Sends adherence/alerts/inventory queries to Gemini, INCLUDING patient
  # names + diagnoses. Operator has accepted this trade-off; document
  # the data flow in your site privacy notice. Disable by leaving
  # GEMINI_API_KEY blank — agent endpoints will return 503.
  AGENT_MODEL_NAME=gemini-2.0-flash
  # Local hours (24h, CSV) when shift-handover briefs auto-generate.
  AGENT_BRIEF_LOCAL_HOURS=7,19
  ```
- **GOTCHA**: This is a deliberate, documented PHI flow. Match the line in the README too.
- **VALIDATE**: After commit, `grep -i "agent\|gemini" backend/.env.example` shows the new section.

### Task 9: `frontend/src/lib/agent.ts` — typed client
- **ACTION**: Three functions + types.
- **IMPLEMENT**:
  ```ts
  export type ChatMessage = { role: "user" | "assistant"; text: string };
  export type ToolCall = { name: string; args: Record<string, unknown>; result_summary?: string };
  export type ChatResponse = { text: string; tool_calls: ToolCall[] };
  export type Brief = {
    id: number;
    kind: "shift_handover" | "on_demand";
    content: string;
    metadata: Record<string, unknown> | null;
    generated_at: string;
  };

  export async function chatAgent(messages: ChatMessage[]): Promise<ChatResponse | null> { ... }
  export async function fetchLatestBrief(): Promise<Brief | null> { ... }
  export async function refreshBrief(): Promise<Brief | null> { ... }   // POST /brief
  ```
- **MIRROR**: `frontend/src/lib/device.ts:47-72` for the fetch shape with header auth + null-on-error.
- **IMPORTS**: re-uses `baseUrl`, `apiKey`, `authHeaders` constants — extract them to a tiny shared helper if not already.
- **GOTCHA**: Send `messages` array as JSON body; do NOT include `system` role from the frontend.
- **VALIDATE**: `npx tsc --noEmit` — no type errors. Manual smoke against running backend.

### Task 10: `frontend/src/components/BriefCard.tsx`
- **ACTION**: Home-dashboard card showing the latest brief.
- **IMPLEMENT**:
  - Fetch latest brief on mount (`fetchLatestBrief`).
  - Render markdown content (use `react-markdown` if not already in deps; else simple `<pre>` rendering with line-break preservation).
  - "Refresh" button calls `refreshBrief` → updates display.
  - "Open agent →" Link to `/agent`.
  - Header: "Today's brief" + relative timestamp (e.g. "Updated 14 min ago").
- **MIRROR**: `frontend/src/components/AlertsPanel.tsx` for the card+rounded-2xl+border style.
- **IMPORTS**: `from "@/lib/agent"`; possibly `react-markdown` (add to `package.json` if missing).
- **GOTCHA**: If `agent_briefs` is empty, show "No brief yet — click Refresh" placeholder.
- **VALIDATE**: `npm run build` passes; manual: load home page after brief generation.

### Task 11: `frontend/src/components/AgentChat.tsx`
- **ACTION**: Chat UI.
- **IMPLEMENT**:
  - State: `messages: ChatMessage[]`, `pending: boolean`.
  - On submit: append user message, set `pending`, call `chatAgent(messages)`, append assistant response with `tool_calls` summary, clear `pending`.
  - Render messages as bubbles (user right, assistant left). Show `tool_calls` as a small grey "used: query_adherence, list_patients" footnote under each assistant turn.
  - Auto-scroll to bottom on new message.
- **MIRROR**: `frontend/src/components/AlertsPanel.tsx` style for cards; build new for the messaging interaction.
- **IMPORTS**: `useState`, `useEffect`, `useRef`, types from `@/lib/agent`.
- **GOTCHA**: Chat history lives in component state only — refresh = blank session. Document. (Persistent history is out of scope.)
- **VALIDATE**: tsc clean; manual smoke.

### Task 12: `frontend/src/app/agent/page.tsx`
- **ACTION**: Page wrapper hosting `<AgentChat />`.
- **IMPLEMENT**:
  ```tsx
  "use client";
  import AgentChat from "@/components/AgentChat";
  export default function AgentPage() {
    return (
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900 mb-4">
          Clinician assistant
        </h1>
        <p className="text-xs text-gray-500 mb-6">
          Read-only. Ask anything about today's adherence, alerts, or inventory.
          Patient data is sent to Gemini.
        </p>
        <AgentChat />
      </div>
    );
  }
  ```
- **MIRROR**: `frontend/src/app/dispensers/[id]/page.tsx` for the page-level structure.
- **VALIDATE**: navigate to `/agent` in dev — chat renders.

### Task 13: `frontend/src/app/page.tsx` — wire BriefCard
- **ACTION**: Mount `<BriefCard />` at the top of the home dashboard.
- **IMPLEMENT**: Add `import BriefCard from "@/components/BriefCard"`; render `<BriefCard />` above the existing tables/components.
- **MIRROR**: existing top-of-page structure on the home dashboard.
- **VALIDATE**: home page now shows the brief card; tsc passes.

---

## Testing Strategy

### Unit Tests

| Test file | Test | Input | Expected | Edge case? |
|---|---|---|---|---|
| `tests/test_agent_tools.py` | `test_today_summary_empty_db` | empty Supabase mock | counts all 0 | empty |
| `tests/test_agent_tools.py` | `test_query_adherence_filters_by_patient` | mock rows + patient_id=1 | only patient_id=1 rows | filter correctness |
| `tests/test_agent_tools.py` | `test_query_medications_low_stock_only` | mock with 5 rows, 2 below threshold | 2 returned | filter correctness |
| `tests/test_agent.py` | `test_chat_loop_terminates_at_text_response` | mocked Gemini returns text on hop 1 | response.text returned, no tools dispatched | happy path |
| `tests/test_agent.py` | `test_chat_loop_dispatches_tool_then_text` | mocked Gemini returns function_call hop 1, text hop 2 | tool dispatched, response includes tool_calls | function-calling |
| `tests/test_agent.py` | `test_chat_loop_caps_at_6_hops` | mocked Gemini always returns function_call | loop terminates with degraded message | runaway protection |
| `tests/test_agent.py` | `test_generate_brief_writes_markdown` | mocked Gemini returns text | brief dict has content_markdown | brief shape |
| `tests/test_agent_api.py` | `test_chat_strips_system_role` | request includes `role:"system"` | system message dropped before LLM call | injection-defense |
| `tests/test_agent_api.py` | `test_briefs_recent_orders_desc` | seed 3 rows | newest first | ordering |
| `tests/test_brief_scheduler.py` | `test_seconds_until_next_target_hour_wraps_midnight` | now=23:30, hours=[7,19] | ~7.5 h | scheduler maths |

### Edge Cases Checklist
- [x] Empty Supabase → tools return `[]` / zeros; agent says "no activity today"
- [x] Gemini API key missing → `/api/agent/*` returns 503 with clear message
- [x] LLM hallucinates a tool name not in `TOOLS` → `dispatch()` raises; loop catches + logs + replies "couldn't reach answer"
- [x] LLM emits malformed args → Pydantic validates; fallback message
- [x] Function-calling infinite loop → 6-hop cap + degraded response
- [x] Brief scheduler crash → broad except + 60s backoff; supervisor stays alive
- [x] System time jumps (NTP sync) → next target re-computed each iteration; harmless
- [x] Concurrent chat requests → each request is independent (no shared session state)

---

## Validation Commands

### Static
```bash
cd backend
python -m py_compile $(git ls-files '*.py')
cd ../frontend
npx tsc --noEmit
```
EXPECT: zero errors both sides.

### Unit tests
```bash
cd backend
PHARMGUARD_STUB=1 BACKEND_HEADLESS=1 SUPABASE_URL=x SUPABASE_KEY=y \
    DEVICE_API_KEY=$(python -c "import secrets;print(secrets.token_urlsafe(32))") \
    GEMINI_API_KEY=test-key \
    pytest tests/test_agent.py tests/test_agent_tools.py tests/test_agent_api.py tests/test_brief_scheduler.py -q
```
EXPECT: all pass.

### Migration
```bash
mcp__supabase__list_tables schemas=["public"]
```
EXPECT: `agent_briefs` listed.

### Smoke (dev-mac, headless)
```bash
cd backend
export BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 \
       SUPABASE_URL=... SUPABASE_KEY=... DEVICE_API_KEY=... GEMINI_API_KEY=...
uvicorn main:app --port 8000 &

curl -X POST -H "X-Device-API-Key: $DEVICE_API_KEY" -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","text":"summary of today"}]}' \
     http://localhost:8000/api/agent/chat | jq

curl -X POST -H "X-Device-API-Key: $DEVICE_API_KEY" \
     http://localhost:8000/api/agent/brief | jq

curl -H "X-Device-API-Key: $DEVICE_API_KEY" \
     http://localhost:8000/api/agent/briefs/recent | jq
```
EXPECT: all 200, valid JSON, `briefs/recent` shows the freshly inserted row.

### Frontend
```bash
cd frontend
npm run build
NEXT_PUBLIC_DEVICE_URL=http://localhost:8000 NEXT_PUBLIC_DEVICE_API_KEY=... npm run dev
```
- Open `/agent` — chat renders, ask "what happened today?", see typed response.
- Open `/` — `<BriefCard />` shows latest brief or empty placeholder.

### Manual checklist
- [ ] Brief auto-generates at the next configured hour (or force via on-demand endpoint)
- [ ] Chat answers a "missed doses this week" question with cited counts (not invented)
- [ ] Tool-calls list under assistant message names the tools used
- [ ] BriefCard refresh button updates timestamp + content
- [ ] Empty DB → friendly "no activity today" response, not error

---

## Acceptance Criteria
- [ ] `agent_briefs` table created via migration 0005, indexed
- [ ] `/api/agent/chat` returns valid JSON for arbitrary patient/inventory questions
- [ ] `/api/agent/brief` writes a row to `agent_briefs` with markdown content
- [ ] `/api/agent/briefs/recent` returns rows newest-first
- [ ] Brief scheduler fires at configured hours (verifiable in logs)
- [ ] Frontend `/agent` page renders chat + answers questions end-to-end
- [ ] Frontend home dashboard shows BriefCard with latest brief
- [ ] PHI-to-Gemini disclosure documented in `.env.example` + README
- [ ] All 10 unit tests pass
- [ ] tsc + py_compile clean

## Completion Checklist
- [ ] Code follows discovered patterns (router, service, lazy imports, lifespan task)
- [ ] No hardcoded URLs (use `settings.agent_model_name`, etc.)
- [ ] `verify_device_api_key` reused — no new auth invented
- [ ] System prompt server-controlled — frontend cannot override
- [ ] Function-call loop capped at 6 hops
- [ ] Brief scheduler crash-safe with backoff
- [ ] Tests cover happy path + the 3 failure modes (no key, runaway loop, malformed args)
- [ ] No unnecessary scope creep (NOT-Building list respected)
- [ ] Frontend self-contained — no questions during `/prp-implement`

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gemini quota exhausted mid-day | M | M (chat / briefs fail) | 503 with clear error; document in README; consider local fallback in v2 |
| LLM hallucinates statistics | M | H (clinician trusts wrong number) | System prompt: "Use ONLY tool outputs; cite exact numbers; if unsure say so." Plus tool-call summaries displayed under each answer so clinician can audit |
| Function-calling infinite loop | L | M | 6-hop cap with degraded response |
| PHI leak via Gemini logs | H (by design) | depends on jurisdiction | Documented + accepted; future Edge Function proxy layer if needed |
| Brief scheduler timezone drift | L | L | Re-compute target each iteration using `astimezone()` |
| `agent_briefs` table grows unbounded | L | L | Index on `generated_at`; manual TRUNCATE or future cleanup task |
| Chat box used as a free-text injection vector | L | L | System prompt server-side only; no SQL exposed; tools are typed |
| Non-determinism breaks tests | M | L | Mock Gemini in unit tests; never assert exact prose, only schema |
| Pi 5 + Gemini-2.0-flash latency | M | L | Single brief is ~3-8 s; chat is single-shot ~2-4 s; acceptable for ad-hoc use |

## Notes

**Why function-calling instead of stuffing data into the prompt.**
Adherence logs accumulate fast (50–100/day per patient at full deployment). Stuffing would hit Gemini's context limit quickly and pay token cost on irrelevant rows. Function-calling lets the LLM fetch only what it needs per question.

**Why two endpoints (chat + brief) instead of one.**
- Chat: stateless, multi-turn, function-calling loop.
- Brief: pre-computed input, single LLM call, persistent.

Different latency profiles + different output shapes. Sharing code (`agent.py` underneath) but distinct API surfaces keeps each predictable.

**Why scheduler in lifespan, not in HardwareLoop.**
HardwareLoop has hardware-dependent supervised restart logic. The agent has no hardware dependency. Coupling the brief scheduler to HardwareLoop would mean (a) brief generation pauses while GPIO is being re-init'd, and (b) headless dev-mac would never generate briefs. Sibling task in lifespan keeps them independent.

**Operator runbook for the PHI tradeoff.**
If a hospital later requires no-cloud-PHI: swap Gemini for a local Ollama model. The agent service abstracts the LLM interface — swap is ~50 lines of code. Documented in the NOT-Building / future-work section of the README.
