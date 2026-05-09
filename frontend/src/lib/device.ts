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
  result: "passed" | "timeout" | null;
  started_at: number | null;
  ended_at: number | null;
  updated_at: number | null;
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
  if (!isDeviceConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/device/status`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as DeviceStatus;
  } catch {
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
