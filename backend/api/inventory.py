"""Inventory endpoints — manage the 10-slot magazine per dispenser."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

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


@router.get("/", dependencies=[Depends(verify_device_token)])
async def list_slots():
    """Return the current state of all 10 magazine slots."""
    sb = get_supabase()
    result = sb.table("medications").select("*").order("slot").execute()
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
    query = (
        sb.table("medications")
        .select("*")
        .gt("quantity", 0)
        .not_.is_("patient_id", "null")
    )
    if dispenser_id is not None:
        query = query.eq("dispenser_id", dispenser_id)
    result = query.limit(1).execute()
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
    result = sb.table("medications").select("*").eq("slot", slot).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Slot not found")
    return result.data[0]


@router.put("/{slot}", dependencies=[Depends(verify_device_token)])
async def update_slot(slot: int, data: SlotUpdate):
    """Assign a medication + patient to a magazine slot (refill operation)."""
    if slot < 0 or slot > 9:
        raise HTTPException(status_code=400, detail="Slot must be 0-9")

    sb = get_supabase()
    # Upsert: update if slot exists, insert if not
    result = sb.table("medications").select("id").eq("slot", slot).execute()

    payload = {
        "name": data.medication_name,
        "slot": slot,
        "quantity": data.quantity,
        "patient_id": data.patient_id,
        "expiry_date": data.expiry_date,
        "pills_per_dose": data.pills_per_dose,
        "dispenser_id": data.dispenser_id,
    }

    if result.data:
        resp = (
            sb.table("medications")
            .update(payload)
            .eq("slot", slot)
            .execute()
        )
    else:
        resp = sb.table("medications").insert(payload).execute()

    return resp.data[0] if resp.data else payload
