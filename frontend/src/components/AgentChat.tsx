"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chatAgentStream,
  refreshBrief,
  type ChatToolCall,
  type ChatTurn,
} from "@/lib/agent";
import { usePatients } from "@/lib/swr";

// One step in the live "thinking" trace shown while the assistant works.
type ThinkingStep =
  | { kind: "status"; text: string }
  | { kind: "analysis"; text: string }
  | {
      kind: "tool";
      name: string;
      action: string;
      running: boolean;
      summary?: string;
    };

type Bubble = ChatTurn & {
  toolCalls?: ChatToolCall[];
  thinking?: ThinkingStep[];
  streaming?: boolean;
  truncated?: boolean;
  error?: boolean;
  latencyMs?: number;
};

// Friendly labels for the lookup chips; raw tool names stay visible in the
// expandable details for transparency. Unknown names fall back to raw.
const TOOL_LABELS: Record<string, string> = {
  query_flags: "Open flags",
  today_summary: "Today's summary",
  query_adherence: "Adherence log",
  query_alerts: "Alerts",
  query_medications: "Medications",
  list_patients: "Patients",
  patient_overview: "Patient overview",
  adherence_stats: "Adherence stats",
  query_schedules: "Dose schedule",
  intake_evidence: "Intake evidence",
  generate_brief: "Shift brief",
};

// Suggestion chips: "chat" sends through the tool-calling agent; "brief"
// calls the real /api/agent/brief endpoint so the handover chip returns the
// actual ShiftBrief content, not an improvised summary.
type SuggestionChip = { label: string; kind: "chat" | "brief" };

const STORAGE_KEY = "pharmguard.agent.chat";

function loadStoredMessages(): Bubble[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Bubble[]) : [];
  } catch {
    return [];
  }
}

export default function AgentChat() {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Last user message that failed to send — enables the Retry button.
  const [lastFailed, setLastFailed] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // True once the stored conversation has been restored — gates the
  // empty-state chips so they don't flash before history loads.
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Restore-before-persist latch: don't overwrite storage with the initial
  // empty array before the mount effect has loaded the saved conversation.
  const hydratedRef = useRef(false);

  const { data: patients = [] } = usePatients();

  const suggestions = useMemo<SuggestionChip[]>(() => {
    const chips: SuggestionChip[] = [
      { label: "What needs my attention?", kind: "chat" },
      { label: "What's happened today?", kind: "chat" },
      { label: "Which patients are at risk this week?", kind: "chat" },
      { label: "Who's due in the next 2 hours?", kind: "chat" },
      { label: "Summarize for shift handover", kind: "brief" },
    ];
    if (patients.length > 0) {
      chips.splice(2, 0, {
        label: `How is ${patients[0].name}'s recent pill-taking?`,
        kind: "chat",
      });
    }
    return chips.slice(0, 6);
  }, [patients]);

  // Restore the conversation once on mount (sessionStorage survives
  // navigation within the tab). Initial state stays [] so SSR markup and
  // the first client render match — no hydration mismatch.
  useEffect(() => {
    setMessages(loadStoredMessages());
    hydratedRef.current = true;
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // storage full / disabled — chat still works, just not persisted
    }
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  async function send(text: string, opts?: { resend?: boolean }) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setErr(null);
    // On retry the failed user turn is already in `messages` — reuse the
    // history as-is instead of appending a duplicate bubble.
    const nextHistory: Bubble[] = opts?.resend
      ? messages
      : [...messages, { role: "user", text: trimmed }];
    if (!opts?.resend) {
      setMessages(nextHistory);
      setDraft("");
    }
    setSending(true);
    // Placeholder assistant bubble we mutate as stream events arrive.
    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: "", thinking: [], streaming: true },
    ]);

    // Mutate only the trailing (placeholder) assistant bubble.
    const patchLast = (fn: (b: Bubble) => Bubble) =>
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const copy = [...prev];
        copy[copy.length - 1] = fn({ ...copy[copy.length - 1] });
        return copy;
      });

    try {
      const payload: ChatTurn[] = nextHistory.map(({ role, text }) => ({
        role,
        text,
      }));
      await chatAgentStream(payload, (e) => {
        patchLast((b) => {
          const thinking = [...(b.thinking ?? [])];
          switch (e.type) {
            case "status":
              thinking.push({ kind: "status", text: e.text });
              break;
            case "reasoning":
              // Pre-tool reasoning: log it, and clear the partial answer the
              // tokens streamed (the real answer comes after the tools run).
              if (e.text) thinking.push({ kind: "status", text: e.text });
              b.text = "";
              break;
            case "analysis":
              thinking.push({ kind: "analysis", text: e.text });
              break;
            case "tool_call":
              thinking.push({
                kind: "tool",
                name: e.name,
                action: e.action,
                running: true,
              });
              break;
            case "tool_result":
              for (let k = thinking.length - 1; k >= 0; k--) {
                const s = thinking[k];
                if (s.kind === "tool" && s.name === e.name && s.running) {
                  thinking[k] = { ...s, running: false, summary: e.summary };
                  break;
                }
              }
              break;
            case "token":
              b.text = (b.text ?? "") + e.text;
              break;
            case "final":
              b.text = e.text || b.text;
              b.toolCalls = e.tool_calls;
              b.truncated = e.metadata.truncated;
              b.error = e.metadata.error;
              b.latencyMs = e.metadata.latency_ms;
              b.streaming = false;
              break;
            case "error":
              b.error = true;
              b.text = b.text || "Assistant error — try again.";
              b.streaming = false;
              break;
          }
          // Any still-running tool steps finish once the turn ends.
          if (e.type === "final" || e.type === "error") {
            for (let k = 0; k < thinking.length; k++) {
              const s = thinking[k];
              if (s.kind === "tool" && s.running) {
                thinking[k] = { ...s, running: false };
              }
            }
          }
          b.thinking = thinking;
          return b;
        });
      });
      setLastFailed(null);
    } catch (e) {
      // Drop the placeholder bubble; surface the error + Retry.
      setMessages((prev) =>
        prev.length && prev[prev.length - 1].role === "assistant" && prev[prev.length - 1].streaming
          ? prev.slice(0, -1)
          : prev,
      );
      setErr(e instanceof Error ? e.message : "Chat failed");
      setLastFailed(trimmed);
    } finally {
      setSending(false);
    }
  }

  // The handover chip fetches the REAL shift brief (same generator the
  // dashboard ShiftBrief uses) instead of letting the model improvise one
  // from generic tools. On failure the optimistic user bubble is rolled
  // back so the empty-state chips (and the chip itself) reappear.
  async function sendBrief() {
    if (sending) return;
    setErr(null);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: "Summarize for shift handover" },
    ]);
    setSending(true);
    try {
      const brief = await refreshBrief("on_demand");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: brief.content,
          toolCalls: [
            {
              name: "generate_brief",
              args: { kind: brief.kind },
              result_summary: `${brief.metadata.n_missed} missed · ${brief.metadata.n_alerts} alerts · ${brief.metadata.n_low_stock} low stock`,
            },
          ],
          latencyMs: brief.metadata.latency_ms,
        },
      ]);
      setLastFailed(null);
    } catch (e) {
      setMessages((prev) => prev.slice(0, -1));
      setErr(e instanceof Error ? e.message : "Brief generation failed");
    } finally {
      setSending(false);
    }
  }

  function copyAnswer(idx: number, text: string) {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedIdx(idx);
        setTimeout(() => {
          setCopiedIdx((c) => (c === idx ? null : c));
        }, 1500);
      })
      .catch(() => {});
  }

  function reset() {
    setMessages([]);
    setErr(null);
    setLastFailed(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  return (
    <div className="flex h-full min-h-[60dvh] max-h-[calc(100dvh-12rem)] flex-col rounded-2xl border border-sand-200 bg-white md:min-h-[60vh] md:max-h-none">
      <header className="flex items-center justify-between border-b border-sand-200 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Clinician assistant
          </h2>
          <p className="text-[11px] text-gray-500">
            Ask about adherence, alerts, inventory, or patients. Read-only.
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          disabled={sending || messages.length === 0}
          className="rounded-full border border-sand-200 px-3 py-1 text-xs text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          New conversation
        </button>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-6 py-4"
      >
        {hydrated && messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              Start with one of these, or type your own question.
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => (s.kind === "brief" ? sendBrief() : send(s.label))}
                  className="rounded-full border border-sand-200 bg-sand-50 px-3 py-1.5 text-xs text-gray-700 transition-colors hover:bg-olive-50 hover:text-olive-700"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                m.role === "user"
                  ? "bg-olive-500 text-white"
                  : "bg-sand-50 text-gray-800"
              }`}
            >
              {m.role === "assistant" ? (
                <>
                  {(m.thinking?.length ?? 0) > 0 && (
                    <ThinkingTrace steps={m.thinking!} streaming={m.streaming} />
                  )}
                  {m.text ? (
                    <MarkdownMessage text={m.text} />
                  ) : m.streaming ? (
                    (m.thinking?.length ?? 0) === 0 && (
                      <span className="text-gray-400">Thinking…</span>
                    )
                  ) : (
                    <MarkdownMessage text="(no response)" />
                  )}
                </>
              ) : (
                <p className="whitespace-pre-wrap">{m.text || "(no response)"}</p>
              )}
              {m.role === "assistant" &&
                !m.thinking?.length &&
                (m.toolCalls?.length ?? 0) > 0 && (
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-1">
                      {m.toolCalls!.map((tc, j) => (
                        <span
                          key={j}
                          className="inline-flex items-center gap-1 rounded-full bg-sand-100 px-2 py-0.5 text-[10px] font-medium text-gray-600"
                        >
                          🔎 {TOOL_LABELS[tc.name] ?? tc.name}
                        </span>
                      ))}
                    </div>
                    <details className="mt-1 text-[11px] text-gray-500">
                      <summary className="cursor-pointer select-none">
                        {m.toolCalls!.length} lookup{m.toolCalls!.length === 1 ? "" : "s"} · raw
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {m.toolCalls!.map((tc, j) => (
                          <li key={j} className="font-mono">
                            {tc.name}({summariseArgs(tc.args)}) → {tc.result_summary}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )}
              {m.role === "assistant" && (m.truncated || m.error) && (
                <p className="mt-1 text-[11px] text-status-warning">
                  {m.error
                    ? "Assistant error — try again."
                    : "Truncated — narrow the question."}
                </p>
              )}
              {m.role === "assistant" && (
                <div className="mt-1 flex items-center gap-2">
                  {typeof m.latencyMs === "number" && (
                    <span className="text-[10px] text-gray-400">
                      {m.latencyMs} ms
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => copyAnswer(i, m.text)}
                    className="ml-auto rounded-full px-2 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-sand-100 hover:text-gray-600"
                  >
                    {copiedIdx === i ? "Copied ✓" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

      </div>

      {err && (
        <div className="mx-6 mb-2 flex items-center justify-between gap-3 rounded-xl bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
          <span className="min-w-0">{err}</span>
          {lastFailed && (
            <button
              type="button"
              onClick={() => send(lastFailed, { resend: true })}
              disabled={sending}
              className="shrink-0 rounded-full border border-status-danger bg-white px-3 py-1 font-semibold transition-colors hover:bg-status-danger-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex gap-2 border-t border-sand-200 px-6 py-4"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about today's activity, missed doses, alerts…"
          disabled={sending}
          className="flex-1 rounded-full border border-sand-200 bg-white px-4 py-2 text-sm text-gray-800 outline-none focus:border-olive-500 disabled:bg-sand-50"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="rounded-full bg-olive-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-olive-600 disabled:cursor-not-allowed disabled:bg-olive-300"
        >
          Send
        </button>
      </form>
    </div>
  );
}

// Live "thinking process": status lines + tool calls as they run/complete.
function ThinkingTrace({
  steps,
  streaming,
}: {
  steps: ThinkingStep[];
  streaming?: boolean;
}) {
  return (
    <div className="mb-2 space-y-1 rounded-xl border border-sand-200 bg-white/60 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
        {streaming ? "Thinking…" : "Thought process"}
      </p>
      {steps.map((s, i) => {
        if (s.kind === "status") {
          return (
            <div key={i} className="flex items-center gap-2 text-[11px] text-gray-500">
              <span className="text-gray-300">›</span>
              {s.text}
            </div>
          );
        }
        if (s.kind === "analysis") {
          return (
            <div
              key={i}
              className="flex items-start gap-2 text-[11px] leading-snug text-indigo-700/90"
            >
              <span className="mt-0.5 shrink-0 text-indigo-400" aria-hidden>
                ✦
              </span>
              <span>{s.text}</span>
            </div>
          );
        }
        return (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span aria-hidden>
              {s.running ? (
                <span className="inline-block animate-spin text-olive-500">◐</span>
              ) : (
                <span className="text-status-success">✓</span>
              )}
            </span>
            <span className={s.running ? "text-gray-700" : "text-gray-600"}>
              {s.action}
              {s.running ? "…" : ""}
            </span>
            {s.summary && !s.running && (
              <span className="ml-auto truncate font-mono text-[10px] text-gray-400">
                {s.summary}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...p }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-gray-900" {...p} />,
          h2: ({ node, ...p }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-gray-900" {...p} />,
          h3: ({ node, ...p }) => <h4 className="mb-1 mt-2 text-[13px] font-semibold text-gray-900" {...p} />,
          h4: ({ node, ...p }) => <h4 className="mb-1 mt-2 text-[13px] font-semibold text-gray-900" {...p} />,
          p: ({ node, ...p }) => <p className="my-1.5" {...p} />,
          ul: ({ node, ...p }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4 marker:text-gray-400" {...p} />,
          ol: ({ node, ...p }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4 marker:text-gray-400" {...p} />,
          li: ({ node, ...p }) => <li className="pl-0.5" {...p} />,
          strong: ({ node, ...p }) => <strong className="font-semibold text-gray-900" {...p} />,
          em: ({ node, ...p }) => <em className="italic" {...p} />,
          a: ({ node, ...p }) => (
            <a className="text-olive-700 underline underline-offset-2" target="_blank" rel="noreferrer" {...p} />
          ),
          code: ({ node, ...p }) => (
            <code className="rounded bg-sand-100 px-1 py-0.5 font-mono text-[12px] text-gray-800" {...p} />
          ),
          pre: ({ node, ...p }) => (
            <pre className="my-2 overflow-x-auto rounded-lg bg-sand-100 p-3 font-mono text-[12px] [&>code]:bg-transparent [&>code]:p-0" {...p} />
          ),
          blockquote: ({ node, ...p }) => (
            <blockquote className="my-2 border-l-2 border-sand-300 pl-3 text-gray-600" {...p} />
          ),
          hr: () => <hr className="my-2 border-sand-200" />,
          table: ({ node, ...p }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]" {...p} />
            </div>
          ),
          thead: ({ node, ...p }) => <thead className="border-b border-sand-300 text-left" {...p} />,
          th: ({ node, ...p }) => <th className="px-2 py-1 font-semibold text-gray-900" {...p} />,
          td: ({ node, ...p }) => <td className="border-t border-sand-100 px-2 py-1 align-top" {...p} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function summariseArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)
    .join(", ");
}
