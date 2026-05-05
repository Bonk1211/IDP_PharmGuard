"""Authentication endpoints — patient face verification & login."""

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.db.base import get_supabase

router = APIRouter()


@router.post("/verify-face")
async def verify_face(file: UploadFile = File(...)):
    """Accept a face crop from the Raspberry Pi and verify the patient.

    Stub disabled — see CR-002. Will return real verification once face model wired.
    """
    raise HTTPException(status_code=501, detail="Face verification not implemented")


@router.post("/login")
async def login():
    """Staff login endpoint for the dashboard."""
    # TODO: Implement JWT-based staff authentication
    raise HTTPException(status_code=501, detail="Not implemented")
