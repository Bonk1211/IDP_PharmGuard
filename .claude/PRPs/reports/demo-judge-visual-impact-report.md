# Implementation Report: Judge-Facing Demo Visual Impact Upgrade

## Summary
Implemented the judge-facing visual upgrade of the guided dispense flow (`/dispensers/[id]`). The three AI verification moments now produce large animated verdicts: face recognition gets a pop-in "Identity verified / Not recognized" stamp over the snapshot plus a count-up similarity gauge; pill identification gets a hero card with the detected pill name in display type, an animated confidence bar, expected-vs-detected chips, and a verdict stamp over the annotated tray snapshot; intake verification gets a horizontal FSM journey strip with live per-step circles, a hold-progress ring, and a green success sweep before the confirmation modal. Operator/debug noise (rotate-test grid, env-var hints, HW-stub chip) was moved out of the judge path.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large (but smooth — no architectural surprises) |
| Confidence | 8/10 | Implemented single-pass |
| Files Changed | 5 | 5 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | CSS keyframes (`verdict-pop`, `bar-grow`, `ring-fill`, `sweep-success`) | Complete | Also added `cross-draw` (✗ companion to existing `check-draw`) |
| 2 | `VerdictStamp` component | Complete | |
| 3 | `ConfidenceGauge` component | Complete | |
| 4 | `FsmJourney` component | Complete | Step names derived from backend `IntakeState`, never hardcoded |
| 5 | Face verify verdict (step 1) | Complete | Deviated: figures kept at `aspect-[4/3]` (see Deviations) |
| 6 | Pill verify hero (step 3) | Complete | |
| 7 | Intake journey strip (step 4) | Complete | 700 ms modal delay so the sweep plays first; timer cleared on unmount |
| 8 | Noise purge | Complete | RotateTestBar → AdvancedSheet; Layer2 disabled → `null`; HW pill only when stubbed (relabeled "sim"); msg toast restyled |
| 9 | StepBar verdict tones | Complete | New optional `stepTones` prop, defaults to `[]` |
| 10 | Lint + build | Complete | Build + type-check pass; `next lint` not runnable (see Issues) |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass (via build) | `next build` type-check: zero errors. `next lint` is unconfigured in this repo (interactive setup prompt) — skipped per repo state |
| Unit Tests | N/A | Repo has no test runner (per CLAUDE.md); none added by design |
| Build | Pass | `npm run build` succeeds; `/dispensers/[id]` bundle 20.4 kB |
| Integration | N/A | Requires physical device / Pi |
| Edge Cases | Code-reviewed | Null similarity, null intake, empty history, empty tray all guarded; browser pass still pending (see Next Steps) |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `frontend/src/components/VerdictStamp.tsx` | CREATED | +115 |
| `frontend/src/components/ConfidenceGauge.tsx` | CREATED | +85 |
| `frontend/src/components/FsmJourney.tsx` | CREATED | +205 |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATED | ~+190 / −115 |
| `frontend/src/app/globals.css` | UPDATED | +62 |

## Deviations from Plan
1. **Face-verify figures not enlarged** — plan suggested taller-than-`aspect-[4/3]` figures. Kept the existing aspect ratio: the `lg` VerdictStamp overlay + 3xl count-up gauge deliver the impact without risking the banner-row layout. WHY: lower regression risk on an already-dense card.
2. **CameraTile footer enlarged globally** — plan asked for cam-1's instruction text only, but the footer lives in the shared `CameraTile`; both cams now use `text-sm` (both are judge-visible, so this is strictly an improvement).
3. **Extra `cross-draw` keyframe** — needed an animated ✗ for fail verdicts; mirrors `check-draw` exactly.
4. **AIIntakeCheck simplification** — removed its `headline`/`sub`/`failed` locals along with the headline block (now owned by FsmJourney); checklist + footer chips kept intact.

## Issues Encountered
- `npm run lint` (`next lint`) opens an interactive ESLint setup prompt — the repo has no ESLint config, so lint cannot run non-interactively. Type safety was validated through `next build` instead. Setting up ESLint was out of scope.
- Pre-existing CSS build warning (`@import` of Google Fonts after the tailwind import in `globals.css`) — present before this change, untouched.

## Tests Written
None — repository has no test infrastructure (explicitly out of scope per plan).

## Next Steps
- [ ] Manual judge run-through on the real device (checklist in the plan: verdict stamps, count-ups, journey strip, sweep → modal, no debug tooling visible)
- [ ] Code review via `/code-review`
- [ ] Create PR via `/prp-pr`
