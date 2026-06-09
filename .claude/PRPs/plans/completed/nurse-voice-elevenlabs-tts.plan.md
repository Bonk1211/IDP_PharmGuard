# Plan: Nurse-style Voice Interaction (ElevenLabs TTS) for the Guided Dispense Demo

## Summary
Give the dispenser a "nurse" voice during the guided-round demo. When the operator opens
the Identify step, the dispenser speaks a face-centering instruction; after AWS Rekognition
confirms the patient's identity, it greets the patient by their profile name and announces
which medication(s) are due this round. Speech is synthesized with the **ElevenLabs** TTS API,
proxied through the on-Pi FastAPI (so the billable API key never ships to the browser), and
played in the dashboard browser via a native `Audio` element.

## User Story
As a **patient standing at the dispenser during a medication round**,
I want **the dispenser to guide me out loud — telling me to center my face, greeting me by name, and naming my medication**,
so that **the interaction feels personal and reassuring, lowering anxiety and improving my adherence**.

## Problem → Solution
**Current:** The guided flow (`frontend/src/app/dispensers/[id]/page.tsx`) is silent. All
prompts ("Confirm patient identity at the cabinet", face match results, "it's time for your
pill") are on-screen text only. A patient at the cabinet gets no audible guidance.
**Desired:** At two scripted moments the dispenser speaks with a warm, consistent voice:
(1) face-centering instruction when the Identify card appears, (2) a personalized greeting +
medication announcement immediately after a successful face match. Everything else is unchanged.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form feature request)
- **PRD Phase**: N/A
- **Estimated Files**: 6 (2 created, 4 updated)

---

## UX Design

### Before
```
┌────────────────────────────────────────────┐
│  Step 1 · Identify                          │
│  "Confirm patient identity at the cabinet." │
│  [Reference photo] [Cam 1 live]             │
│  [ Verify face (AWS) ]                       │   ← silent
│                                             │
│  (match) → [ Continue → ]                    │   ← silent
└────────────────────────────────────────────┘
```

### After
```
┌────────────────────────────────────────────┐
│  Step 1 · Identify                          │
│  🔊 "Hi, please make sure your face is       │
│      centered in the camera."  (on card open)│
│  [Reference photo] [Cam 1 live]             │
│  [ Verify face (AWS) ]                       │
│                                             │
│  (match) → [ Continue → ]                    │
│  🔊 "Hello Mary. It's time to take your      │   ← greeting + meds
│      Metformin. I'm here with you."          │      after match
└────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Identify card opens (active patient, not yet verified) | Silent | Speaks centering instruction once | Best-effort; browser autoplay may require the first utterance to follow a click — see GOTCHA |
| "Verify face" button press | Silent network call | (optional) speak centering line here too, guaranteeing a user-gesture-backed first utterance | Recommended robustness path |
| Face match → operator taps **Continue** | `setFaceVerified(true)` + toast | Same + speaks "Hello {first name}. It's time to take your {medication}. …" | Button click is a user gesture → autoplay always allowed here |
| Device not configured / TTS disabled | n/a | No audio, no error toast — silently degrades | Mirrors `isDeviceConfigured()` greying-out pattern |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `backend/services/deepseek_client.py` | 1-44 | Canonical lazy external-client + `RuntimeError`-when-unconfigured pattern to mirror for `elevenlabs_client.py` |
| P0 (critical) | `backend/services/label_detector.py` | 1-99 | Mirror for **soft-fail** external call returning `{...,"error": str|None}` instead of raising |
| P0 (critical) | `backend/api/device.py` | 1-50, 299-403 | Router setup (`Depends(verify_device_api_key)`), `BaseModel` body pattern, how `verify_face` returns JSON; new `/tts` endpoint goes here and returns binary `Response` |
| P0 (critical) | `frontend/src/lib/device.ts` | 1-82, 343-477 | `baseUrl`/`apiKey`, `authHeaders()`, `isDeviceConfigured()`, `safeError()`, `verifyFace()` shape — `speak()` mirrors these |
| P0 (critical) | `frontend/src/app/dispensers/[id]/page.tsx` | 150-292, 614-684, 673-676 | Where active patient + `currentSlot`/`activeSlots` are derived; the Identify card (`viewIdx===0`); `onContinue` (the greeting trigger) |
| P1 (important) | `backend/config.py` | 32-109, 137-156 | `Settings` shape, safe-default convention, `env_file=.env`; add `elevenlabs_*` keys here |
| P1 (important) | `backend/core/security.py` | 53-75 | `verify_device_api_key` accepts header OR `?key=` — TTS uses the header path |
| P1 (important) | `frontend/src/lib/api.ts` | 3-30 | `Patient` (has `name`) and `SlotInfo` (has `name`, `pills_per_dose`) types used to build the spoken script |
| P2 (reference) | `backend/main.py` | 138-149 | Router include list (device router already mounted at `/api/device` — no change needed) |
| P2 (reference) | `backend/.env.example` | 31-51, 74-92 | Style for documenting new env vars (AWS / DeepSeek blocks) |
| P2 (reference) | `.claude/PRPs/plans/patient-face-verify-rekognition.plan.md` | all | Same-domain prior plan; matches house plan conventions |

## External Documentation

> Sourced from assistant knowledge (cutoff 2026-01). The ElevenLabs HTTP contract below is
> stable, but **verify `model_id` availability against your account** before shipping.

| Topic | Source | Key Takeaway |
|---|---|---|
| ElevenLabs TTS endpoint | `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}` | Auth via header `xi-api-key: <key>`. JSON body `{"text","model_id","voice_settings"}`. Response body is raw `audio/mpeg` bytes. |
| Output format | query `?output_format=mp3_44100_128` | MP3 plays directly in a browser `Audio` element. 44.1kHz/128kbps is the safe default. |
| Latency model | `model_id` | `eleven_turbo_v2_5` / `eleven_flash_v2_5` are low-latency and **multilingual** (handle non-English patient names). `eleven_multilingual_v2` is higher quality but slower. Default to `eleven_turbo_v2_5`. |
| Default voice | voice library | A built-in voice id works without cloning (e.g. Rachel `21m00Tcm4TlvDq8ikWAM`). Make it a config default the operator can override. |
| Browser autoplay | MDN autoplay policy | `Audio.play()` returns a promise that **rejects** if called without a prior user gesture. Greeting after the **Continue** click is gesture-backed; the on-mount centering prompt is not — see GOTCHA. |

```
KEY_INSIGHT: ElevenLabs returns binary audio/mpeg, not JSON.
APPLIES_TO: backend /api/device/tts must return fastapi.Response(content=mp3, media_type="audio/mpeg"), NOT JSONResponse.
GOTCHA: Don't base64-wrap it like verify_face's snapshot — stream the raw bytes; the browser blobs it.

KEY_INSIGHT: The ElevenLabs key is a real billable secret (unlike NEXT_PUBLIC_DEVICE_API_KEY which is an acknowledged soft key).
APPLIES_TO: Key lives ONLY in backend/.env → settings.elevenlabs_api_key. Never expose as NEXT_PUBLIC_*.
GOTCHA: The browser authenticates to /api/device/tts with the existing X-Device-API-Key, and the Pi holds the ElevenLabs key.

KEY_INSIGHT: TTS needs no hardware loop or camera.
APPLIES_TO: The /api/device/tts handler must NOT call _get_loop()/require state.cam_* — it works in BACKEND_HEADLESS=1 mode too. Only the verify_device_api_key dependency gates it.
```

---

## Patterns to Mirror

### NAMING_CONVENTION
```python
# SOURCE: backend/services/deepseek_client.py:19-43
_client = None  # openai client (pointed at DeepSeek) cache

def get_client():
    """Lazy-init the OpenAI-compatible DeepSeek client. ONE per process."""
    global _client
    if _client is not None:
        return _client
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY not set — ...")
    ...
```
→ snake_case module, module-level `_client`/cache, lazy getter, `settings.<lower_snake>` config access.

### ERROR_HANDLING (soft-fail external call)
```python
# SOURCE: backend/services/label_detector.py:81-99
try:
    resp = _get_client().detect_labels(Image={"Bytes": jpeg_bytes}, ...)
except Exception as exc:  # ClientError, EndpointConnectionError, etc.
    log.warning("DetectLabels failed: %s", exc)
    return {"labels": [], "error": str(exc)}
...
return {"labels": out, "error": None}
```
→ catch broad `Exception`, `log.warning`, return a dict carrying `"error"`; caller decides.

### LOGGING_PATTERN
```python
# SOURCE: backend/api/device.py:383-390
log.info(
    "verify_face: patient=%d match=%s similarity=%s latency_ms=%d err=%s",
    body.patient_id, verdict["match"], verdict["similarity"], latency_ms, verdict["error"],
)
```
→ `log = logging.getLogger(__name__)`; one structured `log.info` per endpoint call with `latency_ms`.

### ENDPOINT / REQUEST-BODY PATTERN
```python
# SOURCE: backend/api/device.py:299-336
class VerifyFaceBody(BaseModel):
    patient_id: int = Field(ge=1, description="...")

@router.post("/verify_face")
async def verify_face(body: VerifyFaceBody, request: Request):
    ...
    result = await asyncio.to_thread(_fetch_patient)   # blocking I/O off the loop
```
→ Pydantic `BaseModel` + `Field`, `@router.post`, wrap blocking I/O in `asyncio.to_thread`.

### FRONTEND DEVICE-CLIENT PATTERN
```typescript
// SOURCE: frontend/src/lib/device.ts:73-82, 343-364
export function isDeviceConfigured(): boolean { return Boolean(baseUrl && apiKey); }
function authHeaders(): HeadersInit {
  return { "X-Device-API-Key": apiKey, "ngrok-skip-browser-warning": "true" };
}
export async function verifyFace(patientId: number): Promise<VerifyFaceResult> {
  if (!isDeviceConfigured()) return empty;
  try {
    const r = await fetch(`${baseUrl}/api/device/verify_face`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ patient_id: patientId }),
    });
    ...
  } catch { return empty; }
}
```
→ guard with `isDeviceConfigured()`, `try/catch` returning a safe value, `authHeaders()` spread, `${baseUrl}/api/device/...`.

### FRONTEND TRIGGER POINTS
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:673-676 (greeting trigger)
onContinue={() => {
  setFaceVerified(true);
  setMsg("Identity confirmed. Step advanced.");
}}
```
```tsx
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:287-291 (per-patient reset — mirror for "spoke once" ref)
useEffect(() => {
  setFaceVerified(false);
  setFaceResult(null);
  setFaceVerifying(false);
}, [activePatient?.id]);
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/services/elevenlabs_client.py` | CREATE | Lazy ElevenLabs TTS client; `synthesize(text, voice_id, model_id) -> {"audio": bytes|None, "error": str|None}` (soft-fail) |
| `backend/tests/test_elevenlabs_client.py` | CREATE | Unit tests for the client (key-unset, upstream-fail, success) |
| `backend/api/device.py` | UPDATE | Add `TtsBody` + `POST /tts` returning `audio/mpeg` (or 503 JSON). No hardware loop required |
| `backend/config.py` | UPDATE | Add `elevenlabs_api_key`, `elevenlabs_voice_id`, `elevenlabs_model_id`, `elevenlabs_output_format` |
| `backend/.env.example` | UPDATE | Document the new ELEVENLABS_* env vars + PHI/billing disclaimer |
| `frontend/src/lib/device.ts` | UPDATE | Add `speak(text)`: POST `/api/device/tts`, blob the MP3, play via a module-singleton `Audio` |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | Call `speak()` on Identify-card mount (centering) and in `onContinue` (greeting + meds); add a `useRef` so centering speaks once per patient |

> `backend/requirements.txt` needs **no dependency add** — reuses the already-pinned `requests`
> (a one-line clarifying comment is optional).

## NOT Building
- **No Pi-side speaker playback.** Audio plays in the dashboard browser (the demo machine at the cabinet). Server-side `aplay`/audio-HAT output is out of scope (alternative considered — rejected for demo simplicity).
- **No two-way conversation / STT / LLM dialogue.** One-way scripted TTS at two fixed moments only. No mic, no patient replies.
- **No new TTS at other steps** (Unlock/Dispense/Verify/Log). Only Identify + post-match greeting. Hooks can be added later by reusing `speak()`.
- **No voice cloning / custom voice upload.** Use a built-in ElevenLabs voice id from config.
- **No audio caching/persistence.** Each prompt is synthesized on demand. (Caching is a listed future optimization.)
- **No changes to the dispense cycle, vision, or hardware** (`cycle_runner.py`, `vision/*`, `hardware/*` untouched).
- **No new DB columns / migrations.** The spoken script is built from existing `patients.name` + `medications.name`.

---

## Step-by-Step Tasks

### Task 1: Add ElevenLabs settings to config
- **ACTION**: Add four fields to `Settings` in `backend/config.py`, in a new commented block after the AWS Rekognition block (after ~line 92).
- **IMPLEMENT**:
  ```python
  # ── ElevenLabs nurse-voice TTS (guided-demo greeting) ────────────────
  # Real billable secret — NEVER expose to the browser. Empty = feature off
  # (the /api/device/tts endpoint soft-fails / the frontend stays silent).
  elevenlabs_api_key: str = ""
  # Built-in voice id (no cloning needed). Default = "Rachel".
  elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"
  # Low-latency multilingual model so non-English patient names speak well.
  elevenlabs_model_id: str = "eleven_turbo_v2_5"
  elevenlabs_output_format: str = "mp3_44100_128"
  ```
- **MIRROR**: NAMING_CONVENTION — lower_snake fields with safe defaults (`backend/config.py:86-98` AWS block).
- **IMPORTS**: none new.
- **GOTCHA**: Never add this key with a `NEXT_PUBLIC_` prefix. `model_config` has `extra="ignore"`, so unknown env vars won't crash; names must map to `ELEVENLABS_*` env (pydantic-settings is case-insensitive).
- **VALIDATE**: `cd backend && python -c "from config import settings; print(settings.elevenlabs_voice_id, settings.elevenlabs_model_id)"` → prints defaults.

### Task 2: Create the ElevenLabs client service
- **ACTION**: Create `backend/services/elevenlabs_client.py`. Use the already-installed `requests` lib (mirrors `services/face_verify.py:349` lazy `import requests`).
- **IMPLEMENT**:
  ```python
  """ElevenLabs text-to-speech wrapper for the dispenser's nurse voice.

  Used by POST /api/device/tts to synthesize short spoken prompts during the
  guided demo (face-centering instruction + post-auth greeting). Returns raw
  MP3 bytes the dashboard browser plays.

  Mirrors services/label_detector.py soft-fail posture: a missing key or any
  network failure surfaces as {"audio": None, "error": str}, never a raise, so
  the demo degrades to text-only instead of crashing a round.
  """
  from __future__ import annotations
  import logging
  from config import settings

  log = logging.getLogger(__name__)
  _BASE = "https://api.elevenlabs.io/v1/text-to-speech"

  def synthesize(
      text: str,
      voice_id: str | None = None,
      model_id: str | None = None,
  ) -> dict:
      """Return {"audio": bytes|None, "error": str|None}. Soft-fail (no raise)."""
      if not settings.elevenlabs_api_key:
          return {"audio": None, "error": "ELEVENLABS_API_KEY not set"}
      vid = voice_id or settings.elevenlabs_voice_id
      mid = model_id or settings.elevenlabs_model_id
      import requests  # lazy — keep import-time side-effect-free
      try:
          r = requests.post(
              f"{_BASE}/{vid}",
              params={"output_format": settings.elevenlabs_output_format},
              headers={
                  "xi-api-key": settings.elevenlabs_api_key,
                  "Content-Type": "application/json",
                  "Accept": "audio/mpeg",
              },
              json={"text": text, "model_id": mid},
              timeout=15,
          )
          r.raise_for_status()
      except Exception as exc:
          log.warning("ElevenLabs synthesize failed: %s", exc)
          return {"audio": None, "error": str(exc)}
      return {"audio": r.content, "error": None}
  ```
- **MIRROR**: ERROR_HANDLING (`label_detector.py:81-99`) + NAMING_CONVENTION (`deepseek_client.py`).
- **IMPORTS**: `logging`, `from config import settings`, lazy `import requests`.
- **GOTCHA**: ElevenLabs returns binary on 2xx but **JSON** on error (e.g. 401). `raise_for_status()` routes non-2xx into `except`, so we never mistake an error blob for audio. Keep `timeout` — a hung call would stall the await.
- **VALIDATE**: `cd backend && python -c "from services.elevenlabs_client import synthesize; print(synthesize('hi')['error'])"` → `ELEVENLABS_API_KEY not set` (no traceback) when unset.

### Task 3: Add the `/api/device/tts` endpoint
- **ACTION**: In `backend/api/device.py`, add `TtsBody` + `POST /tts` after the face-verify section (~line 403), before `/snapshot`.
- **IMPLEMENT**:
  ```python
  class TtsBody(BaseModel):
      text: str = Field(min_length=1, max_length=600, description="Text to speak.")
      voice_id: str | None = Field(default=None, description="Override default voice.")

  @router.post("/tts")
  async def tts(body: TtsBody):
      """Synthesize `text` via ElevenLabs and return audio/mpeg bytes.

      Hardware-independent — works in headless mode (no _get_loop / camera).
      Soft-fail: 503 with a JSON detail when TTS is unconfigured or the
      upstream call fails, so the frontend can stay silent without breaking.
      """
      from services.elevenlabs_client import synthesize
      t0 = time.monotonic()
      out = await asyncio.to_thread(synthesize, body.text, body.voice_id)
      latency_ms = int((time.monotonic() - t0) * 1000)
      if out["audio"] is None:
          log.warning("tts: failed err=%s latency_ms=%d", out["error"], latency_ms)
          raise HTTPException(status_code=503, detail=f"TTS unavailable: {out['error']}")
      log.info("tts: chars=%d latency_ms=%d", len(body.text), latency_ms)
      return Response(content=out["audio"], media_type="audio/mpeg")
  ```
- **MIRROR**: ENDPOINT/REQUEST-BODY pattern (`device.py:299-336`); `Response(content=..., media_type=...)` already used at `device.py:427` (snapshot JPEG).
- **IMPORTS**: `Response`, `HTTPException`, `BaseModel`, `Field`, `asyncio`, `time` are **already imported** at the top of `device.py` (lines 13-20). `synthesize` imported lazily inside the handler (matches `from services.face_verify import ...` at `device.py:367`).
- **GOTCHA**: Router-level `Depends(verify_device_api_key)` (device.py:29) already gates this route — do NOT re-add the dependency. Do NOT call `_get_loop()`; TTS must work headless.
- **VALIDATE**: with `BACKEND_HEADLESS=1`, valid `DEVICE_API_KEY`, valid `ELEVENLABS_API_KEY`:
  `curl -s -X POST localhost:8000/api/device/tts -H "X-Device-API-Key: $KEY" -H "Content-Type: application/json" -d '{"text":"hello"}' -o /tmp/out.mp3 && file /tmp/out.mp3` → `... MPEG`. Key unset → HTTP 503 JSON.

### Task 4: Add `speak()` to the frontend device client
- **ACTION**: In `frontend/src/lib/device.ts`, add a module-level current-audio singleton and an exported `speak(text, voiceId?)`.
- **IMPLEMENT**:
  ```typescript
  // ─────────────────── nurse-voice TTS (ElevenLabs via Pi) ──────────────
  // One Audio at a time — a new prompt cancels the previous so the
  // centering line and the greeting never overlap.
  let currentAudio: HTMLAudioElement | null = null;

  /**
   * Synthesize `text` on the Pi (ElevenLabs) and play it in the browser.
   * No-ops silently when the device is unconfigured or TTS fails — the
   * guided flow must never break because audio is unavailable.
   * Returns true when playback started.
   */
  export async function speak(text: string, voiceId?: string): Promise<boolean> {
    if (!isDeviceConfigured() || !text.trim()) return false;
    try {
      const r = await fetch(`${baseUrl}/api/device/tts`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_id: voiceId ?? null }),
      });
      if (!r.ok) {
        console.warn("[device] /tts", r.status, await safeError(r));
        return false;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
      }
      const audio = new Audio(url);
      currentAudio = audio;
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();          // rejects if no prior user gesture (see caller)
      return true;
    } catch (err) {
      console.warn("[device] speak failed:", err);
      return false;
    }
  }
  ```
- **MIRROR**: FRONTEND DEVICE-CLIENT pattern — `isDeviceConfigured()` guard, `authHeaders()` spread, `safeError()` reuse, `try/catch` returning a safe value (`device.ts:343-382`).
- **IMPORTS**: none new — `baseUrl`, `apiKey`, `authHeaders`, `isDeviceConfigured`, `safeError` already live in this module.
- **GOTCHA**: `audio.play()` rejects (caught here) when there was no user gesture. Fine for the greeting (fires from the Continue click). The on-mount centering prompt may be swallowed — acceptable degrade. Revoke the object URL on `ended` to avoid leaking blobs across rounds.
- **VALIDATE**: `cd frontend && npm run lint` → no new errors.

### Task 5: Build the spoken-script helpers in the dispenser page
- **ACTION**: In `frontend/src/app/dispensers/[id]/page.tsx`, add helpers near the other module-scope helpers (after `nextRoundFrom`, ~line 120).
- **IMPLEMENT**:
  ```typescript
  const CENTERING_PROMPT =
    "Hi there. Please make sure your face is centered in the camera so I can recognize you.";

  function firstName(name: string | null | undefined): string {
    return (name ?? "").trim().split(/\s+/)[0] || "there";
  }

  // "Hello Mary. It's time to take your Metformin and Aspirin. I'm right here with you."
  function greetingScript(patient: Patient | null, slots: SlotInfo[]): string {
    const hi = `Hello ${firstName(patient?.name)}.`;
    const meds = slots.map((s) => s.name).filter(Boolean) as string[];
    if (meds.length === 0) {
      return `${hi} You're all verified. Please wait while I prepare your medication.`;
    }
    const list =
      meds.length === 1
        ? meds[0]
        : `${meds.slice(0, -1).join(", ")} and ${meds[meds.length - 1]}`;
    return `${hi} It's time to take your ${list}. Take your time — I'm right here with you.`;
  }
  ```
- **MIRROR**: module-scope pure-helper style (`getInitials`, `nextRoundFrom` at `page.tsx:51-120`).
- **IMPORTS**: add `speak` to the existing `@/lib/device` import block (lines 17-37). `Patient`/`SlotInfo` already imported from `@/lib/api` (lines 38-43).
- **GOTCHA**: Use `activeSlots` (current patient's loaded meds), not all `slots`. Keep scripts < 600 chars to match the backend `TtsBody` cap and keep latency/cost low.
- **VALIDATE**: referenced in Task 6; covered by `npm run build`.

### Task 6: Wire the two trigger points in the dispenser page
- **ACTION**: (a) Speak the centering prompt once when the Identify card is active for a patient; (b) speak the greeting inside `onContinue`.
- **IMPLEMENT**:
  - Add a ref near the other refs (`page.tsx:180-181`):
    ```typescript
    const centeringSpokenForRef = useRef<number | null>(null);
    ```
  - Add an effect after the face-verify reset effect (~line 291):
    ```typescript
    // Speak the face-centering instruction once per patient while the
    // Identify card shows and we haven't verified yet. Best-effort: browser
    // autoplay may block until the first click — speak() swallows the reject.
    useEffect(() => {
      if (viewIdx !== 0) return;
      if (!activePatient || faceVerified) return;
      if (centeringSpokenForRef.current === activePatient.id) return;
      centeringSpokenForRef.current = activePatient.id;
      void speak(CENTERING_PROMPT);
    }, [viewIdx, activePatient, faceVerified]);
    ```
  - Reset the ref when patient changes — fold into the existing per-patient reset effect (`page.tsx:287-291`):
    ```typescript
    useEffect(() => {
      setFaceVerified(false);
      setFaceResult(null);
      setFaceVerifying(false);
      centeringSpokenForRef.current = null;   // ← add
    }, [activePatient?.id]);
    ```
  - Update `onContinue` (`page.tsx:673-676`) to greet (the click is the gesture that unblocks audio):
    ```typescript
    onContinue={() => {
      setFaceVerified(true);
      setMsg("Identity confirmed. Step advanced.");
      void speak(greetingScript(activePatient, activeSlots));
    }}
    ```
- **MIRROR**: FRONTEND TRIGGER POINTS + the per-patient reset effect already in the file.
- **IMPORTS**: `useRef` already imported (`page.tsx:13`).
- **GOTCHA**: Do NOT also auto-speak on `r.match` inside `onVerify` — the flow deliberately waits for the operator's **Continue** (`page.tsx:654-656` comment). Greeting on Continue keeps that contract and guarantees a gesture. Guard the centering effect with `viewIdx !== 0` so later-step re-renders don't re-trigger it.
- **VALIDATE**: `cd frontend && npm run build` → compiles, no type errors; `npm run lint` → clean.

### Task 7: Document env vars
- **ACTION**: Append an ELEVENLABS block to `backend/.env.example` (after the DeepSeek block, ~line 92).
- **IMPLEMENT**:
  ```
  # ─── ElevenLabs nurse-voice TTS (guided-demo greeting) ───
  # Real billable secret — used ONLY by the backend (/api/device/tts proxy).
  # NEVER set this as a NEXT_PUBLIC_* var. Empty = no voice (flow stays text-only).
  # Pricing: per-character; keep prompts short. Each round speaks ~2 short lines.
  ELEVENLABS_API_KEY=
  # Built-in voice id (no cloning). Default = Rachel.
  ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
  # Low-latency multilingual model (handles non-English patient names).
  ELEVENLABS_MODEL_ID=eleven_turbo_v2_5
  ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
  ```
- **MIRROR**: `.env.example` block style (AWS / DeepSeek sections).
- **IMPORTS**: n/a.
- **GOTCHA**: No new pip package — reuse `requests` (already pinned). Don't add the unofficial `elevenlabs` SDK; the raw HTTP call keeps the dep surface flat and matches the boto3/requests style already in services.
- **VALIDATE**: `grep -c ELEVENLABS backend/.env.example` → 4.

### Task 8: Unit-test the client
- **ACTION**: Create `backend/tests/test_elevenlabs_client.py` following `tests/` conventions (see `tests/conftest.py`, `tests/test_magazine.py`).
- **IMPLEMENT**: pytest with `monkeypatch` on `requests.post` and on `settings.elevenlabs_api_key`:
  ```python
  from services import elevenlabs_client as ec

  def test_key_unset_soft_fails(monkeypatch):
      monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "", raising=False)
      out = ec.synthesize("hi")
      assert out["audio"] is None
      assert out["error"] == "ELEVENLABS_API_KEY not set"

  def test_upstream_error_soft_fails(monkeypatch):
      monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "k", raising=False)
      class Boom:
          def raise_for_status(self): raise RuntimeError("401")
          content = b""
      monkeypatch.setattr("requests.post", lambda *a, **k: Boom())
      out = ec.synthesize("hi")
      assert out["audio"] is None and isinstance(out["error"], str)

  def test_success_returns_bytes(monkeypatch):
      monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "k", raising=False)
      class OK:
          def raise_for_status(self): pass
          content = b"ID3audio"
      monkeypatch.setattr("requests.post", lambda *a, **k: OK())
      out = ec.synthesize("hi")
      assert out == {"audio": b"ID3audio", "error": None}
  ```
- **MIRROR**: existing `backend/tests/` layout + `conftest.py` fixtures.
- **IMPORTS**: `pytest` (monkeypatch fixture), the service module.
- **GOTCHA**: `requests` is imported lazily *inside* `synthesize`, so patch the global `requests.post` (the lazy import resolves to the same module object). `raising=False` on the settings patch tolerates pydantic's attribute model.
- **VALIDATE**: `cd backend && python -m pytest tests/test_elevenlabs_client.py -q` → all pass.

---

## Testing Strategy

> Repo note: `backend/tests/` exists (`conftest.py`, `test_magazine.py`) — pytest *is* present,
> contrary to the CLAUDE.md "no test suite" line. Add a backend unit test for the client.
> Frontend has no test runner configured → validate the UI manually.

### Unit Tests (backend — `backend/tests/test_elevenlabs_client.py`)
| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| key unset → soft-fail | `elevenlabs_api_key=""`, `synthesize("hi")` | `{"audio": None, "error": "ELEVENLABS_API_KEY not set"}`, no exception | Yes |
| upstream non-2xx → soft-fail | monkeypatch `requests.post` whose `raise_for_status` raises | `audio is None`, `error` is a string | Yes |
| success → bytes | monkeypatch `requests.post` with `content=b"ID3..."` | `{"audio": b"ID3...", "error": None}` | No |

### Edge Cases Checklist
- [x] Empty/whitespace text → `speak()` returns false (frontend); `TtsBody` rejects `min_length=1` (backend)
- [x] Device unconfigured → `speak()` no-ops, no toast, no console error spam
- [x] ElevenLabs key unset → 503 JSON, frontend swallows
- [x] Autoplay blocked (no gesture) → `audio.play()` rejection caught; flow continues
- [x] Patient with no loaded meds → greeting falls back to "preparing your medication"
- [x] Non-English / multi-word name → `firstName()` takes first token; multilingual model voices it
- [x] Rapid Continue / re-verify → `currentAudio` cancels the prior utterance
- [x] Headless mode (dev-mac) → `/api/device/tts` still works (no hardware dependency)

---

## Validation Commands

### Static Analysis
```bash
cd backend && ruff check services/elevenlabs_client.py api/device.py config.py
cd frontend && npm run lint
```
EXPECT: Zero new errors.

### Backend import / soft-fail smoke
```bash
cd backend && python -c "from services.elevenlabs_client import synthesize; print(synthesize('hi'))"
```
EXPECT: `{'audio': None, 'error': 'ELEVENLABS_API_KEY not set'}` (no traceback) when key unset.

### Backend endpoint (headless)
```bash
cd backend && BACKEND_HEADLESS=1 DEVICE_API_KEY=devdevdevdevdevdev \
  uvicorn main:app --port 8000 &   # then, with ELEVENLABS_API_KEY exported:
curl -s -o /tmp/out.mp3 -w "%{http_code}\n" -X POST localhost:8000/api/device/tts \
  -H "X-Device-API-Key: devdevdevdevdevdev" -H "Content-Type: application/json" \
  -d '{"text":"Hello Mary, it is time for your Metformin."}' && file /tmp/out.mp3
```
EXPECT: `200` + `/tmp/out.mp3: ... MPEG ADTS, layer III` when key valid; `503` when unset.

### Frontend build
```bash
cd frontend && npm run build
```
EXPECT: Compiles, no type errors.

### Backend unit test
```bash
cd backend && python -m pytest tests/test_elevenlabs_client.py -q
```
EXPECT: All pass.

### Manual Validation (demo dry-run)
- [ ] Set `ELEVENLABS_API_KEY` in `backend/.env`; restart backend.
- [ ] Open `/dispensers/<id>` with `NEXT_PUBLIC_DEVICE_URL` + `NEXT_PUBLIC_DEVICE_API_KEY` set and an active patient that has a `face_reference_url`.
- [ ] Identify card appears → centering line is spoken (click anywhere first if the browser blocked autoplay).
- [ ] Tap **Verify face** → match → tap **Continue** → greeting names the patient's first name and the loaded medication(s).
- [ ] Unset `ELEVENLABS_API_KEY`, restart → flow still works, just silent (no errors in console/toast).

---

## Acceptance Criteria
- [ ] Centering instruction is spoken when the Identify card opens for an active patient (best-effort re: autoplay).
- [ ] After a successful face match + Continue, a greeting names the patient (first name) and the due medication(s).
- [ ] ElevenLabs API key lives only in `backend/.env`; no `NEXT_PUBLIC_*` exposure (`grep -ri ELEVEN frontend/src` is empty).
- [ ] `/api/device/tts` returns `audio/mpeg` on success, 503 JSON on failure, and works in headless mode.
- [ ] Feature degrades silently to text-only when unconfigured or on upstream failure.
- [ ] `npm run build`, `npm run lint`, `ruff check`, and the new pytest all pass.

## Completion Checklist
- [ ] Code follows discovered patterns (lazy client, soft-fail dict, `isDeviceConfigured()` guard).
- [ ] Error handling matches `label_detector.py` soft-fail style (no raises from the client).
- [ ] Logging uses `log.info(... latency_ms=%d ...)` per call, like `verify_face`.
- [ ] New backend test follows `tests/` conventions.
- [ ] No hardcoded API key, voice id, or URL outside config / env.
- [ ] `.env.example` documents all four new vars.
- [ ] No new pip/npm dependency added.
- [ ] Self-contained — no further codebase searching needed to implement.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Browser blocks autoplay of the on-mount centering prompt | High | Low | Greeting (the key moment) is gesture-backed via Continue; document "click once"; optionally fire the centering line on the Verify-face click too |
| ElevenLabs latency adds a noticeable pause before greeting | Medium | Medium | Use `eleven_turbo_v2_5`; keep scripts short; `speak()` is async/non-blocking so the UI advances immediately |
| `model_id` not enabled on the operator's plan → 401/400 | Medium | Medium | Soft-fail to silent; `ELEVENLABS_MODEL_ID` is configurable; verify the model in account before demo |
| Per-character billing surprises during repeated demo runs | Low | Low | Short scripts (~2 lines/round); no looping; cost note in `.env.example` |
| Non-audio interstitial returned instead of MP3 | Low | Medium | `r.ok` + blob path; an interstitial is non-2xx or non-audio and `speak()` returns false |
| CORS on the audio fetch | Low | Low | `/api/device/*` already CORS-allowed for localhost + vercel (`main.py:107-121`); same path as existing fetches |

## Notes
- **Why proxy through the Pi instead of calling ElevenLabs from the browser?** The ElevenLabs
  key is a real billable secret. The existing `NEXT_PUBLIC_DEVICE_API_KEY` is explicitly an
  acknowledged *soft* key (device.ts:13-16). Proxying keeps the real secret server-side and
  reuses the established `verify_device_api_key` gate.
- **Why browser playback, not the Pi speaker?** The guided demo is driven entirely from the
  dashboard (`dispensers/[id]/page.tsx`); the operator/demo screen is at the cabinet. Browser
  `Audio` is zero-extra-hardware. Pi-side `aplay` output is a clean future extension — the
  `/api/device/tts` service already returns bytes the Pi could play locally.
- **PHI note:** the spoken text includes patient first name + medication name and is sent to
  ElevenLabs. This mirrors the existing DeepSeek/Rekognition PHI posture documented in
  `.env.example`; leaving `ELEVENLABS_API_KEY` empty fully disables it.
- **Future hooks (not in scope):** reuse `speak()` for "please drink some water" at the intake
  step, or "well done, see you at {next round}" at completion; cache identical utterances.
```
