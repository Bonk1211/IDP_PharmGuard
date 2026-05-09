/**
 * Clinician-assistant client. Same ngrok->Pi tunnel as device.ts;
 * shares NEXT_PUBLIC_DEVICE_URL + NEXT_PUBLIC_DEVICE_API_KEY.
 *
 * The backend gates /api/agent/* with the same X-Device-API-Key header.
 */

const baseUrl = (process.env.NEXT_PUBLIC_DEVICE_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.NEXT_PUBLIC_DEVICE_API_KEY ?? "";

export type ChatTurn = {
  role: "user" | "assistant";
  text: string;
};

export type ChatToolCall = {
  name: string;
  args: Record<string, unknown>;
  result_summary: string;
};

export type ChatResponse = {
  text: string;
  tool_calls: ChatToolCall[];
  metadata: {
    hops: number;
    latency_ms: number;
    model: string;
    truncated: boolean;
    error?: boolean;
  };
};

export type AgentBrief = {
  id?: string;
  kind: "shift_handover" | "on_demand";
  content: string;          // markdown
  metadata: {
    model: string;
    latency_ms: number;
    lookback_hours: number;
    n_missed: number;
    n_alerts: number;
    n_low_stock: number;
  };
  generated_at?: string;
  created_at?: string;
};

function isAgentConfigured(): boolean {
  return Boolean(baseUrl && apiKey);
}

function authHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    ...extra,
    "X-Device-API-Key": apiKey,
    "ngrok-skip-browser-warning": "true",
  };
}

export async function chatAgent(messages: ChatTurn[]): Promise<ChatResponse> {
  if (!isAgentConfigured()) {
    throw new Error(
      "Agent not configured (set NEXT_PUBLIC_DEVICE_URL + NEXT_PUBLIC_DEVICE_API_KEY).",
    );
  }
  const r = await fetch(`${baseUrl}/api/agent/chat`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ messages }),
  });
  if (!r.ok) {
    const detail = await safeError(r);
    throw new Error(`agent chat failed (${r.status}): ${detail}`);
  }
  return (await r.json()) as ChatResponse;
}

export async function fetchLatestBrief(): Promise<AgentBrief | null> {
  if (!isAgentConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/agent/briefs/recent?limit=1`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const rows = (await r.json()) as AgentBrief[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function refreshBrief(
  kind: "shift_handover" | "on_demand" = "on_demand",
): Promise<AgentBrief> {
  if (!isAgentConfigured()) {
    throw new Error("Agent not configured.");
  }
  const r = await fetch(
    `${baseUrl}/api/agent/brief?kind=${encodeURIComponent(kind)}`,
    {
      method: "POST",
      headers: authHeaders(),
    },
  );
  if (!r.ok) {
    const detail = await safeError(r);
    throw new Error(`brief generation failed (${r.status}): ${detail}`);
  }
  return (await r.json()) as AgentBrief;
}

async function safeError(r: Response): Promise<string> {
  try {
    const j = await r.json();
    return typeof j?.detail === "string" ? j.detail : JSON.stringify(j);
  } catch {
    return r.statusText || "unknown";
  }
}
