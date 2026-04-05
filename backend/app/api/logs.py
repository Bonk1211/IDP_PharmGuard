"""Adherence log endpoints — record and query intake events."""

from datetime import datetime

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

router = APIRouter()


class IntakeLog(BaseModel):
    patient_id: int
    slot: int
    pill_taken: bool


class IntakeRecord(IntakeLog):
    id: int
    timestamp: datetime


# In-memory store — replace with DB
_logs: list[IntakeRecord] = []
_ws_clients: list[WebSocket] = []


@router.post("/", response_model=IntakeRecord)
async def create_log(log: IntakeLog):
    """Record a new intake event from the Raspberry Pi."""
    record = IntakeRecord(
        id=len(_logs) + 1,
        timestamp=datetime.utcnow(),
        **log.model_dump(),
    )
    _logs.append(record)

    # Broadcast to connected dashboard clients
    for ws in _ws_clients[:]:
        try:
            await ws.send_json(record.model_dump(mode="json"))
        except Exception:
            _ws_clients.remove(ws)

    return record


@router.get("/", response_model=list[IntakeRecord])
async def list_logs(patient_id: int | None = None):
    """Query intake logs, optionally filtered by patient."""
    if patient_id is not None:
        return [r for r in _logs if r.patient_id == patient_id]
    return _logs


@router.websocket("/ws")
async def logs_websocket(ws: WebSocket):
    """WebSocket for real-time intake notifications to the dashboard."""
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            await ws.receive_text()  # Keep connection alive
    except WebSocketDisconnect:
        _ws_clients.remove(ws)
