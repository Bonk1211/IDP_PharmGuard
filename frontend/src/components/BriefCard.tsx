"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { refreshBrief } from "@/lib/agent";
import { formatRelative } from "@/lib/date";
import { KEYS, useLatestBrief } from "@/lib/swr";

// Pull a single short headline out of the markdown body so the card has
// a one-line takeaway without rendering the full document. Strips
// markdown markers + collapses whitespace.
function pickHeadline(md: string | undefined): string | null {
  if (!md) return null;
  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const stripped = line
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s*/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .trim();
    if (stripped.length >= 8) return stripped;
  }
  return null;
}

export default function BriefCard() {
  const { data: brief, isLoading } = useLatestBrief();
  const { mutate } = useSWRConfig();
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onRefresh() {
    setRefreshing(true);
    setErr(null);
    try {
      const fresh = await refreshBrief("on_demand");
      await mutate(KEYS.brief, fresh, { revalidate: false });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to refresh brief");
    } finally {
      setRefreshing(false);
    }
  }

  const headline = pickHeadline(brief?.content);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-sand-200 bg-white p-6">
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
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900">Shift brief</h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-gray-400">
            {formatRelative(brief?.generated_at ?? brief?.created_at)}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full bg-olive-500 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-olive-600 disabled:cursor-not-allowed disabled:bg-olive-300"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {err && (
        <p className="mb-3 rounded-xl bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
          {err}
        </p>
      )}

      {/* Body — fills remaining height, scrolls if needed */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && !brief ? (
          <p className="py-6 text-center text-sm text-gray-400">Loading…</p>
        ) : brief ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <CountChip label="Missed" n={brief.metadata.n_missed} tone="danger" />
              <CountChip label="Alerts" n={brief.metadata.n_alerts} tone="warning" />
              <CountChip label="Low stock" n={brief.metadata.n_low_stock} tone="warning" />
            </div>
            {headline && (
              <p className="line-clamp-4 text-xs text-gray-600">{headline}</p>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-sm font-medium text-gray-700">No briefs yet</p>
            <p className="mt-0.5 text-xs text-gray-400">
              Click Refresh to generate one. Scheduled briefs run at the hours
              configured in AGENT_BRIEF_LOCAL_HOURS.
            </p>
          </div>
        )}
      </div>

      {brief && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-sand-100 pt-2 text-[10px] text-gray-400">
          <span className="rounded-full bg-sand-100 px-2 py-0.5 font-mono">
            {brief.metadata.model}
          </span>
          <span>{brief.metadata.latency_ms} ms</span>
        </div>
      )}
    </div>
  );
}

function CountChip({
  label,
  n,
  tone,
}: {
  label: string;
  n: number;
  tone: "danger" | "warning";
}) {
  // Zero counts collapse to the calm "all-clear" colour regardless of
  // the configured tone — colour reflects current state, not category.
  const cls =
    n === 0
      ? "bg-olive-50 text-olive-700"
      : tone === "danger"
      ? "bg-status-danger-bg text-status-danger"
      : "bg-status-warning-bg text-status-warning";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${cls}`}
    >
      <span className="uppercase tracking-wider opacity-75">{label}</span>
      <span className="font-bold tabular-nums">{n}</span>
    </span>
  );
}
