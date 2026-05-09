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
