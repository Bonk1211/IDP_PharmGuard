"use client";

import { useState } from "react";
import Link from "next/link";
import type { Patient, SlotInfo } from "@/lib/api";

interface Props {
  patients: Patient[];
  slots: SlotInfo[];
}

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

export default function DispenserOverview({ patients, slots }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-olive-50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <h2 className="text-base font-semibold text-gray-900">Bedside Dispensers</h2>
        </div>
        <span className="text-xs text-gray-400">{patients.length} dispensers</span>
      </div>

      <div className="space-y-3">
        {patients.map((patient) => {
          const patientSlots = slots.filter((s) => s.patient_id === patient.id);
          const filledCount = patientSlots.length;
          const lowCount = patientSlots.filter((s) => s.quantity > 0 && s.quantity <= 3).length;
          const emptyCount = patientSlots.filter((s) => s.quantity === 0).length;
          const isExpanded = expanded === patient.id;

          return (
            <div key={patient.id} className="overflow-hidden rounded-xl border border-sand-200 transition-all">
              {/* Dispenser header row */}
              <button
                onClick={() => setExpanded(isExpanded ? null : patient.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-sand-50"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-olive-100 text-xs font-bold text-olive-700">
                  {getInitials(patient.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-800">{patient.name}</p>
                  <p className="text-xs text-gray-400">{patient.condition ?? "—"}</p>
                </div>

                {/* Slot summary bar */}
                <div className="flex items-center gap-2">
                  <div className="flex gap-0.5">
                    {Array.from({ length: 10 }, (_, i) => {
                      const slot = patientSlots.find((s) => s.slot === i);
                      const color = !slot
                        ? "bg-gray-200"
                        : slot.quantity === 0
                          ? "bg-status-danger"
                          : slot.quantity <= 3
                            ? "bg-status-warning"
                            : "bg-status-success";
                      return (
                        <div key={i} className={`h-3 w-1.5 rounded-sm ${color}`} />
                      );
                    })}
                  </div>
                  <span className="text-xs text-gray-400">{filledCount}/10</span>
                </div>

                {/* Alert badges */}
                {(lowCount > 0 || emptyCount > 0) && (
                  <div className="flex gap-1.5">
                    {emptyCount > 0 && (
                      <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-[10px] font-semibold text-status-danger">
                        {emptyCount} empty
                      </span>
                    )}
                    {lowCount > 0 && (
                      <span className="rounded-full bg-status-warning-bg px-2 py-0.5 text-[10px] font-semibold text-status-warning">
                        {lowCount} low
                      </span>
                    )}
                  </div>
                )}

                {/* Chevron */}
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2"
                  className={`shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {/* Expanded: 10-slot grid */}
              {isExpanded && (
                <div className="border-t border-sand-100 bg-sand-50/50 px-4 py-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-500">10-Slot Magazine</span>
                    <Link
                      href={`/patients/${patient.id}`}
                      className="text-xs font-medium text-olive-600 transition-colors hover:text-olive-800"
                    >
                      Manage
                    </Link>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {Array.from({ length: 10 }, (_, i) => {
                      const slot = patientSlots.find((s) => s.slot === i);
                      const isEmpty = !slot;
                      const isLow = slot && slot.quantity > 0 && slot.quantity <= 3;
                      const isOut = slot && slot.quantity === 0;

                      return (
                        <div
                          key={i}
                          className={`rounded-lg border p-2 text-center text-xs transition-all ${
                            isEmpty
                              ? "border-dashed border-gray-200 bg-white/60"
                              : isOut
                                ? "border-status-danger/30 bg-status-danger-bg"
                                : isLow
                                  ? "border-status-warning/30 bg-status-warning-bg"
                                  : "border-olive-200 bg-olive-50"
                          }`}
                        >
                          <div className="mb-0.5 text-[10px] font-bold text-gray-400">#{i}</div>
                          {isEmpty ? (
                            <div className="text-[10px] text-gray-300">—</div>
                          ) : (
                            <>
                              <div className="truncate font-medium text-gray-700">{slot.name}</div>
                              <div className={`text-[10px] font-medium ${
                                isOut ? "text-status-danger" : isLow ? "text-status-warning" : "text-gray-400"
                              }`}>
                                {slot.quantity} left
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
