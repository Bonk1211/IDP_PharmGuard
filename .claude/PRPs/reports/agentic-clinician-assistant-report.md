# Implementation Report: Agentic Clinician Assistant

## Summary
Gemini-powered, read-only clinician assistant. Two surfaces: a function-calling chat (5 Supabase tools) and a markdown shift-handover brief (scheduled at local hours + on-demand). Persisted to a new `agent_briefs` table. Frontend gets a dedicated `/agent` page (chat + brief) and a dashboard `BriefCard` widget. PHI flows to Gemini in plaintext — operator opted in.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large (LLM + scheduler + frontend + DB) | Large — confirmed |
| Confidence | 8/10 | Met — no plan reversals |
| Files Changed | ~13 | 13 (8 created, 5 modified) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Migration 0005_agent_briefs | Complete | Applied via Supabase MCP |
| 2 | services/agent_tools.py | Complete | 5 read-only tools, Gemini schema sanitiser |
| 3 | services/agent.py | Complete | chat + generate_brief, lazy genai import |
| 4 | api/agent.py | Complete | POST /chat, POST /brief, GET /briefs/recent |
| 5 | scheduler/brief_scheduler.py | Complete | local-hour aware, crash-safe |
| 6 | main.py wiring | Complete | brief task spawned alongside HardwareLoop |
| 7 | config.py settings | Complete | agent_model_name + agent_brief_local_hours |
| 8 | .env.example | Complete | PHI disclaimer added |
| 9 | lib/agent.ts | Complete | chatAgent, fetchLatestBrief, refreshBrief |
| 10 | components/BriefCard.tsx | Complete | Tiny markdown renderer (no library) |
| 11 | components/AgentChat.tsx | Complete | Tool-call drawer, latency footer |
| 12 | app/agent/page.tsx | Complete | Two-column layout reusing BriefCard |
| 13 | app/page.tsx + Navbar | Complete | BriefCard wired into right column; Assistant link added |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| py_compile (backend) | Pass | main, config, services/agent*, api/agent, scheduler/brief_scheduler |
| Module import smoke | Pass | TOOLS list, Gemini decls (5), router routes (3) |
| brief_scheduler helpers | Pass | `_parse_target_hours("7,foo,99,19")` -> [7,19]; empty hours -> 86400 s wait |
| TypeScript (frontend) | Pass | `tsc --noEmit` clean |
| Frontend build | Skipped | `next lint` deprecation prompt is interactive; tsc covers types |
| Backend full app load | Skipped | dev mac venv lacks cv2/picamera2/RPi.GPIO (Pi-only); not a regression |

## Files Changed

| File | Action | Description |
|---|---|---|
| `backend/migrations/0005_agent_briefs.sql` | CREATED | agent_briefs table + index |
| `backend/services/agent_tools.py` | CREATED | 5 read-only tools + Gemini schema builder |
| `backend/services/agent.py` | CREATED | chat (function-calling loop) + generate_brief |
| `backend/api/agent.py` | CREATED | /chat /brief /briefs/recent endpoints |
| `backend/scheduler/brief_scheduler.py` | CREATED | scheduled brief generator |
| `backend/main.py` | UPDATED | spawn brief task in lifespan; mount agent router |
| `backend/config.py` | UPDATED | agent_model_name, agent_brief_local_hours |
| `backend/.env.example` | UPDATED | agent section + PHI disclaimer |
| `frontend/src/lib/agent.ts` | CREATED | typed HTTP client |
| `frontend/src/components/BriefCard.tsx` | CREATED | brief widget with refresh |
| `frontend/src/components/AgentChat.tsx` | CREATED | chat UI with tool-call disclosure |
| `frontend/src/app/agent/page.tsx` | CREATED | dedicated `/agent` route |
| `frontend/src/app/page.tsx` | UPDATED | BriefCard added to dashboard |
| `frontend/src/components/Navbar.tsx` | UPDATED | Assistant nav item |

## Deviations from Plan
- **None substantive.** Lifespan ordering swapped slightly so the brief task is spawned BEFORE the HardwareLoop; this lets the assistant serve even if hardware init crashes. Documented inline.
- Added Navbar `/agent` link (one extra line) so the new page is discoverable; plan implied UX but didn't enumerate it.

## Issues Encountered
- **GateGuard fact-forcing hook** challenged each edit — required listing importers / confirming no duplicates / quoting the user instruction before writing. Slowed iteration but produced no rejections.
- **Dev mac venv lacks `cv2`** so `from main import app` fails locally — pre-existing, not caused by this work. Validated by importing the agent stack directly.
- **`next lint` deprecated** in this Next.js version and prompts interactively; replaced with `tsc --noEmit` for type validation.

## Operator-Side Setup Required
1. `GEMINI_API_KEY` must be set in `backend/.env` — endpoints raise 503 without it.
2. `AGENT_BRIEF_LOCAL_HOURS` defaults to `7,19`. Set to empty string to disable scheduled briefs (manual `/api/agent/brief` still works).
3. Frontend reuses `NEXT_PUBLIC_DEVICE_URL` + `NEXT_PUBLIC_DEVICE_API_KEY` from the existing device tunnel — no new env needed.
4. **PHI**: every chat hop and every brief sends names + conditions + adherence to Google Gemini in plaintext. Documented in `.env.example`.

## Tests Written
None — repo has no test framework configured (per CLAUDE.md). Smoke validation via direct module imports.

## Next Steps
- [ ] Pi-side smoke: `curl https://<ngrok>/api/agent/briefs/recent` once GEMINI_API_KEY is set
- [ ] Live shift-handover at the next configured hour to confirm scheduler firing
- [ ] Optional: a Supabase RLS policy on `agent_briefs` if non-service-role clients ever read it
