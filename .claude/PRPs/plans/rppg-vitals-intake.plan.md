# Plan: rPPG vital-signs "wow factor" on intake verification

**Status:** proposed (plan only — no code yet)
**Source idea:** https://github.com/ubicomplab/rPPG-Toolbox — camera-based heart-rate.

---

## TL;DR decision

**Do NOT import rPPG-Toolbox as a dependency or load its neural models.**
It is a research/training harness (PyTorch dataset benchmarking), not an edge
runtime. Instead **lift one unsupervised algorithm — POS** (Wang et al. 2017,
`unsupervised_methods/methods/POS_WANG.py` in that repo) — which is ~80 lines of
numpy/scipy, needs **no model weights**, and runs real-time on the Pi.

Rationale:
- Neural methods (DeepPhys / TS-CAN / PhysNet / EfficientPhys) need `.pth`
  weights + per-frame torch inference. On Pi 5 CPU, alongside YOLO + MediaPipe,
  they will not hit real-time. Torch is already vendored (via ultralytics) but
  that doesn't make per-frame CNN inference cheap.
- POS/CHROM are pure signal processing. We **already** track the face every
  frame with MediaPipe FaceMesh (`intake_monitor.py:263`), so the ROI — the
  expensive part — is free.

## Hard constraint that shapes the whole design

rPPG signal collapses under **motion and poor light**. During the swallow FSM
the patient moves hand→mouth and tilts the head — that window is unusable.

→ **Measure vitals in a separate "hold still, look at the camera" phase**,
distinct from the READY/INSERT/SWALLOW/DONE steps. Either:
- **Phase A (pre-intake):** after face-ID, before READY — "Hold still 10s while
  we check your vitals." Clean, patient is stationary. **Recommended.**
- **Phase B (post-intake):** after DONE. Also fine.

This is wellness/demo-grade, **not clinical**. Never display a fabricated number
when SNR is low — show `—` + "low signal". Faking a vital sign on a medical
device is the wrong kind of wow.

## License gate (do before shipping)

rPPG-Toolbox carries a **responsible-use / research clause**. Lifting the POS
*algorithm* (public paper, standard DSP) is low-risk, but: (a) re-derive from the
paper or cite, (b) do not copy any model weights, (c) confirm license terms allow
patient-facing use. Owner sign-off required before this is more than a demo.

---

## Architecture fit

New isolated module, mirrors the Layer-2 label sampler pattern already in
`intake_monitor.py` (config-gated, soft-fail, state-dict surfaced).

```
backend/vision/vitals_estimator.py   (new)   POS algorithm, numpy/scipy only
backend/vision/intake_monitor.py     (edit)  feed ROI RGB; new "VITALS" phase
backend/config.py                    (edit)  vitals_* settings block
backend/app/api/device.py            (edit)  expose vitals in /api/device/intake
frontend/src/components/...          (edit)  live BPM panel + quality bar
requirements.txt                     (edit)  scipy (small; confirm not already pulled)
```

### `vitals_estimator.py` (the lift)
- Ring buffer of per-frame `[R_mean, G_mean, B_mean]` from forehead ROI.
- FaceMesh forehead landmarks: **10, 67, 297, 338, 109, 151** (bbox of these);
  optionally add cheeks (50, 280) for a second ROI to average.
- Window: **~10 s** (`fps * 10` samples). Need fps estimate — derive from frame
  timestamps, don't assume 30.
- POS core: project normalized RGB onto the chrominance plane, build the POS
  signal, then **bandpass 0.7–4.0 Hz** (42–240 BPM) via `scipy.signal.butter` +
  `filtfilt`, **FFT**, peak frequency × 60 = BPM.
- **Quality/SNR gate:** ratio of peak-band power to total in-band power. Below
  threshold → return `None` BPM + low-quality flag.
- Pure function + thin stateful wrapper. No camera, no threads inside — the
  monitor owns the loop (same separation as the FSM verifiers).

### `intake_monitor.py` changes
- Add a `VITALS` phase **before** `_STEPS[0]` (or a separate
  `measure_vitals(duration_s)` method called by the cycle before
  `watch_for_swallow`). Keep it OUT of the 4-step FSM so the swallow steps stay
  motion-tolerant.
- During that phase: each frame, crop forehead ROI from the FaceMesh landmarks
  already computed, push mean-RGB to the estimator, every ~1 s recompute BPM.
- New `_state` keys: `vitals_phase` (bool), `heart_rate_bpm` (float|None),
  `vitals_quality` (0..1), `vitals_progress` (0..1 of the 10 s window),
  `vitals_updated_at`. Mirror the lock discipline used everywhere in this file.
- **Do not** gate intake pass/fail on vitals. It's additive telemetry only.

### `config.py` (mirror the `intake_label_*` block at config.py:100)
```python
vitals_enabled: bool = False          # off by default — opt-in demo feature
vitals_window_s: float = 10.0
vitals_min_quality: float = 0.40      # below → show "—", no number
vitals_band_low_hz: float = 0.7
vitals_band_high_hz: float = 4.0
```

### API + frontend
- `/api/device/intake` already returns the state dict — vitals ride along for
  free once added to `_state`.
- Frontend: a "Vitals" card in the intake/game panel — big BPM number, a
  pulsing heart, a **signal-quality bar**. When `vitals_quality <
  vitals_min_quality`: show `—` + "Hold still / improve lighting".
- Optional: persist `heart_rate_bpm` per intake to Supabase for a trend chart.
  Schema add only if owner wants history (separate decision).

---

## Build order (when greenlit)

1. **Prototype first** — `ml/vitals/pos_demo.py` standalone on a laptop webcam.
   Confirm POS gives a stable BPM vs a real pulse-ox before touching backend.
   If signal quality is bad on the actual Pi camera + lighting, stop here.
2. `vitals_estimator.py` + unit-checkable pure POS function.
3. Config flag block (default **off**).
4. Wire the VITALS phase into the monitor, state-dict keys.
5. Frontend vitals card.
6. Validate on the Pi at real fps (measure achieved fps — if FaceMesh+ROI drops
   below ~12 fps the window math must use measured fps, not nominal).

## Risks / open questions

- **fps stability** on Pi under load — POS needs roughly uniform sampling;
  resample to a fixed rate if jitter is high.
- **Pi camera** auto-exposure/auto-white-balance can wreck the rPPG signal —
  may need to lock AE/AWB during the vitals window (picamera2 controls).
- **SpO2** from RGB rPPG is research-grade and unreliable — **do not ship an
  SpO2 number.** Heart rate only.
- Decide Phase A vs Phase B placement (recommend A: pre-intake, stationary).
- License sign-off (above) before patient-facing use.
