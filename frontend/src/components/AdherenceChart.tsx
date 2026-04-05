"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchLogs, type IntakeRecord } from "@/lib/api";

export default function AdherenceChart() {
  const [logs, setLogs] = useState<IntakeRecord[]>([]);

  useEffect(() => {
    fetchLogs().then(setLogs);

    // Real-time updates via Supabase Realtime
    const channel = supabase
      .channel("adherence_logs_changes")
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

  if (logs.length === 0) {
    return <p className="text-gray-400">No intake events recorded yet.</p>;
  }

  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <div
          key={log.id}
          className={`flex items-center justify-between rounded-md border p-3 ${
            log.pill_taken
              ? "border-green-200 bg-green-50"
              : "border-red-200 bg-red-50"
          }`}
        >
          <span>
            Patient {log.patient_id} — Slot {log.slot}
          </span>
          <span className="text-sm text-gray-500">
            {new Date(log.timestamp).toLocaleString()}
          </span>
          <span
            className={`font-semibold ${
              log.pill_taken ? "text-green-700" : "text-red-700"
            }`}
          >
            {log.pill_taken ? "Taken" : "Missed"}
          </span>
        </div>
      ))}
    </div>
  );
}
