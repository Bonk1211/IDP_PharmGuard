# PharmGuard

PharmGuard is a smart pill dispenser system. It is split across three tiers: an edge device (Raspberry Pi 5) that handles physical dispensing, face authentication, and intake verification; a cloud backend (FastAPI + Supabase) that owns patient records, schedules, and intake logs; and a web dashboard (Next.js) used by caregivers and admins to manage patients and review activity.

## Repo layout

- `backend/` — FastAPI service. Runs on cloud / dev machine.
- `frontend/` — Next.js dashboard. Runs on cloud (Vercel) / dev machine.
- `backend/` — Raspberry Pi 5 runtime: `main.py`, `vision/`, `hardware/`, `models/`, `scripts/`. Runs on the Pi.
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
