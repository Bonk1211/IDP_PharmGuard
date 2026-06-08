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
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from core.log_ring import get_ring
from core.security import verify_device_api_key
from db.base import get_supabase

log = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(verify_device_api_key)])

# rpicam-vid TCP ports used by vision/camera.py:RpicamSource. The
# streaming endpoint connects a SECOND cv2 consumer to the same TCP —
# rpicam-vid's `-l` (listen) flag accepts multiple readers, so the
# cycle and the live stream share the broadcast.
_RPICAM_TCP_BASE_PORT = 8888
_STREAM_JPEG_QUALITY = 70

# Dummy drawer state for the demo lock/unlock button. The SG90 servo was
# pulled out of the dispense control flow (scheduler/cycle_runner.py); the
# /api/device/drawer endpoint now just flips this in-memory flag and the
# frontend renders it. No GPIO is touched. Process-local, resets on restart.
_dummy_drawer_unlocked = False


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
            "is_unlocked": False,
        }
    try:
        base = loop.status()
    except Exception:
        log.exception("loop.status() raised")
        base = {
            "headless": False,
            "hardware_stubbed": True,
            "cycle_n": 0,
            "last_cycle": None,
            "task_running": False,
        }
    # Drawer SG90 removed from the control flow — report the demo flag.
    base["is_unlocked"] = _dummy_drawer_unlocked
    return base


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


# ─────────────────── manual hardware ops (X-Device-API-Key) ─────────────────


class EjectBody(BaseModel):
    slot: int = Field(ge=0, le=9, description="Magazine slot to rotate to before eject.")


@router.post("/eject")
async def manual_eject(body: EjectBody, request: Request):
    """Rotate the magazine to ``slot`` and run one ejector push.

    Raw mechanical test. No DB read or write. Drawer is NOT opened.
    Serializes with the cycle via ``app.state.hardware_lock`` so two
    threads never drive the GPIO at once.
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
    state = getattr(loop, "_state", None)
    if state is None or state.magazine is None or state.ejector is None:
        raise HTTPException(status_code=503, detail="Hardware not initialised")
    lock: asyncio.Lock = request.app.state.hardware_lock
    t0 = time.monotonic()
    async with lock:
        await asyncio.to_thread(state.magazine.rotate_to, body.slot)
        await asyncio.to_thread(state.ejector.push)
    latency_ms = int((time.monotonic() - t0) * 1000)
    log.info("manual eject: slot=%d latency_ms=%d", body.slot, latency_ms)
    return {"ok": True, "slot": body.slot, "latency_ms": latency_ms}


class RotateBody(BaseModel):
    slot: int = Field(ge=0, le=9, description="Target magazine slot (0-9).")


@router.post("/rotate")
async def manual_rotate(body: RotateBody, request: Request):
    """Rotate the magazine to ``slot`` without ejecting.

    Bench-test endpoint mirroring hardware/test_magazine.py. Uses the
    same ``state.magazine.rotate_to`` path the dispense cycle uses, so
    if this works the cycle's rotation works too. Serialized with the
    cycle via ``app.state.hardware_lock``.
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no hardware loop")
    state = getattr(loop, "_state", None)
    if state is None or state.magazine is None:
        raise HTTPException(status_code=503, detail="Magazine not initialised")
    lock: asyncio.Lock = request.app.state.hardware_lock
    t0 = time.monotonic()
    async with lock:
        await asyncio.to_thread(state.magazine.rotate_to, body.slot)
    latency_ms = int((time.monotonic() - t0) * 1000)
    log.info("manual rotate: slot=%d latency_ms=%d", body.slot, latency_ms)
    return {
        "ok": True,
        "slot": body.slot,
        "current_slot": state.magazine.current_slot,
        "latency_ms": latency_ms,
    }


class DrawerBody(BaseModel):
    action: Literal["lock", "unlock"]


@router.post("/drawer")
async def manual_drawer(body: DrawerBody):
    """Demo drawer toggle — flips an in-memory flag, no SG90 servo.

    The drawer lock was removed from the dispense control flow. This
    endpoint exists only so the dashboard's lock/unlock button has
    something to call; it touches no GPIO and works in headless mode.
    """
    global _dummy_drawer_unlocked
    _dummy_drawer_unlocked = body.action == "unlock"
    log.info("demo drawer: action=%s (no servo)", body.action)
    return {"ok": True, "action": body.action, "is_unlocked": _dummy_drawer_unlocked}


# ─────────────────── pill verification (post-eject) ────────────────────


class VerifyPillBody(BaseModel):
    # Caller's expected medication name (matched case/space/underscore
    # insensitive against the YOLO class label). Optional — without it
    # the endpoint still returns the top detection but match is null.
    expected: str | None = None


@router.post("/verify_pill")
async def verify_pill(body: VerifyPillBody, request: Request):
    """Grab one frame from cam_0, run pill_detector, and return the top
    detection together with an annotated snapshot the UI can render.

    Used by the Dispense step in the dashboard: after the operator hits
    Eject, the UI calls this to confirm what landed on the tray and
    score it against the expected medication.
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no cameras")
    state = getattr(loop, "_state", None)
    cam = getattr(state, "cam_a", None) if state else None
    if cam is None or not hasattr(cam, "read_frame"):
        raise HTTPException(status_code=503, detail="cam_0 not open")

    t0 = time.monotonic()
    frame = await asyncio.to_thread(cam.read_frame)
    if frame is None:
        raise HTTPException(status_code=503, detail="No frame available")

    detector = await asyncio.to_thread(_get_pill_detector, request.app)

    def _run():
        import base64
        import cv2

        results = detector(frame, verbose=False)
        r0 = results[0] if results else None
        detections: list[dict] = []
        if r0 is not None and getattr(r0, "boxes", None) is not None:
            names = getattr(r0, "names", {}) or {}
            for box in r0.boxes:
                cls_idx = (
                    int(box.cls.item()) if hasattr(box.cls, "item") else int(box.cls)
                )
                conf = (
                    float(box.conf.item())
                    if hasattr(box.conf, "item")
                    else float(box.conf)
                )
                xyxy = (
                    box.xyxy[0].tolist()
                    if hasattr(box.xyxy, "tolist")
                    else list(box.xyxy[0])
                )
                detections.append(
                    {
                        "class_name": names.get(cls_idx, str(cls_idx)),
                        "confidence": round(conf, 4),
                        "bbox": [round(float(v), 1) for v in xyxy],
                    }
                )
        annotated = r0.plot() if r0 is not None else frame
        ok, jpeg = cv2.imencode(
            ".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 85]
        )
        b64 = base64.b64encode(jpeg.tobytes()).decode("ascii") if ok else None
        return detections, b64

    detections, snapshot_b64 = await asyncio.to_thread(_run)
    detections.sort(key=lambda d: d["confidence"], reverse=True)
    top = detections[0] if detections else None

    expected = (body.expected or "").strip() or None
    match: bool | None = None
    if top is not None and expected is not None:
        # Tolerate case + whitespace + underscores so "Lomide capsule"
        # matches the YOLO class label "Lomide_capsule".
        def _norm(s: str) -> str:
            return s.lower().replace(" ", "").replace("_", "")

        match = _norm(top["class_name"]) == _norm(expected)

    latency_ms = int((time.monotonic() - t0) * 1000)
    log.info(
        "verify_pill: top=%s conf=%.2f expected=%s match=%s latency_ms=%d",
        top["class_name"] if top else None,
        top["confidence"] if top else 0.0,
        expected,
        match,
        latency_ms,
    )
    return {
        "ok": True,
        "expected": expected,
        "top": top,
        "match": match,
        "detections": detections,
        "snapshot_b64": snapshot_b64,
        "latency_ms": latency_ms,
    }


# ─────────────────── Layer-1 face verify (AWS CompareFaces) ────────────


class VerifyFaceBody(BaseModel):
    patient_id: int = Field(ge=1, description="patients.id whose reference photo to compare.")


@router.post("/verify_face")
async def verify_face(body: VerifyFaceBody, request: Request):
    """Compare one frame from cam_b against the patient's reference photo.

    Flow: load patients.face_reference_url → download bytes → grab a
    cam_b frame → JPEG encode → Rekognition CompareFaces → return verdict.

    Errors:
      503 — headless mode or cam_b not open
      404 — patient_id not found
      400 — patient has no face_reference_url uploaded yet
      502 — reference photo URL fetch failed (network / 404 / RLS)

    Soft-fail (200 with ``error`` populated) — AWS-side failure (missing
    creds, throttling, no face detected). UI shows the error inline and
    blocks the Next step until a successful compare.
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no cameras")
    state = getattr(loop, "_state", None)
    cam = getattr(state, "cam_b", None) if state else None
    if cam is None or not hasattr(cam, "read_frame"):
        raise HTTPException(status_code=503, detail="cam_1 not open")

    sb = get_supabase()

    def _fetch_patient():
        return (
            sb.table("patients")
            .select("id, name, face_reference_url")
            .eq("id", body.patient_id)
            .execute()
        )

    result = await asyncio.to_thread(_fetch_patient)
    rows = result.data or []
    if not rows:
        raise HTTPException(status_code=404, detail=f"patient {body.patient_id} not found")
    ref_url = rows[0].get("face_reference_url")
    if not ref_url:
        raise HTTPException(
            status_code=400,
            detail="patient has no face_reference_url — upload a reference photo first",
        )

    import requests

    def _fetch_ref() -> bytes:
        r = requests.get(ref_url, timeout=5)
        r.raise_for_status()
        return r.content

    try:
        ref_bytes = await asyncio.to_thread(_fetch_ref)
    except Exception as exc:
        log.warning("face reference fetch failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"reference fetch failed: {exc}")

    t0 = time.monotonic()
    frame = await asyncio.to_thread(cam.read_frame)
    if frame is None:
        raise HTTPException(status_code=503, detail="No frame available")

    from services.face_verify import compare_faces, encode_frame_jpeg

    live_bytes = await asyncio.to_thread(encode_frame_jpeg, frame)
    verdict = await asyncio.to_thread(
        compare_faces,
        ref_bytes,
        live_bytes,
        float(settings.face_similarity_threshold),
    )
    latency_ms = int((time.monotonic() - t0) * 1000)

    # Encode the live frame for the dashboard so the operator sees the
    # exact image AWS scored (not a fresh frame taken seconds later).
    import base64
    snapshot_b64 = base64.b64encode(live_bytes).decode("ascii")

    log.info(
        "verify_face: patient=%d match=%s similarity=%s latency_ms=%d err=%s",
        body.patient_id,
        verdict["match"],
        verdict["similarity"],
        latency_ms,
        verdict["error"],
    )
    return {
        "ok": verdict["error"] is None,
        "patient_id": body.patient_id,
        "patient_name": rows[0].get("name"),
        "match": bool(verdict["match"]),
        "similarity": verdict["similarity"],
        "threshold": float(settings.face_similarity_threshold),
        "bbox": verdict.get("bbox"),
        "snapshot_b64": snapshot_b64,
        "error": verdict["error"],
        "latency_ms": latency_ms,
    }


@router.get("/snapshot")
async def camera_snapshot(
    request: Request,
    cam: int = Query(..., ge=0, le=1, description="0=tray, 1=intake"),
):
    """Single JPEG frame from the requested camera. No streaming.

    Reuses the cycle's already-open camera (RpicamSource fan-out).
    Snapshot quality fixed at 80 to keep the payload small.
    """
    loop = _get_loop(request)
    if loop is None:
        raise HTTPException(status_code=503, detail="Headless mode — no cameras")
    state = getattr(loop, "_state", None)
    cam_obj = getattr(state, "cam_a" if cam == 0 else "cam_b", None) if state else None
    if cam_obj is None:
        raise HTTPException(status_code=503, detail=f"cam_{cam} not open")
    if not hasattr(cam_obj, "latest_frame_jpeg"):
        raise HTTPException(status_code=501, detail="Camera backend lacks latest_frame_jpeg")
    jpeg = await asyncio.to_thread(cam_obj.latest_frame_jpeg, 80)
    if jpeg is None:
        raise HTTPException(status_code=503, detail="No frame available yet")
    return Response(content=jpeg, media_type="image/jpeg")


@router.get("/logs")
async def recent_logs(n: int = Query(default=200, ge=1, le=500)):
    """Last N log records from the in-memory ring buffer (newest first)."""
    ring = get_ring()
    if ring is None:
        return {"records": [], "note": "ring buffer not installed"}
    return {"records": ring.snapshot(n)}


# ─────────────────────── per-slot daily dispense schedules ───────────────────


class ScheduleBody(BaseModel):
    slot: int = Field(ge=0, le=9)
    # "HH:MM" 24h. None / "" clears the schedule.
    schedule_at: str | None = None


@router.get("/schedules")
async def list_schedules():
    """List all medications with the slot, name, patient_id, and current
    schedule_at. Powers the /admin Schedule section.
    """
    sb = get_supabase()
    def _query():
        return (
            sb.table("medications")
            .select("id, slot, name, patient_id, dispenser_id, quantity, schedule_at")
            .order("slot")
            .execute()
        )
    result = await asyncio.to_thread(_query)
    return result.data or []


@router.post("/schedule")
async def set_schedule(body: ScheduleBody):
    """Set or clear the daily dispense time for a slot.

    `schedule_at`: "HH:MM" enables auto-dispense at that time daily.
    null or "" clears the schedule (slot becomes manual-only).
    """
    raw = (body.schedule_at or "").strip()
    parsed: str | None
    if raw == "":
        parsed = None
    else:
        try:
            hh, mm = raw.split(":", 1)
            h = int(hh)
            m = int(mm[:2])
            if not (0 <= h < 24 and 0 <= m < 60):
                raise ValueError
            parsed = f"{h:02d}:{m:02d}:00"
        except (ValueError, IndexError):
            raise HTTPException(
                status_code=400,
                detail="schedule_at must be HH:MM (24h) or null",
            )
    sb = get_supabase()
    def _update():
        return (
            sb.table("medications")
            .update({"schedule_at": parsed})
            .eq("slot", body.slot)
            .execute()
        )
    result = await asyncio.to_thread(_update)
    if not result.data:
        raise HTTPException(status_code=404, detail=f"slot {body.slot} not found")
    log.info("schedule set: slot=%d at=%s", body.slot, parsed)
    return {"ok": True, "slot": body.slot, "schedule_at": parsed}


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
        # Headless or cycle not yet started — synthesize idle state. Keep
        # shape in sync with vision/intake_monitor.py:_initial_state so the
        # frontend's IntakeState type lines up in headless mode too.
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
            # Layer-2 (DetectLabels) fields — empty/false in headless mode.
            "labels_seen": [],
            "labels_seen_at": {},
            "labels_required": [],
            "labels_satisfied": False,
            "mediapipe_complete": False,
            "labels_inflight": False,
            "labels_last_call_at": None,
        }
    return monitor.get_state()


class IntakeStartBody(BaseModel):
    # How long the FSM may run before timing out (seconds). Matches the
    # default the cycle uses in cycle_runner.
    timeout_s: float = Field(default=60.0, gt=0, le=300)


@router.post("/intake/start", status_code=202)
async def start_intake(body: IntakeStartBody, request: Request):
    """Kick the IntakeMonitor's swallow-watch loop in a background task.

    Mirrors what the cycle runner does at the swallow phase, but exposes
    it to the dashboard so a manual eject flow can still drive the
    intake FSM without queuing a full new dispense cycle.

    Idempotent-on-running: if a watch is already in flight (either from
    the cycle or a previous call), returns ``already_running: True``
    instead of starting a second loop on the same monitor.
    """
    loop = _get_loop(request)
    state = getattr(loop, "_state", None) if loop else None
    monitor = getattr(state, "monitor", None) if state else None
    if monitor is None:
        raise HTTPException(
            status_code=503,
            detail="IntakeMonitor not initialised (cycle hasn't started)",
        )

    snapshot = monitor.get_state()
    if snapshot.get("running"):
        return {"ok": True, "already_running": True, "timeout_s": body.timeout_s}

    existing: asyncio.Task | None = getattr(
        request.app.state, "intake_watch_task", None
    )
    if existing is not None and not existing.done():
        return {"ok": True, "already_running": True, "timeout_s": body.timeout_s}

    async def _run() -> None:
        try:
            await asyncio.to_thread(monitor.watch_for_swallow, body.timeout_s)
        except Exception:
            log.exception("intake/start: watch_for_swallow raised")

    task = asyncio.create_task(_run(), name="intake-watch")
    request.app.state.intake_watch_task = task
    log.info("intake/start: launched watch_for_swallow(timeout_s=%.1f)", body.timeout_s)
    return {"ok": True, "already_running": False, "timeout_s": body.timeout_s}


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


def _get_stream_mediapipe(app):
    """Lazy MediaPipe FaceMesh + Hands instances dedicated to the
    stream-overlay path.

    Deliberately separate from IntakeMonitor's instances: MediaPipe is
    not thread-safe, and the cycle's watch_for_swallow holds the
    monitor's instances on its own thread while the stream is also
    rendering frames. Sharing instances across the two threads stalls
    the stream and shows up in the browser as a black/broken cam 1.
    """
    cached = getattr(app.state, "stream_mediapipe", None)
    if cached is not None:
        return cached
    import mediapipe as mp

    log.info("Loading stream-overlay MediaPipe instances")
    face = mp.solutions.face_mesh.FaceMesh(
        max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5,
    )
    hands = mp.solutions.hands.Hands(
        max_num_hands=2, min_detection_confidence=0.5,
    )
    cached = (face, hands)
    app.state.stream_mediapipe = cached
    return cached


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
    # Captured by _annotate_mediapipe (cam 1 HUD). None when cycle hasn't
    # built the monitor yet — HUD then just shows the MediaPipe row from
    # the stream-dedicated face/hands instances and skips Layer-2.
    monitor = getattr(state, "monitor", None) if state else None
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
    stream_face = None
    stream_hands = None

    if do_annotate and cam_num == 0:
        # Cam 0 → pill_detector.pt (multi-class pill identification).
        pill_detector = await asyncio.to_thread(_get_pill_detector, request.app)
        target_fps = 5
    elif do_annotate and cam_num == 1:
        # Cam 1 → MediaPipe overlay using stream-dedicated instances so
        # we never race the cycle's IntakeMonitor on its own models
        # (sharing stalls the stream — see _get_stream_mediapipe docstring).
        stream_face, stream_hands = await asyncio.to_thread(
            _get_stream_mediapipe, request.app
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
        """Cam 1: run FaceMesh + Hands, draw landmarks, encode JPEG.

        cam_b is opened with output_format='rgb' (see cycle_runner) so
        ``frame`` is already RGB — pass straight to MediaPipe and convert
        to BGR once for cv2 drawing/encoding.
        """
        import cv2
        import mediapipe as mp

        face = stream_face.process(frame)
        hands = stream_hands.process(frame)
        # cv2 draw + imencode expect BGR — single convert here.
        annotated = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)

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

        # ── Stacked HUD: L1 MediaPipe row + L2 AWS DetectLabels row ────
        # Both layers run in parallel during watch_for_swallow (MediaPipe
        # on the watch thread, DetectLabels on a 2-worker ThreadPoolExecutor).
        # The HUD makes that parallelism visible on the cam 1 stream so
        # the operator can see both verdicts converge in real time.
        fcount = len(face.multi_face_landmarks or [])
        hcount = len(hands.multi_hand_landmarks or [])
        h, w = annotated.shape[:2]
        snap = monitor.get_state() if monitor is not None else {}

        # Translucent backdrop for legibility over noisy frames.
        overlay = annotated.copy()
        cv2.rectangle(overlay, (0, 0), (w, 68), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.45, annotated, 0.55, 0, annotated)

        # ── L1: MediaPipe FSM ──────────────────────────────────────────
        step_idx = int(snap.get("step_index", 0) or 0)
        total_steps = int(snap.get("total_steps", 3) or 3)
        confidence = float(snap.get("confidence", 0.0) or 0.0)
        mp_complete = bool(snap.get("mediapipe_complete", False))
        result = snap.get("result")
        if mp_complete or result == "passed":
            l1_color = (0, 220, 0)
            l1_state = "DONE"
        elif result in ("timeout", "missing_labels"):
            l1_color = (0, 200, 200)
            l1_state = "DONE"
        else:
            l1_color = (0, 255, 255)
            l1_state = "live"
        cv2.putText(
            annotated,
            f"L1 mediapipe {l1_state} step={step_idx + 1}/{total_steps} "
            f"conf={confidence:.2f} face={fcount} hands={hcount}",
            (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.5, l1_color, 1, cv2.LINE_AA,
        )

        # ── L2: AWS Rekognition DetectLabels ───────────────────────────
        required = snap.get("labels_required") or []
        seen_at = snap.get("labels_seen_at") or {}
        labels_satisfied = bool(snap.get("labels_satisfied", False))
        inflight = bool(snap.get("labels_inflight", False))
        last_call_at = snap.get("labels_last_call_at")
        if not required:
            l2_text = "L2 aws-labels disabled"
            l2_color = (160, 160, 160)
        else:
            chips = []
            for req in required:
                marker = "[+]" if req in seen_at else "[-]"
                chips.append(f"{marker}{req}")
            tag = "OK" if labels_satisfied else ("call" if inflight else "wait")
            age_s = (time.time() - last_call_at) if last_call_at else None
            age_str = f" +{age_s:.1f}s" if age_s is not None else ""
            l2_text = f"L2 aws-labels {tag}{age_str} " + " ".join(chips)
            l2_color = (0, 220, 0) if labels_satisfied else (
                (0, 255, 255) if inflight else (0, 165, 255)
            )
        cv2.putText(
            annotated, l2_text,
            (8, 44), cv2.FONT_HERSHEY_SIMPLEX, 0.45, l2_color, 1, cv2.LINE_AA,
        )

        # Inflight pulse — small filled circle blinks while a DetectLabels
        # call is mid-flight on the ThreadPoolExecutor. Position on the
        # top-right so it's easy to spot at a glance.
        if inflight:
            cv2.circle(annotated, (w - 16, 16), 6, (0, 255, 255), -1, cv2.LINE_AA)

        # Terminal banner — PASS / MISS / TIMEOUT in the bottom-left so
        # the operator sees the final verdict without leaving cam 1.
        terminal_label = None
        terminal_color = (255, 255, 255)
        if result == "passed":
            terminal_label = "PASS  (L1 + L2)"
            terminal_color = (0, 220, 0)
        elif result == "missing_labels":
            terminal_label = "MISS labels (L1 ok, L2 fail)"
            terminal_color = (0, 165, 255)
        elif result == "timeout":
            terminal_label = "TIMEOUT (L1 fail)"
            terminal_color = (0, 0, 255)
        if terminal_label is not None:
            cv2.putText(
                annotated, terminal_label,
                (8, h - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.6, terminal_color, 2,
                cv2.LINE_AA,
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
