"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import type { IntakeRecord } from "@/lib/api";

interface Props {
  logs: IntakeRecord[];
}

export default function IntakeLog({ logs: initialLogs }: Props) {
  const [logs, setLogs] = useState<IntakeRecord[]>(initialLogs);

  useEffect(() => {
    setLogs(initialLogs);
  }, [initialLogs]);

  useEffect(() => {
    const channel = supabase
      .channel("adherence_realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "adherence_logs" },
        (payload) => {
          setLogs((prev) => [payload.new as IntakeRecord, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-olive-50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <h2 className="text-base font-semibold text-gray-900">Recent Intake Log</h2>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-status-success" style={{ animation: "pulse-dot 2s ease-in-out infinite" }} />
          <span className="text-xs text-gray-400">Live</span>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sand-100">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <p className="text-sm text-gray-400">No intake events recorded yet</p>
          <p className="mt-1 text-xs text-gray-300">Events will appear here in real time</p>
        </div>
      ) : (
        <div className="space-y-2">
          {logs.slice(0, 8).map((log) => {
            const patientName = log.patient?.name;

            return (
              <div
                key={log.id}
                className={`flex items-center justify-between rounded-xl border px-4 py-3 transition-all duration-200 hover:shadow-sm ${
                  log.pill_taken
                    ? "border-status-success/15 bg-status-success-bg/50"
                    : "border-status-danger/15 bg-status-danger-bg/50"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full ${
                      log.pill_taken
                        ? "bg-status-success/10 text-status-success"
                        : "bg-status-danger/10 text-status-danger"
                    }`}
                  >
                    {log.pill_taken ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    )}
                  </div>
                  <div>
                    {patientName ? (
                      <Link
                        href={`/patients/${log.patient_id}`}
                        className="text-sm font-medium text-gray-800 transition-colors hover:text-olive-700"
                      >
                        {patientName}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-gray-800">
                        Patient {log.patient_id}
                      </span>
                    )}
                    <span className="mx-2 text-gray-300">·</span>
                    <span className="text-sm text-gray-500">Slot {log.slot}</span>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-400">
                    {formatTime(log.timestamp)}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      log.pill_taken
                        ? "bg-status-success/10 text-status-success"
                        : "bg-status-danger/10 text-status-danger"
                    }`}
                  >
                    {log.pill_taken ? "✓ Taken" : "✗ Missed"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatTime(ts: string) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
