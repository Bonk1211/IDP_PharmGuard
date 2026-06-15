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

export function isAgentConfigured(): boolean {
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

// ── Streaming chat (thinking-process trace) ──────────────────────────────

export type ChatStreamEvent =
  | { type: "status"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "analysis"; text: string }
  | { type: "tool_call"; name: string; action: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "token"; text: string }
  | {
      type: "final";
      text: string;
      tool_calls: ChatToolCall[];
      metadata: ChatResponse["metadata"];
    }
  | { type: "error"; detail: string };

// POST the conversation and parse the SSE stream, invoking `onEvent` for each
// event as it arrives. EventSource only supports GET, so we stream the fetch
// body and split on SSE `data:` frames ourselves.
export async function chatAgentStream(
  messages: ChatTurn[],
  onEvent: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!isAgentConfigured()) {
    throw new Error(
      "Agent not configured (set NEXT_PUBLIC_DEVICE_URL + NEXT_PUBLIC_DEVICE_API_KEY).",
    );
  }
  const r = await fetch(`${baseUrl}/api/agent/chat/stream`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!r.ok || !r.body) {
    const detail = await safeError(r);
    throw new Error(`agent stream failed (${r.status}): ${detail}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as ChatStreamEvent);
      } catch {
        // ignore malformed frame
      }
    }
  }
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

// ──────────────────── intake honesty (single-event forensic) ────────────────

export type DeceptionRisk = "low" | "moderate" | "high";

/** Subset of the dashboard IntakeState the honesty analysis reads, plus
 *  optional patient/medication context. Structural to avoid coupling to
 *  device.ts. */
export type IntakeAnalysisSnapshot = {
  result?: "passed" | "timeout" | "missing_labels" | null;
  confidence?: number;
  hold_progress?: number;
  mediapipe_complete?: boolean;
  labels_seen?: string[];
  labels_required?: string[];
  labels_satisfied?: boolean;
  history?: { step_index: number; step_name: string; passed_at: number }[];
  started_at?: number | null;
  ended_at?: number | null;
  patient_name?: string | null;
  medication?: string | null;
  slot?: number | null;
};

export type IntakeAnalysis = {
  content_markdown: string;
  deception_risk: DeceptionRisk;
  verdict: string;
  signals: Record<string, unknown>;
  metadata: { model: string; latency_ms: number; used_llm: boolean };
};

const VERDICT_LINE: Record<DeceptionRisk, string> = {
  low: "Consistent with a genuine swallow — channels corroborate.",
  moderate: "Inconclusive — at least one verification channel is missing.",
  high: "Raises concern for feigned intake — motor gesture without object evidence.",
};

/** Client-side mirror of the backend `_intake_deception_signals` banding, so the
 *  demo / offline path produces the same grounded report without the Pi. */
function localIntakeAnalysis(snap: IntakeAnalysisSnapshot): IntakeAnalysis {
  const motor = Boolean(snap.mediapipe_complete);
  const objectEvidence = Boolean(snap.labels_satisfied);
  const confidence = snap.confidence ?? 0;
  const labelsSeen = snap.labels_seen ?? [];

  const started = snap.started_at ?? null;
  const ended = snap.ended_at ?? null;
  const durationS =
    started !== null && ended !== null ? Math.round((ended - started) * 10) / 10 : null;

  const gaps: number[] = [];
  let prev = started;
  for (const h of snap.history ?? []) {
    if (h.passed_at != null && prev != null) {
      gaps.push(Math.round((h.passed_at - prev) * 10) / 10);
    }
    prev = h.passed_at ?? prev;
  }
  const maxGap = gaps.length ? Math.max(...gaps) : null;

  let risk: DeceptionRisk;
  if (motor && !objectEvidence) risk = "high";
  else if (snap.result === "passed" && objectEvidence && confidence >= 0.65) risk = "low";
  else if (snap.result === "timeout" || (!motor && !objectEvidence)) risk = "moderate";
  else risk = "moderate";
  if (risk === "low" && maxGap !== null && maxGap >= 8) risk = "moderate";

  const seen = labelsSeen.join(", ") || "none";
  const content_markdown =
    "## Intake honesty assessment\n\n" +
    `**${VERDICT_LINE[risk]}**\n\n` +
    "### Channel corroboration\n" +
    `- Motor sequence: ${motor ? "completed" : "not completed"} ` +
    `(swallow confidence ${Math.round(confidence * 100)}%).\n` +
    `- Object evidence: ${objectEvidence ? "present" : "absent"} (labels seen: ${seen}).\n` +
    `- Timing: ${durationS ?? "—"}s total` +
    `${maxGap !== null ? `, longest inter-step stall ${maxGap}s` : ""}.\n\n` +
    "### Reasoning\n" +
    "- Multi-channel corroboration: a completed motor sequence without object " +
    "evidence is a procedural-without-object (mimed) pattern; full corroboration " +
    "is consistent with honest intake.\n\n" +
    "### Recommended action for staff\n" +
    (risk !== "low"
      ? "- Do a direct visual mouth check before the patient leaves.\n"
      : "- No action — intake corroborated across channels.\n");

  return {
    content_markdown,
    deception_risk: risk,
    verdict: VERDICT_LINE[risk],
    signals: {
      result: snap.result ?? null,
      motor_sequence_complete: motor,
      object_evidence_seen: objectEvidence,
      labels_seen: labelsSeen,
      swallow_confidence: Math.round(confidence * 1000) / 1000,
      duration_s: durationS,
      max_inter_step_gap_s: maxGap,
      deception_risk: risk,
    },
    metadata: { model: "deterministic-local", latency_ms: 0, used_llm: false },
  };
}

/** Cognitive-science honesty assessment for ONE intake round. Posts the snapshot
 *  to the Pi's LLM endpoint; falls back to a local deterministic report when the
 *  agent isn't configured (demo) or the call fails. */
export async function analyzeIntake(
  snapshot: IntakeAnalysisSnapshot,
): Promise<IntakeAnalysis> {
  if (!isAgentConfigured()) return localIntakeAnalysis(snapshot);
  try {
    const r = await fetch(`${baseUrl}/api/agent/intake-analysis`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(snapshot),
    });
    if (!r.ok) throw new Error(await safeError(r));
    return (await r.json()) as IntakeAnalysis;
  } catch (err) {
    console.warn("[agent] intake-analysis fell back to local:", err);
    return localIntakeAnalysis(snapshot);
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

// ──────────────────────────── flags ──────────────────────────────────────

export type AgentFlagStatus = "open" | "acked" | "resolved" | "dismissed";
export type AgentFlagKind =
  | "missed_streak"
  | "low_confidence"
  | "trending_empty"
  | "notable_pattern";
export type AgentFlagSeverity = "info" | "warning" | "critical";

export type AgentFlag = {
  id: number;
  kind: AgentFlagKind;
  severity: AgentFlagSeverity;
  status: AgentFlagStatus;
  title: string;
  detail: string | null;
  patient_id: number | null;
  dispenser_id: string | null;
  slot: number | null;
  fingerprint: string | null;
  payload: Record<string, unknown>;
  detected_by: "heuristic" | "gemini";
  created_at: string;
  acked_at: string | null;
  resolved_at: string | null;
  resolved_by_user: string | null;
  resolution_note: string | null;
};

export async function fetchOpenFlags(limit = 25): Promise<AgentFlag[]> {
  if (!isAgentConfigured()) return [];
  try {
    const r = await fetch(
      `${baseUrl}/api/agent/flags/?status=open&limit=${limit}`,
      { headers: authHeaders(), cache: "no-store" },
    );
    if (!r.ok) return [];
    return (await r.json()) as AgentFlag[];
  } catch {
    return [];
  }
}

async function flagTransition(
  id: number,
  action: "ack" | "resolve" | "dismiss",
  body?: { note?: string | null; resolved_by?: string | null },
): Promise<AgentFlag> {
  if (!isAgentConfigured()) {
    throw new Error("Agent not configured.");
  }
  const r = await fetch(`${baseUrl}/api/agent/flags/${id}/${action}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: action === "ack" ? undefined : JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const detail = await safeError(r);
    throw new Error(`flag ${action} failed (${r.status}): ${detail}`);
  }
  return (await r.json()) as AgentFlag;
}

export function ackFlag(id: number): Promise<AgentFlag> {
  return flagTransition(id, "ack");
}

export function resolveFlag(
  id: number,
  note?: string,
  resolvedBy?: string,
): Promise<AgentFlag> {
  return flagTransition(id, "resolve", {
    note: note?.trim() ? note.trim() : null,
    resolved_by: resolvedBy?.trim() ? resolvedBy.trim() : null,
  });
}

export function dismissFlag(
  id: number,
  note?: string,
  resolvedBy?: string,
): Promise<AgentFlag> {
  return flagTransition(id, "dismiss", {
    note: note?.trim() ? note.trim() : null,
    resolved_by: resolvedBy?.trim() ? resolvedBy.trim() : null,
  });
}

// ─────────────────────────── on-demand flag detection ─────────────────────────

export type FlagDetectionResult = {
  ok: boolean;
  new_count: number;
  by_kind: Record<string, number>;
  gemini_used: boolean;
};

export async function triggerFlagDetection(): Promise<FlagDetectionResult | null> {
  if (!isAgentConfigured()) return null;
  try {
    const r = await fetch(`${baseUrl}/api/agent/flags/detect`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!r.ok) return null;
    return (await r.json()) as FlagDetectionResult;
  } catch {
    return null;
  }
}
