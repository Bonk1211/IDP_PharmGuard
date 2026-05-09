# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## System overview

PharmGuard is a smart pill dispenser split into three tiers that run on different machines:

- **`backend/`** — runs on a Raspberry Pi 5. Drives stepper/servo hardware, Pi Camera (libcamera/picamera2), and runs computer-vision inference (YOLO + MediaPipe) entirely on-device. Polls the backend over HTTP for the next dispense and POSTs intake logs back.
- **`backend/`** — FastAPI service. Stateless app layer on top of **Supabase** (Postgres + storage). No local database — `app/db/base.py` is just a Supabase client singleton. All routes live under `/api/*` (auth, inventory, logs).
- **`frontend/`** — Next.js 15 (App Router, React 19, Tailwind v4) caregiver dashboard. Talks to **Supabase directly** via `@supabase/supabase-js` for reads (`src/lib/supabase.ts`); not all UI routes through the FastAPI backend.
- **`ml/`** — training-only. Never deployed. Produces `.pt` weights that get promoted into `backend/models/`.

The contract between tiers is **HTTP + Supabase**, not a shared library. Changing a route in `backend/app/api/` requires updating both the Pi (`backend/main.py` calls) and any frontend code that hits it.

## Common commands

All of these are top-level Makefile targets unless noted:

```bash
make setup            # one-time: backend venv + frontend npm install
make backend          # uvicorn app.main:app --reload --port 8000  (cwd: backend/)
make frontend         # next dev                                    (cwd: frontend/)
make dev              # both in parallel
make pi-models        # ls -lh backend/models/*.pt — verify weights present
make pi-sync HOST=pi@<host>   # rsync backend/ → Pi, excluding .venv & __pycache__
make clean-ml         # prints what to rm to free ML disk; does NOT delete
```

Frontend (cwd: `frontend/`):
```bash
npm run dev           # dev server on :3000
npm run build         # production build
npm run start         # serve build
npm run lint          # next lint
```

Backend (cwd: `backend/`, venv active):
```bash
uvicorn app.main:app --reload --port 8000
```

There is **no test suite** in this repo yet — `pytest`, `vitest`, etc. are not configured. Don't claim "tests pass" — there are none to run.

Pi-side (run on the Pi, not the dev machine):
```bash
cd ~/IDP_PharmGuard/backend
bash scripts/install.sh                       # first-time only
sudo systemctl enable --now pharmguard
sudo systemctl restart pharmguard             # after a sync
journalctl -u pharmguard -f                   # tail logs
```

## Architecture details that aren't obvious from one file

### Backend (`backend/app/`)
- `main.py` mounts three routers — `auth`, `inventory`, `logs` — under `/api/<name>`. Add new domains the same way; don't put logic in `main.py`.
- `core/config.py` uses `pydantic-settings` reading `backend/.env`. The Supabase **service_role** key lives here — backend has full DB access. The frontend uses the anon key in its own `.env.local`.
- `db/base.py` exports `get_supabase() -> Client`, a lazy singleton. Always go through this — do not instantiate `create_client` elsewhere.
- `services/gemini_fallback.py` — Google Generative AI is wired up as a fallback path (likely for pill ID when on-device YOLO confidence is low). Keep that boundary: the Pi calls the backend, the backend calls Gemini; the Pi never holds a Gemini key.
- Several endpoints are stubs (e.g. `/api/auth/verify-face` returns the first patient row; `/api/auth/login` raises 501). Don't assume an endpoint is fully implemented — read it first.

### Edge Pi (`backend/`)
- `main.py` is a `while True` polling loop hitting `BACKEND_URL/api/inventory/next-dispense`, then sequencing magazine → ejector → vision verify → `POST /api/logs`. `BACKEND_URL` is currently hardcoded to `http://localhost:8000` and must be overridden in production.
- `vision/pill_verifier.py` — wraps YOLO (`models/spotter.pt`) for tray-empty detection. Uses **lazy init** (model + camera open on first call), not in `__init__`. Falls back from `picamera2` → `cv2.VideoCapture` if picamera2 isn't available.
- `vision/intake_monitor.py` — MediaPipe FaceMesh + Hands, ported from `ml/swallow/main5.py` as a 5-step FSM (HAND → TILT → LEVEL → MOUTH → TONGUE) with EMA smoothing. The reference script `ml/swallow/main5.py` is the canonical spec — when behavior is ambiguous, that file wins. Step 4 has **inverted logic** (pill *visible* in mouth resets the timer); preserve this when refactoring.
- `hardware/magazine.py`, `hardware/ejector.py` — both use `import RPi.GPIO`. On Pi 5 / Bookworm, `RPi.GPIO` doesn't work natively — `requirements.txt` pulls **`rpi-lgpio`**, which is a drop-in shim that keeps the imports unchanged but uses `lgpio` underneath. Do not "fix" the imports to `gpiozero`; the shim is intentional.
- `models/*.pt` are **tracked in git** (~37MB total) so a fresh Pi clone is bootable. Training-side weights under `ml/**/*.pt` are gitignored. See `.gitignore` line 16.
- `scripts/install.sh` substitutes `__INSTALL_DIR__` and `__USER__` placeholders into `pharmguard.service` at install time — those tokens are not literal paths, they're sentinel strings.

### Frontend (`frontend/src/`)
- App Router (`src/app/`). Top-level pages: `page.tsx` (dashboard), `patients/`, `inventory/`, `reports/`.
- Two access paths to data: `lib/api.ts` calls the FastAPI backend; `lib/supabase.ts` talks to Supabase directly. Match the existing pattern of the surrounding code — do not unilaterally route everything through one or the other.
- Tailwind v4 (uses `@tailwindcss/postcss`, not the legacy v3 config flow).

### ML (`ml/`)
- Three independent model folders: `pill_detector/` (YOLO classifier, ~340M with training set), `spotter/` (YOLO detector, used by Pi), `swallow/` (MediaPipe prototype, single file `main5.py`).
- Datasets and training artifacts are gitignored: `ml/datasets/`, `ml/**/Medicine_Images/`, `ml/**/train/`, plus `ml/**/*.pt`.
- Promoting a new training run to the Pi means manually copying:
  ```bash
  cp ml/pill_detector/my_model.pt  backend/models/pill_detector.pt
  cp ml/spotter/spotter_model.pt    backend/models/spotter.pt
  ```
  Then commit the new `.pt` and `make pi-sync`.

## MCP / external services

- `.mcp.json` configures the **Supabase MCP server** pointed at project `wqijdqclqhybhdtgsznf`. When the user asks for DB schema, migrations, or queries, prefer `mcp__supabase__*` tools over guessing.
- Backend env (`backend/.env`) needs `SUPABASE_URL`, `SUPABASE_KEY` (service_role), and `GEMINI_API_KEY` for the fallback service.
- Frontend env (`frontend/.env.local`) needs the Supabase URL + anon key.

## Caveats and known mismatches

- `scripts/setup_dev.sh` references a `dashboard/` directory that **does not exist** — this repo uses `frontend/`. Use `make setup` instead, which is correct.
- `backend/main.py` has `BACKEND_URL = "http://localhost:8000"` hardcoded. Production deploys must override (planned via `.env` per `backend/README.md`, but the code does not yet read it — search for `BACKEND_URL` before assuming env-var support).
- macOS dev hosts are case-insensitive: be careful renaming directories that differ only in case (`Spotter` vs `spotter`) — they collide silently and `mv` becomes a no-op while `rm -rf` of the "old" name takes both.
- The repo has no CI configured. Linting/type-checking is manual: `npm run lint` for frontend, nothing for backend or `backend/`.
