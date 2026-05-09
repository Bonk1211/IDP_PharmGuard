"""Frontend control endpoints — gated by X-Device-API-Key.

Path: /api/device/*
Caller: dashboard via ngrok->Pi (see frontend/src/lib/device.ts).

These endpoints exist BECAUSE the dispense cycle now runs in-process;
without them the dashboard would have no way to trigger an out-of-cycle
dispense or read live device state.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from core.security import verify_device_api_key

router = APIRouter(dependencies=[Depends(verify_device_api_key)])


def _get_loop(request: Request):
    """Return the HardwareLoop instance, or None when in headless mode."""
    return getattr(request.app.state, "hardware_loop", None)


@router.get("/status")
async def device_status(request: Request):
    """Return hardware loop snapshot. Always 200 — headless mode is a normal state."""
    loop = _get_loop(request)
    if loop is None:
        return {
            "headless": True,
            "hardware_stubbed": True,
            "cycle_n": 0,
            "last_cycle": None,
            "task_running": False,
        }
    return loop.status()


@router.post("/dispense_now", status_code=202)
async def dispense_now(request: Request):
    """Wake the supervisor early so the next cycle runs immediately.

    202 Accepted — the cycle has been queued, not yet completed. Poll
    /status to see when it lands (cycle_n increments).
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
    loop.trigger_dispense_now()
    return {"queued": True}


@router.post("/reset")
async def reset(request: Request):
    """Hard-reset: stop the loop (cleanup runs) then start a fresh CycleState.

    Used to recover from a wedged GPIO / camera state without restarting
    the whole uvicorn process.
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
    await loop.stop()
    await loop.start()
    request.app.state.hardware_loop = loop
    return {"reset": True}
