"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchPatients, fetchAllSlots, type Patient, type SlotInfo } from "@/lib/api";

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

export default function InventoryPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);

  useEffect(() => {
    fetchPatients().then(setPatients).catch(() => {});
    fetchAllSlots().then(setSlots).catch(() => {});
  }, []);

  return (
    <div>
      <div className="animate-fade-up mb-8">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Inventory Management
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Each patient has a personal 10-slot bedside dispenser
        </p>
      </div>

      <div className="animate-fade-up stagger-1 space-y-4">
        {patients.map((patient) => {
          const patientSlots = slots.filter((s) => s.patient_id === patient.id);
          const filledCount = patientSlots.length;
          const totalQty = patientSlots.reduce((sum, s) => sum + s.quantity, 0);
          const lowCount = patientSlots.filter((s) => s.quantity > 0 && s.quantity <= 3).length;
          const emptyCount = patientSlots.filter((s) => s.quantity === 0).length;

          return (
            <div key={patient.id} className="rounded-2xl border border-sand-200 bg-white p-5">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-olive-100 text-sm font-bold text-olive-700">
                    {getInitials(patient.name)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{patient.name}</p>
                    <p className="text-xs text-gray-400">
                      {patient.condition ?? "—"} · {filledCount}/10 slots · {totalQty} doses total
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {emptyCount > 0 && (
                    <span className="rounded-full bg-status-danger-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-danger">
                      {emptyCount} out of stock
                    </span>
                  )}
                  {lowCount > 0 && (
                    <span className="rounded-full bg-status-warning-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-warning">
                      {lowCount} low stock
                    </span>
                  )}
                  <Link
                    href={`/patients/${patient.id}`}
                    className="rounded-lg border border-sand-200 px-3 py-1.5 text-xs font-medium text-olive-600 transition-colors hover:bg-olive-50"
                  >
                    Manage Slots
                  </Link>
                </div>
              </div>

              {/* Compact slot grid */}
              <div className="grid grid-cols-10 gap-1.5">
                {Array.from({ length: 10 }, (_, i) => {
                  const slot = patientSlots.find((s) => s.slot === i);
                  const isEmpty = !slot;
                  const isLow = slot && slot.quantity > 0 && slot.quantity <= 3;
                  const isOut = slot && slot.quantity === 0;

                  return (
                    <div
                      key={i}
                      className={`rounded-lg border p-2 text-center transition-all ${
                        isEmpty
                          ? "border-dashed border-gray-200 bg-gray-50/50"
                          : isOut
                            ? "border-status-danger/30 bg-status-danger-bg"
                            : isLow
                              ? "border-status-warning/30 bg-status-warning-bg"
                              : "border-olive-200 bg-olive-50"
                      }`}
                    >
                      <div className="text-[9px] font-bold text-gray-400">#{i}</div>
                      {isEmpty ? (
                        <div className="text-[9px] text-gray-300">—</div>
                      ) : (
                        <>
                          <div className="truncate text-[10px] font-medium text-gray-700">{slot.name}</div>
                          <div className={`text-[9px] font-semibold ${
                            isOut ? "text-status-danger" : isLow ? "text-status-warning" : "text-gray-400"
                          }`}>
                            {slot.quantity}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
