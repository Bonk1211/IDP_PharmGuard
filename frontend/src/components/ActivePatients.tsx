"use client";

import { useMemo } from "react";
import Link from "next/link";
import { type Patient } from "@/lib/api";
import { useLogs, usePatients } from "@/lib/swr";

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

function adherenceColor(pct: number) {
  if (pct >= 90) return "text-status-success";
  if (pct >= 75) return "text-status-warning";
  return "text-status-danger";
}

function adherenceBarColor(pct: number) {
  if (pct >= 90) return "bg-status-success";
  if (pct >= 75) return "bg-status-warning";
  return "bg-status-danger";
}

interface PatientWithAdherence extends Patient {
  adherence: number;
}

export default function ActivePatients() {
  const { data: allPatients = [] } = usePatients();
  const { data: allLogs = [] } = useLogs();

  const patients: PatientWithAdherence[] = useMemo(() => {
    const counts = new Map<number, { taken: number; total: number }>();
    for (const l of allLogs) {
      const c = counts.get(l.patient_id) ?? { taken: 0, total: 0 };
      c.total++;
      if (l.pill_taken) c.taken++;
      counts.set(l.patient_id, c);
    }
    return allPatients.map((p) => {
      const c = counts.get(p.id);
      const adherence = c && c.total > 0
        ? Math.round((c.taken / c.total) * 100)
        : 100;
      return { ...p, adherence };
    });
  }, [allPatients, allLogs]);

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900">Active Patients</h2>
        </div>
        <Link
          href="/patients"
          className="text-xs font-medium text-olive-600 transition-colors hover:text-olive-800"
        >
          View All
        </Link>
      </div>

      {patients.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400">Loading...</p>
      ) : (
        <div className="space-y-3">
          {patients.slice(0, 5).map((patient) => (
            <Link
              key={patient.id}
              href={`/patients/${patient.id}`}
              className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-sand-50"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-olive-100 text-xs font-bold text-olive-700">
                {getInitials(patient.name)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-800">{patient.name}</p>
                <p className="text-xs text-gray-400">{patient.condition ?? "—"}</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full ${adherenceBarColor(patient.adherence)}`}
                    style={{ width: `${patient.adherence}%` }}
                  />
                </div>
                <span className={`text-xs font-semibold ${adherenceColor(patient.adherence)}`}>
                  {patient.adherence}%
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
