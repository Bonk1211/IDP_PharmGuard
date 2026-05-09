# PharmGuard

PharmGuard is a smart pill dispenser system. It runs in two tiers: a Pi-hosted FastAPI backend (handles physical dispensing, pill ID, intake verification, and Supabase telemetry) and a Next.js dashboard (used by caregivers + admins to manage patients and review activity). The dashboard reaches the Pi over a free-tier ngrok tunnel for control actions; reads stay direct to Supabase.

## Repo layout

- `backend/` — FastAPI service. Runs ON the Pi (production) and dev-mac with `BACKEND_HEADLESS=1`. Contains the dispense cycle (`scheduler/`), hardware drivers (`hardware/`), vision (`vision/`), offline queue (`storage/`), API routers (`api/`), and the YOLO weights (`models/`).
- `frontend/` — Next.js dashboard. Runs on cloud (Vercel) / dev machine.
- `ml/` — Training code and datasets (`pill_detector/`, `spotter/`, `swallow/`, `datasets/`). Dev workstation only; not deployed.
- `scripts/` — Repo-level dev setup scripts.
- `Makefile` — Top-level entry points.

## Quickstart

### Backend

```
make backend
```

Runs `uvicorn app.main:app --reload --port 8000` from `backend/`. First-time setup: `make setup` then copy `backend/.env.example` to `backend/.env` and fill in Supabase keys.

### Frontend

```
make frontend
```

Runs `npm run dev` from `frontend/`. Copy `frontend/.env.local.example` to `frontend/.env.local` first.

### Edge Pi

**Fresh Pi** (one-shot bootstrap):

```
make pi-bootstrap HOST=pi@<host>
```

Rsyncs `backend/` to the Pi, runs `scripts/install.sh` (idempotent), and enables `pharmguard.service`. Operator then edits `~/IDP_PharmGuard/backend/.env` on the Pi and runs `sudo systemctl restart pharmguard`. See `backend/README.md` for the per-step breakdown and `BOM.md` for hardware procurement.

**Incremental sync** (after a code edit):

```
make pi-sync HOST=pi@<host>
```

Rsync only — service is already enabled. `make pi-models` lists deployed YOLO weights.

## Deployment targets

| Component   | Target                          |
|-------------|---------------------------------|
| `backend/`  | Cloud (Supabase-hosted Postgres + FastAPI host) |
| `frontend/` | Vercel or static hosting        |
| `backend/`  | Raspberry Pi 5                  |
| `ml/`       | Dev workstation only            |

## Model weights

Production model weights live in `backend/models/*.pt` and are tracked in git (~37MB total) so the Pi can be provisioned from a clean clone. Training-side weights under `ml/**/*.pt` and large datasets (`ml/datasets/`, `ml/**/Medicine_Images/`) are gitignored. Retraining and dataset handling live in `ml/` — see `ml/README.md`.
