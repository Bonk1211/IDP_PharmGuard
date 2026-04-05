"""Authentication endpoints — patient face verification & login."""

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.db.base import get_supabase

router = APIRouter()


@router.post("/verify-face")
async def verify_face(file: UploadFile = File(...)):
    """
    Accept a face crop from the Raspberry Pi and verify the patient.
    Returns patient info if recognized, 401 otherwise.
    """
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty image")

    # TODO: Implement face recognition against enrolled patients
    # For now, return the first patient as a stub
    sb = get_supabase()
    result = sb.table("patients").select("*").limit(1).execute()
    if result.data:
        patient = result.data[0]
        return {
            "patient_id": patient["id"],
            "name": patient["name"],
            "verified": True,
        }

    raise HTTPException(status_code=401, detail="No patients enrolled")


@router.post("/login")
async def login():
    """Staff login endpoint for the dashboard."""
    # TODO: Implement JWT-based staff authentication
    raise HTTPException(status_code=501, detail="Not implemented")
