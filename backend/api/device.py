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

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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


@router.get("/intake")
async def intake_state(request: Request):
    """Live state of the 3-step intake-verification game.

    Polled by the dashboard's IntakeGamePanel ~4×/s. Returns an idle
    snapshot when the cycle hasn't reached the swallow phase yet, so
    the UI can render the steps grayed out instead of erroring.
    """
    loop = _get_loop(request)
    state = getattr(loop, "_state", None) if loop else None
    monitor = getattr(state, "monitor", None) if state else None
    if monitor is None:
        # Headless or cycle not yet started — synthesize idle state.
        return {
            "running": False,
            "step_index": 0,
            "total_steps": 3,
            "step_name": "READY",
            "step_label": "Take the pill",
            "instruction": "Waiting for cycle to start",
            "confidence": 0.0,
            "hold_progress": 0.0,
            "face_visible": False,
            "hands_count": 0,
            "history": [],
            "result": None,
            "started_at": None,
            "ended_at": None,
            "updated_at": None,
        }
    return monitor.get_state()


_PILL_DETECTOR_PATH = "models/pill_detector.pt"


def _get_pill_detector(app):
    """Lazy-load and cache models/pill_detector.pt on app.state.

    Separate from PillVerifier's spotter — pill_detector is a multi-class
    pill identifier. The cycle's tray-empty gate still uses spotter.pt;
    this is purely for the live-stream overlay.
    """
    cached = getattr(app.state, "pill_detector_model", None)
    if cached is not None:
        return cached
    from ultralytics import YOLO
    log.info("Loading YOLO pill_detector from %s", _PILL_DETECTOR_PATH)
    model = YOLO(_PILL_DETECTOR_PATH)
    app.state.pill_detector_model = model
    return model


@router.get("/stream/{cam_num}")
async def stream_camera(
    cam_num: int,
    request: Request,
    annotate: bool = Query(
        default=False,
        description="Overlay model output. cam 0 -> YOLO pill_detector boxes, "
                    "cam 1 -> MediaPipe FaceMesh + Hands landmarks.",
    ),
):
    """MJPEG live stream for `cam_num` (0=tray, 1=intake/face).

    Reads frames from the dispense cycle's camera handle (RpicamSource
    keeps a producer thread that fans the single rpicam-vid TCP feed
    out to N consumers).

    `?annotate=1` overlays:
      cam 0 -> YOLO pill_detector.pt bounding boxes (~5 fps; YOLO is
                ~150-200 ms/frame on Pi 5 CPU).
      cam 1 -> MediaPipe FaceMesh + Hands landmarks (~10 fps; uses
                the SAME mp.solutions instances the cycle's IntakeMonitor
                holds, so overlay reflects exactly what the swallow FSM
                sees).

    Auth: X-Device-API-Key header OR ?key=<value> query param.
    Headless mode: cameras not open -> 503.
    """
    if cam_num not in (0, 1):
        raise HTTPException(status_code=404, detail="cam_num must be 0 or 1")
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no cameras")

    state = getattr(loop, "_state", None)
    cam = getattr(state, "cam_a" if cam_num == 0 else "cam_b", None) if state else None
    if cam is None:
        raise HTTPException(status_code=503, detail=f"cam_{cam_num} not open")
    if not hasattr(cam, "latest_frame_jpeg"):
        raise HTTPException(
            status_code=501,
            detail="Camera backend doesn't expose latest_frame_jpeg",
        )

    # ── Decide annotation backend per-camera ───────────────────────────
    do_annotate = bool(annotate)
    pill_detector = None
    monitor = None  # IntakeMonitor — owns _face_mesh + _hands

    if do_annotate and cam_num == 0:
        # Cam 0 → pill_detector.pt (multi-class pill identification).
        pill_detector = await asyncio.to_thread(_get_pill_detector, request.app)
        target_fps = 5
    elif do_annotate and cam_num == 1:
        # Cam 1 → MediaPipe overlay. Reuse the cycle's already-loaded models.
        monitor = getattr(state, "monitor", None) if state else None
        if monitor is None or getattr(monitor, "_face_mesh", None) is None:
            raise HTTPException(
                status_code=503,
                detail="IntakeMonitor not initialised (cycle hasn't started)",
            )
        target_fps = 10
    else:
        target_fps = 15
    frame_interval_s = 1.0 / target_fps

    def _annotate_yolo(frame):
        """Cam 0: run pill_detector, draw boxes, encode JPEG."""
        import cv2
        results = pill_detector(frame, verbose=False)
        annotated = results[0].plot() if results else frame
        ok, jpeg = cv2.imencode(
            ".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), _STREAM_JPEG_QUALITY],
        )
        return jpeg.tobytes() if ok else None

    def _annotate_mediapipe(frame):
        """Cam 1: run FaceMesh + Hands, draw landmarks, encode JPEG."""
        import cv2
        import mediapipe as mp

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face = monitor._face_mesh.process(rgb)
        hands = monitor._hands.process(rgb)
        annotated = frame.copy()

        drawing = mp.solutions.drawing_utils
        drawing_styles = mp.solutions.drawing_styles
        if face.multi_face_landmarks:
            for face_lm in face.multi_face_landmarks:
                drawing.draw_landmarks(
                    annotated, face_lm,
                    mp.solutions.face_mesh.FACEMESH_CONTOURS,
                    landmark_drawing_spec=None,
                    connection_drawing_spec=drawing_styles.get_default_face_mesh_contours_style(),
                )
        if hands.multi_hand_landmarks:
            for hand_lm in hands.multi_hand_landmarks:
                drawing.draw_landmarks(
                    annotated, hand_lm,
                    mp.solutions.hands.HAND_CONNECTIONS,
                    drawing_styles.get_default_hand_landmarks_style(),
                    drawing_styles.get_default_hand_connections_style(),
                )

        # Quick-glance status badge: face / hands counts so the operator
        # can confirm at a glance what the cycle's FSM has to work with.
        fcount = len(face.multi_face_landmarks or [])
        hcount = len(hands.multi_hand_landmarks or [])
        cv2.putText(
            annotated, f"face={fcount} hands={hcount}",
            (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2, cv2.LINE_AA,
        )

        ok, jpeg = cv2.imencode(
            ".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), _STREAM_JPEG_QUALITY],
        )
        return jpeg.tobytes() if ok else None

    async def frame_generator():
        log.info(
            "stream %d: client connected (annotate=%s, target_fps=%d)",
            cam_num, do_annotate, target_fps,
        )
        try:
            while True:
                if await request.is_disconnected():
                    break
                if do_annotate:
                    frame = await asyncio.to_thread(cam.read_frame)
                    if frame is None:
                        await asyncio.sleep(0.05)
                        continue
                    fn = _annotate_yolo if cam_num == 0 else _annotate_mediapipe
                    payload = await asyncio.to_thread(fn, frame)
                else:
                    payload = await asyncio.to_thread(
                        cam.latest_frame_jpeg, _STREAM_JPEG_QUALITY
                    )
                if payload is None:
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
