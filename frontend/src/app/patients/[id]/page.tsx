"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { fetchLogs, type IntakeRecord } from "@/lib/api";

// Stub patient data — replace with Supabase queries
const PATIENT_DATA: Record<string, {
  name: string; gender: string; age: number; diagnosis: string;
  status: string; lastVisit: string; conditions: string[];
  contraindications: string[]; allergies: string[];
  medications: { name: string; dosage: string; frequency: string }[];
}> = {
  "1": {
    name: "James Green", gender: "Male", age: 44, diagnosis: "Hypertension",
    status: "Active", lastVisit: "2026-04-05",
    conditions: ["Hypertension (diagnosed 2021)"],
    contraindications: ["ACE inhibitors intolerance"],
    allergies: ["Penicillin"],
    medications: [
      { name: "Amlodipine", dosage: "5 mg", frequency: "once daily" },
      { name: "Lisinopril", dosage: "10 mg", frequency: "once daily" },
    ],
  },
  "2": {
    name: "Lisa Holloway", gender: "Female", age: 23, diagnosis: "Diabetes",
    status: "Under Treatment", lastVisit: "2026-04-04",
    conditions: ["Type 2 Diabetes (diagnosed 2024)"],
    contraindications: ["High sodium sensitivity"],
    allergies: ["Peanuts"],
    medications: [
      { name: "Metformin", dosage: "500 mg", frequency: "twice daily" },
      { name: "Glipizide", dosage: "5 mg", frequency: "once daily" },
    ],
  },
};

function statusStyle(s: string) {
  switch (s) {
    case "Active": return "bg-status-success-bg text-status-success";
    case "At Risk": return "bg-status-danger-bg text-status-danger";
    case "Under Treatment": return "bg-status-warning-bg text-status-warning";
    default: return "bg-gray-100 text-gray-600";
  }
}

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

export default function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [logs, setLogs] = useState<IntakeRecord[]>([]);
  const patient = PATIENT_DATA[id] ?? PATIENT_DATA["1"]!;

  useEffect(() => {
    fetchLogs(Number(id)).then(setLogs).catch(() => {});
  }, [id]);

  const totalLogs = logs.length;
  const takenLogs = logs.filter((l) => l.pill_taken).length;
  const adherence = totalLogs > 0 ? Math.round((takenLogs / totalLogs) * 100) : 100;

  return (
    <div>
      {/* Back link */}
      <Link
        href="/patients"
        className="animate-fade-in mb-4 inline-flex items-center gap-1.5 text-sm text-gray-400 transition-colors hover:text-gray-600"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to Patients
      </Link>

      {/* Patient Card */}
      <div className="animate-fade-up mb-6 overflow-hidden rounded-2xl border border-sand-200 bg-white">
        <div className="flex flex-col gap-6 p-6 md:flex-row">
          {/* Avatar */}
          <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-2xl bg-olive-100 text-4xl font-bold text-olive-700">
            {getInitials(patient.name)}
          </div>

          {/* Info */}
          <div className="flex-1">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-olive-500">
                  ID {String(id).padStart(7, "0")}
                </p>
                <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900">
                  {patient.name}
                </h1>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle(patient.status)}`}>
                {patient.status}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
              <div>
                <p className="text-xs text-gray-400">Gender</p>
                <p className="text-sm font-medium text-gray-800">{patient.gender}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Age</p>
                <p className="text-sm font-medium text-gray-800">{patient.age}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Primary Diagnosis</p>
                <p className="text-sm font-medium text-gray-800">{patient.diagnosis}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Last Visit</p>
                <p className="text-sm font-medium text-gray-800">{patient.lastVisit}</p>
              </div>
            </div>
          </div>

          {/* Adherence ring */}
          <div className="flex flex-col items-center justify-center rounded-2xl border border-sand-200 bg-sand-50 p-5 text-center">
            <p className="mb-2 text-xs font-medium text-gray-400">Adherence</p>
            <div className="relative h-20 w-20">
              <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90">
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke="#e8e4db" strokeWidth="3"
                />
                <path
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  stroke={adherence >= 90 ? "#2d7a3a" : adherence >= 75 ? "#b86e00" : "#c4372a"}
                  strokeWidth="3"
                  strokeDasharray={`${adherence}, 100`}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-lg font-bold text-gray-900">{adherence}%</span>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">{takenLogs}/{totalLogs} doses taken</p>
          </div>
        </div>
      </div>

      {/* Tabs content */}
      <div className="animate-fade-up stagger-2 grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Medical Summary */}
        <div className="rounded-2xl border border-sand-200 bg-white p-6">
          <div className="mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <h2 className="text-base font-semibold text-gray-900">Medical Summary</h2>
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Chronic Conditions</p>
              {patient.conditions.map((c) => (
                <p key={c} className="mt-1 text-sm text-gray-700">{c}</p>
              ))}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Contraindications</p>
              {patient.contraindications.map((c) => (
                <p key={c} className="mt-1 text-sm text-gray-700">{c}</p>
              ))}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Allergies</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {patient.allergies.map((a) => (
                  <span key={a} className="rounded-full bg-status-danger-bg px-2.5 py-0.5 text-xs font-medium text-status-danger">
                    {a}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Current Medications */}
        <div className="rounded-2xl border border-sand-200 bg-white p-6">
          <div className="mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <h2 className="text-base font-semibold text-gray-900">Current Medications</h2>
          </div>

          <table className="w-full">
            <thead>
              <tr className="border-b border-sand-100">
                <th className="pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Medication</th>
                <th className="pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Dosage</th>
                <th className="pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Frequency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sand-100">
              {patient.medications.map((med) => (
                <tr key={med.name} className="group">
                  <td className="py-3 text-sm font-medium text-gray-800">{med.name}</td>
                  <td className="py-3 text-sm text-gray-600">{med.dosage}</td>
                  <td className="py-3 text-sm text-gray-500">{med.frequency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Adherence Timeline */}
        <div className="rounded-2xl border border-sand-200 bg-white p-6">
          <div className="mb-4 flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <h2 className="text-base font-semibold text-gray-900">Intake History</h2>
          </div>

          {logs.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No records yet</p>
          ) : (
            <div className="space-y-2">
              {logs.slice(0, 6).map((log) => (
                <div
                  key={log.id}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                    log.pill_taken ? "bg-status-success-bg/50" : "bg-status-danger-bg/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {log.pill_taken ? (
                      <div className="h-2 w-2 rounded-full bg-status-success" />
                    ) : (
                      <div className="h-2 w-2 rounded-full bg-status-danger" />
                    )}
                    <span className="text-xs font-medium text-gray-700">
                      Slot {log.slot}
                    </span>
                  </div>
                  <span className="text-[11px] text-gray-400">
                    {new Date(log.timestamp).toLocaleString([], {
                      month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
