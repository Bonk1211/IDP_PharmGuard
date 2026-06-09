# Plan: Nurse-Voice Guidance During Dispense + Intake Verification

## Summary
The ElevenLabs nurse voice today only speaks during patient identification (face-centering prompt + post-match greeting). This plan extends the same `speak()` plumbing to two later phases of the guided round: **Dispense** (a warm "here's your pill" line on eject, plus a calm safety line when the wrong/extra pill is detected) and **Intake verification** (a comforting spoken prompt as each swallow-FSM step advances). No backend changes — all new triggers and scripts live in the frontend `dispensers/[id]/page.tsx`, reusing the existing `speak()` → `/api/device/tts` → ElevenLabs path.

## User Story
As a patient at the dispenser cabinet, I want a warm spoken nurse to guide me as my pill is released and as I take it, so that the whole round feels like a real nurse is with me — not just during login.

## Problem → Solution
**Current:** Voice fires at exactly two places, both auth-phase — `CENTERING_PROMPT` (face centering, `page.tsx:335`) and `greetingScript()` (post-match greeting, `page.tsx:721`). After the greeting, the patient goes through Dispense and Intake verification in silence; error states are cold on-screen text.
**Desired:** Spoken, comforting guidance continues through Dispense (pill released, wrong/extra pill alert) and Intake verification (each FSM step prompt), using hand-written warm scripts, frontend-triggered, milestone-paced (speak on state *change* only — never on every poll tick).

## Metadata
- **Complexity**: Small
- **Source PRD**: N/A (free-form feature request)
- **PRD Phase**: N/A
- **Estimated Files**: 1 (`frontend/src/app/dispensers/[id]/page.tsx`)

---

## Decisions Locked (from user, this session)
| Decision | Choice | Consequence |
|---|---|---|
| Voice moments | Pill dispensed · Wrong/extra pill alert · Intake step prompts | "Intake result" (pass/timeout congrats) was **not** selected → leave terminal silent, but stub a clearly-marked hook so adding it later is one line. |
| Line authoring | Static templates | New pure script functions next to `greetingScript`. No LLM, no network, no latency, deterministic. |
| Verbosity (intake) | Milestones only | Speak on `step_index` change only. No per-tick / per-progress chatter. |
| Trigger site | Frontend `page.tsx` | Zero backend change. Voice is tied to the dashboard being open (acceptable — the dashboard is always the cabinet UI). |

---

## UX Design

### Before
```
┌──────────────────────────────────────────────────────────┐
│ Identify  → 🔊 "centre your face" + 🔊 greeting           │
│ Unlock    → (silent)                                      │
│ Dispense  → click Eject … (silent); wrong pill = red text │
│ Verify    → AI watches swallow FSM … (silent)             │
│ Log       → (silent)                                      │
└──────────────────────────────────────────────────────────┘
```

### After
```
┌──────────────────────────────────────────────────────────┐
│ Identify  → 🔊 "centre your face" + 🔊 greeting (unchanged)│
│ Unlock    → (silent — unchanged)                          │
│ Dispense  → 🔊 "Here's your Metformin, take your time…"   │
│             ⚠ wrong/extra pill → 🔊 "Hold on a moment,    │
│                that's not your pill, let's set it aside…"  │
│ Verify    → on each FSM step change:                      │
│             🔊 READY  "gently bring your hand to your mouth"│
│             🔊 SWALLOW"good — now close and swallow for me"│
│             🔊 DONE   "almost there, open your mouth…"     │
│ Log       → (silent — terminal congrats intentionally     │
│             left out; hook present)                        │
└──────────────────────────────────────────────────────────┘
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Eject success (`onEject`) | on-screen toast only | + `speak(dispensedScript(name))` | One line per eject. New eject cancels prior audio (existing single-Audio behavior). |
| Pill mismatch / unauthorized | red text + Re-eject button | + `speak(wrongPillScript(...))` once per detection | Calm tone, fires once (ref-guarded), not every 4 s re-verify tick. |
| Intake FSM step advance | cam-1 footer text changes | + `speak(intakeStepScript(step_name))` on change | Milestone-paced via `lastSpokenStepRef`. |

---

## Mandatory Reading
| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 129-150 | Existing static-script pattern (`CENTERING_PROMPT`, `firstName`, `greetingScript`) — mirror exactly. |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 327-336 | Existing speak-once-per-state effect + `centeringSpokenForRef` ref-guard pattern. |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 507-539 | `onEject` — where the "pill dispensed" + mismatch lines hook in. |
| P0 | `frontend/src/app/dispensers/[id]/page.tsx` | 244-256 | Intake state poll (250 ms) — the source of `intake.step_index` changes the step-prompt effect watches. |
| P1 | `frontend/src/app/dispensers/[id]/page.tsx` | 86-99, 405-408 | `unauthorizedDetections()` + `unauthorized` memo — drives the wrong-pill trigger. |
| P1 | `frontend/src/lib/device.ts` | 651-680 | `speak()` contract: no-ops when unconfigured/empty, soft-fails, cancels prior Audio, returns bool. Do not re-implement. |
| P2 | `backend/vision/intake_monitor.py` | 72-104 | Canonical FSM step names/instructions the scripts must key off (`READY`/`SWALLOW`/`DONE`) and terminal `result` values. |

## External Documentation
| Topic | Source | Key Takeaway |
|---|---|---|
| ElevenLabs TTS | already integrated (`backend/services/elevenlabs_client.py`) | No new API work. Voice/model/format set in `backend/config.py:112-120`. |

No external research needed — feature reuses established internal patterns.

---

## Patterns to Mirror

### STATIC_SCRIPT_FUNCTION
```ts
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:131-150
const CENTERING_PROMPT =
  "Hi there. Please make sure your face is centered in the camera so I can recognize you.";

function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

function greetingScript(patient: Patient | null, slots: SlotInfo[]): string {
  const hi = `Hello ${firstName(patient?.name)}.`;
  // ...builds a warm sentence from data...
  return `${hi} It's time to take your ${list}. Take your time — I'm right here with you.`;
}
```

### SPEAK_ONCE_PER_STATE_EFFECT (ref-guarded, fires once per state value)
```ts
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:327-336
const centeringSpokenForRef = useRef<number | null>(null);
useEffect(() => {
  if (viewIdx !== 0) return;
  if (!activePatient || faceVerified) return;
  if (centeringSpokenForRef.current === activePatient.id) return;
  centeringSpokenForRef.current = activePatient.id;
  void speak(CENTERING_PROMPT);
}, [viewIdx, activePatient, faceVerified]);
```

### REF_RESET_ON_ROUND_CHANGE
```ts
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:320-325
useEffect(() => {
  setFaceVerified(false);
  setFaceResult(null);
  setFaceVerifying(false);
  centeringSpokenForRef.current = null;     // reset guard for next patient
}, [activePatient?.id]);
```

### FIRE_AND_FORGET_SPEAK
```ts
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:335, 721
void speak(greetingScript(activePatient, activeSlots));  // never await in a render/effect path
```

### ONEJECT_HOOK_POINT
```ts
// SOURCE: frontend/src/app/dispensers/[id]/page.tsx:507-535
async function onEject(slot: number) {
  const r = await withBusy(`eject-${slot}`, () => manualEject(slot));
  if (r.ok) {
    setLastEjected(slot);
    setMsg(`Slot ${slot} ejected (${r.latency_ms} ms). Verifying…`);
    const expected = slots.find((s) => s.slot === slot)?.name ?? undefined;
    // ↑ `expected` is the spoken pill name. speak() the dispensed line here.
    setVerifyResult(null);
    setVerifying(true);
    setTimeout(() => {
      verifyPill(expected)
        .then((vr) => {
          setVerifyResult(vr);
          if (vr.ok && vr.top) { /* match/mismatch toast — speak mismatch here */ }
        })
        .finally(() => setVerifying(false));
    }, 600);
  }
}
```

---

## Files to Change
| File | Action | Justification |
|---|---|---|
| `frontend/src/app/dispensers/[id]/page.tsx` | UPDATE | Add 3 script fns + 2 refs + 1 effect + 2 inline `speak()` calls. Only file touched. |

## NOT Building
- **No backend changes.** `/api/device/tts`, `elevenlabs_client.py`, `config.py` untouched.
- **No LLM-generated lines.** Static templates only (locked decision).
- **No terminal "intake result" voice** (pass congrats / timeout re-prompt) — user did not select it. A commented hook is left at the result-watch site so it's a one-line add later.
- **No per-progress / per-tick chatter** during the swallow watch — step-change milestones only.
- **No new env vars / voice config.** Reuses the existing "Sarah" voice in `config.py:117`.
- **No changes to the Unlock or Log steps.**
- **No new audio queue** — keep the existing one-Audio-at-a-time behavior in `speak()`.

---

## Step-by-Step Tasks

### Task 1: Add the three static script functions
- **ACTION**: In the `nurse-voice scripts` block (after `greetingScript`, ~line 150), add `dispensedScript`, `wrongPillScript`, and `intakeStepScript`.
- **IMPLEMENT**:
  ```ts
  // Spoken when a pill lands on the tray during Dispense.
  function dispensedScript(medName: string | null | undefined): string {
    const med = (medName ?? "").trim();
    return med
      ? `Here's your ${med}. Take your time picking it up from the tray — there's no rush.`
      : `Your medication is on the tray now. Take your time picking it up — there's no rush.`;
  }

  // Spoken once when the tray shows the wrong pill or an extra/unauthorized pill.
  // Calm + reassuring, never alarming.
  function wrongPillScript(
    expected: string | null | undefined,
    detected?: string | null,
  ): string {
    const exp = (expected ?? "").trim();
    const det = (detected ?? "").trim();
    const noticed = det
      ? `Hold on a moment — that looks like ${det}, not your ${exp || "medication"}.`
      : `Hold on a moment — that doesn't look quite right.`;
    return `${noticed} Let's set it aside and I'll sort the right one out for you. You're safe.`;
  }

  // Spoken once each time the swallow-FSM advances to a new step.
  // Keyed by step_name (vision/intake_monitor.py: READY | SWALLOW | DONE);
  // falls back to the backend instruction for any unknown step.
  function intakeStepScript(stepName: string, instruction: string): string {
    switch (stepName) {
      case "READY":
        return "Whenever you're ready, gently bring your hand up to your mouth and take the pill.";
      case "SWALLOW":
        return "That's good. Now close your mouth and swallow for me, nice and easy.";
      case "DONE":
        return "Almost there — open your mouth so I can see it's all gone. You're doing great.";
      default:
        return instruction || "Follow along with me, you're doing great.";
    }
  }
  ```
- **MIRROR**: STATIC_SCRIPT_FUNCTION (uses `firstName`-style plain-function shape; no hooks, no side effects).
- **IMPORTS**: none new.
- **GOTCHA**: Keep each line short (the TTS body cap is 600 chars in `device.py:520`; these are far under). Tone must stay warm/non-alarming even for the wrong-pill case (clinical context).
- **VALIDATE**: `cd frontend && npm run lint` — no unused-var / no-implicit-any errors on the new functions.

### Task 2: Speak the "pill dispensed" line on eject
- **ACTION**: Inside `onEject`, in the `if (r.ok)` branch, after `expected` is computed (~line 515), fire the dispensed line.
- **IMPLEMENT**:
  ```ts
  const expected = slots.find((s) => s.slot === slot)?.name ?? undefined;
  void speak(dispensedScript(expected));   // ← add
  setVerifyResult(null);
  ```
- **MIRROR**: FIRE_AND_FORGET_SPEAK (`void speak(...)`, never awaited).
- **IMPORTS**: `speak` already imported (`page.tsx:29`).
- **GOTCHA**: Place it *before* the `setTimeout(verifyPill…)` so the greeting/centering audio (if any) is cancelled immediately and the dispense line plays while YOLO runs. Do not `await` — `onEject` must stay responsive.
- **VALIDATE**: Manual — click Eject on a loaded slot with device configured; hear the line; confirm the eject toast + verify still run.

### Task 3: Speak the wrong/extra-pill alert once per detection (Dispense step)
- **ACTION**: Add a ref + an effect that watches the `unauthorized` memo (and `verifyResult.match === false`) while on the Dispense card (`viewIdx === 2`), speaking once per eject.
- **IMPLEMENT**:
  - Add ref near the other refs (~line 214):
    ```ts
    // Guards the wrong-pill voice line so it fires once per eject, not on
    // every 4 s re-verify tick. Reset on each new eject (see onEject).
    const wrongPillSpokenRef = useRef<boolean>(false);
    ```
  - In `onEject`'s `if (r.ok)` branch, reset the guard so a fresh eject can warn again:
    ```ts
    wrongPillSpokenRef.current = false;   // ← add alongside setVerifyResult(null)
    ```
  - Add the effect (place after the `viewIdx === 3` verify-loop effect, ~line 456):
    ```ts
    // Calm spoken alert when the tray shows the wrong or an extra pill,
    // while the operator is on the Dispense card. Fires once per eject.
    useEffect(() => {
      if (viewIdx !== 2) return;
      if (!verifyResult || !verifyResult.top) return;
      const isMismatch = verifyResult.match === false;
      const hasExtra = unauthorized.length > 0;
      if (!isMismatch && !hasExtra) return;
      if (wrongPillSpokenRef.current) return;
      wrongPillSpokenRef.current = true;
      const detected = isMismatch
        ? verifyResult.top.class_name
        : unauthorized[0]?.class_name;
      void speak(wrongPillScript(currentSlot?.name, detected));
    }, [viewIdx, verifyResult, unauthorized, currentSlot?.name]);
    ```
- **MIRROR**: SPEAK_ONCE_PER_STATE_EFFECT (ref-guarded) + FIRE_AND_FORGET_SPEAK.
- **IMPORTS**: `useRef`, `useEffect` already imported (`page.tsx:13`). `unauthorized` already a memo (`page.tsx:405`).
- **GOTCHA**: `unauthorized` is recomputed by the 4 s re-verify loop and by `onEject`'s background `verifyPill` — without the ref guard the line would repeat every tick. The guard resets only in `onEject`, so re-ejecting the same slot correctly re-warns.
- **VALIDATE**: Manual — eject a slot whose pill differs from `currentSlot.name` (or place an extra pill); hear the calm alert exactly once; re-eject → hear it again.

### Task 4: Speak each intake FSM step prompt on step-change (Verify step)
- **ACTION**: Add a ref + an effect that watches `intake.step_index` while `intake.running`, speaking the matching `intakeStepScript` once per step transition.
- **IMPLEMENT**:
  - Add ref near the others (~line 214):
    ```ts
    // Last swallow-FSM step index we spoke a prompt for. -1 = none yet.
    // Milestone-paced: speak only when this changes, never on every poll.
    const lastSpokenStepRef = useRef<number>(-1);
    ```
  - Add the effect (after the intake poll effect, ~line 256):
    ```ts
    // Speak a warm prompt each time the swallow FSM advances a step.
    // Milestones only — guarded by lastSpokenStepRef so the 250 ms intake
    // poll doesn't re-trigger the same line. Resets when the watch stops.
    useEffect(() => {
      if (!intake?.running) {
        lastSpokenStepRef.current = -1;
        return;
      }
      const idx = intake.step_index ?? 0;
      if (idx === lastSpokenStepRef.current) return;
      lastSpokenStepRef.current = idx;
      void speak(intakeStepScript(intake.step_name, intake.instruction));
    }, [intake?.running, intake?.step_index, intake?.step_name, intake?.instruction]);
    ```
- **MIRROR**: SPEAK_ONCE_PER_STATE_EFFECT + REF_RESET_ON_ROUND_CHANGE (reset when `!running`) + FIRE_AND_FORGET_SPEAK.
- **IMPORTS**: none new. `IntakeState` fields `running`/`step_index`/`step_name`/`instruction` exist (`lib/device.ts:43-71`).
- **GOTCHA**: The intake state polls every 250 ms (`page.tsx:251`); the ref guard is essential or the current step's line repeats 4×/s. Resetting to `-1` on `!running` ensures the first step of the *next* round speaks again (the FSM restarts at `step_index 0`, which would otherwise equal a stale guard value).
- **VALIDATE**: Manual — start the intake watch (Confirm & verify intake); as the FSM steps READY→SWALLOW→DONE, hear exactly one line per step; idle/re-run → first step speaks again.

### Task 5: Leave a marked hook for the (unselected) terminal result line
- **ACTION**: Add a short comment at the intake step-change effect documenting where a pass/timeout congrats would attach, so the deliberate omission is discoverable.
- **IMPLEMENT**: Above the Task-4 effect:
  ```ts
  // NOTE: terminal result voice (congrats on intake.result === "passed",
  // gentle re-prompt on "timeout"/"missing_labels") was intentionally left
  // out per scope. To add: a sibling effect watching intake.result, ref-
  // guarded once-per-round, calling a resultScript(intake.result).
  ```
- **MIRROR**: in-file comment style (see the many `// ─── …` and rationale comments).
- **IMPORTS**: none.
- **VALIDATE**: comment present; no behavior change.

---

## Testing Strategy

### Unit Tests
No JS/TS test runner is configured in this repo (`CLAUDE.md`: "no test suite"; frontend has only `next lint`). The new code is pure script functions + ref-guarded effects — verified via lint, build, and manual run. Do **not** claim automated tests pass.

| Pure-function behavior to eyeball | Input | Expected |
|---|---|---|
| `dispensedScript` named | `"Metformin"` | "...your Metformin..." |
| `dispensedScript` unknown | `null` | generic "Your medication is on the tray now..." |
| `wrongPillScript` w/ detected | `("Aspirin","Lomide capsule")` | "...that looks like Lomide capsule, not your Aspirin..." |
| `intakeStepScript` known | `("SWALLOW", …)` | swallow line |
| `intakeStepScript` unknown | `("XYZ","raw instr")` | falls back to `"raw instr"` |

### Edge Cases Checklist
- [x] Device unconfigured → `speak()` no-ops (returns false), no crash (handled in `lib/device.ts`).
- [x] TTS upstream 503 → `speak()` warns + returns false, flow continues silent.
- [x] Null/empty med name → script generic fallback.
- [x] Repeated poll ticks → ref guards prevent repeat utterances.
- [x] New round / new patient → `lastSpokenStepRef` resets on `!running`; `wrongPillSpokenRef` resets on eject.
- [x] Re-eject same slot → wrong-pill line re-warns (guard reset in `onEject`).
- [x] Browser autoplay block (no prior gesture) → rejection swallowed in `speak()`; lines that follow a click (Eject, Confirm) are safe.

---

## Validation Commands

### Static Analysis / Lint
```bash
cd frontend && npm run lint
```
EXPECT: Zero new errors/warnings attributable to `page.tsx`.

### Build
```bash
cd frontend && npm run build
```
EXPECT: Type-checks and builds clean (no new TS errors).

### Dev server (manual)
```bash
make frontend     # next dev on :3000
# (device must be configured: NEXT_PUBLIC_DEVICE_URL + NEXT_PUBLIC_DEVICE_API_KEY)
```
EXPECT: Voice plays at Dispense (eject), wrong-pill alert, and each intake step.

### Manual Validation
- [ ] Identify still speaks centering + greeting (no regression).
- [ ] Eject a correct pill → hear `dispensedScript`.
- [ ] Eject a wrong/extra pill → hear `wrongPillScript` once; re-eject → again.
- [ ] Run intake watch → hear one line per FSM step (READY/SWALLOW/DONE), no repeats.
- [ ] Idle/disconnected device → fully silent, no console errors beyond `speak()`'s soft-fail warn.
- [ ] No two lines overlap (new `speak()` cancels prior Audio).

---

## Acceptance Criteria
- [ ] Dispense eject speaks a warm "here's your pill" line.
- [ ] Wrong/extra pill on tray speaks a calm safety line, once per eject.
- [ ] Each swallow-FSM step change speaks its mapped prompt, once per step.
- [ ] Auth-phase voice (centering + greeting) unchanged.
- [ ] `npm run lint` and `npm run build` clean.
- [ ] No backend files changed.

## Completion Checklist
- [ ] Scripts mirror `greetingScript` (pure fns, in the scripts block).
- [ ] Effects mirror the `centeringSpokenForRef` ref-guard + fire-and-forget pattern.
- [ ] All `speak()` calls are `void speak(...)` (never awaited in render/effect).
- [ ] Ref guards reset at the right boundaries (eject / `!running`).
- [ ] Terminal-result hook comment present.
- [ ] No new env vars, no new deps, no hardcoded voice ids.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lines overlap / clip each other | Low | Low | `speak()` already cancels prior Audio (one-Audio-at-a-time, `device.ts:639`). |
| Wrong-pill line repeats on re-verify tick | Med (if unguarded) | Med (annoying) | `wrongPillSpokenRef` guard; reset only on new eject. |
| Intake line repeats 4×/s | High (if unguarded) | High | `lastSpokenStepRef` step-change guard. |
| Voice "speaks over" a patient mid-swallow | Low | Low | Milestones only (step change), not per-progress; lines are short. |
| ElevenLabs free-tier latency on each call | Med | Low | Soft-fail + fire-and-forget; UI never blocks on audio. Lines are short (turbo model, `config.py:119`). |
| Autoplay blocked before first gesture | Low (dispense/intake follow clicks) | Low | Rejection swallowed in `speak()`. |

## Notes
- The entire feature is additive inside one component; the diff is ~3 script fns + 2 refs + 2 effects + 2 inline calls + 2 guard resets.
- If terminal congrats is wanted later, add a `resultScript()` and a sibling effect watching `intake.result` (ref-guarded once-per-round) at the hook comment from Task 5 — ~8 lines, no new infra.
- Voice persona/voice-id is centralized in `backend/config.py:117` ("Sarah"); changing the voice is a backend env change, out of scope here.
