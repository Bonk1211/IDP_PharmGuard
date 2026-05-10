"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import {
  ackFlag,
  dismissFlag,
  resolveFlag,
  type AgentFlag,
  type AgentFlagSeverity,
} from "@/lib/agent";
import { KEYS, useOpenFlags } from "@/lib/swr";

function severityDot(sev: AgentFlagSeverity): string {
  switch (sev) {
    case "critical":
      return "bg-status-danger";
    case "warning":
      return "bg-status-warning";
    case "info":
    default:
      return "bg-olive-500";
  }
}

function severityChip(sev: AgentFlagSeverity): string {
  switch (sev) {
    case "critical":
      return "bg-status-danger-bg text-status-danger";
    case "warning":
      return "bg-status-warning-bg text-status-warning";
    case "info":
    default:
      return "bg-olive-50 text-olive-700";
  }
}

function formatRelative(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 2 * 86_400_000) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function FlagsPanel() {
  const { data: flags = [], isLoading } = useOpenFlags();
  const { mutate } = useSWRConfig();
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [resolvedByDraft, setResolvedByDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function markPending(id: number, on: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function transition(id: number, fn: () => Promise<unknown>, errMsg: string) {
    setErr(null);
    markPending(id, true);
    try {
      await mutate(
        KEYS.flags,
        async () => {
          await fn();
          return (flags as AgentFlag[]).filter((f) => f.id !== id);
        },
        {
          optimisticData: (current: AgentFlag[] | undefined) =>
            (current ?? []).filter((f) => f.id !== id),
          rollbackOnError: true,
          revalidate: true,
          populateCache: true,
        },
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : errMsg);
    } finally {
      markPending(id, false);
    }
  }

  async function onAck(id: number) {
    await transition(id, () => ackFlag(id), "Ack failed");
  }

  async function onResolve(id: number, dismiss: boolean) {
    setExpandedId(null);
    const note = noteDraft;
    const by = resolvedByDraft;
    setNoteDraft("");
    setResolvedByDraft("");
    await transition(
      id,
      () => (dismiss ? dismissFlag(id, note, by) : resolveFlag(id, note, by)),
      "Resolve failed",
    );
  }

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#4a6741"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 21V4a1 1 0 0 1 1-1h11l3 5-3 5H5" />
            <line x1="4" y1="22" x2="4" y2="15" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900">Flags</h2>
        </div>
        {flags.length > 0 && (
          <span className="rounded-full bg-status-warning-bg px-2 py-0.5 text-xs font-semibold text-status-warning">
            {flags.length}
          </span>
        )}
      </div>

      {err && (
        <p className="mb-3 rounded-xl bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
          {err}
        </p>
      )}

      {isLoading && flags.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400">Loading…</p>
      ) : flags.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-olive-50">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#4a6741"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-700">No flags right now</p>
          <p className="mt-0.5 text-xs text-gray-400">
            Detection runs at the brief schedule.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {flags.map((f) => {
            const expanded = expandedId === f.id;
            const isPending = pending.has(f.id);
            return (
              <div
                key={f.id}
                className="rounded-xl border border-sand-200 bg-white px-3 py-2.5 transition-colors hover:bg-sand-50"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${severityDot(f.severity)}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${severityChip(f.severity)}`}
                      >
                        {f.severity}
                      </span>
                      <span className="truncate text-[11px] font-medium text-gray-500">
                        {f.kind.replace(/_/g, " ")}
                      </span>
                      <span className="ml-auto text-[11px] text-gray-400">
                        {formatRelative(f.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-800">{f.title}</p>
                    {f.detail && (
                      <p className="mt-0.5 text-[11px] text-gray-500">
                        {f.detail}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                      {f.detected_by === "gemini" && (
                        <span className="rounded-full bg-sand-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                          gemini
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => onAck(f.id)}
                        disabled={isPending}
                        className="rounded-full border border-sand-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-olive-50 disabled:opacity-50"
                      >
                        Ack
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedId(expanded ? null : f.id);
                          setNoteDraft("");
                          setResolvedByDraft("");
                        }}
                        disabled={isPending}
                        className="rounded-full bg-olive-500 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-olive-600 disabled:bg-olive-300"
                      >
                        {expanded ? "Cancel" : "Resolve…"}
                      </button>
                    </div>

                    {expanded && (
                      <div className="mt-3 space-y-2 border-t border-sand-100 pt-3">
                        <input
                          type="text"
                          value={resolvedByDraft}
                          onChange={(e) => setResolvedByDraft(e.target.value)}
                          placeholder="Your name (optional)"
                          maxLength={80}
                          className="w-full rounded-lg border border-sand-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-olive-500"
                        />
                        <textarea
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          placeholder="What did you do? (optional, max 500 chars)"
                          maxLength={500}
                          rows={2}
                          className="w-full resize-none rounded-lg border border-sand-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-olive-500"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => onResolve(f.id, true)}
                            disabled={isPending}
                            className="rounded-full border border-sand-200 bg-white px-3 py-1 text-[11px] text-gray-700 transition-colors hover:bg-sand-50 disabled:opacity-50"
                          >
                            Dismiss (false alarm)
                          </button>
                          <button
                            type="button"
                            onClick={() => onResolve(f.id, false)}
                            disabled={isPending}
                            className="rounded-full bg-olive-500 px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-olive-600 disabled:bg-olive-300"
                          >
                            Resolve
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
