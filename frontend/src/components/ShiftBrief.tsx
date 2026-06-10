"use client";

import Link from "next/link";

type Severity = "critical" | "warning";

type BriefItem = {
  bed: string;
  patientId: number;
  patientName: string;
  issue: string;
  action: string;
  severity: Severity;
  kind: "Low stock" | "Missed dose";
};

// Hardcoded snapshot of the current ward state (mirrors live DB as of
// 10 Jun 2026). Replace with a real query once the brief API settles.
const ITEMS: BriefItem[] = [
  {
    bed: "Bed 1",
    patientId: 13,
    patientName: "Sarah Williams",
    issue: "Chloramine (slot 0) is depleted — 0 pills remaining",
    action: "Refill dispenser-001 slot 0 before the next scheduled dose",
    severity: "critical",
    kind: "Low stock",
  },
  {
    bed: "Bed 1",
    patientId: 13,
    patientName: "Sarah Williams",
    issue: "Missed morning Chloramine dose yesterday (evening dose taken)",
    action: "Check on patient and confirm today's morning intake",
    severity: "warning",
    kind: "Missed dose",
  },
  {
    bed: "Bed 2",
    patientId: 14,
    patientName: "Lisa Holloway",
    issue: "Clarinase (slot 1) is low — 1 pill remaining",
    action: "Restock dispenser-002 slot 1 during this shift",
    severity: "warning",
    kind: "Low stock",
  },
];

const SEVERITY_STYLES: Record<
  Severity,
  { chip: string; border: string; dot: string }
> = {
  critical: {
    chip: "bg-status-danger-bg text-status-danger",
    border: "border-l-4 border-l-red-600",
    dot: "bg-red-600",
  },
  warning: {
    chip: "bg-status-warning-bg text-status-warning",
    border: "border-l-4 border-l-amber-600",
    dot: "bg-amber-600",
  },
};

export default function ShiftBrief() {
  const nCritical = ITEMS.filter((i) => i.severity === "critical").length;

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
        <span className="text-xs text-gray-400">
          {ITEMS.length} action{ITEMS.length === 1 ? "" : "s"} needed ·{" "}
          {nCritical} critical
        </span>
      </div>

      <ul className="space-y-3">
        {ITEMS.map((item, i) => {
          const s = SEVERITY_STYLES[item.severity];
          return (
            <li
              key={i}
              className={`rounded-xl bg-sand-50 p-4 ${s.border}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
                <Link
                  href={`/patients/${item.patientId}`}
                  className="text-sm font-semibold text-gray-900 hover:underline"
                >
                  {item.bed} · {item.patientName}
                </Link>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.chip}`}
                >
                  {item.severity}
                </span>
                <span className="rounded-full bg-sand-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                  {item.kind}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-gray-600">{item.issue}</p>
              <p className="mt-1 text-xs font-medium text-olive-700">
                → {item.action}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
