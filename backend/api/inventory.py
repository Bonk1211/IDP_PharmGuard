"""Inventory endpoints — manage the 10-slot magazine per dispenser."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.security import verify_device_token
from db.base import get_supabase

router = APIRouter()


class SlotUpdate(BaseModel):
    medication_name: str
    quantity: int
    patient_id: int
    expiry_date: str | None = None       # ISO-8601 YYYY-MM-DD; Postgres casts text → date
    pills_per_dose: int = 1
    dispenser_id: str | None = None


class DispenseByName(BaseModel):
    """YOLO sees a pill, classifies it, hits this endpoint with the class
    label from the model. Backend resolves the slot + decrements quantity.
    Used by the real-time demo where pill identity (not slot) is the input.
    """

    # Must match `medications.name` exactly. Demo classes:
    # Chloramine | Clarinase | Lomide_capsule | Paracetamol | Stadeltine.
    medication_name: str = Field(min_length=1, max_length=100)
    dispenser_id: str | None = None
    # Optional override; default decrements by `pills_per_dose` from DB.
    decrement: int | None = Field(default=None, ge=1, le=10)
    # YOLO best-detection confidence — informational only (not persisted
    # here; pair with POST /api/logs to record an adherence event).
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


@router.get("/", dependencies=[Depends(verify_device_token)])
async def list_slots():
    """Return the current state of all 10 magazine slots."""
    sb = get_supabase()
    result = await asyncio.to_thread(
        lambda: sb.table("medications").select("*").order("slot").execute()
    )
    return result.data


@router.get("/next-dispense", dependencies=[Depends(verify_device_token)])
async def next_dispense(dispenser_id: str | None = None):
    """
    Determine the next slot that needs dispensing.
    Called by the Raspberry Pi in its polling loop.

    If `dispenser_id` is provided, restricts the search to rows tagged with
    that dispenser. Bench runs (BENCH_MODE=1 on the Pi) rely on this to
    isolate from production rows. Backwards-compat when omitted.
    """
    sb = get_supabase()
    def _query():
        q = (
            sb.table("medications")
            .select("*")
            .gt("quantity", 0)
            .not_.is_("patient_id", "null")
        )
        if dispenser_id is not None:
            q = q.eq("dispenser_id", dispenser_id)
        return q.limit(1).execute()
    result = await asyncio.to_thread(_query)
    if not result.data:
        raise HTTPException(status_code=404, detail="No pending dispenses")

    med = result.data[0]
    return {
        "patient_id": med["patient_id"],
        "slot": med["slot"],
        "medication": med["name"],
        "expiry_date": med.get("expiry_date"),
        "pills_per_dose": med.get("pills_per_dose", 1),
        "dispenser_id": med.get("dispenser_id"),
    }


@router.get("/{slot}", dependencies=[Depends(verify_device_token)])
async def get_slot(slot: int):
    sb = get_supabase()
    result = await asyncio.to_thread(
        lambda: sb.table("medications").select("*").eq("slot", slot).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Slot not found")
    return result.data[0]


@router.put("/{slot}", dependencies=[Depends(verify_device_token)])
async def update_slot(slot: int, data: SlotUpdate):
    """Assign a medication + patient to a magazine slot (refill operation)."""
    if slot < 0 or slot > 9:
        raise HTTPException(status_code=400, detail="Slot must be 0-9")

    sb = get_supabase()
    payload = {
        "name": data.medication_name,
        "slot": slot,
        "quantity": data.quantity,
        "patient_id": data.patient_id,
        "expiry_date": data.expiry_date,
        "pills_per_dose": data.pills_per_dose,
        "dispenser_id": data.dispenser_id,
    }

    # Upsert: update if slot exists, insert if not.
    result = await asyncio.to_thread(
        lambda: sb.table("medications").select("id").eq("slot", slot).execute()
    )
    if result.data:
        resp = await asyncio.to_thread(
            lambda: sb.table("medications").update(payload).eq("slot", slot).execute()
        )
    else:
        resp = await asyncio.to_thread(
            lambda: sb.table("medications").insert(payload).execute()
        )

    return resp.data[0] if resp.data else payload


@router.post("/dispense-by-name", dependencies=[Depends(verify_device_token)])
async def dispense_by_name(body: DispenseByName):
    """Decrement quantity for the medication matching `body.medication_name`.

    Demo flow: the Pi runs YOLO pill_detector on the tray cam → posts the
    detected class label here → backend resolves slot via
    ``medications.name = <label>`` and decrements ``quantity``.

    Filters by ``dispenser_id`` when provided so multi-tenant deployments
    target the correct row. The decrement is clamped at 0 server-side
    (no negative quantities).

    Returns 404 if the medication isn't loaded in any slot.
    Returns 409 if the slot is already empty (no decrement performed).
    """
    sb = get_supabase()

    def _lookup():
        q = (
            sb.table("medications")
            .select("*")
            .eq("name", body.medication_name)
        )
        if body.dispenser_id is not None:
            q = q.eq("dispenser_id", body.dispenser_id)
        return q.limit(1).execute()

    result = await asyncio.to_thread(_lookup)
    if not result.data:
        raise HTTPException(
            status_code=404,
            detail=f"No slot loaded with medication '{body.medication_name}'",
        )
    med = result.data[0]
    current_qty: int = int(med.get("quantity") or 0)
    if current_qty <= 0:
        raise HTTPException(
            status_code=409,
            detail=f"Slot {med['slot']} ({body.medication_name}) is already empty",
        )

    step = body.decrement or int(med.get("pills_per_dose") or 1)
    new_qty = max(0, current_qty - step)
    med_id = med["id"]

    def _update():
        return (
            sb.table("medications")
            .update({"quantity": new_qty})
            .eq("id", med_id)
            .execute()
        )

    update_result = await asyncio.to_thread(_update)
    updated_row = update_result.data[0] if update_result.data else {**med, "quantity": new_qty}

    return {
        "ok": True,
        "medication": body.medication_name,
        "slot": med["slot"],
        "patient_id": med.get("patient_id"),
        "dispenser_id": med.get("dispenser_id"),
        "previous_quantity": current_qty,
        "decrement": step,
        "quantity": new_qty,
        "confidence": body.confidence,
        "row": updated_row,
    }
