"""Adherence log endpoints — record and query intake events."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.db.base import get_supabase

router = APIRouter()


class IntakeLog(BaseModel):
    patient_id: int
    slot: int
    pill_taken: bool


_ws_clients: list[WebSocket] = []


@router.post("/")
async def create_log(log: IntakeLog):
    """Record a new intake event from the Raspberry Pi."""
    sb = get_supabase()
    result = (
        sb.table("adherence_logs")
        .insert(log.model_dump())
        .execute()
    )
    record = result.data[0]

    # Broadcast to connected dashboard clients
    for ws in _ws_clients[:]:
        try:
            await ws.send_json(record)
        except Exception:
            _ws_clients.remove(ws)

    # Decrement medication quantity
    med = sb.table("medications").select("quantity").eq("slot", log.slot).execute()
    if med.data and med.data[0]["quantity"] > 0:
        sb.table("medications").update(
            {"quantity": med.data[0]["quantity"] - 1}
        ).eq("slot", log.slot).execute()

    return record


@router.get("/")
async def list_logs(patient_id: int | None = None):
    """Query intake logs, optionally filtered by patient."""
    sb = get_supabase()
    query = sb.table("adherence_logs").select("*").order("timestamp", desc=True)
    if patient_id is not None:
        query = query.eq("patient_id", patient_id)
    result = query.execute()
    return result.data


@router.websocket("/ws")
async def logs_websocket(ws: WebSocket):
    """WebSocket for real-time intake notifications to the dashboard."""
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        _ws_clients.remove(ws)
