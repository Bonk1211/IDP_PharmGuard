"use client";

import type { SlotInfo } from "@/lib/api";

interface Props {
  slots: SlotInfo[];
}

const SLOT_COLORS = [
  "bg-olive-100 border-olive-300",
  "bg-blue-50 border-blue-200",
  "bg-amber-50 border-amber-200",
  "bg-rose-50 border-rose-200",
  "bg-violet-50 border-violet-200",
  "bg-teal-50 border-teal-200",
  "bg-orange-50 border-orange-200",
  "bg-sky-50 border-sky-200",
  "bg-lime-50 border-lime-200",
  "bg-pink-50 border-pink-200",
];

export default function MagazineStatus({ slots }: Props) {
  // Fill out 10 slots with empty placeholders
  const displaySlots: (SlotInfo | null)[] = Array.from({ length: 10 }, (_, i) => {
    return slots.find((s) => s.slot === i) ?? null;
  });

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
          <h2 className="text-base font-semibold text-gray-900">Magazine Slots</h2>
        </div>
        <span className="text-xs text-gray-400">10-Slot Dispenser</span>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {displaySlots.map((slot, i) => {
          const hasStock = slot && slot.quantity > 0;
          const isEmpty = !slot || !slot.name;
          const isLow = slot && slot.quantity > 0 && slot.quantity <= 2;

          return (
            <div
              key={i}
              className={`group relative overflow-hidden rounded-xl border-2 p-3.5 text-center transition-all duration-200 hover:shadow-md ${
                isEmpty
                  ? "border-dashed border-gray-200 bg-gray-50/50"
                  : isLow
                    ? "border-status-warning/40 bg-status-warning-bg"
                    : hasStock
                      ? SLOT_COLORS[i % SLOT_COLORS.length]
                      : "border-status-danger/30 bg-status-danger-bg"
              }`}
            >
              {/* Slot number badge */}
              <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/5 text-[10px] font-bold text-gray-400">
                {i}
              </div>

              {isEmpty ? (
                <div className="py-2">
                  <div className="mx-auto mb-1 h-8 w-8 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="2">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </div>
                  <div className="text-[11px] font-medium text-gray-400">Empty</div>
                </div>
              ) : (
                <div className="py-1">
                  {/* Pill icon */}
                  <div className={`mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full ${
                    isLow ? "bg-status-warning/15" : "bg-white/60"
                  }`}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={isLow ? "#b86e00" : "#4a6741"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m10.5 1.5 3 3L3 15l-1.5-1.5a4.24 4.24 0 0 1 0-6L7.5 1.5a4.24 4.24 0 0 1 6 0z" transform="translate(3, 3) scale(0.85)" />
                    </svg>
                  </div>
                  <div className="truncate text-xs font-semibold text-gray-800">
                    {slot!.name}
                  </div>
                  <div className={`mt-0.5 text-[11px] font-medium ${
                    isLow ? "text-status-warning" : "text-gray-400"
                  }`}>
                    Qty: {slot!.quantity}
                    {isLow && " ⚠"}
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
