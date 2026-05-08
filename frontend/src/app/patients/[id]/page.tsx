"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  fetchPatient, fetchLogs, fetchSlotsByPatient, updateSlot, deleteSlot,
  type Patient, type IntakeRecord, type SlotInfo,
} from "@/lib/api";

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
  const pid = Number(id);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [logs, setLogs] = useState<IntakeRecord[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Slot editing
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [slotForm, setSlotForm] = useState({ medication_name: "", quantity: 0 });

  async function loadData() {
    const [p, l, s] = await Promise.all([
      fetchPatient(pid),
      fetchLogs(pid),
      fetchSlotsByPatient(pid),
    ]);
    setPatient(p);
    setLogs(l);
    setSlots(s);
    setLoading(false);
  }

  useEffect(() => {
    loadData().catch(() => setLoading(false));
  }, [id]);

  async function handleSaveSlot(slotNum: number) {
    if (!slotForm.medication_name.trim()) return;
    await updateSlot(pid, slotNum, slotForm);
    setEditingSlot(null);
    await loadData();
  }

  async function handleDeleteSlot(slotNum: number) {
    await deleteSlot(pid, slotNum);
    await loadData();
  }

  if (loading) {
    return <div className="py-20 text-center text-sm text-gray-400">Loading patient...</div>;
  }

  if (!patient) {
    return <div className="py-20 text-center text-sm text-gray-400">Patient not found</div>;
  }

  const totalLogs = logs.length;
  const takenLogs = logs.filter((l) => l.pill_taken).length;
  const adherence = totalLogs > 0 ? Math.round((takenLogs / totalLogs) * 100) : 100;

  // Build 10-slot display
  const displaySlots: (SlotInfo | null)[] = Array.from({ length: 10 }, (_, i) =>
    slots.find((s) => s.slot === i) ?? null
  );

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
          <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-2xl bg-olive-100 text-4xl font-bold text-olive-700">
            {getInitials(patient.name)}
          </div>

          <div className="flex-1">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-olive-500">
                  ID {String(patient.id).padStart(7, "0")}
                </p>
                <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900">
                  {patient.name}
                </h1>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle(patient.status ?? "Active")}`}>
                  {patient.status ?? "Active"}
                </span>
                <Link
                  href={`/patients/${patient.id}/enroll`}
                  className="inline-flex items-center gap-1 rounded-full border border-olive-300 bg-olive-50 px-3 py-1 text-xs font-medium text-olive-700 hover:bg-olive-100"
                >
                  {patient.face_embedding ? "Re-enrol Face" : "Enrol Face"}
                </Link>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
              <div>
                <p className="text-xs text-gray-400">Gender</p>
                <p className="text-sm font-medium text-gray-800">{patient.gender ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Age</p>
                <p className="text-sm font-medium text-gray-800">{patient.age ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Primary Diagnosis</p>
                <p className="text-sm font-medium text-gray-800">{patient.condition ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Meds Loaded</p>
                <p className="text-sm font-medium text-gray-800">{slots.length} / 10 slots</p>
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

      {/* Two-column: Magazine + Info */}
      <div className="animate-fade-up stagger-2 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Magazine — takes 2 columns */}
        <div className="rounded-2xl border border-sand-200 bg-white p-6 lg:col-span-2">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <h2 className="text-base font-semibold text-gray-900">Bedside Dispenser</h2>
            </div>
            <span className="text-xs text-gray-400">10-Slot Magazine</span>
          </div>

          <div className="grid grid-cols-5 gap-3">
            {displaySlots.map((slot, i) => {
              const isEmpty = !slot;
              const isLow = slot && slot.quantity > 0 && slot.quantity <= 3;
              const isOut = slot && slot.quantity === 0;
              const isEditing = editingSlot === i;

              return (
                <div
                  key={i}
                  className={`group relative overflow-hidden rounded-xl border-2 p-3 text-center transition-all duration-200 ${
                    isEditing
                      ? "border-olive-400 bg-white shadow-lg"
                      : isEmpty
                        ? "border-dashed border-gray-200 bg-gray-50/50"
                        : isOut
                          ? "border-status-danger/30 bg-status-danger-bg"
                          : isLow
                            ? "border-status-warning/30 bg-status-warning-bg"
                            : "border-olive-200 bg-olive-50"
                  }`}
                >
                  {/* Slot badge */}
                  <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/5 text-[10px] font-bold text-gray-400">
                    {i}
                  </div>

                  {isEditing ? (
                    <div className="space-y-1.5 py-1 text-left">
                      <input
                        type="text"
                        placeholder="Medication"
                        value={slotForm.medication_name}
                        onChange={(e) => setSlotForm({ ...slotForm, medication_name: e.target.value })}
                        className="w-full rounded-lg border border-sand-200 px-2 py-1 text-xs outline-none focus:border-olive-300"
                      />
                      <input
                        type="number"
                        placeholder="Qty"
                        value={slotForm.quantity}
                        onChange={(e) => setSlotForm({ ...slotForm, quantity: Number(e.target.value) })}
                        className="w-full rounded-lg border border-sand-200 px-2 py-1 text-xs outline-none focus:border-olive-300"
                      />
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleSaveSlot(i)}
                          className="flex-1 rounded-lg bg-olive-600 py-1 text-[10px] font-medium text-white hover:bg-olive-700"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingSlot(null)}
                          className="flex-1 rounded-lg border border-sand-200 py-1 text-[10px] font-medium text-gray-500 hover:bg-sand-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : isEmpty ? (
                    <button
                      onClick={() => {
                        setEditingSlot(i);
                        setSlotForm({ medication_name: "", quantity: 0 });
                      }}
                      className="flex w-full flex-col items-center py-3"
                    >
                      <div className="mx-auto mb-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-gray-300 transition-colors group-hover:border-olive-400">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="2" className="transition-colors group-hover:stroke-olive-500">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      </div>
                      <div className="text-[11px] font-medium text-gray-400 group-hover:text-olive-600">Add Med</div>
                    </button>
                  ) : (
                    <div className="py-1">
                      <div className={`mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-full ${
                        isOut ? "bg-status-danger/15" : isLow ? "bg-status-warning/15" : "bg-white/60"
                      }`}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isOut ? "#c4372a" : isLow ? "#b86e00" : "#4a6741"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m10.5 1.5 3 3L3 15l-1.5-1.5a4.24 4.24 0 0 1 0-6L7.5 1.5a4.24 4.24 0 0 1 6 0z" transform="translate(3, 3) scale(0.85)" />
                        </svg>
                      </div>
                      <div className="truncate text-xs font-semibold text-gray-800">{slot.name}</div>
                      <div className={`mt-0.5 text-[10px] font-medium ${
                        isOut ? "text-status-danger" : isLow ? "text-status-warning" : "text-gray-400"
                      }`}>
                        {slot.quantity} left
                        {isOut && " · Refill!"}
                        {isLow && !isOut && " ⚠"}
                      </div>
                      {/* Edit / Remove on hover */}
                      <div className="mt-1.5 flex justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => {
                            setEditingSlot(i);
                            setSlotForm({ medication_name: slot.name ?? "", quantity: slot.quantity });
                          }}
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-olive-600 hover:bg-olive-100"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteSlot(i)}
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-status-danger hover:bg-status-danger-bg"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right column: Medical Summary + Intake History */}
        <div className="space-y-6">
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
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Condition</p>
                <p className="mt-1 text-sm text-gray-700">{patient.condition ?? "Not specified"}</p>
              </div>
              {patient.contraindications.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Contraindications</p>
                  {patient.contraindications.map((c) => (
                    <p key={c} className="mt-1 text-sm text-gray-700">{c}</p>
                  ))}
                </div>
              )}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Allergies</p>
                {patient.allergies.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {patient.allergies.map((a) => (
                      <span key={a} className="rounded-full bg-status-danger-bg px-2.5 py-0.5 text-xs font-medium text-status-danger">
                        {a}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-gray-400">None reported</p>
                )}
              </div>
            </div>
          </div>

          {/* Intake History */}
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
                {logs.slice(0, 8).map((log) => {
                  const medName = slots.find((s) => s.slot === log.slot)?.name;
                  return (
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
                          {medName ?? `Slot ${log.slot}`}
                        </span>
                        <span className={`text-[11px] font-medium ${log.pill_taken ? "text-status-success" : "text-status-danger"}`}>
                          {log.pill_taken ? "Taken" : "Missed"}
                        </span>
                      </div>
                      <span className="text-[11px] text-gray-400">
                        {new Date(log.timestamp).toLocaleString([], {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
