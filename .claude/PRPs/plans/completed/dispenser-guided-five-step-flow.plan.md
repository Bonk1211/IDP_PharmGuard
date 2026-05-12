# Dispenser Page — Guided 5-Step Flow + Advanced Sheet

## Goal

Redesign `frontend/src/app/dispensers/[id]/page.tsx` for demo/judge audience. Replace flat scroll layout with a 5-step guided flow driven by a sticky top step bar. Sections become full-viewport snap targets. Power controls move to a dismissable bottom sheet so the default view stays calm during live demo.

## Scope

- Frontend only. No backend route changes, no `lib/api.ts` / `lib/device.ts` signature changes (may add small read helpers if needed).
- All work inside `frontend/src/app/dispensers/[id]/page.tsx` and a small handful of new sibling components under `frontend/src/components/` or co-located inside the page file (match existing pattern — page currently keeps sub-components inline).
- Keep current visual language (olive / sand / status tokens, `rounded-2xl`, Tailwind v4). No new design system.

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| Audience | Demo / judge |
| North star | Guided round flow |
| Hero | 5-step progress timeline |
| Step model | `Identify → Unlock → Dispense → Verify → Log` (5 steps) |
| Identify step | Auto — marks done when `activePatient` resolves |
| Scroll behavior | Full-viewport snap (`scroll-snap-y mandatory`, sections `min-h-screen`) |
| Step bar click | Scroll to any step (preview future steps allowed, read-only) |
| Auto-scroll | Page auto-snaps to active step when `stepIdx` advances |
| Animation budget | Step bar only — active pulse, draw-in check on complete |
| Power controls | Bottom-sheet "Advanced" panel, dismissable |
| Advanced contents | Manual eject (per slot) + drawer lock toggle + snapshot refresh + cam debug |
| Override | Stays inline in `ActionBar` |
| Reset round | Not in scope |
| Visual style | Keep current UI tokens, no big restyle |

## New step model (extends existing `stepIdx`)

Current `stepIdx` logic in page lines ~273-281 returns 0..4 over 4 conceptual steps. Rework to 0..5 over 5 conceptual steps so the step bar maps 1:1.

```
0 = Identify   — no activePatient yet (loading or none assigned)
1 = Unlock     — activePatient resolved, drawer still locked
2 = Dispense   — drawer unlocked, intake not running, no result yet
3 = Verify     — intake.running === true
4 = Log        — intake.result === "passed" && currentSlot not yet confirmed
5 = Done       — currentSlot in confirmedSlots (or no remaining slots)
```

`Identify` auto-advances; no explicit "confirm patient" click. `Unlock` advances when `status.is_unlocked` becomes true (drawer toggle is in Advanced sheet, but step bar still reads device status).

Mapping note: current `StepsRow` is 4 columns. Replace with `StepBar` (5 columns) — old `StepsRow` deleted.

## Files to change

### Modify
- `frontend/src/app/dispensers/[id]/page.tsx`
  - Replace `StepsRow` with new `StepBar` (sticky top, 5 steps).
  - Wrap page body in scroll-snap container.
  - Each major block (`PatientBanner`, Dispense, Verify, Log) becomes a `<section>` with `min-h-screen snap-start scroll-mt-…` + a `ref` registered on mount.
  - Add `sectionRefs` ref-array + `scrollToStep(idx)` callback wired to `StepBar` click.
  - Add `useEffect` that auto-scrolls to current `stepIdx` section when it changes.
  - Extract `AdvancedSheet` component (or co-locate). State: `advancedOpen: boolean`. Sheet contents render `<EjectGrid />`, `<DrawerLockToggle />`, `<SnapshotPanel />`, `<CamDebug />`.
  - Remove eject buttons + drawer-unlock button from `SlotGrid` — make `SlotGrid` read-only (visual state only).
  - Remove "Resnapshot" button from `ActionBar` — it moves into Advanced.
  - Rework `stepIdx` `useMemo` to the 6-state model above (0..5).
  - Add sticky bottom "Advanced ▲" trigger button (only when `configured`).

### No change (verify wiring still works)
- `frontend/src/lib/device.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/swr.ts` — all current calls (`manualEject`, `setDrawer`, `fetchSnapshot`, `streamUrl`, etc.) reused as-is; only their call sites move.

### New helpers (optional, only if useful)
- A tiny `useSectionScroll(stepIdx)` hook if the inline `useEffect` grows past ~30 lines. Keep inline first; refactor only if needed.

## Component sketches

### `StepBar` (replaces `StepsRow`)
```
┌──────────────────────────────────────────────────────────────────┐
│ 1 Identify --- 2 Unlock --- 3 Dispense --- 4 Verify --- 5 Log    │
│   Maria         open         slot 3         FaceMesh         -   │
└──────────────────────────────────────────────────────────────────┘
```
- Sticky `top-0 z-30`, `bg-white/80 backdrop-blur`, border-bottom.
- Each step is a button: `onClick={() => scrollToStep(i)}`. Always clickable (preview allowed).
- Visual state per step: `pending | active | done`.
  - `pending`: muted, no animation.
  - `active`: olive ring + subtle pulse (`animate-pulse-soft` — define in globals.css).
  - `done`: olive fill + check icon, check drawn-in via CSS `stroke-dasharray` transition on mount of `done` state.
- Connector line between steps fills olive as `done` count grows.
- Right-aligned clock keeps existing `fmtClock(now)`.

### Section wrapper convention
```tsx
<section
  ref={(el) => { sectionRefs.current[i] = el; }}
  id={`step-${i}`}
  className="min-h-screen snap-start scroll-mt-20 py-8"
>
  ...
</section>
```
- Outer container: `<div className="snap-y snap-mandatory h-screen overflow-y-auto">…</div>` — note this changes the page's scroll container. Test that the navbar (if any) still behaves.
- `scroll-mt-20` accounts for sticky step bar height.

### Section contents (per step)
1. **Identify section** — `PatientBanner` + `nextRound` summary, no controls.
2. **Unlock section** — Status card (drawer locked/unlocked), big "Open Advanced to unlock" CTA pointing at bottom sheet. (Drawer toggle itself lives in Advanced; this section just narrates.)
3. **Dispense section** — `SlotGrid` (read-only) + Cam 0 (tray). Pulsing active slot indicator.
4. **Verify section** — `AIIntakeCheck` + Cam 1 (patient). FSM step list + hold progress bar live here.
5. **Log section** — `ConfirmHeader` + sticky `ActionBar` (Confirm + Override inline).

Existing `ThisPassRow` (per-slot strip) is shown as a thin sticky strip under `StepBar` so audience sees per-slot progress in all stages. Default = keep sticky.

### `AdvancedSheet`
- Trigger: floating button bottom-right `Advanced ▲`. Hidden when `!configured`.
- Slide up from bottom: `fixed inset-x-0 bottom-0 max-h-[70vh] rounded-t-3xl bg-white shadow-2xl translate-y-… transition-transform`.
- Sections inside:
  - **Manual eject grid** — 10 small buttons reusing existing `onEject(slot)`. Disabled when `!drawerUnlocked` or `busy === "eject-N"`.
  - **Drawer lock toggle** — existing `onUnlockDrawer()` handler. Big switch UI.
  - **Snapshot refresh** — existing `onResnapshot()` + two thumbnail previews.
  - **Cam debug** — show `cam0Url` / `cam1Url` raw strings, last `status` JSON (collapsed `<details>`).
- Close: backdrop click or `Esc` key. Trap focus while open (basic; can defer if scope creeps).

## Animation spec (step bar only)

Tailwind v4 — add custom keyframes in `frontend/src/app/globals.css`.

```css
@keyframes pulse-soft {
  0%, 100% { box-shadow: 0 0 0 0 rgba(132,150,80,0.45); }
  50%      { box-shadow: 0 0 0 6px rgba(132,150,80,0); }
}
.animate-pulse-soft { animation: pulse-soft 1.8s ease-in-out infinite; }

@keyframes check-draw {
  from { stroke-dashoffset: 24; }
  to   { stroke-dashoffset: 0;  }
}
.check-draw path { stroke-dasharray: 24; animation: check-draw 0.4s ease-out forwards; }
```

No animation on slots, FSM rows, cams, confirm button. Out of scope this round.

## Step-by-step implementation order

1. **stepIdx rework** — bump model to 0..5; verify nothing else reads stale values. Add temporary console.log, walk through a manual round to confirm transitions.
2. **Section wrappers** — split current render tree into 5 `<section>` blocks. No styling yet, structure only. Verify page still renders the same content top to bottom (without snap container yet).
3. **Scroll-snap container** — add `<div className="snap-y snap-mandatory h-screen overflow-y-auto">` wrapper. Each section gets `min-h-screen snap-start`. Verify scroll feel in Chrome + Safari. Watch out for navbar height — adjust `h-[calc(100vh-…)]`.
4. **StepBar** — build new sticky component. Render 5 steps with `pending|active|done` visuals. Wire `onClick` to `scrollToStep(i)` using `sectionRefs.current[i]?.scrollIntoView({behavior:'smooth', block:'start'})`.
5. **Auto-scroll on state change** — `useEffect([stepIdx], () => scrollToStep(stepIdx))`. Add `lastAutoIdx` ref to avoid fighting manual scroll (only auto-scroll when `stepIdx` actually changes, not on every render).
6. **AdvancedSheet shell** — add `advancedOpen` state, trigger button, sheet container with transform transition. Empty body first.
7. **Move eject buttons** — pull eject UI out of `SlotGrid` into Advanced sheet's `EjectGrid` sub-block. `SlotGrid` becomes pure read-only color-coded grid. Verify `onEject` still wires.
8. **Move drawer-unlock** — pull the unlock button out of `SlotGrid`/wherever it sits, into Advanced sheet. Keep `onUnlockDrawer` handler in page.
9. **Move resnapshot** — pull from `ActionBar` into Advanced sheet. `ActionBar` now only has Confirm + Override.
10. **Step bar animations** — wire `animate-pulse-soft` to active step, `check-draw` to done state. CSS in `globals.css`.
11. **ThisPassRow placement** — decide sticky-under-StepBar vs per-section. Default sticky.
12. **Polish pass** — keyboard `Esc` closes sheet, backdrop click closes sheet, focus management.

Each step should leave the page in a runnable state — `npm run dev` works, manual click-through works.

## Risks / gotchas

- **Scroll container change**: switching from page-level scroll to a dedicated scroll container breaks anything that relies on `window.scrollY` or `position: sticky` outside the container. Check `Navbar` and any modals.
- **Auto-scroll fight**: if `stepIdx` flickers (e.g. `intake.running` toggles briefly), auto-scroll will yank the viewport. Debounce or gate auto-scroll behind `stepIdx` actually crossing a threshold.
- **Mobile**: full-viewport snap on phones means each section is one phone screen. Verify content fits or allow inner scroll inside sections.
- **`min-h-screen` + sticky**: sticky step bar inside scroll container — anchor it to the container, not the page. `position: sticky; top: 0;` works inside `overflow-y-auto` parents.
- **Existing `StepsRow` + `ThisPassRow`**: their styles likely overlap visually with the new sticky `StepBar`. Audit spacing.
- **No tests in repo** (CLAUDE.md): validation is manual click-through; budget time for it.

## Validation checklist

Run after each major step. Don't claim done until all green.

- [ ] `cd frontend && npm run dev` boots without console errors.
- [ ] Visit `/dispensers/<id>` — page renders, step bar visible, 5 steps shown.
- [ ] Step bar click on each step → smoothly scrolls to that section.
- [ ] Without device configured (`NEXT_PUBLIC_DEVICE_URL` unset) → graceful empty state, no crash.
- [ ] With device configured + active patient → Identify auto-marks done.
- [ ] Toggle drawer in Advanced → Unlock step marks done.
- [ ] Trigger dispense → Dispense section auto-scrolls into view (or stays if user scrolled away — confirm chosen behavior).
- [ ] Intake running → Verify step active, FSM rows update.
- [ ] Intake passed → Log step active, Confirm button enabled.
- [ ] Click Confirm → slot logged, advances to next slot or done state.
- [ ] Advanced sheet: eject 1 slot, lock/unlock drawer, refresh snapshot — all still work.
- [ ] `Esc` closes Advanced sheet.
- [ ] No regression on `ActionBar` Confirm + Override.
- [ ] `npm run lint` clean.
- [ ] Manual test on Safari + Chrome at 1440×900 + iPhone-sized viewport.

## Out of scope (explicit)

- Reset-round feature.
- Override moving out of ActionBar.
- New animations beyond step bar.
- Visual restyle of slots, cams, FSM, banner.
- Wizard-style URL routes per step.
- Backend changes.
- Test suite (none exists in repo).

## Report

When done, write outcome to `.claude/PRPs/reports/dispenser-guided-five-step-flow-report.md`: what shipped, what skipped, what surprised. Include screenshots of step bar in `pending/active/done` states and Advanced sheet open.
