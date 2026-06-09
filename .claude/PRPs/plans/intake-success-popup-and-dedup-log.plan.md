# Plan: Intake-success pop-up + de-duplicated intake log

## Summary
When the swallow/mouth-open FSM finishes successfully during intake verification on the dispenser
page, show a modal confirming the patient took their medication, surface the key intake parameters,
and offer a CTA that advances the operator to the in-flow **Log** step to finalize the record.
Separately, fix the `IntakeLog` dashboard component so realtime inserts no longer render duplicate
"Taken/Done" rows.

## User Story
As a nurse/pharmacist operating the dispenser, I want a clear success pop-up the moment the AI
confirms the patient swallowed the pill (with the key proof parameters) and a one-click path to the
logging step, so that I can confidently finalize the intake log — and I want the intake log list to
show each event exactly once instead of duplicated entries.

## Problem → Solution
- **Problem A:** When intake passes (`intake.result === "passed"`), the wizard silently auto-advances
  to the Log step. There is no affirmative "medication taken" confirmation surfacing the proof
  parameters, and no explicit CTA into logging.
  **Solution A:** A centered modal fires once per round on the `null/running → "passed"` transition,
  shows the key params, and its CTA calls `goToStep(4)` (the Log step) and dismisses.
- **Problem B:** `IntakeLog.tsx` prepends every Supabase realtime `INSERT` with no dedup by `id`.
  Combined with the 30 s SWR refetch (`useLogs`) and React StrictMode double-subscribe in `next dev`,
  the same adherence row appears multiple times.
  **Solution B:** Dedup by `id` in the realtime handler (and harden the `initialLogs` merge) so each
  row renders once.

## Metadata
- **Complexity**: Small–Medium
- **Source PRD**: N/A (free-form feature request)
- **PRD Phase**: N/A
- **Estimated Files**: 2

---

## UX Design

### Before
```
Step 3 "Verify": AI watches patient.
intake.result flips to "passed"
        │  (silent)
        ▼
viewIdx auto-swaps to Step 5 "Log" (IntakeReportCard + Confirm/Override)
No explicit "medication taken" confirmation; operator may miss the transition.

Dashboard "Recent Intake Log":
  • Mary · Slot 2 · Taken   14:32
  • Mary · Slot 2 · Taken   14:32   ← duplicate
  • John · Slot 1 · Taken   14:30
  • John · Slot 1 · Taken   14:30   ← duplicate
```

### After
```
Step 3 "Verify": AI watches patient.
intake.result flips to "passed"  (first time this round)
        │
        ▼
┌────────────────────────────────────────────┐
│  ✓  Medication taken                        │
│                                             │
│  Patient    Mary Tan                        │
│  Medication Slot 2 · Atorvastatin           │
│  Swallow    confirmed · 92% confidence      │
│  Labels     bottle, pill seen ✓             │
│  Duration   7.4s   Time 14:32:05            │
│                                             │
│           [ Go to logging → ]               │
└────────────────────────────────────────────┘
   backdrop click / Esc / × dismiss → reveals Step 5 "Log" underneath
   "Go to logging →" → goToStep(4) + close

Dashboard "Recent Intake Log":
  • Mary · Slot 2 · Taken   14:32
  • John · Slot 1 · Taken   14:30   ← each event once
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Intake passes | Silent auto-advance to Log step | One-time modal with proof params + CTA | Fires once per round (ref-guarded) |
| Modal dismiss | N/A | Backdrop / Esc / × close; CTA → `goToStep(4)` | Wizard is already on step 4 behind the modal |
| Dashboard log list | Duplicate rows on realtime insert | One row per `id` | No visual/animation change otherwise |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 218–262 | Main component state + the existing once-guard refs to mirror (`lastSpokenStepRef`, `wrongPillSpokenRef`) |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 292–328 | `fetchIntakeState` 250 ms poll + the milestone effect pattern (model the popup-trigger effect on this) |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 443–522 | `goToStep`, `stepIdx`, the auto-swap-to-step effect; confirms passed→viewIdx 4 already happens |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 1046–1085 | Step 5 "Log" render (`viewIdx === 4`) — the CTA destination |
| P1 | `frontend/src/app/dispensers/[id]/page.tsx` | 1763–1854 | `IntakeReportCard` — `fmtTime`/`fmtDuration` + param derivations to mirror in the modal |
| P1 | `frontend/src/app/patients/page.tsx` | 257–281 | Centered-modal pattern to mirror exactly (backdrop, `animate-fade-up`, close button) |
| P1 | `frontend/src/components/IntakeLog.tsx` | 12–53 | Realtime subscription + `initialLogs` reset — the dedup target |
| P2 | `frontend/src/lib/device.ts` | 39–73 | `IntakeState` / `IntakeStepHistoryRow` shape (all popup params come from here) |
| P2 | `frontend/src/lib/api.ts` | 30–39 | `IntakeRecord` shape (has `id` — the dedup key) |
| P2 | `frontend/src/lib/swr.ts` | 28–68 | `KEYS.logs`, `INTERVAL.logs = 30 s` — the refetch that races realtime |
| P2 | `frontend/src/app/globals.css` | 55–139 | Available animations: `animate-fade-up`, `animate-fade-in` (no new keyframes needed) |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| Supabase Realtime duplicate delivery | (internal pattern) | Postgres-changes events are at-least-once; client must dedup by primary key. Plus `next dev` StrictMode mounts effects twice. Dedup-by-`id` covers both. |

No external research needed — feature uses established internal React/Tailwind/Supabase patterns already in this repo.

---

## Patterns to Mirror

### ONCE_GUARD_REF (fire-once-per-round, resists the 250 ms poll)
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:259-262, 314-328
const lastSpokenStepRef = useRef<number>(-1);

useEffect(() => {
  if (!intake?.running) {
    lastSpokenStepRef.current = -1; // reset when watch stops
    return;
  }
  const idx = intake.step_index ?? 0;
  if (idx === lastSpokenStepRef.current) return; // already handled
  lastSpokenStepRef.current = idx;
  // ...side effect once per change...
}, [intake?.running, intake?.step_index, intake?.step_name, intake?.instruction]);
```

### STEP_NAVIGATION
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:443-445
const goToStep = (idx: number) => {
  setViewIdx(Math.max(0, Math.min(idx, 4)));
};
```

### CENTERED_MODAL
```tsx
// SOURCE: frontend/src/app/patients/page.tsx:258-281
{showModal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/30 backdrop-blur-sm"
      onClick={() => setShowModal(false)}
    />
    <div className="animate-fade-up relative w-full max-w-lg rounded-2xl border border-sand-200 bg-white p-6 shadow-xl">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="font-[family-name:var(--font-display)] text-xl text-gray-900">New Patient</h2>
        <button onClick={() => setShowModal(false)} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-sand-100 hover:text-gray-600">
          {/* × svg */}
        </button>
      </div>
      {/* body */}
    </div>
  </div>
)}
```

### ESC_TO_CLOSE
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:525-532
useEffect(() => {
  if (!advancedOpen) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAdvancedOpen(false); };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [advancedOpen]);
```

### PARAM_FORMATTERS (reuse in the modal)
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:1838-1854
const fmtTime = (s: number | null) =>
  s === null ? "—" : new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fmtDuration = (s: number | null) => {
  if (s === null) return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60); const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
};
```

### REALTIME_SUBSCRIBE (current — the bug)
```tsx
// SOURCE: frontend/src/components/IntakeLog.tsx:22-37
const channel = supabase
  .channel("adherence_realtime")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "adherence_logs" },
    (payload) => {
      setLogs((prev) => [payload.new as IntakeRecord, ...prev]); // ← no dedup
    })
  .subscribe();
return () => { supabase.removeChannel(channel); };
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | Add popup state + ref-guarded trigger effect + `IntakeSuccessModal` component + render slot |
| `frontend/src/components/IntakeLog.tsx` | UPDATE | Dedup realtime inserts by `id`; harden `initialLogs` merge |

## NOT Building
- No auto-creation of the adherence log from the popup. Logging stays explicit via the existing
  step-5 Confirm/Override (`logIntake`). The popup only navigates there.
- No changes to the backend FSM (`backend/vision/intake_monitor.py`), the Pi loop, or any API.
- No new modal/toast library, no new global animation keyframes (reuse `animate-fade-up`).
- No redesign of `IntakeLog` beyond dedup (badges, filter, layout unchanged).
- No popup for failure terminals (`timeout`, `missing_labels`) — success only, per request.
- No change to the `/reports` page (it is a "Coming Soon" stub and unrelated).

---

## Step-by-Step Tasks

### Task 1: Add popup state + once-per-round guard ref
- **ACTION**: In `DispenserGuidedPage` add a boolean state and a guard ref.
- **IMPLEMENT**:
  ```tsx
  const [intakeSuccessOpen, setIntakeSuccessOpen] = useState(false);
  // Fires the success modal once per round on the first "passed" we see.
  const intakeSuccessShownRef = useRef<boolean>(false);
  ```
  Place the `useState` near the other dispenser states (around line 244) and the `useRef` near the
  other guard refs (around line 262).
- **MIRROR**: ONCE_GUARD_REF.
- **IMPORTS**: `useState`, `useRef` already imported at top of file — verify, add nothing new.
- **GOTCHA**: Do not reuse `lastSpokenStepRef`; this is a distinct round-level latch.
- **VALIDATE**: Type-checks; new identifiers referenced only by Task 2/4 code.

### Task 2: Add the ref-guarded trigger effect
- **ACTION**: Add a `useEffect` that opens the modal exactly once when `intake.result` becomes
  `"passed"`, and resets the latch when a new round starts.
- **IMPLEMENT**:
  ```tsx
  // Show the "medication taken" modal once per round, the moment the swallow
  // FSM passes. Reset the latch whenever a fresh watch starts (running with no
  // terminal result yet) so the next round can fire again. Guarded against the
  // 250 ms intake poll re-triggering on every tick.
  useEffect(() => {
    if (intake?.result === "passed") {
      if (!intakeSuccessShownRef.current) {
        intakeSuccessShownRef.current = true;
        setIntakeSuccessOpen(true);
      }
    } else if (intake?.running && intake.result === null) {
      // a new round is underway — arm the latch for the next pass
      intakeSuccessShownRef.current = false;
    }
  }, [intake?.result, intake?.running]);
  ```
- **MIRROR**: the milestone effect at lines 314–328 (poll-resistant, ref-guarded).
- **GOTCHA**: Depend on `intake?.result` and `intake?.running` only — not the whole `intake` object,
  which changes every 250 ms and would defeat the guard's intent (the ref still protects, but keep
  deps tight to match house style). Resetting the latch on `running && result === null` (not merely
  `!running`) avoids a flash where `result` lingers as `"passed"` after the watch stops.
- **VALIDATE**: With a stubbed `intake` flipping to `passed`, modal opens once; staying `passed`
  across many polls does not re-open after manual dismiss.

### Task 3: Build the `IntakeSuccessModal` component
- **ACTION**: Add a presentational modal component at the bottom of the file (alongside the other
  helper components like `IntakeReportCard`, before/after it).
- **IMPLEMENT**: Props `{ open, patient, slot, intake, onClose, onGoToLog }`. Render nothing when
  `!open`. Mirror CENTERED_MODAL. Derive params from `IntakeState`/`SlotInfo`:
  - Patient: `patient?.name ?? "Patient"`
  - Medication: `Slot {slot?.slot} · {slot?.name ?? "—"}`
  - Swallow: `confirmed · {Math.round((intake?.confidence ?? 0) * 100)}% confidence`
  - Labels (Layer-2): if `intake?.labels_seen?.length`, show `{intake.labels_seen.join(", ")} seen ✓`;
    else `"—"`. (Use `labels_satisfied` to pick the ✓ vs neutral tone.)
  - Duration: `fmtDuration(startedAt !== null ? (endedAt ?? Date.now()/1000) - startedAt : null)`
    where `startedAt = intake?.started_at ?? null`, `endedAt = intake?.ended_at ?? null`.
  - Time: `fmtTime(intake?.ended_at ?? null)`.
  Use the success palette already in the file: `border-status-success`, `bg-status-success-bg`,
  `text-status-success`, check icon (`✓`). CTA button styled like the existing primary action
  (`rounded-full border border-olive-300 bg-olive-700 ... text-white hover:bg-olive-800`) labelled
  `Go to logging →`, calling `onGoToLog`. Include a top-right `×` close button and a backdrop click
  → `onClose`.
- **MIRROR**: CENTERED_MODAL (structure), PARAM_FORMATTERS (copy `fmtTime`/`fmtDuration` locally — they
  are module-private to `IntakeReportCard`, so re-declare inside this component), IntakeReportCard
  success palette (lines 1811–1817).
- **IMPORTS**: Types `Patient` (from `@/lib/api`), `SlotInfo` (already imported in this file),
  `IntakeState` (already imported). No new imports.
- **GOTCHA**: `intake.confidence`/`hold_progress` are `0..1` fractions — multiply by 100 and round.
  `started_at`/`ended_at` are epoch **seconds**, so multiply by 1000 for `Date`. Match
  `IntakeReportCard` which already treats them as seconds.
- **VALIDATE**: Renders with realistic stub values; numbers and time format match `IntakeReportCard`.

### Task 4: Render the modal + wire Esc and CTA
- **ACTION**: Render `<IntakeSuccessModal>` near the end of the page JSX (e.g. just before
  `<AdvancedSheet .../>` around line 1121) and add an Esc-to-close effect.
- **IMPLEMENT**:
  ```tsx
  <IntakeSuccessModal
    open={intakeSuccessOpen}
    patient={activePatient}
    slot={currentSlot}
    intake={intake}
    onClose={() => setIntakeSuccessOpen(false)}
    onGoToLog={() => {
      setIntakeSuccessOpen(false);
      goToStep(4); // Step 5 "Log"
    }}
  />
  ```
  Add an Esc handler mirroring ESC_TO_CLOSE, gated on `intakeSuccessOpen`.
- **MIRROR**: ESC_TO_CLOSE (lines 525–532).
- **GOTCHA**: `goToStep` clamps to ≤ 4, so passing `4` is correct (Log = viewIdx 4). When the modal
  opens, `stepIdx` is already 4 (passed) and the auto-swap effect has set `viewIdx` to 4, so the Log
  card is already mounted behind the backdrop — the CTA simply reveals it. Keep `goToStep(4)` anyway
  so the CTA is correct even if the operator had navigated back to preview an earlier card.
- **VALIDATE**: Clicking CTA closes modal and shows step 5; Esc and backdrop also close.

### Task 5: Dedup realtime inserts in `IntakeLog`
- **ACTION**: In `frontend/src/components/IntakeLog.tsx`, dedup by `id` in the realtime handler and
  harden the `initialLogs` reset so a freshly-arrived realtime row isn't dropped or duplicated.
- **IMPLEMENT**:
  ```tsx
  // realtime handler (replaces line 28-30):
  (payload) => {
    const row = payload.new as IntakeRecord;
    setLogs((prev) =>
      prev.some((l) => l.id === row.id) ? prev : [row, ...prev],
    );
  },
  ```
  And replace the `initialLogs` reset effect (lines 16–18) with a dedup-aware merge that keeps any
  realtime rows not yet present in the refetched snapshot:
  ```tsx
  useEffect(() => {
    setLogs((prev) => {
      const seen = new Set(initialLogs.map((l) => l.id));
      const extras = prev.filter((l) => !seen.has(l.id)); // realtime rows newer than the refetch
      return [...extras, ...initialLogs];
    });
  }, [initialLogs]);
  ```
- **MIRROR**: REALTIME_SUBSCRIBE (the block being fixed); existing `useState`/`useEffect` style in the
  same file.
- **GOTCHA**: `IntakeRecord.id` is a `number` primary key (api.ts:31) — a reliable dedup key. Keep the
  channel name `"adherence_realtime"` and the `removeChannel` cleanup unchanged; dedup-by-`id` already
  neutralizes the StrictMode double-subscribe and any at-least-once duplicate delivery. Preserve the
  comment at lines 20–21 (do not switch to `/api/logs/ws`).
- **VALIDATE**: Inserting the same adherence row twice via realtime yields one list entry; the 30 s
  SWR refetch does not re-duplicate.

---

## Testing Strategy

No automated test suite exists in this repo (see CLAUDE.md). Validation is type-check + lint + manual.

### Manual test matrix
| Test | Steps | Expected |
|---|---|---|
| Popup fires once | Drive a round to `intake.result === "passed"` | Modal appears exactly once with correct params |
| Poll does not re-open | Leave on `passed` for ≥ several 250 ms polls after dismiss | Modal stays closed |
| New round re-arms | Start a second watch (`running`, `result === null`) then pass again | Modal fires again |
| CTA navigation | Click "Go to logging →" | Modal closes; step 5 "Log" card visible |
| Dismiss paths | Backdrop click / Esc / × | Modal closes; underlying step unchanged |
| Failure terminal | Drive to `timeout` / `missing_labels` | No modal |
| Log dedup (realtime) | Trigger an intake log insert with dashboard open | One row added, not two |
| Log dedup (refetch) | Wait for the 30 s `useLogs` refresh after a realtime insert | Still one row |
| Log dedup (dev StrictMode) | Run `npm run dev`, insert a log | One row (no double from double-subscribe) |

### Edge Cases Checklist
- [ ] `intake` null / partial (missing `started_at`) → formatters return "—", no crash
- [ ] `slot` or `patient` null → modal shows graceful fallbacks
- [ ] `labels_seen` empty (Layer-2 disabled) → labels row shows "—", no ✓
- [ ] Operator manually navigated to step 0–3 when pass occurs → CTA still lands on step 5
- [ ] Realtime row already present in `initialLogs` → no duplicate after merge

---

## Validation Commands

### Static analysis / type-check (build)
```bash
cd frontend && npm run build
```
EXPECT: Compiles with zero type errors.

### Lint
```bash
cd frontend && npm run lint
```
EXPECT: No new lint errors.

### Dev server (manual)
```bash
cd frontend && npm run dev   # http://localhost:3000
```
EXPECT: Dispenser page shows the success modal on intake pass; dashboard intake log shows no dupes.

### Database / migrations
N/A — no schema change.

### Manual Validation
- [ ] Run the manual test matrix above against a live/stubbed device.

---

## Acceptance Criteria
- [ ] Success modal appears once per round when `intake.result === "passed"`.
- [ ] Modal shows patient, medication (slot + name), swallow confidence, label confirmation, duration, time.
- [ ] CTA "Go to logging →" closes the modal and lands on the Log step (viewIdx 4).
- [ ] Backdrop / Esc / × all dismiss the modal.
- [ ] Dashboard "Recent Intake Log" shows each adherence event exactly once.
- [ ] `npm run build` and `npm run lint` pass.

## Completion Checklist
- [ ] Once-guard ref pattern matches the existing `lastSpokenStepRef`/`wrongPillSpokenRef` style.
- [ ] Modal markup mirrors the `patients/page.tsx` centered-modal pattern and reuses `animate-fade-up`.
- [ ] Status colors reuse `status-success` tokens already in the file.
- [ ] No new dependencies, no new global CSS keyframes.
- [ ] Dedup uses `IntakeRecord.id`; realtime channel + cleanup unchanged; line 20–21 comment preserved.
- [ ] No backend / Pi / API changes.
- [ ] Self-contained — no further codebase searching needed.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Latch reset logic mis-fires (modal re-opens or never re-arms) | Medium | Medium | Reset only on `running && result === null`; manual "new round re-arms" test |
| Modal stacks over `AdvancedSheet` (both `z-50`) | Low | Low | Render modal after/independent; both are dismissible; acceptable for demo |
| `initialLogs` merge keeps a stale realtime row that was later edited | Low | Low | Adherence rows are insert-only; 30 s refetch reconciles |
| Confidence shown as `0%` if `intake.confidence` not yet settled at pass | Low | Low | FSM sets confidence high at pass; value mirrors `IntakeReportCard` which has the same behavior |

## Notes
- Decision (confirmed with user): the popup CTA advances to the **in-flow Log step** (step 5 /
  viewIdx 4) where `logIntake` is invoked — it does **not** route to `/dashboard`. The "logging page"
  with duplicates is a separate surface (the dashboard `IntakeLog`) fixed in Task 5.
- `intake.result === "passed"` is the Layer-1 (MediaPipe FSM) + Layer-2 (label) combined success
  terminal — the natural "mouth-open / swallow check done" signal the request refers to. Failure
  terminals (`timeout`, `missing_labels`) intentionally show no popup.
- The wizard already auto-advances to step 5 on pass (lines 502, 518–522); the modal is an additive
  affirmation layer, not a replacement for that behavior.
