"""Authentication endpoints — patient face verification & login."""

from fastapi import APIRouter, UploadFile, File, HTTPException

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
    # For now, return a stub patient
    return {
        "patient_id": 1,
        "name": "Test Patient",
        "verified": True,
    }


@router.post("/login")
async def login():
    """Staff login endpoint for the dashboard."""
    # TODO: Implement JWT-based staff authentication
    raise HTTPException(status_code=501, detail="Not implemented")
