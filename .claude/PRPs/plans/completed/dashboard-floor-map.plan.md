# Plan: Dashboard Hospital Floor Map

## Summary
Replace the four-card stat row at the top of the dashboard with a stylised top-down SVG floor plan of the hospital: one Common Room (6 beds) and one ICU (1 isolation bed). Each bed shows the assigned patient (initials + colour-coded adherence ring) and reveals a hover popover with today's adherence, last-intake timestamp, and next medication name.

## User Story
As a nurse/admin, I want a single glance at every bed's medication status laid out by room, so I can spot which beds need attention without scrolling through cards or lists.

## Problem → Solution
**Current**: Top of dashboard shows 4 numeric stat cards (Active Patients, Dispensed Today, Adherence %, Alerts). Numbers but no spatial context — admin can't tell *which* bed is the problem.
**Desired**: Floor plan replaces the stat row. Each bed's tile encodes patient identity + today's adherence; hover reveals details. Stat trends move to the brief / flags panels (already present below).

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (standalone)
- **PRD Phase**: N/A
- **Estimated Files**: 4 changed, 2 created

---

## Design Decisions (confirmed with user)

| Question | Choice | Implication |
|---|---|---|
| Bed↔patient mapping | **Reuse `patients.dispenser_id`** | No DB migration. The 7 bed slot keys (below) ARE the dispenser_id strings admin assigns on `/patients/[id]`. |
| What gets replaced | **The 4 stat cards row only** | Greeting → FloorMap → main grid (DispenserOverview, IntakeLog, BriefCard, FlagsPanel, AlertsPanel, NeedsAttention, ActivePatients all stay). |
| Hover content | **Today's adherence + last intake** AND **Next dose medication** | No name-only tooltip; name is rendered as label always. |
| Visual style | **Stylised SVG floor plan** | Inline SVG, no library. Two rounded-rect rooms, beds as rounded rects with initials. |

### Bed slot keys (hardcoded)
| Slot key | Room | Label | Use |
|---|---|---|---|
| `common-1` | Common | Bed 1 | Patient `dispenser_id="common-1"` lands here |
| `common-2` | Common | Bed 2 | … |
| `common-3` | Common | Bed 3 | |
| `common-4` | Common | Bed 4 | |
| `common-5` | Common | Bed 5 | |
| `common-6` | Common | Bed 6 | |
| `icu-1` | ICU | Isolation | Patient `dispenser_id="icu-1"` lands here |

If a patient has any other `dispenser_id` (e.g. legacy `pi-001`), they appear in a small "Unassigned" footer below the floor plan as a fallback — admin then edits that patient to use a slot key.

### Data sourcing (no new endpoints)
All three data slices are already in the SWR cache (added in the previous turn):
- `usePatients()` → `Patient[]` (filter by `dispenser_id`)
- `useLogs()` → `IntakeRecord[]` (filter by `patient_id`, today only)
- `useSlots()` → `SlotInfo[]` (medications; "next dose" = first slot with `quantity > 0` for that patient, by ascending slot number — same logic as `/api/inventory/next-dispense` but client-side and per-patient)

Result: no extra HTTP calls.

### "Next dose" caveat
The schema has **no schedule/dose-time field**. The hover popover therefore shows **next medication name only**, not a wall-clock time. Documented in tooltip copy as "Next: <med name>".

---

## UX Design

### Before
```
Good Afternoon, Nurse
Here's your dispensing overview for today

[Active Patients 4] [Dispensed 12] [Adherence 87%] [Alerts 1]    ← REPLACED
┌────────────────────────────────┬────────────────┐
│ Bedside Dispensers             │ Brief          │
│ Intake Log                     │ Flags / Alerts │
└────────────────────────────────┴────────────────┘
```

### After
```
Good Afternoon, Nurse
Here's your dispensing overview for today

┌─ Floor map ────────────────────────────────────────────────────┐
│  ┌─ Common Room ──────────────┐   ┌─ ICU ─────────┐            │
│  │ [B1] [B2] [B3]             │   │ [Isolation]   │            │
│  │ [B4] [B5] [B6]             │   │               │            │
│  └────────────────────────────┘   └───────────────┘            │
│  Hover any bed → popover with adherence + next med             │
└────────────────────────────────────────────────────────────────┘
┌────────────────────────────────┬────────────────┐
│ Bedside Dispensers             │ Brief / Flags  │
└────────────────────────────────┴────────────────┘
```

### Bed tile states
| State | Visual | Trigger |
|---|---|---|
| Vacant | Grey outlined rect, "—" | No patient with matching `dispenser_id` |
| Occupied · good | Olive ring, initials | adherence ≥ 90 % today |
| Occupied · warn | Amber ring, initials | 60–89 % |
| Occupied · alert | Red ring, initials | < 60 % OR today's last intake was missed |
| ICU bed | Same states + dashed inner border to signal isolation | Always for `icu-1` |

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Hover stat card | Static number | n/a (cards removed) | |
| Hover bed tile | n/a | Popover (~240 px wide) anchored above tile | 200 ms fade-in |
| Click bed tile | n/a | Navigate to `/patients/[id]` | Only when occupied |
| Mobile (no hover) | n/a | Tap-to-toggle popover | First tap opens, second tap navigates |
| Bed status updates | Manual reload | Auto via existing SWR refresh (logs 30 s, slots 60 s, patients 5 min) | No new polling code |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/app/page.tsx` | 1-50 | The exact section being replaced. Contains greeting, stat row, main grid. |
| P0 | `frontend/src/lib/swr.ts` | all | Existing SWR hooks `usePatients/useLogs/useSlots` — REUSE these. |
| P0 | `frontend/src/components/DispenserOverview.tsx` | 1-80 | Closest visual sibling: card chrome (`rounded-2xl border-sand-200 bg-white p-6`), `getInitials()`, slot color logic. Mirror the chrome and `getInitials` exactly. |
| P0 | `frontend/src/components/ActivePatients.tsx` | 27-50 | Reference: how to compute per-patient adherence by joining patients × logs in `useMemo`. |
| P1 | `frontend/src/lib/api.ts` | 1-50 | Type defs: `Patient`, `SlotInfo`, `IntakeRecord`. `dispenser_id: string \| null` on all three. |
| P1 | `frontend/src/app/page.tsx` | 100-135 | The animate-fade-up / animate-slide-in-right / staggerN classes — reuse for FloorMap entrance. |
| P2 | `backend/api/inventory.py` | 29-60 | "Next dispense" rule: first med row with `quantity > 0` for the patient. We replicate client-side per patient. |
| P2 | `frontend/src/components/FlagsPanel.tsx` | 117-141 | Card-chrome SVG icon pattern (olive `#4a6741`, 1.8 stroke). Mirror for the FloorMap header icon. |

## External Documentation
None. Pure inline SVG + Tailwind v4. No new dependency.

---

## Patterns to Mirror

### CARD_CHROME
// SOURCE: frontend/src/components/FlagsPanel.tsx:117-141
```tsx
<div className="rounded-2xl border border-sand-200 bg-white p-6">
  <div className="mb-4 flex items-center justify-between">
    <div className="flex items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round"
           strokeLinejoin="round">
        {/* icon paths */}
      </svg>
      <h2 className="text-base font-semibold text-gray-900">Floor map</h2>
    </div>
    {/* right-side meta (e.g. "7 beds · 4 occupied") */}
  </div>
  {/* body */}
</div>
```

### INITIALS_HELPER
// SOURCE: frontend/src/components/DispenserOverview.tsx:12-14, ActivePatients.tsx:7-9
```tsx
function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}
```
DO NOT redefine — copy verbatim. Two-letter cap is fine for ≥2-word names; for one-word names returns 1 char.

### ADHERENCE_BUCKET
// SOURCE: frontend/src/components/ActivePatients.tsx:11-21
```tsx
function adherenceColor(pct: number) {
  if (pct >= 90) return "text-status-success";
  if (pct >= 75) return "text-status-warning";
  return "text-status-danger";
}
```
Floor map uses the SAME breakpoints (90 / 60 — note: ActivePatients uses 75; we deliberately drop to 60 for the alert state because a single missed dose on a 3-dose day = 67 % which should not be "danger"). **Add the variant locally; do not modify ActivePatients.**

### SWR_DATA_HOOKS
// SOURCE: frontend/src/lib/swr.ts:55-79
```tsx
const { data: patients = [] } = usePatients();
const { data: logs = [] }     = useLogs();
const { data: slots = [] }    = useSlots();
```
Already deduped across the page. Adding a 4th consumer of `usePatients()` does NOT cost an extra request.

### MEMOISED_DERIVED_STATE
// SOURCE: frontend/src/components/ActivePatients.tsx:30-46 (post-SWR refactor)
```tsx
const beds: BedView[] = useMemo(() => {
  // join patients × logs × slots by patient.id, group by dispenser_id
}, [patients, logs, slots]);
```

### PAGE_INSERTION_POINT
// SOURCE: frontend/src/app/page.tsx:55-100 (the 4-card grid block to delete)
```tsx
{/* Stat Cards */}
<div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
  {/* 4 StatCard wrappers — DELETE this whole block */}
</div>
```
Replace with:
```tsx
<div className="mb-8 animate-fade-up stagger-1">
  <FloorMap />
</div>
```

### NAVIGATION_PATTERN
// SOURCE: frontend/src/components/ActivePatients.tsx:76-80
```tsx
<Link href={`/patients/${patient.id}`} className="...">
```
Use `<Link>` from `next/link` for click-to-detail wrappers. Inside an SVG, use `useRouter().push()` since `<Link>` renders an `<a>` which is invalid as a direct SVG child.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/components/FloorMap.tsx` | CREATE | New component with SVG floor plan + hover popover. ~300 LOC. |
| `frontend/src/lib/date.ts` | CREATE | Extract `formatRelative` here so FloorMap + 3 existing components share one copy. |
| `frontend/src/app/page.tsx` | UPDATE | Remove `<StatCard>` row + the four `Icon*` helpers + the now-dead `useMemo` stats block; insert `<FloorMap />`. |
| `frontend/src/components/BriefCard.tsx` | UPDATE | Replace inline `formatRelative` with import from `@/lib/date`. |
| `frontend/src/components/FlagsPanel.tsx` | UPDATE | Same — import from `@/lib/date`. |
| `frontend/src/components/AlertsPanel.tsx` | UPDATE | Same — import from `@/lib/date`. |
| `frontend/src/components/StatCard.tsx` | LEAVE AS-IS | No longer rendered on dashboard but may be reused; do not delete. |
| (no schema migration) | — | `patients.dispenser_id` already nullable text. No SQL needed. |

## NOT Building
- **No `beds` table or migration.** Bed identity is the dispenser_id string. Shipping zero SQL.
- **No bed-assignment UI.** Admin still edits `dispenser_id` on the existing `/patients/[id]` page (already supports free-text dispenser_id). Adding a dropdown of slot keys there is a follow-up.
- **No "next dose time".** Schema doesn't track schedule. Tooltip shows medication name only. A future schedule feature would require a `medications.schedule` jsonb column or a new `dose_schedules` table — out of scope.
- **No drag-to-reposition beds.** Bed positions are hardcoded in the SVG.
- **No floor-plan editor.** Adding rooms or beds means editing the `BEDS` array in `FloorMap.tsx`.
- **No bed-occupancy history.** We show *who is in this bed right now*, not "Bed 3 was empty yesterday".
- **No real-time websocket push.** Existing SWR refresh intervals (logs 30 s, slots 60 s, patients 5 min) are the freshness story.
- **No deletion of `StatCard.tsx`.** Keep the component; just stop rendering it on the dashboard.

---

## Step-by-Step Tasks

### Task 1: Extract `formatRelative` into `frontend/src/lib/date.ts`
- **ACTION**: Create the shared date helper, then update three existing callers.
- **IMPLEMENT**:
  ```ts
  // frontend/src/lib/date.ts
  export function formatRelative(ts: string | undefined | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 2 * 86_400_000) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  ```
- **MIRROR**: Take BriefCard's variant (most permissive — accepts `undefined`) as the canonical signature.
- **IMPORTS**: none.
- **GOTCHA**: BriefCard's existing variant returns a richer fallback `toLocaleString` with hour/minute. We're taking the simpler `toLocaleDateString` form — verify visually that BriefCard's "very old" timestamp still reads OK; if not, expand to include hour/minute (acceptable evolution).
- **VALIDATE**: Replace the local `formatRelative` in `BriefCard.tsx`, `FlagsPanel.tsx`, `AlertsPanel.tsx` with `import { formatRelative } from "@/lib/date";`. Run `npx tsc --noEmit` → zero errors.

### Task 2: Create `FloorMap.tsx` skeleton with bed layout constants
- **ACTION**: New file with type defs, hardcoded BEDS array, ROOM_RECTS, and stub return.
- **IMPLEMENT**:
  ```tsx
  "use client";

  import { useMemo, useRef, useState, useEffect } from "react";
  import Link from "next/link";
  import { useRouter } from "next/navigation";
  import type { IntakeRecord, Patient, SlotInfo } from "@/lib/api";
  import { useLogs, usePatients, useSlots } from "@/lib/swr";
  import { formatRelative } from "@/lib/date";

  type Room = "common" | "icu";
  type BedSlot = {
    key: string;          // matches patients.dispenser_id
    room: Room;
    label: string;        // "Bed 1", "Isolation"
    x: number; y: number; w: number; h: number;
  };

  const BEDS: BedSlot[] = [
    { key: "common-1", room: "common", label: "Bed 1", x: 60,  y: 70,  w: 100, h: 70 },
    { key: "common-2", room: "common", label: "Bed 2", x: 180, y: 70,  w: 100, h: 70 },
    { key: "common-3", room: "common", label: "Bed 3", x: 300, y: 70,  w: 100, h: 70 },
    { key: "common-4", room: "common", label: "Bed 4", x: 60,  y: 200, w: 100, h: 70 },
    { key: "common-5", room: "common", label: "Bed 5", x: 180, y: 200, w: 100, h: 70 },
    { key: "common-6", room: "common", label: "Bed 6", x: 300, y: 200, w: 100, h: 70 },
    { key: "icu-1",   room: "icu",    label: "Isolation", x: 540, y: 130, w: 200, h: 100 },
  ];

  const ROOM_RECTS = {
    common: { x: 30, y: 40, w: 400, h: 290, label: "Common Room" },
    icu:    { x: 480, y: 40, w: 290, h: 290, label: "ICU" },
  };

  function getInitials(name: string): string {
    return name.split(" ").map((w) => w[0]).join("").toUpperCase();
  }
  ```
- **MIRROR**: INITIALS_HELPER (verbatim copy).
- **IMPORTS**: as shown.
- **GOTCHA**: Coordinates assume `viewBox="0 0 800 380"`. The component's containing card adds 24 px padding (`p-6`) so the SVG renders at ~92 % of card width.
- **VALIDATE**: `BEDS.length === 7`; component compiles even with empty render body.

### Task 3: Compute the BedView join inside `FloorMap()`
- **ACTION**: Add `BedView` type, the `useMemo` join, and the unassigned-patients computation.
- **IMPLEMENT**:
  ```tsx
  type BedView = {
    slot: BedSlot;
    patient: Patient | null;
    adherenceToday: { taken: number; total: number; pct: number | null };
    lastIntake: IntakeRecord | null;
    nextMed: SlotInfo | null;
  };

  export default function FloorMap() {
    const { data: patients = [] } = usePatients();
    const { data: logs = [] }     = useLogs();
    const { data: slots = [] }    = useSlots();

    const router = useRouter();
    const [hoverKey, setHoverKey] = useState<string | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);

    const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

    const bedViews: BedView[] = useMemo(() => {
      const today = new Date().toDateString();
      const byKey = new Map<string, Patient>();
      for (const p of patients) {
        const k = norm(p.dispenser_id);
        if (k) byKey.set(k, p);
      }
      return BEDS.map((slot) => {
        const patient = byKey.get(slot.key) ?? null;
        let taken = 0, total = 0;
        let lastIntake: IntakeRecord | null = null;
        if (patient) {
          for (const l of logs) {
            if (l.patient_id !== patient.id) continue;
            const d = new Date(l.timestamp);
            if (d.toDateString() === today) {
              total++;
              if (l.pill_taken) taken++;
            }
            if (!lastIntake || d > new Date(lastIntake.timestamp)) {
              lastIntake = l;
            }
          }
        }
        const pct = total > 0 ? Math.round((taken / total) * 100) : null;
        const nextMed = patient
          ? slots
              .filter((s) => s.patient_id === patient.id && s.quantity > 0)
              .sort((a, b) => a.slot - b.slot)[0] ?? null
          : null;
        return { slot, patient, adherenceToday: { taken, total, pct }, lastIntake, nextMed };
      });
    }, [patients, logs, slots]);

    const KNOWN_KEYS = useMemo(() => new Set(BEDS.map((b) => b.key)), []);
    const unassigned = useMemo(
      () => patients.filter((p) => p.dispenser_id && !KNOWN_KEYS.has(norm(p.dispenser_id))),
      [patients, KNOWN_KEYS],
    );

    const occupiedCount = bedViews.filter((v) => v.patient).length;
    const hover = bedViews.find((v) => v.slot.key === hoverKey) ?? null;
    /* Task 4 + 5 fill in render body */
  }
  ```
- **MIRROR**: MEMOISED_DERIVED_STATE.
- **IMPORTS**: already added in Task 2.
- **GOTCHA**: The join walks every log for every bed (O(B × L)). With 7 beds and ≤ 100 logs cached this is fine; do not "optimise" with an extra Map unless logs grow > 5k.
- **GOTCHA**: `norm()` lowercases and trims to defend against `"Common-1"` or `" common-1 "` admin typos.
- **VALIDATE**: Insert a test patient `dispenser_id="common-3"` → bedViews[2].patient is non-null.

### Task 4: Render the SVG (rooms + bed tiles)
- **ACTION**: Render the card chrome wrapping a `<div ref={wrapperRef} className="relative">` containing the SVG and (later) the popover.
- **IMPLEMENT**:
  ```tsx
  function bedFill(v: BedView): string {
    if (!v.patient) return "#ffffff";
    const pct = v.adherenceToday.pct;
    if (pct === null) return "#ffffff";
    if (pct >= 90) return "#ecf3e3";
    if (pct >= 60) return "#fef3c7";
    return "#fee2e2";
  }
  function bedStroke(v: BedView): string {
    if (!v.patient) return "#d8d3c4";
    const pct = v.adherenceToday.pct;
    if (pct === null) return "#a8a29e";
    if (pct >= 90) return "#4a6741";
    if (pct >= 60) return "#b45309";
    return "#b91c1c";
  }

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
               stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round"
               strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900">Floor map</h2>
        </div>
        <span className="text-xs text-gray-400">
          {BEDS.length} beds · {occupiedCount} occupied
        </span>
      </div>

      <div ref={wrapperRef} className="relative">
        <svg viewBox="0 0 800 380" className="w-full" role="img"
             aria-label="Hospital floor map">
          {/* Common room */}
          <rect {...ROOM_RECTS.common} rx="14"
                fill="#fafaf6" stroke="#d8d3c4" strokeWidth="1.5" />
          <text x={ROOM_RECTS.common.x + 14} y={ROOM_RECTS.common.y + 22}
                fontSize="12" fontWeight="500" fill="#6b7280">
            {ROOM_RECTS.common.label}
          </text>
          {/* ICU */}
          <rect {...ROOM_RECTS.icu} rx="14"
                fill="#f0eee6" stroke="#bcb59f" strokeWidth="1.5"
                strokeDasharray="4 4" />
          <text x={ROOM_RECTS.icu.x + 14} y={ROOM_RECTS.icu.y + 22}
                fontSize="12" fontWeight="500" fill="#6b7280">
            ICU · Isolation
          </text>

          {bedViews.map((v) => (
            <g
              key={v.slot.key}
              transform={`translate(${v.slot.x}, ${v.slot.y})`}
              onMouseEnter={() => setHoverKey(v.slot.key)}
              onMouseLeave={() => setHoverKey((h) => (h === v.slot.key ? null : h))}
              onClick={() => {
                if (!v.patient) return;
                if (hoverKey === v.slot.key) {
                  router.push(`/patients/${v.patient.id}`);
                } else {
                  setHoverKey(v.slot.key);
                }
              }}
              style={{ cursor: v.patient ? "pointer" : "default" }}
            >
              <rect width={v.slot.w} height={v.slot.h} rx="10"
                    fill={bedFill(v)} stroke={bedStroke(v)} strokeWidth="2" />
              {v.slot.room === "icu" && (
                <rect x={6} y={6} width={v.slot.w - 12} height={v.slot.h - 12}
                      rx="6" fill="none" stroke={bedStroke(v)} strokeWidth="1"
                      strokeDasharray="3 3" />
              )}
              <text x={v.slot.w / 2} y={v.slot.h / 2 - 4}
                    textAnchor="middle" fontSize="18" fontWeight="700"
                    fill={v.patient ? "#4a6741" : "#9ca3af"}>
                {v.patient ? getInitials(v.patient.name) : "—"}
              </text>
              <text x={v.slot.w / 2} y={v.slot.h - 10}
                    textAnchor="middle" fontSize="10" fill="#6b7280">
                {v.slot.label}
              </text>
            </g>
          ))}
        </svg>
        {/* popover goes here in Task 5 */}
      </div>

      {/* unassigned footer goes here in Task 6 */}
    </div>
  );
  ```
- **MIRROR**: CARD_CHROME, INITIALS_HELPER.
- **IMPORTS**: already added.
- **GOTCHA**: `text` inside SVG must use `fontSize`/`fontWeight`/`fill` attrs, not Tailwind classes. Don't try `className="text-[18px]"` — sizes work via arbitrary values but `fill` does not.
- **GOTCHA**: `<Link>` from next/link does NOT work as a direct child of `<g>` (it renders `<a>`, which is technically valid SVG but Next.js's prefetch warns). Use `useRouter().push()`.
- **GOTCHA**: The `onMouseLeave` only clears `hoverKey` if it matches our slot — prevents flicker when moving from bed to popover (popover sits above the bed group).
- **VALIDATE**: All 7 beds render; vacant ones show "—"; ICU bed has dashed inner border.

### Task 5: Render the hover popover
- **ACTION**: Position-aware popover anchored to the hovered bed.
- **IMPLEMENT**:
  ```tsx
  // Inside the component, just before the return
  const popover = useMemo(() => {
    if (!hover || !hover.patient || !wrapperRef.current) return null;
    const wrapW = wrapperRef.current.clientWidth;
    const scale = wrapW / 800;
    const popW = 240;
    const popH = 130;
    let left = hover.slot.x * scale + (hover.slot.w * scale) / 2 - popW / 2;
    let top = hover.slot.y * scale - popH - 8;
    // Clamp horizontally inside the wrapper
    left = Math.max(8, Math.min(left, wrapW - popW - 8));
    // If too high, flip below the bed
    if (top < 0) top = (hover.slot.y + hover.slot.h) * scale + 8;
    return { left, top, popW };
  }, [hover]);

  // ... and inside the wrapper div, after </svg>:
  {popover && hover?.patient && (
    <div
      className="pointer-events-none absolute z-10 w-60 rounded-xl border border-sand-200 bg-white p-3 shadow-lg"
      style={{ left: popover.left, top: popover.top }}
    >
      <p className="text-sm font-semibold text-gray-900">{hover.patient.name}</p>
      <p className="mt-0.5 text-[11px] text-gray-400">
        {hover.slot.label} · {hover.slot.room === "icu" ? "ICU" : "Common"}
      </p>
      <hr className="my-2 border-sand-100" />
      <p className="text-xs text-gray-700">
        Today:{" "}
        <span className="font-medium text-gray-900">
          {hover.adherenceToday.taken}/{hover.adherenceToday.total}
        </span>
        {hover.adherenceToday.pct !== null && (
          <span className="ml-1 text-gray-400">({hover.adherenceToday.pct}%)</span>
        )}
      </p>
      <p className="text-xs text-gray-700">
        Last:{" "}
        {hover.lastIntake
          ? `${formatRelative(hover.lastIntake.timestamp)} · ${
              hover.lastIntake.pill_taken ? "taken" : "missed"
            }`
          : "—"}
      </p>
      <p className="text-xs text-gray-700">
        Next: <span className="font-medium">{hover.nextMed?.name ?? "—"}</span>
      </p>
    </div>
  )}
  ```
- **MIRROR**: Card-style chrome (`rounded-xl border border-sand-200 bg-white shadow-lg`).
- **IMPORTS**: `formatRelative` already imported.
- **GOTCHA**: `pointer-events-none` on the popover prevents it from stealing hover when moving between beds. Click-to-toggle still works because clicks land on the SVG bed group.
- **GOTCHA**: Bounding-box scale assumes the SVG fills its parent (it does — `className="w-full"`). On window resize, `useMemo` recomputes only when `hover` changes, NOT on resize. That's acceptable: popover only shows while hovering, so resize without hover is invisible.
- **VALIDATE**: Hover Bed 1 (top-left), Bed 6 (bottom), Isolation (right edge): popover stays inside card and never overflows. Tapping a bed on touch shows popover; second tap on same bed routes.

### Task 6: Render the unassigned-patients fallback
- **ACTION**: Below the SVG (and outside `wrapperRef`), render a chip row when `unassigned.length > 0`.
- **IMPLEMENT**:
  ```tsx
  {unassigned.length > 0 && (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-sand-100 pt-3 text-[11px] text-gray-500">
      <span className="font-medium text-gray-600">Unassigned:</span>
      {unassigned.map((p) => (
        <Link
          key={p.id}
          href={`/patients/${p.id}`}
          className="rounded-full bg-sand-100 px-2 py-0.5 hover:bg-sand-200"
        >
          {p.name}{" "}
          <span className="font-mono text-gray-400">({p.dispenser_id})</span>
        </Link>
      ))}
    </div>
  )}
  ```
- **MIRROR**: NAVIGATION_PATTERN.
- **IMPORTS**: `Link` already imported.
- **GOTCHA**: Patients with `dispenser_id === null` are NOT shown here — they have no dispenser at all and are admin's responsibility to assign first.
- **VALIDATE**: With a test patient `dispenser_id="pi-001"`, that name appears as a chip; click routes to `/patients/<id>`.

### Task 7: Click-outside to dismiss popover (touch UX)
- **ACTION**: Register a document `mousedown` listener that clears `hoverKey` when the click target is outside `wrapperRef`.
- **IMPLEMENT**:
  ```tsx
  useEffect(() => {
    if (!hoverKey) return;
    function onDocClick(ev: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(ev.target as Node)) {
        setHoverKey(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [hoverKey]);
  ```
- **MIRROR**: N/A.
- **IMPORTS**: `useEffect` already imported.
- **GOTCHA**: Listener is only attached while `hoverKey` is set — avoids running on every render.
- **VALIDATE**: Tap a bed on mobile → popover appears. Tap empty area on the page → popover closes. Tap another bed → popover moves to it.

### Task 8: Replace the stat-card row in `page.tsx`
- **ACTION**: Delete the stat row block, the four `Icon*` helper functions at the bottom, and the now-dead `useMemo` stats block. Insert `<FloorMap />`.
- **IMPLEMENT** — final page.tsx body should look like:
  ```tsx
  "use client";

  import StatCard from "@/components/StatCard";  // DELETE if grep confirms no other usage in this file
  import DispenserOverview from "@/components/DispenserOverview";
  import IntakeLog from "@/components/IntakeLog";
  import NeedsAttention from "@/components/NeedsAttention";
  import ActivePatients from "@/components/ActivePatients";
  import AlertsPanel from "@/components/AlertsPanel";
  import BriefCard from "@/components/BriefCard";
  import FlagsPanel from "@/components/FlagsPanel";
  import FloorMap from "@/components/FloorMap";
  import { useLogs, usePatients, useSlots } from "@/lib/swr";

  export default function Home() {
    const { data: slots = [] } = useSlots();
    const { data: logs = [] } = useLogs();
    const { data: patients = [] } = usePatients();
    // NOTE: page.tsx still calls these hooks because DispenserOverview and
    // IntakeLog receive slots/logs/patients as props. The dead `useMemo`
    // stats block (lines ~22-39) must be REMOVED.

    return (
      <div>
        {/* Greeting (unchanged) */}
        <div className="animate-fade-up mb-8">
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
            Good {getGreeting()}, Nurse
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Here&apos;s your dispensing overview for today
          </p>
        </div>

        {/* Floor map replaces the stat row */}
        <div className="mb-8 animate-fade-up stagger-1">
          <FloorMap />
        </div>

        {/* Main content grid (unchanged from current state) */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="animate-fade-up stagger-3">
              <DispenserOverview patients={patients} slots={slots} />
            </div>
            <div className="animate-fade-up stagger-4">
              <IntakeLog logs={logs} />
            </div>
          </div>
          <div className="space-y-6">
            <div className="animate-slide-in-right stagger-1">
              <BriefCard />
            </div>
            <div className="animate-slide-in-right stagger-2">
              <FlagsPanel />
            </div>
            <div className="animate-slide-in-right stagger-3">
              <AlertsPanel />
            </div>
            <div className="animate-slide-in-right stagger-4">
              <NeedsAttention logs={logs} slots={slots} />
            </div>
            <div className="animate-slide-in-right stagger-5">
              <ActivePatients />
            </div>
          </div>
        </div>
      </div>
    );
  }

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return "Morning";
    if (h < 17) return "Afternoon";
    return "Evening";
  }
  ```
- **MIRROR**: PAGE_INSERTION_POINT.
- **IMPORTS**: add `import FloorMap from "@/components/FloorMap";`. Remove `import StatCard` and the `useMemo` import (no longer used here).
- **GOTCHA**: `IconPatients`, `IconPill`, `IconCheck`, `IconAlert` helpers at the bottom of `page.tsx` are now dead. **Delete all four.** Verify with grep that no other file imports them (they aren't exported, so this is safe).
- **GOTCHA**: `DispenserOverview` still consumes `patients` + `slots`; `IntakeLog` consumes `logs`; `NeedsAttention` consumes `logs` + `slots`. Keep the SWR hook calls in page.tsx — they populate the cache, and child components reading the same SWR keys hit the cache (no extra HTTP).
- **VALIDATE**: `npx tsc --noEmit` passes. Visual: greeting → floor map → main grid (no stat cards).

---

## Testing Strategy

No unit-test framework configured (per CLAUDE.md). Manual testing only.

### Manual Test Matrix

| Scenario | Setup | Expected |
|---|---|---|
| All beds vacant | No patients have `dispenser_id` matching a slot key | 7 grey "—" tiles, no popover content |
| One bed occupied, no doses today | Patient `dispenser_id="common-3"`, no logs today | White tile with grey-ringed initials, hover shows "Today: 0/0", "Last: —", "Next: <med>" |
| Mixed adherence | 3 patients across slots: pct=100, 70, 30 | Olive / amber / red borders respectively |
| ICU isolation styling | Patient at `icu-1` | Inner dashed border visible, room label "ICU · Isolation" |
| Unassigned fallback | Patient with `dispenser_id="pi-001"` | Patient appears in chip footer below SVG, navigates to detail on click |
| Click to navigate (desktop) | Hover bed → click | Routes to `/patients/<id>` |
| Tap to toggle (mobile) | Touch device or browser DevTools touch emulation | First tap → popover; second tap → navigate; tap outside → closes |
| Hover near right edge | Hover Isolation bed | Popover clamps inside card, does not overflow |
| Refresh awareness | Insert intake row in DB | Within 30 s the bed colour updates (logs SWR refresh) |
| Two patients on one bed | Two patients share `dispenser_id="common-1"` | Last one inserted into the Map wins (Map.set semantics). Document as known limitation. |
| Whitespace/case typo | Patient `dispenser_id=" Common-1 "` | Still maps to `common-1` (norm() handles it) |

### Edge Cases Checklist
- [ ] Empty patients table → all beds vacant, occupied count = 0
- [ ] Patient with `dispenser_id=null` → does NOT appear in unassigned footer (by design)
- [ ] Patient name with single word → `getInitials` returns 1 char; verify rendering doesn't overflow tile
- [ ] Logs older than 1 day → `formatRelative` returns "Yesterday" or month/day
- [ ] All slots empty for a patient → `nextMed === null` → tooltip shows "Next: —"
- [ ] Browser zoom 80–150 % → SVG scales (uses viewBox)
- [ ] Reduced-motion preference → entrance animation should respect `prefers-reduced-motion` (existing `animate-fade-up` should already; do not add motion overrides)
- [ ] Window resize while popover open → acceptable to leave popover at stale position; closes on next bed leave

---

## Validation Commands

### Static Analysis
```bash
cd frontend && npx tsc --noEmit
```
EXPECT: Zero type errors.

### Build Check
```bash
cd frontend && npm run build
```
EXPECT: ✓ Compiled successfully. Bundle for `/` route grows by < 5 kB (FloorMap is pure SVG + JS, no new deps).

### Browser Validation
```bash
make frontend
# Open http://localhost:3000
```
EXPECT:
- Greeting still shows.
- Stat cards row is GONE.
- Floor map card replaces it; both rooms visible at 1024 px and 1280 px viewport widths.
- Beds reflect current patient assignments.
- Hover any occupied bed → popover with patient name + adherence + last intake + next med.
- Click occupied bed → patient detail page.

### Dev-data smoke
Seed a row to verify the unassigned footer:
```sql
update patients set dispenser_id = 'pi-001' where id = <some-id>;
-- after testing, restore:
update patients set dispenser_id = null where id = <some-id>;
```
EXPECT: That patient appears in the "Unassigned" chip row below the floor map.

To exercise occupied / vacant / unassigned simultaneously:
```sql
update patients set dispenser_id = 'common-1' where id = <id-A>;
update patients set dispenser_id = 'icu-1'    where id = <id-B>;
update patients set dispenser_id = 'pi-XYZ'   where id = <id-C>;
```

---

## Acceptance Criteria
- [ ] FloorMap renders 6 common-room beds + 1 ICU isolation bed.
- [ ] Bed colour reflects today's adherence: ≥90 % olive, 60–89 % amber, <60 % red, no-data white.
- [ ] Hover an occupied bed shows patient name + today's adherence + last intake + next medication.
- [ ] Click an occupied bed routes to `/patients/<id>`.
- [ ] Vacant beds show "—" and are not clickable.
- [ ] Patients with non-slot `dispenser_id` listed in unassigned footer.
- [ ] Stat cards row removed from `page.tsx`; the four `Icon*` helpers deleted.
- [ ] `formatRelative` consolidated in `lib/date.ts`; 3 callers updated; FloorMap uses it.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run build` passes.

## Completion Checklist
- [ ] Card chrome matches `rounded-2xl border border-sand-200 bg-white p-6` exactly.
- [ ] No new dependencies in `package.json`.
- [ ] No DB migration.
- [ ] SWR hooks reused (`usePatients/useLogs/useSlots`); no new fetch logic.
- [ ] No emojis in source.
- [ ] No comments explaining what code does (only why where non-obvious).
- [ ] `StatCard.tsx` left in place (not deleted).

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SVG popover positioning is wrong on resize | Medium | UX glitch | Clamp left/top to wrapper bounds (Task 5 GOTCHA); resize-while-hovered is acceptable stale state (closes on mouse-out). |
| Two patients share a `dispenser_id` | Low | Floor map shows only one | Map.set last-wins. Add a future "+N" badge — out of scope; document as known limitation. |
| User assigns `dispenser_id` with whitespace/case mismatch | Medium | Bed appears vacant despite assignment | `norm()` lowercases + trims (Task 3). |
| Tablet hover semantics confusing | Low | Two taps to navigate | Documented in matrix; first tap opens popover, second tap on same bed navigates. |
| Breaking change for `formatRelative` callers | Low | Old timestamps now show date instead of full datetime | Acceptable; if BriefCard's "Yesterday at 14:32" feel is critical, restore the richer fallback in `lib/date.ts` — single edit, no API change. |

## Notes
- The Supabase advisor flagged RLS disabled on `alerts`, `agent_briefs`, `agent_flags`. Unrelated to this plan — surface to user separately.
- Adding a schedule field (per-medication dose times) would unlock real "next dose at HH:MM" copy. Not in scope; flagged as a future migration.
- Adding a 2nd ICU bed or a 3rd ward later means adding 1–2 entries to `BEDS` and bumping the SVG `viewBox`. No structural code changes.
- When admin tools grow a dropdown for `dispenser_id`, move the `BEDS` array to `lib/beds.ts` so it becomes the single source of truth for both the floor map and the assignment UI.
