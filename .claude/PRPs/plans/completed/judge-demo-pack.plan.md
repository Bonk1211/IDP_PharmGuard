# Plan: Judge Demo Pack — Telegram Caregiver Alerts + Browser Simulator Mode + Failure-Demo Runbook

## Summary
Three interlocking demo-day features: (1) a Telegram bot that pushes caregiver alerts to a phone the moment a dose fails or a clinical flag opens, (2) a pure client-side simulator mode (`?demo=1`) that runs the entire guided dispense flow with scripted fake device responses so the stage demo survives total hardware/backend loss, and (3) a written demo runbook that scripts the wrong-pill rejection showcase end-to-end, wiring the existing rejection visuals into the new Telegram alert.

## User Story
As a hackathon presenter (and as a caregiver persona in the demo narrative), I want missed/failed doses to buzz a phone live on stage, a guaranteed-working simulated flow if the Pi dies, and a rehearsed failure scenario, so that judges see the system catch mistakes — not just the happy path — without demo-day risk.

## Problem → Solution
- Today a failed cycle only lands as a Supabase row + dashboard flag; nobody's phone buzzes. → Telegram `sendMessage` fired from the cycle runner and flag detector, plus a device endpoint the guided flow can hit on wrong-pill mismatch.
- Today the guided flow is dead without the Pi + ngrok tunnel (`isDeviceConfigured()` → buttons grey out). → A `demoDevice.ts` mock layer intercepted inside `device.ts`, activated by URL query, with canvas-generated "camera" frames and a scripted intake FSM.
- Today the wrong-pill rejection (the most impressive moment) is undocumented tribal knowledge. → `DEMO_RUNBOOK.md` scripting all three acts.

## Metadata
- **Complexity**: Large (three workstreams, but each follows an existing in-repo pattern closely)
- **Source PRD**: N/A (standalone — from "what can I add to impress judges" discussion, picks 1+2+3)
- **PRD Phase**: N/A
- **Estimated Files**: 11 (4 create, 7 update)

---

## UX Design

### Before
```
Stage demo, hardware path only:
┌────────────────────────────────────────────────┐
│ Guided flow: Identify → Dispense → Verify → Log │
│  - Pi dead / ngrok rotated → buttons greyed,    │
│    demo over.                                   │
│  - Wrong pill → voice line + red text, but no   │
│    external signal; judges must trust the UI.   │
└────────────────────────────────────────────────┘
```

### After
```
┌────────────────────────────────────────────────┐
│ Same guided flow, three new layers:             │
│  1. Failed dose / open flag → presenter's phone │
│     buzzes with a Telegram message ON STAGE.    │
│  2. /dispensers/demo-1?demo=1 → full flow runs  │
│     against scripted mocks; amber "SIMULATION"  │
│     chip in the sticky header; synthetic camera │
│     frames watermark "SIMULATED".               │
│     ?demo=fail → scripted wrong-pill rejection. │
│  3. DEMO_RUNBOOK.md: 3-act script with exact    │
│     clicks, expected visuals, recovery moves.   │
└────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Failed dispense cycle | Supabase row only | + Telegram message to caregiver chat | Skipped in stub mode (HI-012 noise guard) |
| New warning/critical flag | Dashboard FlagsPanel only | + one batched Telegram message per detector run | Batching avoids notification spam |
| Wrong pill on tray (guided flow) | Voice line + mismatch text + VerdictStamp | + `POST /api/device/notify` → Telegram | Fires once per eject (same ref-guard as voice) |
| Operator marks dose missed | DB log only | + Telegram message | In `logIntake(false)` |
| Guided flow w/o hardware | Buttons greyed out | `?demo=1` runs full scripted flow | No DB writes in demo mode |
| Sticky header | StepBar only | + amber `SIMULATION` chip when demo active | Honesty marker for judges |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/services/elevenlabs_client.py` | all (56) | THE pattern for external API clients: soft-fail dict return, lazy `requests` import, settings-driven |
| P0 | `backend/scheduler/cycle_runner.py` | 342–491 | `run_cycle` verdict branches — where the failed-cycle notify hook lands |
| P0 | `frontend/src/lib/device.ts` | 1–130, 640–766 | Module shape, `isDeviceConfigured`/`authHeaders`, fetch error posture, `speak()` |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 222–280, 580–820 | `DispenserGuidedPage` component, mismatch effect (639–653), `logIntake` (765–805) |
| P1 | `backend/config.py` | 109–171 | Settings block style (ElevenLabs block 109–121 is the model), `validate_runtime` |
| P1 | `backend/api/device.py` | 519–542 | `/tts` endpoint — the pattern for a hardware-independent, soft-fail device endpoint |
| P1 | `backend/services/flag_detector.py` | 86–141 | `detect_and_persist_flags` persist loop — flag notify hook lands here |
| P1 | `backend/tests/test_elevenlabs_client.py` | all (49) | Exact test pattern to mirror for the Telegram client |
| P2 | `frontend/src/lib/device.ts` | 130–640 | Every export the demo layer must intercept (signatures + return types) |
| P2 | `backend/.env.example` | 93–104 | Env-block comment style to copy for the Telegram block |
| P2 | `frontend/src/app/dispensers/[id]/page.tsx` | 143–195 | Voice script helpers (`wrongPillScript`) — tone reference for Telegram message copy |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Telegram Bot API sendMessage | https://core.telegram.org/bots/api#sendmessage | `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with JSON `{chat_id, text, parse_mode: "HTML"}`. Get a token from @BotFather; get `chat_id` by messaging the bot then reading `GET /bot<TOKEN>/getUpdates`. No SDK needed — plain `requests`. |
| Canvas → base64 JPEG | MDN `HTMLCanvasElement.toDataURL` | `canvas.toDataURL("image/jpeg", 0.8)` returns `data:image/jpeg;base64,XXX` — strip the prefix to match the `snapshot_b64` contract the page already renders (`page.tsx:1437`). |

No other research needed — everything else uses established internal patterns.

---

## Patterns to Mirror

### EXTERNAL_CLIENT_SOFT_FAIL (Telegram client must be indistinguishable from this)
```python
# SOURCE: backend/services/elevenlabs_client.py:23-56
def synthesize(text: str, voice_id: str | None = None, model_id: str | None = None) -> dict:
    if not settings.elevenlabs_api_key:
        return {"audio": None, "error": "ELEVENLABS_API_KEY not set"}
    ...
    import requests  # lazy — keep import-time side-effect-free
    try:
        r = requests.post(..., timeout=15)
        r.raise_for_status()
    except Exception as exc:  # ConnectionError, HTTPError (401/4xx/5xx), etc.
        log.warning("ElevenLabs synthesize failed: %s", exc)
        return {"audio": None, "error": str(exc)}
    return {"audio": r.content, "error": None}
```

### SETTINGS_BLOCK
```python
# SOURCE: backend/config.py:109-121
    # ── ElevenLabs nurse-voice TTS (guided-demo greeting) ────────────────
    # Real billable secret — NEVER expose to the browser. Empty = feature off
    # (the /api/device/tts endpoint soft-fails / the frontend stays silent).
    elevenlabs_api_key: str = ""
```

### DEVICE_ENDPOINT_SOFT_FAIL (hardware-independent, works headless)
```python
# SOURCE: backend/api/device.py:519-542
class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=600, description="Text to speak.")

@router.post("/tts")
async def tts(body: TtsBody):
    from services.elevenlabs_client import synthesize
    t0 = time.monotonic()
    out = await asyncio.to_thread(synthesize, body.text, body.voice_id)
    latency_ms = int((time.monotonic() - t0) * 1000)
    if out["audio"] is None:
        log.warning("tts: failed err=%s latency_ms=%d", out["error"], latency_ms)
        raise HTTPException(status_code=503, detail=f"TTS unavailable: {out['error']}")
```
Note: the router at `device.py:29` already applies `Depends(verify_device_api_key)` to every route — a new endpoint inherits auth for free.

### CYCLE_BLOCKING_IO (anything inside run_cycle)
```python
# SOURCE: backend/scheduler/cycle_runner.py:434-436
                pill_taken_actual = await asyncio.to_thread(
                    state.monitor.watch_for_swallow, 60
                )
```

### FRONTEND_DEVICE_FETCH (error posture for new device.ts function)
```typescript
// SOURCE: frontend/src/lib/device.ts:86-105 (abridged)
export async function fetchDeviceStatus(): Promise<DeviceStatus | null> {
  if (!isDeviceConfigured()) { console.warn("[device] not configured — ..."); return null; }
  try {
    const r = await fetch(`${baseUrl}/api/device/status`, { headers: authHeaders(), cache: "no-store" });
    if (!r.ok) { ...console.error...; return null; }
```

### ONCE_PER_EJECT_GUARD (reuse for the mismatch Telegram ping)
```typescript
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:641-653
  useEffect(() => {
    if (viewIdx !== 1) return;
    if (!verifyResult || !verifyResult.top) return;
    const isMismatch = verifyResult.match === false;
    ...
    if (wrongPillSpokenRef.current) return;
    wrongPillSpokenRef.current = true;
    ...
    void speak(wrongPillScript(currentSlot?.name, detected));
  }, [viewIdx, verifyResult, unauthorized, currentSlot?.name]);
```

### TEST_STRUCTURE (Telegram tests copy this file nearly verbatim)
```python
# SOURCE: backend/tests/test_elevenlabs_client.py:16-35
def test_key_unset_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "", raising=False)
    out = ec.synthesize("hi")
    assert out["audio"] is None
    assert out["error"] == "ELEVENLABS_API_KEY not set"

def test_upstream_error_soft_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ec.settings, "elevenlabs_api_key", "k", raising=False)
    class _Boom:
        content = b""
        def raise_for_status(self) -> None:
            raise RuntimeError("401 Unauthorized")
    monkeypatch.setattr("requests.post", lambda *a, **k: _Boom())
```
GOTCHA from that file's docstring: `requests` is imported lazily inside the function, so patching the global `requests.post` covers it.

### ENV_EXAMPLE_BLOCK
```bash
# SOURCE: backend/.env.example:93-97
# ─── ElevenLabs nurse-voice TTS (guided-demo greeting) ───
# Real billable secret — used ONLY by the backend (/api/device/tts proxy).
# NEVER set this as a NEXT_PUBLIC_* var. Empty = no voice (flow stays text-only).
ELEVENLABS_API_KEY=
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/services/telegram_notifier.py` | CREATE | Telegram sendMessage client, elevenlabs_client pattern |
| `backend/config.py` | UPDATE | `telegram_bot_token`, `telegram_chat_id` + 2 toggles |
| `backend/scheduler/cycle_runner.py` | UPDATE | Notify on failed (non-stub) cycle with reason |
| `backend/services/flag_detector.py` | UPDATE | One batched notify per run for new warning/critical flags |
| `backend/api/device.py` | UPDATE | `POST /api/device/notify` so the guided flow can ping caregiver |
| `backend/tests/test_telegram_notifier.py` | CREATE | Mirror of test_elevenlabs_client.py |
| `backend/.env.example` | UPDATE | Telegram env block |
| `frontend/src/lib/demoDevice.ts` | CREATE | Scripted mock device: status, eject, verify, intake FSM, canvas frames |
| `frontend/src/lib/device.ts` | UPDATE | Demo-mode interception + `notifyCaregiver()` export |
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | `?demo=` activation, SIMULATION chip, DB-write guard, mismatch/missed notify |
| `DEMO_RUNBOOK.md` | CREATE | 3-act judge demo script |

## NOT Building

- No Telegram inbound commands / webhook (send-only bot; no polling loop).
- No notify hook in `api/alerts.py` `_insert_alert` (low-stock/expiry spam risk; flags pipeline already covers the interesting cases).
- No backend-side simulator (PHARMGUARD_STUB stays exactly as-is; HI-012 "stub never reports pill_taken=true" untouched). Demo mode is browser-only.
- No demo-mode writes to Supabase (no fake adherence rows, no "demo" dispenser rows).
- No WhatsApp/SMS (Telegram only — free, no account review).
- No per-caregiver routing (single `TELEGRAM_CHAT_ID`; a group chat works fine for demo).
- No interception of admin/advanced device.ts functions beyond safe no-ops (calibration editing in demo mode is out of scope).

---

## Step-by-Step Tasks

### Task 1: Telegram settings in config.py
- **ACTION**: Add a settings block after the ElevenLabs block (after line 120, before `model_config`).
- **IMPLEMENT**:
  ```python
    # ── Telegram caregiver alerts ────────────────────────────────────────
    # Send-only bot. Both empty = feature off everywhere (notifier soft-fails,
    # /api/device/notify returns 503, cycle/flag hooks no-op). Get a token from
    # @BotFather; find chat_id via GET /bot<token>/getUpdates after messaging
    # the bot once.
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    # Fire on every failed (non-stub) dispense cycle.
    telegram_notify_on_failed_cycle: bool = True
    # Fire one batched message per flag-detector run with new warning/critical flags.
    telegram_notify_on_flags: bool = True
  ```
- **MIRROR**: SETTINGS_BLOCK.
- **GOTCHA**: Do NOT add anything to `validate_runtime()` — empty token must stay a legal config (feature off), same as ElevenLabs.
- **VALIDATE**: `cd backend && .venv/bin/python -c "from config import settings; print(settings.telegram_bot_token == '')"` → `True`.

### Task 2: `backend/services/telegram_notifier.py`
- **ACTION**: Create the client.
- **IMPLEMENT**: Module docstring explaining send-only caregiver alerts + soft-fail posture, then:
  ```python
  from __future__ import annotations
  import logging
  from config import settings
  log = logging.getLogger(__name__)
  _BASE = "https://api.telegram.org"

  def send_alert(text: str) -> dict:
      """Send ``text`` to the configured caregiver chat.

      Returns ``{"ok": bool, "error": str | None}``. Soft-fail: missing config,
      network errors, and non-2xx all return ok=False with the error message —
      never raises, so callers (the dispense cycle!) can't be broken by Telegram.
      """
      if not settings.telegram_bot_token or not settings.telegram_chat_id:
          return {"ok": False, "error": "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set"}
      import requests  # lazy — keep import-time side-effect-free
      try:
          r = requests.post(
              f"{_BASE}/bot{settings.telegram_bot_token}/sendMessage",
              json={
                  "chat_id": settings.telegram_chat_id,
                  "text": text,
                  "parse_mode": "HTML",
              },
              timeout=10,
          )
          r.raise_for_status()
      except Exception as exc:
          log.warning("Telegram send_alert failed: %s", exc)
          return {"ok": False, "error": str(exc)}
      return {"ok": True, "error": None}
  ```
- **MIRROR**: EXTERNAL_CLIENT_SOFT_FAIL — keep the lazy import comment verbatim style.
- **GOTCHA**: `parse_mode: "HTML"` means `<`, `>`, `&` in message text must be escaped or avoided — keep generated messages to plain words, `<b>...</b>` tags only.
- **VALIDATE**: Task 3 tests.

### Task 3: `backend/tests/test_telegram_notifier.py`
- **ACTION**: Create tests mirroring `test_elevenlabs_client.py` (same docstring style, same three cases).
- **IMPLEMENT**: `test_config_unset_soft_fails` (both token/chat patched to `""` → `ok False`, error mentions `TELEGRAM_BOT_TOKEN`), `test_upstream_error_soft_fails` (`_Boom.raise_for_status` raises, assert `"401" in out["error"]`), `test_success` (assert `out == {"ok": True, "error": None}`).
- **MIRROR**: TEST_STRUCTURE. Import as `from services import telegram_notifier as tn`; patch `tn.settings` attrs `telegram_bot_token`/`telegram_chat_id` with `raising=False`; patch `"requests.post"` globally (lazy import resolves to same module).
- **VALIDATE**: `cd backend && .venv/bin/pytest tests/test_telegram_notifier.py -q` → 3 passed.

### Task 4: failed-cycle notify hook in `cycle_runner.py`
- **ACTION**: In `run_cycle`, track a human-readable failure reason in the existing verdict branches, then notify after the adherence log write.
- **IMPLEMENT**: Initialize `fail_reason: str | None = None` before the `if state.hardware_stubbed:` block (line 404). Set it in the existing branches (do not restructure them):
  - pill-ID reject branch (line 443–450): `fail_reason = f"wrong/unidentified pill rejected by vision (confidence {pill_conf})"`
  - intake-gate failure (line 437–442, where `terminal` is read): `fail_reason = "intake not confirmed (timed out)" if terminal == "timeout" else "intake not confirmed (no cup/pill seen)"`
  - Leave the stub branch alone (`fail_reason` stays None there — see GOTCHA).
  Then, immediately after the `log.info("Cycle complete — pill_taken=%s", ...)` line (462):
  ```python
    # Caregiver push — only for real (non-stub) failures so stub-mode dev
    # loops don't spam the chat. Soft-fail inside send_alert; a Telegram
    # outage must never affect the cycle.
    if (
        not pill_taken_actual
        and not state.hardware_stubbed
        and settings.telegram_notify_on_failed_cycle
    ):
        from services.telegram_notifier import send_alert
        med = task.get("medication") or f"slot {slot}"
        await asyncio.to_thread(
            send_alert,
            f"⚠️ <b>PharmGuard</b>: dose NOT confirmed for patient #{patient_id} — "
            f"{med} (slot {slot}). Reason: {fail_reason or 'verification failed'}.",
        )
  ```
- **MIRROR**: CYCLE_BLOCKING_IO (`asyncio.to_thread` for the blocking `requests` call).
- **IMPORTS**: local `from services.telegram_notifier import send_alert` at the call site (matches the lazy-import style used in `api/device.py:533`).
- **GOTCHA**: Stub-mode cycles ALWAYS report `pill_taken=False` (HI-012) — without the `hardware_stubbed` guard every dev cycle would ping the phone every 30 s.
- **VALIDATE**: `cd backend && .venv/bin/pytest tests/ -q` (no regressions); manual end-to-end in Validation Commands.

### Task 5: flag notify hook in `flag_detector.py`
- **ACTION**: In `detect_and_persist_flags`, collect inserted candidates with severity warning/critical and send ONE batched message after the persist loop (after line 128, before the summary `log.info`).
- **IMPLEMENT**: Inside the existing persist loop, when `inserted` is True append `cand` to a `notify_list` if `cand.get("severity") in ("warning", "critical")`. Then after the loop:
  ```python
    if notify_list and settings.telegram_notify_on_flags:
        from services.telegram_notifier import send_alert
        lines = "\n".join(f"• [{c['severity']}] {c['title']}" for c in notify_list[:5])
        await asyncio.to_thread(
            send_alert,
            f"🚩 <b>PharmGuard</b>: {len(notify_list)} new clinical flag(s)\n{lines}",
        )
  ```
- **MIRROR**: the file's own `asyncio.to_thread` usage (e.g. line 125).
- **GOTCHA**: Batch — the detector can insert several flags per run; one message per run, cap listed titles at 5. Titles are plain text already (≤80 chars, built by the detectors).
- **VALIDATE**: `cd backend && .venv/bin/pytest tests/ -q`; full check via headless run in Validation Commands.

### Task 6: `POST /api/device/notify` in `api/device.py`
- **ACTION**: Add a hardware-independent endpoint next to `/tts` (after line 542).
- **IMPLEMENT**:
  ```python
  class NotifyBody(BaseModel):
      text: str = Field(min_length=1, max_length=500, description="Message to push to the caregiver chat.")

  @router.post("/notify")
  async def notify_caregiver(body: NotifyBody):
      """Push ``text`` to the configured Telegram caregiver chat.

      Hardware-independent — works in headless mode, same as /tts. Soft-fail:
      503 with detail when Telegram is unconfigured or upstream fails, so the
      guided flow can fire-and-forget without breaking a round.
      """
      from services.telegram_notifier import send_alert
      t0 = time.monotonic()
      out = await asyncio.to_thread(send_alert, body.text)
      latency_ms = int((time.monotonic() - t0) * 1000)
      if not out["ok"]:
          log.warning("notify: failed err=%s latency_ms=%d", out["error"], latency_ms)
          raise HTTPException(status_code=503, detail=f"Notify unavailable: {out['error']}")
      log.info("notify: sent chars=%d latency_ms=%d", len(body.text), latency_ms)
      return {"ok": True}
  ```
- **MIRROR**: DEVICE_ENDPOINT_SOFT_FAIL — auth comes free from the router dependency (line 29).
- **VALIDATE**: with backend running headless: `curl -s -X POST localhost:8000/api/device/notify -H 'X-Device-API-Key: <key>' -H 'Content-Type: application/json' -d '{"text":"hi"}'` → 503 when unconfigured, 200 + phone buzz when configured.

### Task 7: `.env.example` Telegram block
- **ACTION**: Append after the ElevenLabs block.
- **IMPLEMENT**:
  ```bash
  # ─── Telegram caregiver alerts (demo wow-feature) ───
  # Send-only bot: failed dispense cycles + new clinical flags push to a phone.
  # Create a bot with @BotFather → token. Message the bot once, then find your
  # chat id: https://api.telegram.org/bot<TOKEN>/getUpdates → result[0].message.chat.id
  # Both empty = feature fully off (soft-fail everywhere).
  TELEGRAM_BOT_TOKEN=
  TELEGRAM_CHAT_ID=
  # 0 to silence failed-cycle pushes / flag pushes independently.
  TELEGRAM_NOTIFY_ON_FAILED_CYCLE=1
  TELEGRAM_NOTIFY_ON_FLAGS=1
  ```
- **MIRROR**: ENV_EXAMPLE_BLOCK.
- **VALIDATE**: visual.

### Task 8: `frontend/src/lib/demoDevice.ts` — scripted mock device
- **ACTION**: Create the simulator. One module, no React. Exports mirror the device.ts signatures it replaces (import the types from `./device`).
- **IMPLEMENT**:
  - State: `let scenario: "happy" | "fail" = "happy"; let active = false; let cycleN = 0; let ejectedSlot: number | null = null; let intakeStartedAt: number | null = null; let drawerUnlocked = false;`
  - `export function activateDemo(s: "happy" | "fail") { active = true; scenario = s; }`, `export function isDemoActive() { return active; }`.
  - `function sleep(ms: number)` helper; every mock awaits a realistic latency (eject 1200 ms, verifyPill 700 ms, verifyFace 900 ms) so the UI's busy states read naturally on stage.
  - `function synthFrame(lines: string[], opts?: { box?: boolean; tone?: "ok" | "fail" }): string` — create a 640×480 canvas: dark slate fill, faint grid, big first line, smaller subsequent lines, optional green/red rectangle (fake bbox), and a corner watermark `SIMULATED`. Return `canvas.toDataURL("image/jpeg", 0.8).split(",")[1]` (page renders `data:image/jpeg;base64,${snapshot_b64}` at `page.tsx:1437`, so strip the prefix). Guard `typeof document === "undefined"` → return `""` (SSR safety).
  - Mock implementations (names prefixed `demo` to avoid clashes):
    - `demoFetchDeviceStatus(): DeviceStatus` — `{ headless: false, hardware_stubbed: false, cycle_n: cycleN, last_cycle: ..., task_running: true, is_unlocked: drawerUnlocked }`.
    - `demoManualEject(slot)` — sleep, `ejectedSlot = slot; cycleN++`, return `{ ok: true, slot, latency_ms: 1187, status: 200 }` (match `EjectResult` shape, device.ts:189).
    - `demoRotate(slot)` — `{ ok: true, slot, current_slot: slot, latency_ms: 410, status: 200 }`.
    - `demoVerifyPill(expected?)` — happy: top = `{ class_name: expected ?? "Lomide_capsule", confidence: 0.93, bbox: [180, 140, 460, 360] }`, `match: expected ? true : null`, snapshot via `synthFrame(["TRAY CAM", expected ?? "pill"], { box: true, tone: "ok" })`. fail: `class_name: "Panadol_tablet"`, `confidence: 0.91`, `match: false`, red box frame. Return full `VerifyPillResult` shape (device.ts:273) incl. `detections: [top]`, `latency_ms`.
    - `demoVerifyFace(patientId)` — `{ ok: true, patient_id, patient_name: null, match: true, similarity: 94.2, threshold: 80, bbox: {...}, snapshot_b64: synthFrame(["FACE CAM", "match 94.2%"], { box: true, tone: "ok" }), error: null, latency_ms: 880 }`. (Face verify succeeds in BOTH scenarios — the fail act is about the pill.)
    - `demoStartIntake()` — `intakeStartedAt = Date.now()`, return `{ ok: true, already_running: false, timeout_s: 60 }`.
    - `demoFetchIntakeState(): IntakeState` — time-scripted FSM: steps `READY → INSERT → SWALLOW → DONE` (matches `INTAKE_STEP_SLUG` keys, page.tsx:187), 4 s per step from `intakeStartedAt`; `step_index` 0–3, `total_steps: 4`, `hold_progress` = fraction within current step, `confidence` = `0.55 + 0.4 * hold_progress`, `face_visible: true`, `hands_count: 1`, `history` accumulates passed steps. After 16 s: happy → `result: "passed"`, `mediapipe_complete: true`, `labels_seen: ["cup"]`, `labels_satisfied: true`; fail → `result: "missing_labels"`, `mediapipe_complete: true`, `labels_satisfied: false`. Before `intakeStartedAt`: idle snapshot copying the headless shape in `api/device.py:659-683`.
    - `demoSetDrawer(action)`, `demoFetchSnapshot(cam)` (return a frame matching `fetchSnapshot`'s current return contract — read device.ts:442-455 first), `demoTriggerDispense`, `demoFetchPiLogs` (return 5 canned `LogRecord`s, e.g. "demo: cycle simulated"), `demoSpeak(text)` — use `window.speechSynthesis` + `SpeechSynthesisUtterance` (try/catch, return true) so the nurse voice still exists with zero backend.
- **MIRROR**: type shapes from `frontend/src/lib/device.ts` exactly — import the exported types, don't redeclare.
- **GOTCHA**: All timing derives from `Date.now()` deltas, NOT setInterval state, so the page's existing `fetchIntakeState` polling drives animation for free.
- **VALIDATE**: `cd frontend && npm run lint` clean; manual via Task 10.

### Task 9: demo interception + `notifyCaregiver` in `device.ts`
- **ACTION**: Two edits.
  1. At module top (after `apiKey` const): re-export the demo switch and add interception:
     ```typescript
     import * as demo from "./demoDevice";
     export { activateDemo, isDemoActive } from "./demoDevice";
     ```
     Then add a first-line branch in each function the guided flow uses:
     `isDeviceConfigured` (return `true` when `demo.isDemoActive()`), `fetchDeviceStatus`, `fetchIntakeState`, `triggerDispense`, `resetDevice`, `streamUrl` (return `null` — page already renders a fallback when src is null), `rotateMagazine`, `manualEject`, `startIntakeWatch`, `verifyFace`, `verifyPill`, `setDrawer`, `fetchSnapshot`, `fetchPiLogs`, `fetchSchedules` (return `[]`), `fetchCalibration` (return `null`), `speak` (delegate to `demo.demoSpeak`). Leave `speakStatic` alone — Supabase-cached MP3s work without the device, and its live fallback calls the (already intercepted) `speak`.
  2. New export next to `speak` (line ~653):
     ```typescript
     /** Fire-and-forget caregiver push (Telegram via the Pi). Soft: returns
      *  false on any failure — a notification must never break the flow. */
     export async function notifyCaregiver(text: string): Promise<boolean> {
       if (demo.isDemoActive()) return true;
       if (!isDeviceConfigured() || !text.trim()) return false;
       try {
         const r = await fetch(`${baseUrl}/api/device/notify`, {
           method: "POST",
           headers: { ...authHeaders(), "Content-Type": "application/json" },
           body: JSON.stringify({ text }),
         });
         return r.ok;
       } catch (err) {
         console.warn("[device] notifyCaregiver failed:", err);
         return false;
       }
     }
     ```
- **MIRROR**: FRONTEND_DEVICE_FETCH posture; one-line demo branches (`if (demo.isDemoActive()) return demo.demoVerifyPill(expected);`).
- **GOTCHA**: `streamUrl` must return `null` in demo mode (page.tsx:659 turns null into a no-stream fallback) — do NOT fabricate an MJPEG URL.
- **VALIDATE**: `npm run lint`; `npm run build` compiles.

### Task 10: page.tsx — activation, SIMULATION chip, DB-write guard, notify wiring
- **ACTION**: Four small edits inside `DispenserGuidedPage` (line 222):
  1. **Activation** — first lines of the component body (before any hooks):
     ```typescript
     if (typeof window !== "undefined") {
       const d = new URLSearchParams(window.location.search).get("demo");
       if (d !== null && !isDemoActive()) activateDemo(d === "fail" ? "fail" : "happy");
     }
     ```
     Synchronous so it lands before the polling effects' first tick. Import `activateDemo, isDemoActive` from `@/lib/device`.
  2. **SIMULATION chip** — in the sticky header div (line 815, next to `StepBar`): when `isDemoActive()`, render an amber pill: `<span className="rounded-full border border-status-warning bg-status-warning-bg px-3 py-1 text-xs font-bold uppercase tracking-widest text-status-warning">Simulation</span>` (reuse the `warn` tone classes seen in `VerdictStamp.tsx:16-19`).
  3. **DB-write guard** — top of `logIntake` (line 765): if `isDemoActive()`, skip `createIntakeLog`/`mutate` and just run the local state updates (`setConfirmedSlots`, message "Slot N confirmed (simulation — not logged)."). No fake rows in Supabase.
  4. **Notify wiring** — in the wrong-pill effect (line 641–653), after the `speak(...)` line add:
     ```typescript
     void notifyCaregiver(
       `⚠️ PharmGuard: wrong pill on tray — detected ${detected ?? "unknown"}, expected ${currentSlot?.name ?? "?"}. Pill rejected, operator alerted.`,
     );
     ```
     (the existing `wrongPillSpokenRef` guard already makes this once-per-eject). And in `logIntake`, in the `pillTaken === false` path, add `void notifyCaregiver(\`PharmGuard: dose marked missed for slot ${currentSlot.slot}${overrideNote ? ` — ${overrideNote}` : ""}\`);`.
- **MIRROR**: ONCE_PER_EJECT_GUARD; existing `void speak(...)` fire-and-forget style.
- **GOTCHA**: The component is huge — make surgical edits only; do not reformat. `isDemoActive()` is a plain function read, safe in render.
- **VALIDATE**: `npm run lint`; manual: `npm run dev` → `http://localhost:3000/dispensers/dispenser-001?demo=1` runs the full 4-step flow with synthetic frames; `?demo=fail` shows the red mismatch VerdictStamp + voice line.

### Task 11: `DEMO_RUNBOOK.md`
- **ACTION**: Create at repo root. Three acts + pre-flight + recovery.
- **IMPLEMENT**:
  - **Pre-flight (T-30 min)**: Pi powered, `systemctl status pharmguard`, ngrok URL fresh + pasted into `frontend/.env.local`, dashboard deployed/running, Telegram bot configured (test: `curl .../api/device/notify`), one CORRECT pill loaded in slot A, one WRONG pill staged for Act 2, phone on stage with Telegram chat open, browser tab pre-clicked (autoplay gesture for voice).
  - **Act 1 — happy path (3 min)**: guided flow Identify (face verify, green stamp) → Dispense (eject, YOLO verify, green stamp) → Verify (intake FSM 4 steps on cam 1 with HUD) → Log. Point judges at the live MediaPipe overlay.
  - **Act 2 — failure catch (2 min, the money shot)**: load the WRONG pill into the slot → eject → YOLO detects mismatch → red REJECTED VerdictStamp + calm nurse voice ("that looks like X, not your Y") → presenter's phone buzzes on stage with the Telegram alert → mark missed → adherence log shows the miss; FlagsPanel picks it up. Talking point: "the system catches the error a human might miss, and the caregiver knows in seconds."
  - **Act 3 — simulator insurance (use only if hardware dies)**: open `/dispensers/<id>?demo=1` — same flow, scripted; be transparent with judges (the amber SIMULATION chip is deliberate); `?demo=fail` reproduces Act 2 without hardware.
  - **Recovery table**: ngrok URL rotated → update env + restart; no voice → click once anywhere (autoplay), check ELEVENLABS key; Telegram silent → check `journalctl -u pharmguard | grep -i telegram`; stream black → `/api/device/reset`.
- **VALIDATE**: read-through; every command/path in it must exist.

### Task 12: end-to-end verification pass
- **ACTION**: Run all Validation Commands below; fix anything red.
- **VALIDATE**: see below.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| `test_config_unset_soft_fails` | token+chat empty | `{"ok": False, "error": ".. not set"}` | yes — feature-off path |
| `test_upstream_error_soft_fails` | `requests.post` raises via `raise_for_status` | `ok False`, error contains "401" | yes — network/auth failure |
| `test_success` | mocked 200 | `{"ok": True, "error": None}` | no |

### Edge Cases Checklist
- [x] Telegram unconfigured → every hook no-ops silently (cycle, flags, endpoint 503, frontend `false`)
- [x] Telegram down mid-demo → `send_alert` soft-fails; cycle completes normally
- [x] Stub-mode cycles → NO notifications (guard in Task 4)
- [x] Demo mode → zero Supabase writes; zero real device calls
- [x] SSR render of page with `?demo=1` → `typeof window` guard; canvas guard in `synthFrame`
- [x] `speakStatic` in demo mode → cached Supabase MP3 still plays (no device needed); live-synth fallback routes to speechSynthesis
- [ ] Concurrent access — N/A (notifier is stateless; demo state is per-tab)

## Validation Commands

### Static Analysis
```bash
cd /Users/limjiale/IDP_PharmGuard/frontend && npm run lint
```
EXPECT: clean (pre-existing warnings at worst).

### Unit Tests
```bash
cd /Users/limjiale/IDP_PharmGuard/backend && .venv/bin/pytest tests/test_telegram_notifier.py -q
```
EXPECT: 3 passed.

### Full Test Suite
```bash
cd /Users/limjiale/IDP_PharmGuard/backend && .venv/bin/pytest tests/ -q
```
EXPECT: all pass (magazine + elevenlabs suites unaffected).

### Build
```bash
cd /Users/limjiale/IDP_PharmGuard/frontend && npm run build
```
EXPECT: compiles, no type errors.

### Backend smoke (headless dev-mac)
```bash
cd /Users/limjiale/IDP_PharmGuard/backend && BACKEND_HEADLESS=1 .venv/bin/uvicorn main:app --port 8000
# in another shell, with TELEGRAM_* set in backend/.env:
curl -s -X POST localhost:8000/api/device/notify \
  -H "X-Device-API-Key: $DEVICE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"text":"PharmGuard demo wiring test"}'
```
EXPECT: `{"ok":true}` + message arrives in the Telegram chat. Without env: 503 with "not set" detail.

### Browser Validation
```bash
cd /Users/limjiale/IDP_PharmGuard/frontend && npm run dev
```
- [ ] `/dispensers/dispenser-001?demo=1`: amber SIMULATION chip; face verify green; eject → synthetic tray frame with green box + match; intake FSM advances a step every ~4 s and lands "passed"; Log step does NOT write to Supabase.
- [ ] `/dispensers/dispenser-001?demo=fail`: pill verify shows mismatch (red VerdictStamp), voice line plays (speechSynthesis), intake ends `missing_labels`.
- [ ] No `?demo` param: behavior identical to today (device unconfigured → greyed buttons).

### Manual Validation (hardware, pre-demo-day)
- [ ] Real Pi: load wrong pill, run guided dispense → rejection visuals + phone buzz within ~3 s.
- [ ] Real Pi: let a cycle fail intake (walk away) → Telegram "dose NOT confirmed" message.
- [ ] Run flag detector with a 3-miss streak seeded → one batched 🚩 message.

## Acceptance Criteria
- [ ] All 12 tasks completed
- [ ] All validation commands pass
- [ ] Telegram fires on: failed real cycle, new warning/critical flags, guided-flow wrong-pill, operator-marked miss
- [ ] `?demo=1` and `?demo=fail` run the full guided flow with zero backend
- [ ] HI-012 untouched: stub mode never notifies, never reports pill_taken=true
- [ ] DEMO_RUNBOOK.md covers all three acts + recovery

## Completion Checklist
- [ ] telegram_notifier indistinguishable in style from elevenlabs_client
- [ ] No raise paths added to run_cycle (notify is soft + thread-wrapped)
- [ ] demoDevice types imported from device.ts, not redeclared
- [ ] No Supabase writes in demo mode
- [ ] .env.example documents BotFather + getUpdates chat_id discovery
- [ ] No reformatting of page.tsx beyond the four surgical edits

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Telegram latency/outage on stage | Low | Medium | Soft-fail everywhere; runbook Act 2 works visually without the buzz |
| Demo-mode intercept misses a device.ts call → real fetch to dead ngrok | Medium | Low | Functions already return null/false on failure; sweep every import in page.tsx import block (lines 14–56) during Task 9 |
| `?demo=1` left on during a REAL run → operator thinks dose logged | Low | High | Amber SIMULATION chip + "not logged" message in logIntake guard |
| page.tsx edit conflicts (3602 lines, active branch) | Medium | Medium | Surgical anchored edits only; re-read regions before editing |
| Telegram message HTML-injection via med names | Low | Low | Med names are operator-entered; messages use minimal HTML; worst case message fails to parse → soft-fail log |

## Notes
- Architecture reality check: CLAUDE.md is stale — the Pi IS the backend now (merged; see `backend/config.py:1-20`). All hooks land in the unified `backend/`.
- Deliberate decision: simulator is browser-side, NOT an extension of PHARMGUARD_STUB. Stub mode exists to protect telemetry integrity (HI-012: never fake pill_taken=true). A backend simulator that fakes success would gut that invariant; a browser simulator that writes nothing keeps it intact while giving judges the full visual flow.
- Telegram chosen over WhatsApp/SMS: free, no business verification, instant setup, works on the presenter's own phone via group chat.
- Feature 3 (failure demo) is mostly already built (voice line, VerdictStamp, mismatch detection at page.tsx:639-653); this plan adds the missing external signal (Telegram) and the runbook that turns it into a rehearsed act.
