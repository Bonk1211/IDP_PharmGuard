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

# Force matplotlib (pulled in transitively by mediapipe -> drawing_utils)
# to use the headless Agg backend. Without this it tries to load a Qt /
# Tk GUI backend on import, which on Pi 5 wastes ~10s and ~50 MB. MUST
# come before anything that imports mediapipe (i.e. before vision/* /
# scheduler/cycle_runner). setdefault so the operator can override.
import os
os.environ.setdefault("MPLBACKEND", "Agg")

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import agent, alerts, auth, device, flags, inventory, logs
from config import settings
from scheduler.background import HardwareLoop
from scheduler.brief_scheduler import brief_scheduler_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: validate settings, optionally start HardwareLoop, always
    start the brief-scheduler.

    Shutdown: cancel brief task, then stop HardwareLoop (which awaits
    cleanup of GPIO + cameras).
    """
    settings.validate_runtime()

    # Brief scheduler runs regardless of headless mode — agent endpoints
    # work without hardware. Spawn it FIRST so a HardwareLoop init failure
    # doesn't deny the dashboard its assistant.
    brief_task = asyncio.create_task(
        brief_scheduler_loop(), name="brief_scheduler"
    )
    app.state.brief_task = brief_task
    log.info("Brief scheduler task started")

    if settings.backend_headless:
        log.info("BACKEND_HEADLESS=1 — skipping hardware loop init")
        app.state.hardware_loop = None
        try:
            yield
        finally:
            brief_task.cancel()
            try:
                await brief_task
            except asyncio.CancelledError:
                pass
        return

    loop = HardwareLoop()
    await loop.start()
    app.state.hardware_loop = loop
    log.info("Hardware loop started")
    try:
        yield
    finally:
        log.info("Stopping brief scheduler")
        brief_task.cancel()
        try:
            await brief_task
        except asyncio.CancelledError:
            pass
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

app.include_router(agent.router, prefix="/api/agent", tags=["agent"])
app.include_router(flags.router, prefix="/api/agent/flags", tags=["agent-flags"])
app.include_router(alerts.router, prefix="/api/alerts", tags=["alerts"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(device.router, prefix="/api/device", tags=["device"])
app.include_router(inventory.router, prefix="/api/inventory", tags=["inventory"])
app.include_router(logs.router, prefix="/api/logs", tags=["logs"])


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    # Direct run: `python main.py`. Same entrypoint medispecs uses.
    # No systemd needed for dev / demo. For production, use systemd or
    # a process manager so the loop survives Pi reboots.
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
