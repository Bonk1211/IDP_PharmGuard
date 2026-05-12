# Plan: Patient Identity Verification via AWS Rekognition (cam 1)

## Summary
Insert face-verification gate as first step of dispense flow. Cam 1 (patient-facing) grabs live JPEG; backend calls AWS Rekognition `CompareFaces` against active patient's reference photo stored in Supabase Storage. Step 1 ("Unlock") blocked until similarity ≥ threshold.

## User Story
As a caregiver, I want the dispenser to confirm patient's face matches the scheduled patient before unlocking the drawer, so wrong-patient dispensing is prevented.

## Problem → Solution
Today step 0 "Identify" is a passive banner — staff must eyeball patient match. → Cam 1 captures face, AWS Rekognition compares to stored reference image, drawer unlock denied below threshold.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A — free-form request
- **PRD Phase**: standalone
- **Estimated Files**: ~12 (backend service + endpoint + migration + frontend lib + UI card + env wiring)

---

## UX Design

### Before
```
┌── Step 0 Identify ────────────────────────────┐
│  PatientBanner (passive: name, age, next dose)│
│  → user clicks Next to advance                │
└───────────────────────────────────────────────┘
```

### After
```
┌── Step 0 Identify ────────────────────────────┐
│  PatientBanner (name, age, next dose)         │
│  ┌─ Live cam 1 ──────┐  ┌─ Reference photo ─┐ │
│  │ [MJPEG stream]    │  │ [Supabase URL]    │ │
│  └───────────────────┘  └────────────────────┘ │
│  [ Verify face ] → similarity 92.3% ✓ match    │
│  (Next disabled until match)                  │
└───────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Step 0 card | Banner only | Banner + cam 1 + ref + Verify CTA | Manual capture button |
| `stepIdx` derivation | Returns 1 immediately | Returns 0 until `faceVerified` true | Blocks Unlock card |
| `setDrawer("unlock")` | Always allowed | UI hides button until faceVerified | Backend stays callable (manual recovery) |
| Patient page | No face upload | New "Reference photo" upload widget | Edit patient flow |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/api/device.py` | 28-90, 269-291 | Router pattern, `verify_device_api_key`, snapshot/cam access |
| P0 | `backend/api/device.py` | 167-266 | `verify_pill` — mirror shape for `verify_face` (capture frame → call detector → return result) |
| P0 | `backend/scheduler/cycle_runner.py` | 117-130 | cam_b = cam 1, opened with `output_format="rgb"` for MediaPipe — must re-encode to JPEG for Rekognition |
| P0 | `backend/config.py` | 32-117 | Settings class shape, `validate_runtime` for required-keys check |
| P0 | `backend/core/security.py` | 53-75 | `verify_device_api_key` dep used by all `/api/device/*` routes |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 322-336 | `stepIdx` derivation — must add `faceVerified` gate |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 581-596 | Step 0 card render — where new UI inserts |
| P1 | `frontend/src/lib/device.ts` | 198-301 | `manualEject` / `verifyPill` pattern → mirror as `verifyFace` |
| P1 | `frontend/src/lib/api.ts` | 1-101 | Patient type + `updatePatient` for reference URL field |
| P1 | `backend/migrations/0002_face_embedding.sql` | all | Existing face column — ADD new `face_reference_url` column |
| P1 | `backend/requirements.txt` | all | Add `boto3` for AWS SDK |
| P2 | `frontend/src/app/patients/[id]/page.tsx` | all | Where the reference photo uploader goes |
| P2 | `backend/api/device.py` | 470-634 | MJPEG stream — cam 1 stream already exposed; UI re-uses |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Rekognition CompareFaces | https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CompareFaces.html | `Bytes` field for raw JPEG/PNG; default `SimilarityThreshold=80`; response `.FaceMatches[0].Similarity` (0-100). Returns `InvalidParameterException` if no face detected. Max 5 MB image when using Bytes. |
| boto3 rekognition client | https://docs.aws.amazon.com/boto3/latest/reference/services/rekognition/client/compare_faces.html | `boto3.client("rekognition", region_name=...).compare_faces(SourceImage={"Bytes": b}, TargetImage={"Bytes": b}, SimilarityThreshold=80, QualityFilter="AUTO")` |
| Supabase Storage Python | https://supabase.com/docs/reference/python/storage-from-download | `sb.storage.from_(bucket).download(path)` returns bytes |
| Pricing | https://aws.amazon.com/rekognition/pricing/ | $0.001 per CompareFaces call (us-east). Free tier 5000/mo first 12 months. |

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: backend/api/device.py:174-266
```python
class VerifyPillBody(BaseModel):
    expected: str | None = None

@router.post("/verify_pill")
async def verify_pill(body: VerifyPillBody, request: Request):
    ...
```
Snake_case route, PascalCase Pydantic body, async + `Request` for app.state access.

### ERROR_HANDLING
// SOURCE: backend/api/device.py:185-194
```python
loop = _get_loop(request)
if loop is None:
    raise HTTPException(status_code=503, detail="Headless mode — no cameras")
state = getattr(loop, "_state", None)
cam = getattr(state, "cam_a", None) if state else None
if cam is None or not hasattr(cam, "read_frame"):
    raise HTTPException(status_code=503, detail="cam_0 not open")
...
frame = await asyncio.to_thread(cam.read_frame)
if frame is None:
    raise HTTPException(status_code=503, detail="No frame available")
```
503 for hardware-not-ready, 400 for bad input (pydantic auto), bare `raise HTTPException`.

### LOGGING_PATTERN
// SOURCE: backend/api/device.py:250-257
```python
log = logging.getLogger(__name__)
...
log.info(
    "verify_pill: top=%s conf=%.2f expected=%s match=%s latency_ms=%d",
    top["class_name"] if top else None,
    top["confidence"] if top else 0.0, expected, match, latency_ms,
)
```
Module-level logger, `%`-style, single line per outcome, latency in ms.

### BLOCKING_IO_OFFLOAD
// SOURCE: backend/api/device.py:192, 235
```python
frame = await asyncio.to_thread(cam.read_frame)
detections, snapshot_b64 = await asyncio.to_thread(_run)
```
All blocking calls (camera, YOLO, supabase, boto3) MUST go through `asyncio.to_thread`.

### CONFIG_SETTINGS
// SOURCE: backend/config.py:56-79
```python
device_api_key: str = ""
backend_headless: bool = False
agent_flag_low_confidence_threshold: float = 0.55
```
Snake_case fields with safe defaults; required-in-production checks live in `validate_runtime()`.

### SUPABASE_QUERY
// SOURCE: backend/api/device.py:317-326
```python
sb = get_supabase()
def _query():
    return sb.table("patients").select("id, face_reference_url").eq("id", pid).execute()
result = await asyncio.to_thread(_query)
return result.data or []
```
Always wrap supabase calls in `asyncio.to_thread`; `get_supabase()` singleton.

### FRONTEND_DEVICE_CALL
// SOURCE: frontend/src/lib/device.ts:267-301
```typescript
export async function verifyPill(expected?: string): Promise<VerifyPillResult> {
  if (!isDeviceConfigured()) return empty;
  try {
    const r = await fetch(`${baseUrl}/api/device/verify_pill`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ expected: expected ?? null }),
    });
    if (!r.ok) return { ...empty, status: r.status, error: await safeError(r) };
    const data = await r.json();
    return { ok: true, status: r.status, /* ...map fields */ };
  } catch { return empty; }
}
```
Type-safe result with `ok/status/error`, never throws, returns empty result when not configured.

### FRONTEND_STEP_GATE
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:322-336
```typescript
const stepIdx = useMemo(() => {
  if (!activePatient) return 0;
  if (activeSlots.length > 0 && currentSlot && confirmedSlots.has(currentSlot.slot)) return 5;
  if (intake?.result === "passed") return 4;
  if (intake?.running) return 3;
  if (drawerUnlocked) return 2;
  return 1;
}, [activePatient, intake, currentSlot, confirmedSlots, drawerUnlocked, activeSlots]);
```
useMemo over derived state; new gate slots **between** `!activePatient` and `drawerUnlocked` checks.

### MIGRATION_IDEMPOTENT
// SOURCE: backend/migrations/0002_face_embedding.sql:5-18
```sql
ALTER TABLE public.patients
    ADD COLUMN IF NOT EXISTS face_embedding real[];
CREATE INDEX IF NOT EXISTS patients_has_face_embedding_idx
    ON public.patients ((face_embedding IS NOT NULL));
```
`IF NOT EXISTS` everywhere, header comment naming plan + PRD.

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/migrations/0008_face_reference.sql` | CREATE | Add `face_reference_url text` column on `patients` |
| `backend/services/face_verify.py` | CREATE | Wraps boto3 Rekognition call; lazy boto3 import; encodes frame to JPEG bytes |
| `backend/api/device.py` | UPDATE | Add `POST /api/device/verify_face` endpoint mirroring `verify_pill` |
| `backend/config.py` | UPDATE | Add `aws_region`, `aws_access_key_id`, `aws_secret_access_key`, `face_similarity_threshold` settings |
| `backend/.env.example` | UPDATE | Document new AWS env vars |
| `backend/requirements.txt` | UPDATE | Add `boto3>=1.34.0` |
| `frontend/src/lib/device.ts` | UPDATE | Add `verifyFace(patientId)` → `{ok, similarity, match, error}` |
| `frontend/src/lib/api.ts` | UPDATE | Extend `Patient` with `face_reference_url`; extend `PatientPatch`; add `uploadPatientFaceReference(id, file)` using `supabase.storage` |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | New `FaceVerifySection` for `viewIdx===0`; `faceVerified` state; gate `stepIdx`; reset on patient change |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATE | Reference-photo uploader widget |
| Supabase Storage | CREATE (one-time setup) | New bucket `patient-faces` with service-role write, public read |

## NOT Building

- On-device face recognition (dlib / face_recognition) — Rekognition only, per request.
- Backend enforcement of unlock-after-verify (server-side drawer lock). Only UI gate this phase — drawer endpoint stays callable for manual recovery. Server-side gate can be added later if required.
- Liveness / anti-spoofing checks.
- Multi-face source images: assume each patient has one cropped face photo.
- Face enrollment with Rekognition Collections — single reference photo per patient.
- Caching Rekognition results — every verify is a fresh API call (~$0.001 each).
- Re-using existing `patients.face_embedding` (real[128]) or `face_encoding` (text) — dlib remnants, leave untouched.

---

## Step-by-Step Tasks

### Task 1: Add migration `0008_face_reference.sql`
- **ACTION**: Create new migration file
- **IMPLEMENT**:
  ```sql
  -- Phase: AWS Rekognition face-verify reference image
  -- Plan: .claude/PRPs/plans/patient-face-verify-rekognition.plan.md
  -- Idempotent.
  ALTER TABLE public.patients
      ADD COLUMN IF NOT EXISTS face_reference_url text;
  ```
- **MIRROR**: MIGRATION_IDEMPOTENT
- **VALIDATE**: `mcp__supabase__apply_migration` or psql; re-run twice — second run is a no-op.

### Task 2: Create Supabase Storage bucket `patient-faces`
- **ACTION**: One-time setup via Supabase dashboard or MCP
- **IMPLEMENT**: bucket name `patient-faces`, public read enabled (signed URLs optional), max file size 5 MB (Rekognition `Bytes` upper bound).
- **GOTCHA**: Bucket must allow service-role write (frontend uses anon → either use a signed upload URL OR loosen RLS on `storage.objects` for that bucket; pick whichever matches existing project policy).
- **VALIDATE**: Upload test JPEG via dashboard; fetch its public URL.

### Task 3: Extend `Settings` with AWS + threshold
- **ACTION**: Update `backend/config.py`
- **IMPLEMENT**:
  ```python
  aws_region: str = "ap-southeast-1"
  aws_access_key_id: str = ""
  aws_secret_access_key: str = ""
  face_similarity_threshold: float = 80.0  # Rekognition 0-100
  ```
  Do NOT add a hard check to `validate_runtime` — surface 503 at call time when keys missing so the dispense cycle still runs.
- **MIRROR**: CONFIG_SETTINGS
- **GOTCHA**: Keep import-time side-effect-free. Don't fail uvicorn boot when AWS keys missing — face-verify is opt-in.

### Task 4: Update `backend/.env.example`
- **ACTION**: Append AWS block under `# ─── Vision ───`
- **IMPLEMENT**:
  ```dotenv
  # ─── AWS Rekognition (patient face verify, cam 1) ───
  AWS_REGION=ap-southeast-1
  AWS_ACCESS_KEY_ID=
  AWS_SECRET_ACCESS_KEY=
  # CompareFaces similarity threshold (0-100). Default 80.
  FACE_SIMILARITY_THRESHOLD=80
  ```
- **VALIDATE**: `cp .env.example .env.test` parses cleanly under `pydantic-settings`.

### Task 5: Add `boto3` to requirements
- **ACTION**: Update `backend/requirements.txt`
- **IMPLEMENT**: Add `boto3>=1.34.0` under `# ── Data plane ──`
- **GOTCHA**: boto3 wheel works on aarch64 piwheels — no `platform_machine` gating needed.
- **VALIDATE**: `pip install -r requirements.txt` succeeds on dev-mac and Pi.

### Task 6: Create `backend/services/face_verify.py`
- **ACTION**: New service module
- **IMPLEMENT**:
  ```python
  """AWS Rekognition CompareFaces wrapper for patient identity verification."""
  from __future__ import annotations
  import logging
  import cv2
  import numpy as np
  from config import settings

  log = logging.getLogger(__name__)
  _client = None  # lazy

  def _get_client():
      global _client
      if _client is not None:
          return _client
      import boto3  # lazy: avoid import cost when face-verify unused
      _client = boto3.client(
          "rekognition",
          region_name=settings.aws_region,
          aws_access_key_id=settings.aws_access_key_id or None,
          aws_secret_access_key=settings.aws_secret_access_key or None,
      )
      return _client

  def encode_frame_jpeg(frame: np.ndarray, quality: int = 85) -> bytes:
      """RGB or BGR ndarray → JPEG bytes. cam_b is RGB so convert first."""
      # cam_b output_format='rgb' (cycle_runner.py:118) — convert for cv2 encode.
      bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if frame.shape[2] == 3 else frame
      ok, jpeg = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
      if not ok:
          raise RuntimeError("JPEG encode failed")
      return jpeg.tobytes()

  def compare_faces(source_jpeg: bytes, target_jpeg: bytes, threshold: float) -> dict:
      """Call Rekognition CompareFaces. Returns
      {match: bool, similarity: float|None, error: str|None}.
      """
      try:
          resp = _get_client().compare_faces(
              SourceImage={"Bytes": source_jpeg},
              TargetImage={"Bytes": target_jpeg},
              SimilarityThreshold=float(threshold),
              QualityFilter="AUTO",
          )
      except Exception as exc:  # ClientError, EndpointConnectionError, etc.
          log.warning("Rekognition CompareFaces failed: %s", exc)
          return {"match": False, "similarity": None, "error": str(exc)}
      matches = resp.get("FaceMatches") or []
      if not matches:
          return {"match": False, "similarity": 0.0, "error": None}
      best = max(m.get("Similarity", 0.0) for m in matches)
      return {"match": best >= threshold, "similarity": float(best), "error": None}
  ```
- **MIRROR**: BLOCKING_IO_OFFLOAD (caller wraps in `asyncio.to_thread`), LOGGING_PATTERN
- **IMPORTS**: boto3 lazy inside `_get_client` (saves ~300 ms import + lets dev-mac without boto3 still boot).
- **GOTCHA**:
  - cam_b is RGB; OpenCV `imencode` needs BGR.
  - boto3 raises `InvalidParameterException` when source/target has no face — caller treats `error != None` as soft-fail.
  - DON'T pass region as `None` — boto3 then falls back to env which may not be set; settings provides default.

### Task 7: Add `POST /api/device/verify_face` endpoint
- **ACTION**: Edit `backend/api/device.py`
- **IMPLEMENT**: New endpoint after `verify_pill` (~line 267):
  ```python
  class VerifyFaceBody(BaseModel):
      patient_id: int

  @router.post("/verify_face")
  async def verify_face(body: VerifyFaceBody, request: Request):
      """Capture one frame from cam 1, compare to patient's reference
      photo via AWS Rekognition. 503 when hardware/cam not ready, 400
      when patient has no face_reference_url.
      """
      loop = _get_loop(request)
      if loop is None:
          raise HTTPException(status_code=503, detail="Headless mode — no cameras")
      state = getattr(loop, "_state", None)
      cam = getattr(state, "cam_b", None) if state else None
      if cam is None or not hasattr(cam, "read_frame"):
          raise HTTPException(status_code=503, detail="cam_1 not open")

      sb = get_supabase()
      def _fetch_patient():
          return (sb.table("patients")
                  .select("id, name, face_reference_url")
                  .eq("id", body.patient_id).execute())
      result = await asyncio.to_thread(_fetch_patient)
      rows = result.data or []
      if not rows:
          raise HTTPException(status_code=404, detail=f"patient {body.patient_id} not found")
      ref_url = rows[0].get("face_reference_url")
      if not ref_url:
          raise HTTPException(status_code=400, detail="patient has no face_reference_url")

      import requests
      def _fetch_ref() -> bytes:
          r = requests.get(ref_url, timeout=5)
          r.raise_for_status()
          return r.content
      try:
          ref_bytes = await asyncio.to_thread(_fetch_ref)
      except Exception as exc:
          log.warning("face reference fetch failed: %s", exc)
          raise HTTPException(status_code=502, detail=f"reference fetch failed: {exc}")

      t0 = time.monotonic()
      frame = await asyncio.to_thread(cam.read_frame)
      if frame is None:
          raise HTTPException(status_code=503, detail="No frame available")

      from services.face_verify import compare_faces, encode_frame_jpeg
      live_bytes = await asyncio.to_thread(encode_frame_jpeg, frame)
      verdict = await asyncio.to_thread(
          compare_faces, ref_bytes, live_bytes, settings.face_similarity_threshold,
      )
      latency_ms = int((time.monotonic() - t0) * 1000)
      log.info(
          "verify_face: patient=%d match=%s similarity=%s latency_ms=%d",
          body.patient_id, verdict["match"], verdict["similarity"], latency_ms,
      )
      return {
          "ok": verdict["error"] is None,
          "patient_id": body.patient_id,
          "match": bool(verdict["match"]),
          "similarity": verdict["similarity"],
          "threshold": settings.face_similarity_threshold,
          "error": verdict["error"],
          "latency_ms": latency_ms,
      }
  ```
- **MIRROR**: ERROR_HANDLING, LOGGING_PATTERN, BLOCKING_IO_OFFLOAD, SUPABASE_QUERY
- **IMPORTS**: `from config import settings` already present; `requests` already in requirements.txt; service module from Task 6.
- **GOTCHA**:
  - cam_b not cam_a — operator/patient-facing camera.
  - Reference image fetched via public URL — if bucket is private, swap `requests.get(ref_url)` for `sb.storage.from_("patient-faces").download(path)`.
  - No DB write side-effect — verification is ephemeral. Caller decides whether to record.
- **VALIDATE**: Headless mode → 503; missing reference → 400; happy path → 200 with `match` boolean.

### Task 8: Add `verifyFace` to `frontend/src/lib/device.ts`
- **ACTION**: Append after `verifyPill`
- **IMPLEMENT**:
  ```typescript
  export type VerifyFaceResult = {
    ok: boolean;
    status: number;
    match: boolean;
    similarity: number | null;
    threshold: number | null;
    error?: string;
    latency_ms?: number;
  };

  export async function verifyFace(patientId: number): Promise<VerifyFaceResult> {
    const empty: VerifyFaceResult = {
      ok: false, status: 0, match: false, similarity: null, threshold: null,
    };
    if (!isDeviceConfigured()) return empty;
    try {
      const r = await fetch(`${baseUrl}/api/device/verify_face`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patient_id: patientId }),
      });
      if (!r.ok) return { ...empty, status: r.status, error: await safeError(r) };
      const d = await r.json();
      return {
        ok: !!d.ok,
        status: r.status,
        match: !!d.match,
        similarity: d.similarity ?? null,
        threshold: d.threshold ?? null,
        latency_ms: d.latency_ms,
        error: d.error ?? undefined,
      };
    } catch { return empty; }
  }
  ```
- **MIRROR**: FRONTEND_DEVICE_CALL
- **VALIDATE**: `npm run lint`; no `any` leaked.

### Task 9: Extend Patient type + upload helper in `lib/api.ts`
- **ACTION**: Update `Patient`, `PatientPatch`, add `uploadPatientFaceReference`
- **IMPLEMENT**:
  ```typescript
  export interface Patient {
    /* ...existing... */
    face_reference_url: string | null;
  }
  export type PatientPatch = Partial<{
    /* ...existing... */
    face_reference_url: string | null;
  }>;

  export async function uploadPatientFaceReference(
    patientId: number, file: File,
  ): Promise<string> {
    const path = `${patientId}/${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage
      .from("patient-faces")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;
    const { data } = supabase.storage.from("patient-faces").getPublicUrl(path);
    await updatePatient(patientId, { face_reference_url: data.publicUrl });
    return data.publicUrl;
  }
  ```
- **VALIDATE**: Upload test JPEG from patient page; refresh; URL persists.

### Task 10: Insert face-verify card in dispenser page step 0
- **ACTION**: Edit `frontend/src/app/dispensers/[id]/page.tsx`
- **IMPLEMENT**:
  1. New state: `const [faceVerified, setFaceVerified] = useState<boolean>(false);` and `const [faceResult, setFaceResult] = useState<VerifyFaceResult | null>(null);`
  2. Reset both when `activePatient?.id` changes.
  3. New `stepIdx` gate (REPLACE 322-336):
     ```typescript
     const stepIdx = useMemo(() => {
       if (!activePatient) return 0;
       if (!faceVerified) return 0;  // NEW gate
       if (activeSlots.length > 0 && currentSlot && confirmedSlots.has(currentSlot.slot)) return 5;
       if (intake?.result === "passed") return 4;
       if (intake?.running) return 3;
       if (drawerUnlocked) return 2;
       return 1;
     }, [activePatient, faceVerified, intake, currentSlot, confirmedSlots, drawerUnlocked, activeSlots]);
     ```
  4. `viewIdx === 0` block: replace bare `PatientBanner` with banner + `FaceVerifySection` showing cam 1 stream (`streamUrl(1)`), reference `<img src={activePatient.face_reference_url}/>`, `Verify face` button calling `verifyFace(activePatient.id)`, similarity readout, and `setFaceVerified(true)` on match.
  5. `canNext` in step 0 → require `faceVerified`.
- **MIRROR**: FRONTEND_STEP_GATE
- **GOTCHA**:
  - When `activePatient.face_reference_url` is null, show inline warning + link to `/patients/<id>` to upload — DON'T allow bypass.
  - Reset `faceVerified` whenever active patient ID changes (next-round patient swap).
  - cam 1 stream URL re-uses existing `streamUrl(1)` — no new device API needed for the preview.
- **VALIDATE**: `npm run dev`; happy path: button → similarity ≥ threshold → stepIdx advances to 1.

### Task 11: Add reference-photo uploader to patient page
- **ACTION**: Edit `frontend/src/app/patients/[id]/page.tsx`
- **IMPLEMENT**: New "Reference photo" card with `<input type="file" accept="image/jpeg,image/png" />` → on change calls `uploadPatientFaceReference(id, file)` → toast + refresh.
- **GOTCHA**: Enforce client-side size ≤ 5 MB (Rekognition Bytes cap). Reject HEIC.
- **VALIDATE**: Upload, reload, image renders; subsequent verify call succeeds.

### Task 12: Smoke test end-to-end on dev-mac (headless) + Pi
- **ACTION**: Verify HTTP shape + degraded path on dev-mac; full flow on Pi
- **IMPLEMENT**:
  - dev-mac (BACKEND_HEADLESS=1): `POST /api/device/verify_face` returns 503 with `"Headless mode — no cameras"` (confirms guard).
  - Pi: dashboard → cam 1 visible → upload reference → click Verify → similarity printed → drawer unlock allowed.
- **VALIDATE**: see Validation Commands.

---

## Testing Strategy

There is **no test suite in this repo** (per CLAUDE.md). All validation is manual + existing `backend/scripts/` benchmarks. Do not add pytest/vitest infra unless the user asks.

### Manual Test Matrix
| Test | Input | Expected | Edge Case? |
|---|---|---|---|
| Happy path | Correct patient at cam 1 | similarity ≥ threshold, match true, stepIdx advances | No |
| Wrong patient | Different face at cam 1 | similarity < threshold, match false, stepIdx pinned at 0 | Yes |
| No face in frame | Cam 1 sees empty chair | `error != null` (InvalidParameterException), match false, surfaced as toast | Yes |
| No reference uploaded | patients.face_reference_url null | 400 from backend, UI prompts to upload, no Verify button | Yes |
| AWS creds missing | empty AWS_ACCESS_KEY_ID | boto3 ClientError → `ok=false, error=...`, UI shows error and blocks | Yes |
| Reference URL 404 | Bucket file deleted | 502 from backend, UI shows fetch-failed toast | Yes |
| Headless dev-mac | BACKEND_HEADLESS=1 | 503 "no cameras", Verify button greys | Yes |
| Patient swap mid-round | activePatient ID changes | faceVerified resets to false, UI returns to step 0 | Yes |

---

## Validation Commands

### Backend syntax / import
```bash
cd backend
python -c "from services.face_verify import compare_faces, encode_frame_jpeg; from api.device import router; print('ok')"
```
EXPECT: prints `ok` with no traceback (boto3 lazy-import doesn't fire here).

### FastAPI boot (headless mac)
```bash
cd backend
BACKEND_HEADLESS=1 PHARMGUARD_STUB=1 uvicorn main:app --port 8000
curl -s -X POST localhost:8000/api/device/verify_face \
  -H 'X-Device-API-Key: '"$DEVICE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"patient_id": 1}'
```
EXPECT: 503 `{"detail":"Headless mode — no cameras"}`.

### Migration
```bash
psql "$SUPABASE_DB_URL" -f backend/migrations/0008_face_reference.sql
psql "$SUPABASE_DB_URL" -c "\d public.patients" | grep face_reference_url
```
EXPECT: column present.

### Frontend lint
```bash
cd frontend
npm run lint
```
EXPECT: zero errors. (No type checker configured — `next build` is the strictest gate.)

### Frontend dev smoke
```bash
cd frontend && npm run dev
# Open http://localhost:3000/dispensers/<id>
# Step 0 must show cam 1 preview + reference photo + Verify button.
```

### Pi end-to-end
```bash
# on Pi
sudo systemctl restart pharmguard
journalctl -u pharmguard -f | grep verify_face
```
EXPECT: log line `verify_face: patient=<id> match=True similarity=92.x latency_ms=...` within ~1 s of clicking Verify.

### Manual Validation
- [ ] Migration applied (column visible in Supabase Studio)
- [ ] Bucket `patient-faces` exists, public read confirmed
- [ ] Reference photo uploaded for at least one patient
- [ ] AWS creds in `backend/.env`; restart picks them up
- [ ] Verify with correct patient → match
- [ ] Verify with wrong patient → no-match; UI blocks Next
- [ ] Patient without reference → UI prompts upload, no API call

---

## Acceptance Criteria
- [ ] Migration applied; `face_reference_url` column on `patients`.
- [ ] Supabase Storage bucket `patient-faces` created.
- [ ] `POST /api/device/verify_face` returns documented shape.
- [ ] Frontend step 0 blocks Unlock until match.
- [ ] AWS keys missing → graceful failure, not crash.
- [ ] No lint regression in frontend.
- [ ] `BACKEND_HEADLESS=1` still boots without boto3 errors.

## Completion Checklist
- [ ] All new code matches discovered patterns (snake_case backend, camelCase frontend, `asyncio.to_thread` wraps).
- [ ] No hardcoded AWS region or threshold — all via `settings`.
- [ ] Single-line `log.info` for verify outcomes.
- [ ] `verifyFace` never throws (returns empty result on failure).
- [ ] No new tests added (per repo convention).
- [ ] CLAUDE.md not modified (no new conventions introduced).

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AWS Rekognition latency >2 s on slow link | Medium | UX feels stuck | Spinner, 10 s frontend timeout, surface latency_ms |
| Anon-key bucket misconfigured → public reference URLs leak PHI | Medium | Privacy issue | Signed URLs OR keep bucket private + service-role download in backend (swap `requests.get` for `sb.storage.from_().download`) |
| Demo cam 1 lighting too poor for Rekognition | Medium | False rejects | Default threshold 80 (Rekognition default); allow override via env; one-tap re-verify |
| boto3 not installed on existing Pi venv | Low | 500 on first call | `pip install -r requirements.txt` after pull; lazy import means missing dep only fails the verify call, not boot |
| Existing `face_encoding` / `face_embedding` columns are stale | Low | Confusion for future maintainer | Don't touch them; new column lives alongside until cleanup PR |
| Cost spike from accidental polling | Low | $$$ | Only call on Verify-button click, NEVER on stepIdx poll (no useEffect interval) |

## Notes
- Single-patient-per-Pi model still applies — `activePatient` is derived from earliest-scheduled slot. Face verify confirms that patient is at the cabinet, not which patient.
- cam_b is opened with `output_format="rgb"` for MediaPipe — `encode_frame_jpeg` converts to BGR before `cv2.imencode`. Skipping this step ships an inverted-channel image to Rekognition (red/blue swapped, similarity tanks).
- Reference image fetched per verify call. If this becomes a bottleneck, cache `(patient_id, url) -> bytes` on `app.state`, invalidated when `face_reference_url` changes.
- Rekognition `CompareFaces` source vs target: API picks the **largest face** in source as reference; either order works. For clarity: `source=reference_photo`, `target=live_capture`.
