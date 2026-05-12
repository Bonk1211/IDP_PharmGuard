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
