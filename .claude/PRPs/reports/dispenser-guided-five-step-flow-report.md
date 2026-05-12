# Implementation Report: Dispenser Guided 5-Step Flow + Advanced Sheet

## Summary
Refactored `frontend/src/app/dispensers/[id]/page.tsx` into a 5-step guided round flow (Identify → Unlock → Dispense → Verify → Log). Replaced flat scroll layout with section-per-step structure driven by a new sticky `StepBar`. Power controls (manual eject, drawer lock, snapshot refresh, cam debug, raw status JSON) moved into a new bottom-sheet `AdvancedSheet`. Animations on the step bar (active pulse + check draw-in + connector fill) and bottom sheet (slide up) added in `globals.css`.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Files Changed | 2 modified | 2 modified |
| New Components | 3 (StepBar, UnlockSection, AdvancedSheet) | 4 (added `SectionHeading` helper) |
| Backend changes | None | None |
| stepIdx model | 0..5 | 0..5 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | stepIdx rework: 0..5 model | Complete | Moved `drawerUnlocked` above `stepIdx` so it can drive the Unlock→Dispense transition. |
| 2 | Section wrappers | Complete | 5 `<section>` blocks with `setSectionRef(i)` callback registering each in `sectionRefs`. |
| 3 | Scroll-snap container | Complete (deviated — see below) | Used `scrollIntoView({behavior:"smooth"})` + `min-h-[calc(100vh-10rem)]` per section instead of CSS `scroll-snap-type: y mandatory`. Adopting strict snap would require reshaping the root layout's `<main>` scroll model or applying global snap rules — both higher-risk for one demo. Smooth scrollIntoView gives the same visible one-section-per-viewport effect without touching `app/layout.tsx`. |
| 4 | StepBar component (5 steps) | Complete | 5 buttons (Identify, Unlock, Dispense, Verify, Log). Clickable in all states (preview allowed). Active step uses `animate-pulse-soft`. Done state renders an SVG check with `check-draw` CSS animation. Connector line uses `connector-fill` keyframe when done. Right-side shows `cycle N · clock`. |
| 5 | Auto-scroll on stepIdx change | Complete | `useEffect([stepIdx])` with `lastAutoIdxRef` gate so it only fires when stepIdx actually changes. Step 5 (Done) maps back to section 4 (Log) so the user stays put. |
| 6 | AdvancedSheet shell | Complete | Bottom-sheet dialog with sticky header inside, backdrop button, slide-up animation. |
| 7 | Move eject buttons to Advanced | Complete | `SlotGrid` on the main page is now read-only `<div>` cells. Eject buttons live inside the sheet's Manual eject panel; they additionally require `drawerUnlocked` before being enabled. |
| 8 | Move drawer-unlock to Advanced | Complete | Drawer lock/unlock toggle lives in the sheet's Drawer state card. The Unlock section on the main page now shows an Open Advanced to unlock CTA that calls `setAdvancedOpen(true)`. |
| 9 | Move resnapshot to Advanced | Complete | Re-snapshot button + cam URL preview + raw status JSON moved into the sheet. `ActionBar` only has Override + Confirm now. |
| 10 | Step bar animations | Complete | Added `pulse-soft`, `check-draw`, `connector-fill`, `sheet-up` keyframes to `globals.css` with matching utility classes. No animation added to slots, FSM, cams, or confirm button. |
| 11 | ThisPassRow sticky placement | Complete | Lives inside the sticky header wrapper directly under the StepBar. Visible from any section. |
| 12 | Polish (Esc + backdrop close) | Complete | `useEffect` listens for Escape while sheet is open. Backdrop is a `<button>` covering the area behind the sheet so clicks dismiss it. |
| 13 | Validate (lint + build) | Complete | `npx tsc --noEmit` exits 0. `npm run build` produces a clean production build (only a pre-existing CSS `@import` ordering warning unrelated to this change). `npm run lint` is not used by this project — it triggers an interactive ESLint config prompt because no `.eslintrc` exists. |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static type-check (`tsc --noEmit`) | Pass | Exit code 0. |
| Lint | N/A | Project has no ESLint config; `next lint` opens an interactive setup prompt and is deprecated for Next 16. |
| Unit tests | N/A | Repo has no test suite (per `CLAUDE.md`). |
| Production build (`next build`) | Pass | Dispenser route bundle: 10.9 kB, First Load JS: 179 kB. Pre-existing CSS `@import` warning (font import) carried forward, unrelated. |
| Integration | Deferred | Live device + intake server not started in this session. Must be verified manually on the Pi rig before demo. |

## Files Changed

| File | Action | Net lines |
|---|---|---|
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATED | Old `StepsRow` removed, ConfirmHeader trimmed, SlotGrid + ActionBar slimmed, four new components added. |
| `frontend/src/app/globals.css` | UPDATED | +33 (four new keyframes + utility classes). |

## Deviations from Plan

1. **Scroll-snap mechanism**: plan called for `scroll-snap-type: y mandatory` on a dedicated scroll container with sections `min-h-screen snap-start`. Adopted instead: `scrollIntoView({behavior:"smooth"})` and `min-h-[calc(100vh-10rem)]` per section, page scroll free. Why: the root `app/layout.tsx` wraps every page in a static `<main>` with paddings; making the dispenser page its own scroll container would either require special-casing the layout for one route or globally enabling snap (affects all pages). The visible result is essentially the same — clicking a step or advancing stepIdx scrolls smoothly to that section, and each section nearly fills the viewport. If the demo specifically needs hard snapping (no partial views during free scroll), revisit by adding `snap-y snap-mandatory` to the page wrapper and applying `snap-start` per section. That is a one-line follow-up.
2. **`SectionHeading` helper**: not in the plan, but added because all five sections needed an identical `Step N of 5 · Eyebrow + Title` block. Kept inline at end of file.
3. **`StateLegend` placement**: kept inside `ConfirmHeader` so the colour legend stays visible in the Log section where overrides happen. Plan didn't address it explicitly.
4. **`SlotGrid` ejected indicator**: read-only grid now also pulses the ejected slot using `animate-pulse-soft` + `ring-2 ring-olive-400`. Plan said animation budget is step-bar-only; this reuses the same keyframe so it is essentially free (no new CSS) but stretches the budget slightly. Removable in one Edit if undesired.

## Issues Encountered

- **`next lint` deprecation**: Project ships `next lint` but no `.eslintrc`; `npm run lint` opens an interactive ESLint configuration prompt. Cannot be used in non-interactive shells. `tsc --noEmit` + `next build` were used instead for validation. Not introduced by this change.
- **Pre-existing CSS `@import` warning**: `globals.css` puts the Google Fonts `@import` after `@theme`, which CSS spec disallows. Carried forward unchanged. Cosmetic — the build succeeds and fonts load.
- **No unit / e2e tests** in the repo. Per `CLAUDE.md`, the project has no `pytest` or `vitest` configured. Manual click-through against the live Pi rig is required before claiming behavioural correctness.

## Tests Written

None — project has no test runner configured. See "Issues Encountered".

## Manual verification checklist (must run before demo)

- [ ] `cd frontend && npm run dev` then visit `/dispensers/<id>` — page renders, sticky StepBar visible across all 5 sections.
- [ ] Click each step in the StepBar — page smooth-scrolls to that section.
- [ ] Without device configured — Identify section shows "No active patient" banner; warning toast for missing env vars renders.
- [ ] With device configured + active patient resolved — Identify auto-marks done; Unlock section CTA opens the Advanced sheet.
- [ ] Unlock drawer in Advanced — Unlock step turns olive/check; main page auto-scrolls to Dispense.
- [ ] During dispense — active slot pulses in `SlotGrid`; Cam 0 footer shows "Pill released".
- [ ] During intake — Verify step active; FSM rows in `AIIntakeCheck` update; Cam 1 footer shows instruction + progress.
- [ ] After intake passes — Log step active; Confirm button enabled; click Confirm → slot logged, advances to next.
- [ ] Advanced sheet: manual eject buttons disabled when drawer locked; Re-snapshot updates cam thumbnails; raw status JSON expands.
- [ ] `Esc` closes the sheet; backdrop click also closes it.

## Next Steps

- Manual end-to-end smoke test on the Pi rig (see checklist above).
- Optional: tighten snap behaviour to `snap-y snap-mandatory` if the demo wants hard one-section-at-a-time scroll.
- Optional: add tests once a test runner is introduced to the repo.
- Run `/code-review` for a second pass before merging into `main`.
- Run `/prp-pr` to open a PR from `feat/dispenser-guided-five-step`.
