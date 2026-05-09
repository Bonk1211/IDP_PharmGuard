# Plan: Pi-hosted FastAPI backend (collapse `edge_pi/` into `backend/`)

## Summary
Collapse the 3-tier topology (`backend/` + `edge_pi/` + `frontend/`) into 2 tiers by hosting the FastAPI backend ON the Raspberry Pi alongside the existing hardware/vision code, with the dispense cycle running as an asyncio background task inside the same uvicorn process. Frontend keeps reading Supabase directly; new control actions (Dispense Now, status) reach the Pi via a free-tier ngrok tunnel. The `edge_pi/` tree is deleted entirely.

## User Story
As a **PharmGuard operator**, I want **one process on the Pi that serves the API, runs the hardware loop, and is reachable from the dashboard via ngrok**, so that **I have one log stream, one systemd unit, no self-HTTP latency, and the dashboard can trigger an on-demand dispense**.

## Problem → Solution
**Current state**: `edge_pi/main.py` polls `backend/` over HTTP for the next dispense. `backend/` runs stateless somewhere else. The Pi authenticates faces by POSTing to its own backend server. Two requirements files, two systemd plans, two import roots.

**Desired state**: One repo-rooted `backend/` package on the Pi running uvicorn + asyncio supervisor. The cycle calls `services.face_recognition.compute_embedding` in-process. Frontend hits ngrok→Pi only for control actions (`/api/device/dispense_now`); reads still go direct to Supabase. `edge_pi/` no longer exists.

## Metadata
- **Complexity**: **XL** (~50 file moves, lifespan + asyncio supervisor, new auth path, frontend changes; 15 tasks)
- **Source PRD**: N/A — operator-driven refactor (not from `pharmguard.prd.md` phases).
- **PRD Phase**: N/A
- **Estimated Files**: ~50 moved, ~12 edited, ~6 created, 1 dir deleted
- **Reference repo**: `https://github.com/johnnytan5/medispecs-backend-specs` (flat layout: `main.py` + `routers/` + `services/` + hardware drivers at top level)
- **Locked decisions** (from `/multi-plan` clarifying Q&A):
  1. ONE FastAPI process; hardware loop = asyncio task via `lifespan`
  2. Frontend: Supabase direct for reads + ngrok→Pi for control
  3. Free-tier ngrok with rotating URL accepted
  4. Full merge — `edge_pi/` deleted

---

## UX Design

### Before
```
Caregiver dashboard (Next.js)
  Patient list      <- Supabase direct
  Inventory         <- Supabase direct
  (no on-demand controls)

Pi runs autonomously; only intervention is sysadmin
shelling in to restart pharmguard.service
```

### After
```
Caregiver dashboard (Next.js)
  Patient list      <- Supabase direct (unchanged)
  Inventory         <- Supabase direct (unchanged)

  Patient detail page:
    [ Dispense Now ]   <- new — POSTs ngrok->Pi
    Device status: idle | dispensing | error
    Last cycle: 2026-05-09 00:42  PASS  pill_taken=true

  Banner if env not set: "Set NEXT_PUBLIC_DEVICE_URL after Pi reboot"
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Dashboard -> Pi | none | "Dispense Now" button | Free-ngrok URL must be set in `frontend/.env.local` |
| Pi -> backend | self-HTTP for adherence + face verify | direct service-function calls | ~20 ms saved per cycle, removes a self-call hop |
| Pi systemd | `python main.py` (loop) | `uvicorn main:app` (loop is asyncio task in lifespan) | Workers MUST stay 1 |
| ngrok service | none | new `ngrok.service` ordered after pharmguard | Free tier rotates URL |
| Dev parity | `make backend` ran locally | `make backend BACKEND_HEADLESS=1` runs locally | Hardware lifespan skipped on dev-mac |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| **P0** | `edge_pi/main.py` | 254-419 | The `run()` function — body becomes `scheduler/cycle_runner.py:run_cycle`. HI-012 stub guard at 295-316 is load-bearing. |
| **P0** | `backend/app/api/inventory.py` | 1-103 | Canonical APIRouter shape: `Depends(verify_device_token)` + `get_supabase()` + `HTTPException`. New `device.py` mirrors this structure. |
| **P0** | `backend/app/core/security.py` | 1-51 | `verify_device_token` is the auth pattern. The new `verify_device_api_key` mirrors it but reads `X-Device-API-Key` and matches one secret. |
| **P0** | `edge_pi/config.py` | 1-153 | Frozen-dataclass + `_LazySettings` proxy + `_require()` — to be merged into `backend/config.py` reconciled with pydantic-settings naming. |
| **P0** | `backend/app/core/config.py` | 1-26 | `pydantic-settings` pattern. Merged config keeps this file as the base, adds the `_require`-equivalent invariants in `validate_runtime()`. |
| **P0** | `edge_pi/main.py` | 80-225 | `report_intake`, `report_temperature`, `_replay_drain` — these become **direct DB writes** in cycle_runner, NOT self-HTTP. The 2-phase commit + HI-012 defensive guard at 184-196 must be preserved. |
| **P1** | `backend/app/api/logs.py` | 1-89 | Reference for the direct-write port: see `create_log` body at 26-51 — that body is what `cycle_runner.report_intake_direct` calls instead of POSTing. |
| **P1** | `backend/app/services/face_recognition.py` | 1-71 | `compute_embedding` is what cycle_runner calls instead of POST `/api/auth/verify-face`. |
| **P1** | `backend/app/db/base.py` | 1-15 | `get_supabase()` singleton. Cycle code uses this directly. |
| **P1** | `edge_pi/storage/queue.py` | 1-80 | OfflineQueue — survives the move with import path renames only. |
| **P1** | `edge_pi/scripts/pharmguard.service` | 1-50 | Hardened systemd unit. Update ExecStart only — keep all the security/resource directives. |
| **P1** | `edge_pi/tests/conftest.py` | 1-79 | `stub_env`/`prod_env`/`gpio_mock`/`no_sleep` fixtures. Move with import path renames; the `EDGE_PI_ROOT` symbol becomes `BACKEND_ROOT`. |
| **P2** | `backend/app/main.py` | 1-31 | Existing FastAPI bootstrap. Lifespan + `device` router get added; CORS origin stays `localhost:3000`. |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| FastAPI lifespan with background tasks | `https://fastapi.tiangolo.com/advanced/events/#lifespan` | `@asynccontextmanager`; create_task on enter, cancel + await on exit. Use `app.state.<x>` for handle. |
| `asyncio.to_thread` for blocking I/O | `https://docs.python.org/3.12/library/asyncio-task.html#asyncio.to_thread` | All GPIO + cv2 + face_recognition calls inside `run_cycle` MUST be wrapped — they block the event loop otherwise. |
| ngrok agent on Linux | `https://ngrok.com/docs/agent/linux/` | `ngrok config add-authtoken <T>`; run via systemd. Free tier: `ngrok http 8000` returns a `https://*.ngrok-free.app` host that rotates per agent restart. |
| Uvicorn workers + GPIO | reasoning, not docs | Multi-worker forks Python — `RPi.GPIO` / `lgpio` / picamera2 hold per-process state. **Workers > 1 corrupts hardware.** |

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: backend/app/core/config.py:6-19  (lower_snake attrs, BaseSettings)
class Settings(BaseSettings):
    supabase_url: str = ""
    supabase_key: str = ""
    secret_key: str = "dev-secret-change-in-production"
    expiry_warn_days: int = 14
    over_temp_celsius: float = 30.0

    model_config = {"env_file": ".env"}

# SOURCE: edge_pi/config.py:42-60  (UPPER_SNAKE attrs, frozen dataclass)
@dataclass(frozen=True)
class _Settings:
    BACKEND_URL: str
    DEVICE_TOKEN: str
    POLL_INTERVAL_S: float
    STUB_MODE: bool

# DECISION for merged backend/config.py:
# Keep BaseSettings + lower_snake attrs (backend wins because it has more
# downstream consumers and pydantic-settings handles validation). Cycle code
# is updated to use settings.poll_interval_s, settings.dispenser_id, etc.
```

### ROUTER_PATTERN
```python
# SOURCE: backend/app/api/inventory.py:1-30
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.security import verify_device_token
from app.db.base import get_supabase

router = APIRouter()

class SlotUpdate(BaseModel):
    medication_name: str
    quantity: int

@router.get("/", dependencies=[Depends(verify_device_token)])
async def list_slots():
    sb = get_supabase()
    result = sb.table("medications").select("*").order("slot").execute()
    return result.data
```

After flattening, the imports become `from core.security import ...` and `from db.base import ...` (drop the `app.` prefix).

### AUTH_DEPENDENCY
```python
# SOURCE: backend/app/core/security.py:32-50
_bearer_scheme = HTTPBearer(auto_error=True)

async def verify_device_token(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> str:
    valid_tokens = settings.device_tokens_set
    if not valid_tokens:
        raise HTTPException(status_code=503, detail="Device auth not configured")

    candidate = credentials.credentials
    for token in valid_tokens:
        if hmac.compare_digest(candidate, token):
            return token
    raise HTTPException(status_code=401, detail="Invalid device token")
```

The new `verify_device_api_key` follows the same shape — read header, `hmac.compare_digest` against one secret, fail-closed when key not configured.

### SERVICE_PATTERN (lazy heavy imports)
```python
# SOURCE: backend/app/services/face_recognition.py:17-30
def compute_embedding(image_bytes: bytes) -> list[float] | None:
    try:
        import face_recognition  # heavy; lazy
        import numpy as np
        from PIL import Image
    except ImportError:
        log.exception("face_recognition import failed")
        return None
    ...
```

`scheduler/cycle_runner.py` calls these via `await asyncio.to_thread(compute_embedding, crop_bytes)` so the heavy import + dlib inference don't block the FastAPI event loop.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/main.py:27-31  (project-wide)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# Usage idioms in this codebase:
log.info("Cycle complete — pill_taken=%s", pill_taken_actual)
log.warning("Authentication failed (%d): %s", resp.status_code, resp.text)
log.exception("Camera initialization failed")  # auto-includes traceback
log.error("Hardware degraded but PHARMGUARD_STUB unset; refusing to run")
```

`%`-style format args, not f-strings — keeps the log record's `args` tuple intact for downstream parsing.

### HI-012_STUB_GUARD (load-bearing — copy verbatim)
```python
# SOURCE: edge_pi/main.py:295-316
hardware_stubbed = (
    magazine.is_stub
    or ejector.is_stub
    or diverter.is_stub
    or drawer_lock.is_stub
    or temp_sensor.is_stub
)
if hardware_stubbed:
    if not settings.STUB_MODE:           # <-- becomes settings.pharmguard_stub
        log.error(
            "Hardware initialization degraded ... but PHARMGUARD_STUB is not set. "
            "Refusing to run — telemetry would be falsified.",
            ...
        )
        sys.exit(1)
    log.warning(
        "STUB MODE: hardware not real — pill_taken will always be reported "
        "False. DO NOT use this build in production."
    )
```

In the merged design, `sys.exit(1)` becomes `raise RuntimeError(...)` from inside the lifespan handler so FastAPI startup fails cleanly. The HardwareLoop supervisor must NOT swallow this RuntimeError.

### TWO_PHASE_COMMIT (replay safety)
```python
# SOURCE: edge_pi/main.py:108-126  + storage/queue.py
row_id = offline_queue.enqueue("intake", payload, is_stub=is_stub)
try:
    resp = session.post(f"{BACKEND_URL}/api/logs/", json=payload, timeout=10)
    if 200 <= resp.status_code < 300:
        offline_queue.mark_sent([row_id])
    else:
        log.warning("intake post non-2xx (%d); row %d retained", resp.status_code, row_id)
except requests.RequestException as exc:
    log.warning("intake post failed: %s; row %d retained", exc, row_id)
```

After merge, "POST" becomes "DB INSERT". Same 2-phase shape: `enqueue → INSERT into Supabase → mark_sent` on success. The `try/except` catches Supabase exceptions instead of `requests.RequestException`. The HI-012 defensive replay guard at `edge_pi/main.py:184-196` ports verbatim.

### TEST_STRUCTURE
```python
# SOURCE: edge_pi/tests/conftest.py:35-79
@pytest.fixture
def stub_env(monkeypatch):
    monkeypatch.setenv("PHARMGUARD_STUB", "1")
    _reload_hardware_modules()
    yield
    _reload_hardware_modules()

@pytest.fixture
def gpio_mock(monkeypatch):
    fake = MagicMock(); fake.BCM="BCM"; fake.OUT="OUT"; fake.HIGH=1; fake.LOW=0
    fake.PWM.return_value = MagicMock()
    monkeypatch.setitem(sys.modules, "RPi", MagicMock(GPIO=fake))
    monkeypatch.setitem(sys.modules, "RPi.GPIO", fake)
    return fake
```

Test files move from `edge_pi/tests/` to `backend/tests/`. The `EDGE_PI_ROOT` constant in conftest.py becomes `BACKEND_ROOT`. Test imports stay `from hardware.x import Y` (because `backend/` becomes the sys.path root, same as `edge_pi/` was before).

### SYSTEMD_UNIT (preserve all hardening)
```ini
# SOURCE: edge_pi/scripts/pharmguard.service:1-50
# Update ONLY ExecStart and WorkingDirectory:
WorkingDirectory=__INSTALL_DIR__              # was edge_pi/, becomes backend/
ExecStart=__INSTALL_DIR__/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
# Keep ALL of:  Restart, StartLimitBurst, NoNewPrivileges, ProtectSystem,
#               ReadWritePaths, MemoryHigh, MemoryMax, CPUQuota, etc.
```

---

## Files to Change

### Phase A — moves (preserves git history; no logic edits)

| File / tree | Action | Justification |
|---|---|---|
| `edge_pi/hardware/` (whole tree, 6 .py files) | `git mv` -> `backend/hardware/` | Hardware drivers + their `test_*.py` benches |
| `edge_pi/vision/` | `git mv` -> `backend/vision/` | Camera + pill_verifier + intake_monitor + liveness |
| `edge_pi/storage/` | `git mv` -> `backend/storage/` | OfflineQueue |
| `edge_pi/scripts/` | `git mv` -> `backend/scripts/` | install.sh, pharmguard.service, bench_*.py, journald conf |
| `edge_pi/tests/` | `git mv` -> `backend/tests/` | Replaces empty `backend/tests/` (none currently) |
| `edge_pi/models/` | `git mv` -> `backend/models/` | YOLO weights (~37 MB tracked) |
| `backend/app/api/` | `git mv` -> `backend/api/` | Drop `app/` layer (mirror medispecs flat) |
| `backend/app/services/` | `git mv` -> `backend/services/` | Same |
| `backend/app/db/` | `git mv` -> `backend/db/` | Same |
| `backend/app/core/` | `git mv` -> `backend/core/` | Same |
| `backend/app/main.py` | `git mv` -> `backend/main.py` | Lifespan added in Phase C |

### Phase B — creates

| File | Action | Justification |
|---|---|---|
| `backend/config.py` | CREATE | Replace `backend/app/core/config.py` AND `edge_pi/config.py` with one merged Settings |
| `backend/scheduler/__init__.py` | CREATE | New package |
| `backend/scheduler/cycle_runner.py` | CREATE | Async port of `edge_pi/main.py:run()` body |
| `backend/scheduler/background.py` | CREATE | HardwareLoop supervisor (asyncio.Task lifecycle) |
| `backend/api/device.py` | CREATE | New router: dispense_now / status / reset |
| `backend/scripts/ngrok.service` | CREATE | systemd unit for the tunnel |
| `frontend/src/lib/device.ts` | CREATE | Typed Pi client (X-Device-API-Key header) |

### Phase C — edits

| File | Action | Justification |
|---|---|---|
| `backend/main.py` | UPDATE | Add `lifespan` + new `device` router include |
| `backend/api/{auth,inventory,logs,alerts}.py` | UPDATE | Drop `from app.` prefix -> `from core.security`, `from db.base`, etc. |
| `backend/services/{face_recognition,gemini_fallback}.py` | UPDATE | Same prefix drop |
| `backend/db/base.py` | UPDATE | Same |
| `backend/core/security.py` | UPDATE | Same; ADD `verify_device_api_key` dependency |
| `backend/{hardware,vision,storage}/*.py` | UPDATE (minor) | None of them import `app.*`; only need to confirm their absolute imports (`from hardware.x import Y`) still resolve — they will, since `backend/` becomes the sys.path root |
| `backend/scripts/pharmguard.service` | UPDATE | ExecStart -> uvicorn; WorkingDirectory -> backend |
| `backend/scripts/install.sh` | UPDATE | Reference paths under backend/; install both pharmguard.service + ngrok.service; prompt for ngrok authtoken |
| `backend/requirements.txt` | UPDATE | Union of both manifests with `; platform_machine=='aarch64'` markers on Pi-only deps |
| `backend/.env.example` | UPDATE | Merged keys; drop `BACKEND_URL`+`DEVICE_TOKEN`; add `DEVICE_API_KEY`+`BACKEND_HEADLESS` |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATE | Add Dispense Now button + status display |
| `frontend/.env.local.example` | UPDATE | `NEXT_PUBLIC_DEVICE_URL` + `NEXT_PUBLIC_DEVICE_API_KEY` |
| `Makefile` | UPDATE | Drop `pi-models`, `pi-sync`, `pi-bootstrap`; repoint `backend` target |
| `CLAUDE.md` | UPDATE | Rewrite "System overview" -> 2-tier |
| `README.md`, `HARDWARE_WIRING.md` | UPDATE | Repoint paths from `edge_pi/...` to `backend/...` |

### Phase D — deletes

| File | Action | Justification |
|---|---|---|
| `edge_pi/` (entire tree) | `git rm -r` | Locked decision; everything under it is moved or replaced |
| `backend/app/` (after moves drain it) | `rmdir` | Empty after Phase A |

## NOT Building

- Cloudflare Tunnel migration (deferred — free ngrok stays).
- Supabase Edge Function proxy for hardening `NEXT_PUBLIC_DEVICE_API_KEY` (still browser-readable).
- Multi-worker uvicorn (mandatorily single-worker because of GPIO state).
- Cron/webhook-triggered cycle (rejected at Q&A — autonomous adherence required).
- E2E playwright tests for `/api/device/*` (manual smoke only in Task 15).
- New Supabase migrations (schema unchanged).
- Replacing the existing `verify_device_token` on `/api/inventory/*`, `/api/logs/*`, `/api/auth/verify-face` — those endpoints stay and keep their bearer-token auth (legacy path; cycle runs in-process now and bypasses them).

---

## Step-by-Step Tasks

### Task 1: Branch + safety net
- **ACTION**: `git checkout -b feat/pi-hosted-backend && git tag pre-merge-snapshot`
- **IMPLEMENT**: One-shot bash; no code changes.
- **VALIDATE**: `git tag -l pre-merge-snapshot` returns the tag name; `git status` shows clean tree.

### Task 2: Move hardware tree
- **ACTION**: `git mv edge_pi/hardware backend/hardware`
- **MIRROR**: N/A — pure rename.
- **GOTCHA**: macOS is case-insensitive — verify nothing under `backend/` already matches case-insensitively (`ls -d backend/[Hh]ardware`).
- **VALIDATE**:
  ```bash
  cd backend && python -c "from hardware.magazine import Magazine; print('OK')"
  python -m py_compile $(find backend/hardware -name '*.py')
  ```

### Task 3: Move vision / storage / scripts / tests / models trees
- **ACTION**: `git mv` each of `edge_pi/{vision,storage,scripts,tests,models}` to `backend/<same>`.
- **GOTCHA**: `backend/tests/` does NOT currently exist; `git mv edge_pi/tests backend/tests` works in one shot. (Confirmed by `find` above — no collision.)
- **VALIDATE**: `find backend/{vision,storage,scripts,tests,models} -type f | wc -l` returns the same count as the pre-move `find edge_pi/{vision,storage,scripts,tests,models}`.

### Task 4: Flatten `backend/app/` -> `backend/`
- **ACTION**: `git mv backend/app/api backend/api`; same for `services`, `db`, `core`. `git mv backend/app/main.py backend/main.py`. `rmdir backend/app` (must already be empty).
- **IMPLEMENT** the prefix rewrite in moved files:
  ```bash
  # From repo root:
  grep -RlE "from app\.|import app\." backend/ | xargs sed -i '' -E 's/from app\./from /g; s/import app\./import /g'
  ```
  (Use `sed -i` without `''` on Linux.)
- **MIRROR**: Confirm zero matches: `grep -RnE "from app\.|import app\." backend/` returns empty.
- **GOTCHA**: `backend/app/__init__.py` is empty; safe to delete with the directory.
- **VALIDATE**: `cd backend && BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 python -c "import main"` succeeds (with seeded `.env`).

### Task 5: Merge config (`backend/config.py`)
- **ACTION**: Create `backend/config.py` that unions both Settings.
- **IMPLEMENT**:
  ```python
  """Unified PharmGuard runtime configuration."""
  from pydantic_settings import BaseSettings
  from pathlib import Path
  import logging

  log = logging.getLogger(__name__)


  class Settings(BaseSettings):
      # ── from old backend/app/core/config.py ──
      supabase_url: str = ""
      supabase_key: str = ""
      secret_key: str = "dev-secret-change-in-production"
      gemini_api_key: str = ""
      device_tokens: str = ""                # legacy bearer tokens (still accepted)
      default_dispenser_id: str = "dispenser-001"
      face_match_tolerance: float = 0.6
      expiry_warn_days: int = 14
      low_stock_threshold: int = 3
      over_temp_celsius: float = 30.0

      # ── from old edge_pi/config.py ──
      poll_interval_s: float = 30.0
      pharmguard_stub: bool = False           # was STUB_MODE
      dispenser_id: str = ""
      bench_mode: bool = False
      bench_log_path: str = "/tmp/bench_e2e.csv"
      offline_queue_path: str = ""            # default below
      offline_max_age_seconds: float = 3600.0
      offline_replay_interval_s: float = 30.0

      # ── new (Pi-hosted refactor) ──
      device_api_key: str = ""                # frontend -> Pi via ngrok
      backend_headless: bool = False          # 1 = skip hardware lifespan (dev-mac)

      model_config = {"env_file": ".env", "extra": "ignore"}

      @property
      def device_tokens_set(self) -> set[str]:
          return {t.strip() for t in self.device_tokens.split(",") if t.strip()}

      def model_post_init(self, _ctx) -> None:
          if not self.offline_queue_path:
              # Resolve the default at instance time so Path.home() works
              # regardless of import-time cwd.
              object.__setattr__(
                  self, "offline_queue_path",
                  str(Path.home() / ".pharmguard" / "queue.db"),
              )

      def validate_runtime(self) -> None:
          """Production invariants. Raises RuntimeError on misconfig.

          NOT named `validate()` to avoid shadowing pydantic's internal
          validate. Call from main.py lifespan AFTER load.
          """
          if not self.backend_headless and not self.pharmguard_stub:
              if len(self.device_api_key) < 16:
                  raise RuntimeError(
                      "DEVICE_API_KEY must be >=16 chars in non-stub mode"
                  )
          if not self.supabase_url or not self.supabase_key:
              raise RuntimeError("SUPABASE_URL and SUPABASE_KEY are required")


  settings = Settings()
  ```
- **MIRROR**: pattern from `backend/app/core/config.py:6-26` (BaseSettings + lower_snake) wins. The `_LazySettings` proxy from `edge_pi/config.py:122-152` is **dropped** — pydantic-settings already evaluates lazily enough for our needs, and removing the proxy simplifies callers.
- **IMPORTS in callers**: `from config import settings` (replaces both old paths).
- **GOTCHA**: Old edge_pi code reads `settings.BACKEND_URL`, `settings.DEVICE_TOKEN` — both deleted. Anywhere that previously formatted `f"{settings.BACKEND_URL}/api/..."` in `edge_pi/main.py:79-219` is REMOVED in Task 7 (cycle_runner uses direct DB writes).
- **VALIDATE**: `cd backend && python -c "from config import settings; print(settings.model_dump())"` after seeding `.env`.

### Task 6: Add `verify_device_api_key` dependency
- **ACTION**: Add to `backend/core/security.py` (after the existing `verify_device_token` at line 50).
- **IMPLEMENT**:
  ```python
  from fastapi import Header

  async def verify_device_api_key(
      x_device_api_key: str | None = Header(default=None),
  ) -> None:
      """Auth for /api/device/* — frontend -> ngrok -> Pi.
      Fails closed when DEVICE_API_KEY is unset (matches verify_device_token).
      """
      key = settings.device_api_key
      if not key:
          raise HTTPException(status_code=503, detail="Device API key not configured")
      if not x_device_api_key or not hmac.compare_digest(x_device_api_key, key):
          raise HTTPException(status_code=401, detail="Invalid device API key")
  ```
- **MIRROR**: `verify_device_token` at `backend/app/core/security.py:32-50` (now `backend/core/security.py` after Task 4). Same `hmac.compare_digest` + 503/401 pattern.
- **IMPORTS** added to file: `from fastapi import Header`.
- **VALIDATE**: From a fresh dev shell:
  ```bash
  cd backend && BACKEND_HEADLESS=1 DEVICE_API_KEY=$(python -c "import secrets;print(secrets.token_urlsafe(32))") \
      uvicorn main:app --port 8000 &
  curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/api/device/status                                       # 401
  curl -s -o /dev/null -w '%{http_code}\n' -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8000/api/device/status # 200
  ```
  (Endpoint exists after Task 8.)

### Task 7: Extract cycle into `scheduler/cycle_runner.py`
- **ACTION**: Move the body of `edge_pi/main.py:run()` (specifically lines 254-419 + supporting helpers from 80-225) into a new module. Convert from while-loop with `time.sleep` to async coroutine.
- **IMPLEMENT** (skeleton — full body mirrors edge_pi/main.py with three transformations):
  ```python
  """Async port of edge_pi/main.py:run()."""
  import asyncio, csv, logging, time
  from pathlib import Path

  from config import settings
  from db.base import get_supabase
  from hardware.diverter import Diverter
  from hardware.drawer_lock import DrawerLock
  from hardware.ejector import Ejector
  from hardware.magazine import Magazine
  from hardware.temp_sensor import TempSensor
  from services.face_recognition import compute_embedding, match_embedding
  from storage.queue import OfflineQueue
  from vision import IntakeMonitor, LivenessDetector, PillVerifier, open_camera

  log = logging.getLogger(__name__)


  class CycleState:
      """Holds per-process cycle resources. Built once by HardwareLoop.start."""
      def __init__(self) -> None:
          self.magazine: Magazine | None = None
          # ... ejector, diverter, drawer_lock, temp_sensor, monitors, queue, ...
          self.hardware_stubbed: bool = False
          self.bench_writer = None
          self.cycle_n: int = 0
          self.last_cycle_summary: dict | None = None  # exposed via /api/device/status

      async def init(self) -> None:
          # MIRROR: edge_pi/main.py:289-360 verbatim, but raise RuntimeError
          # instead of sys.exit on stub-without-flag (so HardwareLoop can fail
          # the lifespan cleanly). Wrap blocking init in asyncio.to_thread.
          ...

      async def cleanup(self) -> None:
          for h in (self.magazine, self.ejector, self.diverter, self.drawer_lock):
              if h is not None:
                  await asyncio.to_thread(h.cleanup)
          # close cameras, queue, bench_writer

  async def report_intake_direct(state, patient_id, slot, *, verified, confidence, is_stub):
      """Direct DB write — replaces the HTTP POST in edge_pi/main.py:80-126.
      Same 2-phase commit: enqueue -> INSERT -> mark_sent."""
      payload = {"patient_id": patient_id, "slot": slot, "pill_taken": verified}
      if settings.dispenser_id:
          payload["dispenser_id"] = settings.dispenser_id
      if confidence is not None:
          payload["confidence_score"] = float(confidence)
      row_id = await asyncio.to_thread(state.queue.enqueue, "intake", payload, is_stub=is_stub)
      sb = get_supabase()
      try:
          await asyncio.to_thread(lambda: sb.table("adherence_logs").insert(payload).execute())
          await asyncio.to_thread(state.queue.mark_sent, [row_id])
          # Decrement medication quantity (mirrors backend/app/api/logs.py:44-49)
          # ...
      except Exception as exc:
          log.warning("intake insert failed: %s; row %d retained for replay", exc, row_id)

  async def run_cycle(state: CycleState) -> None:
      """One pass of the dispense loop. Caller (HardwareLoop) wraps in while True."""
      # MIRROR: edge_pi/main.py:362-419 step-for-step. Replace each
      # session.post / session.get with the equivalent direct call:
      #   session.get  /api/inventory/next-dispense  -> direct supabase query
      #   session.post /api/auth/verify-face         -> compute_embedding + match
      #   session.post /api/logs/                    -> report_intake_direct
      #   session.post /api/alerts/temperature       -> sb.table("temperatures").insert
      # Wrap every blocking call (GPIO, cv2, supabase) in asyncio.to_thread.
      # PRESERVE the per-step time.perf_counter() instrumentation verbatim.
      # PRESERVE the BENCH_MODE CSV writer at the bottom.
  ```
- **MIRROR**: Whole body of `edge_pi/main.py:run()` lines 254-419. The HI-012 stub guard at 295-316 ports VERBATIM (only `sys.exit(1)` -> `raise RuntimeError(...)`).
- **IMPORTS**: as above.
- **GOTCHA #1** — `asyncio.to_thread`: `magazine.rotate_to(slot)` is blocking + GPIO-bound; without `to_thread` it stalls FastAPI for the full step duration. Same for `cv2.VideoCapture.read`, `verifier.confirm_tray_empty`, etc.
- **GOTCHA #2** — `time.sleep(POLL_INTERVAL_S)` at the bottom of the loop becomes `await asyncio.sleep(...)`. Critical for FastAPI to serve HTTP between cycles.
- **GOTCHA #3** — `temperatures` table: confirm whether the existing backend writes through `/api/alerts/temperature` (endpoint exists per `edge_pi/main.py:144`). Read `backend/app/api/alerts.py` once; if its body just does `sb.table("temperatures").insert(...)`, port that body inline. If it does threshold logic, KEEP calling the route via `httpx.AsyncClient` to localhost — but prefer the direct call for consistency.
- **VALIDATE**:
  ```bash
  cd backend && BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 python -c "from scheduler.cycle_runner import run_cycle, CycleState"
  ```

### Task 8: HardwareLoop supervisor (`scheduler/background.py`)
- **ACTION**: New module with `HardwareLoop` class.
- **IMPLEMENT**:
  ```python
  """asyncio.Task supervisor for the dispense cycle."""
  import asyncio
  import logging

  from config import settings
  from scheduler.cycle_runner import CycleState, run_cycle

  log = logging.getLogger(__name__)

  _MAX_BACKOFF_S = 60.0


  class HardwareLoop:
      def __init__(self) -> None:
          self._state: CycleState | None = None
          self._task: asyncio.Task | None = None
          self._dispense_now_event = asyncio.Event()
          self._stop_event = asyncio.Event()

      async def start(self) -> None:
          self._state = CycleState()
          await self._state.init()                      # may raise; lifespan aborts startup
          self._task = asyncio.create_task(self._supervised_loop(), name="hardware_loop")

      async def stop(self) -> None:
          self._stop_event.set()
          if self._task is not None:
              self._task.cancel()
              try:
                  await self._task
              except asyncio.CancelledError:
                  pass
          if self._state is not None:
              await self._state.cleanup()

      def trigger_dispense_now(self) -> None:
          self._dispense_now_event.set()

      def status(self) -> dict:
          assert self._state is not None
          return {
              "headless": False,
              "hardware_stubbed": self._state.hardware_stubbed,
              "cycle_n": self._state.cycle_n,
              "last_cycle": self._state.last_cycle_summary,
              "task_running": self._task is not None and not self._task.done(),
          }

      async def _supervised_loop(self) -> None:
          backoff = 1.0
          while not self._stop_event.is_set():
              try:
                  await run_cycle(self._state)         # one pass of the cycle
                  backoff = 1.0                         # reset after success
                  # poll-or-trigger sleep
                  try:
                      await asyncio.wait_for(
                          self._dispense_now_event.wait(),
                          timeout=settings.poll_interval_s,
                      )
                      self._dispense_now_event.clear()
                  except asyncio.TimeoutError:
                      pass
              except asyncio.CancelledError:
                  raise
              except Exception:
                  log.exception("hardware loop crashed; restarting in %.1fs", backoff)
                  await asyncio.sleep(backoff)
                  backoff = min(backoff * 2, _MAX_BACKOFF_S)
  ```
- **MIRROR**: The `Refusing dispense — oldest unposted event ...` gate from `edge_pi/main.py:373-386` lives INSIDE `run_cycle`, not here.
- **IMPORTS**: `asyncio`, `logging`, `scheduler.cycle_runner`, `config.settings`.
- **GOTCHA**: Catch broad `Exception` inside `_supervised_loop` so a transient GPIO glitch doesn't kill the FastAPI lifespan. Only `_state.init()` raises out — that's the fail-loud HI-012 path.
- **VALIDATE**: New unit test in `backend/tests/test_background.py`:
  ```python
  @pytest.mark.asyncio
  async def test_loop_restarts_on_runtime_error(monkeypatch):
      calls = []
      async def fake_run_cycle(state):
          calls.append(1)
          if len(calls) < 3:
              raise RuntimeError("boom")
      monkeypatch.setattr("scheduler.background.run_cycle", fake_run_cycle)
      ...
      assert len(calls) >= 3
  ```

### Task 9: Wire `lifespan` in `backend/main.py`
- **ACTION**: Update `backend/main.py` (already moved in Task 4).
- **IMPLEMENT**:
  ```python
  """PharmGuard Backend — FastAPI application + asyncio hardware supervisor."""
  import logging
  from contextlib import asynccontextmanager

  from fastapi import FastAPI
  from fastapi.middleware.cors import CORSMiddleware

  from api import alerts, auth, device, inventory, logs
  from config import settings
  from scheduler.background import HardwareLoop

  logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
  log = logging.getLogger(__name__)


  @asynccontextmanager
  async def lifespan(app: FastAPI):
      settings.validate_runtime()
      if settings.backend_headless:
          log.info("BACKEND_HEADLESS=1 — skipping hardware loop init")
          app.state.hardware_loop = None
          yield
          return
      loop = HardwareLoop()
      await loop.start()
      app.state.hardware_loop = loop
      log.info("Hardware loop started")
      try:
          yield
      finally:
          log.info("Stopping hardware loop")
          await loop.stop()


  app = FastAPI(title="PharmGuard", version="0.2.0", lifespan=lifespan)

  app.add_middleware(
      CORSMiddleware,
      allow_origins=["http://localhost:3000"],
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
  )

  app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
  app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
  app.include_router(device.router, prefix="/api/device", tags=["device"])
  app.include_router(inventory.router, prefix="/api/inventory", tags=["inventory"])
  app.include_router(logs.router, prefix="/api/logs", tags=["logs"])


  @app.get("/health")
  async def health():
      return {"status": "ok"}
  ```
- **MIRROR**: `backend/app/main.py:1-31` (existing). Add `lifespan=lifespan` and the new `device` router include.
- **GOTCHA**: `lifespan` startup errors print as ugly tracebacks but DO prevent uvicorn from binding the port — that's intended for HI-012.
- **VALIDATE**:
  ```bash
  cd backend && BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 SUPABASE_URL=x SUPABASE_KEY=y DEVICE_API_KEY=$(python -c "import secrets;print(secrets.token_urlsafe(32))") \
      uvicorn main:app --port 8000
  curl http://localhost:8000/health
  # -> {"status":"ok"}
  ```

### Task 10: New `api/device.py` router
- **ACTION**: Create `backend/api/device.py`.
- **IMPLEMENT**:
  ```python
  """Frontend control endpoints — gated by X-Device-API-Key (set in frontend env)."""
  from fastapi import APIRouter, Depends, HTTPException, Request

  from core.security import verify_device_api_key

  router = APIRouter(dependencies=[Depends(verify_device_api_key)])


  @router.get("/status")
  async def device_status(request: Request):
      loop = request.app.state.hardware_loop
      if loop is None:
          return {"headless": True, "hardware_stubbed": True, "cycle_n": 0, "last_cycle": None}
      return loop.status()


  @router.post("/dispense_now", status_code=202)
  async def dispense_now(request: Request):
      loop = request.app.state.hardware_loop
      if loop is None:
          raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
      loop.trigger_dispense_now()
      return {"queued": True}


  @router.post("/reset")
  async def reset(request: Request):
      loop = request.app.state.hardware_loop
      if loop is None:
          raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
      # Stop + restart the loop so cleanup() runs on the failed cycle.
      await loop.stop()
      await loop.start()
      return {"reset": True}
  ```
- **MIRROR**: `backend/app/api/inventory.py:1-30` for router shape; auth is the new `verify_device_api_key`.
- **IMPORTS**: as above.
- **VALIDATE**:
  ```bash
  curl -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8000/api/device/status   # 200, headless=true on dev mac
  curl -X POST -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8000/api/device/dispense_now   # 503 in headless, 202 on Pi
  ```

### Task 11: Merge `requirements.txt`
- **ACTION**: Replace `backend/requirements.txt` with the union.
- **IMPLEMENT** (final content):
  ```
  fastapi>=0.115.0
  uvicorn[standard]>=0.30.0
  supabase>=2.0.0
  pydantic>=2.0.0
  pydantic-settings>=2.0.0
  python-jose[cryptography]>=3.3.0
  passlib[bcrypt]>=1.7.4
  python-multipart>=0.0.9
  httpx>=0.27.0
  websockets>=12.0
  google-generativeai>=0.8.0
  face_recognition>=1.3.0,<2.0.0
  # ── from edge_pi/requirements.txt ──
  ultralytics>=8.0.0,<9.0.0
  opencv-python-headless>=4.8.0,<5.0.0
  mediapipe>=0.10.9,<0.11.0
  numpy>=1.24,<2.0
  requests>=2.31.0,<3.0.0
  # Pi-only — Mac venv ignores via marker
  picamera2>=0.3.12,<0.4.0; platform_machine == 'aarch64'
  rpi-lgpio>=0.6; platform_machine == 'aarch64'
  adafruit-circuitpython-dht>=4.0.0,<5.0.0; platform_machine == 'aarch64'
  ```
- **MIRROR**: existing `backend/requirements.txt` + `edge_pi/requirements.txt`.
- **GOTCHA**: mediapipe needs cp ≤ 3.12. The Pi uses an `uv python install 3.12` venv per the prior session — confirm `bash scripts/install.sh` still respects `PHARMGUARD_PYTHON`.
- **VALIDATE**:
  ```bash
  cd backend && pip install --dry-run -r requirements.txt
  ```

### Task 12: Systemd + ngrok services
- **ACTION**: Update `backend/scripts/pharmguard.service`; create `backend/scripts/ngrok.service`; update `backend/scripts/install.sh`.
- **IMPLEMENT** changes to `pharmguard.service` (only ExecStart + WorkingDirectory diff from current):
  ```ini
  WorkingDirectory=__INSTALL_DIR__
  ExecStart=__INSTALL_DIR__/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
  ```
  Keep ALL other directives unchanged from `edge_pi/scripts/pharmguard.service:1-50`.

  New `backend/scripts/ngrok.service`:
  ```ini
  [Unit]
  Description=ngrok HTTP tunnel for PharmGuard
  After=pharmguard.service network-online.target
  Requires=pharmguard.service

  [Service]
  Type=simple
  User=__USER__
  ExecStart=/usr/local/bin/ngrok http --log=stdout 8000
  Restart=on-failure
  RestartSec=5s

  StandardOutput=journal
  StandardError=journal
  SyslogIdentifier=ngrok-pharmguard

  [Install]
  WantedBy=multi-user.target
  ```

  `install.sh` additions: prompt for ngrok authtoken if not set; `ngrok config add-authtoken`; install both .service files; `chown` paths for `__USER__` substitution as before.
- **MIRROR**: existing install.sh hash-checked unit refresh pattern.
- **GOTCHA**: Free-tier ngrok URL changes per restart. Add a one-shot `ExecStartPost=` script that greps the just-bound URL from `journalctl` and writes it to `/var/lib/pharmguard/ngrok_url.txt` so the operator (or future watcher) can read it without scraping logs.
- **VALIDATE**: On Pi after install, `systemctl status pharmguard ngrok` both `active (running)`; both URL probes from §"Validation Commands" succeed.

### Task 13: Frontend `lib/device.ts` + Dispense Now button
- **ACTION**: Create `frontend/src/lib/device.ts`; update `frontend/src/app/patients/[id]/page.tsx`; update `frontend/.env.local.example`.
- **IMPLEMENT** `lib/device.ts`:
  ```ts
  const baseUrl = process.env.NEXT_PUBLIC_DEVICE_URL || "";
  const apiKey  = process.env.NEXT_PUBLIC_DEVICE_API_KEY || "";

  export type DeviceStatus = {
    headless: boolean;
    hardware_stubbed: boolean;
    cycle_n: number;
    last_cycle: { pill_taken: boolean; t_total_ms: number; cycle: number } | null;
    task_running?: boolean;
  };

  export async function fetchDeviceStatus(): Promise<DeviceStatus | null> {
    if (!baseUrl || !apiKey) return null;
    const r = await fetch(`${baseUrl}/api/device/status`, {
      headers: { "X-Device-API-Key": apiKey },
      cache: "no-store",
    });
    if (!r.ok) return null;
    return r.json();
  }

  export async function triggerDispense(): Promise<boolean> {
    if (!baseUrl || !apiKey) return false;
    const r = await fetch(`${baseUrl}/api/device/dispense_now`, {
      method: "POST",
      headers: { "X-Device-API-Key": apiKey },
    });
    return r.ok;
  }
  ```
  Patient detail page additions: "Dispense Now" button + status display, disabled when `baseUrl`/`apiKey` empty.
- **MIRROR**: existing `frontend/src/lib/api.ts` and `frontend/src/lib/supabase.ts` shape — typed wrapper around `fetch` returning typed objects.
- **GOTCHA**: `NEXT_PUBLIC_*` ships to the browser. State in README that this is a soft key, not a hard secret. Disable button entirely (don't just hide) when env vars missing — make the constraint visible.
- **VALIDATE**: `cd frontend && npm run build` — zero type errors. Manual smoke against Pi after Task 15.

### Task 14: Delete `edge_pi/`, fix Makefile, update docs
- **ACTION**: `git rm -r edge_pi/`. Update `Makefile`, `CLAUDE.md`, `README.md`, `HARDWARE_WIRING.md`.
- **IMPLEMENT** Makefile diff:
  ```make
  # before
  backend:
  	cd backend && uvicorn app.main:app --reload --port 8000

  pi-models:
  	ls -lh edge_pi/models/*.pt
  pi-sync:
  	rsync -a --exclude='.venv' --exclude='__pycache__' edge_pi/ $(HOST):~/IDP_PharmGuard/edge_pi/
  pi-bootstrap:
  	... (whole target)

  # after
  backend:
  	cd backend && BACKEND_HEADLESS=1 uvicorn main:app --reload --port 8000

  pi-sync:
  	rsync -a --exclude='.venv' --exclude='__pycache__' --exclude='models' backend/ $(HOST):~/IDP_PharmGuard/backend/
  ```
  `CLAUDE.md` System overview rewrite: 2-tier; remove edge_pi paragraph; add lifespan/asyncio + ngrok + DEVICE_API_KEY notes.
  `HARDWARE_WIRING.md`: replace every `edge_pi/hardware/` with `backend/hardware/`, every `edge_pi/scripts/` with `backend/scripts/`.
- **VALIDATE**: `grep -RnE "edge_pi" --exclude-dir=.git . | grep -v "pre-merge-snapshot"` returns empty.

### Task 15: Pi bring-up + frontend smoke
- **ACTION** (operator on the Pi):
  ```bash
  cd ~/IDP_PharmGuard && git pull
  cd backend && bash scripts/install.sh
  sudo systemctl daemon-reload
  sudo systemctl enable --now pharmguard ngrok
  journalctl -u pharmguard -n 50 --no-pager
  journalctl -u ngrok -n 30 --no-pager | grep -oE 'https://[a-z0-9-]+\.ngrok-free\.app'
  ```
  Then on dev mac, set `NEXT_PUBLIC_DEVICE_URL` + `NEXT_PUBLIC_DEVICE_API_KEY` in `frontend/.env.local`, restart `npm run dev`, click Dispense Now on a patient page.
- **VALIDATE** (full e2e):
  - `curl http://localhost:8000/health` on Pi -> 200
  - `curl -H "X-Device-API-Key: $K" http://localhost:8000/api/device/status` -> real hardware state, `headless=false`, `hardware_stubbed=false`
  - `journalctl -u pharmguard -f` shows "Hardware loop started" + cycle log lines every `poll_interval_s`
  - From dev mac: `curl https://<ngrok>.ngrok-free.app/health` -> 200
  - Dashboard "Dispense Now" returns 202; Pi journal shows an out-of-cycle dispense
  - One row appears in Supabase `adherence_logs` with the expected `patient_id`/`slot`

---

## Testing Strategy

### Unit Tests

| Test file | Test | Input | Expected | Edge case? |
|---|---|---|---|---|
| `tests/test_background.py` | `test_loop_restarts_on_runtime_error` | mock `run_cycle` raising twice | task survives, `run_cycle` called >=3 times | crash recovery |
| `tests/test_background.py` | `test_stop_cancels_task` | start then stop | `_task` is cancelled and awaited | clean shutdown |
| `tests/test_background.py` | `test_dispense_now_unblocks_sleep` | start, set `_dispense_now_event` mid-`asyncio.wait_for` | next cycle runs without waiting full poll interval | manual trigger |
| `tests/test_device_api.py` | `test_status_unauthenticated` | GET without header | 401 | auth |
| `tests/test_device_api.py` | `test_status_wrong_key` | wrong header | 401 | auth |
| `tests/test_device_api.py` | `test_status_ok` | correct header | 200 + status JSON | happy path |
| `tests/test_device_api.py` | `test_dispense_now_headless` | BACKEND_HEADLESS=1 | 503 | dev-mac path |
| `tests/test_stub_invariant.py` | `test_stub_mode_never_logs_pill_taken_true` | run cycle with `pharmguard_stub=1` and stubbed hardware | no `adherence_logs` row with `pill_taken=true` | **HI-012 SAFETY** |
| `tests/test_config.py` | `test_validate_runtime_rejects_short_api_key` | DEVICE_API_KEY="abc" + non-stub | RuntimeError | config |
| `tests/test_config.py` | `test_offline_queue_path_default` | omit env var | resolves to `~/.pharmguard/queue.db` | default |

Existing `edge_pi/tests/*` move to `backend/tests/` unchanged (Task 3). Their conftest already monkeypatches `sys.modules["RPi"]` so they keep working from the new root.

### Edge Cases Checklist
- [x] Empty input — `run_cycle` with no pending dispense -> `next-dispense` query returns no row -> cycle no-ops
- [x] Maximum size input — N/A
- [x] Invalid types — handled by Pydantic on inbound API; cycle only consumes typed dicts
- [x] Concurrent access — single-process / single-event-loop; no concurrency at the GPIO boundary
- [x] Network failure — Supabase outage handled by OfflineQueue 2-phase commit; cycle refuse-gate at `cycle_runner` (port of `edge_pi/main.py:373-386`) prevents long-stale dispenses
- [x] Permission denied — uvicorn under root (per existing service unit) — same posture as edge_pi today
- [x] **HI-012 stub falsification** — explicit unit test in `test_stub_invariant.py`
- [x] ngrok URL rotation — frontend env var must be re-set; documented in README

---

## Validation Commands

### Static Analysis
```bash
cd backend
python -m py_compile $(git ls-files '*.py')
```
**EXPECT**: zero errors.

```bash
cd frontend
npm run lint
npm run build
```
**EXPECT**: zero errors / zero type errors.

### Unit tests
```bash
cd backend
pip install pytest pytest-asyncio
PHARMGUARD_STUB=1 BACKEND_HEADLESS=1 SUPABASE_URL=x SUPABASE_KEY=y DEVICE_API_KEY=$(python -c "import secrets;print(secrets.token_urlsafe(32))") \
    pytest tests/ -q
```
**EXPECT**: all tests pass, including `test_stub_invariant.py`.

### Smoke (dev-mac, headless)
```bash
cd backend
export BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 SUPABASE_URL=... SUPABASE_KEY=...
export DEVICE_API_KEY=$(python -c "import secrets;print(secrets.token_urlsafe(32))")
uvicorn main:app --port 8000 &
PID=$!
sleep 2
curl -s http://localhost:8000/health                                                    # {"status":"ok"}
curl -s -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8000/api/device/status  # headless=true
curl -s -X POST -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8000/api/device/dispense_now  # 503 (headless)
kill $PID
```
**EXPECT**: all four lines as commented.

### Smoke (Pi, real hardware)
```bash
sudo systemctl restart pharmguard ngrok
sleep 5
sudo systemctl is-active pharmguard ngrok            # active active
curl -s http://localhost:8000/health                 # 200
curl -s -H "X-Device-API-Key: $DEVICE_API_KEY" http://localhost:8000/api/device/status | jq
journalctl -u pharmguard -n 50 --no-pager | grep -E "Hardware loop started|Cycle complete"
```
**EXPECT**: status JSON shows `hardware_stubbed=false`, journal shows started + at least one cycle.

### HI-012 invariant (CRITICAL)
```bash
cd backend
PHARMGUARD_STUB=1 BACKEND_HEADLESS=0 pytest tests/test_stub_invariant.py -q
```
**EXPECT**: passes; the test patches Supabase client and asserts no insert with `pill_taken=true` ever occurs in stub mode.

### Full Test Suite
```bash
cd backend && pytest tests/ -q
cd frontend && npm run build
```
**EXPECT**: green both sides.

### Manual Validation (after Task 15)
- [ ] `curl http://localhost:8000/health` on Pi returns 200
- [ ] `journalctl -u pharmguard -f` shows cycles every `poll_interval_s`
- [ ] ngrok URL extracted from `journalctl -u ngrok` resolves from dev mac
- [ ] `curl https://<ngrok>.ngrok-free.app/health` returns 200
- [ ] Dashboard renders with `NEXT_PUBLIC_DEVICE_URL` set; "Dispense Now" button enabled
- [ ] Click "Dispense Now" -> toast says success -> Pi journal shows out-of-cycle trigger -> Supabase `adherence_logs` row appears
- [ ] Stop pharmguard service -> dashboard reads still work (Supabase direct unaffected) -> Dispense Now toast shows network error
- [ ] Restart Pi -> `NEXT_PUBLIC_DEVICE_URL` now stale -> button greyed out / 502 toast

---

## Acceptance Criteria
- [ ] `edge_pi/` does not exist after final commit; `grep -RnE "edge_pi" --exclude-dir=.git .` is empty
- [ ] `backend/main.py` boots a FastAPI app whose `lifespan` starts `HardwareLoop`
- [ ] `BACKEND_HEADLESS=1` lets `uvicorn main:app` start on dev-mac without GPIO
- [ ] `POST /api/device/dispense_now` triggers a real cycle on the Pi
- [ ] Frontend "Dispense Now" round-trips through ngrok and produces a Supabase `adherence_logs` row
- [ ] HI-012 invariant test passes
- [ ] All 5 `hardware/test_*.py` bench scripts still work from `backend/hardware/`
- [ ] `make backend` works on dev-mac (headless), `bash backend/scripts/install.sh` works on Pi
- [ ] `CLAUDE.md` / `README.md` describe the 2-tier architecture
- [ ] `tests/` from the moved edge_pi tests pass under `backend/tests/`

## Completion Checklist
- [ ] All tasks completed
- [ ] All validation commands pass
- [ ] Tests written and passing (HI-012 test mandatory)
- [ ] No type errors (`npm run build` + `py_compile`)
- [ ] No lint errors (`npm run lint`)
- [ ] UX matches the "After" diagram (Dispense Now button + status block)
- [ ] Code follows discovered patterns (router shape, auth dep, %-style logging)
- [ ] Error handling matches codebase (HTTPException + log.exception + fail-loud HI-012)
- [ ] No hardcoded values (all settings via `config.settings`)
- [ ] Documentation updated (CLAUDE.md, README.md, HARDWARE_WIRING.md)
- [ ] No unnecessary scope additions (NOT-Building list respected)
- [ ] Self-contained — no questions needed during `/prp-implement`

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Multi-worker uvicorn corrupts GPIO state | M | H (silent dispense failures) | Pin `--workers 1` in pharmguard.service Task 12. Add startup assertion `assert os.environ.get("WEB_CONCURRENCY","1") == "1"`. |
| HardwareLoop crash propagates to FastAPI lifespan, kills HTTP API | M | H (dashboard goes dark on Pi crash) | `_supervised_loop` catches broad exceptions with exp-backoff. ONLY `_state.init()` raises out — that's the HI-012 fail-loud path. |
| Free ngrok URL rotation breaks frontend | H | M (manual env update required) | Document loudly in README. ExecStartPost script writes URL to `/var/lib/pharmguard/ngrok_url.txt` for ops scripts. Long-term: paid static domain or Cloudflare Tunnel. |
| `NEXT_PUBLIC_DEVICE_API_KEY` is browser-readable | H | M (anyone reading the bundle can dispense) | Document explicitly. Recommend Edge Function proxy as follow-up. Note: ngrok URL itself is also discoverable; the key is defence-in-depth. |
| HI-012 invariant lost during refactor | M | H (falsified adherence) | Carry stub-mode guard verbatim. **Mandatory** unit test `test_stub_invariant.py`. |
| `asyncio.to_thread` overhead offsets self-HTTP savings | L | L (perf parity) | Benchmark before/after with `bench_e2e.py`. If regressed, switch the hottest call (`run_cycle` body inner section) to `asyncio.run_in_executor` with a custom thread pool. |
| Dev-mac venv breaks on Pi-only deps | M | L (annoying, blocks dev) | `; platform_machine == 'aarch64'` markers — verified in Task 11. |
| Existing `verify_device_token` callers break when token gets removed | L | M (face-verify route 401s) | DON'T remove; legacy bearer auth stays for `/api/inventory/*`, `/api/logs/*`, `/api/auth/verify-face`. New endpoints use `verify_device_api_key`. |
| In-flight refactor breaks both backends at once | M | M | `pre-merge-snapshot` git tag for instant rollback; work on `feat/pi-hosted-backend`. |
| Cycle code calls Supabase directly + lifespan also calls Supabase -> connection thrashing | L | L | `db.base.get_supabase()` is a singleton — confirmed at backend/app/db/base.py:7-14. One client process-wide. |

## Notes

**Why pydantic-settings wins over the frozen-dataclass + lazy proxy.** The lazy proxy in `edge_pi/config.py:122-152` exists because `_load()` calls `_require()` which raises on missing env — and import-time crashes break `python -m py_compile` and tests. With pydantic-settings + safe defaults, every key is optional at import time; `validate_runtime()` is what raises in lifespan. Cleaner, fewer moving parts, one settings object across the codebase.

**Why we kept `verify_device_token` and added `verify_device_api_key` (instead of one auth).** The legacy bearer-token endpoints (`/api/inventory/*`, `/api/logs/*`, `/api/auth/verify-face`) had been called by the Pi over HTTP. After the merge, the Pi-internal cycle code bypasses those endpoints entirely (direct service-function calls). The endpoints stay for forward compatibility — any future external integration (a second device, a diagnostic tool, a Postman probe) can still authenticate with a bearer token. The new `/api/device/*` group is specifically for frontend-via-ngrok and uses a different header name (`X-Device-API-Key`) to make the auth boundary explicit.

**ngrok URL rotation: not as bad as it sounds.** Pi reboots are rare in production. The frontend env update is one line in `frontend/.env.local` + a `vercel env pull` if hosted on Vercel. For dev iteration where Pi reboots happen often, a 5-line bash watcher running on the Pi can `curl` a static endpoint with the new URL on every ngrok start.

**HI-012 invariant priority.** This refactor crosses one safety boundary (telemetry truthfulness in stub mode). A mandatory unit test catches it. If `test_stub_invariant.py` fails at any point during implementation, **stop and fix** — do not proceed to the next task.
