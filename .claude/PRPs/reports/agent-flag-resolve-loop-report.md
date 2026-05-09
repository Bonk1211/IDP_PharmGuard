# Implementation Report: Agent Flag → Human-in-the-Loop → Resolve

## Summary
Adds a proactive flagging surface to the read-only clinician assistant. New
`agent_flags` table holds detected anomalies; a hybrid heuristic + Gemini
detector runs piggyback on the brief schedule; clinicians ack/resolve/dismiss
with optional notes via dashboard buttons. Agent chat gets a new `query_flags`
read-only tool; the brief now has a "## Open flags" section.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large — confirmed |
| Confidence | 8/10 | Met — no plan reversals |
| Files Changed | 12 | 12 (5 created, 7 updated) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Migration 0006_agent_flags | Complete | Applied via Supabase MCP |
| 2 | services/flag_detector.py | Complete | 3 heuristics + Gemini soft pass + tolerant JSON parser |
| 3 | api/flags.py | Complete | GET / + POST ack/resolve/dismiss; 404/409 semantics |
| 4 | main.py wire flags router | Complete | `/api/agent/flags/*` mounted |
| 5 | agent_tools.query_flags | Complete | TOOLS reordered — query_flags is now FIRST |
| 6 | Brief cites open flags | Complete | Payload + system prompt updated; metadata gets n_open_flags |
| 7 | Scheduler runs detection | Complete | Sequential before brief; broad except keeps it crash-safe |
| 8 | Settings + .env.example | Complete | 3 new tunables, all with safe defaults |
| 9 | lib/agent.ts flag client | Complete | Types + fetchOpenFlags + ack/resolve/dismiss |
| 10 | components/FlagsPanel.tsx | Complete | Inline resolve UX, optimistic remove, error fallback |
| 11 | Wire FlagsPanel into dashboard | Complete | Right column, above AlertsPanel |
| 12 | Apply migration + smoke | Complete | Dedup behaviour confirmed via SQL |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| py_compile | Pass | flags.py, flag_detector.py, agent_tools.py, agent.py, brief_scheduler.py, main.py, config.py |
| Module import smoke | Pass | TOOLS=6 (query_flags first), 4 routes under /api/agent/flags |
| Settings smoke | Pass | thresholds load with defaults 3 / 0.55 / True |
| Tolerant JSON parser | Pass | plain, fenced, junk, empty all behave |
| Frontend tsc | Pass | `tsc --noEmit` clean |
| DB dedup | Pass | Same fingerprint while open → 23505; resolve → re-flag works |
| End-to-end on Pi | Skipped | Operator step — needs live ngrok + Pi |

## Files Changed

| File | Action | Description |
|---|---|---|
| `backend/migrations/0006_agent_flags.sql` | CREATED | table + 4 CHECK constraints + 4 indexes (incl. partial unique) |
| `backend/services/flag_detector.py` | CREATED | hybrid detector + tolerant JSON parser + persistence |
| `backend/api/flags.py` | CREATED | 4 endpoints with state-machine guards |
| `frontend/src/components/FlagsPanel.tsx` | CREATED | dashboard widget with inline resolve UX |
| `backend/services/agent_tools.py` | UPDATED | added QueryFlagsArgs + query_flags + first-position registration |
| `backend/services/agent.py` | UPDATED | brief prefetches open flags + system prompt cites them |
| `backend/scheduler/brief_scheduler.py` | UPDATED | detection runs before brief on every tick |
| `backend/main.py` | UPDATED | imports + mounts flags router |
| `backend/config.py` | UPDATED | 3 new agent_flag_* settings |
| `backend/.env.example` | UPDATED | documented new env vars |
| `frontend/src/lib/agent.ts` | UPDATED | exported isAgentConfigured + flag types + 4 helpers |
| `frontend/src/app/page.tsx` | UPDATED | imports + renders FlagsPanel |

## Deviations from Plan
- **None substantive.** TOOLS array gained `query_flags` at position 0 (plan said "append" but the system prompt advised "use FIRST" — putting it physically first matches the model's bias toward earlier-listed tools).

## Issues Encountered
- **GateGuard fact-forcing hook** challenged each create/edit; presented facts each time, no rejections.
- **`config.py` model name** had been hand-edited by the user from `gemini-2.0-flash` → `gemini-2.5-flash` between plan write and implementation; preserved.

## Tests Written
None — repo has no test framework configured (per CLAUDE.md). Validation via:
- `python -m py_compile` across 7 modules
- `python -c` import + dispatch smoke
- Live SQL dedup test against the actual Supabase project

## Operator-Side Setup Required
1. **No new env required to start** — defaults (`3` / `0.55` / Gemini-on) are sane.
2. To suppress the LLM soft pass without losing chat/brief: set `AGENT_FLAG_GEMINI_ENABLED=0`.
3. Heuristic-only flags appear at the next configured local hour after the next dose miss, low-confidence intake, or trending-empty slot.
4. **PHI**: same surface as briefs — Gemini soft pass sends adherence + alerts. Documented in `.env.example`.

## Next Steps
- [ ] On Pi: `journalctl -u pharmguard -f` at next configured hour to confirm scheduler logs `running flag detection` then `detection done — new=N`
- [ ] Smoke a real flag end-to-end: insert a manual row, confirm dashboard surfaces + resolve writes back
- [ ] Optional: Supabase RLS on `agent_flags` once auth is live
