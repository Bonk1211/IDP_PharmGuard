# Implementation Report: Dashboard Surfaces (PRD Phase 7)

## Summary
Polished four dashboard surfaces to make the system legible to nurses and pharmacists. Improved the live adherence feed (`IntakeLog.tsx`) with a per-patient filter, dispenser_id badge, confidence-score chip, and friendlier "Today HH:MM" / "Yesterday HH:MM" timestamps — keeping the existing Supabase Realtime subscription. Created `AlertsPanel.tsx` that reads `public.alerts` if it exists and gracefully falls back to a "Phase 5 not yet shipped" empty state otherwise (handles PostgREST `42P01` and `PGRST205` schema-cache misses). Extended `/inventory` with an all-slots heatmap (10 cols x N patients) showing six status colours (healthy / expiring / low / out / expired / empty), a legend strip, and per-patient expiring/expired chips + dispenser_id badges. Polished `/patients/[id]/enroll` with MIME-prefix file-type rejection, >10 MB warning, and `<img onLoad>` preview gating + `onError` corruption handler. Phase 7 is frontend-only — no backend, Pi, or migration changes.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Files Changed | 6 modified + 2 created | 5 modified + 2 created (no need to touch `NeedsAttention.tsx`) |
| LOC | ~400 net | ~610 net (heatmap + AlertsPanel were richer than estimated) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extend `lib/api.ts` with `Alert` + `fetchAlerts()` | Complete | Tolerates `42P01`, `PGRST205`, "does not exist", "not found", "schema cache"; outer try/catch swallows network errors. Forward-compat union (`(string & {})`). |
| 2 | Create `AlertsPanel.tsx` | Complete | Severity dot + chip, acknowledged greying, system-vs-patient row, friendly relative timestamps. |
| 3 | Polish `IntakeLog.tsx` | Complete | Realtime channel preserved; filter via `<select>`; dispenser badge + confidence chip render only when non-null; "Today/Yesterday HH:MM" + relative for <1h. |
| 4 | Mount `AlertsPanel` on home | Complete | Above `NeedsAttention` in the right column with `animate-slide-in-right stagger-3`. |
| 5 | Inventory heatmap | Complete | Six-status cascade, legend, dispenser_id chip on patient header, expiring/expired count chips. Cell tooltips via `title=`. |
| 6 | Polish enrol page | Complete | MIME hard-reject, >10 MB warn, preview gated on `onLoad`, submit disabled until preview ready. |
| 7 | Build | Pass | `npm run build` green; 7 routes; Realtime subscription compiles; CSS @import warning is pre-existing (globals.css). |

## Decisions

1. **Kept Supabase Realtime** for the live feed instead of moving to `/api/logs/ws`. The WS endpoint requires a `device_token` query parameter (`backend/app/api/logs.py:66-80`) which cannot be safely embedded in browser JS; staff-token plumbing is out of Phase 7 scope. Documented in plan + as inline comment in `IntakeLog.tsx`.
2. **Slot-status grid lives at `/inventory`**, not a new `/slots` route. `/inventory` was already the canonical slot view; adding a fifth nav entry would crowd `Navbar.tsx`.
3. **Alerts panel renders the empty state on a missing table**, with the friendly subtitle "Alerts feed connects in Phase 5". `fetchAlerts()` returns `[]` on PostgREST error codes `42P01`/`PGRST205` and message substrings "does not exist", "not found", "schema cache". Outer try/catch defends against network failure too.
4. **Forward-compat `Alert` types** — the `AlertKind` union is open-ended (`(string & {})` literal-preserving fallback), and `severity` accepts the standard three levels. If Phase 5 ships overlapping types, the merge can replace this with the canonical schema; the helper signature stays the same.
5. **Heatmap status cascade order**: `expired` and `out` both red, `low` yellow, `expiring` (<= 14 days) amber, `healthy` green, `empty` grey-dashed. `expired` is checked first because an expired-but-non-empty slot is more dangerous than just "low". `expiring` only wins over `healthy` (not over `low`/`out`).

## Validation Results

| Level | Status | Notes |
|---|---|---|
| `npm install` | Pass | 57 packages, 4s |
| `npm run build` | Pass | 7 routes prerendered (`/`, `/inventory`, `/patients`, `/patients/[id]`, `/patients/[id]/enroll`, `/reports`, `/_not-found`); CSS @import warning is pre-existing in `globals.css` (out of scope) |
| TypeScript types | Pass | No errors; `Alert` interface compiles; `fetchAlerts()` returns Promise<Alert[]>; component props all typed |
| Visual smoke | Deferred (manual) | Build artefacts produced; an operator can `npm run dev` to verify rendering. |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `.claude/PRPs/plans/dashboard-surfaces.plan.md` | CREATE | ~210 |
| `frontend/src/lib/api.ts` | UPDATE | +66 |
| `frontend/src/components/AlertsPanel.tsx` | CREATE | ~165 |
| `frontend/src/components/IntakeLog.tsx` | UPDATE | rewritten (~275 lines) |
| `frontend/src/app/page.tsx` | UPDATE | +5 (import + mount) |
| `frontend/src/app/inventory/page.tsx` | UPDATE | rewritten (~355 lines) |
| `frontend/src/app/patients/[id]/enroll/page.tsx` | UPDATE | rewritten (~150 lines) |
| `.claude/PRPs/reports/dashboard-surfaces-report.md` | CREATE | this file |

## What I Did NOT Do

- Did not touch backend, edge_pi, or migrations (Phase 7 is frontend-only).
- Did not switch the live feed to `/api/logs/ws` (token plumbing out of scope).
- Did not add a chart library — heatmap is plain Tailwind grid.
- Did not modify `NeedsAttention.tsx` even though it overlaps conceptually with `AlertsPanel`. They serve different signal sources (heuristic vs. table-backed) and the dashboard now shows both.
- Did not modify the Reports page — not on Phase 7's success-signal path.
- Did not push or merge.
- Did not update the central PRD row at `.claude/PRPs/prds/pharmguard.prd.md` (orchestrator handles it).
- Did not move the plan to `completed/` (orchestrator handles it).

## Risks for Merge with Phase 4 / Phase 5

- **Phase 5 collision surface**: `frontend/src/lib/api.ts` adds an `Alert` interface and `fetchAlerts()`. If Phase 5 also adds these in parallel, the merge can pick whichever is canonical — the field shape here is conservative (`id`, `kind`, `severity`, `message`, `patient_id`, `slot`, `dispenser_id`, `created_at`, `acknowledged_at`) and forward-compatible.
- **Phase 5 may add an `alerts` table with different field names** — `fetchAlerts()` would still succeed (returns whatever shape the table has, cast as `Alert`). At worst the panel renders blank rows; at best the merge reconciles types. No runtime crash.
- **Phase 4 (diverter + drawer-lock)**: zero overlap. Pure hardware/Pi territory; this PR doesn't touch `edge_pi/` or backend.
- **Phase 6 (bench loop)**: parallel-safe. Bench writes data; this PR only reads.

## Notes
- The CSS `@import` warning during build (`globals.css` Google Fonts URL) is pre-existing and not introduced by this phase.
- `frontend/.env.local` is gitignored (`.gitignore:12`); the build needs `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` set or the prerender step fails. I copied the existing `.env.local` from the main worktree for the build smoke; it is not committed.
- `node_modules/` was not present in the worktree at start; ran `npm install` (57 packages, 4s) before the build.
