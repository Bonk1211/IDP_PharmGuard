# Plan: Face ID End-to-End (PRD Phase 3)

## Summary
Replace the 501 stub at `POST /api/auth/verify-face` with real face recognition. Add a sibling `POST /api/auth/enroll-face` endpoint for caregivers to enrol a patient via the dashboard. Compute 128-D face embeddings server-side using the `face_recognition` library (dlib-based), persist them as a `real[]` column on `patients`, and match incoming probes by Euclidean distance against all enrolled patients. Add a Pi-side `LivenessDetector` that runs MediaPipe FaceMesh against `cam_b` and only forwards a face crop after a confirmed blink (EAR drop + recovery) — defeats printed-photo spoof. New Next.js page at `/patients/[id]/enroll` lets the caregiver upload a photo from the dashboard.

## User Story
As a **caregiver / nursing staff** enrolling an isolation-ward patient, I want **to upload one photo from the dashboard and have the bedside dispenser recognise that patient (and refuse photo-spoofs)**, so that **the drawer unlocks for the right patient with zero physical contact and verifiable identity proof**.

## Problem → Solution
**Today**: `POST /api/auth/verify-face` raises HTTP 501. The Pi's `authenticate_patient` (in `edge_pi/main.py:33-46`) sends a `face.jpg` and gets a 501 back, so authentication is fully broken in production. There is no enrolment path either.
**After**: Caregiver uploads patient photo at `/patients/<id>/enroll` → backend computes a 128-D embedding via `face_recognition` and stores it in `patients.face_embedding`. Pi runs MediaPipe-based blink-liveness on `cam_b`, captures a verified-live face crop, POSTs to `/api/auth/verify-face`. Backend computes the probe embedding, fetches all enrolled patients, returns the closest match if Euclidean distance < tolerance (default 0.6), else 401. Drawer unlocks only on the matched patient.

## Metadata
- **Complexity**: Large
- **Source PRD**: `.claude/PRPs/prds/pharmguard.prd.md`
- **PRD Phase**: 3 — Face ID end-to-end
- **Estimated Files**: 12 (1 migration + 1 backend service + 1 backend route update + 1 backend config + 1 backend deps + 1 backend env doc + 1 Pi liveness module + 1 vision __init__ + 1 Pi main update + 1 frontend types/helper + 1 frontend page + 1 frontend patient-page link)
- **Estimated Lines**: ~600 LOC net

---

## UX Design

### Before
```
┌─────────────────────────────────┐
│  Caregiver opens patient page   │
│  No way to enrol face           │
│                                 │
│  Pi sends face → 501 error      │
│  Drawer never unlocks           │
└─────────────────────────────────┘
```

### After
```
┌──────────────────────────────────────────┐
│ Caregiver: /patients/12 → "Enrol face"   │
│   ↓                                      │
│ /patients/12/enroll                      │
│   ↓ [upload photo, preview, submit]      │
│ POST /api/auth/enroll-face (multipart)   │
│   ↓ backend computes 128-D embedding     │
│ patients.face_embedding stored           │
│                                          │
│ Pi cycle (cam_b):                        │
│   1. MediaPipe FaceMesh on live frames   │
│   2. EAR < 0.20 then EAR > 0.25 → blink  │
│   3. Capture face crop                   │
│   4. POST /api/auth/verify-face          │
│      → {patient_id, distance}            │
│   5. Magazine rotates only if matched    │
└──────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `POST /api/auth/verify-face` | 501 | matches probe vs all enrolled patients; returns `{patient_id, name, distance}` or 401 | live impl |
| `POST /api/auth/enroll-face` | did not exist | accepts multipart `file` + `patient_id` form field; computes embedding; updates `patients.face_embedding` | new |
| Pi `authenticate_patient` | sends a hard-coded face crop path | runs blink-liveness on `cam_b`, captures verified-live crop, sends crop bytes | dual-cam dependency |
| `/patients/[id]/enroll` page | did not exist | upload + preview + submit flow | new |
| Pi → backend wire | used 501 path; never functional | now functional once enrolled | end-to-end |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/app/api/auth.py` | 1–24 | The 501 stub to replace; `UploadFile` import already in place |
| P0 | `backend/app/api/inventory.py` | 1–88 | Pattern: Pydantic model + router + `Depends(verify_device_token)` + Supabase data access |
| P0 | `backend/app/api/logs.py` | 23–40 | Multipart-free pattern but shows JSON insert + WS broadcast |
| P0 | `backend/app/services/gemini_fallback.py` | 1–39 | Service-layer convention: top-level docstring, lazy imports inside functions, settings-driven |
| P0 | `backend/app/db/base.py` | 1–13 | `get_supabase()` lazy singleton — only path for DB access |
| P0 | `backend/app/core/config.py` | 1–20 | Settings pattern (after Phase 1: `default_dispenser_id`) |
| P0 | `backend/app/core/security.py` | 30–60 | `verify_device_token` dependency — `verify-face` MUST keep this |
| P0 | `backend/migrations/0001_phase1_schema_hardening.sql` | all | Migration convention: idempotent ALTER TABLE, named numbered file |
| P0 | `edge_pi/main.py` | 33–55, 109–155 | `authenticate_patient` call site + dual-cam wiring from Phase 2 |
| P0 | `edge_pi/vision/intake_monitor.py` | 70–115, 128–175 | Existing MediaPipe FaceMesh init + landmark indexing; mirror for liveness module |
| P0 | `edge_pi/vision/camera.py` | all | `CameraSource` Protocol; liveness module accepts injected cam_b |
| P1 | `frontend/src/lib/api.ts` | 1–80 | Patient types + Supabase direct queries; new helper goes here |
| P1 | `frontend/src/app/patients/[id]/page.tsx` | 60–90 | Where to add the "Enrol face" link; uses Next.js `Link` and `useParams` |
| P1 | `edge_pi/requirements.txt` | all | `mediapipe>=0.10.9` + `picamera2` already pinned |
| P1 | `backend/requirements.txt` | all | Need to add `face_recognition` |
| P2 | `CLAUDE.md` | full | Tier boundaries: Pi never holds Gemini key — same rule applies, Pi never holds the dlib model |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `face_recognition` library API | https://face-recognition.readthedocs.io/en/latest/face_recognition.html | `face_encodings(image)` returns list of 128-D `np.ndarray`. `compare_faces(known, candidate, tolerance=0.6)` and `face_distance(known, candidate)` use **Euclidean distance**, default threshold 0.6. |
| `face_recognition` install | https://github.com/ageitgey/face_recognition | Requires `dlib` + cmake + a C++ toolchain. On Apple Silicon: `brew install cmake && pip install dlib face_recognition`. Backend-host only — never on the Pi. |
| FaceNet 128-D thresholds | https://datahacker.rs/025-facenet-a-unified-embedding-for-face-recognition-and-clustering-in-pytorch/ | 128-D embeddings + Euclidean distance; threshold ~0.6 separates same/different person reliably. |
| MediaPipe FaceMesh eye landmarks | https://www.researchgate.net/figure/MediaPipe-Facemesh-Left-Eye-Landmarks-for-calculating-Eye-Aspect-Ratio-EAR_fig1_368318088 | Right eye 6-pt EAR: `[33, 160, 158, 133, 153, 144]`. Left eye: `[362, 385, 387, 263, 373, 380]`. EAR formula `(|p2-p6| + |p3-p5|) / (2*|p1-p4|)`. |
| EAR blink threshold | https://learnopencv.com/driver-drowsiness-detection-using-mediapipe-in-python/ | EAR < 0.20 → eye closed; > 0.25 → open. Hysteresis (two thresholds) avoids jitter. |
| EAR limitations | https://pmc.ncbi.nlm.nih.gov/articles/PMC9044337/ | EAR is 2D and varies with head roll/pitch/yaw — acceptable for face-the-camera use case. |

---

## Patterns to Mirror

### NAMING_CONVENTION (backend route)
```python
# SOURCE: backend/app/api/auth.py:1-12
"""Authentication endpoints — patient face verification & login."""

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.db.base import get_supabase

router = APIRouter()

@router.post("/verify-face")
async def verify_face(file: UploadFile = File(...)):
    ...
```
Rule: module-level docstring; `router = APIRouter()`; one function per endpoint; HTTPException with explicit status_code; `UploadFile = File(...)` for multipart.

### SERVICE_LAYER_PATTERN
```python
# SOURCE: backend/app/services/gemini_fallback.py:1-26
"""Gemini Vision API fallback for pill identification."""

import logging
from app.core.config import settings

log = logging.getLogger(__name__)

async def identify_pill(image_bytes: bytes) -> dict | None:
    if not settings.gemini_api_key:
        log.warning("GEMINI_API_KEY not set — fallback unavailable")
        return None
    try:
        import google.generativeai as genai
        ...
    except Exception:
        log.exception("Gemini fallback failed")
        return None
```
Rule: pure-function service modules under `app/services/`; **lazy import** of heavy dependencies inside the function (so backend imports don't pay dlib's load cost on cold start unless the function actually fires); `log.warning` on missing config, `log.exception` on unexpected failure, return `None` instead of raising.

### MIGRATION_PATTERN
```sql
-- SOURCE: backend/migrations/0001_phase1_schema_hardening.sql:1-7
-- Phase 1: schema + telemetry hardening
-- Plan: .claude/PRPs/plans/schema-telemetry-hardening.plan.md
-- PRD:  .claude/PRPs/prds/pharmguard.prd.md (Phase 1)
-- Idempotent: safe to re-run.

ALTER TABLE public.medications
    ADD COLUMN IF NOT EXISTS dispenser_id    text,
    ...
```
Rule: header comment with phase + plan + PRD references; "Idempotent: safe to re-run"; `ADD COLUMN IF NOT EXISTS`; numbered filename `NNNN_<short_name>.sql`; constraints follow `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT`.

### DATA_ACCESS_PATTERN
```python
# SOURCE: backend/app/api/logs.py:23-30
@router.post("/", dependencies=[Depends(verify_device_token)])
async def create_log(log: IntakeLog):
    sb = get_supabase()
    result = (
        sb.table("adherence_logs")
        .insert(log.model_dump())
        .execute()
    )
```
Rule: lazy `get_supabase()`; fluent `.table(name).select/insert/update.execute()`. Same applies to face-embedding read/write.

### MEDIAPIPE_FACEMESH_PATTERN (Pi-side)
```python
# SOURCE: edge_pi/vision/intake_monitor.py:73-77, 233-239
self._face_mesh = mp.solutions.face_mesh.FaceMesh(
    max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
)
...
rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
face_res = self._face_mesh.process(rgb)
if not face_res.multi_face_landmarks:
    timer_start = 0.0
    continue
lms = face_res.multi_face_landmarks[0].landmark
```
Rule: instantiate `FaceMesh` once at construction; call `.process(rgb)` per frame (BGR→RGB conversion mandatory); guard on `multi_face_landmarks`; index landmarks by integer (0–467) returning `.x` and `.y` in [0,1] range.

### CAMERA_INJECTION_PATTERN (Pi-side, post-Phase-2)
```python
# SOURCE: edge_pi/vision/intake_monitor.py:68-77, 81-84
def __init__(self, camera_index: int = 1, camera: CameraSource | None = None) -> None:
    self.camera_index = camera_index
    self._source: CameraSource | None = camera
    self._owns_source = camera is None
    ...

def _ensure_camera(self) -> None:
    if self._source is not None:
        return
    self._source = open_camera(self.camera_index)
```
Rule: optional injected `CameraSource`, `_owns_source` for lifecycle, `_ensure_camera` opens lazily.

### LOGGING_PATTERN
```python
# SOURCE: edge_pi/vision/intake_monitor.py:106
log.info("Intake camera initialized via picamera2 (index=%d)", self.camera_index)
log.warning("Swallow verification timed out after %.1fs", timeout_s)
```
Rule: positional formatters, never f-strings.

### PI_HTTP_REQUEST_PATTERN
```python
# SOURCE: edge_pi/main.py:33-55
def authenticate_patient(face_crop_path: str) -> dict | None:
    assert session is not None, "session not initialized; call run() first"
    with open(face_crop_path, "rb") as f:
        resp = session.post(
            f"{settings.BACKEND_URL}/api/auth/verify-face",
            files={"file": ("face.jpg", f, "image/jpeg")},
            timeout=10,
        )
    if resp.status_code == 200:
        return resp.json()
    log.warning("Authentication failed: %s", resp.text)
    return None
```
Rule: shared `session` (already authed); multipart via `files=`; explicit timeout; warn-and-return-None on non-200.

### FRONTEND_API_HELPER_PATTERN
```ts
// SOURCE: frontend/src/lib/api.ts:69-80
export async function createPatient(input: CreatePatientInput): Promise<Patient> {
  const { data, error } = await supabase
    .from("patients")
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data;
}
```
Rule: typed input/output; `if (error) throw error;` on Supabase calls. New helper that hits the FastAPI backend uses `fetch()` (new convention seeded for backend-bound calls).

### FRONTEND_PAGE_PATTERN
```tsx
// SOURCE: frontend/src/app/patients/[id]/page.tsx:1-17
"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  fetchPatient, fetchLogs, fetchSlotsByPatient, updateSlot, deleteSlot,
  type Patient, type IntakeRecord, type SlotInfo,
} from "@/lib/api";
```
Rule: `"use client"`, `useParams<{ id: string }>()`, hooks-driven loading state, `loadData()` on mount via `useEffect`, Tailwind classes inline.

### TEST_STRUCTURE
N/A — repo has no test framework. Validation = curl + manual UI flow + textual regression guards.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/migrations/0002_face_embedding.sql` | CREATE | Add `face_embedding real[]` to `patients` (idempotent) + index |
| `backend/app/services/face_recognition.py` | CREATE | Service-layer module: `compute_embedding(bytes) -> list[float] \| None`, `match_embedding(probe, candidates) -> (id, dist) \| None`. Lazy-imports `face_recognition` per service convention. |
| `backend/app/api/auth.py` | UPDATE | Replace 501 `verify_face` with real impl; add `enroll_face` POST |
| `backend/app/core/config.py` | UPDATE | Add `face_match_tolerance: float = 0.6` (overridable via env) |
| `backend/requirements.txt` | UPDATE | Add `face_recognition>=1.3.0,<2.0.0` |
| `backend/.env.example` | UPDATE | Document `FACE_MATCH_TOLERANCE=0.6` |
| `edge_pi/vision/liveness.py` | CREATE | `LivenessDetector` class — MediaPipe FaceMesh, EAR-based blink, returns face crop on confirmed blink |
| `edge_pi/vision/__init__.py` | UPDATE | Export `LivenessDetector` |
| `edge_pi/main.py` | UPDATE | Inject `cam_b` into a `LivenessDetector`; rewrite `authenticate_patient` to capture-then-POST instead of reading from disk; gate magazine cycle on auth success |
| `frontend/src/lib/api.ts` | UPDATE | Add `enrollFace(patientId, file)`; extend `Patient` interface with `face_embedding: number[] \| null` |
| `frontend/src/app/patients/[id]/enroll/page.tsx` | CREATE | Caregiver upload UI: file picker, preview, submit, success/error toast, "back to patient" link |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATE | Add small "Enrol face" Link button |

## NOT Building

- **Multi-face per patient enrolment** — single embedding per patient.
- **pgvector / ivfflat index** — `real[]` linear scan is fine for <500 patients; revisit when pilot grows.
- **Active liveness beyond blink** — no head-turn challenge, no NIR, no depth. Photo-spoof defended; video-replay attack is acknowledged residual risk.
- **Face quality / pose checks during enrolment** — caregiver judgement is the gate. We refuse only if zero or >1 faces detected.
- **Encrypted-at-rest embedding storage** — relies on Supabase's default at-rest encryption + RLS.
- **Face-deletion endpoint** — admin path to clear an embedding deferred (pending privacy policy).
- **Audit log of who-enrolled-whom** — `created_at` on patient row is the proxy until a real audit table exists.
- **Pi-side fallback if backend down** — Pi refuses to dispense (existing). Offline-cache deferred to Phase 8.
- **Bulk enrolment / CSV import** — single-photo, single-patient only.
- **Pi-side embedding compute** — Pi never holds the dlib model. Backend is the only embedding producer.
- **Staff JWT on `/enroll-face`** — open in V1; Phase 7 will gate behind staff auth once `/login` lands.

---

## Step-by-Step Tasks

### Task 1: Author SQL migration `0002_face_embedding.sql`
- **ACTION**: Create `backend/migrations/0002_face_embedding.sql`.
- **IMPLEMENT**:
  ```sql
  -- Phase 3: face embedding column on patients
  -- Plan: .claude/PRPs/plans/face-id-end-to-end.plan.md
  -- PRD:  .claude/PRPs/prds/pharmguard.prd.md (Phase 3)
  -- Idempotent: safe to re-run.

  ALTER TABLE public.patients
      ADD COLUMN IF NOT EXISTS face_embedding real[];

  ALTER TABLE public.patients
      DROP CONSTRAINT IF EXISTS patients_face_embedding_dim;
  ALTER TABLE public.patients
      ADD CONSTRAINT patients_face_embedding_dim
          CHECK (face_embedding IS NULL OR array_length(face_embedding, 1) = 128) NOT VALID;
  ALTER TABLE public.patients
      VALIDATE CONSTRAINT patients_face_embedding_dim;

  CREATE INDEX IF NOT EXISTS patients_has_face_embedding_idx
      ON public.patients ((face_embedding IS NOT NULL));
  ```
- **MIRROR**: MIGRATION_PATTERN.
- **IMPORTS**: N/A.
- **GOTCHA**: 128-D matches `face_recognition` library output. Constraint is `NOT VALID` first then `VALIDATE` — same as Phase 1.
- **VALIDATE**: SQL parses; idempotent.

### Task 2: Apply migration via Supabase MCP
- **ACTION**: `mcp__supabase__apply_migration` with name `phase3_face_embedding`.
- **IMPLEMENT**: One MCP call. Fallback: paste into Supabase Studio at https://supabase.com/dashboard/project/wqijdqclqhybhdtgsznf/sql/new.
- **MIRROR**: Phase 1 apply approach.
- **IMPORTS**: N/A.
- **GOTCHA**: MCP may time out (Phase 1 saw this). Retry; if down, fall back to Studio.
- **VALIDATE**:
  ```sql
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'patients' AND column_name = 'face_embedding';
  ```
  Expect 1 row, `data_type=ARRAY`, `is_nullable=YES`.

### Task 3: Add `face_recognition` to backend deps
- **ACTION**: Edit `backend/requirements.txt`.
- **IMPLEMENT**: Add line:
  ```
  face_recognition>=1.3.0,<2.0.0
  ```
- **MIRROR**: existing `requirements.txt` style — version pinned with upper bound.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - dlib build can take 3–5 min on first install. macOS needs `brew install cmake` first.
  - `face_recognition` is **NOT installed on the Pi** — backend-only.
- **VALIDATE**:
  ```bash
  cd backend && .venv/bin/pip install -r requirements.txt
  .venv/bin/python -c "import face_recognition; print('OK')"
  ```

### Task 4: Create `backend/app/services/face_recognition.py`
- **ACTION**: New service module.
- **IMPLEMENT**:
  ```python
  """Face recognition service: 128-D embedding + Euclidean distance match.

  Library: face_recognition (dlib, ResNet-34). One embedding per patient,
  stored as a real[] of length 128 in patients.face_embedding.
  """

  from __future__ import annotations

  import io
  import logging

  log = logging.getLogger(__name__)

  EMBEDDING_DIM = 128


  def compute_embedding(image_bytes: bytes) -> list[float] | None:
      """Compute a 128-D face embedding from raw image bytes.

      Returns None if zero faces or >1 face detected (caller renders 400).
      Lazy-imports face_recognition + numpy so backend cold-start is cheap.
      """
      try:
          import face_recognition  # heavy; lazy
          import numpy as np
          from PIL import Image
      except ImportError:
          log.exception("face_recognition import failed")
          return None

      try:
          img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
          arr = np.array(img)
          encodings = face_recognition.face_encodings(arr)
      except Exception:
          log.exception("face_encodings failed")
          return None

      if len(encodings) != 1:
          log.warning("Expected 1 face, got %d", len(encodings))
          return None
      return encodings[0].astype(float).tolist()


  def match_embedding(
      probe: list[float],
      candidates: list[tuple[int, list[float]]],
      tolerance: float = 0.6,
  ) -> tuple[int, float] | None:
      """Find the closest candidate by Euclidean distance.

      candidates: list of (patient_id, embedding) tuples.
      Returns (patient_id, distance) of the closest match below tolerance, or None.
      """
      if not candidates:
          return None
      try:
          import numpy as np
      except ImportError:
          log.exception("numpy import failed")
          return None

      probe_arr = np.array(probe, dtype=float)
      best: tuple[int, float] | None = None
      for pid, emb in candidates:
          emb_arr = np.array(emb, dtype=float)
          dist = float(np.linalg.norm(probe_arr - emb_arr))
          if dist < tolerance and (best is None or dist < best[1]):
              best = (pid, dist)
      return best
  ```
- **MIRROR**: SERVICE_LAYER_PATTERN.
- **IMPORTS**: stdlib + lazy `face_recognition`/`numpy`/`PIL.Image`.
- **GOTCHA**:
  - `face_recognition.face_encodings(arr)` requires `len(encodings) == 1` for both enrol and verify.
  - Euclidean distance (library default), not cosine. Threshold 0.6 is the documented "same person" boundary.
- **VALIDATE**:
  ```bash
  cd backend && .venv/bin/python -c "from app.services.face_recognition import compute_embedding, match_embedding; print('OK')"
  ```

### Task 5: Replace `verify_face` + add `enroll_face` endpoint
- **ACTION**: Edit `backend/app/api/auth.py`.
- **IMPLEMENT**:
  ```python
  """Authentication endpoints — patient face verification & login."""

  import logging

  from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

  from app.core.config import settings
  from app.core.security import verify_device_token
  from app.db.base import get_supabase
  from app.services.face_recognition import compute_embedding, match_embedding

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
  ```
- **MIRROR**: NAMING_CONVENTION (auth.py), DATA_ACCESS_PATTERN, SERVICE_LAYER_PATTERN's lazy-load via the imported service.
- **IMPORTS**: `Form`, `Depends`, `settings`, `verify_device_token`, the service module.
- **GOTCHA**:
  - `Form(...)` requires `python-multipart` — already in `requirements.txt`.
  - `result.data` may be `None`; defensive `or []`.
  - Authentication asymmetry: `/enroll-face` open in V1, `/verify-face` device-gated. Preserve that.
- **VALIDATE**: see Task 13.

### Task 6: Add `face_match_tolerance` to backend Settings
- **ACTION**: Edit `backend/app/core/config.py` and `backend/.env.example`.
- **IMPLEMENT**:
  ```python
  class Settings(BaseSettings):
      supabase_url: str = ""
      supabase_key: str = ""
      secret_key: str = "dev-secret-change-in-production"
      gemini_api_key: str = ""
      device_tokens: str = ""
      default_dispenser_id: str = "dispenser-001"
      face_match_tolerance: float = 0.6

      model_config = {"env_file": ".env"}
  ```
  Append to `.env.example`:
  ```
  # Face match acceptance threshold (Euclidean distance); tighten for stricter ID
  FACE_MATCH_TOLERANCE=0.6
  ```
- **MIRROR**: Phase 1's CONFIG_PATTERN_BACKEND.
- **IMPORTS**: None.
- **GOTCHA**: pydantic-settings lower-cases env keys; `FACE_MATCH_TOLERANCE` → `face_match_tolerance`.
- **VALIDATE**:
  ```bash
  cd backend && .venv/bin/python -c "from app.core.config import settings; print(settings.face_match_tolerance)"
  ```

### Task 7: Create `edge_pi/vision/liveness.py`
- **ACTION**: New Pi-side liveness module.
- **IMPLEMENT**:
  ```python
  """Liveness detection: confirm a real person via MediaPipe FaceMesh blink (EAR).

  EAR (Eye Aspect Ratio) drops below a closed threshold and recovers above an
  open threshold within a small window — that's a blink, and a printed photo
  cannot do it. Returns the face crop bytes captured at the moment of blink
  recovery, or None on timeout.
  """

  from __future__ import annotations

  import logging
  import math
  import time
  from typing import Any

  import cv2
  import mediapipe as mp

  from vision.camera import CameraSource, open_camera

  log = logging.getLogger(__name__)

  # MediaPipe FaceMesh 6-point indices for EAR per eye (refine_landmarks=True).
  RIGHT_EYE_EAR = (33, 160, 158, 133, 153, 144)
  LEFT_EYE_EAR = (362, 385, 387, 263, 373, 380)

  EAR_CLOSED = 0.20
  EAR_OPEN = 0.25
  CROP_PADDING = 30


  def _dist(p1: Any, p2: Any, w: int, h: int) -> float:
      return math.hypot((p2.x - p1.x) * w, (p2.y - p1.y) * h)


  def _ear(lms: list[Any], idx: tuple[int, int, int, int, int, int], w: int, h: int) -> float:
      p1, p2, p3, p4, p5, p6 = (lms[i] for i in idx)
      v = _dist(p2, p6, w, h) + _dist(p3, p5, w, h)
      hz = 2.0 * _dist(p1, p4, w, h)
      return (v / hz) if hz > 0 else 0.0


  def _face_bbox(lms: list[Any], w: int, h: int) -> tuple[int, int, int, int]:
      xs = [int(p.x * w) for p in lms]
      ys = [int(p.y * h) for p in lms]
      return (
          max(0, min(xs) - CROP_PADDING),
          max(0, min(ys) - CROP_PADDING),
          min(w, max(xs) + CROP_PADDING),
          min(h, max(ys) + CROP_PADDING),
      )


  class LivenessDetector:
      """Run MediaPipe on cam_b until a confirmed blink, then return JPEG bytes."""

      def __init__(self, camera_index: int = 1, camera: CameraSource | None = None) -> None:
          self.camera_index = camera_index
          self._source: CameraSource | None = camera
          self._owns_source = camera is None
          self._face_mesh = mp.solutions.face_mesh.FaceMesh(
              max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
          )

      def _ensure_camera(self) -> None:
          if self._source is not None:
              return
          self._source = open_camera(self.camera_index)

      def capture_live_face(self, timeout_s: float = 15.0) -> bytes | None:
          """Block until a blink is observed; return JPEG-encoded face crop bytes.

          Returns None if no blink confirmed within timeout_s.
          """
          try:
              self._ensure_camera()
          except Exception:
              log.exception("Liveness camera initialization failed")
              return None

          deadline = time.time() + timeout_s
          eyes_were_closed = False

          while time.time() < deadline:
              frame = self._source.read_frame() if self._source else None
              if frame is None:
                  time.sleep(0.02)
                  continue
              h, w = frame.shape[:2]
              rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
              face_res = self._face_mesh.process(rgb)
              if not face_res.multi_face_landmarks:
                  eyes_were_closed = False
                  continue
              lms = face_res.multi_face_landmarks[0].landmark
              ear = (_ear(lms, RIGHT_EYE_EAR, w, h) + _ear(lms, LEFT_EYE_EAR, w, h)) / 2.0

              if ear < EAR_CLOSED:
                  eyes_were_closed = True
              elif eyes_were_closed and ear > EAR_OPEN:
                  log.info("Blink confirmed (EAR transition)")
                  x0, y0, x1, y1 = _face_bbox(lms, w, h)
                  crop = frame[y0:y1, x0:x1]
                  if crop.size == 0:
                      return None
                  ok, buf = cv2.imencode(".jpg", crop)
                  return buf.tobytes() if ok else None

          log.warning("Liveness timed out after %.1fs", timeout_s)
          return None

      def close(self) -> None:
          if self._source is not None and self._owns_source:
              self._source.close()
          self._source = None
          self._face_mesh.close()
  ```
- **MIRROR**: MEDIAPIPE_FACEMESH_PATTERN, CAMERA_INJECTION_PATTERN, LOGGING_PATTERN.
- **IMPORTS**: stdlib + `cv2`, `mediapipe`, `vision.camera`.
- **GOTCHA**:
  - Hysteresis (0.20 / 0.25) prevents jitter at the boundary.
  - **Do NOT mirror the frame** (`cv2.flip`) — `intake_monitor.py` mirrors for FSM display, but the embedding must match the un-mirrored enrol photo.
  - `cv2.imencode(".jpg", crop)` returns `(ok, buf)`; default JPEG quality ~95.
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/edge_pi && python3 -m py_compile vision/liveness.py
  ```

### Task 8: Update `edge_pi/vision/__init__.py`
- **ACTION**: Re-export `LivenessDetector`.
- **IMPLEMENT**:
  ```python
  """Vision pipeline: pill spotter, swallow verification, liveness, and the camera abstraction."""

  from vision.camera import CameraSource, Cv2Source, Picamera2Source, open_camera
  from vision.intake_monitor import IntakeMonitor
  from vision.liveness import LivenessDetector
  from vision.pill_verifier import PillVerifier

  __all__ = [
      "CameraSource",
      "Cv2Source",
      "IntakeMonitor",
      "LivenessDetector",
      "Picamera2Source",
      "PillVerifier",
      "open_camera",
  ]
  ```
- **MIRROR**: Phase 2's `__init__.py`.
- **IMPORTS**: re-export only.
- **GOTCHA**: alphabetical order matters.
- **VALIDATE**:
  ```bash
  python3 -c "
  import pathlib
  init = pathlib.Path('vision/__init__.py').read_text()
  assert 'LivenessDetector' in init
  print('OK')
  "
  ```

### Task 9: Wire liveness into `edge_pi/main.py::authenticate_patient`
- **ACTION**: Update Pi main.
- **IMPLEMENT**:
  - Update vision imports:
    ```python
    from vision import CameraSource, IntakeMonitor, LivenessDetector, PillVerifier, open_camera
    ```
  - After the dual-cam open block (Phase 2), instantiate the liveness detector with `cam_b`:
    ```python
    liveness = LivenessDetector(camera=cam_b)
    ```
  - Replace `authenticate_patient(face_crop_path)` (current lines 33–55) with:
    ```python
    def authenticate_patient(detector: "LivenessDetector") -> dict | None:
        """Capture a live (post-blink) face crop, send to backend, return patient or None."""
        assert session is not None, "session not initialized; call run() first"
        crop_bytes = detector.capture_live_face(timeout_s=15.0)
        if crop_bytes is None:
            log.warning("No live face captured")
            return None
        resp = session.post(
            f"{settings.BACKEND_URL}/api/auth/verify-face",
            files={"file": ("face.jpg", crop_bytes, "image/jpeg")},
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
        log.warning("Authentication failed (%d): %s", resp.status_code, resp.text)
        return None
    ```
  - Insert into the polling loop **before** `magazine.rotate_to(slot)` (right-patient gate):
    ```python
    auth = None if hardware_stubbed else authenticate_patient(liveness)
    if not hardware_stubbed and auth is None:
        log.warning("Skipping cycle: authentication failed for slot %d", slot)
        time.sleep(settings.POLL_INTERVAL_S)
        continue
    if auth is not None and auth.get("patient_id") != patient_id:
        log.warning(
            "Authenticated patient_id=%s does not match scheduled %d; skipping cycle",
            auth.get("patient_id"), patient_id,
        )
        time.sleep(settings.POLL_INTERVAL_S)
        continue
    ```
- **MIRROR**: PI_HTTP_REQUEST_PATTERN, MAIN_LOOP_INSTANTIATION_PATTERN.
- **IMPORTS**: `LivenessDetector` from `vision`.
- **GOTCHA**:
  - The liveness detector and the intake monitor BOTH use `cam_b` — but they run at different cycle stages (liveness BEFORE rotate; intake AFTER pill ejected), so there is no contention for the camera.
  - `liveness.close()` is intentionally not called per cycle — keep the FaceMesh model loaded across cycles.
  - The right-patient invariant (`auth.get("patient_id") != patient_id`) refuses to dispense if Face ID returns a valid match for a *different* patient than scheduled.
- **VALIDATE**:
  ```bash
  python3 -m py_compile main.py
  python3 -c "
  import pathlib
  src = pathlib.Path('main.py').read_text()
  assert 'liveness = LivenessDetector(camera=cam_b)' in src
  assert 'authenticate_patient(liveness)' in src
  assert 'auth.get(\"patient_id\") != patient_id' in src
  print('main.py wiring intact')
  "
  ```

### Task 10: Frontend types + `enrollFace` helper
- **ACTION**: Edit `frontend/src/lib/api.ts`.
- **IMPLEMENT**:
  - Extend `Patient`:
    ```ts
    export interface Patient {
      id: number;
      name: string;
      gender: string | null;
      age: number | null;
      condition: string | null;
      status: string | null;
      allergies: string[];
      contraindications: string[];
      created_at: string;
      face_embedding: number[] | null;   // 128-D when enrolled, NULL otherwise
    }
    ```
  - Append helper at end of file:
    ```ts
    // ── Face enrolment (FastAPI) ──

    const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

    export async function enrollFace(patientId: number, file: File): Promise<{ ok: boolean; embedding_dim: number }> {
      const fd = new FormData();
      fd.append("patient_id", String(patientId));
      fd.append("file", file);
      const resp = await fetch(`${API_BASE_URL}/api/auth/enroll-face`, {
        method: "POST",
        body: fd,
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Enrol failed (${resp.status}): ${text}`);
      }
      return resp.json();
    }
    ```
  - Document new env in `frontend/.env.example` (create if absent):
    ```
    NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
    ```
- **MIRROR**: TYPE_DEFINITION_FRONTEND, FRONTEND_API_HELPER_PATTERN.
- **IMPORTS**: None new.
- **GOTCHA**:
  - `face_embedding: number[] | null` is large (128 floats); only the enrol page reads it. Performance-tune later by selecting only needed columns.
  - CORS already allows `http://localhost:3000` (`backend/app/main.py:14-19`).
- **VALIDATE**:
  ```bash
  cd /Users/limjiale/IDP_PharmGuard/frontend && npm run build
  ```
  Expect green build, `enrollFace` exported.

### Task 11: Create `frontend/src/app/patients/[id]/enroll/page.tsx`
- **ACTION**: New caregiver enrolment page.
- **IMPLEMENT**:
  ```tsx
  "use client";

  import Link from "next/link";
  import { useState } from "react";
  import { useParams, useRouter } from "next/navigation";
  import { enrollFace } from "@/lib/api";

  export default function EnrollFacePage() {
    const { id } = useParams<{ id: string }>();
    const router = useRouter();
    const pid = Number(id);
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function onPick(f: File | null) {
      setFile(f);
      setPreviewUrl(f ? URL.createObjectURL(f) : null);
      setError(null);
    }

    async function onSubmit(e: React.FormEvent) {
      e.preventDefault();
      if (!file) return;
      setSubmitting(true);
      setError(null);
      try {
        await enrollFace(pid, file);
        router.push(`/patients/${pid}`);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <div className="mx-auto max-w-xl">
        <Link
          href={`/patients/${pid}`}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-400 transition-colors hover:text-gray-600"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Patient
        </Link>

        <div className="rounded-2xl border border-sand-200 bg-white p-6">
          <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900">
            Enrol Patient Face
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Upload one clear front-facing photo. Single face only.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border file:border-sand-200 file:bg-sand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-olive-700 hover:file:bg-sand-100"
            />

            {previewUrl && (
              <img
                src={previewUrl}
                alt="preview"
                className="mx-auto h-48 w-48 rounded-2xl border border-sand-200 object-cover"
              />
            )}

            {error && (
              <p className="rounded-lg bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!file || submitting}
              className="w-full rounded-xl bg-olive-600 py-2 text-sm font-semibold text-white transition-opacity hover:bg-olive-700 disabled:opacity-50"
            >
              {submitting ? "Enrolling…" : "Enrol Face"}
            </button>
          </form>
        </div>
      </div>
    );
  }
  ```
- **MIRROR**: FRONTEND_PAGE_PATTERN.
- **IMPORTS**: `useParams`, `useRouter` from `next/navigation`; `enrollFace` from `@/lib/api`.
- **GOTCHA**:
  - `URL.createObjectURL(f)` leaks a blob URL — acceptable for one-shot page.
  - Plain `<img>` not `<Image>` — keeps page minimal without remote-host config.
  - `disabled={!file || submitting}` prevents double-submission.
- **VALIDATE**: `npm run build` green; visiting `/patients/1/enroll` shows the form.

### Task 12: Add "Enrol Face" link on patient detail page
- **ACTION**: Edit `frontend/src/app/patients/[id]/page.tsx`.
- **IMPLEMENT**: After the existing status badge, insert:
  ```tsx
  <Link
    href={`/patients/${patient.id}/enroll`}
    className="ml-2 inline-flex items-center gap-1 rounded-full border border-olive-300 bg-olive-50 px-3 py-1 text-xs font-medium text-olive-700 hover:bg-olive-100"
  >
    {patient.face_embedding ? "Re-enrol Face" : "Enrol Face"}
  </Link>
  ```
- **MIRROR**: existing `<Link>` style + olive-tone class set in this page.
- **IMPORTS**: None new.
- **GOTCHA**: `patient.face_embedding` is on the type after Task 10.
- **VALIDATE**: `npm run build` green; on `/patients/1` see the new button.

### Task 13: End-to-end backend validation
- **ACTION**: Run all backend validations.
- **IMPLEMENT**:
  ```bash
  # Backend module compile
  cd /Users/limjiale/IDP_PharmGuard/backend
  .venv/bin/python -m py_compile app/services/face_recognition.py app/api/auth.py app/core/config.py

  # Pi module compile
  cd /Users/limjiale/IDP_PharmGuard/edge_pi
  python3 -m py_compile vision/liveness.py vision/__init__.py main.py

  # Frontend build
  cd /Users/limjiale/IDP_PharmGuard/frontend && npm run build

  # Live smoke (requires face_recognition installed + an existing patients row + sample.jpg with 1 face)
  cd /Users/limjiale/IDP_PharmGuard/backend
  .venv/bin/uvicorn app.main:app --port 8000 &
  SERVER=$!; sleep 3
  PID=1
  TOKEN="$(grep '^DEVICE_TOKENS=' .env | cut -d= -f2- | cut -d, -f1)"

  curl -fsS -X POST http://localhost:8000/api/auth/enroll-face \
       -F "patient_id=$PID" -F "file=@/tmp/sample.jpg"

  curl -fsS -X POST http://localhost:8000/api/auth/verify-face \
       -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/sample.jpg"

  kill $SERVER
  ```
- **MIRROR**: Phase 1's curl smoke pattern.
- **IMPORTS**: N/A.
- **GOTCHA**: dev mac without `face_recognition` will fail at the live smoke; install in Task 3 first.
- **VALIDATE**: All 5 sub-checks pass.

### Task 14: Pi-hardware live test (operator step)
- **ACTION**: Operator runs the full Face ID + dual-cam loop on a real Pi 5.
- **IMPLEMENT**:
  ```bash
  # 1. Enrol a test patient via the dashboard at http://localhost:3000/patients/1/enroll.
  # 2. SSH to the Pi:
  ssh pi@<host>
  cd ~/IDP_PharmGuard/edge_pi
  rpicam-hello --list-cameras
  BACKEND_URL=https://<backend-host> DEVICE_TOKEN=<token> DISPENSER_ID=dispenser-001 \
      python3 main.py
  # 3. Sit in front of cam_b, blink. Watch for "Blink confirmed (EAR transition)" and successful auth.
  # 4. Try a printed photo of the same person — should NOT trigger blink within 15s.
  ```
- **MIRROR**: Phase 2's Pi-hardware-only test pattern.
- **IMPORTS**: N/A.
- **GOTCHA**:
  - Gated on Phase 2 (dual-cam) being committed and `cam_b` actually opening.
  - Lighting matters for both face_recognition and EAR.
- **VALIDATE**: live face → 200 with matching `patient_id`; printed photo → "Liveness timed out".

---

## Testing Strategy

Repo has no test framework. Validation = curl smoke + `next build` + Pi-hardware operator test.

### Manual / Smoke Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| Migration idempotency | run `0002_face_embedding.sql` twice | second run no-ops | yes |
| Enrol with valid 1-face image | POST `/enroll-face` | 200, `embedding_dim=128`, row updated | normal |
| Enrol with 0 faces | POST a landscape photo | 400 "Could not extract a single face" | yes |
| Enrol with multiple faces | POST a group photo | 400 "Could not extract a single face" | yes |
| Enrol on missing patient | POST `patient_id=99999` | 404 "Patient not found" | yes |
| Verify with self-photo | POST same photo as enrol | 200, `distance < 0.1` | normal |
| Verify with different person | POST distinct face | 401 "No matching patient" | normal |
| Verify with no enrolment | DB empty of embeddings, POST any | 401 "No matching patient" | yes |
| Verify with no device token | omit Authorization header | 401 from `verify_device_token` | yes |
| Pi blink-liveness real face | sit in front of cam_b, blink | "Blink confirmed", crop returned | normal |
| Pi blink-liveness printed photo | hold printed photo | "Liveness timed out" | yes |
| Pi cycle wrong-patient guard | enrol patient A, scheduled dose for B | "Authenticated patient_id=A does not match scheduled B; skipping cycle" | yes (right-patient invariant) |
| Frontend `npm run build` after type widening | run build | zero TS errors | normal |

### Edge Cases Checklist
- [x] Empty input — file with no face → 400.
- [x] Maximum size — `face_recognition` typically handles up to 4K images; size cap deferred.
- [x] Invalid types — non-image bytes → `Image.open` raises → 400.
- [x] Concurrent access — last-writer-wins is acceptable for enrolment.
- [x] Network failure — Pi `authenticate_patient` returns None on timeout; cycle skipped, no falsified telemetry.
- [x] Permission denied — RLS unchanged; service-role key bypasses RLS.
- [x] Photo-spoof — defended by EAR-blink liveness.
- [x] Video replay — acknowledged residual risk; out of scope V1.

---

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/backend
.venv/bin/python -m py_compile app/services/face_recognition.py app/api/auth.py app/core/config.py

cd /Users/limjiale/IDP_PharmGuard/edge_pi
python3 -m py_compile vision/liveness.py vision/__init__.py main.py
```
EXPECT: zero output, exit 0 in both.

### Frontend Build
```bash
cd /Users/limjiale/IDP_PharmGuard/frontend && npm run build
```
EXPECT: green; `enrollFace` exported; new page route registered.

### Backend Smoke (live)
See Task 13. EXPECT: enrol returns 200 with `embedding_dim=128`; verify returns 200 with `distance < 0.6`.

### Database Validation
```sql
SELECT id, name, array_length(face_embedding, 1) AS dim
FROM public.patients WHERE face_embedding IS NOT NULL LIMIT 5;
```
EXPECT: each row has `dim=128`.

### Pi Hardware Live Test (operator step)
See Task 14. EXPECT: live face → 200 match; printed photo → "Liveness timed out".

### Manual Validation Checklist
- [ ] `backend/migrations/0002_face_embedding.sql` exists, applied via MCP or Studio.
- [ ] `backend/app/services/face_recognition.py` exists with both `compute_embedding` and `match_embedding`.
- [ ] `backend/app/api/auth.py`: 501 stub gone; `enroll_face` + real `verify_face` + login (still 501, intentional) all present.
- [ ] `face_recognition` installed in `backend/.venv`.
- [ ] `edge_pi/vision/liveness.py` exists; `LivenessDetector` exported from `vision/__init__.py`.
- [ ] `edge_pi/main.py::authenticate_patient` rewritten; right-patient invariant enforced.
- [ ] `frontend/src/lib/api.ts` exports `enrollFace`; `Patient` type includes `face_embedding`.
- [ ] `/patients/[id]/enroll` page renders; submit flow works against running backend.
- [ ] Patient detail page has the "Enrol / Re-enrol Face" link.
- [ ] PRD Phase 3 row flipped to `complete` after Pi hardware live test.

---

## Acceptance Criteria
- [ ] All 14 tasks completed.
- [ ] `verify-face` returns 200 with matching patient_id when probe matches enrolled patient.
- [ ] `verify-face` returns 401 on unknown probe.
- [ ] `enroll-face` rejects 0-face and >1-face images with 400.
- [ ] EAR-based blink liveness passes a real face within ≤15 s, rejects a printed photo at the timeout.
- [ ] Right-patient invariant: scheduled patient_id MUST match `verify-face` patient_id, else cycle skipped.
- [ ] Stub-mode safety guard preserved (HI-012). No falsified `pill_taken=true` from stubbed Pi.
- [ ] PRD Phase 3 row updated.

## Completion Checklist
- [ ] Backend follows discovered patterns (NAMING, SERVICE_LAYER, DATA_ACCESS, MIGRATION).
- [ ] Pi follows existing patterns (MEDIAPIPE_FACEMESH, CAMERA_INJECTION, LOGGING, PI_HTTP_REQUEST).
- [ ] Frontend follows existing patterns (TYPE_DEFINITION, FRONTEND_PAGE).
- [ ] No `face_recognition` import on the Pi.
- [ ] No silent fallbacks — failure paths return None / 4xx, never invent a match.
- [ ] PRD updated with this plan path + report path on completion.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `dlib` install fails on dev mac (no cmake) | M | M | Document `brew install cmake` prereq in Task 3; report.md handoff. |
| `face_recognition` accuracy weak on poor-quality phone selfies | M | M | Default tolerance 0.6 is liberal; tighten to 0.5 once enrolment stabilises. Phase 9 (accuracy validation) will tune. |
| EAR threshold mis-tunes for darker irises / glasses | M | L | Defaults (0.20 / 0.25) come from drowsiness-detection literature with broad applicability. |
| Photo-spoof bypass via video replay | M | M | Documented residual risk. |
| RLS on `face_embedding` exposes biometrics to unauthorised reads | L | H | Existing RLS on `patients` table inherits. Verify via `select` from anon role during Task 14. |
| `real[]` linear scan too slow at scale | L | L | Acceptable to ~500 patients. pgvector migration ready to swap in. |
| `cam_b` frame interval too slow for blink window | L | M | Phase 2 bench target p95 < 100 ms; blink ~150 ms gives 1–2 closed frames — sufficient. |
| Right-patient guard mis-fires when caregiver re-enrols mid-shift | L | L | Re-enrol updates atomically; next cycle picks up. |

## Notes
- **`enroll-face` is open in V1 by design** — Phase 7 (`/api/auth/login`) will gate it behind staff JWT.
- **Pi never holds the dlib model** — backend is the only embedding producer.
- **Pi's blink liveness is independent of the swallow FSM**, even though both use MediaPipe FaceMesh. They run at different cycle stages, separate FaceMesh instances.
- **Step-4 inverted-logic invariant from the swallow FSM is unaffected** — this plan does not touch `intake_monitor.py`.
- After this plan ships, update `pharmguard.prd.md` Phase 3 row to:
  ```
  | 3 | Face ID end-to-end | ... | in-progress | - | 1 | .claude/PRPs/plans/face-id-end-to-end.plan.md |
  ```
  Then `complete` once Task 14 passes.
- Highest external-dep risk of any phase so far (dlib/cmake build). Fallback: pre-built community wheels (https://github.com/ageitgey/face_recognition/issues/175).

Sources:
- [face_recognition library docs](https://face-recognition.readthedocs.io/en/latest/face_recognition.html)
- [face_recognition GitHub README](https://github.com/ageitgey/face_recognition)
- [DeepFace + 128-D FaceNet thresholds](https://datahacker.rs/025-facenet-a-unified-embedding-for-face-recognition-and-clustering-in-pytorch/)
- [MediaPipe FaceMesh EAR landmarks (research)](https://www.researchgate.net/figure/MediaPipe-Facemesh-Left-Eye-Landmarks-for-calculating-Eye-Aspect-Ratio-EAR_fig1_368318088)
- [LearnOpenCV Drowsiness Detection (EAR thresholds)](https://learnopencv.com/driver-drowsiness-detection-using-mediapipe-in-python/)
- [Adjusting EAR for blink detection (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9044337/)
