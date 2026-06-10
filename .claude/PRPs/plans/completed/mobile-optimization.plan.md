# Plan: Mobile Optimization (Frontend)

## Summary
Make the PharmGuard caregiver dashboard (Next.js 15 / Tailwind v4) usable on phones and tablets. The codebase is desktop-first with partial responsive coverage; this plan closes the gaps: a navbar that overflows on small screens, an 8-column patient table and a 10-column inventory heatmap with no horizontal-scroll fallback, fixed grid columns, iOS input auto-zoom, and oversized landing-page hero elements.

## User Story
As a nurse/caregiver on the ward, I want the dashboard to work on my phone, so that I can check dispensing status, patient adherence, and alerts without finding a workstation.

## Problem → Solution
Desktop-only layouts break below ~820px (nav overflow, clipped tables, crushed grids) → All routes render correctly and are touch-usable at 375px (iPhone SE/13 width) and 768px (tablet), with no horizontal page scroll except inside designated scroll containers.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form: "mobile optimization")
- **PRD Phase**: N/A
- **Estimated Files**: 9 modified, 0 created

---

## UX Design

### Before
```
iPhone 375px wide:
┌─────────────────────────────┐
│ [Logo][Dash][Assist][Inv][D… │  ← navbar tabs overflow, icons pushed off
├─────────────────────────────┤
│ │Name│Gen│Age│Cond│Last│Sta… │  ← patient table clipped, no h-scroll
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← inventory heatmap cells ~8px wide
│ [slot][slot][slot][slot][sl] │  ← 5-col slot grid, unreadable cells
└─────────────────────────────┘
Tapping a text input → iOS Safari zooms page (14px font)
```

### After
```
iPhone 375px wide:
┌─────────────────────────────┐
│ [Logo]              [🔔][☰] │  ← hamburger below md breakpoint
│ ┌─────────────────────────┐ │
│ │ Dashboard               │ │  ← full-width dropdown panel
│ │ Assistant               │ │
│ │ Inventory  …            │ │
│ └─────────────────────────┘ │
├─────────────────────────────┤
│ ◀═ Name│Gender│Age│Cond… ═▶ │  ← table scrolls horizontally in card
│ ◀═ heatmap scrolls ═▶       │  ← min-width grid inside overflow-x-auto
│ [slot][slot]                │  ← 2-col slot grid on phones
│ [slot][slot]                │
└─────────────────────────────┘
Inputs render ≥16px on touch → no iOS zoom
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Navbar < md | 5 tabs overflow horizontally | Hamburger toggles dropdown panel; tabs hidden | Settings/avatar stay; bell stays |
| Patients table | Clipped at viewport edge | Horizontal scroll inside the rounded card | `overflow-x-auto` + `min-w` |
| Inventory heatmap | 10 cols crushed to slivers | Horizontal scroll; name column 120px on phones | header strip + rows share wrapper |
| Patient detail slot grid | Always 5 columns | 2 cols → 3 (sm) → 5 (md) | mirrors dispenser SlotGrid pattern |
| Any text input/select | iOS zooms on focus (14px) | 16px on touch devices, no zoom | single CSS rule in globals.css |
| Landing hero | 3rem headline + 4 floating chips cramped | Smaller base headline; 2 chips hidden < sm | chips are decorative |
| Page gutter | fixed `px-6` | `px-4 sm:px-6` | LayoutShell + Navbar + landing sections |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/components/Navbar.tsx` | all (89) | Component being rewritten for mobile menu |
| P0 | `frontend/src/components/LayoutShell.tsx` | all (20) | Page gutter lives here |
| P0 | `frontend/src/app/patients/page.tsx` | 126–256 | Header row, search row, table to wrap |
| P0 | `frontend/src/app/inventory/page.tsx` | 207–260 | Heatmap grids (two `grid-cols-[180px_…]` strips) |
| P1 | `frontend/src/app/patients/[id]/page.tsx` | 373–470 | `grid-cols-5` slot magazine |
| P1 | `frontend/src/components/AgentChat.tsx` | 70–130, 245–261 | Chat container height + input row |
| P1 | `frontend/src/app/page.tsx` | 60–143 | Hero headline + FeatureChips |
| P1 | `frontend/src/app/globals.css` | all (145) | Where the iOS input rule goes; existing keyframes |
| P2 | `frontend/src/app/dispensers/[id]/page.tsx` | 1696–1810, 3011–3099 | Reference: already-responsive SlotGrid + flex-wrap StepBar — the patterns to mirror |
| P2 | `frontend/src/app/dashboard/page.tsx` | all (55) | Already responsive (`lg:grid-cols-[7fr_3fr]`); only verify |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| iOS Safari input zoom | WebKit behavior (well-known) | Safari zooms the page when a focused input's font-size < 16px; fix with `font-size: 16px` on inputs under a `(pointer: coarse)` media query |
| Next.js App Router viewport | Next.js docs | App Router injects `<meta name="viewport" content="width=device-width, initial-scale=1">` by default — `layout.tsx` needs no change |
| Tailwind v4 | Already in repo (`@import "tailwindcss"` + `@theme`) | No config file; custom CSS goes straight into `globals.css` |

No further external research needed — everything else uses established internal Tailwind patterns.

---

## Patterns to Mirror

### RESPONSIVE_GRID (canonical in-repo pattern)
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:1725
<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
```

### TWO_COLUMN_COLLAPSE
```tsx
// SOURCE: frontend/src/app/dashboard/page.tsx:38
<div className="grid grid-cols-1 gap-6 lg:grid-cols-[7fr_3fr]">
```

### FLEX_WRAP_TOOLBAR
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:3025
<div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-2.5">
```

### HIDDEN_BELOW_BREAKPOINT (landing header already does this)
```tsx
// SOURCE: frontend/src/app/page.tsx:37
<nav className="hidden items-center gap-7 text-sm text-gray-600 md:flex">
```

### SCROLLABLE_OVERFLOW_REGION
```tsx
// SOURCE: frontend/src/components/AgentChat.tsx:240-241
<div className="my-2 overflow-x-auto">
  <table className="w-full border-collapse text-[12px]" {...p} />
```

### ACTIVE_NAV_TAB (reuse styling in mobile panel)
```tsx
// SOURCE: frontend/src/components/Navbar.tsx:48-52
className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
  isActive
    ? "bg-olive-700 text-white shadow-sm"
    : "text-gray-500 hover:bg-sand-100 hover:text-gray-900"
}`}
```

### CSS_ADDITIONS (globals.css house style: plain CSS blocks with comment headers)
```css
/* SOURCE: frontend/src/app/globals.css:46-56 — comment-header + plain rule style */
/* Scrollbar */
::-webkit-scrollbar {
  width: 6px;
}
```

### CLIENT_STATE (for the menu toggle)
```tsx
// SOURCE: frontend/src/app/patients/page.tsx (top of file) — "use client" + useState
"use client";
import { useState } from "react";
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/components/Navbar.tsx` | UPDATE | Add hamburger + mobile dropdown; hide tab row below `md` |
| `frontend/src/components/LayoutShell.tsx` | UPDATE | `px-6` → `px-4 sm:px-6` gutter |
| `frontend/src/app/patients/page.tsx` | UPDATE | Wrap table in `overflow-x-auto` + `min-w`; let search/filter row wrap |
| `frontend/src/app/inventory/page.tsx` | UPDATE | Scrollable heatmap wrapper; narrower name column on phones |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATE | Slot magazine `grid-cols-5` → responsive |
| `frontend/src/components/AgentChat.tsx` | UPDATE | Mobile-friendly chat height (`dvh`-based) |
| `frontend/src/app/page.tsx` | UPDATE | Hero headline scale, hide 2 chips < sm, gutters |
| `frontend/src/app/globals.css` | UPDATE | 16px touch-input rule (iOS zoom fix) |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE (verify-first) | Spot-fix only if a section fails 375px check; most grids already responsive |

## NOT Building

- No separate mobile app or PWA manifest / service worker
- No bottom tab bar — keep single navbar pattern
- No card-per-row redesign of the patients table (horizontal scroll is the chosen approach)
- No touch/drag rework of `useSlotDnd` drag-and-drop (mouse DnD stays as-is; slot editing still works via tap)
- No backend / `backend/` changes
- No new dependencies (no headlessui, no radix — hand-rolled toggle)
- No dark mode, no PWA offline, no performance budget work (Lighthouse perf is out of scope; layout only)

---

## Step-by-Step Tasks

### Task 1: Navbar mobile menu
- **ACTION**: Rewrite `Navbar.tsx` for small screens.
- **IMPLEMENT**:
  - Add `useState(false)` for `menuOpen`; close on `pathname` change (`useEffect` on `pathname`).
  - Desktop tab row: add `hidden md:flex` to the existing `<nav>` (line 41).
  - Right-side cluster: keep bell; wrap settings button in `hidden sm:block`; keep avatar; append a hamburger `<button className="rounded-full p-2 text-gray-500 hover:bg-sand-100 md:hidden" aria-label="Open menu" aria-expanded={menuOpen}>` with a 3-line / X svg toggle.
  - Mobile panel: below the header row, render when `menuOpen`: `<nav className="border-t border-sand-100 px-4 pb-4 pt-2 md:hidden">` mapping the same `NAV_ITEMS`, each link `block rounded-xl px-4 py-3 text-sm font-medium` with the ACTIVE_NAV_TAB conditional classes (block shape instead of pill).
  - Header inner div: `px-6` → `px-4 sm:px-6`.
- **MIRROR**: HIDDEN_BELOW_BREAKPOINT, ACTIVE_NAV_TAB, CLIENT_STATE.
- **IMPORTS**: `import { useEffect, useState } from "react";` (file already has `"use client"`, `Link`, `usePathname`).
- **GOTCHA**: `isActive` uses `pathname.startsWith(item.href)` and Dashboard's href is `/` — `startsWith("/")` matches everything. That bug already exists on desktop; reuse the exact same predicate in the mobile panel so behavior matches (or fix in both places identically: `item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)`).
- **VALIDATE**: `npm run dev`, view at 375px: hamburger shows, panel opens/closes, navigating closes panel; at ≥768px: identical to today.

### Task 2: LayoutShell gutter
- **ACTION**: Loosen the global gutter for phones.
- **IMPLEMENT**: In `LayoutShell.tsx:17`, `px-6` → `px-4 sm:px-6`.
- **MIRROR**: n/a (one-token change).
- **IMPORTS**: none.
- **GOTCHA**: Landing page (`/`) bypasses LayoutShell — its sections have their own `px-6` (handled in Task 7).
- **VALIDATE**: At 375px, dashboard cards have 16px gutters; no double scrollbar.

### Task 3: Patients page — table scroll + toolbar wrap
- **ACTION**: Make `/patients` survive 375px.
- **IMPLEMENT**:
  - Inside the card div (`patients/page.tsx:169`), wrap the `<table>` (line 173) in `<div className="overflow-x-auto">` and change table to `className="w-full min-w-[760px]"`. Loading branch stays as-is.
  - Search/filter row (line 146): `flex items-center gap-3` → `flex flex-wrap items-center gap-3`.
  - Page header row (~line 128, the flex holding `<h1>` + New Patient button): add `flex-wrap gap-3` if not present.
  - Pagination row (line 239): add `flex-wrap gap-2`.
- **MIRROR**: SCROLLABLE_OVERFLOW_REGION, FLEX_WRAP_TOOLBAR.
- **IMPORTS**: none.
- **GOTCHA**: The card has `overflow-hidden` (line 169) for rounded corners — put `overflow-x-auto` on an inner wrapper, not the card. Also check the New Patient modal (line 258+): ensure its panel has `mx-4` / `max-h-[85vh] overflow-y-auto` so it fits a phone screen; its two `grid grid-cols-2 gap-3` field rows (lines 298, 326) are fine at 375px — leave them.
- **VALIDATE**: At 375px: table pans horizontally inside the card, page itself does not scroll sideways; modal opens fully visible.

### Task 4: Inventory heatmap scroll
- **ACTION**: Make the 10-slot heatmap scrollable instead of crushed.
- **IMPLEMENT**:
  - Wrap the heatmap block (`inventory/page.tsx:212` `<div className="space-y-1.5">`) in `<div className="overflow-x-auto">` and add `min-w-[560px]` to the `space-y-1.5` div.
  - Both grid strips (lines 214 and 226): `grid-cols-[180px_repeat(10,minmax(0,1fr))]` → `grid-cols-[120px_repeat(10,minmax(0,1fr))] sm:grid-cols-[180px_repeat(10,minmax(0,1fr))]`.
- **MIRROR**: SCROLLABLE_OVERFLOW_REGION.
- **IMPORTS**: none.
- **GOTCHA**: Header strip and data rows must share the same wrapper (and the same min-width) or columns misalign while scrolling. The legend row above (line 186) already has `flex-wrap` — leave it. The per-patient `grid grid-cols-10 gap-1.5` mini-strip (line 341) gets cells ≈26px at 375px — acceptable for a status strip; leave it.
- **VALIDATE**: At 375px: heatmap pans; header `#0–#9` stays aligned with cells; patient name column readable.

### Task 5: Patient detail slot grid
- **ACTION**: Responsive magazine grid on `/patients/[id]`.
- **IMPLEMENT**: Line 389: `grid grid-cols-5 gap-3` → `grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5`.
- **MIRROR**: RESPONSIVE_GRID (`dispensers/[id]/page.tsx:1725` uses exactly this progression).
- **IMPORTS**: none.
- **GOTCHA**: Cells contain an inline edit form when `editingSlot === i` (line 417+) — 2-col cells at 375px are ≈160px wide, wide enough for the inputs; do not go below 2 columns. Drag-and-drop (`getCellDragProps`) is mouse-only and unaffected by column count.
- **VALIDATE**: At 375px: slots readable in 2 columns, tapping a slot opens the inline editor without clipping; at ≥768px identical to today.

### Task 6: AgentChat height
- **ACTION**: Chat fills the phone viewport sensibly.
- **IMPLEMENT**: `AgentChat.tsx:77`: `min-h-[60vh]` → `min-h-[60dvh] md:min-h-[60vh]` and add `max-h-[calc(100dvh-12rem)] md:max-h-none` so the input row stays reachable above the keyboard. Keep the rest.
- **MIRROR**: existing class on same line.
- **IMPORTS**: none.
- **GOTCHA**: `dvh` accounts for iOS Safari's collapsing URL bar; plain `vh` leaves the send button hidden behind the bottom bar. The input's `text-sm` zoom problem is fixed globally in Task 8, not here.
- **VALIDATE**: At 375px (responsive mode with touch): chat scrolls internally, input visible without scrolling the page.

### Task 7: Landing page hero
- **ACTION**: Scale down hero for phones.
- **IMPLEMENT** (`app/page.tsx`):
  - H1 (line 72): `text-5xl … sm:text-6xl lg:text-7xl` → `text-4xl leading-[1.08] sm:text-6xl lg:text-7xl` (keep tracking classes).
  - FeatureChips: the two least-critical chips (mid-left "YOLO" lines 116–121 and bottom-left "Ward dashboard" 132–137) get `hidden sm:flex` prepended to their `className` prop.
  - All landing `px-6` containers (Header line 30, Hero line 66, sections 166/222, Footer 261): `px-6` → `px-4 sm:px-6`.
  - Header CTA (lines 48–54): shorten label on phones — `<span className="hidden sm:inline">Open the Dashboard</span><span className="sm:hidden">Dashboard</span>`.
- **MIRROR**: HIDDEN_BELOW_BREAKPOINT.
- **IMPORTS**: none.
- **GOTCHA**: FeatureChip root already has `flex` in its own class string; the passed `hidden sm:flex` lands after it in the template literal, but Tailwind specificity ties resolve by stylesheet order, not class order — verify visually that chips actually hide at 375px; if not, handle the variant inside FeatureChip instead.
- **VALIDATE**: At 375px: headline fits without breaking words, 2 chips visible over the 3D model, no horizontal scroll; at ≥1024px unchanged.

### Task 8: iOS input zoom fix (globals.css)
- **ACTION**: Stop Safari auto-zoom on focus.
- **IMPLEMENT**: Append to `globals.css`, following the existing comment-header style:
  ```css
  /* iOS Safari zooms the page when a focused input is under 16px.
     Force 16px on coarse-pointer (touch) devices only. */
  @media (pointer: coarse) {
    input,
    select,
    textarea {
      font-size: 16px;
    }
  }
  ```
- **MIRROR**: CSS_ADDITIONS.
- **IMPORTS**: none.
- **GOTCHA**: Scope to `(pointer: coarse)`, NOT a width query — desktop windows narrowed to 375px should keep the designed 14px (`text-sm`) inputs. This rule intentionally beats Tailwind's `text-sm` on touch devices.
- **VALIDATE**: Desktop unchanged; in responsive mode with touch simulation, inputs render 16px.

### Task 9: Dispenser page 375px sweep (verify, spot-fix only)
- **ACTION**: Walk all 5 steps of `/dispensers/dispenser-001` at 375px.
- **IMPLEMENT**: No planned edits — the page already uses RESPONSIVE_GRID, FLEX_WRAP_TOOLBAR, `grid-cols-1 md:…` throughout (lines 966, 1063, 1368, 1725, 1785, 2104, 2449, 3295, 3351, 3517) and the AdvancedSheet bottom sheet (3207–3220) is mobile-shaped already. If a specific section overflows (most likely candidates: `ThisPassRow`, `IntakeReportCard` KPIs at 2104; the `<pre>` at 3369 already has `overflow-x-auto`), apply the minimal `flex-wrap` / responsive-cols fix matching the patterns above.
- **MIRROR**: RESPONSIVE_GRID, FLEX_WRAP_TOOLBAR.
- **IMPORTS**: none.
- **GOTCHA**: 3,599-line file under active development (recent FSM commits) — keep diffs surgical; don't reformat or refactor anything you aren't fixing. `min-h-[calc(100vh-14rem)]` at line 811 is fine (min-, not fixed).
- **VALIDATE**: Each step view at 375px: no horizontal page scroll, buttons tappable, camera tiles scale.

---

## Testing Strategy

### Unit Tests
No test runner exists in this repo (per CLAUDE.md: no pytest/vitest configured). Do **not** claim tests pass; validation is lint + build + manual viewport checks.

### Edge Cases Checklist
- [ ] 320px width (smallest common) — nothing fatally clipped
- [ ] 375px and 768px — primary targets
- [ ] Landscape phone (667×375) — navbar panel still usable
- [ ] Mobile menu open + route change → panel closes
- [ ] Patients list empty / loading state at 375px
- [ ] Inventory with 0 patients ("No patients enrolled yet") at 375px
- [ ] Long patient name in heatmap label column (has `truncate` — confirm it still does)
- [ ] New Patient modal on 375px with keyboard open

---

## Validation Commands

### Static Analysis
```bash
cd frontend && npm run lint
```
EXPECT: Zero errors (warnings unchanged from baseline)

### Build
```bash
cd frontend && npm run build
```
EXPECT: Production build succeeds, no type errors

### Browser Validation
```bash
cd frontend && npm run dev
```
Then in browser devtools responsive mode, check each route at 375px and 768px:
`/` (landing), `/dashboard`, `/agent`, `/inventory`, `/patients`, `/patients/<id>`, `/dispensers/dispenser-001`, `/reports`
EXPECT: No horizontal page scroll anywhere; nav usable; tables/heatmap pan inside their cards

### Manual Validation
- [ ] Hamburger menu opens, closes, closes on navigation
- [ ] Patients table pans horizontally inside card at 375px
- [ ] Inventory heatmap header stays aligned with cells while panning
- [ ] Patient detail slots: 2/3/5 columns at 375/640/768
- [ ] Agent chat input visible without page scroll at 375px
- [ ] Landing hero: 2 chips on phone, 4 on ≥640px
- [ ] Focus an input with touch emulation → no zoom
- [ ] Desktop ≥1024px: every page visually identical to before

---

## Acceptance Criteria
- [ ] All 9 tasks completed
- [ ] `npm run lint` and `npm run build` pass
- [ ] No horizontal page-level scroll at 320/375/768px on any route
- [ ] Desktop layout visually unchanged at ≥1024px
- [ ] No new dependencies added

## Completion Checklist
- [ ] Every change uses an existing in-repo Tailwind pattern (see Patterns to Mirror)
- [ ] No refactors beyond the listed class/markup changes
- [ ] `globals.css` addition follows existing comment-header style
- [ ] Navbar active-tab predicate identical between desktop and mobile renders
- [ ] No hardcoded breakpoint pixel values outside Tailwind prefixes (except the two `min-w-[…]` scroll floors)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Dispenser page (3.6k lines, active dev) merge conflicts | Medium | Medium | Task 9 is verify-first, surgical diffs only |
| FeatureChip `hidden sm:flex` loses to its own `flex` class | Medium | Low | GOTCHA in Task 7 includes fallback (handle variant inside component) |
| 16px input rule affects touchscreen laptops | Low | Low | Acceptable; rule only fires on coarse pointer |
| `min-w` scroll floors chosen wrong (too wide/narrow) | Low | Low | Tune visually during browser validation |
| Working tree already has uncommitted edits to `page.tsx`/`dashboard/page.tsx`/`globals.css` | High | Medium | Diff against current working tree, not HEAD; do not revert in-flight edits |

## Notes
- Next.js App Router injects the responsive viewport meta by default — `layout.tsx` needs no change.
- Git status shows uncommitted modifications in `frontend/src/app/{agent,dashboard,page}.tsx`, `globals.css`, and a new `ShiftBrief.tsx`. Line numbers in this plan were captured from the current working tree on 2026-06-10; re-verify with a quick grep if files have moved since.
- `WhatHappenedLately` (sm:grid-cols-2 lg:grid-cols-4), `FloorMap` (viewBox SVG, `w-full`), `StatCard`, `IntakeLog`, `ShiftBrief`, dashboard and agent page grids are already responsive — intentionally untouched.
- Touch DnD for slots (`useSlotDnd`) is explicitly out of scope; HTML5 drag events don't fire on touch and fixing that is a feature, not an optimization.
