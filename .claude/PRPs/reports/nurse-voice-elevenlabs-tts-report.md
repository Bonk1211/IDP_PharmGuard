# Implementation Report: Nurse-style Voice Interaction (ElevenLabs TTS)

## Summary
Added a "nurse voice" to the guided-dispense demo. The dashboard now speaks a
face-centering instruction when the Identify card opens, and after a successful
AWS Rekognition match it greets the patient by first name and names the due
medication(s). Speech is synthesized by ElevenLabs, proxied through the on-Pi
FastAPI (`POST /api/device/tts`) so the billable key stays server-side, and
played in the browser via a native `Audio` element. Feature degrades silently to
text-only when unconfigured.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | n/a | High — implemented as planned |
| Files Changed | 7 (2 create, 5 update) | 7 (2 create, 5 update) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | config.py ElevenLabs settings | ✅ Complete | 4 additive fields |
| 2 | services/elevenlabs_client.py | ✅ Complete | Lazy, soft-fail |
| 3 | /api/device/tts endpoint | ✅ Complete | Hardware-independent; 503 soft-fail |
| 4 | frontend speak() | ✅ Complete | Singleton Audio; autoplay-safe |
| 5 | spoken-script helpers | ✅ Complete | `CENTERING_PROMPT`, `firstName`, `greetingScript` |
| 6 | wire trigger points | ✅ Complete | Centering effect + greeting on Continue |
| 7 | .env.example docs | ✅ Complete | 4 keys documented |
| 8 | unit tests | ✅ Complete | 3 tests, all pass |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | ✅ Pass | `ruff check` clean on all backend files |
| Unit Tests | ✅ Pass | 3 tests (`test_elevenlabs_client.py`) — pytest installed into venv (was missing) |
| Build | ✅ Pass | `next build` compiled, types valid |
| Integration | ✅ Pass | TestClient: no-key→401, key+unset→503 JSON, empty text→422 |
| Edge Cases | ✅ Pass | Unset key, empty text, headless mode all verified |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `backend/services/elevenlabs_client.py` | CREATED | +59 |
| `backend/tests/test_elevenlabs_client.py` | CREATED | +52 |
| `backend/config.py` | UPDATED | +10 |
| `backend/api/device.py` | UPDATED | +30 |
| `backend/.env.example` | UPDATED | +11 |
| `frontend/src/lib/device.ts` | UPDATED | +50 |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATED | +~40 |

## Deviations from Plan
- **requirements.txt** — plan listed an *optional* one-line comment noting `requests` powers TTS. Skipped: no dependency change, comment adds no value. No code impact.
- **Lint command** — `next lint` is deprecated and unconfigured in this repo (prompts interactively). Used `next build` for type-checking instead, which runs the same TS validation.
- **pytest** — not present in `backend/.venv`; installed it to run the new unit test. (conftest.py existed but pytest itself was missing.)

## Issues Encountered
- None blocking. The CSS `@import` ordering warning in `next build` is pre-existing in `globals.css` (font import) and unrelated to this change.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `backend/tests/test_elevenlabs_client.py` | 3 | key-unset soft-fail, upstream-error soft-fail, success returns bytes |

## Manual Validation Still Recommended (needs real keys + hardware)
- [ ] Set `ELEVENLABS_API_KEY` in `backend/.env`; confirm centering line speaks on Identify card and greeting speaks after Continue.
- [ ] Confirm greeting names the patient's first name + loaded medication(s).
- [ ] Unset key → flow still works, silent, no console/toast errors.

## Next Steps
- [ ] Code review via `/code-review`
- [ ] Commit via `/prp-commit`, then PR via `/prp-pr`
