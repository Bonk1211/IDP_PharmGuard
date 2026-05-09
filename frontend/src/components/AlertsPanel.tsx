"use client";

import { useEffect, useState } from "react";
import { fetchAlerts, type Alert, type AlertSeverity } from "@/lib/api";

function describe(alert: Alert): string {
  const p = alert.payload ?? {};
  switch (alert.kind) {
    case "expiry": {
      const med = (p.medication ?? p.name) as string | undefined;
      const exp = p.expiry_date as string | undefined;
      return (
        [med, exp ? `expires ${exp}` : undefined].filter(Boolean).join(" — ") ||
        "Medication expiring soon"
      );
    }
    case "low_stock": {
      const med = (p.medication ?? p.name) as string | undefined;
      const qty = p.quantity as number | undefined;
      return (
        [med, qty != null ? `${qty} left` : undefined].filter(Boolean).join(" — ") ||
        "Stock running low"
      );
    }
    default:
      return String(alert.kind).replace(/_/g, " ");
  }
}

function severityDot(sev: AlertSeverity): string {
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

function severityChip(sev: AlertSeverity): string {
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

export default function AlertsPanel() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlerts()
      .then(setAlerts)
      .finally(() => setLoading(false));
  }, []);

  const unacked = alerts;  // Phase 5 schema has no ack flag yet

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
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900">Alerts</h2>
        </div>
        {unacked.length > 0 && (
          <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-xs font-semibold text-status-danger">
            {unacked.length}
          </span>
        )}
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-gray-400">Loading...</p>
      ) : alerts.length === 0 ? (
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
          <p className="text-sm font-medium text-gray-700">No active alerts</p>
          <p className="mt-0.5 text-xs text-gray-400">
            Alerts feed connects in Phase 5
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.slice(0, 6).map((alert) => (
            <div
              key={alert.id}
              className="flex items-start gap-3 rounded-xl border border-sand-200 bg-white px-3 py-2.5 transition-colors hover:bg-sand-50"
            >
              <span
                className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${severityDot(
                  alert.severity,
                )}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${severityChip(
                      alert.severity,
                    )}`}
                  >
                    {alert.severity}
                  </span>
                  <span className="truncate text-[11px] font-medium text-gray-500">
                    {String(alert.kind).replace(/_/g, " ")}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-800">{describe(alert)}</p>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
                  {alert.dispenser_id && (
                    <span className="rounded-full bg-sand-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                      {alert.dispenser_id}
                    </span>
                  )}
                  <span className="ml-auto">
                    {formatRelative(alert.created_at)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
