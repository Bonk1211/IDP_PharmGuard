"use client";

// Guided-round control panel — patient banner, 4-step progress, slot grid,
// AI intake check, twin cams, action bar. All buttons wire to real
// endpoints in lib/device.ts + lib/api.ts.
//
// Layout matches the approved mockup: one banner row, two thin inline
// rows (steps + this-pass), a bare confirm header with state legend, a
// 7:3 slot-grid / AI panel row, then a full-width 2-col cams row, then
// the sticky action bar.

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
  verifyPill,
  type DeviceStatus,
  type IntakeState,
  type ScheduleRow,
  type VerifyPillResult,
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

  const { data: slots = [] } = useSlots();
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [activePatient, setActivePatient] = useState<Patient | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideNote, setOverrideNote] = useState("");
  const [snapKey, setSnapKey] = useState(0);
  const [confirmedSlots, setConfirmedSlots] = useState<Set<number>>(new Set());
  const [now, setNow] = useState<Date>(new Date());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [viewIdx, setViewIdx] = useState<number>(0);
  const [lastEjected, setLastEjected] = useState<number | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyPillResult | null>(null);
  const [verifying, setVerifying] = useState<boolean>(false);
  const prevSnapUrl = useRef<string | null>(null);
  const lastStepIdxRef = useRef<number>(-1);

  const configured = isDeviceConfigured();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

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

  // Active patient = owner of earliest-scheduled assigned slot.
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

  useEffect(() => {
    return () => {
      if (prevSnapUrl.current) URL.revokeObjectURL(prevSnapUrl.current);
    };
  }, []);

  const goToStep = (idx: number) => {
    setViewIdx(Math.max(0, Math.min(idx, 4)));
  };

  // ──────────────────────────── derived ─────────────────────

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
    if (intake?.running && currentSlot) return currentSlot.slot;
    return lastEjected;
  }, [intake?.running, currentSlot, lastEjected]);

  // Clear the "just ejected" indicator after 5 s so the slot grid stops
  // pulsing once the operator has had a chance to read it.
  useEffect(() => {
    if (lastEjected === null) return;
    const t = setTimeout(() => setLastEjected(null), 5000);
    return () => clearTimeout(t);
  }, [lastEjected]);

  const drawerUnlocked = !!status?.is_unlocked;

  // 0=Identify 1=Unlock 2=Dispense 3=Verify 4=Log 5=Done
  const stepIdx = useMemo(() => {
    if (!activePatient) return 0;
    if (
      activeSlots.length > 0 &&
      currentSlot &&
      confirmedSlots.has(currentSlot.slot)
    ) {
      return 5;
    }
    if (intake?.result === "passed") return 4;
    if (intake?.running) return 3;
    if (drawerUnlocked) return 2;
    return 1;
  }, [activePatient, intake, currentSlot, confirmedSlots, drawerUnlocked, activeSlots]);

  const nextRound = useMemo(() => nextRoundFrom(schedules), [schedules]);

  // When stepIdx advances, swap the visible card to follow.
  // User can still click a different step to preview — we only auto-swap on
  // a real stepIdx change, not on every render.
  useEffect(() => {
    if (lastStepIdxRef.current === stepIdx) return;
    lastStepIdxRef.current = stepIdx;
    setViewIdx(Math.min(stepIdx, 4));
  }, [stepIdx]);

  // Esc closes the advanced sheet.
  useEffect(() => {
    if (!advancedOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAdvancedOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advancedOpen]);

  const cam0Url = streamUrl(0);
  const cam1Url = streamUrl(1);
  const cam0Src = cam0Url ? `${cam0Url}&_=${snapKey}` : null;
  const cam1Src = cam1Url ? `${cam1Url}&_=${snapKey}` : null;

  const cam0Footer =
    ejectedSlot !== null
      ? `● Pill released · slot ${ejectedSlot}`
      : "Idle — awaiting dispense";

  const cam1Footer = intake?.running
    ? `${intake.instruction} · ${Math.round((intake.hold_progress ?? 0) * 100)}%`
    : intake?.result === "passed"
    ? "✓ Intake confirmed"
    : intake?.result === "timeout"
    ? "✗ Intake timed out"
    : "Idle";

  // ──────────────────────────── handlers ─────────────────────

  async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    setBusy(label);
    setMsg(null);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }

  async function onSetDrawer(action: "lock" | "unlock") {
    const r = await withBusy(`drawer-${action}`, () => setDrawer(action));
    if (r.ok) {
      // Reflect new state immediately so the UI doesn't wait for the
      // 3 s status poll. Prefer device-reported state, else trust the
      // requested action.
      const nextUnlocked =
        typeof r.is_unlocked === "boolean" ? r.is_unlocked : action === "unlock";
      setStatus((s) => (s ? { ...s, is_unlocked: nextUnlocked } : s));
      setMsg(`Drawer ${nextUnlocked ? "unlocked" : "locked"}.`);
    } else {
      setMsg(`Drawer ${action} failed: ${r.error ?? r.status}`);
    }
  }

  async function onEject(slot: number) {
    const r = await withBusy(`eject-${slot}`, () => manualEject(slot));
    if (r.ok) {
      setLastEjected(slot);
      setMsg(`Slot ${slot} ejected (${r.latency_ms} ms). Verifying…`);
      // Kick off pill verification in the background so the eject
      // handler returns immediately. YOLO inference takes ~150-200 ms
      // on the Pi; give the pill a moment to settle on the tray first.
      const expected = slots.find((s) => s.slot === slot)?.name ?? undefined;
      setVerifyResult(null);
      setVerifying(true);
      setTimeout(() => {
        verifyPill(expected)
          .then((vr) => {
            setVerifyResult(vr);
            if (vr.ok && vr.top) {
              setMsg(
                vr.match === true
                  ? `Verified: ${vr.top.class_name} (${Math.round(vr.top.confidence * 100)}% confidence).`
                  : vr.match === false
                  ? `Mismatch: detected ${vr.top.class_name} (${Math.round(vr.top.confidence * 100)}%), expected ${expected}.`
                  : `Detected: ${vr.top.class_name} (${Math.round(vr.top.confidence * 100)}%).`,
              );
            } else {
              setMsg(`Verification failed: ${vr.error ?? "no detection"}.`);
            }
          })
          .finally(() => setVerifying(false));
      }, 600);
    } else {
      setMsg(`Eject failed: ${r.error ?? r.status}`);
    }
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

  // ──────────────────────────── render ───────────────────────

  const canPrev = viewIdx > 0;
  const canNext = viewIdx < 4 && viewIdx < Math.min(stepIdx, 4);

  return (
    <div className="-mx-6 px-6">
      {/* Sticky header: step bar + this-pass strip */}
      <div className="sticky top-0 z-30 -mx-6 border-b border-sand-200 bg-sand-50/85 px-6 pb-2 pt-2 backdrop-blur">
        <StepBar
          stepIdx={stepIdx}
          clock={fmtClock(now)}
          cycleN={status?.cycle_n ?? 0}
          onJump={goToStep}
          viewIdx={viewIdx}
        />
        <div className="mt-2">
          <ThisPassRow
            slots={activeSlots}
            currentSlot={currentSlot}
            confirmed={confirmedSlots}
          />
        </div>
      </div>

      {/* Toasts */}
      <div className="mt-3 space-y-2">
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
      </div>

      {/* Single-card stage area. Each step renders one card; key={viewIdx}
          forces a remount so the slide-in animation replays on switch. */}
      <div className="relative mt-4 overflow-hidden">
        <div
          key={viewIdx}
          className="animate-slide-in-right flex min-h-[calc(100vh-14rem)] flex-col"
        >
          {viewIdx === 0 && (
            <>
              <SectionHeading
                index={1}
                total={5}
                eyebrow="Identify"
                title="Confirm patient at the cabinet."
              />
              <PatientBanner
                patient={activePatient}
                status={status}
                nextRound={nextRound}
                clock={fmtClock(now)}
              />
            </>
          )}
          {viewIdx === 1 && (
            <>
              <SectionHeading
                index={2}
                total={5}
                eyebrow="Unlock"
                title={
                  drawerUnlocked
                    ? "Drawer is unlocked."
                    : "Unlock the drawer to begin."
                }
              />
              <UnlockSection
                drawerUnlocked={drawerUnlocked}
                configured={configured}
                busy={busy}
                onSetDrawer={onSetDrawer}
              />
            </>
          )}
          {viewIdx === 2 && (
            <>
              <SectionHeading
                index={3}
                total={5}
                eyebrow="Dispense"
                title={
                  currentSlot
                    ? `Ejecting ${currentSlot.name} from slot ${currentSlot.slot}.`
                    : "Waiting for active medication."
                }
              />

              <DispenseCTA
                currentSlot={currentSlot}
                drawerUnlocked={drawerUnlocked}
                busy={busy}
                configured={configured}
                onEject={onEject}
                onOpenAdvanced={() => setAdvancedOpen(true)}
              />

              <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[7fr_3fr]">
                <SlotGrid
                  slots={slots}
                  ejectedSlot={ejectedSlot}
                  drawerUnlocked={drawerUnlocked}
                  busy={busy}
                  configured={configured}
                  onEject={onEject}
                />
                <CameraTile
                  label="Cam 0 · Tray"
                  url={cam0Src}
                  clock={fmtClock(now)}
                  footer={cam0Footer}
                />
              </div>

              {(verifying || verifyResult) && (
                <div className="mt-4">
                  <VerifyResultCard
                    result={verifyResult}
                    verifying={verifying}
                    expected={currentSlot?.name ?? null}
                  />
                </div>
              )}
            </>
          )}
          {viewIdx === 3 && (
            <>
              <SectionHeading
                index={4}
                total={5}
                eyebrow="Verify"
                title="AI is watching the patient take the pill."
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[3fr_4fr]">
                <AIIntakeCheck intake={intake} patient={activePatient} />
                <CameraTile
                  label="Cam 1 · Patient"
                  url={cam1Src}
                  clock={fmtClock(now)}
                  footer={cam1Footer}
                />
              </div>
            </>
          )}
          {viewIdx === 4 && (
            <>
              <SectionHeading
                index={5}
                total={5}
                eyebrow="Log"
                title={
                  stepIdx === 5
                    ? "Round complete."
                    : `Confirm ${activePatient?.name?.split(" ")[0] ?? "the patient"} took the pill.`
                }
              />
              <ConfirmHeader patient={activePatient} slot={currentSlot} />
              <div className="mt-4">
                <ActionBar
                  intake={intake}
                  currentSlot={currentSlot}
                  busy={busy}
                  overrideOpen={overrideOpen}
                  overrideNote={overrideNote}
                  setOverrideOpen={setOverrideOpen}
                  setOverrideNote={setOverrideNote}
                  onConfirm={() => logIntake(true)}
                  onOverride={() => logIntake(false)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Prev / Next card nav */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => goToStep(viewIdx - 1)}
          disabled={!canPrev}
          className="inline-flex items-center gap-2 rounded-full border border-sand-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← {viewIdx > 0 ? STEP_LABELS[viewIdx - 1] : "Back"}
        </button>
        <p className="text-[11px] text-gray-400">
          Card {viewIdx + 1} of 5 · Live step {Math.min(stepIdx, 4) + 1}
        </p>
        <button
          type="button"
          onClick={() => goToStep(viewIdx + 1)}
          disabled={!canNext}
          className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {viewIdx < 4 ? STEP_LABELS[viewIdx + 1] : "Done"} →
        </button>
      </div>

      {/* Floating Advanced trigger */}
      <button
        type="button"
        onClick={() => setAdvancedOpen((v) => !v)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 shadow-lg transition-colors hover:bg-sand-50"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-olive-500" aria-hidden />
        Advanced
        <span className="text-gray-400">{advancedOpen ? "▼" : "▲"}</span>
      </button>

      <AdvancedSheet
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        slots={slots}
        ejectedSlot={ejectedSlot}
        drawerUnlocked={drawerUnlocked}
        busy={busy}
        configured={configured}
        cam0Src={cam0Src}
        cam1Src={cam1Src}
        cam0Url={cam0Url}
        cam1Url={cam1Url}
        status={status}
        clock={fmtClock(now)}
        onEject={onEject}
        onSetDrawer={onSetDrawer}
        onResnapshot={onResnapshot}
      />
    </div>
  );
}

// ──────────────────────────── PatientBanner (single row) ────────────────────────────

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
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sand-200 bg-white p-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-olive-100 text-sm font-bold text-olive-700 ring-2 ring-olive-200/60">
          {patient ? getInitials(patient.name) : "—"}
        </div>
        <div className="min-w-0">
          {/* TODO: room/bed columns once schema gains them */}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="truncate text-sm font-semibold text-gray-900">
              {patient?.name ?? "No active patient"}
            </p>
            {patient && (
              <span className="text-[11px] text-gray-400">
                · {patient.age ?? "?"}y{patient.condition ? ` · ${patient.condition}` : ""}
              </span>
            )}
          </div>
          <p className="text-[10px] text-gray-400">
            MRN {patient ? `${String(7000000 + patient.id).slice(0, 4)}-${String(patient.id).padStart(3, "0")}` : "—"}
          </p>
        </div>
      </div>

      {patient && patient.allergies.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {patient.allergies.map((a) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 rounded-full bg-status-danger-bg px-2 py-0.5 text-[10px] font-medium text-status-danger"
            >
              ⚠ {a}
            </span>
          ))}
        </div>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px]">
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
      </div>

      <div className="flex items-center gap-3 border-l border-sand-200 pl-4">
        <div>
          <p className="text-[10px] text-gray-400">Next round</p>
          <p className="font-mono text-sm text-gray-900">
            <span className="font-semibold">{nextRound?.time ?? "—"}</span>
            <span className="ml-2 text-[11px] font-normal text-gray-500">
              {nextRound?.in ?? "no schedule"}
            </span>
          </p>
        </div>
        {patient && (
          <Link
            href={`/patients/${patient.id}`}
            className="rounded-full border border-sand-200 bg-white px-3 py-1.5 text-[11px] font-medium text-gray-700 transition-colors hover:bg-sand-50"
          >
            View chart
          </Link>
        )}
      </div>
      <span className="hidden font-mono text-[10px] text-gray-400 sm:inline">
        {clock}
      </span>
    </div>
  );
}

// ──────────────────────────── ThisPassRow (horizontal chips) ────────────────────────────

function ThisPassRow({
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
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-2.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
        This pass
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {display.length === 0 && (
          <span className="text-xs text-gray-400">No medications loaded.</span>
        )}
        {display.map((s, i) => {
          const isDone = confirmed.has(s.slot);
          const isCurrent = currentSlot?.slot === s.slot && !isDone;
          return (
            <span
              key={s.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                isCurrent
                  ? "bg-olive-50 ring-1 ring-olive-300"
                  : isDone
                  ? "bg-sand-50 text-gray-400"
                  : "bg-sand-50"
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                  isDone
                    ? "bg-status-success-bg text-status-success"
                    : isCurrent
                    ? "bg-olive-700 text-white"
                    : "bg-sand-200 text-gray-500"
                }`}
              >
                {isDone ? "✓" : i + 1}
              </span>
              <span className={isDone ? "line-through" : ""}>
                {s.name}
                {s.pills_per_dose > 1 ? ` ×${s.pills_per_dose}` : ""}
              </span>
              <span className="rounded-full bg-sand-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                S{s.slot}
              </span>
            </span>
          );
        })}
      </div>
      <span className="text-[10px] uppercase tracking-wider text-gray-400">
        {doneCount} / {total} done
      </span>
    </div>
  );
}

// ──────────────────────────── ConfirmHeader (bare) ────────────────────────────

function ConfirmHeader({
  patient,
  slot,
}: {
  patient: Patient | null;
  slot: SlotInfo | null;
}) {
  return (
    <div className="flex flex-col gap-3 px-1 pt-2 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <p className="text-xs text-gray-600">
          {slot ? (
            <>
              <span className="font-semibold text-gray-800">
                {slot.name}
                {slot.pills_per_dose > 1 ? ` ×${slot.pills_per_dose}` : ""}
              </span>{" "}
              from slot{" "}
              <span className="font-mono">{String(slot.slot).padStart(2, "0")}</span>
              {patient ? ` for ${patient.name}` : ""}.
            </>
          ) : (
            "Awaiting active medication."
          )}{" "}
          Watch the patient camera and confirm — or override if the AI got it wrong.
        </p>
      </div>
      <StateLegend />
    </div>
  );
}

function StateLegend() {
  const items: { label: string; cls: string }[] = [
    { label: "Ready",   cls: "bg-status-success" },
    { label: "Ejected", cls: "bg-olive-700" },
    { label: "Low",     cls: "bg-status-warning" },
    { label: "Empty",   cls: "bg-status-danger" },
    { label: "Locked",  cls: "bg-sand-300" },
  ];
  return (
    <div className="flex flex-wrap gap-3 md:gap-4">
      {items.map((it) => (
        <span
          key={it.label}
          className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500"
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${it.cls}`}
            aria-hidden
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ──────────────────────────── SlotGrid ────────────────────────────

function SlotGrid({
  slots,
  ejectedSlot,
  drawerUnlocked,
  busy,
  configured,
  onEject,
}: {
  slots: SlotInfo[];
  ejectedSlot: number | null;
  drawerUnlocked: boolean;
  busy: string | null;
  configured: boolean;
  onEject: (slot: number) => void;
}) {
  const slotsByIndex = SLOT_NUMBERS.map((i) => slots.find((s) => s.slot === i) ?? null);
  const ejectedCount = ejectedSlot !== null ? 1 : 0;

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Magazine — click a loaded slot to eject
        </p>
        <span className="text-[10px] text-gray-400">
          {TOTAL_SLOTS} slots · {ejectedCount} ejected
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {slotsByIndex.map((s, i) => {
          const slot = i;
          const state = s ? deriveSlotState(s, ejectedSlot) : "locked";
          const isEjected = state === "ejected";
          const isBusy = busy === `eject-${slot}`;
          const canEject =
            !!s?.name && configured && drawerUnlocked && busy === null;
          return (
            <button
              key={slot}
              type="button"
              onClick={() => canEject && onEject(slot)}
              disabled={!canEject}
              className={`flex flex-col gap-1 rounded-xl border p-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${slotStateClasses(state)} ${
                isEjected ? "animate-pulse-soft ring-2 ring-olive-400" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
                  Slot {String(slot).padStart(2, "0")}
                </span>
                {isBusy && <span className="text-[10px]">…</span>}
              </div>
              <div className="truncate font-semibold">{s?.name ?? "—"}</div>
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

// ──────────────────────────── VerifyResultCard ────────────────────────────

function VerifyResultCard({
  result,
  verifying,
  expected,
}: {
  result: VerifyPillResult | null;
  verifying: boolean;
  expected: string | null;
}) {
  if (verifying && !result) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-sand-200 bg-white p-4">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-olive-500" />
        <p className="text-xs text-gray-700">
          Running pill identifier on the tray frame…
        </p>
      </div>
    );
  }

  if (!result) return null;

  const top = result.top;
  const match = result.match;
  const tone =
    match === true
      ? {
          bg: "bg-status-success-bg",
          border: "border-status-success",
          text: "text-status-success",
          icon: "✓",
          headline: "Verified — correct medication",
        }
      : match === false
      ? {
          bg: "bg-status-danger-bg",
          border: "border-status-danger",
          text: "text-status-danger",
          icon: "✗",
          headline: "Mismatch — pill does not match expected",
        }
      : top
      ? {
          bg: "bg-olive-50",
          border: "border-olive-300",
          text: "text-olive-700",
          icon: "·",
          headline: "Detection complete",
        }
      : {
          bg: "bg-status-warning-bg",
          border: "border-status-warning",
          text: "text-status-warning",
          icon: "?",
          headline: "No pill detected on tray",
        };

  const confPct = top ? Math.round(top.confidence * 100) : null;

  return (
    <div className={`rounded-2xl border ${tone.border} ${tone.bg} p-4`}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_3fr]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-lg font-bold ${tone.text}`}
            >
              {tone.icon}
            </span>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
                Pill verification
              </p>
              <p className={`text-sm font-semibold ${tone.text}`}>
                {tone.headline}
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt className="text-gray-500">Detected</dt>
            <dd className="font-semibold text-gray-900">
              {top ? top.class_name : "—"}
            </dd>
            <dt className="text-gray-500">Confidence</dt>
            <dd className="font-mono text-gray-900">
              {confPct !== null ? `${confPct}%` : "—"}
            </dd>
            <dt className="text-gray-500">Expected</dt>
            <dd className="text-gray-900">{expected ?? "—"}</dd>
            <dt className="text-gray-500">Other candidates</dt>
            <dd className="text-gray-700">
              {result.detections.length > 1
                ? result.detections
                    .slice(1, 4)
                    .map(
                      (d) =>
                        `${d.class_name} ${Math.round(d.confidence * 100)}%`,
                    )
                    .join(", ")
                : "none"}
            </dd>
            {typeof result.latency_ms === "number" && (
              <>
                <dt className="text-gray-500">Inference</dt>
                <dd className="font-mono text-gray-500">
                  {result.latency_ms} ms
                </dd>
              </>
            )}
          </dl>
        </div>

        <div className="overflow-hidden rounded-xl border border-sand-200 bg-black">
          {result.snapshot_b64 ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={`data:image/jpeg;base64,${result.snapshot_b64}`}
              alt="Annotated tray snapshot"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-40 w-full items-center justify-center text-xs text-gray-400">
              No snapshot
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────── DispenseCTA ────────────────────────────

function DispenseCTA({
  currentSlot,
  drawerUnlocked,
  busy,
  configured,
  onEject,
  onOpenAdvanced,
}: {
  currentSlot: SlotInfo | null;
  drawerUnlocked: boolean;
  busy: string | null;
  configured: boolean;
  onEject: (slot: number) => void;
  onOpenAdvanced: () => void;
}) {
  const slot = currentSlot?.slot;
  const slotBusy =
    typeof slot === "number" && busy === `eject-${slot}`;
  const canEject =
    !!currentSlot &&
    !!currentSlot.name &&
    configured &&
    drawerUnlocked &&
    busy === null;

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sand-200 bg-white p-4">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Active medication
        </p>
        <p className="truncate text-sm font-semibold text-gray-900">
          {currentSlot
            ? `${currentSlot.name}${currentSlot.pills_per_dose > 1 ? ` ×${currentSlot.pills_per_dose}` : ""} · slot ${String(currentSlot.slot).padStart(2, "0")}`
            : "No active slot"}
        </p>
        <p className="mt-1 text-[11px] text-gray-500">
          {drawerUnlocked
            ? "Press Eject to push the pill onto the tray. Tray camera will show the drop."
            : "Drawer is locked. Unlock the drawer (step 2) before ejecting."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {!drawerUnlocked && (
          <button
            type="button"
            onClick={onOpenAdvanced}
            className="rounded-full border border-sand-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-sand-50"
          >
            Open Advanced
          </button>
        )}
        <button
          type="button"
          onClick={() => slot !== undefined && onEject(slot)}
          disabled={!canEject}
          className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {slotBusy
            ? "Ejecting…"
            : `Eject${currentSlot ? ` ${currentSlot.name}` : ""}`}
          <span className="rounded bg-white/20 px-1 font-mono text-[10px]">↓</span>
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────── CameraTile ────────────────────────────

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

// ──────────────────────────── AIIntakeCheck ────────────────────────────

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

// ──────────────────────────── ActionBar ────────────────────────────

function ActionBar({
  intake,
  currentSlot,
  busy,
  overrideOpen,
  overrideNote,
  setOverrideOpen,
  setOverrideNote,
  onConfirm,
  onOverride,
}: {
  intake: IntakeState | null;
  currentSlot: SlotInfo | null;
  busy: string | null;
  overrideOpen: boolean;
  overrideNote: string;
  setOverrideOpen: (b: boolean) => void;
  setOverrideNote: (s: string) => void;
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
    <div className="rounded-2xl border border-sand-200 bg-white/95 p-4 shadow-lg backdrop-blur">
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

// ──────────────────────────── SectionHeading ────────────────────────────

function SectionHeading({
  index,
  total,
  eyebrow,
  title,
}: {
  index: number;
  total: number;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="mb-4 px-1">
      <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
        Step {index} of {total} · {eyebrow}
      </p>
      <h2 className="mt-1 font-[family-name:var(--font-display)] text-2xl text-gray-900">
        {title}
      </h2>
    </div>
  );
}

// ──────────────────────────── StepBar ────────────────────────────

const STEP_LABELS = ["Identify", "Unlock", "Dispense", "Verify", "Log"];

function StepBar({
  stepIdx,
  viewIdx,
  clock,
  cycleN,
  onJump,
}: {
  stepIdx: number;
  viewIdx: number;
  clock: string;
  cycleN: number;
  onJump: (i: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-2.5">
      <div className="flex flex-1 flex-wrap items-center gap-1.5">
        {STEP_LABELS.map((label, i) => {
          const done = i < stepIdx;
          const liveActive = i === stepIdx;
          const focused = i === viewIdx;
          return (
            <div key={label} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onJump(i)}
                className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-xs transition-colors ${
                  focused
                    ? "bg-olive-50 ring-1 ring-olive-300"
                    : "hover:bg-sand-50"
                }`}
                aria-current={focused ? "step" : undefined}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    done
                      ? "bg-status-success-bg text-status-success"
                      : liveActive
                      ? "bg-olive-700 text-white animate-pulse-soft"
                      : focused
                      ? "bg-olive-100 text-olive-700"
                      : "bg-sand-100 text-gray-400"
                  }`}
                >
                  {done ? (
                    <svg
                      key={`done-${i}`}
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                    >
                      <path
                        className="check-draw"
                        d="M2.5 6.5 L5 9 L9.5 3.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={
                    focused ? "font-semibold text-gray-900" : "text-gray-600"
                  }
                >
                  {label}
                </span>
              </button>
              {i < STEP_LABELS.length - 1 && (
                <span
                  className={`h-px w-5 ${
                    done ? "bg-olive-400 connector-fill" : "bg-sand-200"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-gray-400">
        cycle {cycleN} · {clock}
      </p>
    </div>
  );
}

// ──────────────────────────── UnlockSection ────────────────────────────

function UnlockSection({
  drawerUnlocked,
  configured,
  busy,
  onSetDrawer,
}: {
  drawerUnlocked: boolean;
  configured: boolean;
  busy: string | null;
  onSetDrawer: (action: "lock" | "unlock") => void;
}) {
  return (
    <div className="flex flex-col items-start gap-5 rounded-2xl border border-sand-200 bg-white p-6">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-14 w-14 items-center justify-center rounded-2xl text-2xl ${
            drawerUnlocked
              ? "bg-status-warning-bg text-status-warning"
              : "bg-olive-50 text-olive-700"
          }`}
          aria-hidden
        >
          {drawerUnlocked ? "🔓" : "🔒"}
        </span>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Drawer state
          </p>
          <p className="font-[family-name:var(--font-display)] text-xl text-gray-900">
            {drawerUnlocked ? "Unlocked" : "Locked"}
          </p>
          <p className="mt-1 text-xs text-gray-600">
            {drawerUnlocked
              ? "Cabinet drawer is open. Ready to dispense."
              : "Drawer must be unlocked before the round can begin."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onSetDrawer("lock")}
          disabled={!configured || busy !== null || !drawerUnlocked}
          className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "drawer-lock" ? "Locking…" : "Lock (0°)"}
        </button>
        <button
          type="button"
          onClick={() => onSetDrawer("unlock")}
          disabled={!configured || busy !== null || drawerUnlocked}
          className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "drawer-unlock" ? "Unlocking…" : "Unlock (180°)"}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────── AdvancedSheet ────────────────────────────

function AdvancedSheet({
  open,
  onClose,
  slots,
  ejectedSlot,
  drawerUnlocked,
  busy,
  configured,
  cam0Src,
  cam1Src,
  cam0Url,
  cam1Url,
  status,
  clock,
  onEject,
  onSetDrawer,
  onResnapshot,
}: {
  open: boolean;
  onClose: () => void;
  slots: SlotInfo[];
  ejectedSlot: number | null;
  drawerUnlocked: boolean;
  busy: string | null;
  configured: boolean;
  cam0Src: string | null;
  cam1Src: string | null;
  cam0Url: string | null;
  cam1Url: string | null;
  status: DeviceStatus | null;
  clock: string;
  onEject: (slot: number) => void;
  onSetDrawer: (action: "lock" | "unlock") => void;
  onResnapshot: () => void;
}) {
  if (!open) return null;

  const slotsByIndex = SLOT_NUMBERS.map(
    (i) => slots.find((s) => s.slot === i) ?? null,
  );

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close advanced controls"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Advanced controls"
        className="animate-sheet-up relative max-h-[80vh] overflow-y-auto rounded-t-3xl bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-sand-200 bg-white/95 px-6 py-3 backdrop-blur">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
              Advanced
            </p>
            <p className="text-sm font-semibold text-gray-900">
              Operator controls
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-sand-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-sand-50"
          >
            Close (Esc)
          </button>
        </div>

        <div className="space-y-4 p-6">
          {/* Drawer lock */}
          <div className="rounded-2xl border border-sand-200 bg-sand-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-2xl text-lg ${
                    drawerUnlocked
                      ? "bg-status-warning-bg text-status-warning"
                      : "bg-olive-50 text-olive-700"
                  }`}
                  aria-hidden
                >
                  {drawerUnlocked ? "🔓" : "🔒"}
                </span>
                <div>
                  <p className="text-xs font-semibold text-gray-900">
                    Drawer {drawerUnlocked ? "unlocked" : "locked"}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    Physical lock controlling the cabinet door.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSetDrawer("lock")}
                  disabled={!configured || busy !== null || !drawerUnlocked}
                  className="rounded-full border border-sand-300 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === "drawer-lock" ? "…" : "Lock (0°)"}
                </button>
                <button
                  type="button"
                  onClick={() => onSetDrawer("unlock")}
                  disabled={!configured || busy !== null || drawerUnlocked}
                  className="rounded-full border border-olive-300 bg-olive-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === "drawer-unlock" ? "…" : "Unlock (180°)"}
                </button>
              </div>
            </div>
          </div>

          {/* Manual eject grid */}
          <div className="rounded-2xl border border-sand-200 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-900">
                Manual eject
              </p>
              <p className="text-[10px] text-gray-400">
                Requires drawer unlocked.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {slotsByIndex.map((s, i) => {
                const slot = i;
                const state = s ? deriveSlotState(s, ejectedSlot) : "locked";
                const isBusy = busy === `eject-${slot}`;
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => s?.name && onEject(slot)}
                    disabled={
                      !s?.name ||
                      !configured ||
                      !drawerUnlocked ||
                      busy !== null
                    }
                    className={`flex flex-col gap-1 rounded-xl border p-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${slotStateClasses(
                      state,
                    )}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
                        S{String(slot).padStart(2, "0")}
                      </span>
                      {isBusy && <span className="text-[10px]">…</span>}
                    </div>
                    <div className="truncate font-semibold">
                      {s?.name ?? "—"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider opacity-80">
                      {state === "ejected" ? "● Ejected" : state}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Snapshot + cam debug */}
          <div className="rounded-2xl border border-sand-200 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-900">
                Snapshots & cam debug
              </p>
              <button
                type="button"
                onClick={onResnapshot}
                disabled={!configured || busy !== null}
                className="rounded-full border border-sand-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "snap" ? "…" : "Re-snapshot"}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <CameraTile
                label="Cam 0 · Tray"
                url={cam0Src}
                clock={clock}
                footer={cam0Url ?? "no URL"}
              />
              <CameraTile
                label="Cam 1 · Patient"
                url={cam1Src}
                clock={clock}
                footer={cam1Url ?? "no URL"}
              />
            </div>
            <details className="mt-3 rounded-xl bg-sand-50 p-3 text-[11px] text-gray-700">
              <summary className="cursor-pointer font-semibold">
                Raw device status
              </summary>
              <pre className="mt-2 overflow-x-auto font-mono text-[10px] text-gray-600">
                {status ? JSON.stringify(status, null, 2) : "no status"}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
