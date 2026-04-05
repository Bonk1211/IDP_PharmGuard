"use client";

import type { SlotInfo } from "@/lib/api";

interface Props {
  slots: SlotInfo[];
}

export default function PillStatus({ slots }: Props) {
  return (
    <div className="grid grid-cols-5 gap-3">
      {slots.map((slot) => (
        <div
          key={slot.slot}
          className={`rounded-lg border p-4 text-center ${
            slot.quantity > 0
              ? "border-green-300 bg-green-50"
              : "border-gray-200 bg-white"
          }`}
        >
          <div className="text-sm font-medium text-gray-500">
            Slot {slot.slot}
          </div>
          <div className="mt-1 text-lg font-bold">
            {slot.medication_name ?? "Empty"}
          </div>
          <div className="text-sm text-gray-400">Qty: {slot.quantity}</div>
        </div>
      ))}
    </div>
  );
}
