"""Alerts endpoints — expiry / low-stock / over-temperature surface to the dashboard.

Mirrors the WebSocket broadcast pattern from `backend/app/api/logs.py`. Holds a
private `_ws_clients` list so the alerts wire stays disjoint from the adherence
log wire — every connected dashboard gets each alert row insert pushed within
one async hop.
"""

from __future__ import annotations

import hmac
import logging
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core.config import settings
from app.core.security import verify_device_token
from app.db.base import get_supabase

log = logging.getLogger(__name__)

router = APIRouter()


ALERT_KIND_EXPIRY = "expiry"
ALERT_KIND_LOW_STOCK = "low_stock"
ALERT_KIND_OVER_TEMP = "over_temperature"

SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_CRITICAL = "critical"


class TemperatureSample(BaseModel):
    value_c: float
    dispenser_id: str | None = None


_ws_clients: list[WebSocket] = []


async def _broadcast(record: dict[str, Any]) -> None:
    """Send a record to every connected dashboard client; drop on send error."""
    for ws in _ws_clients[:]:
        try:
            await ws.send_json(record)
        except Exception:
            try:
                _ws_clients.remove(ws)
            except ValueError:
                pass


async def _insert_alert(
    *,
    kind: str,
    severity: str,
    dispenser_id: str | None,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Insert a single alert row and broadcast it to the WS subscribers."""
    sb = get_supabase()
    row = {
        "kind": kind,
        "severity": severity,
        "dispenser_id": dispenser_id,
        "payload": payload,
    }
    result = sb.table("alerts").insert(row).execute()
    record = result.data[0] if result.data else row
    log.info(
        "alert kind=%s severity=%s dispenser=%s",
        kind,
        severity,
        dispenser_id,
    )
    await _broadcast(record)
    return record


@router.get("/", dependencies=[Depends(verify_device_token)])
async def list_alerts(limit: int = 100, kind: str | None = None):
    """Return the most recent alerts, newest first."""
    sb = get_supabase()
    query = (
        sb.table("alerts")
        .select("*")
        .order("created_at", desc=True)
        .limit(limit)
    )
    if kind is not None:
        query = query.eq("kind", kind)
    result = query.execute()
    return result.data or []


@router.post("/temperature", dependencies=[Depends(verify_device_token)])
async def post_temperature(sample: TemperatureSample):
    """Pi-posted temperature sample. Inserts an alert iff over threshold."""
    threshold = settings.over_temp_celsius
    if sample.value_c <= threshold:
        return {
            "alert_created": False,
            "value_c": sample.value_c,
            "threshold_c": threshold,
        }

    payload = {"value_c": sample.value_c, "threshold_c": threshold}
    record = await _insert_alert(
        kind=ALERT_KIND_OVER_TEMP,
        severity=SEVERITY_CRITICAL,
        dispenser_id=sample.dispenser_id,
        payload=payload,
    )
    return {"alert_created": True, "alert": record}


@router.post("/scan", dependencies=[Depends(verify_device_token)])
async def scan_inventory():
    """Walk medications and emit expiry + low-stock alerts.

    Operator-poked. Run as often as the operator wants — hourly, every minute,
    whatever a cron driver is set up for. Does not deduplicate; Phase 7 may
    add an ack/snooze column.
    """
    sb = get_supabase()
    meds = sb.table("medications").select("*").execute()
    rows = meds.data or []

    today = date.today()
    cutoff = today + timedelta(days=settings.expiry_warn_days)

    n_expiry = 0
    n_low_stock = 0

    for m in rows:
        dispenser_id = m.get("dispenser_id")
        slot = m.get("slot")
        name = m.get("name")
        patient_id = m.get("patient_id")

        # Expiry check (only if expiry_date is present).
        expiry_str = m.get("expiry_date")
        expiry: date | None = None
        if expiry_str:
            try:
                expiry = date.fromisoformat(expiry_str)
            except ValueError:
                log.warning(
                    "Bad expiry_date on medication id=%s: %r",
                    m.get("id"),
                    expiry_str,
                )
                expiry = None
        if expiry is not None and expiry <= cutoff:
            severity = SEVERITY_CRITICAL if expiry <= today else SEVERITY_WARNING
            await _insert_alert(
                kind=ALERT_KIND_EXPIRY,
                severity=severity,
                dispenser_id=dispenser_id,
                payload={
                    "medication_id": m.get("id"),
                    "name": name,
                    "slot": slot,
                    "patient_id": patient_id,
                    "expiry_date": expiry_str,
                    "days_until_expiry": (expiry - today).days,
                },
            )
            n_expiry += 1

        # Low-stock check.
        quantity = m.get("quantity")
        if quantity is not None and quantity <= settings.low_stock_threshold:
            severity = SEVERITY_CRITICAL if quantity == 0 else SEVERITY_WARNING
            await _insert_alert(
                kind=ALERT_KIND_LOW_STOCK,
                severity=severity,
                dispenser_id=dispenser_id,
                payload={
                    "medication_id": m.get("id"),
                    "name": name,
                    "slot": slot,
                    "patient_id": patient_id,
                    "quantity": quantity,
                    "threshold": settings.low_stock_threshold,
                },
            )
            n_low_stock += 1

    return {"expiry": n_expiry, "low_stock": n_low_stock, "scanned": len(rows)}


@router.websocket("/ws")
async def alerts_websocket(ws: WebSocket, token: str = Query(...)):
    """WebSocket for real-time alert push. Same auth handshake as logs WS.

    Requires ?token=<device_token> query parameter — HTTPBearer does not
    apply to WebSocket connections natively.
    """
    valid_tokens = settings.device_tokens_set
    if not valid_tokens:
        await ws.close(code=1008)
        return

    authenticated = any(hmac.compare_digest(token, t) for t in valid_tokens)
    if not authenticated:
        await ws.close(code=1008)
        return

    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        try:
            _ws_clients.remove(ws)
        except ValueError:
            pass
