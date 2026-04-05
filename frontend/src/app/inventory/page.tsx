"use client";

import { useEffect, useState } from "react";
import { fetchSlots, updateSlot, type SlotInfo } from "@/lib/api";

export default function InventoryPage() {
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [form, setForm] = useState({ medication_name: "", quantity: 0, patient_id: 0 });

  useEffect(() => {
    fetchSlots().then(setSlots).catch(() => {});
  }, []);

  const displaySlots = Array.from({ length: 10 }, (_, i) => {
    return slots.find((s) => s.slot === i) ?? null;
  });

  async function handleSave(slot: number) {
    await updateSlot(slot, form);
    setEditing(null);
    fetchSlots().then(setSlots);
  }

  return (
    <div>
      <div className="animate-fade-up mb-8">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Inventory Management
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Manage the 10-slot medication magazine
        </p>
      </div>

      <div className="animate-fade-up stagger-1 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {displaySlots.map((slot, i) => {
          const isEditing = editing === i;
          const isEmpty = !slot || !slot.name;
          const isLow = slot && slot.quantity > 0 && slot.quantity <= 2;

          return (
            <div
              key={i}
              className={`rounded-2xl border-2 p-5 transition-all ${
                isEditing
                  ? "border-olive-400 bg-white shadow-lg"
                  : isEmpty
                    ? "border-dashed border-gray-200 bg-gray-50/50"
                    : isLow
                      ? "border-status-warning/30 bg-status-warning-bg"
                      : "border-sand-200 bg-white"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-500">
                  Slot {i}
                </span>
                {!isEditing && (
                  <button
                    onClick={() => {
                      setEditing(i);
                      setForm({
                        medication_name: slot?.name ?? "",
                        quantity: slot?.quantity ?? 0,
                        patient_id: slot?.patient_id ?? 0,
                      });
                    }}
                    className="text-xs font-medium text-olive-600 hover:text-olive-800"
                  >
                    Edit
                  </button>
                )}
              </div>

              {isEditing ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Medication name"
                    value={form.medication_name}
                    onChange={(e) => setForm({ ...form, medication_name: e.target.value })}
                    className="w-full rounded-lg border border-sand-200 px-3 py-1.5 text-sm outline-none focus:border-olive-300"
                  />
                  <input
                    type="number"
                    placeholder="Quantity"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                    className="w-full rounded-lg border border-sand-200 px-3 py-1.5 text-sm outline-none focus:border-olive-300"
                  />
                  <input
                    type="number"
                    placeholder="Patient ID"
                    value={form.patient_id}
                    onChange={(e) => setForm({ ...form, patient_id: Number(e.target.value) })}
                    className="w-full rounded-lg border border-sand-200 px-3 py-1.5 text-sm outline-none focus:border-olive-300"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(i)}
                      className="flex-1 rounded-lg bg-olive-600 py-1.5 text-xs font-medium text-white hover:bg-olive-700"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="flex-1 rounded-lg border border-sand-200 py-1.5 text-xs font-medium text-gray-500 hover:bg-sand-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : isEmpty ? (
                <div className="py-4 text-center">
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-gray-300">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="2">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </div>
                  <p className="text-xs text-gray-400">No medication assigned</p>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-800">{slot!.name}</p>
                  <p className={`mt-1 text-xs font-medium ${isLow ? "text-status-warning" : "text-gray-400"}`}>
                    {slot!.quantity} remaining {isLow ? "⚠" : ""}
                  </p>
                  {slot!.patient_id && (
                    <p className="mt-0.5 text-[11px] text-gray-400">Patient #{slot!.patient_id}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
