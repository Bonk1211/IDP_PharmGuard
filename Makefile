.PHONY: backend frontend dev setup pi-sync pi-bootstrap pi-models clean-ml benchmark

# Run backend (FastAPI). On dev-mac, BACKEND_HEADLESS=1 skips the hardware
# lifespan (GPIO + cameras unavailable on darwin) but still serves the API.
backend:
	cd backend && source .venv/bin/activate && BACKEND_HEADLESS=1 uvicorn main:app --reload --port 8000

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

# Sync backend/ to a Raspberry Pi host (usage: make pi-sync HOST=pi@raspberrypi.local)
pi-sync:
	bash backend/scripts/sync_from_dev.sh $(HOST)

# Fresh-Pi bootstrap: rsync → ssh → install.sh → enable service.
# Idempotent (re-running on a configured Pi is safe).
# Usage: make pi-bootstrap HOST=pi@raspberrypi.local
pi-bootstrap:
	@if [ -z "$(HOST)" ]; then echo "ERROR: HOST=pi@<host> required"; exit 1; fi
	bash backend/scripts/sync_from_dev.sh $(HOST)
	@echo ""
	@echo "=== Running install.sh on $(HOST) ==="
	ssh $(HOST) "cd ~/IDP_PharmGuard/backend && bash scripts/install.sh"
	@echo ""
	@echo "=== Enabling pharmguard.service on $(HOST) ==="
	ssh $(HOST) "sudo systemctl enable pharmguard.service"
	@echo ""
	@echo "=== Done. ==="
	@echo "Edit ~/IDP_PharmGuard/backend/.env on the Pi, then:"
	@echo "  ssh $(HOST) 'sudo systemctl restart pharmguard'"

# Show sizes of deployed model weights on the Pi runtime side
pi-models:
	@ls -lh backend/models/*.pt

# Print guidance for reclaiming disk used by ML training assets (does not delete)
clean-ml:
	@echo "WARNING: ml/datasets/ and ml/**/Medicine_Images/ are gitignored, run 'rm -rf ml/datasets ml/pill_detector/Medicine_Images' to free disk"

# Open the market & workforce benchmark notebook (dev-workstation only)
benchmark:
	cd ml/notebooks && jupyter lab benchmark_market_comparison.ipynb
