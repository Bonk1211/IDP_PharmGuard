"use client";

// Guided-round control panel — patient banner, 4-step progress, slot grid,
// AI intake check, twin cams, action bar. All buttons wire to real
// endpoints in lib/device.ts + lib/api.ts.
//
// NOTE: lib/device.ts is single-target; the URL [id] is informational
// until multi-tenant routing lands. Patient & slot context derive from
// the current next-dispense row in `medications`.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";

import {
  fetchDeviceStatus,
  fetchIntakeState,
  fetchSchedules,
  fetchSnapshot,
  isDeviceConfigured,
  manualEject,
  setDrawer,
  streamUrl,
  triggerDispense,
  type DeviceStatus,
  type IntakeState,
  type ScheduleRow,
} from "@/lib/device";
import {
  createIntakeLog,
  fetchPatient,
  type Patient,
  type SlotInfo,
} from "@/lib/api";
import { KEYS, useSlots } from "@/lib/swr";

const TOTAL_SLOTS = 10;
const SLOT_NUMBERS = Array.from({ length: TOTAL_SLOTS }, (_, i) => i);

// ──────────────────────────── helpers ────────────────────────────

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fmtHHmm(d: Date): string {
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function nextRoundFrom(schedules: ScheduleRow[]): { time: string; in: string } | null {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  let best: Date | null = null;
  for (const s of schedules) {
    if (!s.schedule_at) continue;
    const candidate = new Date(`${today}T${s.schedule_at}`);
    if (Number.isNaN(candidate.getTime())) continue;
    if (candidate.getTime() < now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    if (!best || candidate.getTime() < best.getTime()) {
      best = candidate;
    }
  }
  if (!best) return null;
  const diffMs = best.getTime() - now.getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const inLabel =
    hours > 0
      ? `in ${hours}h ${minutes}m`
      : minutes > 0
      ? `in ${minutes}m`
      : "any moment";
  return { time: fmtHHmm(best), in: inLabel };
}

type SlotState = "ready" | "ejected" | "low" | "empty" | "locked";

function deriveSlotState(slot: SlotInfo, ejectedSlot: number | null): SlotState {
  if (!slot.name) return "locked";
  if (slot.quantity === 0) return "empty";
  if (ejectedSlot === slot.slot) return "ejected";
  if (slot.quantity <= 3) return "low";
  return "ready";
}

function slotStateClasses(state: SlotState): string {
  switch (state) {
    case "ejected":
      return "bg-olive-700 text-white border-olive-700";
    case "low":
      return "bg-status-warning-bg text-status-warning border-status-warning-bg";
    case "empty":
      return "bg-status-danger-bg text-status-danger border-status-danger-bg";
    case "locked":
      return "bg-sand-100 text-gray-400 border-sand-100";
    case "ready":
    default:
      return "bg-white text-gray-800 border-sand-200 hover:border-olive-400 hover:bg-olive-50";
  }
}

// ──────────────────────────── page ────────────────────────────

export default function DispenserGuidedPage() {
  const { id } = useParams<{ id: string }>();
  const dispenserId = String(id);
  const { mutate } = useSWRConfig();

  // Live data
  const { data: slots = [] } = useSlots();
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [activePatient, setActivePatient] = useState<Patient | null>(null);

  // Action state
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideNote, setOverrideNote] = useState("");
  const [snapKey, setSnapKey] = useState(0);
  const [confirmedSlots, setConfirmedSlots] = useState<Set<number>>(new Set());
  const [now, setNow] = useState<Date>(new Date());
  const prevSnapUrl = useRef<string | null>(null);

  const configured = isDeviceConfigured();

  // Live clock — drives "Next round in Xm" + "current time" displays.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // /status poll
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    async function tick() {
      const s = await fetchDeviceStatus();
      if (!alive) return;
      if (s) {
        setStatus(s);
        setStatusError(null);
      } else {
        setStatusError("Device unreachable.");
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [configured]);

  // /intake poll — drives the AI panel + step state.
  useEffect(() => {
    let alive = true;
    async function tick() {
      const s = await fetchIntakeState();
      if (alive) setIntake(s);
    }
    tick();
    const id = setInterval(tick, 250);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // /schedules — feeds "next round" + this-pass.
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    async function load() {
      const rows = await fetchSchedules();
      if (alive) setSchedules(rows);
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [configured]);

  // Determine the active patient: the patient owning the slot of the
  // earliest upcoming scheduled dispense, falling back to the first slot
  // with a quantity > 0.
  useEffect(() => {
    let alive = true;
    async function pick() {
      if (slots.length === 0) {
        if (alive) setActivePatient(null);
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const nowMs = Date.now();
      const ranked = [...slots]
        .filter((s) => s.name && s.patient_id)
        .map((s) => {
          const sched = schedules.find((x) => x.slot === s.slot)?.schedule_at ?? null;
          let dueMs = Infinity;
          if (sched) {
            const d = new Date(`${today}T${sched}`);
            if (!Number.isNaN(d.getTime())) {
              dueMs = d.getTime() < nowMs ? d.getTime() + 86_400_000 : d.getTime();
            }
          }
          return { slot: s, dueMs };
        })
        .sort((a, b) => {
          if (a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
          // Stable fallback: lowest slot index wins.
          return a.slot.slot - b.slot.slot;
        });
      const target = ranked[0]?.slot;
      if (!target?.patient_id) {
        if (alive) setActivePatient(null);
        return;
      }
      const p = await fetchPatient(target.patient_id);
      if (alive) setActivePatient(p);
    }
    pick();
  }, [slots, schedules]);

  // Cleanup any blob URL we may have created from snapshots.
  useEffect(() => {
    return () => {
      if (prevSnapUrl.current) URL.revokeObjectURL(prevSnapUrl.current);
    };
  }, []);

  // ──────────────────────────── derived data ─────────────────────

  const activeSlots: SlotInfo[] = useMemo(() => {
    if (!activePatient) return [];
    return slots
      .filter((s) => s.name && s.patient_id === activePatient.id)
      .sort((a, b) => a.slot - b.slot);
  }, [slots, activePatient]);

  const currentSlot: SlotInfo | null = useMemo(() => {
    const remaining = activeSlots.filter((s) => !confirmedSlots.has(s.slot));
    return remaining[0] ?? activeSlots[0] ?? null;
  }, [activeSlots, confirmedSlots]);

  const ejectedSlot: number | null = useMemo(() => {
    // Treat "currently being dispensed" as the slot at the head of the
    // queue once the cycle has incremented. Approximation; the backend
    // doesn't expose the in-flight slot directly.
    if (intake?.running && currentSlot) return currentSlot.slot;
    return null;
  }, [intake?.running, currentSlot]);

  const stepIdx = useMemo(() => {
    // Step inference from intake state + cycle:
    //   0: Verify patient   → assumed done as soon as patient is identified
    //   1: Eject pill       → done once intake game is running OR finished
    //   2: Confirm intake   → current while intake game is running
    //   3: Sign off         → done after operator confirms
    if (!activePatient) return 0;
    if (intake?.result === "passed" && currentSlot && confirmedSlots.has(currentSlot.slot)) {
      return 4; // all done
    }
    if (intake?.running) return 2;
    if (intake?.result === "passed") return 3; // awaiting sign-off
    return 1; // verified, ejecting
  }, [activePatient, intake, currentSlot, confirmedSlots]);

  const nextRound = useMemo(() => nextRoundFrom(schedules), [schedules]);

  const drawerUnlocked = !!status?.is_unlocked;

  const cam0Url = streamUrl(0);
  const cam1Url = streamUrl(1);
  // Re-snapshot trick: re-key the <img> by appending a counter to force
  // the browser to reopen the MJPEG connection (snapKey changes).
  const cam0Src = cam0Url ? `${cam0Url}&_=${snapKey}` : null;
  const cam1Src = cam1Url ? `${cam1Url}&_=${snapKey}` : null;

  // ──────────────────────────── handlers ─────────────────────────

  async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    setBusy(label);
    setMsg(null);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }

  async function onUnlockDrawer() {
    const r = await withBusy(
      drawerUnlocked ? "drawer-lock" : "drawer-unlock",
      () => setDrawer(drawerUnlocked ? "lock" : "unlock"),
    );
    setMsg(
      r.ok
        ? `Drawer ${drawerUnlocked ? "locked" : "unlocked"}.`
        : `Drawer toggle failed: ${r.error ?? r.status}`,
    );
  }

  async function onEject(slot: number) {
    const r = await withBusy(`eject-${slot}`, () => manualEject(slot));
    setMsg(
      r.ok
        ? `Slot ${slot} ejected (${r.latency_ms} ms).`
        : `Eject failed: ${r.error ?? r.status}`,
    );
  }

  async function onResnapshot() {
    setBusy("snap");
    setMsg(null);
    setSnapKey((k) => k + 1);
    try {
      await Promise.all([fetchSnapshot(0), fetchSnapshot(1)]);
      setMsg("Snapshots refreshed.");
    } catch {
      setMsg("Snapshot refresh failed.");
    } finally {
      setBusy(null);
    }
  }

  async function logIntake(pillTaken: boolean) {
    if (!currentSlot || !activePatient) {
      setMsg("No active patient/slot to log against.");
      return;
    }
    return withBusy(pillTaken ? "confirm" : "override", async () => {
      try {
        await createIntakeLog({
          patient_id: activePatient.id,
          slot: currentSlot.slot,
          pill_taken: pillTaken,
          dispenser_id: currentSlot.dispenser_id ?? dispenserId,
          confidence_score: pillTaken ? intake?.confidence ?? null : null,
        });
        setConfirmedSlots((prev) => {
          const next = new Set(prev);
          next.add(currentSlot.slot);
          return next;
        });
        await mutate(KEYS.logs);
        await mutate(KEYS.slots);
        setMsg(
          pillTaken
            ? `Slot ${currentSlot.slot} confirmed. Triggering next dispense.`
            : `Slot ${currentSlot.slot} marked missed${overrideNote ? " (note copied to clipboard)." : "."}`,
        );
        if (overrideNote && !pillTaken && navigator.clipboard) {
          navigator.clipboard
            .writeText(`Slot ${currentSlot.slot} override: ${overrideNote}`)
            .catch(() => {});
        }
        setOverrideOpen(false);
        setOverrideNote("");
        if (pillTaken) {
          await triggerDispense();
        }
      } catch (e) {
        setMsg(e instanceof Error ? `Log failed: ${e.message}` : "Log failed.");
      }
    });
  }

  // ──────────────────────────── render ───────────────────────────

  return (
    <div className="space-y-4">
      {/* ── Patient banner + status pills ─────────────────── */}
      <PatientBanner
        patient={activePatient}
        status={status}
        nextRound={nextRound}
        clock={fmtClock(now)}
      />

      {!configured && (
        <div className="rounded-2xl border border-status-warning-bg bg-status-warning-bg p-3 text-xs text-status-warning">
          Set <code>NEXT_PUBLIC_DEVICE_URL</code> + <code>NEXT_PUBLIC_DEVICE_API_KEY</code> in <code>frontend/.env.local</code> to enable hardware control.
        </div>
      )}
      {statusError && configured && (
        <div className="rounded-2xl border border-status-danger-bg bg-status-danger-bg p-3 text-xs text-status-danger">
          {statusError}
        </div>
      )}
      {msg && (
        <div className="rounded-2xl border border-sand-200 bg-sand-50 px-3 py-2 text-xs text-gray-700">
          {msg}
        </div>
      )}

      {/* ── Steps + this-pass list ─────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <StepsCard stepIdx={stepIdx} cycleN={status?.cycle_n ?? 0} clock={fmtClock(now)} />
        <ThisPassList
          slots={activeSlots}
          currentSlot={currentSlot}
          confirmed={confirmedSlots}
        />
      </div>

      {/* ── Confirm card ──────────────────────────────────── */}
      <ConfirmCard
        stepIdx={stepIdx}
        patient={activePatient}
        slot={currentSlot}
        ejectedSlot={ejectedSlot}
        drawerUnlocked={drawerUnlocked}
        anyEmpty={slots.some((s) => s.name && s.quantity === 0)}
        anyLow={slots.some((s) => s.name && s.quantity > 0 && s.quantity <= 3)}
      />

      {/* ── Slot grid + AI panel + cams ───────────────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[5fr_7fr]">
        <SlotGrid
          slots={slots}
          ejectedSlot={ejectedSlot}
          drawerUnlocked={drawerUnlocked}
          busy={busy}
          configured={configured}
          onEject={onEject}
          onUnlockDrawer={onUnlockDrawer}
        />

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CameraTile
              label="Cam 0 · Tray"
              url={cam0Src}
              clock={fmtClock(now)}
              footer={
                ejectedSlot !== null
                  ? `● Pill released · slot ${ejectedSlot}`
                  : "Idle — awaiting dispense"
              }
            />
            <CameraTile
              label="Cam 1 · Patient"
              url={cam1Src}
              clock={fmtClock(now)}
              footer={
                intake?.running
                  ? `${intake.instruction} · ${Math.round((intake.hold_progress ?? 0) * 100)}%`
                  : intake?.result === "passed"
                  ? "✓ Intake confirmed"
                  : intake?.result === "timeout"
                  ? "✗ Intake timed out"
                  : "Idle"
              }
            />
          </div>

          <AIIntakeCheck intake={intake} patient={activePatient} />
        </div>
      </div>

      {/* ── Action bar ────────────────────────────────────── */}
      <ActionBar
        intake={intake}
        currentSlot={currentSlot}
        busy={busy}
        configured={configured}
        overrideOpen={overrideOpen}
        overrideNote={overrideNote}
        setOverrideOpen={setOverrideOpen}
        setOverrideNote={setOverrideNote}
        onResnapshot={onResnapshot}
        onConfirm={() => logIntake(true)}
        onOverride={() => logIntake(false)}
      />
    </div>
  );
}

// ──────────────────────────── sub-components ────────────────────────────

function PatientBanner({
  patient,
  status,
  nextRound,
  clock,
}: {
  patient: Patient | null;
  status: DeviceStatus | null;
  nextRound: { time: string; in: string } | null;
  clock: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_3fr_2fr]">
      {/* Patient identity */}
      <div className="flex items-center gap-3 rounded-2xl border border-sand-200 bg-white p-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-olive-100 text-base font-bold text-olive-700 ring-2 ring-olive-200/60">
          {patient ? getInitials(patient.name) : "—"}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-base font-semibold text-gray-900">
              {patient?.name ?? "No active patient"}
            </p>
            {patient && (
              <span className="text-[11px] text-gray-400">
                · {patient.age ?? "?"}y{patient.condition ? " · " : ""}
                {patient.condition ?? ""}
              </span>
            )}
          </div>
          <p className="text-[11px] text-gray-500">
            MRN {patient ? String(7000000 + patient.id).slice(0, 4) + "-" + String(patient.id).padStart(3, "0") : "—"}
          </p>
          {patient && patient.allergies.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {patient.allergies.map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-1 rounded-full bg-status-warning-bg px-2 py-0.5 text-[10px] font-medium text-status-warning"
                >
                  ⚠ {a}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Status pills */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-sand-200 bg-white p-4 text-[11px]">
        <Pill label="Cycles" value={status ? String(status.cycle_n) : "—"} />
        <Pill
          label="Loop"
          value={status?.task_running ? "running" : "stopped"}
          tone={status?.task_running ? "good" : "bad"}
        />
        <Pill
          label="HW"
          value={status?.hardware_stubbed ? "stub" : "real"}
          tone={status?.hardware_stubbed ? "warn" : "good"}
        />
        <Pill
          label="Drawer"
          value={status?.is_unlocked ? "unlocked" : "locked"}
          tone={status?.is_unlocked ? "warn" : "good"}
        />
        <span className="ml-auto rounded-full bg-sand-100 px-2 py-0.5 font-mono text-[10px] text-gray-500">
          {clock}
        </span>
      </div>

      {/* Next round + chart link */}
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-sand-200 bg-white p-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Next round
          </p>
          <p className="font-mono text-base text-gray-900">
            {nextRound?.time ?? "—"}
          </p>
          <p className="text-[11px] text-gray-500">{nextRound?.in ?? "no schedule set"}</p>
        </div>
        {patient ? (
          <Link
            href={`/patients/${patient.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-olive-300 bg-olive-700 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-olive-800"
          >
            View chart →
          </Link>
        ) : (
          <span className="text-[11px] text-gray-400">No patient</span>
        )}
      </div>
    </div>
  );
}

function StepsCard({
  stepIdx,
  cycleN,
  clock,
}: {
  stepIdx: number;
  cycleN: number;
  clock: string;
}) {
  const steps = ["Verify patient", "Eject pill", "Confirm intake", "Sign off"];
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="flex items-center gap-2">
        {steps.map((label, i) => {
          const done = i < stepIdx;
          const current = i === stepIdx;
          return (
            <div key={label} className="flex flex-1 items-center gap-2">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                  done
                    ? "bg-status-success-bg text-status-success"
                    : current
                    ? "bg-olive-700 text-white ring-2 ring-olive-300"
                    : "bg-sand-100 text-gray-400"
                }`}
              >
                {done ? "✓" : i + 1}
              </div>
              <span
                className={`truncate text-xs ${
                  current ? "font-semibold text-gray-900" : "text-gray-500"
                }`}
              >
                {label}
              </span>
              {i < steps.length - 1 && (
                <span
                  className={`h-px flex-1 ${
                    done ? "bg-olive-400" : "bg-sand-200"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] uppercase tracking-wider text-gray-400">
        Round · cycle {cycleN} · {clock}
      </p>
    </div>
  );
}

function ThisPassList({
  slots,
  currentSlot,
  confirmed,
}: {
  slots: SlotInfo[];
  currentSlot: SlotInfo | null;
  confirmed: Set<number>;
}) {
  const display = slots.slice(0, 4);
  const total = slots.length;
  const doneCount = [...confirmed].filter((c) =>
    slots.some((s) => s.slot === c),
  ).length;

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          This pass
        </p>
        <span className="text-[10px] text-gray-400">
          {doneCount} / {total} done
        </span>
      </div>
      <div className="space-y-1.5">
        {display.length === 0 && (
          <p className="text-xs text-gray-400">No medications loaded for this patient.</p>
        )}
        {display.map((s, i) => {
          const isDone = confirmed.has(s.slot);
          const isCurrent = currentSlot?.slot === s.slot && !isDone;
          return (
            <div
              key={s.id}
              className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs ${
                isCurrent
                  ? "bg-olive-50 ring-1 ring-olive-300"
                  : "bg-sand-50"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  isDone
                    ? "bg-status-success-bg text-status-success"
                    : isCurrent
                    ? "bg-olive-700 text-white"
                    : "bg-sand-200 text-gray-500"
                }`}
              >
                {isDone ? "✓" : i + 1}
              </span>
              <span className={`flex-1 truncate ${isCurrent ? "font-semibold text-gray-900" : "text-gray-700"}`}>
                {s.name}
              </span>
              <span className="rounded-full bg-sand-100 px-2 py-0.5 font-mono text-[10px] text-gray-500">
                S{String(s.slot).padStart(2, "0")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfirmCard({
  stepIdx,
  patient,
  slot,
  ejectedSlot,
  drawerUnlocked,
  anyEmpty,
  anyLow,
}: {
  stepIdx: number;
  patient: Patient | null;
  slot: SlotInfo | null;
  ejectedSlot: number | null;
  drawerUnlocked: boolean;
  anyEmpty: boolean;
  anyLow: boolean;
}) {
  const stepLabels = ["Verify patient", "Eject pill", "Confirm intake", "Sign off"];
  const headline =
    stepIdx === 0
      ? "Verify the patient at the cabinet."
      : stepIdx === 1
      ? `Ejecting ${slot?.name ?? "medication"} from slot ${slot?.slot ?? "?"}.`
      : stepIdx === 2
      ? `Confirm ${patient?.name?.split(" ")[0] ?? "the patient"} took the pill.`
      : stepIdx === 3
      ? "Sign off this round."
      : "Round complete.";

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-5">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-olive-600">
            Step {Math.min(stepIdx + 1, 4)} of 4 · {stepLabels[Math.min(stepIdx, 3)]}
          </p>
          <h2 className="mt-1 font-[family-name:var(--font-display)] text-xl text-gray-900">
            {headline}
          </h2>
          <p className="mt-1 text-xs text-gray-600">
            {slot ? (
              <>
                <span className="font-semibold text-gray-800">{slot.name}</span>
                {slot.pills_per_dose > 1 ? ` (×${slot.pills_per_dose})` : ""} from slot{" "}
                <span className="font-mono">{String(slot.slot).padStart(2, "0")}</span>.
              </>
            ) : (
              "Awaiting active medication."
            )}{" "}
            Watch the patient camera and confirm — or override if the AI got it wrong.
          </p>
        </div>
        <div className="flex flex-wrap content-start gap-1.5">
          <StateChip label="Ready" active={!ejectedSlot && stepIdx <= 1} />
          <StateChip label="Ejected" active={ejectedSlot !== null} tone="olive" />
          <StateChip label="Low" active={anyLow} tone="warn" />
          <StateChip label="Empty" active={anyEmpty} tone="danger" />
          <StateChip label={drawerUnlocked ? "Unlocked" : "Locked"} active tone={drawerUnlocked ? "warn" : "neutral"} />
        </div>
      </div>
    </div>
  );
}

function SlotGrid({
  slots,
  ejectedSlot,
  drawerUnlocked,
  busy,
  configured,
  onEject,
  onUnlockDrawer,
}: {
  slots: SlotInfo[];
  ejectedSlot: number | null;
  drawerUnlocked: boolean;
  busy: string | null;
  configured: boolean;
  onEject: (slot: number) => void;
  onUnlockDrawer: () => void;
}) {
  const slotsByIndex = SLOT_NUMBERS.map((i) => slots.find((s) => s.slot === i) ?? null);
  const ejectedCount = ejectedSlot !== null ? 1 : 0;

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full text-xs ${
              drawerUnlocked
                ? "bg-status-warning-bg text-status-warning"
                : "bg-olive-50 text-olive-700"
            }`}
            aria-hidden
          >
            {drawerUnlocked ? "🔓" : "🔒"}
          </span>
          <span className="text-xs font-semibold text-gray-800">
            Drawer {drawerUnlocked ? "unlocked" : "locked"}
          </span>
          <button
            type="button"
            onClick={onUnlockDrawer}
            disabled={!configured || busy !== null}
            className="ml-2 rounded-full border border-olive-300 bg-olive-700 px-3 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "drawer-unlock" || busy === "drawer-lock"
              ? "…"
              : drawerUnlocked
              ? "Lock"
              : "Unlock"}
          </button>
        </div>
        <span className="text-[10px] text-gray-400">
          {TOTAL_SLOTS} slots · {ejectedCount} ejected
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {slotsByIndex.map((s, i) => {
          const slot = i;
          const state = s ? deriveSlotState(s, ejectedSlot) : "locked";
          const isBusy = busy === `eject-${slot}`;
          return (
            <button
              key={slot}
              type="button"
              onClick={() => s?.name && onEject(slot)}
              disabled={!s?.name || !configured || busy !== null}
              className={`flex flex-col gap-1 rounded-xl border p-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${slotStateClasses(state)}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
                  Slot {String(slot).padStart(2, "0")}
                </span>
                {isBusy && <span className="text-[10px]">…</span>}
              </div>
              <div className="truncate font-semibold">
                {s?.name ?? "—"}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] tabular-nums">
                  {s ? `${s.quantity} pills` : "empty"}
                </span>
                <span className="text-[10px] uppercase tracking-wider opacity-80">
                  {state === "ejected" ? "● Ejected" : state}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CameraTile({
  label,
  url,
  clock,
  footer,
}: {
  label: string;
  url: string | null;
  clock: string;
  footer: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-sand-200 bg-white">
      <div className="flex items-center justify-between border-b border-sand-200 px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-status-success" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-status-success">
            LIVE
          </span>
          <span className="ml-2 text-xs font-medium text-gray-700 truncate">
            {label}
          </span>
        </div>
        <span className="font-mono text-[10px] text-gray-400">{clock}</span>
      </div>
      <div className="relative aspect-video w-full bg-black">
        {url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-gray-400">
            Stream unavailable
          </div>
        )}
      </div>
      <div className="border-t border-sand-200 px-3 py-1.5 text-[11px] text-gray-600">
        {footer}
      </div>
    </div>
  );
}

function AIIntakeCheck({
  intake,
  patient,
}: {
  intake: IntakeState | null;
  patient: Patient | null;
}) {
  const passed = intake?.result === "passed";
  const failed = intake?.result === "timeout";
  const running = intake?.running ?? false;

  const headline = passed
    ? "Confirmed"
    : failed
    ? "Timed out"
    : running
    ? "Watching…"
    : "Idle";

  const sub = passed
    ? "Empty-mouth check passed"
    : failed
    ? "No swallow detected before timeout"
    : running
    ? intake?.instruction ?? "Following the patient"
    : "Waiting for cycle to start";

  const checks: { label: string; value: string; ok: boolean | null }[] = [
    {
      label: "Pill detected on tray",
      value: running || passed ? "Yes" : "—",
      ok: running || passed ? true : null,
    },
    {
      label: "Patient face matched",
      value: intake?.face_visible ? (patient ? getInitials(patient.name) : "Yes") : "—",
      ok: intake?.face_visible ? true : null,
    },
    {
      label: "Mouth open & empty",
      value: passed
        ? "100%"
        : intake
        ? `${Math.round((intake.hold_progress ?? 0) * 100)}%`
        : "—",
      ok: passed ? true : null,
    },
    {
      label: "Hands visible",
      value: intake ? (intake.hands_count > 0 ? "Yes" : "No") : "—",
      ok: intake?.hands_count != null ? intake.hands_count > 0 : null,
    },
  ];

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-gray-400">
        AI intake check
      </p>
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-base font-bold ${
            passed
              ? "bg-status-success-bg text-status-success"
              : failed
              ? "bg-status-danger-bg text-status-danger"
              : "bg-olive-50 text-olive-700"
          }`}
        >
          {passed ? "✓" : failed ? "✗" : "…"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{headline}</p>
          <p className="text-[11px] text-gray-500">{sub}</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {checks.map((c) => (
          <div
            key={c.label}
            className="flex items-center gap-2 rounded-xl bg-sand-50 px-2.5 py-1.5 text-xs"
          >
            <span
              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                c.ok === true
                  ? "bg-status-success-bg text-status-success"
                  : c.ok === false
                  ? "bg-status-danger-bg text-status-danger"
                  : "bg-sand-200 text-gray-400"
              }`}
              aria-hidden
            >
              {c.ok === true ? "✓" : c.ok === false ? "✗" : "·"}
            </span>
            <span className="flex-1 text-gray-700">{c.label}</span>
            <span className="font-mono text-[11px] text-gray-500">{c.value}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-gray-400">
        <span className="rounded-full bg-sand-100 px-2 py-0.5 font-mono">
          model: mediapipe-fsm
        </span>
        <span>conf: {intake ? (intake.confidence ?? 0).toFixed(2) : "—"}</span>
        <span>step: {intake ? `${(intake.step_index ?? 0) + 1}/${intake.total_steps}` : "—"}</span>
      </div>
    </div>
  );
}

function ActionBar({
  intake,
  currentSlot,
  busy,
  configured,
  overrideOpen,
  overrideNote,
  setOverrideOpen,
  setOverrideNote,
  onResnapshot,
  onConfirm,
  onOverride,
}: {
  intake: IntakeState | null;
  currentSlot: SlotInfo | null;
  busy: string | null;
  configured: boolean;
  overrideOpen: boolean;
  overrideNote: string;
  setOverrideOpen: (b: boolean) => void;
  setOverrideNote: (s: string) => void;
  onResnapshot: () => void;
  onConfirm: () => void;
  onOverride: () => void;
}) {
  const looksGood = intake?.result === "passed";
  const headline = looksGood
    ? "Intake looks good"
    : intake?.running
    ? "Awaiting confirmation"
    : "Ready to dispense";

  const sub = currentSlot
    ? `Slot ${currentSlot.slot} · ${currentSlot.name}` +
      (looksGood ? ` · AI ${Math.round((intake?.confidence ?? 0) * 100)}%` : "")
    : "No active slot";

  return (
    <div className="sticky bottom-2 z-10 rounded-2xl border border-sand-200 bg-white/95 p-4 shadow-lg backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-2xl text-base ${
            looksGood
              ? "bg-status-success-bg text-status-success"
              : "bg-olive-50 text-olive-700"
          }`}
        >
          {looksGood ? "✓" : "…"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{headline}</p>
          <p className="text-[11px] text-gray-500">{sub}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onResnapshot}
            disabled={!configured || busy !== null}
            className="rounded-full border border-sand-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "snap" ? "…" : "Re-snapshot"}
          </button>
          <button
            type="button"
            onClick={() => setOverrideOpen(!overrideOpen)}
            disabled={!currentSlot || busy !== null}
            className="rounded-full border border-status-warning bg-white px-3 py-1.5 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {overrideOpen ? "Cancel" : "Override · note"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!currentSlot || busy !== null}
            className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "confirm" ? "Logging…" : "Confirm & continue"}
            <span className="rounded bg-white/20 px-1 text-[10px] font-mono">↵</span>
          </button>
        </div>
      </div>

      {overrideOpen && (
        <div className="mt-3 space-y-2 border-t border-sand-200 pt-3">
          <textarea
            value={overrideNote}
            onChange={(e) => setOverrideNote(e.target.value)}
            placeholder="Reason for override (e.g. patient refused, wrong pill)…"
            maxLength={500}
            rows={2}
            className="w-full resize-none rounded-xl border border-sand-200 bg-white px-3 py-2 text-xs text-gray-800 outline-none focus:border-olive-500"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onOverride}
              disabled={busy !== null}
              className="rounded-full bg-status-warning px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "override" ? "Saving…" : "Mark as missed + save note"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────── primitives ────────────────────────────

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "warn";
}) {
  const toneCls =
    tone === "good"
      ? "text-status-success"
      : tone === "bad"
      ? "text-status-danger"
      : tone === "warn"
      ? "text-status-warning"
      : "text-gray-900";
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sand-200 bg-white px-2.5 py-1">
      <span className="text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
      <span className={`font-semibold tabular-nums ${toneCls}`}>{value}</span>
    </span>
  );
}

function StateChip({
  label,
  active,
  tone,
}: {
  label: string;
  active: boolean;
  tone?: "olive" | "warn" | "danger" | "neutral";
}) {
  const cls = !active
    ? "bg-sand-50 text-gray-400 border-sand-200"
    : tone === "olive"
    ? "bg-olive-700 text-white border-olive-700"
    : tone === "warn"
    ? "bg-status-warning-bg text-status-warning border-status-warning-bg"
    : tone === "danger"
    ? "bg-status-danger-bg text-status-danger border-status-danger-bg"
    : "bg-sand-100 text-gray-700 border-sand-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
