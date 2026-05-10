# Plan: Admin Hardware Control Panel

## Summary
A new `/admin` route gives an operator full hardware + ops control over the Pi-hosted backend without touching SSH. Adds 5 backend endpoints (eject, drawer, snapshot, in-memory logs, flag-detect-now), a per-process logging ring buffer, an asyncio mutex shared between the cycle loop and manual ops, and one new frontend page that reuses the existing `lib/device.ts` auth pattern.

## User Story
As a clinician/admin, I want a single dashboard page to reset the loop, eject a pill from any slot, lock/unlock the drawer, snap a still from each camera, view recent service logs, and trigger brief / flag-detection runs, so I can diagnose the device or seed a demo without shelling into the Pi.

## Problem → Solution
**Current**: `/dispensers/[id]` exposes "Dispense Now", "Reset" (endpoint exists but no UI), live cameras, intake game. Hardware test buttons live only in `backend/hardware/test_*.py` scripts that need SSH + sudo. Operations triggers (brief, flag detection) only run on schedule. Operator has to SSH+`journalctl` to see logs.
**Desired**: One `/admin` page in the dashboard with sections — System (reset, status, force dispense), Hardware (eject from slot, drawer lock/unlock, camera snapshots), Operations (brief now, flag detection now), Logs (in-memory ring buffer of the last 500 records). Same X-Device-API-Key auth as the existing device endpoints.

## Metadata
- **Complexity**: Medium-Large (multi-file, multi-tier — backend endpoints + safety mutex + frontend page)
- **Source PRD**: N/A (standalone)
- **PRD Phase**: N/A
- **Estimated Files**: 9 changed, 3 created

---

## Design Decisions (confirmed with user)

| Question | Choice | Implication |
|---|---|---|
| Manual eject behaviour | **Rotate + eject (full mechanical test)** | No DB read/write. `Magazine.rotate_to(slot)` + `Ejector.push()`. Drawer stays locked. Mirrors `hardware/test_ejector.py`. |
| Logs source | **App-level ring buffer (Python logger)** | `collections.deque(maxlen=500)` attached as a `logging.Handler` in `main.py` lifespan. No subprocess, no journalctl. Survives only as long as the FastAPI process — fine for runtime debugging. |
| Camera snapshot output | **Inline JPEG response** | `GET /api/device/snapshot?cam={0,1}` → `Response(content=bytes, media_type="image/jpeg")`. Frontend renders via `<img src="...&t=<ts>"/>` with cache-busting. |
| Force cycle | **Drop — duplicates Dispense Now** | "Dispense Now" already wakes the supervisor. No new endpoint needed. |

### Concurrency model — the missing piece

The existing cycle loop (`backend/scheduler/cycle_runner.py`) holds the same `Magazine` / `Ejector` / `DrawerLock` instances that the new manual endpoints will need. Calling `Ejector.push()` from a manual endpoint while the cycle's `_dispense` is also calling `push()` would have two threads driving GPIO at once — undefined behaviour.

**Solution**: a single `asyncio.Lock` on `app.state.hardware_lock`, acquired by:
- The cycle loop, around the `magazine.rotate_to → ejector.push` block (one new edit in `cycle_runner.py`).
- Each new manual endpoint, for the duration of its hardware call.

The lock is fair (asyncio FIFO), so a manual op queued while a cycle is running will run as soon as the cycle's dispense block releases. No explicit "pause/resume" UX needed for MVP.

### Auth — already done

`backend/api/device.py:23` declares `router = APIRouter(dependencies=[Depends(verify_device_api_key)])`. New endpoints in this router inherit the gate automatically. The new flag-detect endpoint goes under `api/agent.py` which uses `verify_device_api_key` the same way (see `api/agent.py` import).

### "Refresh inventory" — frontend-only

The dashboard already has SWR auto-refresh (slots 60 s, logs 30 s, patients 5 min). "Refresh inventory" on the admin page just calls `mutate()` on the SWR cache keys — no backend endpoint. Listed below in the frontend tasks.

---

## UX Design

### Before
```
Dashboard → Greeting → 4 panels → Floor map → Dispenser overview + Intake log
/dispensers/[id] → Dispense Now button + status tiles + intake game + 2 camera streams
(reset, eject, drawer, snapshots, logs, flag-detect, brief-now)  ← unreachable from UI
```

### After
```
Dashboard (unchanged)

NEW: /admin route, accessible via Navbar item "Admin"

┌──── /admin ────────────────────────────────────────────────────────┐
│  Status banner: cycles=42 · loop=running · hw=real · last=✓ 1.8 s  │
│  ┌── System ──────────────────────────────────────────────────┐    │
│  │ [Reset loop]  [Dispense now]                                │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌── Hardware ────────────────────────────────────────────────┐    │
│  │ Eject from slot: [0][1][2][3][4][5][6][7][8][9]             │    │
│  │ Drawer:     [Lock]  [Unlock]   (state: locked)              │    │
│  │ Snapshots:  [Cam 0]  [Cam 1]   (refreshes inline images)    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌── Operations ──────────────────────────────────────────────┐    │
│  │ [Generate brief now]   [Run flag detection now]             │    │
│  │ [Refresh inventory caches]                                  │    │
│  │ Last result: detected 2 new flags / brief id=…              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌── Recent service logs (in-memory, last 500) ──────────────┐     │
│  │ 13:42:01 INFO  cycle_runner   Cycle #42 done — taken=True   │    │
│  │ 13:41:55 INFO  pill_verifier  Tray empty (3 frames)         │    │
│  │ … live, autoscroll-to-top, 2 s SWR refresh                  │    │
│  └─────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Reset loop | Endpoint exists, no UI | Button on `/admin` | Confirmation dialog before firing — destructive |
| Manual eject slot N | Only via `hardware/test_ejector.py` over SSH | Button row 0–9 on `/admin` | Each button shows latency `(1.2 s)` after success |
| Drawer lock/unlock | Only via cycle | Toggle pair + state pill on `/admin` | `is_unlocked()` polled every 3 s |
| Camera snapshot | Only via live MJPEG | Two buttons → inline `<img>` | Cache-busted; replaces previous shot |
| Pi logs | SSH `journalctl -u pharmguard` | In-memory tail on `/admin` | NOTE: covers only what's been logged since uvicorn started |
| Brief generation | Schedule-only or BriefCard refresh | "Generate now" button on `/admin` | Same call as BriefCard's existing button — duplicate convenience |
| Flag detection | Schedule-only (every 12 h) | "Run flag detection now" button | Returns counts for instant feedback |
| Inventory cache refresh | Auto via SWR intervals | Manual "Refresh" button | `mutate()` on slots/logs/patients SWR keys |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/api/device.py` | 1-200 | Exact pattern for new device endpoints + how `_get_loop()` + `verify_device_api_key` work. |
| P0 | `backend/hardware/ejector.py` | all (~145) | `Ejector.push()` is sync + GPIO-blocking → needs `asyncio.to_thread`. |
| P0 | `backend/hardware/drawer_lock.py` | all (~150) | `DrawerLock.lock/unlock/is_unlocked` API. Same to_thread treatment. |
| P0 | `backend/hardware/magazine.py` | all (~130) | `Magazine.rotate_to(slot)` API. |
| P0 | `backend/scheduler/cycle_runner.py` | grep `dispense` | Where to wrap the `magazine.rotate_to → ejector.push` block in the new `app.state.hardware_lock`. |
| P0 | `backend/main.py` | all | Lifespan setup — install logging handler + create hardware_lock here. |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 1-200 | Closest UI sibling. Mirror status polling, button styles, error banner pattern. |
| P0 | `frontend/src/lib/device.ts` | all (~143) | Add new client functions here, reuse `authHeaders()`, `isDeviceConfigured()`. |
| P1 | `frontend/src/components/BriefCard.tsx` | 50-70 | Pattern for "trigger backend op + mutate SWR cache" — copy for "Generate brief now". |
| P1 | `frontend/src/components/Navbar.tsx` | all | Add "Admin" nav item. |
| P1 | `backend/services/flag_detector.py` | top + `detect_and_persist_flags` | Public callable returns `{new_count, by_kind, gemini_used}`. |
| P1 | `backend/api/agent.py` | router setup + brief endpoint | Pattern for new `/api/agent/flags/detect` endpoint. |
| P2 | `backend/vision/camera.py` | 117-205 (latest_frame_jpeg) | Reuse `cam.latest_frame_jpeg(quality)` for snapshots. No new camera plumbing. |
| P2 | `frontend/src/lib/swr.ts` | all | `KEYS` + `mutate()` pattern for the inventory-refresh button. |

## External Documentation
None. All patterns internal.

---

## Patterns to Mirror

### NEW_DEVICE_ENDPOINT
// SOURCE: backend/api/device.py:53-64
```python
@router.post("/dispense_now", status_code=202)
async def dispense_now(request: Request):
    """Wake the supervisor early …"""
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
    loop.trigger_dispense_now()
    return {"queued": True}
```
Every new hardware endpoint follows this shape: get loop, 503 if headless, do thing, return JSON.

### TO_THREAD_HARDWARE_CALL
// SOURCE: backend/scheduler/cycle_runner.py (the existing dispense block)
```python
await asyncio.to_thread(state.magazine.rotate_to, slot)
await asyncio.to_thread(state.ejector.push)
```
GPIO calls are sync + blocking. Always wrap with `to_thread` so the FastAPI event loop stays responsive.

### LOCK_THE_HARDWARE_BLOCK
// NEW pattern (this plan introduces it).
```python
async with request.app.state.hardware_lock:
    await asyncio.to_thread(state.magazine.rotate_to, slot)
    await asyncio.to_thread(state.ejector.push)
```
And in `cycle_runner.py`, the existing dispense block also acquires the same lock. Lock object is created once in `main.py` lifespan: `app.state.hardware_lock = asyncio.Lock()`.

### CAMERA_SNAPSHOT
// SOURCE: backend/api/device.py:170-178 (existing stream endpoint reads `cam.latest_frame_jpeg()`)
```python
cam = getattr(state, "cam_a" if cam_num == 0 else "cam_b", None)
if cam is None or not hasattr(cam, "latest_frame_jpeg"):
    raise HTTPException(status_code=503, detail=...)
jpeg = cam.latest_frame_jpeg(quality=80)
return Response(content=jpeg, media_type="image/jpeg")
```

### LOG_RING_BUFFER
// NEW (plan introduces).
```python
# backend/core/log_ring.py
import logging
from collections import deque
from typing import Deque

class RingBufferHandler(logging.Handler):
    def __init__(self, maxlen: int = 500) -> None:
        super().__init__()
        self.records: Deque[dict] = deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.records.appendleft({
                "ts": record.created,
                "level": record.levelname,
                "name": record.name,
                "message": record.getMessage(),
            })
        except Exception:
            self.handleError(record)
```
Installed in `main.py` lifespan via `logging.getLogger().addHandler(handler)`. Endpoint reads `list(handler.records)`.

### FRONTEND_DEVICE_CALL
// SOURCE: frontend/src/lib/device.ts:99-110 (`triggerDispense`)
```ts
export async function triggerDispense(): Promise<{ ok: boolean; status: number }> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/dispense_now`, {
      method: "POST",
      headers: authHeaders(),
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
```
All new client functions follow this `{ok, status}` envelope so the UI can render error banners uniformly.

### NAV_ITEM
// SOURCE: frontend/src/components/Navbar.tsx (existing pattern)
```tsx
{ label: "Assistant", href: "/agent" }
```
Add `{ label: "Admin", href: "/admin" }` to the same array.

### CARD_CHROME (frontend section wrapper)
// SOURCE: existing dashboard panels (FloorMap, BriefCard, FlagsPanel, AlertsPanel)
```tsx
<div className="rounded-2xl border border-sand-200 bg-white p-6">
  <div className="mb-4 flex items-center gap-2">
    <svg width="18" height="18" ... stroke="#4a6741" strokeWidth="1.8">{/* icon */}</svg>
    <h2 className="text-base font-semibold text-gray-900">Section title</h2>
  </div>
  {/* body */}
</div>
```
Reuse for each /admin section.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/core/log_ring.py` | CREATE | New `RingBufferHandler` + module-level `RING` singleton getter. |
| `backend/api/device.py` | UPDATE | Add 4 new routes: `/eject`, `/drawer`, `/snapshot`, `/logs`. Extend `/status` with `is_unlocked`. |
| `backend/api/agent.py` | UPDATE | Add 1 new route: `POST /flags/detect`. |
| `backend/main.py` | UPDATE | Install RingBufferHandler in lifespan; create `app.state.hardware_lock`. |
| `backend/scheduler/cycle_runner.py` | UPDATE | Wrap the existing `magazine.rotate_to → ejector.push → drawer.unlock/lock` calls in `async with app.state.hardware_lock`. |
| `frontend/src/lib/device.ts` | UPDATE | Add `manualEject(slot)`, `setDrawer(action)`, `fetchSnapshot(cam)`, `fetchPiLogs(n?)`, types. Extend `DeviceStatus` with `is_unlocked`. |
| `frontend/src/lib/agent.ts` | UPDATE | Add `triggerFlagDetection()` returning `{new_count, by_kind, gemini_used}`. |
| `frontend/src/app/admin/page.tsx` | CREATE | The `/admin` page composing 4 sections (System, Hardware, Operations, Logs). |
| `frontend/src/components/Navbar.tsx` | UPDATE | Add `{ label: "Admin", href: "/admin" }`. |

## NOT Building
- **No journalctl/subprocess logs.** App ring buffer only — covers what the FastAPI process logs since startup. journalctl integration is a follow-up.
- **No "force cycle" button.** Reuses existing "Dispense Now"; "Force cycle" is the same operation.
- **No drawer auto-relock timer on `/admin`.** The Hardware section's [Unlock] is a raw test — operator clicks [Lock] to relock. The cycle's auto-relock (`hold_unlocked`) is unaffected.
- **No camera streaming on /admin.** That stays on `/dispensers/[id]`. Snapshots only.
- **No log filtering / search.** Just last 500 records, newest first.
- **No multi-user audit trail / role-based perms.** Existing X-Device-API-Key gate only.
- **No remote service restart (`systemctl restart pharmguard`).** Use the existing `/api/device/reset` endpoint, which restarts the loop without exiting uvicorn.
- **No new SQL.** Schema unchanged.
- **No log persistence across restarts.** In-memory only.
- **No "stub mode" toggle from UI.** `PHARMGUARD_STUB` is an env var; runtime toggle would need bigger refactor.

---

## Step-by-Step Tasks

### Task 1: Create the ring-buffer logging handler
- **ACTION**: New file `backend/core/log_ring.py`.
- **IMPLEMENT**:
  ```python
  """In-memory ring buffer for recent log records.

  Surfaced via GET /api/device/logs so the dashboard can show what the
  Pi's just been doing without an SSH/journalctl roundtrip. Survives
  only as long as the uvicorn process — by design.
  """
  from __future__ import annotations
  import logging
  from collections import deque
  from threading import Lock
  from typing import Any, Deque

  _MAXLEN_DEFAULT = 500


  class RingBufferHandler(logging.Handler):
      def __init__(self, maxlen: int = _MAXLEN_DEFAULT) -> None:
          super().__init__()
          self.records: Deque[dict[str, Any]] = deque(maxlen=maxlen)
          self._lock = Lock()

      def emit(self, record: logging.LogRecord) -> None:
          try:
              entry = {
                  "ts": record.created,
                  "level": record.levelname,
                  "name": record.name,
                  "message": record.getMessage(),
              }
              with self._lock:
                  self.records.appendleft(entry)
          except Exception:
              self.handleError(record)

      def snapshot(self, n: int | None = None) -> list[dict[str, Any]]:
          with self._lock:
              if n is None or n >= len(self.records):
                  return list(self.records)
              return list(self.records)[:n]


  _RING: RingBufferHandler | None = None


  def install_ring_handler(level: int = logging.INFO, maxlen: int = _MAXLEN_DEFAULT) -> RingBufferHandler:
      global _RING
      if _RING is not None:
          return _RING
      handler = RingBufferHandler(maxlen=maxlen)
      handler.setLevel(level)
      logging.getLogger().addHandler(handler)
      _RING = handler
      return handler


  def get_ring() -> RingBufferHandler | None:
      return _RING
  ```
- **MIRROR**: LOG_RING_BUFFER (this is the canonical reference).
- **IMPORTS**: stdlib only.
- **GOTCHA**: Add a `threading.Lock` because multiple threads (uvicorn workers, cycle thread, to_thread callers) all log simultaneously. `deque.appendleft` is atomic in CPython, but `list(deque)` during a concurrent append can race — the lock makes snapshot reads safe.
- **VALIDATE**: Import smoke: `python -c "from core.log_ring import install_ring_handler; h = install_ring_handler(); import logging; logging.info('hi'); assert len(h.records) == 1"`.

### Task 2: Install the ring handler + create the hardware lock in lifespan
- **ACTION**: Edit `backend/main.py` lifespan to install the handler at startup and to create `app.state.hardware_lock`.
- **IMPLEMENT**: Inside `lifespan(app)`, before spawning HardwareLoop / brief scheduler:
  ```python
  from core.log_ring import install_ring_handler
  install_ring_handler(level=logging.INFO)
  app.state.hardware_lock = asyncio.Lock()
  ```
  No teardown needed — handler lives for process lifetime; `Lock` is GC'd with the app.
- **MIRROR**: existing lifespan in main.py.
- **IMPORTS**: `asyncio` already imported. Add `from core.log_ring import install_ring_handler`.
- **GOTCHA**: Install BEFORE the HardwareLoop spawns so the loop's startup logs are captured.
- **VALIDATE**: `curl -H "X-Device-API-Key: <key>" http://localhost:8000/api/device/logs` (Task 7 endpoint) returns the most recent records, including the loop's startup messages.

### Task 3: Add the hardware lock around the cycle's dispense block
- **ACTION**: Edit `backend/scheduler/cycle_runner.py`. Find the block that calls `state.magazine.rotate_to(...)` followed by `state.ejector.push(...)` AND the drawer `unlock/hold_unlocked/lock` calls. Wrap each contiguous hardware block in `async with app.state.hardware_lock`.
- **IMPLEMENT**:
  ```python
  # Around the dispense step
  async with app.state.hardware_lock:
      await asyncio.to_thread(state.magazine.rotate_to, slot)
      await asyncio.to_thread(state.ejector.push)
  # …elsewhere, around drawer block:
  async with app.state.hardware_lock:
      await asyncio.to_thread(state.drawer.unlock)
      await asyncio.to_thread(state.drawer.hold_unlocked, DRAWER_OPEN_S)
      await asyncio.to_thread(state.drawer.lock)
  ```
- **MIRROR**: LOCK_THE_HARDWARE_BLOCK.
- **IMPORTS**: cycle_runner already has access to `app` via `state.app` or via the `request`-less HardwareLoop. **Read the file first** — if the loop doesn't have direct app access, store the lock on `state` instead: `state.hardware_lock = app.state.hardware_lock` set up in `CycleState.init`. Pick the simplest path that doesn't change the loop's signature.
- **GOTCHA**: Audit the existing cycle for ALL hardware-touching `to_thread` calls and bring them under the lock. Missing one = race.
- **VALIDATE**: Manually fire `POST /api/device/eject` with body `{"slot": 2}` while a cycle is mid-dispense — eject queues, runs after cycle's release. Pi logs show no "GPIO busy" errors.

### Task 4: New endpoint — `POST /api/device/eject`
- **ACTION**: Edit `backend/api/device.py`. Add a new route after `dispense_now`.
- **IMPLEMENT**:
  ```python
  from pydantic import BaseModel, Field
  import time

  class EjectBody(BaseModel):
      slot: int = Field(ge=0, le=9, description="Magazine slot to rotate to before eject.")


  @router.post("/eject")
  async def manual_eject(body: EjectBody, request: Request):
      """Rotate the magazine to `slot` and run one ejector push.

      Raw mechanical test. No DB read or write. Drawer is NOT opened.
      Caller must serialize with the cycle via the shared hardware lock,
      which this endpoint does internally.
      """
      loop = _get_loop(request)
      if loop is None:
          raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
      state = getattr(loop, "_state", None)
      if state is None or state.magazine is None or state.ejector is None:
          raise HTTPException(status_code=503, detail="Hardware not initialised")
      lock: asyncio.Lock = request.app.state.hardware_lock
      t0 = time.monotonic()
      async with lock:
          await asyncio.to_thread(state.magazine.rotate_to, body.slot)
          await asyncio.to_thread(state.ejector.push)
      latency_ms = int((time.monotonic() - t0) * 1000)
      log.info("manual eject: slot=%d latency_ms=%d", body.slot, latency_ms)
      return {"ok": True, "slot": body.slot, "latency_ms": latency_ms}
  ```
- **MIRROR**: NEW_DEVICE_ENDPOINT, TO_THREAD_HARDWARE_CALL.
- **IMPORTS**: add `import time` (top of file), `from pydantic import BaseModel, Field`.
- **GOTCHA**: Pydantic body gives FastAPI 422 for slot out of [0,9] automatically. Don't re-validate.
- **VALIDATE**: `curl -X POST -H "X-Device-API-Key: <key>" -H "Content-Type: application/json" -d '{"slot":2}' http://<pi>/api/device/eject` returns `{"ok":true,"slot":2,"latency_ms":...}`. Pi logs show one rotate + push.

### Task 5: New endpoint — `POST /api/device/drawer`
- **ACTION**: Add to `backend/api/device.py`.
- **IMPLEMENT**:
  ```python
  from typing import Literal

  class DrawerBody(BaseModel):
      action: Literal["lock", "unlock"]


  @router.post("/drawer")
  async def manual_drawer(body: DrawerBody, request: Request):
      """Manual drawer test — bypasses the cycle's auto-relock."""
      loop = _get_loop(request)
      if loop is None:
          raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
      state = getattr(loop, "_state", None)
      drawer = getattr(state, "drawer", None) if state else None
      if drawer is None:
          raise HTTPException(status_code=503, detail="Drawer not initialised")
      lock: asyncio.Lock = request.app.state.hardware_lock
      async with lock:
          if body.action == "unlock":
              await asyncio.to_thread(drawer.unlock)
          else:
              await asyncio.to_thread(drawer.lock)
      log.info("manual drawer: action=%s", body.action)
      return {"ok": True, "action": body.action, "is_unlocked": drawer.is_unlocked()}
  ```
- **MIRROR**: NEW_DEVICE_ENDPOINT.
- **IMPORTS**: already added.
- **GOTCHA**: `drawer.is_unlocked()` returns the cached state — synchronous, safe to call after the to_thread finishes.
- **VALIDATE**: Cycle through `unlock` then `lock`. After each, `GET /api/device/status` reflects `is_unlocked` correctly (after Task 13).

### Task 6: New endpoint — `GET /api/device/snapshot?cam=`
- **ACTION**: Add to `backend/api/device.py`.
- **IMPLEMENT**:
  ```python
  from fastapi import Response

  @router.get("/snapshot")
  async def camera_snapshot(
      request: Request,
      cam: int = Query(..., ge=0, le=1, description="0=tray, 1=intake"),
  ):
      """Single JPEG frame from the requested camera. No streaming.

      Reuses the cycle's already-open camera (RpicamSource fan-out).
      Snapshot quality is fixed at 80 to keep the payload small.
      """
      loop = _get_loop(request)
      if loop is None:
          raise HTTPException(status_code=503, detail="Headless mode — no cameras")
      state = getattr(loop, "_state", None)
      cam_obj = getattr(state, "cam_a" if cam == 0 else "cam_b", None) if state else None
      if cam_obj is None:
          raise HTTPException(status_code=503, detail=f"cam_{cam} not open")
      if not hasattr(cam_obj, "latest_frame_jpeg"):
          raise HTTPException(status_code=501, detail="Camera backend lacks latest_frame_jpeg")
      jpeg = await asyncio.to_thread(cam_obj.latest_frame_jpeg, 80)
      if jpeg is None:
          raise HTTPException(status_code=503, detail="No frame available yet")
      return Response(content=jpeg, media_type="image/jpeg")
  ```
- **MIRROR**: CAMERA_SNAPSHOT.
- **IMPORTS**: `from fastapi import Response` — add to existing fastapi import line.
- **GOTCHA**: Auth header X-Device-API-Key is required, BUT browser `<img>` cannot set headers. Snapshot is meant to be requested via fetch (with auth) → blob → object URL. Document in the device.ts client.
- **VALIDATE**: `curl -H "X-Device-API-Key: <key>" -o /tmp/test.jpg "http://<pi>/api/device/snapshot?cam=0"` produces a valid JPEG (`file /tmp/test.jpg` reports JPEG image data).

### Task 7: New endpoint — `GET /api/device/logs`
- **ACTION**: Add to `backend/api/device.py`.
- **IMPLEMENT**:
  ```python
  from core.log_ring import get_ring

  @router.get("/logs")
  async def recent_logs(n: int = Query(default=200, ge=1, le=500)):
      """Last N log records from the in-memory ring buffer (newest first)."""
      ring = get_ring()
      if ring is None:
          return {"records": [], "note": "ring buffer not installed"}
      return {"records": ring.snapshot(n)}
  ```
- **MIRROR**: NEW_DEVICE_ENDPOINT.
- **IMPORTS**: add `from core.log_ring import get_ring`.
- **GOTCHA**: Endpoint does NOT require a loop — works in headless mode too. Don't gate on `_get_loop()`.
- **VALIDATE**: After server boot, `curl ... /api/device/logs?n=20` returns ≥ a few records (uvicorn startup, hardware init).

### Task 8: New endpoint — `POST /api/agent/flags/detect`
- **ACTION**: Edit `backend/api/agent.py` (NOT `backend/api/flags.py` — that's the CRUD-on-a-flag router; this one runs the detector).
- **IMPLEMENT**:
  ```python
  from services.flag_detector import detect_and_persist_flags

  @router.post("/flags/detect")
  async def trigger_flag_detection():
      """Run the heuristic + Gemini flag-detection pipeline now."""
      result = await detect_and_persist_flags()
      return {
          "ok": True,
          "new_count": result.get("new_count", 0),
          "by_kind": result.get("by_kind", {}),
          "gemini_used": result.get("gemini_used", False),
      }
  ```
  Mount path note: agent.py's router is mounted at `/api/agent`, so this surfaces as `POST /api/agent/flags/detect`.
- **MIRROR**: existing brief endpoint in agent.py.
- **IMPORTS**: `from services.flag_detector import detect_and_persist_flags`.
- **GOTCHA**: Two back-to-back manual calls within the same minute will mostly insert zero new flags (open-fingerprint dedup). That's correct; report `new_count: 0` and let the UI say "no new flags".
- **VALIDATE**: `curl -X POST -H "X-Device-API-Key: <key>" .../api/agent/flags/detect` returns the summary; FlagsPanel SWR refresh picks up new rows on its 30 s tick.

### Task 9: Frontend — extend `lib/device.ts`
- **ACTION**: Add new client functions following the `{ok, status}` envelope pattern.
- **IMPLEMENT**:
  ```ts
  export type EjectResult = { ok: boolean; status: number; latency_ms?: number; error?: string };
  export type DrawerAction = "lock" | "unlock";
  export type DrawerResult = { ok: boolean; status: number; is_unlocked?: boolean; error?: string };

  export async function manualEject(slot: number): Promise<EjectResult> {
    if (!isDeviceConfigured()) return { ok: false, status: 0 };
    try {
      const r = await fetch(`${baseUrl}/api/device/eject`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      const data = r.ok ? await r.json() : null;
      return {
        ok: r.ok,
        status: r.status,
        latency_ms: data?.latency_ms,
        error: r.ok ? undefined : await safeError(r),
      };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  export async function setDrawer(action: DrawerAction): Promise<DrawerResult> {
    if (!isDeviceConfigured()) return { ok: false, status: 0 };
    try {
      const r = await fetch(`${baseUrl}/api/device/drawer`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = r.ok ? await r.json() : null;
      return {
        ok: r.ok,
        status: r.status,
        is_unlocked: data?.is_unlocked,
        error: r.ok ? undefined : await safeError(r),
      };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  export async function fetchSnapshot(cam: 0 | 1): Promise<string | null> {
    if (!isDeviceConfigured()) return null;
    try {
      const r = await fetch(`${baseUrl}/api/device/snapshot?cam=${cam}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      if (!r.ok) return null;
      const blob = await r.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  export type LogRecord = { ts: number; level: string; name: string; message: string };

  export async function fetchPiLogs(n: number = 200): Promise<LogRecord[]> {
    if (!isDeviceConfigured()) return [];
    try {
      const r = await fetch(`${baseUrl}/api/device/logs?n=${n}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { records: LogRecord[] };
      return j.records ?? [];
    } catch {
      return [];
    }
  }

  async function safeError(r: Response): Promise<string> {
    try {
      const j = await r.json();
      return typeof j?.detail === "string" ? j.detail : JSON.stringify(j);
    } catch {
      return r.statusText || "unknown";
    }
  }
  ```
  Also extend `DeviceStatus` type (Task 13 adds `is_unlocked` server-side):
  ```ts
  export type DeviceStatus = {
    headless: boolean;
    hardware_stubbed: boolean;
    cycle_n: number;
    last_cycle: LastCycleSummary | null;
    task_running: boolean;
    is_unlocked: boolean;
  };
  ```
- **MIRROR**: FRONTEND_DEVICE_CALL.
- **IMPORTS**: existing — no new ones.
- **GOTCHA**: `fetchSnapshot` returns an object URL. Caller must `URL.revokeObjectURL(prevUrl)` before assigning a new one to avoid leaking blobs.
- **VALIDATE**: `npx tsc --noEmit` — zero errors.

### Task 10: Frontend — extend `lib/agent.ts` for flag detection trigger
- **ACTION**: Add `triggerFlagDetection`. Lives in agent.ts because the endpoint is under /api/agent/.
- **IMPLEMENT**:
  ```ts
  export type FlagDetectionResult = {
    ok: boolean;
    new_count: number;
    by_kind: Record<string, number>;
    gemini_used: boolean;
  };

  export async function triggerFlagDetection(): Promise<FlagDetectionResult | null> {
    if (!isAgentConfigured()) return null;
    try {
      const r = await fetch(`${baseUrl}/api/agent/flags/detect`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!r.ok) return null;
      return (await r.json()) as FlagDetectionResult;
    } catch {
      return null;
    }
  }
  ```
- **MIRROR**: existing `refreshBrief` function.
- **IMPORTS**: existing.
- **VALIDATE**: tsc clean.

### Task 11: Frontend — `/admin` page
- **ACTION**: New file `frontend/src/app/admin/page.tsx`. Compose 4 sections inside cards.
- **IMPLEMENT** (skeleton — flesh out card chrome per CARD_CHROME):
  ```tsx
  "use client";

  import { useEffect, useRef, useState } from "react";
  import { useSWRConfig } from "swr";
  import {
    fetchDeviceStatus,
    fetchPiLogs,
    fetchSnapshot,
    isDeviceConfigured,
    manualEject,
    resetDevice,
    setDrawer,
    triggerDispense,
    type DeviceStatus,
    type LogRecord,
  } from "@/lib/device";
  import { refreshBrief, triggerFlagDetection } from "@/lib/agent";
  import { KEYS } from "@/lib/swr";

  export default function AdminPage() {
    const { mutate } = useSWRConfig();
    const [status, setStatus] = useState<DeviceStatus | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const [snap, setSnap] = useState<{ cam: 0 | 1; url: string } | null>(null);
    const [logs, setLogs] = useState<LogRecord[]>([]);
    const prevSnapUrl = useRef<string | null>(null);
    const configured = isDeviceConfigured();

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

    useEffect(() => {
      if (!configured) return;
      let alive = true;
      async function tick() {
        const r = await fetchPiLogs(200);
        if (alive) setLogs(r);
      }
      tick();
      const id = setInterval(tick, 2000);
      return () => { alive = false; clearInterval(id); };
    }, [configured]);

    async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
      setBusy(label);
      setMsg(null);
      try {
        return await fn();
      } finally {
        setBusy(null);
      }
    }

    async function onReset() {
      if (!confirm("Reset the hardware loop? This stops + restarts the dispense cycle.")) return;
      const r = await withBusy("reset", resetDevice);
      setMsg(r.ok ? "Loop reset." : `Reset failed: ${r.status}`);
    }

    async function onDispense() {
      const r = await withBusy("dispense", triggerDispense);
      setMsg(r.ok ? "Dispense queued." : `Dispense failed: ${r.status}`);
    }

    async function onEject(slot: number) {
      const r = await withBusy(`eject-${slot}`, () => manualEject(slot));
      setMsg(r.ok ? `Slot ${slot} ejected (${r.latency_ms} ms).` : `Eject failed: ${r.error ?? r.status}`);
    }

    async function onDrawer(action: "lock" | "unlock") {
      const r = await withBusy(`drawer-${action}`, () => setDrawer(action));
      setMsg(r.ok ? `Drawer ${action}ed.` : `Drawer ${action} failed: ${r.error ?? r.status}`);
    }

    async function onSnapshot(cam: 0 | 1) {
      if (prevSnapUrl.current) URL.revokeObjectURL(prevSnapUrl.current);
      const url = await withBusy(`snap-${cam}`, () => fetchSnapshot(cam));
      if (url) {
        prevSnapUrl.current = url;
        setSnap({ cam, url });
      } else {
        setMsg("Snapshot failed.");
      }
    }

    async function onBrief() {
      try {
        await withBusy("brief", () => refreshBrief("on_demand"));
        await mutate(KEYS.brief);
        setMsg("Brief generated.");
      } catch (e) {
        setMsg(e instanceof Error ? `Brief failed: ${e.message}` : "Brief failed.");
      }
    }

    async function onDetect() {
      const r = await withBusy("detect", triggerFlagDetection);
      if (r) {
        await mutate(KEYS.flags);
        setMsg(`Detection: ${r.new_count} new flag(s).`);
      } else {
        setMsg("Detection failed.");
      }
    }

    function onRefreshCaches() {
      mutate(KEYS.slots);
      mutate(KEYS.logs);
      mutate(KEYS.patients);
      setMsg("Inventory caches refreshed.");
    }

    // Render sections (CARD_CHROME × 4) + scrollable log tail with newest-first list.
    return (/* see CARD_CHROME pattern */);
  }
  ```
- **MIRROR**: CARD_CHROME, FRONTEND_DEVICE_CALL, status polling pattern from `/dispensers/[id]/page.tsx:35-53`.
- **IMPORTS**: as shown.
- **GOTCHA**: revoke previous snapshot URL on every new snap to avoid blob leaks.
- **GOTCHA**: `confirm()` is fine for the reset confirmation (project's no-modal-library philosophy). Don't add a custom modal.
- **GOTCHA**: Status bar reads `status.task_running`, `status.cycle_n`, `status.hardware_stubbed`, `status.last_cycle?.t_total_ms`, and `status.is_unlocked` (after Task 13). Render a small drawer-state pill in the Hardware section.
- **GOTCHA**: When `configured` is false, render a banner and disable all buttons (mirror `/dispensers/[id]/page.tsx:113-119`).
- **VALIDATE**: tsc clean. Build adds < 8 kB to the new `/admin` route. Manual click-through covers every button.

### Task 12: Frontend — Navbar item
- **ACTION**: Edit `frontend/src/components/Navbar.tsx`. Append `{ label: "Admin", href: "/admin" }` to the NAV_ITEMS array.
- **MIRROR**: NAV_ITEM (existing pattern).
- **VALIDATE**: Visual — click "Admin" navigates to `/admin`.

### Task 13: Wire `is_unlocked` into the existing `/api/device/status` payload
- **ACTION**: Edit `backend/api/device.py:38-50`. Add `is_unlocked` to the JSON returned by `device_status`. Both branches (loop is None → `is_unlocked: false`; loop running → read from `loop._state.drawer.is_unlocked()`).
- **IMPLEMENT**:
  ```python
  if loop is None:
      return {
          "headless": True,
          "hardware_stubbed": True,
          "cycle_n": 0,
          "last_cycle": None,
          "task_running": False,
          "is_unlocked": False,
      }
  base = loop.status()
  state = getattr(loop, "_state", None)
  drawer = getattr(state, "drawer", None) if state else None
  base["is_unlocked"] = bool(drawer.is_unlocked()) if drawer else False
  return base
  ```
- **MIRROR**: existing /status.
- **GOTCHA**: Update `frontend/src/lib/device.ts` — extend `DeviceStatus` type (done in Task 9).
- **VALIDATE**: `curl ... /api/device/status` includes `is_unlocked`. Frontend `DeviceStatus` consumers compile.

---

## Testing Strategy

No unit-test framework configured (per CLAUDE.md). Manual testing only.

### Manual Test Matrix

| Scenario | Setup | Expected |
|---|---|---|
| Backend smoke (headless dev mac) | `make backend` (PHARMGUARD_STUB=1) | `/api/device/logs` returns recent records; `/eject` and `/drawer` return 503 (headless); `/snapshot` returns 503; `/api/agent/flags/detect` returns `{new_count: 0, ...}` |
| /admin loads in dev mode | `make dev`, env unset | All buttons disabled with "Set NEXT_PUBLIC_DEVICE_URL ..." banner |
| /admin loads with device configured | `make dev` + valid env | Status bar live, all sections render, Reset confirmation prompt appears |
| Manual eject slot 0 | Pi running, slot 0 has a med | Magazine rotates, ejector pushes once, `latency_ms` reported in toast |
| Manual eject during cycle | Trigger eject mid-cycle | Eject blocks until cycle's dispense completes (lock fairness); no GPIO error |
| Drawer lock/unlock | Pi running | Drawer servo audibly moves; status pill flips; cycle's auto-relock still works |
| Camera snapshot cam 0 | Pi running, picamera2 streaming | Inline JPEG renders inside the Hardware section; "Cam 0" button taken twice replaces image |
| Snapshot blob cleanup | Take 5 snapshots | DevTools memory: blob count stays at 1 (revokeObjectURL works) |
| Pi logs tail | Pi running for ≥ 1 min | List shows ≥ 1 record per second of activity, newest on top |
| Brief now | Pi running, agent configured | Toast "Brief generated"; FlagsPanel + BriefCard refresh on dashboard |
| Flag detection (no anomalies) | All adherence good | Toast "Detection: 0 new flag(s)"; FlagsPanel unchanged |
| Flag detection (anomalies present) | Seed missed-streak via SQL | Toast reports new count; FlagsPanel shows them on dashboard within 30 s |
| Refresh caches | Click Refresh inventory | Slots/logs/patients SWR keys invalidate; UI updates |
| Reset loop | Cycle running | Confirmation prompt → loop stops → starts → cycle_n resets to 0 |
| Concurrent ops | Click eject + drawer + dispense in quick succession | All complete in order, no error, lock fairness preserved |

### Edge Cases Checklist
- [ ] Headless mode → all hardware endpoints 503 with clear message
- [ ] Cycle in mid-dispense when manual op fires → manual op queues
- [ ] `is_unlocked()` while drawer is mid-move → returns last-set state (acceptable)
- [ ] Camera not yet open (cycle hasn't started) → 503 with "no frame available"
- [ ] Flag detection fails (Gemini quota etc.) → endpoint catches + returns `gemini_used: false`
- [ ] User opens `/admin` with stale env → status fetch returns null, banner explains
- [ ] Log buffer empty (just booted) → endpoint returns `{records: []}` with no note
- [ ] Snapshot blob URL not revoked on page navigation → minor browser leak; document, do NOT add a global cleanup hook
- [ ] X-Device-API-Key wrong → 401 from FastAPI; UI shows error toast

---

## Validation Commands

### Static Analysis
```bash
cd frontend && npx tsc --noEmit
```
EXPECT: Zero type errors.

### Backend smoke (no Pi required)
```bash
cd backend && PHARMGUARD_STUB=1 python -m uvicorn main:app --port 8000 &
sleep 3
curl -H "X-Device-API-Key: $KEY" http://localhost:8000/api/device/status
curl -H "X-Device-API-Key: $KEY" http://localhost:8000/api/device/logs?n=10
curl -X POST -H "X-Device-API-Key: $KEY" http://localhost:8000/api/agent/flags/detect
kill %1
```
EXPECT: status returns headless payload incl. `is_unlocked`; logs returns ring records; flag detect returns `{ok:true, new_count:0, ...}`.

### Build Check
```bash
cd frontend && npm run build
```
EXPECT: ✓ Compiled successfully. New `/admin` route appears in the route table.

### Browser Validation (full Pi)
```bash
make pi-sync HOST=pi@<host> && ssh pi@<host> sudo systemctl restart pharmguard
make frontend
# Navigate to http://localhost:3000/admin
```
EXPECT:
- Status bar reflects live cycle_n, loop=running, hardware=real
- Click Reset → confirm → cycle_n flips back
- Each slot button 0–9 ejects with audible servo movement
- Drawer Lock / Unlock both work; status pill updates
- Cam 0/1 snapshot buttons render an inline JPEG
- Brief now / Flag detection now produce toasts
- Logs panel scrolls with new records as the Pi runs

### Manual Validation Checklist
- [ ] All buttons disabled when env unset
- [ ] Confirmation dialog on Reset only
- [ ] No console errors on a clean page load
- [ ] Snapshot replaces (not stacks) on consecutive clicks
- [ ] Bundle delta < 8 kB on `/admin` route

---

## Acceptance Criteria
- [ ] `/admin` page renders 4 sections (System, Hardware, Operations, Logs).
- [ ] All 11 buttons map to working backend endpoints.
- [ ] Cycle loop and manual ops serialise via `app.state.hardware_lock`.
- [ ] Logs panel shows ≥ 200 in-memory records, newest first.
- [ ] Camera snapshots render inline; no blob leak.
- [ ] Status bar reflects `is_unlocked` correctly.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run build` passes; bundle delta < 8 kB.

## Completion Checklist
- [ ] Card chrome `rounded-2xl border border-sand-200 bg-white p-6` on every section.
- [ ] All hardware ops use `asyncio.to_thread`.
- [ ] All hardware ops acquire `app.state.hardware_lock`.
- [ ] X-Device-API-Key gate intact on every new endpoint.
- [ ] No emojis in source.
- [ ] No new dependencies in `requirements.txt` or `package.json`.
- [ ] `lib/device.ts` follows the existing `{ok, status}` envelope.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `cycle_runner.py` lock placement misses an existing GPIO call | Medium | GPIO collision under concurrent ops | Audit ALL `to_thread` calls touching `magazine`/`ejector`/`drawer` in cycle_runner; bring them under the lock (Task 3). |
| Logging handler emits records faster than deque can rotate (high-volume burst) | Low | Some records dropped from buffer | maxlen=500 + lock-protected `appendleft` is fine for real PharmGuard log rate (≤ 1 record / 50 ms). Monitor; raise maxlen if needed. |
| `<img>` won't load snapshot due to header auth | High (unmitigated) | Snapshot button broken in browser | `fetchSnapshot` uses `fetch` + `URL.createObjectURL` — header auth works, blob URL feeds `<img>` (Task 9). |
| Operator hits "Reset" mid-dispense | Medium | Drops a pill mid-flight | Reset confirmation dialog (Task 11) is the user's last chance. Cycle's `hold_unlocked` already guards drawer state on stop. |
| Flag-detect endpoint races with scheduled run | Low | Both insert; dedup index handles it | `agent_flags_open_fingerprint_uniq` rejects duplicates with 23505 → flag_detector treats as no-op. Already handled. |
| ngrok URL rotation breaks `/admin` until env updated | High | Buttons fail | Same as `/dispensers/[id]` today — operator must update `NEXT_PUBLIC_DEVICE_URL`. Documented. |
| Browser tab idle → snapshot blob URL still alive | Low | Memory leak (~50 kB per snapshot) | Acceptable; revoke on next snapshot. Not a per-tab concern. |

## Notes
- Once `/admin` ships, BriefCard's existing "Refresh" button arguably duplicates `/admin > Operations > Generate brief now`. Don't remove BriefCard's button — different surface (dashboard panel vs admin tab). Both call the same endpoint.
- Future work that this plan deliberately does NOT touch:
  - journalctl integration (covers crashes / pre-uvicorn output)
  - log-level filtering, search, download
  - per-camera FPS in snapshot (optional `?quality=` in current plan)
  - per-button audit trail (who/when)
  - role-based perms (admin vs operator)
- The `app.state.hardware_lock` becomes the canonical hardware mutex once this lands. Future hardware operations (rotate-to-home, calibrate, etc.) MUST acquire it.
