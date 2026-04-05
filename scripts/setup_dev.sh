#!/usr/bin/env bash
# Quick dev environment setup for PharmGuard
set -euo pipefail

echo "=== PharmGuard Dev Setup ==="

# Backend
echo "[1/3] Setting up backend..."
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  -> Created backend/.env from .env.example (edit with your keys)"
fi
deactivate
cd ..

# Dashboard
echo "[2/3] Setting up dashboard..."
cd dashboard
npm install
cd ..

echo "[3/3] Done! To start development:"
echo "  Backend:   cd backend && source .venv/bin/activate && uvicorn app.main:app --reload"
echo "  Dashboard: cd dashboard && npm run dev"
