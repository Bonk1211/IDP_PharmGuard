"use client";

import { useState } from "react";
import Link from "next/link";

// Stub data — replace with Supabase queries
const PATIENTS = [
  { id: 1, name: "James Green", gender: "Male", age: 44, condition: "Hypertension", lastDose: "2026-04-05", status: "Active", adherence: 94, priority: "High" },
  { id: 2, name: "Lisa Holloway", gender: "Female", age: 23, condition: "Diabetes", lastDose: "2026-04-05", status: "Under Treatment", adherence: 87, priority: "Medium" },
  { id: 3, name: "Wanda Johnson", gender: "Female", age: 57, condition: "Asthma", lastDose: "2026-04-04", status: "Active", adherence: 91, priority: "Low" },
  { id: 4, name: "Liam O'Connor", gender: "Male", age: 61, condition: "Heart Disease", lastDose: "2026-04-03", status: "At Risk", adherence: 65, priority: "High" },
  { id: 5, name: "Maya Patel", gender: "Female", age: 29, condition: "Anxiety", lastDose: "2026-04-05", status: "Active", adherence: 98, priority: "Low" },
  { id: 6, name: "Michael Chen", gender: "Male", age: 35, condition: "Hypertension", lastDose: "2026-04-04", status: "Active", adherence: 72, priority: "Medium" },
  { id: 7, name: "Sophia Kim", gender: "Female", age: 36, condition: "Migraines", lastDose: "2026-04-05", status: "Active", adherence: 89, priority: "Low" },
  { id: 8, name: "Sarah Williams", gender: "Female", age: 48, condition: "Heart Disease", lastDose: "2026-04-05", status: "Under Treatment", adherence: 95, priority: "High" },
];

function statusStyle(status: string) {
  switch (status) {
    case "Active":
      return "bg-status-success-bg text-status-success";
    case "At Risk":
      return "bg-status-danger-bg text-status-danger";
    case "Under Treatment":
      return "bg-status-warning-bg text-status-warning";
    default:
      return "bg-gray-100 text-gray-600";
  }
}

function priorityStyle(p: string) {
  switch (p) {
    case "High":
      return "text-status-danger";
    case "Medium":
      return "text-status-warning";
    default:
      return "text-status-success";
  }
}

function adherenceColor(pct: number) {
  if (pct >= 90) return "text-status-success";
  if (pct >= 75) return "text-status-warning";
  return "text-status-danger";
}

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

export default function PatientsPage() {
  const [search, setSearch] = useState("");

  const filtered = PATIENTS.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.condition.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      {/* Header */}
      <div className="animate-fade-up mb-6 flex items-center justify-between">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Patients
        </h1>
        <button className="flex items-center gap-2 rounded-full bg-olive-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-olive-700 hover:shadow-md">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Patient
        </button>
      </div>

      {/* Search + Filters */}
      <div className="animate-fade-up stagger-1 mb-6 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search patients by name or condition..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-sand-200 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-700 outline-none transition-colors placeholder:text-gray-400 focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
          />
        </div>
        <button className="flex items-center gap-2 rounded-xl border border-sand-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-sand-50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          Filters
        </button>
      </div>

      {/* Table */}
      <div className="animate-fade-up stagger-2 overflow-hidden rounded-2xl border border-sand-200 bg-white">
        <table className="w-full">
          <thead>
            <tr className="border-b border-sand-100">
              <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Name</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Gender</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Age</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Condition</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Last Dose</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Status</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Adherence</th>
              <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Priority</th>
              <th className="px-3 py-3.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-100">
            {filtered.map((patient) => (
              <tr
                key={patient.id}
                className="group transition-colors hover:bg-sand-50/50"
              >
                <td className="px-5 py-4">
                  <Link href={`/patients/${patient.id}`} className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-olive-100 text-xs font-bold text-olive-700">
                      {getInitials(patient.name)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900 group-hover:text-olive-700 transition-colors">
                        {patient.name}
                      </p>
                      <p className="text-[11px] text-gray-400">ID {String(patient.id).padStart(7, "0")}</p>
                    </div>
                  </Link>
                </td>
                <td className="px-4 py-4 text-sm text-gray-600">{patient.gender}</td>
                <td className="px-4 py-4 text-sm text-gray-600">{patient.age}</td>
                <td className="px-4 py-4 text-sm text-gray-600">{patient.condition}</td>
                <td className="px-4 py-4 text-sm text-gray-500">{patient.lastDose}</td>
                <td className="px-4 py-4">
                  <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle(patient.status)}`}>
                    {patient.status}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <span className={`text-sm font-semibold ${adherenceColor(patient.adherence)}`}>
                    {patient.adherence}%
                  </span>
                </td>
                <td className="px-4 py-4">
                  <span className={`text-sm font-semibold ${priorityStyle(patient.priority)}`}>
                    {patient.priority}
                  </span>
                </td>
                <td className="px-3 py-4">
                  <button className="rounded-lg p-1 text-gray-300 transition-colors hover:bg-sand-100 hover:text-gray-500">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="1" />
                      <circle cx="12" cy="5" r="1" />
                      <circle cx="12" cy="19" r="1" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-sand-100 px-5 py-3">
          <span className="text-xs text-gray-400">
            Showing {filtered.length} of {PATIENTS.length} patients
          </span>
          <div className="flex items-center gap-1">
            <button className="rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-sand-100">
              &lt;
            </button>
            <button className="rounded-lg bg-olive-700 px-3 py-1.5 text-xs font-medium text-white">
              1
            </button>
            <button className="rounded-lg px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-sand-100">
              &gt;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
