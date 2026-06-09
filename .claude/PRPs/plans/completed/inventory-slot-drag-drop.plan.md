# Plan: Drag-and-Drop Medication Slot Reassignment

## Summary
Make each filled medication slot a draggable "card". A caregiver can drag a card onto another slot to change which physical slot index a medication occupies — swapping with the med already there, or moving into an empty slot. Wired into **two** surfaces: the per-patient grid on `/inventory` and the "Bedside Dispenser" magazine on `/patients/[id]`, sharing one `moveSlot()` data-layer function.

## User Story
As a **caregiver managing a patient's bedside dispenser**, I want to **drag a medication card from one slot onto another**, so that **I can rearrange which slot holds which medication without manually re-typing the medication name and quantity into each slot.**

## Problem → Solution
**Current:** Slots are static. To "move" a med from slot 2 to slot 5 you must Remove it from slot 2 and re-Add it (name + quantity) in slot 5 — two manual edits, retypes everything, loses `expiry_date` / `pills_per_dose` / `schedule_at`.
**Desired:** Drag the slot-2 card onto slot 5. The app performs the move (empty target) or swap (occupied target) in one gesture, preserving all medication fields, scoped to a single patient's dispenser.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form feature request)
- **PRD Phase**: N/A
- **Estimated Files**: 4 (1 new shared hook, 1 API update, 2 page updates)

---

## UX Design

### Before
```
/patients/[id]  — Bedside Dispenser (read-only-ish; hover Edit/Remove only)
┌──────┬──────┬──────┬──────┬──────┐
│  #0  │  #1  │  #2  │  #3  │  #4  │
│ Asp. │ Met. │  —   │ Ibu. │  —   │   to move Asp.(#0) → #2:
├──────┼──────┼──────┼──────┼──────┤   1. Remove #0
│  #5  │  #6  │  #7  │  #8  │  #9  │   2. click empty #2 → Add Med
│  —   │  —   │  —   │  —   │  —   │   3. retype name + qty
└──────┴──────┴──────┴──────┴──────┘
```

### After
```
/patients/[id]  — Bedside Dispenser (cards now draggable)
┌──────┬──────┬──────┬──────┬──────┐
│  #0  │  #1  │ #2◄┐ │  #3  │  #4  │   drag Asp.(#0) ──┐
│ Asp.˃│ Met. │  —  │└ Ibu.│  —   │   drop on #2      │
├──────┼──────┼─────┼──────┼──────┤   ──────────────────┘
│  #5  │  #6  │  #7 │  #8  │  #9  │   #2 was empty → MOVE: #0 becomes empty,
│  —   │  —   │  —  │  —   │  —   │   #2 now holds Aspirin (qty/expiry kept)
└──────┴──────┴─────┴──────┴──────┘
   drop target shows ring highlight while dragging over it
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Filled slot card | Static; hover reveals Edit/Remove | `draggable`; grab + drag to another slot | Edit/Remove still work (drag starts on the card body, not the buttons) |
| Slot cell (any) | Inert div | Drop target; highlights on drag-over | Only accepts drops from the **same patient** |
| Empty slot | "Add Med" button only | Also a valid drop target → receives moved med | Add Med still works when not dragging |
| Cross-patient drag (inventory page) | N/A | Blocked / ignored | Different dispenser; out of scope |
| Touch devices | Tap to edit | Drag unsupported (HTML5 DnD is mouse/pointer) | Documented limitation; edit/remove unaffected |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `frontend/src/lib/api.ts` | 154-272 | `SlotInfo`, `fetchAllSlots`, `fetchSlotsByPatient`, `updateSlot`, `deleteSlot` — the exact data-access style to mirror; new `moveSlot` goes right after `deleteSlot` |
| P0 (critical) | `frontend/src/app/patients/[id]/page.tsx` | 372-485 | The magazine grid + `editingSlot`/`handleSaveSlot`/`handleDeleteSlot` patterns; where drag handlers attach |
| P0 (critical) | `frontend/src/app/inventory/page.tsx` | 244-371 | Per-patient detailed card grid (the drag target on inventory). NOT the heatmap above it |
| P1 (important) | `frontend/src/app/inventory/page.tsx` | 121-145 | `useState`/`useEffect`/`useMemo` load pattern + `slots`/`patients` state to refetch after a move |
| P1 (important) | `frontend/src/lib/supabase.ts` | all | Single shared anon-key client; all reads/writes go through `supabase` from `./supabase` |
| P2 (reference) | `frontend/src/app/patients/[id]/page.tsx` | 120-152 | `loadData()` refetch-after-mutation convention to copy for the move handler |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| HTML5 Drag and Drop | MDN `draggable`, `dragstart`, `dragover`, `drop`, `dataTransfer` | Set `draggable`, populate `e.dataTransfer` on `dragstart`, **call `e.preventDefault()` in `onDragOver`** or `drop` never fires. No library needed |
| React 19 DnD events | React synthetic `onDragStart`/`onDragOver`/`onDrop` | Standard synthetic events; identical semantics to native. No special React 19 caveat |

> No new npm dependency. Native HTML5 DnD is sufficient for this desktop caregiver dashboard. `@dnd-kit` / `react-dnd` were considered and rejected (adds a dep for a 10-cell single-axis reorder).

---

## Patterns to Mirror

### NAMING_CONVENTION
```ts
// SOURCE: frontend/src/lib/api.ts:223-272
// Slot mutations are free functions named verb + "Slot",
// take (patientId, slot, ...), go through the shared `supabase` client,
// throw on error so the caller can surface it.
export async function updateSlot(
  patientId: number,
  slot: number,
  data: { medication_name: string; quantity: number }
): Promise<SlotInfo> { /* ... */ }

export async function deleteSlot(patientId: number, slot: number): Promise<void> {
  const { error } = await supabase
    .from("medications")
    .delete()
    .eq("patient_id", patientId)
    .eq("slot", slot);
  if (error) throw error;
}
```

### ERROR_HANDLING
```ts
// SOURCE: frontend/src/lib/api.ts:225-263 (data layer throws)
//   + frontend/src/app/patients/[id]/page.tsx:89-104 (UI layer try/catch → setXxxMsg)
try {
  const updated = await updatePatient(pid, { dispenser_id: /* ... */ null });
  setPatient(updated);
  setDispenserMsg(/* ... */ "Saved");
} catch (e) {
  setDispenserMsg(`Save failed: ${(e as Error).message}`);
} finally {
  setSavingDispenser(false);
}
```

### REFETCH_AFTER_MUTATION
```ts
// SOURCE: frontend/src/app/patients/[id]/page.tsx:142-152
async function handleSaveSlot(slotNum: number) {
  if (!slotForm.medication_name.trim()) return;
  await updateSlot(pid, slotNum, slotForm);
  setEditingSlot(null);
  await loadData();          // re-pull slots after the write
}
// Inventory page equivalent: re-call fetchAllSlots().then(setSlots)
```

### STATE_LOAD_PATTERN
```ts
// SOURCE: frontend/src/app/inventory/page.tsx:121-132
const [patients, setPatients] = useState<Patient[]>([]);
const [slots, setSlots] = useState<SlotInfo[]>([]);
useEffect(() => {
  fetchPatients().then(setPatients).catch(() => {});
  fetchAllSlots().then(setSlots).catch(() => {});
}, []);
```

### GRID_CELL_RENDER (inventory, per-patient detailed grid)
```tsx
// SOURCE: frontend/src/app/inventory/page.tsx:324-367
<div className="grid grid-cols-10 gap-1.5">
  {Array.from({ length: 10 }, (_, i) => {
    const slot = patientSlots.find((s) => s.slot === i);
    const status = statusFor(slot);
    return (
      <div key={i}
        className={`rounded-lg border p-2 text-center transition-all ${statusClasses(status)}`}
        title={tooltip(slot, i)}>
        {/* #i label, name, qty */}
      </div>
    );
  })}
</div>
```

### GRID_CELL_RENDER (patient magazine)
```tsx
// SOURCE: frontend/src/app/patients/[id]/page.tsx:372-393
<div className="grid grid-cols-5 gap-3">
  {displaySlots.map((slot, i) => {
    const isEmpty = !slot; const isEditing = editingSlot === i;
    return (
      <div key={i}
        className={`group relative overflow-hidden rounded-xl border-2 p-3 text-center transition-all duration-200 ${ /* status ternary */ }`}>
        {/* badge / editing form / Add Med / med display */}
      </div>
    );
  })}
</div>
```

### TEST_STRUCTURE
```
No test suite exists in this repo (CLAUDE.md: "There is no test suite — pytest, vitest, etc. are not configured. Don't claim tests pass.").
Validation is manual + `npm run lint` + `npm run build` (Next.js type-checks during build). See Validation Commands.
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/lib/api.ts` | UPDATE | Add `moveSlot(patientId, fromSlot, toSlot)` after `deleteSlot` (api.ts:272). Handles move-to-empty vs content-swap, constraint-safe |
| `frontend/src/lib/useSlotDnd.ts` | CREATE | Shared hook returning drag state + `getCellDragProps(patientId, slot, isFilled)` so both pages wire identical handlers without duplication |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATE | Attach DnD props to magazine cells; add `handleMove` that calls `moveSlot` then `loadData()` |
| `frontend/src/app/inventory/page.tsx` | UPDATE | Attach DnD props to the per-patient detailed grid cells; add `handleMove` that calls `moveSlot` then refetches `fetchAllSlots` |

## NOT Building
- **Cross-patient / cross-dispenser drag.** A drop is only accepted when source and target share the same `patient_id`. Moving a med to another patient's dispenser is out of scope.
- **Drag-drop on the inventory "All Slots" heatmap** (`inventory/page.tsx:157-242`). That row is a cramped cross-patient overview; only the per-patient detailed grid (lines 244-371) becomes draggable.
- **Touch / pointer-drag support.** HTML5 DnD is mouse-driven; touch devices keep tap-to-edit. No `@dnd-kit` migration.
- **Field editing during drag.** Drag only relocates an existing med as-is; field editing stays in the existing inline edit form.
- **Optimistic UI / undo.** Mirror existing refetch-after-write; no optimistic state or undo toast.
- **Backend (`backend/`) or Pi changes.** Slot index semantics on the Pi are unaffected — the magazine still maps slot 0-9 to physical positions; we only change which med sits at which index, same as a manual edit does today.

---

## Step-by-Step Tasks

### Task 1: Add `moveSlot` to the data layer
- **ACTION**: Add an exported async function `moveSlot(patientId, fromSlot, toSlot)` in `frontend/src/lib/api.ts`, immediately after `deleteSlot` (after line 272).
- **IMPLEMENT**:
  ```ts
  /**
   * Relocate the medication at `fromSlot` to `toSlot` within ONE patient's
   * dispenser. Two cases, both constraint-safe:
   *   • target empty   → UPDATE the source row's `slot` (one write).
   *   • target filled  → SWAP the medication-identifying columns between the
   *                      two rows, leaving `slot`/`id`/`patient_id` fixed.
   *
   * Why swap content instead of swapping the `slot` values: the table has
   *   UNIQUE (patient_id, slot)  AND  CHECK (slot BETWEEN 0 AND 9)
   * so there is NO legal "parking" slot to stash a row in mid-swap, and
   * supabase-js cannot issue a single multi-row UPDATE with per-row values.
   * Swapping the content columns achieves the same visible result with two
   * plain by-id updates and never touches the unique/range-constrained slot.
   */
  export async function moveSlot(
    patientId: number,
    fromSlot: number,
    toSlot: number,
  ): Promise<void> {
    if (fromSlot === toSlot) return;

    // Pull both rows with all columns (need every med field for the swap).
    const { data: rows, error: readErr } = await supabase
      .from("medications")
      .select("*")
      .eq("patient_id", patientId)
      .in("slot", [fromSlot, toSlot]);
    if (readErr) throw readErr;

    const src = (rows ?? []).find((r) => r.slot === fromSlot);
    const dst = (rows ?? []).find((r) => r.slot === toSlot);
    if (!src) return; // nothing to move (source empty)

    if (!dst) {
      // Target empty → just move the slot index of the source row.
      const { error } = await supabase
        .from("medications")
        .update({ slot: toSlot })
        .eq("id", src.id);
      if (error) throw error;
      return;
    }

    // Both filled → swap the medication-identifying columns by id.
    const fields = (r: Record<string, unknown>) => ({
      name: r.name,
      description: r.description,
      quantity: r.quantity,
      expiry_date: r.expiry_date,
      pills_per_dose: r.pills_per_dose,
      schedule_at: r.schedule_at,
    });
    const { error: e1 } = await supabase
      .from("medications").update(fields(dst)).eq("id", src.id);
    if (e1) throw e1;
    const { error: e2 } = await supabase
      .from("medications").update(fields(src)).eq("id", dst.id);
    if (e2) throw e2;
  }
  ```
- **MIRROR**: `NAMING_CONVENTION`, `ERROR_HANDLING` (throw on error), `deleteSlot` filter style (`.eq("patient_id", ...)`).
- **IMPORTS**: none new — `supabase` already imported at top of `api.ts:1`.
- **GOTCHA**:
  - `UNIQUE (patient_id, slot)` + `CHECK (slot BETWEEN 0 AND 9)` mean you **cannot** swap by reassigning `slot` to a temp value — confirmed against the live schema. Use the content-swap path for filled targets.
  - Swap the full med field set (`name, description, quantity, expiry_date, pills_per_dose, schedule_at`); `name`/`quantity`/`pills_per_dose` are NOT NULL so always present. Do **not** swap `id`, `slot`, `patient_id`, or `dispenser_id`.
  - `select("*")` returns `schedule_at` even though `SlotInfo` (api.ts:17-28) doesn't declare it — operate on the raw row, not the typed interface, inside this function.
- **VALIDATE**: `cd frontend && npx tsc --noEmit` (or `npm run build`) compiles with no error referencing `moveSlot`.

### Task 2: Create the shared `useSlotDnd` hook
- **ACTION**: Create `frontend/src/lib/useSlotDnd.ts`. It owns the in-flight drag source and produces the DnD props for any slot cell. Page-agnostic; the page supplies an `onMove` callback.
- **IMPLEMENT**:
  ```ts
  "use client";
  import { useState, useCallback } from "react";

  export interface SlotDragSource {
    patientId: number;
    slot: number;
  }

  /**
   * Native HTML5 drag-drop for the 10-slot magazine. One source at a time.
   * Drops are accepted only within the SAME patient (same dispenser).
   * `onMove(patientId, fromSlot, toSlot)` runs the actual relocation.
   */
  export function useSlotDnd(
    onMove: (patientId: number, fromSlot: number, toSlot: number) => void,
  ) {
    const [source, setSource] = useState<SlotDragSource | null>(null);
    const [overKey, setOverKey] = useState<string | null>(null);

    const key = (patientId: number, slot: number) => `${patientId}:${slot}`;

    const getCellDragProps = useCallback(
      (patientId: number, slot: number, isFilled: boolean) => {
        const sameDispenser = source?.patientId === patientId;
        const isOver = overKey === key(patientId, slot) && sameDispenser;
        return {
          // Only filled cells can start a drag.
          draggable: isFilled,
          onDragStart: (e: React.DragEvent) => {
            setSource({ patientId, slot });
            e.dataTransfer.effectAllowed = "move";
            // Some browsers require data to be set for the drag to begin.
            e.dataTransfer.setData("text/plain", key(patientId, slot));
          },
          onDragEnd: () => {
            setSource(null);
            setOverKey(null);
          },
          onDragOver: (e: React.DragEvent) => {
            if (!source || !sameDispenser) return; // block cross-patient
            e.preventDefault(); // REQUIRED — else onDrop never fires
            setOverKey(key(patientId, slot));
          },
          onDragLeave: () => {
            setOverKey((k) => (k === key(patientId, slot) ? null : k));
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setOverKey(null);
            if (!source || !sameDispenser) return;
            if (source.slot === slot) return; // dropped on itself
            const from = source.slot;
            setSource(null);
            onMove(patientId, from, slot);
          },
          // Consumer uses these for styling.
          "data-dnd-over": isOver ? "true" : undefined,
          "data-dnd-dragging":
            source?.slot === slot && sameDispenser ? "true" : undefined,
        };
      },
      [source, overKey, onMove],
    );

    return { getCellDragProps, isDragging: source !== null };
  }
  ```
- **MIRROR**: `swr.ts` shows `lib/` holds shared client helpers; this fits the same folder. `"use client"` matches every interactive file (`inventory/page.tsx:1`, `patients/[id]/page.tsx:1`).
- **IMPORTS**: `useState`, `useCallback` from `react`. `React.DragEvent` is a global type with `@types/react@^19` installed.
- **GOTCHA**:
  - **`onDragOver` MUST call `e.preventDefault()`** or the browser rejects the drop and `onDrop` never runs. Most common DnD bug.
  - Guard every handler on `sameDispenser` so a drag started in patient A's row cannot drop into patient B's row on the inventory page.
  - The `data-dnd-over` / `data-dnd-dragging` attributes drive Tailwind `data-[dnd-over=true]:` styling — keep the attribute names stable across both pages.
- **VALIDATE**: `npx tsc --noEmit` clean; hook exports `getCellDragProps` and `isDragging`.

### Task 3: Wire DnD into the patient magazine (`/patients/[id]`)
- **ACTION**: In `frontend/src/app/patients/[id]/page.tsx`, import the hook + `moveSlot`, add a `handleMove`, and spread `getCellDragProps(...)` onto each magazine cell `<div>` (line 380-393), plus a drag-over highlight class.
- **IMPLEMENT**:
  1. Extend imports (line 6-11): add `moveSlot` to the `@/lib/api` import; add `import { useSlotDnd } from "@/lib/useSlotDnd";`.
  2. Add the move handler + hook at component top level (near line 41, with the other hooks — **above** the early returns at line 154/158):
     ```ts
     const handleMove = useCallback(
       async (patientId: number, from: number, to: number) => {
         try {
           await moveSlot(patientId, from, to);
           await loadData();
         } catch (e) {
           setDispenseMsg(`Move failed: ${(e as Error).message}`);
         }
       },
       [],
     );
     const { getCellDragProps } = useSlotDnd(handleMove);
     ```
     (`useCallback` keeps the `onMove` reference stable for the hook's memo. Add `useCallback` to the existing `react` import at line 4.)
  3. On the cell `<div key={i}>` (line 380), spread `{...getCellDragProps(pid, i, !isEmpty)}` and append the highlight to the className:
     ```tsx
     <div key={i}
       {...getCellDragProps(pid, i, !isEmpty)}
       className={`group relative overflow-hidden rounded-xl border-2 p-3 text-center transition-all duration-200 data-[dnd-over=true]:ring-2 data-[dnd-over=true]:ring-olive-400 data-[dnd-dragging=true]:opacity-40 ${ /* existing status ternary, unchanged */ }`}>
     ```
- **MIRROR**: `REFETCH_AFTER_MUTATION` (`await loadData()` after the write, like `handleSaveSlot:142-147`); `ERROR_HANDLING` (reuse the existing `setDispenseMsg` slot that already renders at line 249-251).
- **IMPORTS**: `moveSlot` from `@/lib/api`; `useSlotDnd` from `@/lib/useSlotDnd`; `useCallback` from `react`. `pid` already defined (line 28).
- **GOTCHA**:
  - The cell already has hover Edit/Remove buttons (line 463-478) and an "Add Med" button (line 431). Keep `draggable` only `true` when `!isEmpty` so empty "Add Med" cells stay fully clickable.
  - `useSlotDnd(handleMove)` must be called unconditionally at top level — declare it **above** the loading/not-found early returns (line 154/158).
  - Optional: to prevent dragging a card that is mid-edit, pass `!isEmpty && editingSlot !== i` as the `isFilled` arg.
- **VALIDATE**: `npm run lint` clean; drag a filled card onto an empty slot → it moves; onto a filled slot → they swap; drop ring appears on hover-over.

### Task 4: Wire DnD into the inventory per-patient grid (`/inventory`)
- **ACTION**: In `frontend/src/app/inventory/page.tsx`, import the hook + `moveSlot`, add `handleMove` (refetch via `fetchAllSlots`), and spread `getCellDragProps(...)` onto the **per-patient detailed grid** cells (line 330), NOT the heatmap.
- **IMPLEMENT**:
  1. Extend imports (line 5-10): add `moveSlot` to `@/lib/api`; add `import { useSlotDnd } from "@/lib/useSlotDnd";`; add `useCallback` to the `react` import (line 3).
  2. Inside `InventoryPage`, after the `useMemo` (line 144), add:
     ```ts
     const handleMove = useCallback(
       async (patientId: number, from: number, to: number) => {
         try {
           await moveSlot(patientId, from, to);
           const fresh = await fetchAllSlots();
           setSlots(fresh);
         } catch {
           // mirror the page's silent .catch(() => {}) load convention
         }
       },
       [],
     );
     const { getCellDragProps } = useSlotDnd(handleMove);
     ```
  3. On the detailed-grid cell `<div key={i}>` (line 330-335), spread props + highlight:
     ```tsx
     <div key={i}
       {...getCellDragProps(patient.id, i, !!slot)}
       className={`rounded-lg border p-2 text-center transition-all data-[dnd-over=true]:ring-2 data-[dnd-over=true]:ring-olive-400 data-[dnd-dragging=true]:opacity-40 ${statusClasses(status)}`}
       title={tooltip(slot, i)}>
     ```
     `patient.id` is in scope from `patients.map((patient) => ...)` at line 246; `slot` is the per-cell lookup at line 326.
- **MIRROR**: `STATE_LOAD_PATTERN` (refetch `fetchAllSlots` → `setSlots`); inventory page's existing `.catch(() => {})` silent-load convention (line 128/131).
- **IMPORTS**: `moveSlot` from `@/lib/api`; `useSlotDnd` from `@/lib/useSlotDnd`; `useCallback` from `react`.
- **GOTCHA**:
  - Only the per-patient detailed grid (line 324-367) gets DnD. Leave the "All Slots" heatmap (line 197-240) untouched — cross-patient and cramped.
  - The hook auto-blocks cross-patient drops; the ring only lights on same-patient cells via the `sameDispenser` guard.
  - Cells here are small; the ring highlight is the key UX feedback — keep it.
- **VALIDATE**: `npm run lint` + `npm run build` clean; on `/inventory`, drag within one patient row reorders; dragging onto a different patient's row does nothing.

---

## Testing Strategy

> No automated test runner exists (CLAUDE.md). "Tests" below are the manual verification matrix.

### Manual Verification Matrix
| Scenario | Setup | Action | Expected |
|---|---|---|---|
| Move to empty | Slot 2 filled, slot 5 empty | Drag #2 → #5 | #2 empty, #5 holds the med (qty/expiry/schedule preserved) |
| Swap two filled | Slot 0 = Aspirin, slot 1 = Metformin | Drag #0 → #1 | #0 = Metformin, #1 = Aspirin; all fields preserved |
| Drop on self | Any filled slot | Drag #3 → #3 | No-op, no DB write |
| Cross-patient (inventory) | Two patient rows | Drag patient A #0 → patient B #4 | No move, no ring on B's cells |
| Empty source | Empty slot | Try to drag empty #7 | Not draggable (no `draggable` attr) |
| Add Med still works | Empty slot | Click empty cell (no drag) | Inline Add Med form opens as before |
| Edit/Remove still works | Filled slot | Hover → click Edit / Remove | Existing behavior unchanged |
| Refetch after move | Any move | Complete a drop | Grid reflects new arrangement without manual reload |

### Edge Cases Checklist
- [x] Empty input (empty source) — blocked by `draggable={isFilled}`
- [x] Drop on self — early `return` in `onDrop`
- [x] Invalid target (cross-patient) — `sameDispenser` guard
- [x] Target empty vs filled — both handled in `moveSlot`
- [x] All med fields preserved on swap — full field set swapped
- [ ] Concurrent access (two caregivers) — not handled; last write wins (matches existing `updateSlot`)
- [ ] Network failure mid-swap — first update may succeed, second fail → inconsistent state; see Risks

---

## Validation Commands

### Static Analysis / Type Check
```bash
cd frontend && npx tsc --noEmit
```
EXPECT: Zero type errors.

### Lint
```bash
cd frontend && npm run lint
```
EXPECT: No new lint errors.

### Build
```bash
cd frontend && npm run build
```
EXPECT: Production build succeeds (Next.js type-checks during build).

### Database Validation
```bash
# No migration needed — feature is read/update only against existing columns.
# Constraints the plan relies on (already verified live):
#   UNIQUE (patient_id, slot)  +  CHECK (slot BETWEEN 0 AND 9)
```
EXPECT: No schema change; constraints unchanged.

### Browser Validation
```bash
make frontend     # or: cd frontend && npm run dev  → http://localhost:3000
```
EXPECT: `/patients/[id]` magazine and `/inventory` per-patient grids support drag-drop per the Manual Verification Matrix.

### Manual Validation
- [ ] `/patients/[id]`: drag a med onto an empty slot → moves; onto a filled slot → swaps.
- [ ] `/inventory`: same within a single patient row; cross-row drops ignored.
- [ ] Drag-over ring highlight shows on valid targets only.
- [ ] Edit / Remove / Add Med unchanged.
- [ ] Reload page → arrangement persisted in Supabase.

---

## Acceptance Criteria
- [ ] `moveSlot` added to `lib/api.ts`, handles empty-target move and filled-target content-swap.
- [ ] Shared `useSlotDnd` hook created and used by both pages.
- [ ] `/patients/[id]` magazine cells draggable + droppable.
- [ ] `/inventory` per-patient grid cells draggable + droppable; heatmap untouched.
- [ ] Cross-patient drops blocked.
- [ ] All medication fields preserved across a swap.
- [ ] `tsc --noEmit`, `npm run lint`, `npm run build` all clean.

## Completion Checklist
- [ ] Code follows discovered patterns (free-function data layer, throw-on-error, refetch-after-write).
- [ ] Error handling matches codebase style (`setXxxMsg(\`... ${(e as Error).message}\`)`).
- [ ] No new npm dependency (native HTML5 DnD).
- [ ] No hardcoded patient/slot values.
- [ ] `"use client"` present on the new hook.
- [ ] No backend / Pi changes.
- [ ] Self-contained — no codebase searching needed during implementation.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Non-atomic swap: 2nd `update` fails after 1st succeeds → both rows show the same med | Low | Medium | Acceptable for demo (matches existing non-transactional `updateSlot`). If hardening needed later, move the swap into a Postgres RPC (`create function move_slot(...)`) for a single transaction. Out of scope now. |
| `onDragOver` missing `preventDefault` → drop silently fails | Med (common mistake) | High | Hook centralizes `preventDefault`; documented as GOTCHA in Tasks 2-4. |
| Touch users can't drag | High (tablets at bedside) | Low | Documented limitation; edit/remove still available. Future: `@dnd-kit` with pointer sensors. |
| Drag conflicts with hover Edit/Remove buttons | Low | Low | `draggable` only on filled cells; buttons remain clickable; accidental tiny drags resolve to self-drop no-op. |
| Historical `adherence_logs.slot` now references a different med after a move/swap | Low | Low | Inherent to any slot reassignment (same as manual Remove+Add today). Logs key on `slot`+`patient_id`, not med id. Accepted. |

## Notes
- **Why content-swap, not slot-swap** (the single most important design decision): the live `medications` table enforces `UNIQUE (patient_id, slot)` and `CHECK (slot BETWEEN 0 AND 9)`. There is no legal slot value to "park" a row at during a swap, and supabase-js (PostgREST) cannot issue one multi-row `UPDATE` with per-row values. Swapping the medication content columns between the two fixed rows yields the identical user-visible result while only ever touching unconstrained columns. The empty-target case is a plain single-row slot move (no conflict possible).
- Columns swapped on a filled-target swap: `name, description, quantity, expiry_date, pills_per_dose, schedule_at`. Untouched: `id, slot, patient_id, dispenser_id`.
- `dispenser_id` is constant across a patient's slots, so it is intentionally never swapped.
- React 19 / Next 15 App Router; all three touched/created files are client components (`"use client"`).
- `medications` columns (live schema, for reference): `id` bigint PK · `name` text NOT NULL · `description` text · `slot` int 0-9 NOT NULL · `quantity` int NOT NULL · `patient_id` bigint NOT NULL FK · `dispenser_id` text · `expiry_date` date (`YYYY-MM-DD`) · `pills_per_dose` int ≥1 NOT NULL · `schedule_at` time (`HH:MM:SS`).
```
