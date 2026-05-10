"use client";

import type { IntakeRecord, SlotInfo } from "@/lib/api";

interface Props {
  logs: IntakeRecord[];
  slots: SlotInfo[];
}

interface Alert {
  id: string;
  type: "missed" | "low_stock" | "empty";
  title: string;
  detail: string;
  time?: string;
}

export default function NeedsAttention({ logs, slots }: Props) {
  const alerts: Alert[] = [];

  // Missed doses
  logs
    .filter((l) => !l.pill_taken)
    .slice(0, 3)
    .forEach((l) => {
      const name = l.patient?.name ?? `Patient ${l.patient_id}`;
      alerts.push({
        id: `missed-${l.id}`,
        type: "missed",
        title: "Missed Dose",
        detail: `${name} · Slot ${l.slot}`,
        time: formatRelative(l.timestamp),
      });
    });

  // Low stock slots
  slots
    .filter((s) => s.name && s.quantity > 0 && s.quantity <= 3)
    .forEach((s) => {
      const pName = s.patient?.name ?? `Patient ${s.patient_id}`;
      alerts.push({
        id: `low-${s.patient_id}-${s.slot}`,
        type: "low_stock",
        title: "Low Stock",
        detail: `${s.name} · ${pName} · Slot ${s.slot} (${s.quantity} left)`,
      });
    });

  // Empty slots that have a medication assigned
  slots
    .filter((s) => s.name && s.quantity === 0)
    .forEach((s) => {
      const pName = s.patient?.name ?? `Patient ${s.patient_id}`;
      alerts.push({
        id: `empty-${s.patient_id}-${s.slot}`,
        type: "empty",
        title: "Out of Stock",
        detail: `${s.name} · ${pName} · Slot ${s.slot}`,
      });
    });

  const ICONS = {
    missed: (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-status-danger-bg">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c4372a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      </div>
    ),
    low_stock: (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-status-warning-bg">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b86e00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
    ),
    empty: (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-status-danger-bg">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c4372a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="9" x2="15" y2="15" />
          <line x1="15" y1="9" x2="9" y2="15" />
        </svg>
      </div>
    ),
  };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Needs Attention</h2>
        {alerts.length > 0 && (
          <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-xs font-semibold text-status-danger">
            {alerts.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
      {alerts.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center py-8 text-center">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-status-success-bg">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2d7a3a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className="text-sm font-medium text-status-success">All clear</p>
          <p className="mt-0.5 text-xs text-gray-400">No issues require attention</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="flex items-start gap-3 rounded-xl bg-sand-50 p-3 transition-colors hover:bg-sand-100"
            >
              {ICONS[alert.type]}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-800">{alert.title}</p>
                <p className="text-xs text-gray-500">{alert.detail}</p>
                {alert.time && (
                  <p className="mt-0.5 text-[11px] text-gray-400">{alert.time}</p>
                )}
              </div>
              <button className="shrink-0 text-gray-300 transition-colors hover:text-gray-500">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="12" cy="5" r="1" />
                  <circle cx="12" cy="19" r="1" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return "Yesterday";
}
