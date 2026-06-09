# Implementation Report: Nurse-Voice Guidance During Dispense + Intake Verification

## Summary
Extended the existing ElevenLabs nurse voice (previously auth-phase only) into the Dispense and Intake-verification phases of the guided round. All changes are additive and confined to one frontend component, reusing the existing `speak()` → `/api/device/tts` → ElevenLabs path. No backend changes.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Small | Small |
| Confidence | 9/10 | Implemented exactly as planned |
| Files Changed | 1 | 1 (`frontend/src/app/dispensers/[id]/page.tsx`, +81 lines) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Add 3 static script fns (`dispensedScript`, `wrongPillScript`, `intakeStepScript`) | ✅ Complete | Placed after `greetingScript`. |
| 2 | Speak "pill dispensed" line on eject + reset wrong-pill guard | ✅ Complete | `void speak(dispensedScript(expected))` before the verify `setTimeout`. |
| 3 | Wrong/extra-pill alert effect (once per eject, viewIdx 2) | ✅ Complete | `wrongPillSpokenRef`-guarded; fires on mismatch or unauthorized. |
| 4 | Intake FSM step-change prompt effect (milestone-paced) | ✅ Complete | `lastSpokenStepRef`-guarded; resets on `!running`. |
| 5 | Marked hook comment for the (unselected) terminal-result line | ✅ Complete | Comment above the step-change effect. |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis (type-check) | ✅ Pass | Ran via `next build` ("Linting and checking validity of types") — zero errors on changed file. |
| Lint (`next lint`) | ⚠ N/A | ESLint never configured in this repo (`next lint` drops into interactive setup). Build's type/lint step passed cleanly; not auto-configuring per scope. |
| Unit Tests | ⚠ N/A | No JS/TS test runner configured (`CLAUDE.md`: "no test suite"). |
| Build | ✅ Pass | `npm run build` succeeded; `/dispensers/[id]` 17.7 kB. |
| Integration | ⚠ N/A | Requires live Pi + ngrok + ElevenLabs key — manual checklist below. |
| Edge Cases | ✅ Pass (by design) | Soft-fail `speak()`, ref guards, null-name fallbacks — see plan. |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATED | +81 / -0 |

## Deviations from Plan
None — implemented exactly as planned. Line offsets shifted as edits were applied (expected); all anchors re-verified against current file state before each edit.

## Issues Encountered
- `next lint` is not configured in this repo and launches an interactive ESLint setup prompt. Resolved by relying on the type/lint pass that `next build` performs (which completed with no errors on the changed file). Did not auto-configure ESLint — out of scope and would alter repo tooling.
- A pre-existing CSS `@import` ordering warning in `globals.css` surfaced during build; unrelated to this change.

## Tests Written
None — no test runner exists. New functions are pure and were validated by type-check + build. Manual verification checklist:
- [ ] Identify still speaks centering + greeting (no regression).
- [ ] Eject correct pill → hear `dispensedScript`.
- [ ] Eject wrong/extra pill → hear `wrongPillScript` once; re-eject → again.
- [ ] Intake watch → one line per FSM step (READY/SWALLOW/DONE), no repeats.
- [ ] Unconfigured/offline device → silent, no crash.
- [ ] No two lines overlap (new `speak()` cancels prior Audio).

## Next Steps
- [ ] Manual run on the cabinet (device-configured) to confirm audio timing.
- [ ] Code review via `/code-review`.
- [ ] Create PR via `/prp-pr`.
- [ ] (Optional) Re-enable terminal "intake result" congrats — ~8 lines at the Task-5 hook.
