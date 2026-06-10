"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  fetchPatients,
  fetchAllSlots,
  moveSlot,
  type Patient,
  type SlotInfo,
} from "@/lib/api";
import { useSlotDnd } from "@/lib/useSlotDnd";

function getInitials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

type SlotStatus =
  | "empty"
  | "expired"
  | "out"
  | "low"
  | "expiring"
  | "healthy";

const EXPIRING_DAYS = 14;

/**
 * Decide colour status for one slot.
 * Cascade order: empty -> expired -> out -> low -> expiring-soon -> healthy.
 * (`empty` means there is no medication in this physical slot index at all.)
 */
function statusFor(slot: SlotInfo | undefined): SlotStatus {
  if (!slot) return "empty";

  if (slot.expiry_date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(slot.expiry_date + "T00:00:00");
    const diffDays = Math.floor(
      (exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diffDays < 0) return "expired";
    if (slot.quantity === 0) return "out";
    if (slot.quantity > 0 && slot.quantity <= 3) return "low";
    if (diffDays <= EXPIRING_DAYS) return "expiring";
    return "healthy";
  }

  if (slot.quantity === 0) return "out";
  if (slot.quantity > 0 && slot.quantity <= 3) return "low";
  return "healthy";
}

function statusClasses(status: SlotStatus): string {
  switch (status) {
    case "expired":
    case "out":
      return "border-status-danger/40 bg-status-danger-bg";
    case "low":
      return "border-status-warning/40 bg-status-warning-bg";
    case "expiring":
      return "border-amber-300 bg-amber-50";
    case "healthy":
      return "border-olive-200 bg-olive-50";
    case "empty":
    default:
      return "border-dashed border-gray-200 bg-gray-50/60";
  }
}

function statusDot(status: SlotStatus): string {
  switch (status) {
    case "expired":
    case "out":
      return "bg-status-danger";
    case "low":
      return "bg-status-warning";
    case "expiring":
      return "bg-amber-400";
    case "healthy":
      return "bg-status-success";
    case "empty":
    default:
      return "bg-gray-300";
  }
}

function statusLabel(status: SlotStatus): string {
  switch (status) {
    case "expired":
      return "Expired";
    case "out":
      return "Out";
    case "low":
      return "Low";
    case "expiring":
      return "Expiring";
    case "healthy":
      return "OK";
    case "empty":
    default:
      return "Empty";
  }
}

function tooltip(slot: SlotInfo | undefined, slotNum: number): string {
  if (!slot) return `Slot ${slotNum}: empty`;
  const parts = [
    `Slot ${slotNum}`,
    slot.name ?? "—",
    `${slot.quantity} left`,
  ];
  if (slot.expiry_date) parts.push(`exp ${slot.expiry_date}`);
  if (slot.dispenser_id) parts.push(slot.dispenser_id);
  return parts.join(" · ");
}

export default function InventoryPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);

  useEffect(() => {
    fetchPatients()
      .then(setPatients)
      .catch(() => {});
    fetchAllSlots()
      .then(setSlots)
      .catch(() => {});
  }, []);

  // Pre-bucket patient -> 10-slot array for the heatmap row.
  const heatmapRows = useMemo(() => {
    return patients.map((p) => {
      const patientSlots = slots.filter((s) => s.patient_id === p.id);
      const cells: (SlotInfo | undefined)[] = Array.from(
        { length: 10 },
        (_, i) => patientSlots.find((s) => s.slot === i),
      );
      return { patient: p, cells };
    });
  }, [patients, slots]);

  // Drag-drop slot reassignment within a single patient's dispenser.
  const handleMove = useCallback(
    async (patientId: number, from: number, to: number) => {
      try {
        await moveSlot(patientId, from, to);
        const fresh = await fetchAllSlots();
        setSlots(fresh);
      } catch {
        // mirror the page's silent .catch(() => {}) load convention
      }
    },
    [],
  );
  const { getCellDragProps } = useSlotDnd(handleMove);

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

      {/* All-slots heatmap */}
      <div className="animate-fade-up stagger-1 mb-6 rounded-2xl border border-sand-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              All Slots
            </h2>
            <p className="text-xs text-gray-400">
              {slots.length} slots across {patients.length} dispensers ·
              expiring window {EXPIRING_DAYS} days
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
            {(
              [
                "healthy",
                "expiring",
                "low",
                "out",
                "expired",
                "empty",
              ] as SlotStatus[]
            ).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${statusDot(s)}`}
                />
                {statusLabel(s)}
              </span>
            ))}
          </div>
        </div>

        {heatmapRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">
            No patients enrolled yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <div className="min-w-[560px] space-y-1.5">
            {/* Column header strip */}
            <div className="grid grid-cols-[120px_repeat(10,minmax(0,1fr))] sm:grid-cols-[180px_repeat(10,minmax(0,1fr))] gap-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">
              <span />
              {Array.from({ length: 10 }, (_, i) => (
                <span key={i} className="text-center">
                  #{i}
                </span>
              ))}
            </div>

            {heatmapRows.map(({ patient, cells }) => (
              <div
                key={patient.id}
                className="grid grid-cols-[120px_repeat(10,minmax(0,1fr))] sm:grid-cols-[180px_repeat(10,minmax(0,1fr))] items-center gap-1.5"
              >
                <Link
                  href={`/patients/${patient.id}`}
                  className="flex items-center gap-2 truncate rounded-lg px-1.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-sand-50 hover:text-olive-700"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-olive-100 text-[10px] font-bold text-olive-700">
                    {getInitials(patient.name)}
                  </span>
                  <span className="truncate">{patient.name}</span>
                </Link>
                {cells.map((slot, i) => {
                  const status = statusFor(slot);
                  return (
                    <div
                      key={i}
                      className={`relative h-9 rounded-md border ${statusClasses(
                        status,
                      )} transition-all hover:scale-105 hover:shadow-sm`}
                      title={tooltip(slot, i)}
                    >
                      {slot?.quantity != null && (
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-gray-700">
                          {slot.quantity}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          </div>
        )}
      </div>

      {/* Per-patient detailed cards */}
      <div className="animate-fade-up stagger-2 space-y-4">
        {patients.map((patient) => {
          const patientSlots = slots.filter((s) => s.patient_id === patient.id);
          const filledCount = patientSlots.length;
          const totalQty = patientSlots.reduce((sum, s) => sum + s.quantity, 0);
          const lowCount = patientSlots.filter(
            (s) => s.quantity > 0 && s.quantity <= 3,
          ).length;
          const emptyCount = patientSlots.filter((s) => s.quantity === 0)
            .length;
          const expiringCount = patientSlots.filter(
            (s) => statusFor(s) === "expiring",
          ).length;
          const expiredCount = patientSlots.filter(
            (s) => statusFor(s) === "expired",
          ).length;

          const dispenserId = patientSlots.find((s) => s.dispenser_id)
            ?.dispenser_id;

          return (
            <div
              key={patient.id}
              className="rounded-2xl border border-sand-200 bg-white p-5"
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-olive-100 text-sm font-bold text-olive-700">
                    {getInitials(patient.name)}
                  </div>
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                      {patient.name}
                      {dispenserId && (
                        <span
                          className="rounded-full bg-sand-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500"
                          title={`Dispenser ${dispenserId}`}
                        >
                          {dispenserId}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-400">
                      {patient.condition ?? "—"} · {filledCount}/10 slots ·{" "}
                      {totalQty} doses total
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {expiredCount > 0 && (
                    <span className="rounded-full bg-status-danger-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-danger">
                      {expiredCount} expired
                    </span>
                  )}
                  {emptyCount > 0 && (
                    <span className="rounded-full bg-status-danger-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-danger">
                      {emptyCount} out of stock
                    </span>
                  )}
                  {expiringCount > 0 && (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                      {expiringCount} expiring
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
                  const status = statusFor(slot);

                  return (
                    <div
                      key={i}
                      {...getCellDragProps(patient.id, i, !!slot)}
                      className={`rounded-lg border p-2 text-center transition-all data-[dnd-over=true]:ring-2 data-[dnd-over=true]:ring-olive-400 data-[dnd-dragging=true]:opacity-40 ${statusClasses(
                        status,
                      )}`}
                      title={tooltip(slot, i)}
                    >
                      <div className="text-[9px] font-bold text-gray-400">
                        #{i}
                      </div>
                      {!slot ? (
                        <div className="text-[9px] text-gray-300">—</div>
                      ) : (
                        <>
                          <div className="truncate text-[10px] font-medium text-gray-700">
                            {slot.name}
                          </div>
                          <div
                            className={`text-[9px] font-semibold ${
                              status === "out" || status === "expired"
                                ? "text-status-danger"
                                : status === "low"
                                  ? "text-status-warning"
                                  : status === "expiring"
                                    ? "text-amber-700"
                                    : "text-gray-400"
                            }`}
                          >
                            {slot.quantity}
                            {status === "expiring" && " · soon"}
                            {status === "expired" && " · expired"}
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
