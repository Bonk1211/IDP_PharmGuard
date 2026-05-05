.PHONY: backend frontend dev setup pi-sync pi-models clean-ml

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

# Sync edge_pi/ to a Raspberry Pi host (usage: make pi-sync HOST=pi@raspberrypi.local)
pi-sync:
	bash edge_pi/scripts/sync_from_dev.sh $(HOST)

# Show sizes of deployed model weights on the Pi runtime side
pi-models:
	@ls -lh edge_pi/models/*.pt

# Print guidance for reclaiming disk used by ML training assets (does not delete)
clean-ml:
	@echo "WARNING: ml/datasets/ and ml/**/Medicine_Images/ are gitignored, run 'rm -rf ml/datasets ml/pill_detector/Medicine_Images' to free disk"
