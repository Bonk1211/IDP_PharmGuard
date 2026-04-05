"""Inventory endpoints — manage the 10-slot magazine per dispenser."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.db.base import get_supabase

router = APIRouter()


class SlotUpdate(BaseModel):
    medication_name: str
    quantity: int
    patient_id: int


@router.get("/")
async def list_slots():
    """Return the current state of all 10 magazine slots."""
    sb = get_supabase()
    result = sb.table("medications").select("*").order("slot").execute()
    return result.data


@router.get("/next-dispense")
async def next_dispense():
    """
    Determine the next slot that needs dispensing.
    Called by the Raspberry Pi in its polling loop.
    """
    sb = get_supabase()
    result = (
        sb.table("medications")
        .select("*")
        .gt("quantity", 0)
        .not_.is_("patient_id", "null")
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="No pending dispenses")

    med = result.data[0]
    return {
        "patient_id": med["patient_id"],
        "slot": med["slot"],
        "medication": med["name"],
    }


@router.get("/{slot}")
async def get_slot(slot: int):
    sb = get_supabase()
    result = sb.table("medications").select("*").eq("slot", slot).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Slot not found")
    return result.data[0]


@router.put("/{slot}")
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
