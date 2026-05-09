"""PharmGuard Backend — FastAPI application + asyncio hardware supervisor.

Single process: serves the HTTP API AND runs the dispense cycle as a
background asyncio.Task. The lifespan handler builds a HardwareLoop on
startup (which itself raises RuntimeError on HI-012 violations, aborting
uvicorn cleanly) and tears it down on shutdown.

BACKEND_HEADLESS=1 skips the hardware lifespan entirely — used on dev-mac
where there's no GPIO. The HTTP API still serves; /api/device/* endpoints
return 503 in that mode.

Workers MUST stay 1 — RPi.GPIO + picamera2 + lgpio hold per-process
state, so multi-worker uvicorn would fork-corrupt the hardware. The
systemd unit pins --workers 1.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import alerts, auth, device, inventory, logs
from config import settings
from scheduler.background import HardwareLoop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: validate settings, optionally start HardwareLoop.
    Shutdown: stop HardwareLoop (which awaits cleanup of GPIO + cameras).
    """
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


app = FastAPI(
    title="PharmGuard",
    description="Medical IoT medication dispensing & adherence tracking",
    version="0.2.0",
    lifespan=lifespan,
)

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
