# Plan: Dashboard Surfaces (PRD Phase 7)

## Summary
Make the system legible to nurses and pharmacists by polishing three dashboard surfaces and tightening one existing flow. Improve the live adherence feed (`IntakeLog.tsx`) with friendlier timestamps, dispenser badges, and confidence-score chips. Add a new top-level slot-status heatmap on `/inventory` showing all 10 slots across all patients with low/out/expiring/healthy colour-coding driven by `expiry_date` and `quantity`. Add a new `AlertsPanel` component on the dashboard home page that reads `public.alerts` (Phase 5 may not have shipped that table yet — must tolerate "relation does not exist") and renders an empty state when missing. Polish `/patients/[id]/enroll` with file-type, file-size, and image-load preflight guards. Phase 7 is frontend-only — no backend, no migrations, no Pi changes.

## User Story
As a **nurse on rounds**, I want **to glance at the dashboard and answer "did patient X take their last dose?" in under 5 seconds**, so that **I don't have to dig through patient detail pages or chase logs in the database**.

## Problem -> Solution
**Today**: The dashboard home page shows a recent intake log, dispenser overview, and a heuristic "Needs Attention" panel that derives alerts from `medications` rows (no expiry awareness, no real `alerts` table read). The intake log doesn't surface dispenser_id or confidence_score even though Phase 1 added the columns. There is no global slot-status grid — caregivers must drill into each patient page.
**After**: The intake log shows dispenser + confidence chips when present, friendlier timestamps, and a small per-patient filter affordance. The inventory page gets a heatmap-style grid that flags expiring-soon slots (<= 14 days) in orange and surfaces the dispenser_id badge. A new `AlertsPanel` on the dashboard home reads `public.alerts` if the table exists; otherwise renders a "no alerts yet" empty state with a small "Phase 5 not yet shipped" explanatory hint. The enrol page rejects non-images and >10 MB uploads at the client before round-tripping to the backend.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 7 — Frontend dashboard surfaces
- **Estimated Files**: 6 modified + 2 created
- **Estimated Lines**: ~400 LOC net

---

## Decisions Up Front

1. **Realtime path: keep Supabase Realtime (not WS).** `IntakeLog.tsx` already subscribes via `supabase.channel("adherence_realtime")`. The `/api/logs/ws` endpoint requires a `device_token` query parameter (`backend/app/api/logs.py:66-80`); plumbing a device token into the browser would either expose the token in client JS or require a new staff-token flow which is out of scope for Phase 7. Staying on Supabase Realtime preserves the existing `lib/supabase.ts` direct-read pattern and is zero-config.
2. **Slot-status grid lives on `/inventory`, not a new `/slots` route.** `/inventory` is already the canonical slot view — adding a heatmap and expiry awareness there preserves the existing nav (Dashboard / Patients / Inventory / Reports). Adding a fifth nav entry would crowd `Navbar.tsx`.
3. **Alerts panel empty-state is graceful.** When the `alerts` table doesn't exist (PostgREST returns `42P01` / a 404 on the resource), `fetchAlerts()` resolves to `[]`. The panel renders the empty state without flashing an error.
4. **Enrol-page polish is small.** Reject non-images by MIME prefix; warn on >10 MB; only show the preview when the image actually loads (`<img onLoad>` flips a flag). No drag-drop, no cropping — defer.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/lib/api.ts` | full | Helpers + types; new `fetchAlerts()` + `Alert` interface go here |
| P0 | `frontend/src/lib/supabase.ts` | 1-7 | Anon-key direct-read client; reuse for alerts table |
| P0 | `frontend/src/app/page.tsx` | 1-123 | Dashboard composition; insert `AlertsPanel` |
| P0 | `frontend/src/components/IntakeLog.tsx` | full | Existing Realtime subscription + render — extend, do not replace |
| P0 | `frontend/src/app/inventory/page.tsx` | full | Existing per-patient slot grid; extend with heatmap legend + expiry chip |
| P0 | `frontend/src/app/patients/[id]/enroll/page.tsx` | full | File-input flow to harden |
| P0 | `backend/app/api/logs.py` | 65-88 | WS contract — confirms device_token requirement; rationale to stay on Supabase Realtime |
| P1 | `frontend/src/components/NeedsAttention.tsx` | full | Visual style baseline for `AlertsPanel` |
| P1 | `frontend/src/components/DispenserOverview.tsx` | 60-75 | Slot-colour conventions to mirror |
| P1 | `CLAUDE.md` | "Frontend" section | Two access paths convention; preserve |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Supabase Realtime channels | https://supabase.com/docs/guides/realtime | `postgres_changes` event filter pattern; existing IntakeLog already uses it correctly |
| PostgREST error code for missing table | https://postgrest.org/en/stable/references/errors.html | `42P01` — "relation does not exist". Surfaces as a Supabase JS error with `code === "42P01"`. |

---

## Patterns to Mirror

### TYPE_DEFINITION_FRONTEND
Source: `frontend/src/lib/api.ts:29-38`. Rule: nullable fields are explicit `| null`; optional nested join uses `?:`.

### FRONTEND_API_HELPER_PATTERN (Supabase direct, error-tolerant)
New for Phase 7. Wraps the supabase client read; checks `error.code === "42P01"` and message substrings ("does not exist", "not found"); returns `[]` on missing table.

### COMPONENT_STYLE
Source: `frontend/src/components/NeedsAttention.tsx:92-141`. Rule: rounded-2xl panel; sand/olive palette; emoji-free icons via inline SVG; consistent header chip style.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/lib/api.ts` | UPDATE | Add `Alert` interface + `fetchAlerts()` (graceful on missing table) |
| `frontend/src/components/IntakeLog.tsx` | UPDATE | Add per-patient filter, dispenser_id badge, confidence_score chip, friendlier "Today/Yesterday" timestamps |
| `frontend/src/components/AlertsPanel.tsx` | CREATE | Reads `alerts` table; renders empty-state when absent or empty |
| `frontend/src/app/page.tsx` | UPDATE | Mount `AlertsPanel` in the right column above `NeedsAttention` |
| `frontend/src/app/inventory/page.tsx` | UPDATE | Add a top-level "All slots" heatmap + expiring-soon orange + dispenser badge + legend |
| `frontend/src/app/patients/[id]/enroll/page.tsx` | UPDATE | MIME-prefix guard; >10 MB warn; image `onLoad` preview gating |

## NOT Building

- **WS-based live feed.** `/api/logs/ws` requires a device token; cannot be safely embedded in client JS. Sticking with Supabase Realtime (already implemented).
- **Server-side staff-auth gating.** Phase 7 doesn't ship `/api/auth/login`.
- **A new `/slots` route.** Folded into `/inventory`.
- **Chart libraries.** No `recharts`/`chart.js` — Tailwind + small SVG only.
- **Real-time alert subscription.** `AlertsPanel` polls on mount only. Live alerts can come in Phase 5/8.
- **Drag-drop, image-cropping, multi-file enrolment.** Out of scope.
- **Reports page rebuild.** `/reports` stays "Coming Soon" — not on Phase 7's success-signal path.

---

## Step-by-Step Tasks

### Task 1: Extend `frontend/src/lib/api.ts` with `Alert` + `fetchAlerts()`
- **ACTION**: Append a new types block + helper at the bottom of `api.ts`.
- **MIRROR**: TYPE_DEFINITION_FRONTEND, FRONTEND_API_HELPER_PATTERN.
- **GOTCHA**: Phase 5 may add overlapping types. The fields chosen here are conservative and forward-compatible (severity union, AlertKind extensible via `| string`). Whoever ships Phase 5 should reconcile during merge.
- **VALIDATE**: `npm run build` — no TS errors.

### Task 2: Create `frontend/src/components/AlertsPanel.tsx`
- **ACTION**: New component.
- **IMPLEMENT**: A panel matching `NeedsAttention.tsx` style with:
  - Header: "Alerts" + count chip when non-zero.
  - Empty state: "No active alerts" sub-text "Alerts feed connects in Phase 5".
  - List: each row shows severity dot, message, patient_id (linked), and friendly timestamp; acknowledged alerts grey out.
- **MIRROR**: NeedsAttention.tsx layout.
- **GOTCHA**: When patient_id is null (system alert), don't render a Link.
- **VALIDATE**: appears on home page even when alerts empty.

### Task 3: Polish `frontend/src/components/IntakeLog.tsx`
- **ACTION**: Update existing component.
- **IMPLEMENT**:
  - Optional `selectedPatientId` filter via inline `<select>` driven by unique patients in `logs`.
  - When `log.dispenser_id` is non-null: small `text-[10px] text-gray-400` badge.
  - When `log.confidence_score` is non-null: percentage chip; <0.7 warn-tone, >=0.7 success-tone.
  - Friendly timestamp: "Just now" < 1 min, "Nm ago" < 1 h, "Today HH:MM", "Yesterday HH:MM", else "MMM D".
  - Keep the existing Supabase Realtime channel subscription untouched.
  - When filtered, show "Showing N of M" footer.
- **MIRROR**: existing IntakeLog styling.
- **GOTCHA**: do not break the Realtime INSERT path. The filter is purely render-time.
- **VALIDATE**: dispenser badge appears only when set; new logs pushed via Realtime still appear at top.

### Task 4: Add `AlertsPanel` to dashboard home
- **ACTION**: Edit `frontend/src/app/page.tsx`.
- **IMPLEMENT**: Mount `<AlertsPanel />` in the right column, above `<NeedsAttention />`.
- **MIRROR**: existing `animate-slide-in-right` stagger pattern.
- **GOTCHA**: AlertsPanel fetches its own data; home page doesn't need to plumb it in.
- **VALIDATE**: panel renders; counts are independent of NeedsAttention's heuristic.

### Task 5: Extend `/inventory` with the slot-status heatmap
- **ACTION**: Edit `frontend/src/app/inventory/page.tsx`.
- **IMPLEMENT**:
  - Add a top-of-page "All Slots" panel rendering a single grid (10 cols x N patients rows) with one cell per slot.
  - Cell colour rules (cascade — first match wins): out-of-stock = red, expired = red, low-stock (1-3) = yellow, expiring-soon (<= 14 days) = orange, healthy = green, empty (no medication) = grey-dashed.
  - Each cell tooltip via `title=` attribute: `medication name . qty left . expiry . dispenser_id`.
  - Add a small legend strip above the grid (5 dots).
  - Below the heatmap, keep the existing per-patient cards but add an expiry-soon chip + dispenser_id badge to each patient header.
- **MIRROR**: existing per-patient card styling; reuse colour tokens.
- **GOTCHA**: `expiry_date` is `string | null` (YYYY-MM-DD). Compare via `new Date(...)` and a 14-day window. Avoid timezone bugs by comparing day-only via ISO `toISOString().slice(0,10)`.
- **VALIDATE**: heatmap shows all patients' slots; expiring-soon orange appears for any DB row with `expiry_date` <= 14 days from today.

### Task 6: Polish `frontend/src/app/patients/[id]/enroll/page.tsx`
- **ACTION**: Edit existing page.
- **IMPLEMENT**:
  - Inside `onPick`, before setting state: reject non-`image/*` MIME (`setError("Please select an image file.")`); warn (but allow) on >10 MB (`setError("Image is large (>10 MB) — upload may be slow.")`).
  - Replace the unconditional preview with one that only renders after the `<img onLoad>` fires; show a small spinner state in between.
  - Keep the existing submit flow untouched.
- **MIRROR**: existing inline-error tone (`bg-status-danger-bg text-status-danger`).
- **GOTCHA**: Errors here are client-side preflight; the backend's "single face" check (Phase 3) is the real gate. Don't block on size — just warn.
- **VALIDATE**: PDF / >10 MB image / corrupted bytes -> friendly client-side error; valid PNG/JPG passes through.

### Task 7: Static analysis + build
- **ACTION**: Verify the frontend builds.
- **IMPLEMENT**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/.claude/worktrees/agent-a9562b83a4afcc9aa/frontend
  npm run build
  ```
- **GOTCHA**: Tailwind v4 — no config changes; pure className additions.
- **VALIDATE**: green build, no TS errors, all 7+ routes prerendered.

### Task 8: Manual visual smoke (briefly)
- **ACTION**: `npm run dev`, hit `/`, `/inventory`, `/patients/<id>/enroll`. Kill the dev server.
- **VALIDATE**: dashboard renders empty AlertsPanel, IntakeLog has filter affordance, inventory shows heatmap; enrol page rejects PDF.

---

## Testing Strategy

Repo has no test framework. Validation = `next build` + manual visual check.

### Manual / Smoke Tests

| Test | Input | Expected Output |
|---|---|---|
| `npm run build` | run after all edits | green; new component compiles; all routes registered |
| Dashboard renders with 0 alerts | DB has no `alerts` table | AlertsPanel shows "No active alerts" empty state |
| Dashboard with `alerts` table | manually inserted row in Phase 5 | row appears, severity dot coloured, timestamp formatted |
| IntakeLog filter | toggle the patient `<select>` | log list filters; Realtime INSERT still appends |
| IntakeLog dispenser badge | log row with `dispenser_id="dispenser-001"` | badge renders |
| IntakeLog confidence chip | log row with `confidence_score=0.92` | green "92%" chip; 0.55 -> warn-tone |
| Inventory heatmap | slot with `expiry_date` 7 days from today | orange cell with title text including expiry |
| Inventory heatmap legend | rendered above grid | 5 swatches: empty, healthy, low, expiring, out/expired |
| Enrol PDF reject | upload `.pdf` | client error "Please select an image file"; no submit |
| Enrol big image warn | upload 12 MB JPG | warn banner; submit still allowed |

---

## Validation Commands

### Frontend Build
```bash
cd /Users/limjiale/IDP_PharmGuard/.claude/worktrees/agent-a9562b83a4afcc9aa/frontend
npm run build
```
EXPECT: zero TS errors; new component + new helper compile.

### Dev smoke
```bash
cd /Users/limjiale/IDP_PharmGuard/.claude/worktrees/agent-a9562b83a4afcc9aa/frontend
npm run dev   # foreground briefly; visit / and /inventory; ctrl-c
```

### Manual Validation Checklist
- [ ] `lib/api.ts` exports `fetchAlerts()` and `Alert` interface.
- [ ] `AlertsPanel.tsx` renders empty state when `alerts` table is absent.
- [ ] `IntakeLog.tsx` Supabase Realtime channel still active.
- [ ] Inventory heatmap colour rules match the spec.
- [ ] Enrol page rejects non-images.
- [ ] `npm run build` green.
- [ ] No backend / Pi files modified.

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] `next build` green.
- [ ] Nurse can answer "did patient X take their last dose?" in <5 s on the dashboard (filter affordance + first-row clarity).
- [ ] Slot-status grid surfaces low / out / expiring / expired states by colour.
- [ ] Alerts panel renders an empty state without errors when Phase 5's `alerts` table is missing.
- [ ] No backend / no migrations / no Pi changes.
- [ ] Existing Supabase Realtime path preserved.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 5 ships an `Alert` type with different field names | M | L | Forward-compat union + tolerant parsing in `fetchAlerts()`. Reconciler at merge picks one; both will compile against `error.code` shape. |
| Supabase JS error shape varies across versions | L | L | We check both `code === "42P01"` and message-substring "does not exist" / "not found". |
| Tailwind v4 PostCSS quirks | L | L | All new classes use existing tokens (`olive-*`, `sand-*`, `status-*`). |
| Big images hang the preview | L | L | `<img onLoad>` gating + size warn. |
| Confidence chip distorts log row layout | L | L | Hidden when null; small fixed-width chip. |

## Notes
- **`/api/logs/ws` not used** — explicit decision; rationale documented in Decisions Up Front.
- **Phase 5 collision surface** is `frontend/src/lib/api.ts` (`Alert` interface). The merge can swap the type for whatever Phase 5 settles on; the helpers won't change shape much.
- After this plan ships, update `pharmguard.prd.md` Phase 7 row to `complete` (the orchestrator handles the actual update).

Sources:
- [Supabase Realtime docs](https://supabase.com/docs/guides/realtime)
- [PostgREST error codes](https://postgrest.org/en/stable/references/errors.html)
- `backend/app/api/logs.py:65-88` — WS device-token gate that pushed us back to Supabase Realtime
