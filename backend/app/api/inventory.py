"""Inventory endpoints — manage the 10-slot magazine per dispenser."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class SlotInfo(BaseModel):
    slot: int
    medication_name: str | None = None
    quantity: int = 0
    patient_id: int | None = None


class SlotUpdate(BaseModel):
    medication_name: str
    quantity: int
    patient_id: int


# In-memory store — replace with DB queries
_slots: dict[int, SlotInfo] = {
    i: SlotInfo(slot=i) for i in range(10)
}


@router.get("/", response_model=list[SlotInfo])
async def list_slots():
    """Return the current state of all 10 magazine slots."""
    return list(_slots.values())


@router.get("/{slot}", response_model=SlotInfo)
async def get_slot(slot: int):
    if slot not in _slots:
        raise HTTPException(status_code=404, detail="Slot not found")
    return _slots[slot]


@router.put("/{slot}", response_model=SlotInfo)
async def update_slot(slot: int, data: SlotUpdate):
    """Assign a medication + patient to a magazine slot (refill operation)."""
    if slot < 0 or slot > 9:
        raise HTTPException(status_code=400, detail="Slot must be 0-9")
    _slots[slot] = SlotInfo(
        slot=slot,
        medication_name=data.medication_name,
        quantity=data.quantity,
        patient_id=data.patient_id,
    )
    return _slots[slot]


@router.get("/next-dispense", response_model=dict)
async def next_dispense():
    """
    Determine the next slot that needs dispensing.
    Called by the Raspberry Pi in its polling loop.
    """
    # TODO: Implement schedule-based logic
    for slot_info in _slots.values():
        if slot_info.quantity > 0 and slot_info.patient_id is not None:
            return {
                "patient_id": slot_info.patient_id,
                "slot": slot_info.slot,
                "medication": slot_info.medication_name,
            }
    raise HTTPException(status_code=404, detail="No pending dispenses")
