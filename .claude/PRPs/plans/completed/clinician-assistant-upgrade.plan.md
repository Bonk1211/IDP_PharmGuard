# Plan: Clinician Assistant Response & Capability Upgrade

## Summary
Upgrade the DeepSeek-powered clinician assistant on two fronts: (1) **response quality** — tool results currently return bare `patient_id`s so the model cites IDs instead of names, the model has no idea what time "now" is, and answers have no enforced shape; (2) **new capabilities** — add three read-only tools (`patient_overview`, `adherence_stats`, `query_schedules`) plus name-enriched existing tools so one question gets one authoritative answer instead of burning the 6-hop budget. Frontend chat gets patient-aware suggestion chips, friendly tool-call labels, session persistence, copy, and retry.

## User Story
As a **nurse or pharmacist using the PharmGuard assistant**, I want **answers that name patients, know what time it is, and can summarize a patient or rank adherence risk in one question**, so that **I get shift-ready information without cross-referencing IDs or re-asking**.

## Problem → Solution
- `query_adherence` returns `patient_id: 3` → model answers "patient 3 missed a dose" → **join patient names server-side; model cites "Mary Tan"**.
- "Any missed doses this evening?" → model can't resolve "evening" (no clock) → **inject current local datetime into the system prompt per request**.
- "How is Mary doing?" → needs list_patients + query_adherence + query_flags + query_medications = 4 of 6 hops → **single `patient_overview` tool**.
- "Which patients are at risk?" → model eyeballs raw rows → **`adherence_stats` computes rate/missed-streak server-side**.
- "What's due next?" → no tool covers `medications.schedule_at` → **`query_schedules` tool**.
- Chat UX: chips static, tool calls raw mono, conversation lost on navigation, no retry → **fix all four in AgentChat**.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A
- **PRD Phase**: N/A
- **Estimated Files**: 4 (2 backend, 2 frontend — one verify-only)

---

## UX Design

### Before
```
[chat] "Which patients are at risk?"
  → 4-6 tool hops → "Patients 2 and 5 have missed doses…"
  → tool calls shown as: query_adherence(only_missed=true) → 14 rows
  → navigate away = conversation gone
```

### After
```
[chat] chips: "What needs my attention?" · "How is Mary Tan doing?" ·
       "Who's due in the next 2 hours?" · "Summarize for shift handover"
  → 1-2 hops → "**At risk: Mary Tan** (3 missed in 48h, 62% adherence) …"
  → lookups shown as friendly chips: 🔎 Adherence stats · 🔎 Open flags
  → [copy] on each answer · error bubble has [Retry] · survives navigation
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Assistant citations | patient IDs | patient names | server-side join, no model effort |
| Relative dates | model guesses/asks | resolved against injected `now` | per-request system prompt |
| Patient question | 4+ hops, may truncate | 1 hop via `patient_overview` | |
| Risk ranking | raw-row eyeballing | server-computed `adherence_stats` | |
| Suggested chips | 4 static | static + patient-aware + handover | uses existing `usePatients()` |
| Tool-call display | raw mono line | label chip + mono detail in `<details>` | |
| Conversation | lost on nav | sessionStorage persisted | "New conversation" clears |
| Error | message only | message + Retry button | resends last user turn |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/services/agent_tools.py` | all (388) | Tool pattern: pydantic Args class + fn + ToolDef registry; every new tool mirrors this |
| P0 | `backend/services/agent.py` | 37-80, 106-141 | System prompts + chat loop; prompt edits and `now` injection land here |
| P1 | `frontend/src/components/AgentChat.tsx` | all (261) | Chat UI being upgraded |
| P1 | `frontend/src/lib/agent.ts` | 11-78 | `ChatTurn`/`ChatResponse` contract — unchanged, do not break |
| P2 | `frontend/src/lib/api.ts` | 156-167 | Supabase relation-join select pattern (`patient:patients(id, name)`) |
| P2 | `backend/api/device.py` | 580-615 | `schedule_at` semantics ("HH:MM" daily) for `query_schedules` |
| P2 | `frontend/src/lib/swr.ts` | all | `usePatients` hook for patient-aware chips |

## External Documentation
No external research needed — DeepSeek tool-calling already wired (OpenAI-compatible); all additions follow existing internal patterns.

---

## Patterns to Mirror

### TOOL_DEFINITION (args model + fn + registry entry)
```python
# SOURCE: backend/services/agent_tools.py:94-120, 265-328
class QueryAdherenceArgs(BaseModel):
    model_config = {"extra": "forbid"}
    patient_id: int | None = Field(default=None, description="Filter by patient_id (numeric).")
    limit: int = Field(default=50, ge=1, le=500)

def query_adherence(**kwargs: Any) -> list[dict]:
    args = QueryAdherenceArgs(**kwargs)
    sb = get_supabase()
    q = sb.table("adherence_logs").select("...").order("timestamp", desc=True).limit(args.limit)
    ...
    return q.execute().data or []

TOOLS: list[ToolDef] = [
    ToolDef(name="query_adherence", description="...", args_schema=QueryAdherenceArgs, fn=query_adherence),
]
```

### SUPABASE_RELATION_JOIN (names instead of IDs)
```ts
// SOURCE: frontend/src/lib/api.ts:156-160 — same PostgREST syntax works in supabase-py:
.select("*, patient:patients(id, name)")
```
Python equivalent for the new code:
```python
.select("id, patient_id, slot, pill_taken, timestamp, confidence_score, patient:patients(name)")
```

### SYSTEM_PROMPT_STYLE
```python
# SOURCE: backend/services/agent.py:37-61 — triple-quoted module constant,
# "Hard rules:" block, tool list with usage hints. Keep this voice.
_SYSTEM_PROMPT_CHAT = """\
You are a clinical assistant for the PharmGuard pill dispenser system.
...
Hard rules:
- Use ONLY data returned by your tools. NEVER invent counts, names, or dates.
"""
```

### TOOL_ERROR_HANDLING (dispatch already wraps)
```python
# SOURCE: backend/services/agent.py:184-190 — tools may raise; the chat loop
# catches and feeds {"error": str(exc)} back to the model. New tools just
# raise naturally on bad args (pydantic) and return [] / {} on no data.
```

### CHAT_UI_PATTERNS
```tsx
// SOURCE: frontend/src/components/AgentChat.tsx:15-20 (chips), 36-69 (send),
// 138-151 (tool-call details). Bubble type extension and send() are the
// integration points; preserve the ChatTurn payload mapping at 48-51.
const SUGGESTED: string[] = ["What's happened today?", ...];
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/services/agent_tools.py` | UPDATE | Name-join existing tools; add `patient_overview`, `adherence_stats`, `query_schedules` + registry entries |
| `backend/services/agent.py` | UPDATE | Inject current datetime; response-shape rules; document new tools in prompt |
| `frontend/src/components/AgentChat.tsx` | UPDATE | Patient-aware chips, friendly tool labels, sessionStorage persistence, copy + retry |
| `frontend/src/lib/agent.ts` | NONE (verify) | Contract unchanged — `ChatResponse` already carries everything needed |

## NOT Building
- **No write actions from chat** (ack/resolve flags, dispense triggers) — the assistant stays read-only; the UI label "Read-only" remains true.
- **No streaming responses** — DeepSeek streaming over the ngrok tunnel + current request/response contract is a separate project.
- **No `device_status` tool** — hardware state lives on `request.app.state.hardware_loop` (api/device.py:47); tools are plain callables without app access. Deferred; would need an app-state accessor module.
- **No provider change** (stays DeepSeek), no voice, no new pages, no RAG/embeddings.
- **No brief-generation changes** — `generate_brief` untouched (it pre-fetches its own data).
- **No test infrastructure** (repo has none).

---

## Step-by-Step Tasks

### Task 1: Name-enrich existing tools
- **ACTION**: In `backend/services/agent_tools.py`, update `query_adherence` and `query_flags` to return patient names.
- **IMPLEMENT**: `query_adherence` select becomes `"id, patient_id, slot, pill_taken, timestamp, dispenser_id, confidence_score, patient:patients(name)"`. After `.execute()`, flatten: `row["patient_name"] = (row.pop("patient") or {}).get("name")` so the LLM sees a flat `patient_name`. Same for `query_flags` via `"*, patient:patients(name)"` — if PostgREST rejects the embed (no FK on agent_flags), fall back to one `patients` lookup building an id→name map and stitching `patient_name` in Python.
- **MIRROR**: SUPABASE_RELATION_JOIN; keep return type `list[dict]`.
- **GOTCHA**: Embed is `None` for rows with null `patient_id` — `(row.pop("patient") or {})` handles it. Do NOT rename existing fields; only add `patient_name` (additive — `generate_brief` also consumes these rows).
- **VALIDATE**: `cd backend && .venv/bin/python -m py_compile services/agent_tools.py`; live: "any missed doses today?" → names in answer.

### Task 2: `adherence_stats` tool
- **ACTION**: New tool computing per-patient adherence over a lookback window.
- **IMPLEMENT**:
  ```python
  class AdherenceStatsArgs(BaseModel):
      model_config = {"extra": "forbid"}
      lookback_days: int = Field(default=7, ge=1, le=90)
      patient_id: int | None = Field(default=None)
  ```
  Fetch `adherence_logs` (patient_id, pill_taken, timestamp) since cutoff (+ optional patient filter), fetch `patients` (id, name), group in Python into `{patient_id, patient_name, n_scheduled, n_taken, n_missed, adherence_pct, current_missed_streak, last_dose_at}`. `current_missed_streak` = consecutive `pill_taken=False` from the most recent log backwards. Sort worst-first (lowest `adherence_pct`).
- **MIRROR**: TOOL_DEFINITION; date math mirrors `_today_iso_bounds()` (timezone.utc).
- **GOTCHA**: Zero logs → `[]`; guard division: `adherence_pct = round(100*n_taken/n_scheduled, 1) if n_scheduled else None`.
- **VALIDATE**: py_compile; live: "which patients are at risk?" → percentages + streaks in 1 hop.

### Task 3: `patient_overview` tool
- **ACTION**: One-hop everything-about-one-patient tool.
- **IMPLEMENT**:
  ```python
  class PatientOverviewArgs(BaseModel):
      model_config = {"extra": "forbid"}
      patient_id: int | None = Field(default=None, description="Numeric id, if known.")
      name: str | None = Field(default=None, description="Full or partial patient name (case-insensitive).")
  ```
  Resolve patient: by id, else `patients.ilike("name", f"%{name}%")` — 0 matches → `{"error": "no patient matched"}`; >1 → `{"ambiguous": [{id, name}, ...]}` so the model asks the user. Then assemble one dict: patient row (id, name, age, gender, condition, status, allergies, contraindications), their `medications` (slot, name, quantity, expiry_date, schedule_at), last 10 `adherence_logs`, open `agent_flags` (≤10).
- **MIRROR**: TOOL_DEFINITION; sub-queries mirror `query_medications` / `query_adherence` / `query_flags` bodies.
- **GOTCHA**: Require at least one of id/name — `raise ValueError("provide patient_id or name")` (dispatch surfaces it to the model). Cap sub-lists to keep the tool message small.
- **VALIDATE**: py_compile; live: "tell me about <patient>" → single `patient_overview` hop.

### Task 4: `query_schedules` tool
- **ACTION**: Expose the daily dose schedule with next-due computation.
- **IMPLEMENT**:
  ```python
  class QuerySchedulesArgs(BaseModel):
      model_config = {"extra": "forbid"}
      patient_id: int | None = Field(default=None)
      due_within_hours: float | None = Field(default=None, ge=0, le=24,
          description="Only doses whose next occurrence is within this many hours.")
  ```
  Select `medications` rows where `schedule_at` not null (`.not_.is_("schedule_at", "null")`), join `patient:patients(name)` + flatten. `schedule_at` is "HH:MM" daily (api/device.py:609): `next_due_iso` = today at HH:MM local, +1 day if past — mirror `nextRoundFrom` (frontend `dispensers/[id]/page.tsx:104-130`). Filter by `due_within_hours` when set; sort by `next_due_iso`.
- **MIRROR**: TOOL_DEFINITION; SUPABASE_RELATION_JOIN.
- **GOTCHA**: Malformed `schedule_at` → skip row, never raise. Use Pi-local time (`datetime.now().astimezone()`) — same clock the device scheduler uses.
- **VALIDATE**: py_compile; live: "who's due in the next 2 hours?" → ordered list, names + times.

### Task 5: Register new tools + prompt upgrade
- **ACTION**: Append three `ToolDef`s to `TOOLS`; upgrade `_SYSTEM_PROMPT_CHAT` in `backend/services/agent.py`.
- **IMPLEMENT**:
  - Registry descriptions keep the usage-hint style: `patient_overview` — "Everything about ONE patient in one call… use FIRST for any single-patient question"; `adherence_stats` — "Per-patient adherence rates and missed streaks, worst first… use for 'who is at risk'"; `query_schedules` — "Upcoming scheduled doses with next-due times".
  - Prompt additions (keep Hard rules): "Refer to patients by NAME (tools return patient_name); never expose raw IDs unless asked." / "Answer shape: one-line verdict first, then at most 5 bullets; **bold** anomalies; end with ONE short follow-up question only when it changes the action." / tool routing hints (single patient → patient_overview; risk → adherence_stats; what's next → query_schedules).
  - Time injection: in `chat()`, system message becomes `_SYSTEM_PROMPT_CHAT + f"\nCurrent local datetime: {datetime.now().astimezone().isoformat()} — resolve relative dates ('today', 'this evening', 'last night') against this."` (datetime already imported).
- **MIRROR**: SYSTEM_PROMPT_STYLE.
- **GOTCHA**: Keep additions terse — the prompt rides on every request. Do NOT touch `_SYSTEM_PROMPT_BRIEF` / `generate_brief`.
- **VALIDATE**: py_compile both files; live: "any missed doses this evening?" answers without asking what "evening" means.

### Task 6: AgentChat — smarter suggestion chips
- **ACTION**: Patient-aware + handover chips in `frontend/src/components/AgentChat.tsx`.
- **IMPLEMENT**: Import `usePatients` from `@/lib/swr`. Chips via `useMemo`: keep "What's happened today?"; add "What needs my attention?", "Who's due in the next 2 hours?", "Which patients are at risk this week?", "Summarize for shift handover"; when patients loaded, add `How is ${patients[0].name} doing?`. Cap at 6.
- **MIRROR**: CHAT_UI_PATTERNS (chip markup unchanged).
- **IMPORTS**: `{ usePatients } from "@/lib/swr"`.
- **GOTCHA**: SWR may be empty/loading — just omit the personalized chip.
- **VALIDATE**: `npm run build`; chips render, clicking sends.

### Task 7: AgentChat — friendly tool-call labels
- **ACTION**: Map tool names to human labels in the lookups section.
- **IMPLEMENT**:
  ```tsx
  const TOOL_LABELS: Record<string, string> = {
    query_flags: "Open flags", today_summary: "Today's summary",
    query_adherence: "Adherence log", query_alerts: "Alerts",
    query_medications: "Medications", list_patients: "Patients",
    patient_overview: "Patient overview", adherence_stats: "Adherence stats",
    query_schedules: "Dose schedule",
  };
  ```
  Render a chip row above the `<details>`: `🔎 {TOOL_LABELS[tc.name] ?? tc.name}` as small sand-bg pills; keep the existing mono `name(args) → summary` lines inside the expanded details for transparency.
- **MIRROR**: chip styling from SUGGESTED buttons (rounded-full bg-sand-50 text-xs).
- **GOTCHA**: Unknown tool name → fall back to raw name.
- **VALIDATE**: build; multi-tool answer shows labeled chips; expand shows raw calls.

### Task 8: AgentChat — persistence, copy, retry
- **ACTION**: Conversation survives navigation; copy answers; retry failed sends.
- **IMPLEMENT**:
  - Persistence: `const STORAGE_KEY = "pharmguard.agent.chat";` lazy `useState<Bubble[]>(() => …JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]")…)` wrapped in try/catch and `typeof window !== "undefined"` guard; `useEffect` writes on `messages` change; `reset()` also removes the key.
  - Copy: ghost button on assistant bubbles — `navigator.clipboard.writeText(m.text).catch(() => {})`, label flips to "Copied" for 1.5 s (state holds copied index).
  - Retry: on failure keep the user turn in `messages`, store prepared history in a ref; error banner gains "Retry" that re-sends WITHOUT re-appending the user bubble.
- **MIRROR**: CHAT_UI_PATTERNS send() flow; button styling from "New conversation".
- **GOTCHA**: `send()` appends the user turn before the request — retry path must not double-append; pass the prepared history explicitly. Never touch sessionStorage outside lazy init/effects (SSR prerender).
- **VALIDATE**: build; send → navigate away → back → history intact; kill tunnel → Retry works.

### Task 9: Validate end-to-end
- **ACTION**: Full validation pass.
- **IMPLEMENT**: `cd backend && .venv/bin/python -m py_compile services/agent.py services/agent_tools.py`; `cd frontend && npm run build`; live questions: "What needs my attention?", "How is <patient> doing?", "Which patients are at risk this week?", "Who's due in the next 2 hours?", "Any missed doses this evening?"
- **GOTCHA**: No pytest exists — py_compile + build + live chat IS the gate. Backend changes reach the device via `make pi-sync HOST=pi@<host>` + `sudo systemctl restart pharmguard`.
- **VALIDATE**: All clean; each demo question answers in ≤2 hops with patient names.

---

## Testing Strategy

### Unit Tests
N/A — repo has no test runner (per CLAUDE.md). Validation is compile + build + live-chat checklist.

### Edge Cases Checklist
- [ ] `patient_overview` ambiguous name → candidate list returned, model asks user
- [ ] `patient_overview` no match → plain "no patient matched" answer
- [ ] `adherence_stats` zero logs → `[]`, no division by zero
- [ ] `query_schedules` malformed/empty `schedule_at` → row skipped
- [ ] Adherence rows with null `patient_id` → `patient_name: null`, no crash
- [ ] sessionStorage empty/corrupt JSON → chat starts fresh
- [ ] DeepSeek down → existing error path + Retry button
- [ ] 6-hop truncation still renders the truncated notice

## Validation Commands

### Static Analysis
```bash
cd backend && .venv/bin/python -m py_compile services/agent.py services/agent_tools.py
```
EXPECT: silence (zero errors)

### Build
```bash
cd frontend && npm run build
```
EXPECT: success, zero type errors

### Browser Validation
```bash
make dev   # open /agent
```
EXPECT: chips, chat, tool chips, copy, retry all functional

### Manual Validation
- [ ] "Which patients are at risk this week?" → named patients + adherence % in ≤2 hops
- [ ] "How is <patient> doing?" → 1 `patient_overview` hop; meds + adherence + flags in answer
- [ ] "Who's due in the next 2 hours?" → ordered, named, with times
- [ ] "Any missed doses this evening?" → no clarifying question about "evening"
- [ ] Answers lead with a verdict line; no raw patient IDs
- [ ] Navigate away and back → conversation intact; New conversation clears

## Acceptance Criteria
- [ ] All 9 tasks complete
- [ ] Assistant cites names, never bare IDs
- [ ] Single-patient and risk questions resolve in ≤2 hops
- [ ] py_compile + frontend build pass
- [ ] Read-only boundary unchanged (no write tools)

## Completion Checklist
- [ ] New tools follow Args-model + ToolDef registry pattern exactly
- [ ] Tool results JSON-safe (dispatch's `_coerce_to_json_safe` handles dates)
- [ ] Prompt additions terse; brief prompt untouched
- [ ] `lib/agent.ts` contract untouched
- [ ] sessionStorage access SSR-guarded

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PostgREST embed fails on `agent_flags` (no FK to patients) | Medium | Low | Task 1 fallback: Python-side id→name stitch |
| Bigger tool results inflate DeepSeek context/cost | Medium | Low | Caps: ≤10 logs/flags in overview; narrow selects |
| Prompt growth degrades focus | Low | Medium | Additions ≤10 lines; verdict-first rule shortens outputs |
| Pi timezone differs from ward expectation | Low | Medium | `query_schedules` + `now` injection both use Pi-local time consistently |
| supabase-py embed syntax mismatch | Low | Medium | Same PostgREST underneath; fallback stitch covers it |

## Notes
**Considered and deferred — the "what else could it do" list beyond this plan:**
- `device_status` tool ("is the dispenser healthy?") — blocked on tools lacking access to `app.state.hardware_loop`; needs a small state-accessor module first.
- Flag actions from chat ("ack flag 3") — breaks the read-only promise; if ever wanted, gate behind an explicit confirm UI, not free text.
- Streaming responses — biggest perceived-latency win, but touches the API contract + ngrok tunnel; separate PR.
- Structured `references` in ChatResponse (deep links to `/patients/[id]`) — needs a response-shape change; do after this lands.
- Proactive scheduled digest — `brief_scheduler.py` already exists; extend that, not the chat.
