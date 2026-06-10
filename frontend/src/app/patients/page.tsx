"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchPatients, fetchLogs, createPatient,
  type Patient, type CreatePatientInput,
} from "@/lib/api";

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

function adherenceColor(pct: number) {
  if (pct >= 90) return "text-status-success";
  if (pct >= 75) return "text-status-warning";
  return "text-status-danger";
}

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

interface PatientRow extends Patient {
  adherence: number;
  lastDose: string | null;
}

const EMPTY_FORM: CreatePatientInput = {
  name: "",
  gender: "Male",
  age: 0,
  condition: "",
  status: "Active",
  allergies: [],
  contraindications: [],
};

export default function PatientsPage() {
  const [search, setSearch] = useState("");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<CreatePatientInput>({ ...EMPTY_FORM });
  const [allergyInput, setAllergyInput] = useState("");
  const [contraInput, setContraInput] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadPatients() {
    const [allPatients, allLogs] = await Promise.all([
      fetchPatients(),
      fetchLogs(),
    ]);

    const rows: PatientRow[] = allPatients.map((p) => {
      const pLogs = allLogs.filter((l) => l.patient_id === p.id);
      const taken = pLogs.filter((l) => l.pill_taken).length;
      const total = pLogs.length;
      const lastLog = pLogs.length > 0 ? pLogs[0] : null;

      return {
        ...p,
        adherence: total > 0 ? Math.round((taken / total) * 100) : 100,
        lastDose: lastLog ? lastLog.timestamp : null,
      };
    });

    setPatients(rows);
    setLoading(false);
  }

  useEffect(() => {
    loadPatients().catch(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await createPatient({
        ...form,
        name: form.name.trim(),
        condition: form.condition.trim(),
      });
      setShowModal(false);
      setForm({ ...EMPTY_FORM });
      setAllergyInput("");
      setContraInput("");
      await loadPatients();
    } finally {
      setSaving(false);
    }
  }

  function addAllergy() {
    const val = allergyInput.trim();
    if (val && !form.allergies.includes(val)) {
      setForm({ ...form, allergies: [...form.allergies, val] });
      setAllergyInput("");
    }
  }

  function addContra() {
    const val = contraInput.trim();
    if (val && !form.contraindications.includes(val)) {
      setForm({ ...form, contraindications: [...form.contraindications, val] });
      setContraInput("");
    }
  }

  const filtered = patients.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.condition ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      {/* Header */}
      <div className="animate-fade-up mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Patients
        </h1>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 rounded-full bg-olive-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-olive-700 hover:shadow-md"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Patient
        </button>
      </div>

      {/* Search + Filters */}
      <div className="animate-fade-up stagger-1 mb-6 flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
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
        {loading ? (
          <div className="py-16 text-center text-sm text-gray-400">Loading patients...</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-sand-100">
                <th className="px-5 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Name</th>
                <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Gender</th>
                <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Age</th>
                <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Condition</th>
                <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Last Dose</th>
                <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Status</th>
                <th className="px-4 py-3.5 text-left text-xs font-medium uppercase tracking-wider text-gray-400">Adherence</th>
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
                        <p className="text-sm font-medium text-gray-900 transition-colors group-hover:text-olive-700">
                          {patient.name}
                        </p>
                        <p className="text-[11px] text-gray-400">ID {String(patient.id).padStart(7, "0")}</p>
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-4 text-sm text-gray-600">{patient.gender ?? "—"}</td>
                  <td className="px-4 py-4 text-sm text-gray-600">{patient.age ?? "—"}</td>
                  <td className="px-4 py-4 text-sm text-gray-600">{patient.condition ?? "—"}</td>
                  <td className="px-4 py-4 text-sm text-gray-500">
                    {patient.lastDose
                      ? new Date(patient.lastDose).toLocaleDateString([], { month: "short", day: "numeric" })
                      : "—"}
                  </td>
                  <td className="px-4 py-4">
                    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle(patient.status ?? "Active")}`}>
                      {patient.status ?? "Active"}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`text-sm font-semibold ${adherenceColor(patient.adherence)}`}>
                      {patient.adherence}%
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
          </div>
        )}

        {/* Pagination */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-sand-100 px-5 py-3">
          <span className="text-xs text-gray-400">
            Showing {filtered.length} of {patients.length} patients
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

      {/* New Patient Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
          />

          {/* Modal */}
          <div className="animate-fade-up relative mx-4 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-sand-200 bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-[family-name:var(--font-display)] text-xl text-gray-900">
                New Patient
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-sand-100 hover:text-gray-600"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Name */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Full Name *</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. John Smith"
                  className="w-full rounded-xl border border-sand-200 px-4 py-2.5 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                />
              </div>

              {/* Gender + Age row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Gender</label>
                  <select
                    value={form.gender}
                    onChange={(e) => setForm({ ...form, gender: e.target.value })}
                    className="w-full rounded-xl border border-sand-200 px-4 py-2.5 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Age</label>
                  <input
                    type="number"
                    min={0}
                    max={150}
                    value={form.age || ""}
                    onChange={(e) => setForm({ ...form, age: Number(e.target.value) })}
                    placeholder="e.g. 45"
                    className="w-full rounded-xl border border-sand-200 px-4 py-2.5 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                  />
                </div>
              </div>

              {/* Condition + Status row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Condition</label>
                  <input
                    type="text"
                    value={form.condition}
                    onChange={(e) => setForm({ ...form, condition: e.target.value })}
                    placeholder="e.g. Hypertension"
                    className="w-full rounded-xl border border-sand-200 px-4 py-2.5 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full rounded-xl border border-sand-200 px-4 py-2.5 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                  >
                    <option value="Active">Active</option>
                    <option value="Under Treatment">Under Treatment</option>
                    <option value="At Risk">At Risk</option>
                  </select>
                </div>
              </div>

              {/* Allergies */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Allergies</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={allergyInput}
                    onChange={(e) => setAllergyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAllergy(); } }}
                    placeholder="Type and press Enter"
                    className="flex-1 rounded-xl border border-sand-200 px-4 py-2 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                  />
                  <button
                    type="button"
                    onClick={addAllergy}
                    className="rounded-xl border border-sand-200 px-3 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-sand-50"
                  >
                    Add
                  </button>
                </div>
                {form.allergies.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {form.allergies.map((a) => (
                      <span
                        key={a}
                        className="flex items-center gap-1 rounded-full bg-status-danger-bg px-2.5 py-0.5 text-xs font-medium text-status-danger"
                      >
                        {a}
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, allergies: form.allergies.filter((x) => x !== a) })}
                          className="ml-0.5 hover:text-red-800"
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Contraindications */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Contraindications</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={contraInput}
                    onChange={(e) => setContraInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addContra(); } }}
                    placeholder="Type and press Enter"
                    className="flex-1 rounded-xl border border-sand-200 px-4 py-2 text-sm outline-none transition-colors focus:border-olive-300 focus:ring-2 focus:ring-olive-100"
                  />
                  <button
                    type="button"
                    onClick={addContra}
                    className="rounded-xl border border-sand-200 px-3 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-sand-50"
                  >
                    Add
                  </button>
                </div>
                {form.contraindications.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {form.contraindications.map((c) => (
                      <span
                        key={c}
                        className="flex items-center gap-1 rounded-full bg-status-warning-bg px-2.5 py-0.5 text-xs font-medium text-status-warning"
                      >
                        {c}
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, contraindications: form.contraindications.filter((x) => x !== c) })}
                          className="ml-0.5 hover:text-amber-800"
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-xl border border-sand-200 px-5 py-2.5 text-sm font-medium text-gray-500 transition-colors hover:bg-sand-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.name.trim()}
                  className="rounded-xl bg-olive-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-olive-700 hover:shadow-md disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Add Patient"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
