"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { refreshBrief } from "@/lib/agent";
import { KEYS, useLatestBrief } from "@/lib/swr";

function formatRelative(ts: string | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 2 * 86_400_000) return "Yesterday";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderMarkdown(md: string): { __html: string } {
  // Tiny markdown renderer for headings + bullets + bold. Avoids pulling
  // in a full library for what is a server-curated, trusted payload.
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = escaped
    .replace(/^## (.*)$/gm, '<h3 class="mt-3 text-sm font-semibold text-gray-900">$1</h3>')
    .replace(/^# (.*)$/gm, '<h2 class="mt-3 text-base font-semibold text-gray-900">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>')
    .replace(/^[-*] (.*)$/gm, '<li class="ml-5 list-disc text-sm text-gray-700">$1</li>')
    .replace(/\n{2,}/g, '<br/><br/>');
  return { __html: html };
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

      {isLoading && !brief ? (
        <p className="py-6 text-center text-sm text-gray-400">Loading…</p>
      ) : brief ? (
        <article
          className="prose-sm max-w-none space-y-1 text-sm text-gray-700"
          dangerouslySetInnerHTML={renderMarkdown(brief.content)}
        />
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <p className="text-sm font-medium text-gray-700">No briefs yet</p>
          <p className="mt-0.5 text-xs text-gray-400">
            Click Refresh to generate one. Scheduled briefs run at the hours
            configured in AGENT_BRIEF_LOCAL_HOURS.
          </p>
        </div>
      )}

      {brief && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-sand-100 pt-3 text-[11px] text-gray-500">
          <span className="rounded-full bg-sand-100 px-2 py-0.5 font-mono">
            {brief.metadata.model}
          </span>
          <span>{brief.metadata.latency_ms} ms</span>
          <span>missed: {brief.metadata.n_missed}</span>
          <span>alerts: {brief.metadata.n_alerts}</span>
          <span>low-stock: {brief.metadata.n_low_stock}</span>
        </div>
      )}
    </div>
  );
}
