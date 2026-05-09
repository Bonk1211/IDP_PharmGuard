"""Frontend control endpoints — gated by X-Device-API-Key.

Path: /api/device/*
Caller: dashboard via ngrok->Pi (see frontend/src/lib/device.ts).

These endpoints exist BECAUSE the dispense cycle now runs in-process;
without them the dashboard would have no way to trigger an out-of-cycle
dispense, read live device state, or stream the cameras.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from core.security import verify_device_api_key

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_device_api_key)])

# rpicam-vid TCP ports used by vision/camera.py:RpicamSource. The
# streaming endpoint connects a SECOND cv2 consumer to the same TCP —
# rpicam-vid's `-l` (listen) flag accepts multiple readers, so the
# cycle and the live stream share the broadcast.
_RPICAM_TCP_BASE_PORT = 8888
_STREAM_JPEG_QUALITY = 70


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


@router.get("/stream/{cam_num}")
async def stream_camera(cam_num: int, request: Request):
    """MJPEG live stream for `cam_num` (0=tray, 1=intake/face).

    Reads frames from the dispense cycle's camera handle (a producer
    thread inside RpicamSource fans the single rpicam-vid TCP feed out
    to N consumers — the cycle and any number of /stream/* clients).

    Returns multipart/x-mixed-replace which browsers render natively in
    an <img> tag. Frame rate matches rpicam-vid (~15 fps); each frame
    is JPEG-encoded at quality 70.

    Auth: same X-Device-API-Key as the rest of /api/device/*. For
    browser <img> tags (which can't set headers) pass `?key=<value>`.

    Headless mode (BACKEND_HEADLESS=1): cameras aren't open, returns 503.
    """
    if cam_num not in (0, 1):
        raise HTTPException(status_code=404, detail="cam_num must be 0 or 1")
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no cameras")

    # Pull the camera handle that the cycle already opened. This is the
    # SAME RpicamSource instance the dispense cycle uses for pill_id —
    # its internal producer thread keeps the latest frame slot fresh.
    state = getattr(loop, "_state", None)
    cam = getattr(state, "cam_a" if cam_num == 0 else "cam_b", None) if state else None
    if cam is None:
        raise HTTPException(status_code=503, detail=f"cam_{cam_num} not open")
    if not hasattr(cam, "latest_frame_jpeg"):
        # Cv2Source / Picamera2Source don't (yet) implement the multi-consumer
        # buffer. Should never happen on Pi 5 + rpicam-vid path.
        raise HTTPException(
            status_code=501,
            detail="Camera backend doesn't expose latest_frame_jpeg",
        )

    # Cap stream framerate — no point sending faster than rpicam-vid produces.
    target_fps = 15
    frame_interval_s = 1.0 / target_fps

    async def frame_generator():
        log.info("stream %d: client connected", cam_num)
        try:
            while True:
                if await request.is_disconnected():
                    break
                payload = await asyncio.to_thread(
                    cam.latest_frame_jpeg, _STREAM_JPEG_QUALITY
                )
                if payload is None:
                    # First frame not yet captured by the producer thread.
                    await asyncio.sleep(0.05)
                    continue
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(payload)).encode() + b"\r\n\r\n"
                    + payload + b"\r\n"
                )
                await asyncio.sleep(frame_interval_s)
        finally:
            log.info("stream %d: client disconnected", cam_num)

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
