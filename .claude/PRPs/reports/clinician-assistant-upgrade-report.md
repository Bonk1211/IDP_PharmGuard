# Implementation Report: Clinician Assistant Response & Capability Upgrade

## Summary
Implemented all 9 plan tasks. Backend: existing tools now return flat `patient_name` (PostgREST embed for adherence_logs, Python id→name stitch for agent_flags); three new read-only tools — `adherence_stats` (per-patient rates + missed streaks, worst-first), `patient_overview` (chart + meds + last 10 logs + open flags in one hop, with ambiguous-name handling), `query_schedules` (daily HH:MM schedule with computed next-due, Pi-local time); system prompt rewritten with name-not-ID rule, verdict-first answer shape, tool-routing hints, and a per-request local-datetime injection. Frontend: AgentChat gained patient-aware suggestion chips, friendly lookup label chips (raw calls kept in details), sessionStorage conversation persistence (hydration-safe), per-answer Copy button, and a Retry button on failed sends.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Single-pass, no blockers |
| Files Changed | 4 (1 verify-only) | 3 changed + 1 verified unchanged |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Name-enrich query_adherence / query_flags | Complete | Embed for adherence; stitch helper `_attach_patient_names` for flags (no FK assumption) |
| 2 | `adherence_stats` tool | Complete | None-pct sorts last (101 sentinel) |
| 3 | `patient_overview` tool | Complete | 0 match → error dict; >1 → ambiguous list |
| 4 | `query_schedules` tool | Complete | Handles "HH:MM" and "HH:MM:SS"; malformed rows skipped |
| 5 | Registry + prompt + clock injection | Complete | Brief prompt untouched |
| 6 | Patient-aware suggestion chips | Complete | `usePatients` + useMemo, capped at 6 |
| 7 | Friendly tool-call labels | Complete | Chip row + raw details preserved |
| 8 | Persistence / copy / retry | Complete | Mount-effect restore (no hydration mismatch); resend skips re-append |
| 9 | Validation | Complete | py_compile + build green |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `python -m py_compile services/agent.py services/agent_tools.py` clean |
| Unit Tests | N/A | No test runner in repo (per CLAUDE.md) |
| Build | Pass | `npm run build` zero type errors |
| Integration | Pending | Needs live device + DEEPSEEK_API_KEY; manual checklist below |
| Edge Cases | Code-reviewed | All checklist items guarded in code |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `backend/services/agent_tools.py` | UPDATED | ~+250 |
| `backend/services/agent.py` | UPDATED | ~+25 / −10 |
| `frontend/src/components/AgentChat.tsx` | UPDATED | ~+130 / −30 |
| `frontend/src/lib/agent.ts` | VERIFIED | unchanged — `ChatResponse` contract intact |

## Deviations from Plan
1. **`query_flags` uses the Python stitch directly** (not embed-with-fallback) — avoids a runtime failure mode on a table whose FK to patients is unconfirmed; one extra indexed lookup, same output shape.
2. **Hydration-safe persistence** — plan suggested lazy `useState` initializer; implemented as mount-effect restore instead, because a lazy initializer reading sessionStorage produces SSR/client hydration mismatches in Next.

## Issues Encountered
None — both validation gates passed first run.

## Tests Written
None — repo has no test infrastructure (explicitly out of scope per plan).

## Next Steps
- [ ] Deploy to device: `make pi-sync HOST=pi@<host>` + `sudo systemctl restart pharmguard`
- [ ] Live checklist: "What needs my attention?" / "How is <patient> doing?" (1 hop) / "Which patients are at risk this week?" (named + %) / "Who's due in the next 2 hours?" / "Any missed doses this evening?" (no clarifying question)
- [ ] Code review via `/code-review`
- [ ] Commit via `/prp-commit`, PR via `/prp-pr`
