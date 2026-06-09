/**
 * Pi device control client.
 *
 * Talks to the on-Pi FastAPI through the ngrok tunnel:
 *   NEXT_PUBLIC_DEVICE_URL    -> e.g. https://abcd-1234.ngrok-free.app
 *   NEXT_PUBLIC_DEVICE_API_KEY -> shared secret matching the Pi's settings.device_api_key
 *
 * The free-tier ngrok URL rotates every Pi reboot — operator must update
 * the env var and redeploy / refresh. fetchDeviceStatus + triggerDispense
 * return null/false when env is unset so the UI can grey out the button
 * instead of silently 404-ing.
 *
 * SECURITY NOTE: NEXT_PUBLIC_DEVICE_API_KEY is shipped to the browser. It
 * is a soft key (defence-in-depth alongside the un-guessable ngrok URL),
 * not a hard secret. For production, route control actions through a
 * Supabase Edge Function proxy that holds the real key server-side.
 */

import { supabase } from "./supabase";

const baseUrl = (process.env.NEXT_PUBLIC_DEVICE_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.NEXT_PUBLIC_DEVICE_API_KEY ?? "";

export type LastCycleSummary = {
  cycle: number;
  pill_taken: boolean;
  t_total_ms: number;
};

export type DeviceStatus = {
  headless: boolean;
  hardware_stubbed: boolean;
  cycle_n: number;
  last_cycle: LastCycleSummary | null;
  task_running: boolean;
  is_unlocked: boolean;
};

export type IntakeStepHistoryRow = {
  step_index: number;
  step_name: string;
  passed_at: number;
};

export type IntakeState = {
  running: boolean;
  step_index: number;       // 0-based
  total_steps: number;
  step_name: string;        // READY | SWALLOW | DONE
  step_label: string;       // human label, e.g. "Take the pill"
  instruction: string;      // patient prompt
  confidence: number;       // 0..1, EMA of current step verifier
  hold_progress: number;    // 0..1, hold-timer fraction
  face_visible: boolean;
  hands_count: number;
  history: IntakeStepHistoryRow[];
  // Layer-2 hard gate extends the terminal set with "missing_labels":
  // MediaPipe FSM completed but no required label (bottle/cup/pill/...)
  // was seen during the swallow window.
  result: "passed" | "timeout" | "missing_labels" | null;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number | null;
  // ── Layer-2 (AWS Rekognition DetectLabels) state ───────────────────
  // Empty arrays / false flags when label layer is disabled server-side.
  labels_seen: string[];                  // ordered unique label names
  labels_seen_at: Record<string, number>; // {label_lower: epoch_seconds}
  labels_required: string[];              // snapshot of required set (lower)
  labels_satisfied: boolean;              // any seen ∈ required?
  mediapipe_complete: boolean;            // all 3 FSM steps done
  labels_inflight: boolean;               // a DetectLabels call is mid-flight
  labels_last_call_at: number | null;     // epoch seconds of last AWS return
};

export function isDeviceConfigured(): boolean {
  return Boolean(baseUrl && apiKey);
}

function authHeaders(): HeadersInit {
  return {
    "X-Device-API-Key": apiKey,
    "ngrok-skip-browser-warning": "true",
  };
}

export async function fetchDeviceStatus(): Promise<DeviceStatus | null> {
  if (!isDeviceConfigured()) {
    console.warn(
      "[device] not configured — set NEXT_PUBLIC_DEVICE_URL + NEXT_PUBLIC_DEVICE_API_KEY in frontend/.env.local, then restart `npm run dev`.",
    );
    return null;
  }
  try {
    const r = await fetch(`${baseUrl}/api/device/status`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(
        `[device] /status ${r.status} ${r.statusText}`,
        body.slice(0, 200),
      );
      return null;
    }
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      const body = await r.text().catch(() => "");
      const looksLikeNgrokWarning =
        body.includes("ngrok") || body.includes("interstitial");
      console.error(
        `[device] /status returned non-JSON (${ct})${
          looksLikeNgrokWarning
            ? " — ngrok warning page; open the URL in a browser tab once to dismiss"
            : ""
        }`,
        body.slice(0, 200),
      );
      return null;
    }
    return (await r.json()) as DeviceStatus;
  } catch (err) {
    console.error("[device] /status fetch failed:", err);
    return null;
  }
}

export async function fetchIntakeState(): Promise<IntakeState | null> {
  if (!isDeviceConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/device/intake`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as IntakeState;
  } catch {
    return null;
  }
}

export async function triggerDispense(): Promise<{ ok: boolean; status: number }> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/dispense_now`, {
      method: "POST",
      headers: authHeaders(),
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function resetDevice(): Promise<{ ok: boolean; status: number }> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/reset`, {
      method: "POST",
      headers: authHeaders(),
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Build the URL for the MJPEG live stream of a camera. For use in
 * <img src="..." />. Auth flows via `?key=...` query param because
 * browser <img> can't set custom headers.
 *
 * `annotate=true` overlays YOLO spotter boxes (cam 0 only). Cam 1
 * ignores the flag — its mediapipe FSM doesn't have a bbox output.
 * Annotated streams drop to ~5 fps (YOLO inference ~150-200 ms on Pi 5).
 *
 * SECURITY NOTE: the API key is in the URL; it'll appear in browser
 * history + ngrok logs. Acceptable for a dev/demo dashboard.
 */
export function streamUrl(camNum: 0 | 1, opts?: { annotate?: boolean }): string | null {
  if (!isDeviceConfigured()) return null;
  const params = new URLSearchParams({ key: apiKey });
  if (opts?.annotate) params.set("annotate", "1");
  return `${baseUrl}/api/device/stream/${camNum}?${params.toString()}`;
}

// ──────────────────────────── manual hardware ops ────────────────────────────

export type EjectResult = {
  ok: boolean;
  status: number;
  latency_ms?: number;
  error?: string;
};

export type DrawerAction = "lock" | "unlock";

export type DrawerResult = {
  ok: boolean;
  status: number;
  is_unlocked?: boolean;
  error?: string;
};

export type LogRecord = {
  ts: number;
  level: string;
  name: string;
  message: string;
};

export type RotateResult = {
  ok: boolean;
  status: number;
  slot?: number;
  current_slot?: number;
  latency_ms?: number;
  error?: string;
};

/**
 * Rotate the magazine to `slot` (0-9) without ejecting. Bench-test
 * counterpart to manualEject — same hardware path, no ejector push.
 */
export async function rotateMagazine(slot: number): Promise<RotateResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/rotate`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slot }),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      slot: data?.slot,
      current_slot: data?.current_slot,
      latency_ms: data?.latency_ms,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function manualEject(slot: number): Promise<EjectResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/eject`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slot }),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      latency_ms: data?.latency_ms,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

export type PillDetection = {
  class_name: string;
  confidence: number;
  bbox: [number, number, number, number];
};

export type VerifyPillResult = {
  ok: boolean;
  status: number;
  expected: string | null;
  top: PillDetection | null;
  match: boolean | null;
  detections: PillDetection[];
  snapshot_b64: string | null;
  latency_ms?: number;
  error?: string;
};

export type IntakeStartResult = {
  ok: boolean;
  status: number;
  already_running?: boolean;
  timeout_s?: number;
  error?: string;
};

export async function startIntakeWatch(
  timeoutS: number = 60,
): Promise<IntakeStartResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/intake/start`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ timeout_s: timeoutS }),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      already_running: data?.already_running,
      timeout_s: data?.timeout_s,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─────────────────── Layer-1 face verify (AWS CompareFaces) ──────────────

export type FaceBoundingBox = {
  Left: number;    // 0-1, normalized to image width
  Top: number;     // 0-1, normalized to image height
  Width: number;   // 0-1
  Height: number;  // 0-1
};

export type VerifyFaceResult = {
  ok: boolean;                    // false → AWS error (still 200, but soft-fail)
  status: number;
  patient_id: number;
  patient_name: string | null;
  match: boolean;                 // similarity >= threshold
  similarity: number | null;      // 0-100, null when AWS errored
  threshold: number | null;
  bbox: FaceBoundingBox | null;   // target-face bbox of best match
  snapshot_b64: string | null;    // base64 JPEG of the frame AWS scored
  error?: string;
  latency_ms?: number;
};

/**
 * Compare the patient's reference photo (patients.face_reference_url) against
 * a live cam_b frame via AWS Rekognition. Returns an empty result without
 * calling the network when device is unconfigured so the UI can grey out
 * the Verify button.
 */
export async function verifyFace(patientId: number): Promise<VerifyFaceResult> {
  const empty: VerifyFaceResult = {
    ok: false,
    status: 0,
    patient_id: patientId,
    patient_name: null,
    match: false,
    similarity: null,
    threshold: null,
    bbox: null,
    snapshot_b64: null,
  };
  if (!isDeviceConfigured()) return empty;
  try {
    const r = await fetch(`${baseUrl}/api/device/verify_face`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ patient_id: patientId }),
    });
    if (!r.ok) {
      return { ...empty, status: r.status, error: await safeError(r) };
    }
    const d = await r.json();
    return {
      ok: !!d.ok,
      status: r.status,
      patient_id: patientId,
      patient_name: d.patient_name ?? null,
      match: !!d.match,
      similarity: d.similarity ?? null,
      threshold: d.threshold ?? null,
      bbox: d.bbox ?? null,
      snapshot_b64: d.snapshot_b64 ?? null,
      latency_ms: d.latency_ms,
      error: d.error ?? undefined,
    };
  } catch {
    return empty;
  }
}

export async function verifyPill(expected?: string): Promise<VerifyPillResult> {
  const empty: VerifyPillResult = {
    ok: false,
    status: 0,
    expected: expected ?? null,
    top: null,
    match: null,
    detections: [],
    snapshot_b64: null,
  };
  if (!isDeviceConfigured()) return empty;
  try {
    const r = await fetch(`${baseUrl}/api/device/verify_pill`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ expected: expected ?? null }),
    });
    if (!r.ok) {
      return { ...empty, status: r.status, error: await safeError(r) };
    }
    const data = await r.json();
    return {
      ok: true,
      status: r.status,
      expected: data?.expected ?? expected ?? null,
      top: data?.top ?? null,
      match: data?.match ?? null,
      detections: Array.isArray(data?.detections) ? data.detections : [],
      snapshot_b64: data?.snapshot_b64 ?? null,
      latency_ms: data?.latency_ms,
    };
  } catch {
    return empty;
  }
}

export async function setDrawer(action: DrawerAction): Promise<DrawerResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/drawer`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      is_unlocked: data?.is_unlocked,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function fetchSnapshot(cam: 0 | 1): Promise<string | null> {
  if (!isDeviceConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/device/snapshot?cam=${cam}`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export async function fetchPiLogs(n: number = 200): Promise<LogRecord[]> {
  if (!isDeviceConfigured()) return [];
  try {
    const r = await fetch(`${baseUrl}/api/device/logs?n=${n}`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { records: LogRecord[] };
    return j.records ?? [];
  } catch {
    return [];
  }
}

async function safeError(r: Response): Promise<string> {
  try {
    const j = await r.json();
    return typeof j?.detail === "string" ? j.detail : JSON.stringify(j);
  } catch {
    return r.statusText || "unknown";
  }
}

// ─────────────────── ejector servo calibration + homing ──────────────────────

export type EjectorCalibration = {
  fwd_us: number;   // forward (eject) pulse width, µs
  rev_us: number;   // reverse (home) pulse width, µs
  stop_us: number;  // stop pulse width, µs (~1500; trim to kill creep)
  move_s: number;   // seconds each stroke is driven
  pause_s: number;  // pause after each stroke, s
};

export type CalibrationInfo = {
  calibration: EjectorCalibration;
  defaults: EjectorCalibration;
  bounds: Record<keyof EjectorCalibration, [number, number]>;
};

export async function fetchCalibration(): Promise<CalibrationInfo | null> {
  if (!isDeviceConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/device/calibration`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as CalibrationInfo;
  } catch {
    return null;
  }
}

export type SetCalibrationResult = {
  ok: boolean;
  status: number;
  calibration?: EjectorCalibration;
  error?: string;
};

/** Persist a partial calibration update; only the given fields change. */
export async function setCalibration(
  updates: Partial<EjectorCalibration>,
): Promise<SetCalibrationResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/calibration`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      calibration: data?.calibration,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Run just the return-home stroke (re-seat the pusher). */
export async function homeEjector(): Promise<EjectResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/ejector/home`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      latency_ms: data?.latency_ms,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Run one full eject (forward + return-home) with current calibration —
 *  no magazine rotation, no DB write. For tuning the servo. */
export async function testEjector(): Promise<EjectResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/ejector/test`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      latency_ms: data?.latency_ms,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─────────────────────────── per-slot daily schedules ────────────────────────

export type ScheduleRow = {
  id: number;
  slot: number;
  name: string | null;
  patient_id: number | null;
  dispenser_id: string | null;
  quantity: number;
  schedule_at: string | null;
};

export async function fetchSchedules(): Promise<ScheduleRow[]> {
  if (!isDeviceConfigured()) return [];
  try {
    const r = await fetch(`${baseUrl}/api/device/schedules`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return [];
    return (await r.json()) as ScheduleRow[];
  } catch {
    return [];
  }
}

export type SetScheduleResult = {
  ok: boolean;
  status: number;
  schedule_at?: string | null;
  error?: string;
};

export async function setSlotSchedule(
  slot: number,
  scheduleAt: string | null,
): Promise<SetScheduleResult> {
  if (!isDeviceConfigured()) return { ok: false, status: 0 };
  try {
    const r = await fetch(`${baseUrl}/api/device/schedule`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ slot, schedule_at: scheduleAt }),
    });
    const data = r.ok ? await r.json() : null;
    return {
      ok: r.ok,
      status: r.status,
      schedule_at: data?.schedule_at ?? null,
      error: r.ok ? undefined : await safeError(r),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─────────────────── nurse-voice TTS (ElevenLabs via Pi) ──────────────
// One Audio at a time — a new prompt cancels the previous so the centering
// line and the greeting never overlap.
let currentAudio: HTMLAudioElement | null = null;

/**
 * Synthesize `text` on the Pi (ElevenLabs) and play it in the browser.
 * No-ops silently when the device is unconfigured or TTS fails — the guided
 * flow must never break because audio is unavailable. Returns true when
 * playback started.
 *
 * NOTE: `audio.play()` rejects when there was no prior user gesture (browser
 * autoplay policy); the rejection is caught here. Call this from a click
 * handler (e.g. the Continue button) when the utterance must be guaranteed.
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
    audio.addEventListener("ended", () => URL.revokeObjectURL(url), {
      once: true,
    });
    await audio.play();
    return true;
  } catch (err) {
    console.warn("[device] speak failed:", err);
    return false;
  }
}

// ─────────────────── static (pre-rendered) nurse lines ────────────────
// Lines that never change are synthesized ONCE by
// backend/scripts/seed_tts_cache.py and stored as MP3s in the Supabase
// "tts-cache" bucket, then played straight from the Supabase CDN — no
// ElevenLabs call, no Pi/ngrok round-trip, works even when the device is
// offline. speakStatic() falls back to live speak() if the cached object
// is missing (seed not run yet) or fails to play.
//
// IMPORTANT: keep this text in sync with SLUG_TEXT in
// backend/scripts/seed_tts_cache.py — that script generates the audio,
// this text is only the live-synth fallback if the cache misses.
export const STATIC_TTS = {
  centering:
    "Hi there. Please make sure your face is centered in the camera so I can recognize you.",
  "intake-ready":
    "Whenever you're ready, gently bring your hand up to your mouth and take the pill.",
  "intake-swallow":
    "That's good. Now close your mouth and swallow for me, nice and easy.",
  "intake-done":
    "Almost there — open your mouth so I can see it's all gone. You're doing great.",
} as const;

export type StaticTtsSlug = keyof typeof STATIC_TTS;

const TTS_BUCKET = "tts-cache";

/** Public URL of a cached line's MP3, or null if Supabase env is unset.
 *  getPublicUrl just builds a string — it does NOT verify the object exists,
 *  so a missing object 404s at play time and triggers the speak() fallback. */
function staticTtsUrl(slug: StaticTtsSlug): string | null {
  try {
    const { data } = supabase.storage
      .from(TTS_BUCKET)
      .getPublicUrl(`${slug}.mp3`);
    return data.publicUrl || null;
  } catch {
    return null;
  }
}

/** Play a remote MP3, sharing the single-audio cancel behavior with speak().
 *  Resolves true only once playback actually starts ("playing" event), false
 *  on load error (e.g. 404 — cache not seeded) or autoplay block, so the
 *  caller can fall back. 4 s safety timeout guards against neither firing. */
function playRemote(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
      }
      const audio = new Audio(src);
      currentAudio = audio;
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      audio.addEventListener("playing", () => finish(true), { once: true });
      audio.addEventListener("error", () => finish(false), { once: true });
      audio.play().catch(() => finish(false));
      setTimeout(() => finish(false), 4000);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Speak a fixed nurse line from the Supabase cache, falling back to live
 * ElevenLabs synthesis if the cached object is missing or won't play.
 * Returns true when audio started (cached or live).
 */
export async function speakStatic(slug: StaticTtsSlug): Promise<boolean> {
  const url = staticTtsUrl(slug);
  if (url && (await playRemote(url))) return true;
  // Cache miss / play failure → live synth (no-ops if device unconfigured).
  return speak(STATIC_TTS[slug]);
}
