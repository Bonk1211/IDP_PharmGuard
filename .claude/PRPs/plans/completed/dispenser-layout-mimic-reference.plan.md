# Plan: Mimic Reference UI on `/dispensers/[id]` — Position + Ratio Refactor

## Summary
The current dispenser page has all the right sub-components and wiring, but the **layout ratios and stacking** don't match the supplied reference. This plan refactors only the JSX skeleton + ratios: patient banner becomes one full-width row, steps + this-pass become two thin inline rows, the confirm block becomes bare typography (no card), the main work area becomes a 7:3 SlotGrid / AI-panel row, and the twin cameras lift out into their own full-width 2-column row above the action bar.

## User Story
As a caregiver running a guided round at the cabinet,
I want the dispenser screen to lay out exactly like the approved mockup,
so that visual hierarchy guides me through the four steps in one glance.

## Problem → Solution
**Current**: stacked cards in a vertical chain, slot grid is 2-col × 5-row stuck on the left, cams + AI panel share the right column. Patient banner is split into three boxes.
**Desired**: single-row patient banner, inline-strip steps row, horizontal this-pass chips, bare confirm typography with a state legend on the right, a 7:3 row holding the slot grid (5-col × 2-row) and AI panel, twin cameras as a separate full-width row below, then the sticky action bar.

## Metadata
- **Complexity**: Medium (single-file refactor, all sub-components already exist)
- **Source PRD**: N/A (free-form reference image)
- **PRD Phase**: N/A
- **Estimated Files**: 1 changed (`frontend/src/app/dispensers/[id]/page.tsx`)

---

## UX Design

### Before
```
┌──────────────────────────────────────────────────────────────────────┐
│ Navbar (global)                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Patient ──┐ ┌── Status pills ──┐ ┌── Next round ──┐  (3 cards)  │
│ └─────────────┘ └──────────────────┘ └────────────────┘              │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Steps card (3fr) ──┐ ┌── This-pass card (2fr) ──┐                │
│ │ 4 steps + cycle      │ │ Vertical list of 4 meds  │                │
│ └──────────────────────┘ └──────────────────────────┘                │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Confirm CARD (bordered) ──────────────────────────────────────┐ │
│ └─────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Slot grid (5fr) ──┐ ┌── Right column (7fr): cams + AI ────────┐ │
│ │ 2 cols × 5 rows     │ │ Cams md:grid-cols-2 / AI panel below    │ │
│ └─────────────────────┘ └─────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ Action bar (sticky)                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### After (mirroring the reference)
```
┌──────────────────────────────────────────────────────────────────────┐
│ Navbar                                                               │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Patient banner — ONE ROW ─────────────────────────────────────┐ │
│ │ MC | name 78y · condition | ⚠Allergies | CYCLES LOOP HW DRAWER | │ │
│ │      MRN                                                  Next  │ │
│ │                                                          round  │ │
│ │                                                       View chart│ │
│ └─────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Steps row (full width) ───────────────────────────────────────┐ │
│ │ ✓ Verify — ✓ Eject — (3) Confirm — (4) Sign off    14:00 round  │ │
│ │                                                  cycle 0 · 14:42│ │
│ └─────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── This pass row (full width) ───────────────────────────────────┐ │
│ │ THIS PASS  ✓Med1̶ S0 — (2)Med2 S1 — (3)Med3 S2 — (4)Med4 S3  1/4 │ │
│ └─────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ Bare typography (no card):                                           │
│   STEP 3 OF 4 · CONFIRM INTAKE                                       │
│   Confirm <name> took the pill.   (serif display)                    │
│   <medication> from slot N. Watch the patient cam …                  │
│                                ● Ready ● Ejected ● Low ● Empty ● Lk │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Slot grid (7fr) ───────────────────────────┐ ┌── AI panel (3fr)│ │
│ │ Drawer locked · Unlock     10 slots · 1 ej   │ │ AI INTAKE CHECK │ │
│ │ ┌───┐┌───┐┌───┐┌───┐┌───┐                    │ │ ✓ Confirmed     │ │
│ │ │S00││S01││S02││S03││S04│                    │ │ ✓ Pill on tray  │ │
│ │ └───┘└───┘└───┘└───┘└───┘                    │ │ ✓ Face matched  │ │
│ │ ┌───┐┌───┐┌───┐┌───┐┌───┐                    │ │ ✓ Mouth empty   │ │
│ │ │S05││S06││S07││S08││S09│                    │ │ ✓ Hands visible │ │
│ │ └───┘└───┘└───┘└───┘└───┘                    │ │ model · latency │ │
│ │       (5 columns × 2 rows)                   │ └─────────────────┘ │
│ └──────────────────────────────────────────────┘                     │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── Cam 0 · Tray ──────────────┐ ┌── Cam 1 · Patient ─────────────┐ │
│ │ LIVE          14:42:31       │ │ LIVE             14:42:31      │ │
│ │ [tray video]                 │ │ [patient video]                │ │
│ │ ● Pill released · slot N     │ │ Show empty mouth · 100%        │ │
│ └──────────────────────────────┘ └────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────┤
│ ✓ Intake looks good        Re-snapshot · Override · Confirm & cont. │
└──────────────────────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Patient banner | 3 separate cards | 1 banner row with internal sections | Reduces vertical noise; matches mockup |
| Steps card | dedicated card with sub-line | thin inline row, cycle/clock pushed right | Same data, less vertical space |
| This pass | vertical list of 4 rows | horizontal chip row + "N/M done" right | Whole pass visible at a glance |
| Confirm block | bordered card | bare typography + right-aligned dot legend | Removes card chrome; legend captions the slot grid below |
| Slot grid | 2-col × 5-row, left of cams | 5-col × 2-row, full left of main row | Wider, fewer rows |
| AI panel | beneath cams in right column | direct right neighbour of slot grid (3fr) | Promoted to sibling of slot grid |
| Cams | nested top-right | separate full-width 2-col row above action bar | Big readable preview pair |
| Action bar | sticky bottom | unchanged | Already correct |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 1-end | All sub-components live here. Refactoring layout + tweaking three of them; nothing new to build. |
| P1 | `frontend/src/lib/device.ts` | 22-60, 166-171 | Type shapes — no change. Confirms `IntakeState`, `DeviceStatus`, `streamUrl`. |
| P1 | `frontend/src/lib/api.ts` | 16-38, 110-145 | `SlotInfo`, `Patient` shapes used in components. |
| P2 | `frontend/src/components/Navbar.tsx` | 1-end | Global top bar — no change; new layout sits under existing `<main>` wrapper. |
| P2 | reference screenshot | — | Pixel target. Component positions + ratios are the source of truth. |

## External Documentation
No external research needed — feature uses established Tailwind v4 utility patterns + Next.js App Router conventions already in repo.

---

## Patterns to Mirror

### CARD_WRAPPER
```tsx
// SOURCE: existing SlotGrid root
<div className="rounded-2xl border border-sand-200 bg-white p-4">…</div>
```

### STATUS_PILL
```tsx
// SOURCE: current Pill helper
<span className="inline-flex items-center gap-1 rounded-full border border-sand-200 bg-white px-2.5 py-1">
  <span className="text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
  <span className={`font-semibold tabular-nums ${toneCls}`}>{value}</span>
</span>
```

### STEP_DOT
```tsx
// SOURCE: current StepsCard
<div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
  done ? "bg-status-success-bg text-status-success"
  : current ? "bg-olive-700 text-white ring-2 ring-olive-300"
  : "bg-sand-100 text-gray-400"
}`}>
  {done ? "✓" : i + 1}
</div>
```

### STATE_LEGEND_DOT (new helper — tiny non-interactive caption)
```tsx
<span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500">
  <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-success" aria-hidden />
  Ready
</span>
```
Replaces the current bordered `StateChip` inside `ConfirmCard`.

### SLOT_TILE (existing — reuse exactly)
```tsx
// SOURCE: current SlotGrid map body — DO NOT change inner markup.
<button className={`flex flex-col gap-1 rounded-xl border p-2.5 text-left text-xs … ${slotStateClasses(state)}`}>
  …
</button>
```

### GRID_RATIO
```tsx
// existing: lg:grid-cols-[3fr_2fr], xl:grid-cols-[5fr_7fr]
// new:      xl:grid-cols-[7fr_3fr]  (slot-grid / AI panel)
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | Refactor `DispenserGuidedPage` JSX + rewrite four sub-components (`PatientBanner`, `StepsCard → StepsRow`, `ThisPassList → ThisPassRow`, `ConfirmCard → ConfirmHeader`). Slot tile, camera tile, AI panel, action bar, all helpers stay. |

## NOT Building
- New backend endpoints or schema. Layout study only.
- A real "round" abstraction. Step inference remains the existing approximation.
- Patient room / bed columns. Schema has none. Keep synthetic MRN, omit "Rm / Bed".
- Allergy chip rendering changes. Already iterates `patient.allergies`; just move them.
- Navbar tweaks (theme toggle, notif bell). Out of scope.
- Changes to `lib/device.ts` / `lib/api.ts` / SWR hooks. Data sources unchanged.
- Animation polish.

---

## Step-by-Step Tasks

### Task 1: Replace `PatientBanner` with a single-row layout
- **ACTION**: Rewrite `PatientBanner` so its root is one card containing a flex row.
- **IMPLEMENT**:
  ```tsx
  function PatientBanner({ patient, status, nextRound, clock }: {…}) {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sand-200 bg-white p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-olive-100 text-sm font-bold text-olive-700 ring-2 ring-olive-200/60">
            {patient ? getInitials(patient.name) : "—"}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="truncate text-sm font-semibold text-gray-900">
                {patient?.name ?? "No active patient"}
              </p>
              {patient && (
                <span className="text-[11px] text-gray-400">
                  · {patient.age ?? "?"}y{patient.condition ? ` · ${patient.condition}` : ""}
                </span>
              )}
            </div>
            <p className="text-[10px] text-gray-400">
              MRN {patient ? `${String(7000000 + patient.id).slice(0, 4)}-${String(patient.id).padStart(3, "0")}` : "—"}
            </p>
          </div>
        </div>

        {patient && patient.allergies.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {patient.allergies.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full bg-status-danger-bg px-2 py-0.5 text-[10px] font-medium text-status-danger">
                ⚠ {a}
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px]">
          <Pill label="Cycles" value={status ? String(status.cycle_n) : "—"} />
          <Pill label="Loop" value={status?.task_running ? "running" : "stopped"} tone={status?.task_running ? "good" : "bad"} />
          <Pill label="HW" value={status?.hardware_stubbed ? "stub" : "real"} tone={status?.hardware_stubbed ? "warn" : "good"} />
          <Pill label="Drawer" value={status?.is_unlocked ? "unlocked" : "locked"} tone={status?.is_unlocked ? "warn" : "good"} />
        </div>

        <div className="flex items-center gap-3 border-l border-sand-200 pl-4">
          <div>
            <p className="text-[10px] text-gray-400">Next round</p>
            <p className="font-mono text-sm text-gray-900">
              <span className="font-semibold">{nextRound?.time ?? "—"}</span>
              <span className="ml-2 text-[11px] font-normal text-gray-500">{nextRound?.in ?? "no schedule"}</span>
            </p>
          </div>
          {patient && (
            <Link href={`/patients/${patient.id}`} className="rounded-full border border-sand-200 bg-white px-3 py-1.5 text-[11px] font-medium text-gray-700 transition-colors hover:bg-sand-50">
              View chart
            </Link>
          )}
        </div>
        <span className="hidden font-mono text-[10px] text-gray-400 sm:inline">{clock}</span>
      </div>
    );
  }
  ```
- **MIRROR**: `CARD_WRAPPER`, `STATUS_PILL`.
- **IMPORTS**: `Link`, `Pill`, `getInitials` (all exist).
- **GOTCHA**: Reference shows "Rm 412 · Bed 2" but `patients` table has no such columns. Omit. Add a `// TODO: room/bed columns` comment near the meta line.
- **VALIDATE**: visually compare to reference — single bordered row; allergies right of name; pills right-justified; Next round + View chart on the far right.

### Task 2: Replace `StepsCard` with an inline `StepsRow`
- **ACTION**: Convert 4-step block into one row with connector lines and cycle/clock pushed right.
- **IMPLEMENT**:
  ```tsx
  function StepsRow({ stepIdx, cycleN, clock }: { stepIdx: number; cycleN: number; clock: string }) {
    const steps = ["Verify patient", "Eject pill", "Confirm intake", "Sign off"];
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-2.5">
        <div className="flex flex-1 items-center gap-2">
          {steps.map((label, i) => {
            const done = i < stepIdx;
            const current = i === stepIdx;
            return (
              <div key={label} className="flex items-center gap-2">
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  done ? "bg-status-success-bg text-status-success"
                  : current ? "bg-olive-700 text-white ring-2 ring-olive-300"
                  : "bg-sand-100 text-gray-400"
                }`}>
                  {done ? "✓" : i + 1}
                </div>
                <span className={`text-xs ${current ? "font-semibold text-gray-900" : "text-gray-500"}`}>{label}</span>
                {i < steps.length - 1 && (
                  <span className={`h-px w-6 ${done ? "bg-olive-400" : "bg-sand-200"}`} />
                )}
              </div>
            );
          })}
        </div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-gray-400">
          {hourLabel()} round · cycle {cycleN} · {clock}
        </p>
      </div>
    );
  }
  function hourLabel(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  }
  ```
- **MIRROR**: `CARD_WRAPPER`, `STEP_DOT`.
- **IMPORTS**: existing.
- **GOTCHA**: At <~1100px the cycle string wraps to a second line via flex-wrap. Acceptable.
- **VALIDATE**: at 1440px steps + connectors + cycle string all on one row.

### Task 3: Replace `ThisPassList` with `ThisPassRow`
- **ACTION**: Turn the vertical list into a horizontal chip strip.
- **IMPLEMENT**:
  ```tsx
  function ThisPassRow({ slots, currentSlot, confirmed }: {…}) {
    const display = slots.slice(0, 4);
    const total = slots.length;
    const doneCount = [...confirmed].filter((c) => slots.some((s) => s.slot === c)).length;
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-2.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">This pass</span>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {display.length === 0 && (
            <span className="text-xs text-gray-400">No medications loaded.</span>
          )}
          {display.map((s, i) => {
            const isDone = confirmed.has(s.slot);
            const isCurrent = currentSlot?.slot === s.slot && !isDone;
            return (
              <span key={s.id}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                  isCurrent ? "bg-olive-50 ring-1 ring-olive-300"
                  : isDone ? "bg-sand-50 text-gray-400"
                  : "bg-sand-50"
                }`}
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                  isDone ? "bg-status-success-bg text-status-success"
                  : isCurrent ? "bg-olive-700 text-white"
                  : "bg-sand-200 text-gray-500"
                }`}>
                  {isDone ? "✓" : i + 1}
                </span>
                <span className={isDone ? "line-through" : ""}>
                  {s.name}{s.pills_per_dose > 1 ? ` ×${s.pills_per_dose}` : ""}
                </span>
                <span className="rounded-full bg-sand-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                  S{s.slot}
                </span>
              </span>
            );
          })}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-gray-400">{doneCount} / {total} done</span>
      </div>
    );
  }
  ```
- **MIRROR**: `CARD_WRAPPER`, `STEP_DOT` (smaller).
- **IMPORTS**: existing.
- **GOTCHA**: completed items use `line-through`. Don't lose it.
- **VALIDATE**: done chip strikes through name; current chip has olive ring.

### Task 4: Replace `ConfirmCard` with bare `ConfirmHeader`
- **ACTION**: Drop the border + padding card. Bare typography + right-aligned legend dots (non-interactive caption).
- **IMPLEMENT**:
  ```tsx
  function ConfirmHeader({ stepIdx, patient, slot }: {…}) {
    const stepLabels = ["Verify patient", "Eject pill", "Confirm intake", "Sign off"];
    const headline =
      stepIdx === 0 ? "Verify the patient at the cabinet."
      : stepIdx === 1 ? `Ejecting ${slot?.name ?? "medication"} from slot ${slot?.slot ?? "?"}.`
      : stepIdx === 2 ? `Confirm ${patient?.name?.split(" ")[0] ?? "the patient"} took the pill.`
      : stepIdx === 3 ? "Sign off this round."
      : "Round complete.";
    return (
      <div className="flex flex-col gap-3 px-1 pt-2 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Step {Math.min(stepIdx + 1, 4)} of 4 · {stepLabels[Math.min(stepIdx, 3)]}
          </p>
          <h2 className="mt-1 font-[family-name:var(--font-display)] text-2xl text-gray-900">
            {headline}
          </h2>
          <p className="mt-1 text-xs text-gray-600">
            {slot ? (
              <>
                <span className="font-semibold text-gray-800">
                  {slot.name}{slot.pills_per_dose > 1 ? ` ×${slot.pills_per_dose}` : ""}
                </span>{" "}
                from slot <span className="font-mono">{String(slot.slot).padStart(2, "0")}</span>.
              </>
            ) : "Awaiting active medication."}{" "}
            Watch the patient camera and confirm — or override if the AI got it wrong.
          </p>
        </div>
        <StateLegend />
      </div>
    );
  }

  function StateLegend() {
    const items = [
      { label: "Ready",   cls: "bg-status-success" },
      { label: "Ejected", cls: "bg-olive-700" },
      { label: "Low",     cls: "bg-status-warning" },
      { label: "Empty",   cls: "bg-status-danger" },
      { label: "Locked",  cls: "bg-sand-300" },
    ];
    return (
      <div className="flex flex-wrap gap-3 md:gap-4">
        {items.map((it) => (
          <span key={it.label} className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${it.cls}`} aria-hidden />
            {it.label}
          </span>
        ))}
      </div>
    );
  }
  ```
- **MIRROR**: `STATE_LEGEND_DOT`.
- **IMPORTS**: existing.
- **GOTCHA**: intentionally NO card border. Removing `rounded-2xl border …` is the point.
- **VALIDATE**: uppercase eyebrow → big serif headline → body line → 5 dot-legends right-aligned. No surrounding box.

### Task 5: Restructure outer grid — Slot grid (7fr) + AI panel (3fr), then cams row
- **ACTION**: Replace the existing `xl:grid-cols-[5fr_7fr]` block with two siblings: a 7:3 row, then a full-width 2-col cam row.
- **IMPLEMENT**:
  ```tsx
  <div className="grid grid-cols-1 gap-4 xl:grid-cols-[7fr_3fr]">
    <SlotGrid …/>
    <AIIntakeCheck intake={intake} patient={activePatient} />
  </div>

  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
    <CameraTile label="Cam 0 · Tray"    url={cam0Src} clock={fmtClock(now)} footer={cam0Footer} />
    <CameraTile label="Cam 1 · Patient" url={cam1Src} clock={fmtClock(now)} footer={cam1Footer} />
  </div>
  ```
- **MIRROR**: `GRID_RATIO`.
- **IMPORTS**: same.
- **GOTCHA 1**: hoist `cam0Footer` / `cam1Footer` to `const` declarations in the page component so the JSX stays compact. Footer logic moves verbatim.
- **GOTCHA 2**: parent grid default `align-items: stretch` keeps AI panel height-matching the slot grid — no extra classes needed.
- **VALIDATE**: 7:3 holds at `xl` (≥1280px); slot grid renders 5×2; AI panel right of it; cams equal width below.

### Task 6: Update `SlotGrid` inner grid to 5 columns
- **ACTION**: Single-line change inside `SlotGrid`.
- **IMPLEMENT**:
  ```tsx
  // Before: <div className="grid grid-cols-2 gap-2">
  // After:
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
  ```
- **MIRROR**: `SLOT_TILE` (unchanged inside).
- **IMPORTS**: none.
- **GOTCHA**: 5 columns on <640px is cramped. Responsive fallback keeps mobile usable.
- **VALIDATE**: 10 tiles render 5×2 at desktop width.

### Task 7: Wire new render order
- **ACTION**: Replace the JSX return so children read top-to-bottom:
  `PatientBanner → warnings → StepsRow → ThisPassRow → ConfirmHeader → SlotGrid+AI row → Cams row → ActionBar`.
- **IMPLEMENT**:
  ```tsx
  return (
    <div className="space-y-4">
      <PatientBanner patient={activePatient} status={status} nextRound={nextRound} clock={fmtClock(now)} />
      {!configured && (<…existing not-configured banner…/>)}
      {statusError && configured && (<…existing error banner…/>)}
      {msg && (<…existing msg banner…/>)}
      <StepsRow stepIdx={stepIdx} cycleN={status?.cycle_n ?? 0} clock={fmtClock(now)} />
      <ThisPassRow slots={activeSlots} currentSlot={currentSlot} confirmed={confirmedSlots} />
      <ConfirmHeader stepIdx={stepIdx} patient={activePatient} slot={currentSlot} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[7fr_3fr]">
        <SlotGrid slots={slots} ejectedSlot={ejectedSlot} drawerUnlocked={drawerUnlocked} busy={busy} configured={configured} onEject={onEject} onUnlockDrawer={onUnlockDrawer} />
        <AIIntakeCheck intake={intake} patient={activePatient} />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CameraTile label="Cam 0 · Tray"    url={cam0Src} clock={fmtClock(now)} footer={cam0Footer} />
        <CameraTile label="Cam 1 · Patient" url={cam1Src} clock={fmtClock(now)} footer={cam1Footer} />
      </div>
      <ActionBar …/>
    </div>
  );
  ```
- **MIRROR**: existing render skeleton.
- **IMPORTS**: drop unused props from the new `ConfirmHeader` signature (`ejectedSlot`, `drawerUnlocked`, `anyEmpty`, `anyLow`) — they now live in the static `StateLegend`. Keep them on `SlotGrid`.
- **GOTCHA**: rename old components — `ConfirmCard → ConfirmHeader`, `StepsCard → StepsRow`, `ThisPassList → ThisPassRow`. Remove old definitions. A `git grep` after refactor should return zero references to the old names.
- **VALIDATE**: `cd frontend && npm run build` is clean; page renders top-to-bottom in the new order.

---

## Testing Strategy

### Unit Tests
No unit-test harness in this repo. Manual visual diff against the reference is the validation gate.

### Edge Cases Checklist
- [ ] **No patient assigned** — banner shows "No active patient" + em-dash MRN; downstream blocks render with `stepIdx = 0` and empty `activeSlots`.
- [ ] **Patient with no allergies** — allergy chip block hides without gap.
- [ ] **Device unreachable** (`status` null) — status pills render `—`; statusError banner appears between PatientBanner and StepsRow.
- [ ] **`isDeviceConfigured() === false`** — yellow banner appears; cams show `Stream unavailable`; SlotGrid tiles disabled.
- [ ] **Narrow viewport (≤768px)** — patient banner wraps; steps row wraps cycle to a second line; slot grid falls back to 2 columns.
- [ ] **Intake passed** — `ConfirmHeader` shifts to "Sign off this round."; AI panel shows ✓ Confirmed.
- [ ] **All four meds confirmed** — `ThisPassRow` shows "4 / 4 done"; `ConfirmHeader` reads "Round complete.".

---

## Validation Commands

### Static Analysis (type-check)
```bash
cd frontend && npm run build
```
EXPECT: Zero TypeScript errors. Build also exercises Tailwind compile.

### Lint
```bash
cd frontend && npm run lint
```
EXPECT: Skipped — `next lint` interactive in this repo. Rely on the build's type-check.

### Browser Validation
```bash
cd frontend && npm run dev
```
EXPECT: Open `http://localhost:3000/dispensers/dispenser-001` and compare side-by-side with the reference. Check:
- [ ] Patient banner is ONE row.
- [ ] Steps row is ONE inline row with cycle text right-aligned.
- [ ] This-pass is a horizontal chip row, "N / M done" on the right.
- [ ] Confirm block has NO card border.
- [ ] Slot grid is 5 columns × 2 rows.
- [ ] AI panel sits to the right of slot grid (3fr).
- [ ] Two cams form their own row below.
- [ ] Action bar still sticks to bottom.

### Manual Button Smoke
- [ ] Click a slot → `manualEject` fires.
- [ ] Toggle drawer → `setDrawer` fires.
- [ ] Re-snapshot → cam URLs re-key.
- [ ] Override · note → textarea appears, save inserts adherence row.
- [ ] Confirm & continue → `createIntakeLog({ pill_taken: true })` + `triggerDispense()`.
- [ ] View chart → navigates to `/patients/{id}`.

---

## Acceptance Criteria
- [ ] Layout matches the reference screenshot (positions + ratios per Phase 4).
- [ ] All existing handlers still fire — no regression.
- [ ] `npm run build` passes.
- [ ] No new dependencies added.
- [ ] No backend changes.

## Completion Checklist
- [ ] Single-file diff: only `frontend/src/app/dispensers/[id]/page.tsx`.
- [ ] No dead components left behind (old `StepsCard`, `ThisPassList`, `ConfirmCard` removed).
- [ ] `SlotGrid` inner grid is responsive `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5`.
- [ ] Outer slot/AI grid is `xl:grid-cols-[7fr_3fr]`.
- [ ] Cams live in a sibling `md:grid-cols-2` row.
- [ ] `ConfirmHeader` is bare (no card border).
- [ ] Patient banner is one bordered row.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Slot grid 5×2 doesn't fit at 1280px | Med | Tile labels truncate | Cards already use `truncate` on name + `text-[11px]` qty. If still tight, accept truncation or step down to `lg:grid-cols-4 xl:grid-cols-5`. |
| Status pills row overflows when 5+ metrics | Low | Visual wrap | Banner uses `flex-wrap`; pills wrap gracefully. |
| Removing `ConfirmCard`'s `StateChip` removes the at-a-glance "any slot empty" hint | Low | Slight info loss | The replacement `StateLegend` is a static caption; actual state is rendered on each slot tile directly. No net info loss. |
| Dropping the mockup's "Rm 412 · Bed 2" data | Low | Cosmetic | Documented in NOT Building. Add the columns later when demo requires bed-level data. |
| Cams now span full page width — taller page | Med | More vertical scroll | Matches the reference; sticky action bar keeps controls reachable. |

## Notes
- Reference rendered at ~1440×1180. The 7:3 ratio matches the mockup grid. Tailwind arbitrary-value `xl:grid-cols-[7fr_3fr]` expresses it directly.
- Sub-component renames (`StepsCard → StepsRow`, etc.) describe layout intent. A `git grep` after refactor should return zero references to old names.
- `Pill` helper already applies tone via `text-status-success` etc. — no change needed.
- ActionBar already implements every button the mockup shows, including the kbd "↵" chip. No work needed there.
