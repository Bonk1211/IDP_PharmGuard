# PharmGuard — Judge Demo Runbook

Three acts, ~7 minutes. Act 2 is the money shot: the system **catching a wrong
pill live** and buzzing the caregiver's phone on stage. Act 3 is insurance —
use it only if the hardware dies.

---

## Pre-flight checklist (T-30 min)

| # | Check | How |
|---|---|---|
| 1 | Pi powered + service running | `ssh pi@<host>`, `systemctl status pharmguard` |
| 2 | ngrok tunnel fresh | grab the new URL, paste into `frontend/.env.local` → `NEXT_PUBLIC_DEVICE_URL`, restart/redeploy dashboard |
| 3 | Dashboard reachable | open `/dispensers/<id>` — status pill green, cams streaming |
| 4 | Telegram wired | `curl -s -X POST <NGROK_URL>/api/device/notify -H "X-Device-API-Key: <key>" -H 'Content-Type: application/json' -d '{"text":"demo wiring test"}'` → phone buzzes |
| 5 | CORRECT pill loaded in the demo slot | physical check |
| 6 | WRONG pill staged within reach (Act 2) | physical check |
| 7 | Phone on stage, Telegram chat open, volume UP | — |
| 8 | Browser tab clicked once | autoplay policy — voice won't play without a prior gesture |
| 9 | Backup tab pre-opened: `/dispensers/<id>?demo=1` | Act 3 insurance |

Telegram setup (once): create a bot with **@BotFather** → put the token in
`backend/.env` `TELEGRAM_BOT_TOKEN`. Message the bot once from the demo phone,
then `https://api.telegram.org/bot<TOKEN>/getUpdates` →
`result[0].message.chat.id` → `TELEGRAM_CHAT_ID`. Restart the service.

---

## Act 1 — Happy path (~3 min)

1. **Identify** — select the patient, hit Verify Face. AWS Rekognition compares
   against the reference photo → green VERIFIED stamp with similarity %.
   *Say: "two-layer identity check before a single pill moves."*
2. **Dispense** — eject the slot. Magazine rotates, ejector pushes, tray cam
   runs YOLO → green stamp naming the pill + confidence.
   *Point at the annotated tray snapshot — that's on-device inference.*
3. **Verify** — the intake game starts. Cam 1 shows the live MediaPipe
   FaceMesh/Hands overlay + the L1/L2 HUD. Patient takes the pill through the
   4-step FSM; AWS DetectLabels gates on cup/bottle.
   *Say: "we don't trust 'I took it' — we watch the swallow, two ways."*
4. **Log** — confirm. Adherence row lands in Supabase; dashboard updates live.

## Act 2 — Failure catch (~2 min, THE moment)

1. Load the **WRONG** pill into the demo slot (do it visibly — judges should
   see the mistake happen).
2. Eject. YOLO detects the mismatch →
   - red **REJECTED** verdict stamp with detected-vs-expected names,
   - calm nurse voice: *"that looks like X, not your Y…"*,
   - **the phone on stage buzzes** — Telegram: "⚠️ PharmGuard: wrong pill on
     tray — detected X, expected Y."
3. Mark the dose missed → second Telegram message + adherence log shows the
   miss; the clinician flags panel picks up streaks automatically.
4. *Talking point: "the dangerous case isn't forgetting a pill — it's taking
   the wrong one. PharmGuard catches it in seconds and the caregiver knows
   before the patient's even left the room."*

## Act 3 — Simulator insurance (only if hardware dies)

1. Switch to the pre-opened tab: `/dispensers/<id>?demo=1`.
2. The amber **SIMULATION** chip shows — be transparent: *"hardware demo
   gods said no, so here's the exact same flow in simulation mode."*
3. Full flow runs scripted: face verify → eject → synthetic tray frame →
   4-step intake FSM → done. Nothing is written to the database.
4. `?demo=fail` reproduces Act 2's wrong-pill rejection without hardware.

---

## Recovery moves

| Symptom | Fix |
|---|---|
| Buttons greyed / status dead | ngrok URL rotated — update `NEXT_PUBLIC_DEVICE_URL`, restart dashboard. If mid-demo: go to Act 3. |
| No nurse voice | click anywhere once (autoplay); check `ELEVENLABS_API_KEY`; static lines still play from Supabase cache |
| Telegram silent | `journalctl -u pharmguard -f \| grep -i telegram`; check token/chat_id; Act 2 still works visually without the buzz |
| Cam stream black | `POST /api/device/reset` (Advanced tab) or `sudo systemctl restart pharmguard` |
| Wedged mid-cycle | same reset; the offline queue replays any unposted logs |
