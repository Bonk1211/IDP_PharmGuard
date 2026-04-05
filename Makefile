.PHONY: backend frontend dev setup

# Run backend (FastAPI)
backend:
	cd backend && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000

# Run frontend (Next.js)
frontend:
	cd frontend && npm run dev

# Run both together
dev:
	@echo "Starting backend and frontend..."
	@make backend & make frontend & wait

# First-time setup
setup:
	cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
	cd frontend && npm install
	@echo "\nDone! Copy .env.example files and fill in your keys:"
	@echo "  cp backend/.env.example backend/.env"
	@echo "  cp frontend/.env.local.example frontend/.env.local"
