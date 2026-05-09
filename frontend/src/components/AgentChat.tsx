"use client";

import { useEffect, useRef, useState } from "react";
import { chatAgent, type ChatToolCall, type ChatTurn } from "@/lib/agent";

type Bubble = ChatTurn & {
  toolCalls?: ChatToolCall[];
  truncated?: boolean;
  error?: boolean;
  latencyMs?: number;
};

const SUGGESTED: string[] = [
  "What's happened today?",
  "Any missed doses since this morning?",
  "Show me low-stock medications.",
  "Which patients are at risk?",
];

export default function AgentChat() {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setErr(null);
    const nextHistory: Bubble[] = [
      ...messages,
      { role: "user", text: trimmed },
    ];
    setMessages(nextHistory);
    setDraft("");
    setSending(true);
    try {
      const payload: ChatTurn[] = nextHistory.map(({ role, text }) => ({
        role,
        text,
      }));
      const resp = await chatAgent(payload);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: resp.text,
          toolCalls: resp.tool_calls,
          truncated: resp.metadata.truncated,
          error: resp.metadata.error,
          latencyMs: resp.metadata.latency_ms,
        },
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setSending(false);
    }
  }

  function reset() {
    setMessages([]);
    setErr(null);
  }

  return (
    <div className="flex h-full min-h-[60vh] flex-col rounded-2xl border border-sand-200 bg-white">
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
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              Start with one of these, or type your own question.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-sand-200 bg-sand-50 px-3 py-1.5 text-xs text-gray-700 transition-colors hover:bg-olive-50 hover:text-olive-700"
                >
                  {s}
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
              <p className="whitespace-pre-wrap">{m.text || "(no response)"}</p>
              {m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0 && (
                <details className="mt-2 text-[11px] text-gray-500">
                  <summary className="cursor-pointer select-none">
                    {m.toolCalls!.length} lookup{m.toolCalls!.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {m.toolCalls!.map((tc, j) => (
                      <li key={j} className="font-mono">
                        {tc.name}({summariseArgs(tc.args)}) → {tc.result_summary}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {m.role === "assistant" && (m.truncated || m.error) && (
                <p className="mt-1 text-[11px] text-status-warning">
                  {m.error
                    ? "Reached Gemini error — try again."
                    : "Truncated — narrow the question."}
                </p>
              )}
              {m.role === "assistant" && typeof m.latencyMs === "number" && (
                <p className="mt-1 text-[10px] text-gray-400">
                  {m.latencyMs} ms
                </p>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-sand-50 px-4 py-2.5 text-sm text-gray-500">
              Thinking…
            </div>
          </div>
        )}
      </div>

      {err && (
        <p className="mx-6 mb-2 rounded-xl bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
          {err}
        </p>
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

function summariseArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`)
    .join(", ");
}
