# Plan: Judge-Facing Demo Visual Impact Upgrade

## Summary
Upgrade the guided dispense flow (`/dispensers/[id]`) so the three AI verification moments — **face recognition**, **pill identification**, **intake (swallow) verification** — produce an instant, unmistakable visual verdict a judge can read in under 2 seconds, while stripping operator/debug noise out of the main demo path. No backend or hardware changes; purely frontend presentation on top of data the page already receives.

## User Story
As a **competition judge watching a 3-minute demo**, I want **each AI verification step to announce its result with one big, obvious, animated visual**, so that **I immediately understand what the system just proved without reading small text or having someone point at the screen**.

## Problem → Solution
- **Face verify**: result today = small status chip + thin 2px similarity bar + tiny mono text → **big animated verdict stamp over the snapshot, count-up similarity number, threshold gauge**.
- **Pill ID**: result today = plain `<dl>` key/value rows → **hero verdict banner: detected pill name in display font, animated confidence bar vs expected, annotated snapshot as primary visual**.
- **Intake verify**: today = 4 small checkbox rows + a % string → **horizontal FSM journey tracker (step icons lighting up live) + progress ring, as the dominant element next to the live cam**.
- **Noise**: rotate-test grid, servo hints, env-var setup text, "HW stub" chip, raw toast strings all visible → **moved into the Advanced sheet or hidden, so the main path only shows what the judge should see**.

## Metadata
- **Complexity**: Large (one big page + CSS + 3 new components, ~10 tasks)
- **Source PRD**: N/A (free-form)
- **PRD Phase**: N/A
- **Estimated Files**: 5 (1 major update, 1 CSS update, 3 new components)

---

## UX Design

### Before
```
┌─ Step 1 · Identify ─────────────────────────────┐
│ [ref photo]   [cam snapshot w/ thin bbox]       │
│ similarity ▏▏ 99.2% / 90%   (2px bar, 11px txt) │
│ status chip: "Verified · 99.2%"  (tiny)         │
└─────────────────────────────────────────────────┘
┌─ Step 4 · Verify ───────────────────────────────┐
│ AI intake check          │  Cam 1 (live)        │
│  ✓ Pill detected   Yes   │                      │
│  ✓ Face matched    JD    │                      │
│  · Mouth open      42%   │                      │
│  ✓ Hands visible   Yes   │                      │
│ conf: 0.84 step: 3/5  (10px gray)               │
└─────────────────────────────────────────────────┘
+ RotateTestBar, servo calibration, env-var hints all in-flow
```

### After
```
┌─ Step 1 · Identify ─────────────────────────────┐
│ [ref photo]   [cam snapshot w/ thick bbox]      │
│        ╭──────────────────────────╮             │
│        │   ✓ IDENTITY VERIFIED    │  ← verdict  │
│        │   John D. · 99.2% match  │    stamp,   │
│        ╰──────────────────────────╯    scales in│
│  similarity gauge: ████████████░ 99.2%│90%      │
│  (8px bar, count-up number, threshold tick)     │
└─────────────────────────────────────────────────┘
┌─ Step 4 · Verify ───────────────────────────────┐
│  HAND → TILT → LEVEL → MOUTH → TONGUE           │
│  (●)────(●)────(◐ 42%)──(○)────(○)   ← journey │
│   done   done   active   next   next    strip   │
│ ┌──────────────────────┬──────────────────────┐ │
│ │ progress ring 42%    │  Cam 1 LIVE          │ │
│ │ "Tilt your head…"    │  (FaceMesh overlay)  │ │
│ └──────────────────────┴──────────────────────┘ │
│  On pass: full-card green sweep + "✓ INTAKE     │
│  CONFIRMED · 96%" stamp before success modal    │
└─────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Face match result | Small chip + 2px bar | VerdictStamp overlay on snapshot + ConfidenceGauge with count-up | Same data (`VerifyFaceResult`) |
| Pill verify result | `<dl>` rows in VerifyResultCard | Hero banner: pill name in display font, animated confidence bar, expected-vs-detected chips | Same data (`VerifyPillResult`) |
| Swallow FSM | 4 checkbox rows in AIIntakeCheck | FsmJourney strip (per-step icons + live hold ring) above cam; AIIntakeCheck demoted to compact detail | Driven by `intake.step_index`, `intake.history`, `intake.hold_progress` |
| Intake pass | Modal only | Full-card green verdict sweep, then modal | Modal kept (already good) |
| RotateTestBar | Visible on Dispense step | Moved into AdvancedSheet | Judges never see test tooling |
| Layer2 disabled state | Shows env-var setup text | Renders `null` when disabled | Setup hint belongs in README |
| "HW stub" pill | Always shown | Only when `hardware_stubbed === true`, relabeled "Sim" (warn tone) | Honest but not cryptic |
| Toast messages | Raw technical strings | Same content, restyled with status tone + icon | Low-effort polish |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | all (3600) | The page being upgraded; every component referenced below lives here |
| P0 | `frontend/src/app/globals.css` | 58-145 | Existing keyframe/animation conventions to extend (`check-draw`, `pulse-soft`, `connector-fill`, stagger classes) |
| P1 | `frontend/src/lib/device.ts` | 24-75, 267-340 | `IntakeState`, `VerifyPillResult`, `VerifyFaceResult`, `PillDetection` shapes — all visuals are pure functions of these |
| P1 | `frontend/src/components/StatCard.tsx` | all | Existing standalone-component conventions (props typing, tailwind classes) |
| P2 | `frontend/src/app/page.tsx` | 272-294 | `FeatureChip` — the landing-page chip aesthetic to echo |

## External Documentation
No external research needed — feature uses established internal patterns (Tailwind v4 utilities, CSS keyframes, SVG stroke animation already present in `check-draw`).

---

## Patterns to Mirror

### NAMING_CONVENTION
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:2386-2396
// PascalCase function components, props destructured with inline type literal:
function VerifyResultCard({
  result,
  verifying,
  expected,
}: {
  result: VerifyPillResult | null;
  verifying: boolean;
  expected: string | null;
}) {
```

### TONE_PALETTE (status colors)
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:2011-2036
const tonePalette = {
  ok:   { border: "border-status-success", bg: "bg-status-success-bg", text: "text-status-success", icon: "✓" },
  warn: { border: "border-status-warning", bg: "bg-status-warning-bg", text: "text-status-warning", icon: "!" },
  fail: { border: "border-status-danger",  bg: "bg-status-danger-bg",  text: "text-status-danger",  icon: "✗" },
  pending: { border: "border-sand-200", bg: "bg-white", text: "text-olive-700", icon: "…" },
}[overall.tone];
```

### ANIMATION_PATTERN (SVG stroke draw — reuse for verdict check + progress ring)
```css
/* SOURCE: frontend/src/app/globals.css:119-127 */
@keyframes check-draw {
  from { stroke-dashoffset: 24; }
  to   { stroke-dashoffset: 0; }
}
.check-draw {
  stroke-dasharray: 24;
  stroke-dashoffset: 24;
  animation: check-draw 0.45s ease-out forwards;
}
```

### ONCE_PER_EVENT_GUARD (refs against the 250 ms intake poll)
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:340-349
useEffect(() => {
  if (intake?.result === "passed") {
    if (!intakeSuccessShownRef.current) {
      intakeSuccessShownRef.current = true;
      setIntakeSuccessOpen(true);
    }
  } else if (intake?.running && intake.result === null) {
    intakeSuccessShownRef.current = false;  // re-arm for next round
  }
}, [intake?.result, intake?.running]);
```
Any new "fire animation once" logic MUST use this ref-latch pattern — the page polls intake every 250 ms and device status every 3 s; naive effects will replay animations on every tick.

### CARD_SHELL
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:1351
<div className="rounded-2xl border border-sand-200 bg-white p-4">
```
All new surfaces use `rounded-2xl border border-sand-200 bg-white` (or status-tone variants). Eyebrow labels: `text-[10px] font-medium uppercase tracking-wider text-gray-400`. Display numerals: `font-[family-name:var(--font-display)]`.

### BBOX_OVERLAY (percent-positioned absolute div)
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:1413-1437
<div
  className={`pointer-events-none absolute rounded-md border-2 ... ${result.match ? "border-status-success" : "border-status-danger"}`}
  style={{ left: `${result.bbox.Left * 100}%`, top: `${result.bbox.Top * 100}%`,
           width: `${result.bbox.Width * 100}%`, height: `${result.bbox.Height * 100}%` }}
>
```

### STANDALONE_COMPONENT_FILE
```tsx
// SOURCE: frontend/src/components/StatCard.tsx (flat components dir, default export,
// "use client" only when hooks/state needed, typed inline props)
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/components/VerdictStamp.tsx` | CREATE | Reusable animated verdict overlay (✓/✗ + headline + sub), used by all three AI moments |
| `frontend/src/components/ConfidenceGauge.tsx` | CREATE | Count-up % number + thick bar with threshold tick; used by face + pill verdicts |
| `frontend/src/components/FsmJourney.tsx` | CREATE | Horizontal swallow-FSM step tracker with live hold-progress ring |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | Wire the three components into steps 1/3/4; move RotateTestBar + noise into AdvancedSheet; restyle toasts |
| `frontend/src/app/globals.css` | UPDATE | New keyframes: `verdict-pop`, `bar-grow`, `ring-fill`, `sweep-success` |

## NOT Building
- No backend / Pi / `lib/device.ts` API changes — visuals are pure functions of existing `VerifyFaceResult` / `VerifyPillResult` / `IntakeState`.
- No changes to the dashboard (`/dashboard`), landing page, patients, inventory, or reports pages.
- No confetti / sound effects / lottie — professional clinical tone only, CSS-driven.
- No new npm dependencies (no framer-motion; the page's CSS keyframe pattern is sufficient).
- No demo-script automation, fake data injection, or "presentation mode" toggle.
- No removal of operator functionality — debug tooling moves to AdvancedSheet, never deleted.
- No test suite setup (repo has none; validation = lint + build + manual checklist).

---

## Step-by-Step Tasks

### Task 1: Add demo animation keyframes to globals.css
- **ACTION**: Append four keyframes + utility classes after the existing `sheet-up` block in `frontend/src/app/globals.css`.
- **IMPLEMENT**:
  ```css
  /* Verdict stamp pop-in */
  @keyframes verdict-pop {
    0%   { opacity: 0; transform: scale(1.25); }
    60%  { opacity: 1; transform: scale(0.97); }
    100% { opacity: 1; transform: scale(1); }
  }
  .animate-verdict-pop { animation: verdict-pop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }

  /* Confidence bar grow (scaleX from 0 — width set inline) */
  @keyframes bar-grow {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
  }
  .animate-bar-grow { transform-origin: left center; animation: bar-grow 0.9s cubic-bezier(0.22, 1, 0.36, 1) both; }

  /* SVG progress-ring fill — pair with inline stroke-dasharray */
  @keyframes ring-fill {
    from { stroke-dashoffset: var(--ring-circumference, 251); }
  }
  .animate-ring-fill { animation: ring-fill 0.8s ease-out both; }

  /* One-shot green wash across a card on success */
  @keyframes sweep-success {
    0%   { background-position: -100% 0; }
    100% { background-position: 200% 0; }
  }
  .animate-sweep-success {
    background-image: linear-gradient(100deg, transparent 20%, rgba(45,122,58,0.12) 50%, transparent 80%);
    background-size: 200% 100%;
    animation: sweep-success 1.1s ease-out both;
  }
  ```
- **MIRROR**: ANIMATION_PATTERN (keyframe + single utility class, kebab-case names, `both` fill mode).
- **GOTCHA**: Tailwind v4 — these are plain CSS classes, NOT `@theme` tokens; keep them outside the `@theme` block exactly like `.animate-pulse-soft`.
- **VALIDATE**: `cd frontend && npm run build` — CSS compiles; spot-check one class in devtools.

### Task 2: Create `VerdictStamp` component
- **ACTION**: New file `frontend/src/components/VerdictStamp.tsx`.
- **IMPLEMENT**: Presentational component:
  ```tsx
  type VerdictTone = "ok" | "fail" | "warn";
  export default function VerdictStamp({
    tone, headline, sub, size = "md", className = "",
  }: {
    tone: VerdictTone;
    headline: string;       // e.g. "IDENTITY VERIFIED"
    sub?: string;           // e.g. "John Doe · 99.2% match"
    size?: "md" | "lg";
    className?: string;
  })
  ```
  Renders a centered banner: large circled icon (✓ uses the existing `check-draw` SVG technique, ✗ a drawn cross), uppercase tracking-wide headline in `font-display`, optional sub line. Root carries `animate-verdict-pop` and tone classes from TONE_PALETTE. `lg` size for full-card overlays (absolute inset-0, grid place-items-center, `bg-white/85 backdrop-blur-sm` scrim), `md` for inline banners.
- **MIRROR**: NAMING_CONVENTION, TONE_PALETTE, CARD_SHELL.
- **IMPORTS**: none beyond React types (pure presentational, no hooks → no "use client").
- **GOTCHA**: Remount to replay animation — callers pass a changing `key` (e.g. keyed on the result object); do NOT add internal animation state.
- **VALIDATE**: `npm run lint` clean; renders in step 1 after Task 5.

### Task 3: Create `ConfidenceGauge` component
- **ACTION**: New file `frontend/src/components/ConfidenceGauge.tsx`.
- **IMPLEMENT**: `"use client"` (uses rAF count-up):
  ```tsx
  export default function ConfidenceGauge({
    value,            // 0-100
    threshold,        // 0-100 | undefined — renders tick when present
    label,            // e.g. "Rekognition similarity" / "YOLO confidence"
    tone,             // "ok" | "fail"
  }: { value: number; threshold?: number; label: string; tone: "ok" | "fail" })
  ```
  Layout: label row with a count-up numeral (rAF 0 → value over ~800 ms, `font-display text-3xl tabular-nums`, tone-colored) next to `"/ {threshold}% required"` when threshold present; below, an `h-2.5` rounded track with tone-colored fill at `width: value%` carrying `animate-bar-grow`, plus an absolute 2px gray tick at `left: threshold%` (mirrors existing similarity-bar tick at page.tsx:1475-1487, just bigger).
  Count-up: `useEffect` + `requestAnimationFrame`, eased (`1 - (1-t)^3`), cancel on unmount, re-run when `value` changes.
- **MIRROR**: NAMING_CONVENTION; threshold-tick markup from FaceVerifySection (page.tsx:1463-1489).
- **IMPORTS**: `{ useEffect, useState } from "react"`.
- **GOTCHA**: Clamp `value`/`threshold` to [0,100] like the existing bar (`Math.min(100, Math.max(0, …))`).
- **VALIDATE**: `npm run lint`; number animates once per result in browser.

### Task 4: Create `FsmJourney` component
- **ACTION**: New file `frontend/src/components/FsmJourney.tsx`.
- **IMPLEMENT**: Presentational tracker fed by `IntakeState`:
  ```tsx
  import type { IntakeState } from "@/lib/device";
  export default function FsmJourney({ intake }: { intake: IntakeState | null })
  ```
  - Derive steps from backend truth: `intake.total_steps` count; names from `intake.history[].step_name` (done) + `intake.step_name` (current); placeholder dots when idle. Do NOT hardcode a 5-name list as the data source — step naming and the step-4 inverted logic are owned by the Pi (CLAUDE.md: `ml/swallow/main5.py` is canonical).
  - Each step: 40px circle — done = `bg-status-success-bg text-status-success` with `check-draw` ✓; current = olive ring + SVG progress ring around the circle showing `intake.hold_progress` (stroke-dasharray = C, stroke-dashoffset = C·(1−p), `--ring-circumference` inline, `animate-ring-fill` keyed on step change); upcoming = `bg-sand-100 text-gray-400`.
  - Connectors reuse `connector-fill` when the left step is done.
  - Under the strip: `intake.instruction` in `text-sm font-medium` (judge-readable, bigger than today's 11px).
  - Terminal states: `result === "passed"` → all green + container `animate-sweep-success`; `"timeout"`/`"missing_labels"` → current circle danger tone.
- **MIRROR**: StepBar circles/connectors (page.tsx:3011-3099) — same geometry language, scaled up.
- **IMPORTS**: `type { IntakeState } from "@/lib/device"`.
- **GOTCHA**: `intake.history` can briefly lag `step_index` between 250 ms polls — treat `i < step_index` as done regardless of history presence. Component re-renders every 250 ms; keep it pure (no state, no effects).
- **VALIDATE**: `npm run lint`; with intake watch running, circles advance and ring tracks `hold_progress`.

### Task 5: Face verify — verdict stamp + gauge (step 1)
- **ACTION**: Update `FaceVerifySection` in `page.tsx`.
- **IMPLEMENT**:
  - When `result?.ok && result.match` (or `verified`): render `<VerdictStamp size="lg" tone="ok" headline="IDENTITY VERIFIED" sub={`${patient.name} · ${sim?.toFixed(1)}% match`} />` as absolute overlay on the cam-1 snapshot figure (bbox stays visible beneath; scrim keeps stamp legible). When `result.ok && !result.match`: `tone="fail" headline="NOT RECOGNIZED"`. Key the stamp on `result` so it pops once per verify.
  - Replace the thin similarity-bar block (lines ~1463-1489) with `<ConfidenceGauge value={sim} threshold={threshold} label="Rekognition similarity" tone={result.match ? "ok" : "fail"} />`.
  - Enlarge the two figures (`md:grid-cols-2`, taller than current `aspect-[4/3]` cards) — the faces ARE the demo.
  - Keep the explicit Continue gate untouched (operator must still tap Continue — clinical-safety behavior, never auto-advance).
- **MIRROR**: BBOX_OVERLAY, TONE_PALETTE.
- **IMPORTS**: `VerdictStamp from "@/components/VerdictStamp"`, `ConfidenceGauge from "@/components/ConfidenceGauge"`.
- **GOTCHA**: `result.similarity` can be `null` even when `ok` (no face found) — guard before rendering gauge/stamp sub. Stamp must disappear when `onReset`/Retake clears the result.
- **VALIDATE**: Verify against device (or stub): match → green stamp pops over snapshot + gauge counts up; mismatch → red stamp; Retake clears.

### Task 6: Pill verify — hero verdict (step 3 Dispense)
- **ACTION**: Restyle `VerifyResultCard` in `page.tsx` (keep name + props).
- **IMPLEMENT**:
  - Promote the annotated snapshot to the larger column (YOLO boxes already drawn server-side); overlay `VerdictStamp` keyed on `result`: match → `"CORRECT MEDICATION"` / sub `"{class_name} · {conf}%"`; mismatch → `"WRONG PILL DETECTED"`; no detection → warn `"NO PILL ON TRAY"`.
  - Other column: detected pill name in `font-display text-3xl`, then `<ConfidenceGauge value={confPct} label="YOLO confidence" tone={…} />` (no threshold tick), then compact expected-vs-detected chip pair (`Expected: X` sand chip / `Detected: Y` tone chip).
  - Collapse "Other candidates" + inference latency into one muted footer line (`text-[10px] text-gray-400 font-mono`) — kept for credibility, shrunk for noise.
  - Reuse the existing `tone` derivation (page.tsx:2412-2443) verbatim.
- **MIRROR**: TONE_PALETTE, CARD_SHELL.
- **GOTCHA**: VerifyResultCard re-renders on eject-triggered verifies; key the stamp on `result` object identity so the pop replays on re-eject, not on unrelated parent renders.
- **VALIDATE**: Eject: correct pill → green hero with name + count-up; wrong pill → red hero, existing UnsafePillAlert still shows above.

### Task 7: Intake verify — journey strip as hero (step 4)
- **ACTION**: Update step-4 (`viewIdx === 3`) layout in `page.tsx`.
- **IMPLEMENT**:
  - Insert `<FsmJourney intake={intake} />` full-width directly under `SectionHeading`, above the existing grid.
  - Demote `AIIntakeCheck` to compact: drop its internal headline block (journey owns the headline); keep it as the secondary checklist in the left column.
  - On `intake.result === "passed"`: inside the existing ref-latched success effect, delay `setIntakeSuccessOpen(true)` by ~700 ms so the journey's `animate-sweep-success` is visible before the modal covers it. Clear the timeout on unmount.
  - Raise cam-1 footer instruction from `text-[11px]` to `text-sm`.
- **MIRROR**: ONCE_PER_EVENT_GUARD (modify only inside the existing `intakeSuccessShownRef` effect).
- **GOTCHA**: Store the timeout id in a ref and clear in the effect cleanup; the 250 ms poll must not schedule duplicates (the ref-latch already prevents this).
- **VALIDATE**: Run intake watch: steps light up live, ring tracks hold, pass → sweep then modal.

### Task 8: Noise purge — move test tooling out of the judge path
- **ACTION**: In `page.tsx`:
  1. Remove `<RotateTestBar …/>` from the Dispense card (viewIdx 2); render it inside `AdvancedSheet` (after the manual-eject grid) — add an `onRotate` prop to AdvancedSheet.
  2. `Layer2LabelPanel`: when `disabled` (no required labels), return `null` instead of the `INTAKE_LABEL_ENABLED=1` instruction card.
  3. PatientBanner: render the `HW` pill only when `status?.hardware_stubbed === true`, relabeled `Sim` (warn tone); omit entirely when hardware is real.
  4. Restyle the `msg` toast with a leading status icon and tone background (reuse TONE_PALETTE); config-missing + unreachable toasts keep content.
- **MIRROR**: CARD_SHELL; AdvancedSheet section structure (page.tsx:3240-3375).
- **GOTCHA**: `RotateTestBar` needs `busy`, `configured`, `onRotate` — first two already reach AdvancedSheet; only `onRotate` is new.
- **VALIDATE**: Dispense card shows only CTA + slot grid + cam + verdicts; Advanced sheet contains rotate test; `npm run lint` clean.

### Task 9: Step-bar polish — verdict-aware step states
- **ACTION**: In `StepBar` (page.tsx:3011), let completed AI steps carry their verdict color.
- **IMPLEMENT**: Add optional `stepTones?: Array<"ok" | "fail" | undefined>` prop, derived in the page: index 0 ← face result (verified→ok, failed match→fail), index 2 ← `pillMatch`, index 3 ← `intake.result`. `fail` renders the danger palette on that step's circle so a judge scanning the bar sees exactly where a round went wrong; default stays the current green ✓.
- **MIRROR**: TONE_PALETTE.
- **GOTCHA**: Default the prop to `[]` so existing renders are unchanged; don't alter click/jump behavior.
- **VALIDATE**: Force a face mismatch → step 1 chip shows danger tone until retake.

### Task 10: Lint, build, manual pass
- **ACTION**: Full validation.
- **IMPLEMENT**: `cd frontend && npm run lint && npm run build`, then `make frontend` and walk the 5-step round end-to-end (device or stubbed hardware) using the Manual Validation checklist.
- **GOTCHA**: Repo has NO test suite — do not claim tests pass; lint + build + manual walkthrough is the full gate.
- **VALIDATE**: Zero lint errors, build succeeds, checklist all ticked.

---

## Testing Strategy

### Unit Tests
N/A — repo has no test runner configured (per CLAUDE.md). Do not add one in this change.

### Edge Cases Checklist
- [ ] `result.similarity === null` (no face in frame) — gauge/stamp guarded, no NaN
- [ ] `intake === null` (watch never started) — FsmJourney renders idle placeholders
- [ ] `intake.history` empty while `step_index > 0` — done-circles still render
- [ ] Re-verify after Retake — count-up and stamp replay exactly once
- [ ] `verifyResult.top === undefined` (empty tray) — warn verdict, no crash
- [ ] Device not configured (`NEXT_PUBLIC_DEVICE_URL` unset) — page renders, new components show idle states
- [ ] Mobile width — journey strip wraps or scrolls horizontally (reuse `flex-wrap` like StepBar)

## Validation Commands

### Static Analysis
```bash
cd frontend && npm run lint
```
EXPECT: Zero errors

### Build
```bash
cd frontend && npm run build
```
EXPECT: Production build succeeds, no type errors

### Browser Validation
```bash
make frontend   # next dev on :3000 → open /dispensers/<id>
```
EXPECT: Demo flow works as designed

### Manual Validation (the judge run-through)
- [ ] Step 1: Verify face → green VerdictStamp pops over snapshot, similarity counts up past threshold tick, bbox visible
- [ ] Step 1 negative: wrong person → red "NOT RECOGNIZED" stamp, step bar chip turns danger
- [ ] Step 3: Eject → pill name in display font, confidence bar grows, annotated snapshot prominent
- [ ] Step 3 negative: wrong pill → red hero + UnsafePillAlert + spoken alert (existing)
- [ ] Step 4: journey circles light up live, ring tracks hold %, instruction readable at 2 m distance
- [ ] Step 4 pass: green sweep → success modal
- [ ] No rotate-test grid, no env-var text, no calibration visible anywhere in the main 5 cards
- [ ] Whole round readable without anyone pointing at the screen

## Acceptance Criteria
- [ ] All 10 tasks completed
- [ ] Each of the three AI moments has a ≤2-second-readable verdict visual
- [ ] Zero lint errors, production build passes
- [ ] No operator functionality removed (only relocated to Advanced)
- [ ] No new dependencies added
- [ ] Matches UX design diagrams above

## Completion Checklist
- [ ] New components follow page.tsx prop/typing conventions
- [ ] All animations use the globals.css keyframe pattern (no inline `<style>`, no JS animation libs)
- [ ] Tone colors only from the `status-*` / `olive-*` / `sand-*` theme tokens
- [ ] Once-per-event animations are ref-latched against the 250 ms poll
- [ ] Continue-gate / override safety behaviors untouched
- [ ] No hardcoded FSM step names as data source (backend `step_name` is truth)

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 250 ms intake poll replays animations | Medium | High (looks broken) | Ref-latch pattern (mandatory in Tasks 5-7); key remounts on result identity |
| Verdict overlay hides the bbox evidence | Low | Medium | 85% white scrim + centered stamp; bbox border-2 visible at edges; judge sees both |
| `total_steps`/`step_name` differ from assumed 5-step list | Medium | Medium | FsmJourney derives everything from `IntakeState`, never hardcodes names |
| 3600-line page edit conflicts | Medium | Low | New visuals live in 3 new component files; page edits are localized swaps |
| Demo on slow client: count-up + ring jank | Low | Low | All animation CSS-composited (transform/opacity/stroke), no layout thrash |

## Notes
- `IntakeSuccessModal` and `UnsafePillAlert` are already strong — intentionally reused, not redesigned.
- Voice prompts (TTS) already give an audio "wow" channel; this plan deliberately doesn't touch them.
- Possible later pass (out of scope now): a read-only `?present=1` flag hiding the patient picker + prev/next nav for an even tighter stage demo.
