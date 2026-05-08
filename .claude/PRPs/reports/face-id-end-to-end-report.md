# Implementation Report: Face ID End-to-End (PRD Phase 3)

## Summary
Replaced the `POST /api/auth/verify-face` 501 stub with a real face-recognition implementation backed by `face_recognition` (dlib, ResNet-34, 128-D Euclidean). Added a sibling `POST /api/auth/enroll-face` endpoint for caregivers. Persisted embeddings as a `real[]` column on `patients` via a new migration (`0002_face_embedding.sql`, applied to live Supabase). Built a Pi-side `LivenessDetector` that runs MediaPipe FaceMesh against `cam_b` and only forwards a face crop after a confirmed blink (EAR drop + recovery). Wired the Pi main loop with a right-patient gate before magazine rotation. Added a `/patients/[id]/enroll` page for caregiver upload and a small "Enrol Face" link on the patient detail page. **Pi hardware live test (Task 14) is operator-attested and remains the only outstanding step.**

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Large | Large |
| Confidence | 6/10 | 8/10 (dlib install succeeded first try; backend boots) |
| Files Changed | 12 | 13 |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | SQL migration `0002_face_embedding.sql` | Complete | Idempotent, 128-D CHECK constraint, partial index |
| 2 | Apply migration via Supabase MCP | Complete | `success: true`; column verified `data_type=ARRAY, is_nullable=YES` |
| 3 | Add `face_recognition` + install | Complete | dlib 20.0.1 wheel built (cmake 4.1.2 present); face_recognition 1.3.0, numpy 2.2.6, Pillow 12.2.0 installed |
| 4 | `services/face_recognition.py` | Complete | Lazy heavy imports per service convention; synthetic-vector smoke green |
| 5 | Replace `verify_face` + add `enroll_face` | Complete | Both endpoints live; `login` 501 preserved; OpenAPI exposes 3 routes |
| 6 | `face_match_tolerance` setting | Complete | Default 0.6, env-overridable; `.env.example` documented |
| 7 | `vision/liveness.py` | Complete | EAR thresholds 0.20/0.25 hysteresis; right & left eye 6-pt indices; JPEG crop on blink |
| 8 | `vision/__init__.py` re-export | Complete | Alphabetised; exports `LivenessDetector` |
| 9 | Wire liveness into Pi `main.py` | Complete | `authenticate_patient(detector)` rewritten; right-patient invariant + stub-mode bypass both present |
| 10 | Frontend types + `enrollFace` | Complete | `Patient.face_embedding: number[] \| null` added; helper uses `fetch` against `NEXT_PUBLIC_API_BASE_URL` |
| 11 | `/patients/[id]/enroll` page | Complete | File picker + preview + submit; build registered route at 2.17 kB |
| 12 | Enrol Face link on detail page | Complete | Label flips Enrol/Re-enrol based on `face_embedding` |
| 13 | Validation suite | Complete | py_compile clean (3 backend + 3 Pi), `next build` green, backend boots, OpenAPI publishes all 3 auth routes |
| 14 | Pi hardware live test | **Blocked — operator step** | Requires Pi 5 with cam_b + real face + printed-photo spoof check |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Backend Python (`py_compile`) | Pass | `app/services/face_recognition.py`, `app/api/auth.py`, `app/core/config.py` all clean |
| Pi Python (`py_compile`) | Pass | `vision/liveness.py`, `vision/__init__.py`, `main.py` all clean |
| Frontend TypeScript (`next build`) | Pass | 8 routes prerendered (was 7); new `/patients/[id]/enroll` registered as dynamic |
| `face_recognition` import smoke | Pass | Library, dlib, numpy 2.2.6 all load; module reports version 1.2.3 (lib's internal `__version__` lags pip; pip-resolved 1.3.0) |
| Service synthetic smoke | Pass | garbage bytes → None; empty candidates → None; identical vectors → `(42, 0.0)`; far-apart → None |
| Backend boot + OpenAPI | Pass | uvicorn starts; `/health` returns 200; `/api/auth/{enroll-face, verify-face, login}` all published as POST |
| Database column verification | Pass | `patients.face_embedding` exists, `data_type=ARRAY`, `is_nullable=YES`; CHECK constraint on dim=128 active |
| Live face enrol/verify (curl) | **Deferred** | Backend `.env` lacks `DEVICE_TOKENS`; needs operator to set token + provide a real face JPEG |
| Pi hardware live test | **Deferred** | Operator-attested only |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `backend/migrations/0002_face_embedding.sql` | CREATED | +18 |
| `backend/requirements.txt` | UPDATED | +1 |
| `backend/app/services/face_recognition.py` | CREATED | +75 |
| `backend/app/api/auth.py` | UPDATED | full rewrite, ~90 lines (+82 net) |
| `backend/app/core/config.py` | UPDATED | +1 |
| `backend/.env.example` | UPDATED | +2 |
| `edge_pi/vision/liveness.py` | CREATED | +106 |
| `edge_pi/vision/__init__.py` | UPDATED | +2 / -0 |
| `edge_pi/main.py` | UPDATED | +25 / -8 |
| `frontend/src/lib/api.ts` | UPDATED | +24 / -0 |
| `frontend/.env.local.example` | UPDATED | +2 |
| `frontend/src/app/patients/[id]/page.tsx` | UPDATED | +9 / -3 |
| `frontend/src/app/patients/[id]/enroll/page.tsx` | CREATED | +88 |

Plus the planning artifacts already committed in the Phase 2 commit (Phase 3 plan, PRD Phase 3 row).

## Deviations from Plan

- **`face_recognition` library version reported as 1.2.3 in `__version__` attribute** despite `pip` installing 1.3.0. Library quirk; functional in all paths.
- **Pi `intake_monitor.py` left untouched** — plan was already explicit about this; recording as positive confirmation since the swallow FSM is critical.
- **Synthetic vector smoke added** to validation flow as a substitute for the operator-attested live enrol/verify (which needs a real face image + DEVICE_TOKENS). Strengthens the local validation envelope without expanding scope.
- **Backend boot probe** added as a final validation step (uvicorn + OpenAPI) — confirms the new router + service load without runtime errors. Beyond plan, but cheap.
- **Plan estimated 12 files, this ships 13** — counted `frontend/.env.local.example` separately; the plan rolled it into the helper task.
- **Stayed on `main`** per user choice; Phase 2 was committed first (commit `7c6495c`) before Phase 3 began, also per user choice.

## Issues Encountered

1. **Initial `pip install face_recognition>=1.3.0,<2.0.0` got mangled by zsh** treating `<` as redirection. Re-ran with quoted spec; install succeeded (dlib wheel built locally in ~2 min, faster than the predicted 3–5).
2. **`numpy` upgraded to 2.2.6** during the install. No issue for backend — backend doesn't pin numpy. Pi runtime is unaffected (separate venv on the Pi).
3. **GateGuard fact-forcing hook** continued to fire on every Edit/Write as in Phases 1–2. User-tolerated friction; not a code issue.
4. **No actual blockers** — every task landed first or second try after the GateGuard pass.

## Tests Written

None — repo has no test framework. Validation = py_compile + AST/textual regression + synthetic-vector smoke + uvicorn boot + OpenAPI introspection. The new `services/face_recognition.py` is the only function-level addition that would benefit from unit tests; deferred to a future TDD pass.

## Open Handoff Items

To finish Phase 3 the user must:

1. **Set `DEVICE_TOKENS=<token>`** in `backend/.env` (token format: 16+ chars).
2. **Enrol a test patient** via the dashboard:
   - Start backend: `make backend`
   - Start frontend: `make frontend`
   - Visit `http://localhost:3000/patients/<id>/enroll`, upload a single-face photo, submit.
3. **Live curl smoke**:
   ```bash
   cd backend
   TOKEN="$(grep '^DEVICE_TOKENS=' .env | cut -d= -f2- | cut -d, -f1)"
   curl -fsS -X POST http://localhost:8000/api/auth/verify-face \
        -H "Authorization: Bearer $TOKEN" \
        -F "file=@/path/to/same_or_different_photo.jpg"
   ```
   Expect 200 with `{"patient_id": <id>, "name": "...", "distance": <0.6}` for matching photo, 401 for non-matching.
4. **Pi hardware live test** (Task 14):
   - Sync to Pi: `make pi-sync HOST=pi@<host>`
   - Confirm dual cams: `ssh pi@<host> 'rpicam-hello --list-cameras'`
   - Run main: `ssh pi@<host> 'cd ~/IDP_PharmGuard/edge_pi && BACKEND_URL=https://<host> DEVICE_TOKEN=<token> DISPENSER_ID=dispenser-001 python3 main.py'`
   - Sit in front of cam_b, blink. Watch for `Blink confirmed (EAR transition)` log + `Face match: patient_id=...` log.
   - Try a printed photo of the same person — expect `Liveness timed out after 15.0s`.
5. **Commit the change set**. Suggested message:
   ```
   feat(phase3): face ID end-to-end with dlib embeddings + EAR blink liveness

   - 0002_face_embedding migration adds patients.face_embedding real[] (128-D)
     with dimensionality CHECK and partial index.
   - app/services/face_recognition.py wraps face_recognition (dlib) for
     128-D Euclidean matching (default tolerance 0.6, env-overridable).
   - /api/auth/verify-face is real and device-token gated. /api/auth/enroll-face
     is open in V1 (Phase 7 will gate behind staff JWT).
   - vision/liveness.py runs MediaPipe FaceMesh EAR-blink detection on cam_b;
     refuses printed photos by waiting for a real EAR transition.
   - main.py rewires authenticate_patient to capture-then-POST and adds the
     right-patient invariant: refuse to dispense when scheduled patient_id
     does not match the verified one.
   - /patients/[id]/enroll page lets caregivers upload a photo from the
     dashboard. Patient detail page shows Enrol/Re-enrol Face link.
   ```
6. **Flip PRD Phase 3 status** to `complete` after Pi live test passes.

## Next Steps
- [ ] User: set `DEVICE_TOKENS`, enrol a patient, run curl smoke.
- [ ] User: Pi hardware live test (Task 14).
- [ ] User: commit change set on `main`.
- [ ] After: `/prp-plan .claude/PRPs/prds/pharmguard.prd.md` picks up the next eligible phase. Phase 4 (Diverter + drawer-lock) and Phase 5 (Sensors + alerts) both unblocked by Phase 2; Phase 7 (Frontend dashboard surfaces) by Phase 1.
