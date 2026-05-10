# Implementation Report: Dashboard Hospital Floor Map

## Summary
Replaced the four-card stat row at the top of the dashboard with a stylised top-down SVG floor plan (Common Room with 6 beds + ICU isolation bed). Beds are colour-coded by today's adherence; hovering an occupied bed reveals patient name, today's taken/total, last intake, and next medication. Clicking navigates to the patient detail page. Bed identity reuses `patients.dispenser_id` (no DB migration). `formatRelative` extracted to a shared `lib/date.ts` so FloorMap and the three existing panels share one copy.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Hit on first build, no rework |
| Files Changed | 6 (2 new, 4 updated) | 6 (2 new, 4 updated) |
| Bundle delta | < 5 kB on `/` | +0.98 kB (6.9 kB → 7.88 kB) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Extract `formatRelative` to `lib/date.ts` | Complete | 3 inline copies removed; signature widened to accept `null` |
| 2 | FloorMap skeleton + `BEDS` + `ROOM_RECTS` | Complete | |
| 3 | `BedView` join in `useMemo` | Complete | `norm()` handles whitespace/case typos |
| 4 | Render rooms + bed tiles | Complete | ICU dashed inner border applied |
| 5 | Hover popover with clamp + flip | Complete | `pointer-events-none` to prevent flicker |
| 6 | Unassigned-patients footer | Complete | Renders only when `unassigned.length > 0` |
| 7 | Click-outside dismiss | Complete | Listener attaches only while `hoverKey` set |
| 8 | Replace stat row in `page.tsx` | Complete | Stat row + 4 `Icon*` helpers + dead `useMemo` block all deleted |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (tsc) | Pass | Zero type errors |
| Unit Tests | N/A | No test framework configured (per CLAUDE.md) |
| Build (`next build`) | Pass | 8 routes generated; `/` First Load JS 179 kB |
| Integration | N/A | Pure UI; manual browser test pending |
| Edge Cases | Pass (static) | Norm/clamp/flip logic in place; visual confirmation pending |

## Files Changed

| File | Action | Notes |
|---|---|---|
| `frontend/src/lib/date.ts` | CREATED | +12 LOC; one exported function |
| `frontend/src/components/FloorMap.tsx` | CREATED | +318 LOC |
| `frontend/src/app/page.tsx` | UPDATED | Net -125; stat row + 4 Icon helpers + dead useMemo block deleted |
| `frontend/src/components/BriefCard.tsx` | UPDATED | Replaced inline `formatRelative` with import |
| `frontend/src/components/FlagsPanel.tsx` | UPDATED | Same |
| `frontend/src/components/AlertsPanel.tsx` | UPDATED | Same |

## Deviations from Plan
None — implemented exactly as planned. The plan's per-task code blocks compiled on first build with zero changes.

## Issues Encountered
None blocking. GateGuard pre-edit hook required fact restatement before each Write/Edit (no rejections, just friction).

## Tests Written
N/A — repo has no test framework. Plan calls for manual test matrix; left to operator browser run.

## Next Steps
- [ ] Manual browser test against the plan's test matrix (vacant beds, mixed adherence, ICU styling, unassigned footer, mobile tap-to-toggle, edge popover clamp).
- [ ] Seed `patients.dispenser_id` with `common-1`..`common-6` / `icu-1` to populate the map. Existing patients with legacy ids (e.g. `pi-001`) appear in the unassigned footer until reassigned.
- [ ] Optional: extract `BEDS` array to `lib/beds.ts` if/when an admin dropdown picker is added on `/patients/[id]`.
- [ ] Out of scope but flagged: dose schedule field would unlock real "Next: <med> at HH:MM" copy.
- [ ] Unrelated: Supabase advisor flagged RLS disabled on `alerts`, `agent_briefs`, `agent_flags` — address when auth lands.
