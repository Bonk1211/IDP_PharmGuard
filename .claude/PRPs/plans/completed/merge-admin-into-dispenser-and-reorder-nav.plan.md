# Plan: Merge `/admin` into `/dispensers/[id]` and Reorder Top Nav

## Summary
Collapse the standalone `/admin` page into the dispenser detail page so all per-device hardware ops live alongside the live cam streams. Reorder the top nav to: **Dashboard, Assistant, Inventory, Dispenser, Patient List**. Drop "Reports" from the nav (route stays accessible by URL). The "Dispenser" tab routes to the default dispenser id from env (single-tenant pilot setup).

## User Story
As a caregiver/operator,
I want one screen per dispenser that combines live cams, intake game, hardware controls, schedules, and service logs,
so that I can run the device without page-hopping and the top nav reflects only the workflows I actually use.

## Problem → Solution
Current: `/admin` and `/dispensers/[id]` are two separate panes that both target the same Pi. Operator clicks back-and-forth between them. Nav has six items including a duplicate-feeling "Admin" + a never-clicked "Reports".
Desired: One `/dispensers/[id]` page with cams **and** all hardware/ops/schedule/log panels. Five-item nav in user-listed order. `/admin` route deleted. Nav "Dispenser" link resolves to `/dispensers/${defaultDispenserId}`.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form ask)
- **PRD Phase**: N/A
- **Estimated Files**: 5 changed + 1 deleted

---

## UX Design

### Before
```
┌──────────────────────────────────────────────────────────────────────┐
│  Logo  | Dashboard Patients Inventory Reports Assistant Admin  | ⚙   │
├──────────────────────────────────────────────────────────────────────┤
│  /dispensers/<id>                  /admin                            │
│  ┌─────────────┐ ┌─────────────┐   ┌──────────────────────────────┐  │
│  │ Cam 0 (live)│ │ Cam 1 (live)│   │ Status tiles ×5              │  │
│  └─────────────┘ └─────────────┘   ├──────────────────────────────┤  │
│  Intake game tiles                 │ System: Reset / Dispense     │  │
│  Status (4 tiles)                  │ Hardware: Eject / Drawer /   │  │
│                                    │           Snapshots          │  │
│                                    │ Operations: Brief / Detect   │  │
│                                    │ Schedule (per-slot HH:MM)    │  │
│                                    │ Service logs (live tail)     │  │
└──────────────────────────────────────────────────────────────────────┘
```

### After
```
┌──────────────────────────────────────────────────────────────────────┐
│  Logo  | Dashboard Assistant Inventory Dispenser Patient List | ⚙    │
├──────────────────────────────────────────────────────────────────────┤
│  /dispensers/<id>                                                    │
│  Status tiles (5: Cycles / Loop / Hardware / Drawer / Last cycle)    │
│  Intake game panel                                                   │
│  ┌─────────────┐ ┌─────────────┐                                     │
│  │ Cam 0 (live)│ │ Cam 1 (live)│   [Show model overlay]              │
│  └─────────────┘ └─────────────┘                                     │
│  System          : Reset / Dispense now                              │
│  Hardware        : Eject buttons / Drawer / Snapshots                │
│  Operations      : Brief / Detect / Refresh caches                   │
│  Schedule        : per-slot HH:MM rows                               │
│  Service logs    : live tail, max-h-96 scroll                        │
└──────────────────────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Top nav order | Dashboard, Patients, Inventory, Reports, Assistant, Admin | Dashboard, Assistant, Inventory, Dispenser, Patient List | 5 items; "Patients" relabelled "Patient List". |
| `/admin` URL | Standalone page | 404 (route removed) | Old in-app links / bookmarks break — none found in repo. |
| "Dispenser" nav click | n/a | `/dispensers/${NEXT_PUBLIC_DEFAULT_DISPENSER_ID ?? "dispenser-001"}` | Single-tenant default. Multi-tenant deferred. |
| Hardware ops | `/admin` only | `/dispensers/[id]` | Same controls, same `lib/device.ts` helpers — no new endpoints. |
| Schedule editing | `/admin` only | `/dispensers/[id]` | Same `setSlotSchedule` / `fetchSchedules`. |
| Service logs panel | `/admin` only | `/dispensers/[id]` | Same `fetchPiLogs` polling at 2 s. |
| Reports link | In nav | Removed from nav | Route at `/reports` still works if typed directly. |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/components/Navbar.tsx` | 1-86 | Nav source-of-truth — `NAV_ITEMS` array drives order/labels. |
| P0 | `frontend/src/app/admin/page.tsx` | 1-563 | Full source to copy panels from. Includes `SectionCard`, `StatusTile`, `ActionButton` helpers + `formatLogTime`/`levelColor` utilities used inside. |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 1-389 | Existing dispenser page (already has cams + intake game). Target for the merge. Has its own `StatusTile` (4 fields) — must reconcile with admin's 5-field version. |
| P1 | `frontend/src/lib/device.ts` | 1-220 | All device helpers (`fetchDeviceStatus`, `manualEject`, `setSlotSchedule`, `fetchPiLogs`, `fetchSchedules`, `setDrawer`, `triggerDispense`, `fetchSnapshot`, `resetDevice`, `streamUrl`, `isDeviceConfigured`). Already imported from admin — same imports usable from dispenser page. |
| P1 | `frontend/src/lib/agent.ts` | 1-230 | `refreshBrief` + `triggerFlagDetection` — used in admin's "Operations" panel. Same imports usable. |
| P1 | `frontend/src/lib/swr.ts` | 1-100 | `KEYS` (slots/logs/patients/alerts/flags/brief). Admin's "Refresh caches" + post-action `mutate(KEYS.brief)` rely on these. |
| P2 | `frontend/.env.local` | all | Add `NEXT_PUBLIC_DEFAULT_DISPENSER_ID=dispenser-001`. Backend already has `DEFAULT_DISPENSER_ID` server-side; we mirror to the public env so the nav can build the link without a fetch. |
| P2 | `frontend/src/app/page.tsx` | 1-50 | Dashboard is `/` — confirm `pathname === "/"` active-state branch in Navbar still works. |
| P2 | `frontend/src/app/patients/[id]/page.tsx` | 200-220 | Already links into `/dispensers/${dispenser_id}` — no change needed, but confirms target route survives. |

## External Documentation
No external research needed — feature uses established internal patterns (Next.js App Router, Tailwind v4 utility classes, SWR, "use client" components, `next/link`).

---

## Patterns to Mirror

### NAV_ITEMS_SHAPE
```tsx
// SOURCE: frontend/src/components/Navbar.tsx:6-13
const NAV_ITEMS = [
  { label: "Dashboard", href: "/" },
  { label: "Patients", href: "/patients" },
  { label: "Inventory", href: "/inventory" },
  { label: "Reports", href: "/reports" },
  { label: "Assistant", href: "/agent" },
  { label: "Admin", href: "/admin" },
];
```
Keep the same `{ label, href }` shape. Order + entries change. Active-state logic at lines 37-40 already handles "/" vs prefix-startsWith — no change needed.

### SECTION_CARD
```tsx
// SOURCE: frontend/src/app/admin/page.tsx:495-508
function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
      {children}
    </div>
  );
}
```
Move this into the merged dispenser page (inline, not extracted). Both admin and dispenser share `border-sand-200 bg-white` + `rounded-2xl` aesthetic.

### ACTION_BUTTON
```tsx
// SOURCE: frontend/src/app/admin/page.tsx:535-562
function ActionButton({ onClick, disabled, children, tone }: {...}) {
  const cls =
    tone === "danger"
      ? "border-status-danger bg-white text-status-danger hover:bg-status-danger-bg"
      : tone === "muted"
      ? "border-sand-200 bg-white text-gray-700 hover:bg-sand-50"
      : "border-olive-300 bg-olive-700 text-white hover:bg-olive-800";
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >{children}</button>
  );
}
```
Match exactly when copying admin actions into dispenser page. Dispenser page already has its own pill-style "Dispense Now" button — replace with `ActionButton` for consistency.

### STATUS_TILE_PATTERN
Two divergent versions exist:
```tsx
// SOURCE: frontend/src/app/admin/page.tsx:510-533 (5-tile, includes Drawer)
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:204-227 (4-tile, no Drawer)
```
Merge: use admin's 5-tile version (Cycles / Loop / Hardware / Drawer / Last cycle). Keep one local `StatusTile` definition.

### POLLING_PATTERN
```tsx
// SOURCE: frontend/src/app/admin/page.tsx:61-74
useEffect(() => {
  if (!configured) return;
  let alive = true;
  async function tick() {
    const s = await fetchDeviceStatus();
    if (alive) setStatus(s);
  }
  tick();
  const id = setInterval(tick, 3000);
  return () => { alive = false; clearInterval(id); };
}, [configured]);
```
Already mirrored in dispenser page lines 35-55 with `setStatusError` extra. Keep dispenser's variant (it has error reporting for the unreachable case).

### WITH_BUSY
```tsx
// SOURCE: frontend/src/app/admin/page.tsx:123-131
async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  setBusy(label);
  setMsg(null);
  try { return await fn(); }
  finally { setBusy(null); }
}
```
Keep verbatim. Dispenser page currently has its own ad-hoc `setDispensing(true)` for one button — replace with `withBusy`.

### LOG_FORMATTERS
```tsx
// SOURCE: frontend/src/app/admin/page.tsx:25-47
function formatLogTime(ts: number): string { /* HH:MM:SS hour12=false */ }
function levelColor(level: string): string { /* ERROR|CRITICAL → danger, WARNING → warn, INFO → olive, default → gray */ }
```
Move alongside the rest into the merged dispenser page.

### NEXT_LINK_NAV
```tsx
// SOURCE: frontend/src/components/Navbar.tsx:42-53
<Link key={item.href} href={item.href}
  className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
    isActive ? "bg-olive-700 text-white shadow-sm" : "text-gray-500 hover:bg-sand-100 hover:text-gray-900"
  }`}
>{item.label}</Link>
```
No change to render logic. Only `NAV_ITEMS` data changes.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `frontend/src/components/Navbar.tsx` | UPDATE | New `NAV_ITEMS` order + labels; build `/dispensers/${defaultDispenserId}` href from `process.env.NEXT_PUBLIC_DEFAULT_DISPENSER_ID ?? "dispenser-001"`. Active-state for `/dispensers` prefix-match continues to work. |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | Inline all admin sections (System / Hardware / Operations / Schedule / Service logs). Promote status grid to 5 tiles. Add `useSWRConfig`, `refreshBrief`, `triggerFlagDetection`, `KEYS`, `manualEject`, `setDrawer`, `setSlotSchedule`, `fetchPiLogs`, `fetchSchedules`, `fetchSnapshot`, `resetDevice` imports. Keep current cam streams + intake game panel. |
| `frontend/src/app/admin/page.tsx` | DELETE | Merged into dispenser page. Removing the file deletes the route under Next.js App Router. |
| `frontend/src/app/admin/` (folder) | DELETE | Empty after page.tsx removal. `git rm -r` to clean. |
| `frontend/.env.local` | UPDATE | Add `NEXT_PUBLIC_DEFAULT_DISPENSER_ID=dispenser-001` so Navbar can resolve the link without fetch. |
| `frontend/.env.local.example` | UPDATE | Mirror the new public env var so fresh clones get the hint. |

## NOT Building
- A `/dispensers` index page that lists all dispensers. Single-tenant pilot — defer until multi-tenant is on the roadmap.
- A backend endpoint to expose `default_dispenser_id` to frontend. Keep the value in `frontend/.env.local` (mirroring the backend). One source of truth per tier is acceptable for now.
- Server-side redirect from `/admin` → `/dispensers/<id>`. Next.js will return 404 on `/admin` after the file deletion; no in-repo links pointed there.
- Removing `/reports` route entirely. User asked only to drop from nav. Leave the route + page in place; nav exclusion is the only requested change.
- Refactor of `SectionCard` / `ActionButton` / `StatusTile` into a shared `frontend/src/components/` module. Out of scope for this merge — keep them inline in the merged page (matches existing one-page-owns-its-helpers pattern).
- Any change to the backend `/api/device/*` surface. All hardware ops already exist there.
- Any change to the dispense cycle logic, RGB camera path, or Pi-side code.

---

## Step-by-Step Tasks

### Task 1: Add `NEXT_PUBLIC_DEFAULT_DISPENSER_ID` to env files
- **ACTION**: Append the var to both env files.
- **IMPLEMENT**:
  ```dotenv
  # frontend/.env.local — add after the existing DEVICE_API_KEY block
  NEXT_PUBLIC_DEFAULT_DISPENSER_ID=dispenser-001
  ```
  ```dotenv
  # frontend/.env.local.example — add a documented placeholder
  # Default dispenser id for the "Dispenser" nav tab. Mirror of the
  # backend DEFAULT_DISPENSER_ID. Single-tenant pilots can leave this
  # at "dispenser-001".
  NEXT_PUBLIC_DEFAULT_DISPENSER_ID=dispenser-001
  ```
- **MIRROR**: Existing `NEXT_PUBLIC_DEVICE_URL` / `NEXT_PUBLIC_DEVICE_API_KEY` documentation tone in `.env.local.example`.
- **IMPORTS**: N/A (config file).
- **GOTCHA**: `NEXT_PUBLIC_*` is the only prefix Next.js inlines into the client bundle. Without that prefix, the value is `undefined` in `Navbar.tsx`.
- **VALIDATE**: `grep NEXT_PUBLIC_DEFAULT_DISPENSER_ID frontend/.env.local frontend/.env.local.example` returns both lines.

### Task 2: Rewrite `NAV_ITEMS` in `Navbar.tsx`
- **ACTION**: Replace the `NAV_ITEMS` constant with the new order/labels and resolve the dispenser href from env.
- **IMPLEMENT**:
  ```tsx
  // frontend/src/components/Navbar.tsx — replace lines 6-13
  const DEFAULT_DISPENSER_ID =
    process.env.NEXT_PUBLIC_DEFAULT_DISPENSER_ID ?? "dispenser-001";

  const NAV_ITEMS = [
    { label: "Dashboard",    href: "/" },
    { label: "Assistant",    href: "/agent" },
    { label: "Inventory",    href: "/inventory" },
    { label: "Dispenser",    href: `/dispensers/${DEFAULT_DISPENSER_ID}` },
    { label: "Patient List", href: "/patients" },
  ];
  ```
- **MIRROR**: Same `{ label, href }` object shape used today (line 6-13).
- **IMPORTS**: None new — `Link`, `usePathname` already imported.
- **GOTCHA**: Active-state logic uses `pathname.startsWith(item.href)` for non-`/` items. The dispenser href contains the id, so visiting any other id (e.g. `/dispensers/foo`) would NOT highlight the tab. For single-tenant this is fine; document the limitation in a one-line comment above the constant.
- **VALIDATE**: Open `/`, `/agent`, `/inventory`, `/dispensers/dispenser-001`, `/patients` in dev — each highlights its tab. `/admin` is gone from the bar.

### Task 3: Inline admin panels into `dispensers/[id]/page.tsx`
- **ACTION**: Merge admin's state, effects, handlers, and JSX into the dispenser page. Preserve existing cam streams + intake game panel. Replace the 4-tile status block with admin's 5-tile version.
- **IMPLEMENT**: Open both files side-by-side and:
  1. **Imports**: union the import blocks. New imports for the dispenser page:
     ```tsx
     import { useSWRConfig } from "swr";
     import {
       fetchPiLogs, fetchSchedules, fetchSnapshot,
       manualEject, resetDevice, setDrawer, setSlotSchedule,
       type LogRecord, type ScheduleRow,
     } from "@/lib/device";
     import { refreshBrief, triggerFlagDetection } from "@/lib/agent";
     import { KEYS } from "@/lib/swr";
     ```
  2. **State**: add `const { mutate } = useSWRConfig();`, plus `busy`, `msg`, `snap`, `logs`, `schedules`, `scheduleDrafts`, `prevSnapUrl` from admin lines 50-58. Drop the dispenser's `dispensing` / `dispenseMsg` state — `withBusy` + `msg` replaces them.
  3. **Helpers**: copy `formatLogTime`, `levelColor`, `withBusy`, `onReset`, `onDispense`, `onEject`, `onDrawer`, `onSnapshot`, `onBrief`, `onDetect`, `onRefreshCaches`, `onScheduleSave`, `onScheduleClear` from admin lines 25-231 verbatim.
  4. **Effects**: add the three polling effects from admin lines 61-115 (status, logs, schedules) — guard each with `if (!configured) return;` exactly as admin does. The dispenser already has its own status poll; consolidate so there's one status poll (use the admin pattern, reinstate the dispenser's `setStatusError` branch).
  5. **JSX**: between the existing intake game panel and the cams, render the 5-tile status grid (admin's version) — replace the dispenser's current 4-tile block. Below the cams, append `<SectionCard>` blocks for System, Hardware, Operations, Schedule, Service logs in that order, copy-pasted from admin lines 288-490.
  6. **Helpers (footer)**: copy `SectionCard`, `ActionButton` from admin lines 495-562 to the bottom of the file. Reconcile the existing dispenser `StatusTile` (4-arg) with admin's (3-arg) — keep one definition; admin's is sufficient.
- **MIRROR**: All listed `SOURCE:` comments in the Patterns to Mirror section.
- **IMPORTS**: union as listed above.
- **GOTCHA 1**: Two `useEffect`s currently poll `/status` (admin: 3 s, dispenser: 3 s). Consolidate into ONE — leaving both will double-fetch and the cache will thrash. Drop the dispenser's existing one and use admin's, but reinstate `setStatusError(null)` / failure branch.
- **GOTCHA 2**: `prevSnapUrl.current = url` + `URL.revokeObjectURL` on unmount — dispenser page didn't have this before. If you copy the snapshot logic, also copy the cleanup `useEffect` at admin line 117-121, or you'll leak Blob URLs across sessions.
- **GOTCHA 3**: `IntakeGamePanel` and the cam strip are currently rendered between status + footer note. Keep that layout — moving the game below the cams will surprise users. The new structure should be: header → status (5 tiles) → IntakeGamePanel → annotation toggle → cam grid → SectionCards (System / Hardware / Operations / Schedule / Logs) → footer note.
- **GOTCHA 4**: The dispenser page is parameterised by `[id]` but admin assumes a single device. All `lib/device.ts` calls are id-agnostic (they hit the env-configured ngrok URL). Multi-dispenser parity is NOT in scope — render the same panels regardless of `id`. Add a one-line comment near the top: `// NOTE: lib/device.ts is single-target; id is informational until multi-tenant lands.`
- **VALIDATE**:
  - `npm run lint && npm run build` passes (zero TS errors).
  - Dev server: `/dispensers/dispenser-001` shows ALL of: status × 5, intake panel, cams, System / Hardware / Operations / Schedule / Logs.
  - Eject button → Pi receives the call (check service logs panel populates).
  - Snapshot + Drawer + Schedule edit + Brief + Detect + Refresh caches all functional.

### Task 4: Delete `/admin` route
- **ACTION**: Remove the file + parent folder.
- **IMPLEMENT**:
  ```bash
  git rm frontend/src/app/admin/page.tsx
  rmdir frontend/src/app/admin
  ```
- **MIRROR**: N/A — deletion.
- **IMPORTS**: N/A.
- **GOTCHA**: Confirm no other file imports from `app/admin/page.tsx` first:
  ```bash
  grep -rn "app/admin\|from.*admin/page" frontend/src
  ```
  Should return zero hits (admin is a route, not an exported module).
- **VALIDATE**: `curl -I http://localhost:3000/admin` returns 404 after dev server reloads. No build errors.

### Task 5: Smoke-test nav + page in browser
- **ACTION**: Click each nav item; confirm active state + correct page.
- **IMPLEMENT**: N/A — manual.
- **MIRROR**: N/A.
- **IMPORTS**: N/A.
- **GOTCHA**: Free-tier ngrok interstitial may block stream `<img>` requests on first load — visit the ngrok URL in a tab once to dismiss (already documented in dispenser page footer).
- **VALIDATE**: Each tab highlights when active. Streams render. Hardware buttons fire (logs panel reflects). Schedule edits persist (Supabase `medications.schedule_at` updated).

---

## Testing Strategy

### Unit Tests
No frontend test harness exists in this repo (per CLAUDE.md: "no test suite is configured"). Skip unit tests and rely on the manual validation checklist.

### Edge Cases Checklist
- [ ] `NEXT_PUBLIC_DEFAULT_DISPENSER_ID` unset → fallback to `"dispenser-001"`; nav tab still works (Task 2 fallback expression).
- [ ] User visits `/dispensers/some-other-id` → page renders, but the nav "Dispenser" tab is not highlighted (acceptable for single-tenant; documented).
- [ ] `isDeviceConfigured()` is `false` (frontend env missing) → "Set NEXT_PUBLIC_DEVICE_URL…" banner renders; all hardware/log/schedule sections show their existing "Configure device to…" placeholders. No console errors.
- [ ] ngrok offline → `fetchDeviceStatus` returns null → `statusError` banner shows. Status tiles render `—`. Cams show broken-image alt text. No client crash.
- [ ] User refreshes during a `withBusy("eject-3")` → no zombie `busy` state (component unmounts; the in-flight fetch resolves into a dead component, React warns once but recovers). Acceptable.
- [ ] Browser back/forward across `/dispensers/[id]` and `/agent`, `/inventory` etc. → SWR caches survive; status poll restarts cleanly via `useEffect` cleanup.
- [ ] `/admin` direct navigation → 404 page (Next.js default).

---

## Validation Commands

### Static Analysis
```bash
cd frontend && npm run lint
```
EXPECT: Zero errors. Existing project lint config (Next.js) — no rules added.

### Type Check (build runs `tsc`)
```bash
cd frontend && npm run build
```
EXPECT: Zero TypeScript errors. Bundle size delta ≤ +5 KB gz (admin code moves, doesn't duplicate).

### Dev Server
```bash
cd frontend && npm run dev
```
EXPECT: Server boots on `:3000`. Console clean. HMR works as files are edited.

### Backend Validation
No backend changes — skip. Existing `/api/device/*` endpoints already serve the merged page.

### Manual Validation
- [ ] Open `http://localhost:3000/`. Top nav shows: Dashboard | Assistant | Inventory | Dispenser | Patient List, in that order.
- [ ] Click "Dispenser" → URL becomes `/dispensers/dispenser-001`. Tab highlighted.
- [ ] Page renders: status × 5 tiles, intake game panel, annotation toggle, two cam tiles, SectionCard × 5 (System / Hardware / Operations / Schedule / Service logs).
- [ ] "Reset loop" → confirm dialog → click → status panel updates `cycle_n`. msg banner shows "Loop reset.".
- [ ] "Dispense now" → msg banner shows "Dispense queued."; cycle increments within poll interval.
- [ ] Manual eject button "3" → Pi logs reflect the call.
- [ ] Drawer Unlock/Lock → status tile flips between LOCKED/UNLOCKED.
- [ ] Snapshot Cam 0 + Cam 1 → thumbnails render.
- [ ] Schedule for slot 5 → save HH:MM → row shows `live: HH:MM` chip.
- [ ] Brief / Detect / Refresh caches → all return success messages, no console errors.
- [ ] Direct nav to `/admin` → 404.
- [ ] Direct nav to `/reports` → page still renders (just absent from nav).

---

## Acceptance Criteria
- [ ] Nav order matches: Dashboard, Assistant, Inventory, Dispenser, Patient List (5 items).
- [ ] "Dispenser" tab links to `/dispensers/${NEXT_PUBLIC_DEFAULT_DISPENSER_ID ?? "dispenser-001"}`.
- [ ] All admin panels (System / Hardware / Operations / Schedule / Service logs) live on `/dispensers/[id]`.
- [ ] `/admin` route returns 404; folder deleted.
- [ ] `npm run build` passes.
- [ ] Manual checklist green.

## Completion Checklist
- [ ] Code follows discovered patterns (SectionCard / ActionButton / StatusTile / withBusy / formatLogTime / levelColor copied verbatim from admin).
- [ ] Error handling matches existing style (no new try/catch wrappers; rely on `lib/device.ts` returning `{ ok: false }` shapes).
- [ ] Logging follows codebase conventions (no `console.log` added; backend logs already cover hardware ops).
- [ ] No tests added (per existing repo convention — manual validation only).
- [ ] No hardcoded values beyond the documented `"dispenser-001"` fallback.
- [ ] No unnecessary scope additions (no shared components extracted, no `/dispensers` index added, no Reports route deleted).
- [ ] Self-contained — no questions needed during implementation.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Two concurrent status polls remain after merge (forgot to remove dispenser's) | Med | Doubles `/status` traffic to Pi | Task 3 GOTCHA 1: explicitly delete the dispenser's existing poll before adding admin's. |
| `NEXT_PUBLIC_DEFAULT_DISPENSER_ID` not set in deployed env → nav points to wrong id | Low | Tab opens an empty page | Task 1 fallback to `"dispenser-001"`. Task 5 manual validation catches it. |
| User visits a non-default dispenser id → "Dispenser" tab no longer highlights | Low | Minor UX wrinkle | Documented in Task 2 GOTCHA. Future multi-tenant work can switch active-state to `pathname.startsWith("/dispensers")`. |
| Bookmarks to `/admin` break for existing operators | Low | One-time confusion | Acceptable — pre-pilot stage, no external bookmarks expected. |
| Page becomes too long — operator scrolls forever | Med | UX | Existing layout already accepts long pages (admin was equally long). Could add a sticky table-of-contents in a follow-up if it's a real complaint. NOT in scope. |

## Notes
- All `lib/device.ts` and `lib/agent.ts` helpers used by admin are already imported elsewhere — no new dependencies.
- Tailwind class set is identical between admin and dispenser pages (`rounded-2xl`, `border-sand-200`, `bg-white`, `text-olive-700`, `bg-status-*`). No new tokens.
- The dispenser page's existing footer note about ngrok interstitial stays put — still relevant.
- Backend changes done in the prior session (cam_b RGB, asyncio.to_thread on Supabase calls, etc.) are unrelated to this plan and don't need to be re-shipped here.
