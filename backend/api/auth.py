"""Authentication endpoints — patient face verification & login."""

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from config import settings
from core.security import verify_device_token
from db.base import get_supabase
from services.face_recognition import compute_embedding, match_embedding

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/enroll-face")
async def enroll_face(
    patient_id: int = Form(...),
    file: UploadFile = File(...),
):
    """Compute an embedding and persist it on patients.face_embedding.

    Caregiver path; called from the dashboard. Rejects images with
    0 or >1 faces.

    NOTE: this endpoint is currently unauthenticated for prototype; in
    Phase 7 it should adopt the staff-JWT path once /api/auth/login lands.
    """
    data = await file.read()
    embedding = compute_embedding(data)
    if embedding is None:
        raise HTTPException(
            status_code=400,
            detail="Could not extract a single face from the uploaded image",
        )

    sb = get_supabase()
    result = (
        sb.table("patients")
        .update({"face_embedding": embedding})
        .eq("id", patient_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Patient not found")
    log.info("Enrolled face for patient_id=%d", patient_id)
    return {"ok": True, "patient_id": patient_id, "embedding_dim": len(embedding)}


@router.post("/verify-face", dependencies=[Depends(verify_device_token)])
async def verify_face(file: UploadFile = File(...)):
    """Match an incoming face crop against all enrolled patients.

    Pi-call site (`edge_pi/main.py::authenticate_patient`).
    Returns 200 with {patient_id, name, distance} on match,
    401 on no-match, 400 on undetectable face.
    """
    data = await file.read()
    probe = compute_embedding(data)
    if probe is None:
        raise HTTPException(
            status_code=400,
            detail="Could not extract a single face from the probe image",
        )

    sb = get_supabase()
    result = (
        sb.table("patients")
        .select("id,name,face_embedding")
        .not_.is_("face_embedding", "null")
        .execute()
    )
    candidates: list[tuple[int, list[float]]] = [
        (row["id"], row["face_embedding"]) for row in (result.data or [])
    ]
    match = match_embedding(probe, candidates, tolerance=settings.face_match_tolerance)
    if match is None:
        raise HTTPException(status_code=401, detail="No matching patient")

    pid, dist = match
    name = next((row["name"] for row in result.data if row["id"] == pid), None)
    log.info("Face match: patient_id=%d distance=%.3f", pid, dist)
    return {"patient_id": pid, "name": name, "distance": dist}


@router.post("/login")
async def login():
    """Staff login endpoint for the dashboard."""
    raise HTTPException(status_code=501, detail="Not implemented")
