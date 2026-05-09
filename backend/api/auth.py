"""Authentication endpoints — staff login (face biometric removed)."""

from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.post("/login")
async def login():
    """Staff login endpoint for the dashboard."""
    raise HTTPException(status_code=501, detail="Not implemented")
