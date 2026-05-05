# PharmGuard

PharmGuard is a smart pill dispenser system. It is split across three tiers: an edge device (Raspberry Pi 5) that handles physical dispensing, face authentication, and intake verification; a cloud backend (FastAPI + Supabase) that owns patient records, schedules, and intake logs; and a web dashboard (Next.js) used by caregivers and admins to manage patients and review activity.

## Repo layout

- `backend/` — FastAPI service. Runs on cloud / dev machine.
- `frontend/` — Next.js dashboard. Runs on cloud (Vercel) / dev machine.
- `edge_pi/` — Raspberry Pi 5 runtime: `main.py`, `vision/`, `hardware/`, `models/`, `scripts/`. Runs on the Pi.
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

See `edge_pi/README.md` for Pi-side setup, including syncing from a dev machine via `make pi-sync HOST=pi@<host>` and verifying weights with `make pi-models`.

## Deployment targets

| Component   | Target                          |
|-------------|---------------------------------|
| `backend/`  | Cloud (Supabase-hosted Postgres + FastAPI host) |
| `frontend/` | Vercel or static hosting        |
| `edge_pi/`  | Raspberry Pi 5                  |
| `ml/`       | Dev workstation only            |

## Model weights

Production model weights live in `edge_pi/models/*.pt` and are tracked in git (~37MB total) so the Pi can be provisioned from a clean clone. Training-side weights under `ml/**/*.pt` and large datasets (`ml/datasets/`, `ml/**/Medicine_Images/`) are gitignored. Retraining and dataset handling live in `ml/` — see `ml/README.md`.
