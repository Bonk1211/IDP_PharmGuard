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
  fetchCalibration,
  fetchDeviceStatus,
  fetchIntakeState,
  fetchSchedules,
  fetchSnapshot,
  homeEjector,
  isDeviceConfigured,
  manualEject,
  rotateMagazine,
  setCalibration,
  setDrawer,
  speak,
  speakStatic,
  startIntakeWatch,
  streamUrl,
  testEjector,
  triggerDispense,
  verifyFace,
  verifyPill,
  type CalibrationInfo,
  type StaticTtsSlug,
  type DeviceStatus,
  type EjectorCalibration,
  type IntakeState,
  type PillDetection,
  type ScheduleRow,
  type VerifyFaceResult,
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

// Pill classes detected on the tray that are NOT the medication scheduled
// for this round. Anything ≥ confidence threshold counts. Used to block
// step 3 → step 4 when an extra/wrong drug is on the tray.
function unauthorizedDetections(
  result: VerifyPillResult | null,
  expected: string | null | undefined,
  threshold = 0.5,
): PillDetection[] {
  if (!result || !expected) return [];
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]/g, "");
  const ne = norm(expected);
  return result.detections.filter(
    (d) => d.confidence >= threshold && norm(d.class_name) !== ne,
  );
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

// ──────────────────────────── nurse-voice scripts ────────────────────────────
//
// Static lines (centering + the three intake-step prompts) are pre-rendered
// to the Supabase "tts-cache" bucket and played via speakStatic() — see
// STATIC_TTS in lib/device.ts. Only the DYNAMIC lines below (greeting,
// dispensed, wrong-pill) are synthesized live, because they interpolate a
// patient name / medication and can't be cached by fixed text.

function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

// e.g. "Hello Mary. It's time to take your Metformin and Aspirin. I'm right here with you."
function greetingScript(patient: Patient | null, slots: SlotInfo[]): string {
  const hi = `Hello ${firstName(patient?.name)}.`;
  const meds = slots.map((s) => s.name).filter(Boolean) as string[];
  if (meds.length === 0) {
    return `${hi} You're all verified. Please wait while I prepare your medication.`;
  }
  const list =
    meds.length === 1
      ? meds[0]
      : `${meds.slice(0, -1).join(", ")} and ${meds[meds.length - 1]}`;
  return `${hi} It's time to take your ${list}. Take your time — I'm right here with you.`;
}

// Spoken when a pill lands on the tray during Dispense.
function dispensedScript(medName: string | null | undefined): string {
  const med = (medName ?? "").trim();
  return med
    ? `Here's your ${med}. Take your time picking it up from the tray — there's no rush.`
    : `Your medication is on the tray now. Take your time picking it up — there's no rush.`;
}

// Spoken once when the tray shows the wrong pill or an extra/unauthorized pill.
// Calm + reassuring, never alarming.
function wrongPillScript(
  expected: string | null | undefined,
  detected?: string | null,
): string {
  const exp = (expected ?? "").trim();
  const det = (detected ?? "").trim();
  const noticed = det
    ? `Hold on a moment — that looks like ${det}, not your ${exp || "medication"}.`
    : `Hold on a moment — that doesn't look quite right.`;
  return `${noticed} Let's set it aside and I'll sort the right one out for you. You're safe.`;
}

// Maps a swallow-FSM step_name (vision/intake_monitor.py) to its cached
// static-audio slug. Known steps play from the Supabase cache via
// speakStatic(); an unknown step falls back to speaking the backend
// instruction live (see the intake step-change effect).
const INTAKE_STEP_SLUG: Record<string, StaticTtsSlug> = {
  READY: "intake-ready",
  SWALLOW: "intake-swallow",
  DONE: "intake-done",
};

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
  // Layer-1 face verify (step 0 gate). faceVerified must be true before
  // stepIdx advances out of Identify. Resets whenever the active patient
  // changes (next round may be for a different patient).
  const [faceResult, setFaceResult] = useState<VerifyFaceResult | null>(null);
  const [faceVerifying, setFaceVerifying] = useState<boolean>(false);
  const [faceVerified, setFaceVerified] = useState<boolean>(false);
  const prevSnapUrl = useRef<string | null>(null);
  const lastStepIdxRef = useRef<number>(-1);
  // Tracks which patient id the centering prompt already spoke for, so it
  // fires once per patient (not on every Identify-card re-render).
  const centeringSpokenForRef = useRef<number | null>(null);
  // Guards the wrong-pill voice line so it fires once per eject, not on
  // every 4 s re-verify tick. Reset on each new eject (see onEject).
  const wrongPillSpokenRef = useRef<boolean>(false);
  // Last swallow-FSM step index we spoke a prompt for. -1 = none yet.
  // Milestone-paced: speak only when this changes, never on every poll.
  const lastSpokenStepRef = useRef<number>(-1);

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

  // NOTE: terminal result voice (congrats on intake.result === "passed",
  // gentle re-prompt on "timeout"/"missing_labels") was intentionally left
  // out per scope. To add: a sibling effect watching intake.result, ref-
  // guarded once-per-round, calling a resultScript(intake.result).
  //
  // Speak a warm prompt each time the swallow FSM advances a step.
  // Milestones only — guarded by lastSpokenStepRef so the 250 ms intake
  // poll doesn't re-trigger the same line. Resets when the watch stops.
  useEffect(() => {
    if (!intake?.running) {
      lastSpokenStepRef.current = -1;
      return;
    }
    const idx = intake.step_index ?? 0;
    if (idx === lastSpokenStepRef.current) return;
    lastSpokenStepRef.current = idx;
    const slug = INTAKE_STEP_SLUG[intake.step_name];
    if (slug) {
      void speakStatic(slug); // cached → live fallback inside speakStatic
    } else {
      void speak(intake.instruction || "Follow along with me, you're doing great.");
    }
  }, [intake?.running, intake?.step_index, intake?.step_name, intake?.instruction]);

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

  // Reset Layer-1 face verify whenever the active patient changes — a new
  // round may belong to a different patient and the prior pass MUST NOT
  // carry over.
  useEffect(() => {
    setFaceVerified(false);
    setFaceResult(null);
    setFaceVerifying(false);
    centeringSpokenForRef.current = null;
  }, [activePatient?.id]);

  // Speak the face-centering instruction once per patient while the Identify
  // card shows and we haven't verified yet. Best-effort: browser autoplay may
  // block until the first click — speak() swallows the rejection.
  useEffect(() => {
    if (viewIdx !== 0) return;
    if (!activePatient || faceVerified) return;
    if (centeringSpokenForRef.current === activePatient.id) return;
    centeringSpokenForRef.current = activePatient.id;
    void speakStatic("centering");
  }, [viewIdx, activePatient, faceVerified]);

  const goToStep = (idx: number) => {
    setViewIdx(Math.max(0, Math.min(idx, 4)));
  };

  // Confirm + Override on step 3 funnel through here so the backend
  // intake monitor actually starts running. Without this the AI INTAKE
  // CHECK panel stays "Idle" because nothing is feeding cam_b frames
  // into the FSM (the cycle runner is the only other caller).
  const confirmAndVerify = async () => {
    setViewIdx(3);
    const r = await startIntakeWatch(60);
    if (!r.ok) {
      setMsg(`Intake watch failed to start: ${r.error ?? r.status}`);
    } else if (!r.already_running) {
      setMsg("Intake watch started — show the patient on cam 1.");
    }
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
  // Layer-1 face verify pins stepIdx at 0 until faceVerified flips true.
  const stepIdx = useMemo(() => {
    if (!activePatient) return 0;
    if (!faceVerified) return 0;
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
  }, [activePatient, faceVerified, intake, currentSlot, confirmedSlots, drawerUnlocked, activeSlots]);

  const nextRound = useMemo(() => nextRoundFrom(schedules), [schedules]);

  const unauthorized = useMemo(
    () => unauthorizedDetections(verifyResult, currentSlot?.name),
    [verifyResult, currentSlot?.name],
  );

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

  // While the Verify card is on screen, keep re-running the pill
  // detector so the tray-status strip reflects whether the pill is
  // still on the tray (taken vs. forgotten). Skipped if no expected
  // medication is known yet, if a verify call is already in flight,
  // or if hardware isn't configured.
  useEffect(() => {
    if (viewIdx !== 3) return;
    if (!configured) return;
    const expected = currentSlot?.name ?? undefined;
    let alive = true;
    let inFlight = false;
    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const vr = await verifyPill(expected);
        if (alive) setVerifyResult(vr);
      } finally {
        inFlight = false;
      }
    }
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [viewIdx, configured, currentSlot?.name]);

  // Calm spoken alert when the tray shows the wrong or an extra pill,
  // while the operator is on the Dispense card. Fires once per eject.
  useEffect(() => {
    if (viewIdx !== 2) return;
    if (!verifyResult || !verifyResult.top) return;
    const isMismatch = verifyResult.match === false;
    const hasExtra = unauthorized.length > 0;
    if (!isMismatch && !hasExtra) return;
    if (wrongPillSpokenRef.current) return;
    wrongPillSpokenRef.current = true;
    const detected = isMismatch
      ? verifyResult.top.class_name
      : unauthorized[0]?.class_name;
    void speak(wrongPillScript(currentSlot?.name, detected));
  }, [viewIdx, verifyResult, unauthorized, currentSlot?.name]);

  const cam0Url = streamUrl(0);
  // Cam 1 streams with FaceMesh + Hands overlay so judges can see the
  // MediaPipe FSM tracking the patient in real time.
  const cam1Url = streamUrl(1, { annotate: true });
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
    : intake?.result === "missing_labels"
    ? "✗ No bottle / cup / pill seen"
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
      void speak(dispensedScript(expected));
      wrongPillSpokenRef.current = false;
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

  async function onRotate(slot: number) {
    const r = await withBusy(`rotate-${slot}`, () => rotateMagazine(slot));
    if (r.ok) {
      setMsg(
        `Magazine rotated to slot ${r.slot ?? slot} (${r.latency_ms} ms).`,
      );
    } else {
      setMsg(`Rotate failed: ${r.error ?? r.status}`);
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
                title={
                  faceVerified
                    ? "Patient identity confirmed."
                    : "Confirm patient identity at the cabinet."
                }
              />
              <PatientBanner
                patient={activePatient}
                status={status}
                nextRound={nextRound}
                clock={fmtClock(now)}
              />
              <div className="mt-4">
                <FaceVerifySection
                  patient={activePatient}
                  cam1Url={cam1Src}
                  clock={fmtClock(now)}
                  configured={configured}
                  verifying={faceVerifying}
                  result={faceResult}
                  verified={faceVerified}
                  onVerify={async () => {
                    if (!activePatient) return;
                    if (!activePatient.face_reference_url) {
                      setMsg(
                        "No reference photo for this patient. Upload one on the patient page first.",
                      );
                      return;
                    }
                    setFaceVerifying(true);
                    setMsg(null);
                    try {
                      const r = await verifyFace(activePatient.id);
                      setFaceResult(r);
                      // Do NOT auto-advance — operator reviews the snapshot
                      // + bounding box and explicitly clicks Continue.
                      if (r.ok && r.match) {
                        setMsg(
                          `Face matched (similarity ${r.similarity?.toFixed(1) ?? "?"}%). Review the snapshot and tap Continue to proceed.`,
                        );
                      } else if (r.ok) {
                        setMsg(
                          `Face did not match (similarity ${
                            r.similarity?.toFixed(1) ?? "?"
                          }% < threshold ${r.threshold ?? "?"}%). Re-position and retry.`,
                        );
                      } else {
                        setMsg(`Face verify failed: ${r.error ?? r.status}`);
                      }
                    } finally {
                      setFaceVerifying(false);
                    }
                  }}
                  onContinue={() => {
                    setFaceVerified(true);
                    setMsg("Identity confirmed. Step advanced.");
                    void speak(greetingScript(activePatient, activeSlots));
                  }}
                  onReset={() => {
                    setFaceVerified(false);
                    setFaceResult(null);
                  }}
                />
              </div>
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

              <RotateTestBar
                busy={busy}
                configured={configured}
                onRotate={onRotate}
              />

              {(verifying || verifyResult) && (
                <div className="mt-4 space-y-3">
                  {verifyResult && unauthorized.length > 0 && (
                    <UnsafePillAlert
                      unauthorized={unauthorized}
                      expected={currentSlot?.name ?? null}
                    />
                  )}
                  <VerifyResultCard
                    result={verifyResult}
                    verifying={verifying}
                    expected={currentSlot?.name ?? null}
                  />
                </div>
              )}

              {verifyResult && !verifying && verifyResult.top && (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {unauthorized.length > 0 ? (
                    <>
                      <span className="mr-auto text-xs font-medium text-status-danger">
                        Clear the tray and re-eject before proceeding.
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          currentSlot && onEject(currentSlot.slot)
                        }
                        disabled={
                          !currentSlot || !drawerUnlocked || busy !== null
                        }
                        className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Re-eject
                      </button>
                      <button
                        type="button"
                        onClick={confirmAndVerify}
                        className="inline-flex items-center gap-2 rounded-full border border-status-danger bg-white px-4 py-2 text-xs font-semibold text-status-danger transition-colors hover:bg-status-danger-bg"
                      >
                        Override — proceed anyway
                        <span className="rounded bg-status-danger/10 px-1 font-mono text-[10px]">
                          ⚠
                        </span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={confirmAndVerify}
                      className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-olive-800"
                    >
                      Confirm & verify intake
                      <span className="rounded bg-white/20 px-1 font-mono text-[10px]">
                        →
                      </span>
                    </button>
                  )}
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
              <TrayStatusStrip
                result={verifyResult}
                expected={currentSlot?.name ?? null}
              />
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[3fr_4fr]">
                <div className="space-y-4">
                  <AIIntakeCheck intake={intake} patient={activePatient} />
                  <Layer2LabelPanel intake={intake} now={now} />
                </div>
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
                <IntakeReportCard
                  patient={activePatient}
                  slot={currentSlot}
                  verify={verifyResult}
                  intake={intake}
                  unauthorized={unauthorized}
                  overrideNote={overrideOpen ? overrideNote : ""}
                />
              </div>
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

// ──────────────────────────── FaceVerifySection (step 0 gate) ────────────────────────────

// Side-by-side reference photo + cam 1 (live OR captured snapshot with
// bbox overlay after a verify call) and a Verify CTA. Calls
// /api/device/verify_face → AWS Rekognition CompareFaces. Result panel
// stays on screen with the framed face after a match; the operator
// reviews the snapshot and explicitly taps Continue to advance stepIdx.
function FaceVerifySection({
  patient,
  cam1Url,
  clock,
  configured,
  verifying,
  result,
  verified,
  onVerify,
  onContinue,
  onReset,
}: {
  patient: Patient | null;
  cam1Url: string | null;
  clock: string;
  configured: boolean;
  verifying: boolean;
  result: VerifyFaceResult | null;
  verified: boolean;
  onVerify: () => void;
  onContinue: () => void;
  onReset: () => void;
}) {
  const hasReference = !!patient?.face_reference_url;
  const sim = result?.similarity;
  const threshold = result?.threshold;

  let statusLabel: string;
  let statusTone: "ok" | "warn" | "danger" | "idle";
  if (!patient) {
    statusLabel = "No active patient";
    statusTone = "idle";
  } else if (!hasReference) {
    statusLabel = "No reference photo uploaded";
    statusTone = "warn";
  } else if (verified) {
    statusLabel = sim != null ? `Verified · ${sim.toFixed(1)}%` : "Verified";
    statusTone = "ok";
  } else if (verifying) {
    statusLabel = "Comparing with AWS Rekognition…";
    statusTone = "idle";
  } else if (result?.error) {
    statusLabel = `Error · ${result.error.slice(0, 60)}`;
    statusTone = "danger";
  } else if (result && !result.match && sim != null) {
    statusLabel = `No match · ${sim.toFixed(1)}% < ${threshold ?? "?"}%`;
    statusTone = "danger";
  } else {
    statusLabel = "Awaiting verification";
    statusTone = "idle";
  }

  const toneClasses: Record<typeof statusTone, string> = {
    ok: "bg-status-success-bg text-status-success",
    warn: "bg-status-warning-bg text-status-warning",
    danger: "bg-status-danger-bg text-status-danger",
    idle: "bg-olive-50 text-olive-700",
  };

  const canVerify =
    !!patient && hasReference && configured && !verifying && !verified;

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Layer 1 · Face verify (AWS Rekognition CompareFaces)
          </p>
          <p className="mt-0.5 text-sm font-semibold text-gray-900">
            {patient ? patient.name : "—"}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-[11px] font-semibold ${toneClasses[statusTone]}`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Reference photo */}
        <figure className="overflow-hidden rounded-xl border border-sand-200 bg-sand-50">
          <div className="flex aspect-[4/3] items-center justify-center bg-sand-100">
            {hasReference ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={patient!.face_reference_url!}
                alt={`${patient!.name} reference`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="px-4 text-center text-[11px] text-gray-500">
                No reference photo yet.
                {patient && (
                  <>
                    <br />
                    <Link
                      href={`/patients/${patient.id}`}
                      className="font-semibold text-olive-700 underline"
                    >
                      Upload on patient page →
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
          <figcaption className="flex items-center justify-between bg-white px-3 py-1.5 text-[10px] text-gray-500">
            <span>Reference photo</span>
            <span className="font-mono">stored</span>
          </figcaption>
        </figure>

        {/* Cam 1 — captured snapshot (with bbox) after verify, else live */}
        <figure className="overflow-hidden rounded-xl border border-sand-200 bg-black">
          <div className="relative aspect-[4/3] bg-black">
            {result?.snapshot_b64 ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/jpeg;base64,${result.snapshot_b64}`}
                  alt="Captured cam 1 snapshot"
                  className="h-full w-full object-cover"
                />
                {result.bbox && (
                  <div
                    className={`pointer-events-none absolute rounded-md border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.4)] ${
                      result.match
                        ? "border-status-success"
                        : "border-status-danger"
                    }`}
                    style={{
                      left: `${result.bbox.Left * 100}%`,
                      top: `${result.bbox.Top * 100}%`,
                      width: `${result.bbox.Width * 100}%`,
                      height: `${result.bbox.Height * 100}%`,
                    }}
                  >
                    <span
                      className={`absolute -top-5 left-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white ${
                        result.match ? "bg-status-success" : "bg-status-danger"
                      }`}
                    >
                      {result.match ? "MATCH" : "NO MATCH"}
                      {result.similarity != null &&
                        ` · ${result.similarity.toFixed(1)}%`}
                    </span>
                  </div>
                )}
              </>
            ) : cam1Url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cam1Url}
                alt="Cam 1 live"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-gray-400">
                Cam 1 unavailable — check device config.
              </div>
            )}
          </div>
          <figcaption className="flex items-center justify-between bg-white px-3 py-1.5 text-[10px] text-gray-500">
            <span>
              Cam 1 · {result?.snapshot_b64 ? "captured" : "live"}
              {result?.bbox ? " · face framed" : ""}
            </span>
            <span className="font-mono text-gray-400">{clock}</span>
          </figcaption>
        </figure>
      </div>

      {/* Similarity bar + threshold marker */}
      {result && sim != null && threshold != null && (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between text-[11px]">
            <span className="font-mono text-gray-500">similarity</span>
            <span
              className={`font-mono font-semibold ${
                result.match ? "text-status-success" : "text-status-danger"
              }`}
            >
              {sim.toFixed(1)}% / {threshold}%
            </span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-sand-100">
            <div
              className={`h-full ${
                result.match ? "bg-status-success" : "bg-status-danger"
              }`}
              style={{ width: `${Math.min(100, Math.max(0, sim))}%` }}
            />
            <div
              className="absolute top-0 h-full w-px bg-gray-700"
              style={{ left: `${Math.min(100, Math.max(0, threshold))}%` }}
              title={`threshold ${threshold}%`}
            />
          </div>
        </div>
      )}

      {/* Action row — explicit Continue gate after match. Operator
          confirms by tapping Continue, never auto-advanced. */}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {result?.latency_ms != null && (
          <span className="mr-auto font-mono text-[10px] text-gray-400">
            {result.latency_ms} ms · rekognition
          </span>
        )}
        {verified ? (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50"
          >
            Re-verify
          </button>
        ) : result?.ok && result.match ? (
          <>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={onContinue}
              className="inline-flex items-center gap-2 rounded-full border border-status-success bg-status-success px-5 py-2 text-xs font-semibold text-white transition-colors hover:opacity-90"
            >
              Continue
              <span className="rounded bg-white/20 px-1 font-mono text-[10px]">
                →
              </span>
            </button>
          </>
        ) : result && (!result.ok || !result.match) ? (
          <>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={onVerify}
              disabled={!canVerify && !result}
              className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {verifying ? "Verifying…" : "Retry verify"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onVerify}
            disabled={!canVerify}
            className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-olive-700 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {verifying ? "Verifying…" : "Verify face"}
            {!verifying && (
              <span className="rounded bg-white/20 px-1 font-mono text-[10px]">
                AWS
              </span>
            )}
          </button>
        )}
      </div>
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

// ──────────────────────────── RotateTestBar ────────────────────────────

function RotateTestBar({
  busy,
  configured,
  onRotate,
}: {
  busy: string | null;
  configured: boolean;
  onRotate: (slot: number) => void;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-sand-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Rotate test — drive the magazine to any slot (no eject)
        </p>
        <span className="text-[10px] text-gray-400">{TOTAL_SLOTS} slots</span>
      </div>
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
        {SLOT_NUMBERS.map((slot) => {
          const isBusy = busy === `rotate-${slot}`;
          const disabled = !configured || (busy !== null && !isBusy);
          return (
            <button
              key={slot}
              type="button"
              onClick={() => onRotate(slot)}
              disabled={disabled}
              className="rounded-xl border border-sand-200 bg-sand-50 px-2 py-2 font-mono text-xs tabular-nums transition-colors hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? "…" : String(slot).padStart(2, "0")}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────── IntakeReportCard ────────────────────────────

function IntakeReportCard({
  patient,
  slot,
  verify,
  intake,
  unauthorized,
  overrideNote,
}: {
  patient: Patient | null;
  slot: SlotInfo | null;
  verify: VerifyPillResult | null;
  intake: IntakeState | null;
  unauthorized: PillDetection[];
  overrideNote: string;
}) {
  const expected = slot?.name ?? null;
  const detected = verify?.top?.class_name ?? null;
  const detConfPct = verify?.top
    ? Math.round(verify.top.confidence * 100)
    : null;
  const pillMatch = verify?.match;

  const fsmResult = intake?.result ?? null;
  const fsmConfPct = intake ? Math.round(intake.confidence * 100) : 0;
  const fsmHoldPct = intake ? Math.round(intake.hold_progress * 100) : 0;
  const startedAt = intake?.started_at ?? null;
  const endedAt = intake?.ended_at ?? null;
  const nowS = Date.now() / 1000;
  const durationS =
    startedAt !== null ? (endedAt ?? nowS) - startedAt : null;

  // Overall outcome — drives the headline + colour scheme.
  const overall: {
    label: string;
    tone: "ok" | "warn" | "fail" | "pending";
  } = (() => {
    if (unauthorized.length > 0) return { label: "Unsafe round", tone: "fail" };
    if (pillMatch === false) return { label: "Wrong pill on tray", tone: "fail" };
    if (fsmResult === "passed" && (pillMatch === true || pillMatch === null))
      return { label: "Intake confirmed", tone: "ok" };
    if (fsmResult === "timeout")
      return { label: "Intake timed out", tone: "warn" };
    if (intake?.running) return { label: "Intake in progress", tone: "pending" };
    return { label: "Awaiting confirmation", tone: "pending" };
  })();

  const tonePalette = {
    ok: {
      border: "border-status-success",
      bg: "bg-status-success-bg",
      text: "text-status-success",
      icon: "✓",
    },
    warn: {
      border: "border-status-warning",
      bg: "bg-status-warning-bg",
      text: "text-status-warning",
      icon: "!",
    },
    fail: {
      border: "border-status-danger",
      bg: "bg-status-danger-bg",
      text: "text-status-danger",
      icon: "✗",
    },
    pending: {
      border: "border-sand-200",
      bg: "bg-white",
      text: "text-olive-700",
      icon: "…",
    },
  }[overall.tone];

  const fmtTime = (s: number | null) =>
    s === null
      ? "—"
      : new Date(s * 1000).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });

  const fmtDuration = (s: number | null) => {
    if (s === null) return "—";
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m ${r}s`;
  };

  return (
    <div className={`rounded-2xl border ${tonePalette.border} ${tonePalette.bg} p-4`}>
      {/* Headline — outcome + meta on the left, proof thumbnail on the right. */}
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-lg font-bold ${tonePalette.text}`}
          aria-hidden
        >
          {tonePalette.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Intake session report
          </p>
          <p className={`text-sm font-semibold ${tonePalette.text}`}>
            {overall.label}
          </p>
          <p className="text-[11px] text-gray-600">
            {patient?.name ?? "—"} ·{" "}
            <span className="font-semibold text-gray-800">
              {expected ?? "no medication"}
            </span>{" "}
            from slot{" "}
            <span className="font-mono">
              {slot ? String(slot.slot).padStart(2, "0") : "—"}
            </span>
          </p>
        </div>
        {verify?.snapshot_b64 && (
          <figure className="hidden sm:block shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/jpeg;base64,${verify.snapshot_b64}`}
              alt="Annotated tray snapshot"
              className="h-16 w-24 rounded-lg border border-sand-200 bg-black object-cover"
              title={
                verify.top
                  ? `${verify.top.class_name} · ${Math.round(
                      verify.top.confidence * 100,
                    )}% (cam 0 · pill_detector.pt)`
                  : "cam 0 · pill_detector.pt"
              }
            />
          </figure>
        )}
      </div>

      {/* KPI tiles */}
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi
          label="Pill verify"
          value={detected ?? "—"}
          sub={
            detConfPct !== null
              ? `${detConfPct}% conf · ${
                  pillMatch === true
                    ? "match"
                    : pillMatch === false
                    ? "mismatch"
                    : "no target"
                }`
              : "no detection"
          }
          tone={
            pillMatch === true
              ? "ok"
              : pillMatch === false
              ? "fail"
              : detected
              ? "pending"
              : "warn"
          }
        />
        <Kpi
          label="Swallow FSM"
          value={
            fsmResult === "passed"
              ? "Passed"
              : fsmResult === "timeout"
              ? "Timed out"
              : intake?.running
              ? "Watching"
              : "Idle"
          }
          sub={`step ${(intake?.step_index ?? 0) + 1}/${
            intake?.total_steps ?? 3
          } · ${fsmConfPct}%`}
          tone={
            fsmResult === "passed"
              ? "ok"
              : fsmResult === "timeout"
              ? "fail"
              : "pending"
          }
        />
        <Kpi
          label="Hold progress"
          value={`${fsmHoldPct}%`}
          sub={
            intake?.face_visible
              ? `face seen · ${intake.hands_count} hand${
                  intake.hands_count === 1 ? "" : "s"
                }`
              : "no face"
          }
          tone="pending"
        />
        <Kpi
          label="Duration"
          value={fmtDuration(durationS)}
          sub={`${fmtTime(startedAt)} → ${fmtTime(endedAt)}`}
          tone="pending"
        />
      </div>

      {/* FSM step history */}
      {intake && intake.history.length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
            Step history
          </p>
          <ul className="mt-1 space-y-1">
            {intake.history.map((h, i) => (
              <li
                key={`${h.step_index}-${i}`}
                className="flex items-center gap-2 rounded-xl bg-white px-3 py-1.5 text-xs"
              >
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-status-success-bg text-[10px] font-bold text-status-success">
                  ✓
                </span>
                <span className="flex-1 text-gray-800">{h.step_name}</span>
                <span className="font-mono text-[10px] text-gray-500">
                  {fmtTime(h.passed_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Unauthorized drug warning */}
      {unauthorized.length > 0 && (
        <div className="mt-3 rounded-xl border border-status-danger bg-white p-3 text-xs">
          <p className="font-semibold text-status-danger">
            ⚠ Unauthorized medication on tray during round
          </p>
          <ul className="mt-1 space-y-0.5 text-gray-700">
            {unauthorized.map((d, i) => (
              <li key={`${d.class_name}-${i}`}>
                {d.class_name}{" "}
                <span className="font-mono text-gray-500">
                  {Math.round(d.confidence * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Override note */}
      {overrideNote.trim() && (
        <div className="mt-3 rounded-xl border border-status-warning bg-white p-3 text-xs">
          <p className="font-semibold text-status-warning">Operator note</p>
          <p className="mt-1 text-gray-700">{overrideNote}</p>
        </div>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "ok" | "warn" | "fail" | "pending";
}) {
  const valueTone = {
    ok: "text-status-success",
    warn: "text-status-warning",
    fail: "text-status-danger",
    pending: "text-gray-900",
  }[tone];
  return (
    <div className="rounded-xl bg-white p-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
        {label}
      </p>
      <p
        className={`mt-0.5 truncate font-[family-name:var(--font-display)] text-base ${valueTone}`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[10px] text-gray-500">{sub}</p>}
    </div>
  );
}

// ──────────────────────────── UnsafePillAlert ────────────────────────────

function UnsafePillAlert({
  unauthorized,
  expected,
}: {
  unauthorized: PillDetection[];
  expected: string | null;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border-2 border-status-danger bg-status-danger-bg p-4"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-lg font-bold text-status-danger"
          aria-hidden
        >
          ⚠
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider text-status-danger">
            Unauthorized medication detected
          </p>
          <p className="mt-0.5 text-sm font-semibold text-status-danger">
            {unauthorized.length === 1
              ? "1 pill on the tray is not on this round's schedule."
              : `${unauthorized.length} pills on the tray are not on this round's schedule.`}
          </p>
          <p className="mt-1 text-xs text-gray-700">
            {expected
              ? `Only ${expected} should be dispensed at this slot. Clear the tray and re-eject before letting the patient take anything.`
              : "Clear the tray and re-eject the correct medication."}
          </p>
          <ul className="mt-3 space-y-1">
            {unauthorized.map((d, i) => (
              <li
                key={`${d.class_name}-${i}`}
                className="flex items-center gap-2 rounded-xl bg-white px-3 py-1.5 text-xs"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-danger" />
                <span className="font-semibold text-gray-900">
                  {d.class_name}
                </span>
                <span className="ml-auto font-mono text-gray-500">
                  {Math.round(d.confidence * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────── TrayStatusStrip ────────────────────────────

function TrayStatusStrip({
  result,
  expected,
}: {
  result: VerifyPillResult | null;
  expected: string | null;
}) {
  if (!result) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-2.5 text-xs text-gray-500">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-olive-400" />
        Probing tray with pill_detector…
      </div>
    );
  }

  const top = result.top;
  const hasPill = !!top;
  const confPct = top ? Math.round(top.confidence * 100) : null;
  const matchTone =
    !hasPill
      ? { dot: "bg-status-warning", label: "TRAY EMPTY", text: "text-status-warning" }
      : result.match === false
      ? { dot: "bg-status-danger", label: "WRONG PILL", text: "text-status-danger" }
      : { dot: "bg-status-success", label: "ON TRAY", text: "text-status-success" };

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sand-200 bg-white px-4 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${matchTone.dot}`}
        />
        <span
          className={`font-semibold uppercase tracking-wider ${matchTone.text}`}
        >
          {matchTone.label}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-gray-500">
          Detected:{" "}
          <span className="font-semibold text-gray-900">
            {top?.class_name ?? "none"}
          </span>
        </span>
        <span className="text-gray-500">
          Confidence:{" "}
          <span className="font-mono text-gray-900">
            {confPct !== null ? `${confPct}%` : "—"}
          </span>
        </span>
        {expected && (
          <span className="text-gray-500">
            Expected: <span className="text-gray-900">{expected}</span>
          </span>
        )}
        {typeof result.latency_ms === "number" && (
          <span className="text-gray-400">
            <span className="font-mono">{result.latency_ms}ms</span>
          </span>
        )}
      </div>
      <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-400">
        auto-refresh · 4s
      </span>
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

// ──────────────────────────── Layer2LabelPanel ────────────────────────────

// Live readout of AWS Rekognition DetectLabels evidence collected during
// the swallow window. Hard-gate companion to AIIntakeCheck — intake only
// confirms when both MediaPipe FSM passes AND at least one required label
// appears here. Empty `labels_required` => layer disabled server-side.
function Layer2LabelPanel({
  intake,
  now,
}: {
  intake: IntakeState | null;
  now: Date;
}) {
  const required = intake?.labels_required ?? [];
  const seenAt = intake?.labels_seen_at ?? {};
  const satisfied = intake?.labels_satisfied ?? false;
  const disabled = required.length === 0;
  const nowMs = now.getTime();

  if (disabled) {
    return (
      <div className="rounded-2xl border border-sand-200 bg-white p-4">
        <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Layer 2 · Object evidence
        </p>
        <p className="text-xs text-gray-500">
          Disabled — set <code>INTAKE_LABEL_ENABLED=1</code> on the Pi to require
          bottle / cup / pill evidence alongside MediaPipe.
        </p>
      </div>
    );
  }

  const matchedCount = required.filter((r) => r in seenAt).length;

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-base font-bold ${
            satisfied
              ? "bg-status-success-bg text-status-success"
              : "bg-olive-50 text-olive-700"
          }`}
        >
          {satisfied ? "✓" : "…"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Layer 2 · Object evidence
          </p>
          <p className="text-sm font-semibold text-gray-900">
            {satisfied
              ? "Required object seen"
              : intake?.running
              ? "Watching for bottle / cup / pill…"
              : "Awaiting cycle"}
          </p>
          <p className="text-[11px] text-gray-500">
            {matchedCount}/1 match{matchedCount === 1 ? "" : "es"} from{" "}
            {required.length} required label{required.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {required.map((label) => {
          const tsMs = seenAt[label] ? seenAt[label] * 1000 : null;
          const ageS = tsMs != null ? Math.max(0, (nowMs - tsMs) / 1000) : null;
          const ok = tsMs != null;
          return (
            <div
              key={label}
              className="flex items-center gap-2 rounded-xl bg-sand-50 px-2.5 py-1.5 text-xs"
            >
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  ok
                    ? "bg-status-success-bg text-status-success"
                    : "bg-sand-200 text-gray-400"
                }`}
                aria-hidden
              >
                {ok ? "✓" : "·"}
              </span>
              <span className="flex-1 capitalize text-gray-700">{label}</span>
              <span className="font-mono text-[11px] text-gray-500">
                {ageS == null
                  ? "not seen"
                  : ageS < 1
                  ? "just now"
                  : `${ageS.toFixed(1)}s ago`}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-gray-400">
        <span className="rounded-full bg-sand-100 px-2 py-0.5 font-mono">
          model: aws-rekognition-detect-labels
        </span>
        <span>seen: {intake?.labels_seen?.length ?? 0} unique</span>
        <span>mediapipe: {intake?.mediapipe_complete ? "✓" : "—"}</span>
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

          {/* Ejector servo calibration */}
          <ServoCalibrationSection configured={configured} parentBusy={busy} />

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

// ──────────────────────── ServoCalibrationSection ───────────────────────────

const CAL_FIELDS: {
  key: keyof EjectorCalibration;
  label: string;
  unit: string;
  step: number;
  hint: string;
}[] = [
  { key: "fwd_us", label: "Forward pulse", unit: "µs", step: 5, hint: ">1500 = eject direction; further from 1500 = faster" },
  { key: "rev_us", label: "Reverse pulse", unit: "µs", step: 5, hint: "<1500 = return-home direction" },
  { key: "stop_us", label: "Stop pulse", unit: "µs", step: 1, hint: "~1500; trim in small steps to kill creep" },
  { key: "move_s", label: "Stroke time", unit: "s", step: 0.5, hint: "seconds driven each direction" },
  { key: "pause_s", label: "Pause", unit: "s", step: 0.1, hint: "settle between strokes" },
];

function toDraft(cal: EjectorCalibration): Record<string, string> {
  return Object.fromEntries(
    CAL_FIELDS.map((f) => [f.key, String(cal[f.key])]),
  );
}

/**
 * Operator calibration for the continuous-rotation ejector servo. Tune
 * pulse widths + stroke timing, save (persists on the Pi), and Test/Home to
 * iterate. Self-contained: fetches + writes through lib/device.ts directly.
 */
function ServoCalibrationSection({
  configured,
  parentBusy,
}: {
  configured: boolean;
  parentBusy: string | null;
}) {
  const [info, setInfo] = useState<CalibrationInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const ci = await fetchCalibration();
      if (alive && ci) {
        setInfo(ci);
        setDraft(toDraft(ci.calibration));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const locked = !configured || busy !== null || parentBusy !== null || !info;

  async function onSave() {
    const updates: Partial<EjectorCalibration> = {};
    for (const f of CAL_FIELDS) {
      const n = parseFloat(draft[f.key]);
      if (!Number.isFinite(n)) {
        setMsg({ text: `${f.label} is not a number`, ok: false });
        return;
      }
      const [lo, hi] = info?.bounds[f.key] ?? [-Infinity, Infinity];
      if (n < lo || n > hi) {
        setMsg({ text: `${f.label} must be ${lo}–${hi} ${f.unit}`, ok: false });
        return;
      }
      updates[f.key] = n;
    }
    setBusy("save");
    setMsg(null);
    const r = await setCalibration(updates);
    setBusy(null);
    if (r.ok && r.calibration) {
      setInfo((p) => (p ? { ...p, calibration: r.calibration! } : p));
      setDraft(toDraft(r.calibration));
      setMsg({ text: "Calibration saved (takes effect next eject).", ok: true });
    } else {
      setMsg({ text: r.error ?? `Save failed (${r.status})`, ok: false });
    }
  }

  function onResetDefaults() {
    if (!info) return;
    setDraft(toDraft(info.defaults));
    setMsg({ text: "Filled defaults — press Save to apply.", ok: true });
  }

  async function onTest() {
    setBusy("test");
    setMsg(null);
    const r = await testEjector();
    setBusy(null);
    setMsg(
      r.ok
        ? { text: `Test eject ran (${r.latency_ms ?? "?"} ms).`, ok: true }
        : { text: r.error ?? `Test failed (${r.status})`, ok: false },
    );
  }

  async function onHome() {
    setBusy("home");
    setMsg(null);
    const r = await homeEjector();
    setBusy(null);
    setMsg(
      r.ok
        ? { text: `Homed (${r.latency_ms ?? "?"} ms).`, ok: true }
        : { text: r.error ?? `Home failed (${r.status})`, ok: false },
    );
  }

  return (
    <div className="rounded-2xl border border-sand-200 p-4">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-900">
          Ejector servo calibration
        </p>
        <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400">
          MG996R · continuous
        </span>
      </div>
      <p className="mb-3 text-[11px] text-gray-500">
        Tune the pusher motion. Saved values persist on the device and take
        effect on the next eject. Use Test to try them and Home to re-seat the
        pusher.
      </p>

      {!info ? (
        <p className="rounded-xl bg-sand-50 px-3 py-2 text-[11px] text-gray-500">
          {configured
            ? "Loading calibration…"
            : "Device not connected — calibration unavailable."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CAL_FIELDS.map((f) => {
              const [lo, hi] = info.bounds[f.key];
              return (
                <label key={f.key} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between">
                    <span className="text-[11px] font-medium text-gray-700">
                      {f.label}
                    </span>
                    <span className="font-mono text-[10px] text-gray-400">
                      {f.unit} · {lo}–{hi}
                    </span>
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={f.step}
                    min={lo}
                    max={hi}
                    value={draft[f.key] ?? ""}
                    disabled={locked}
                    onChange={(e) =>
                      setDraft((p) => ({ ...p, [f.key]: e.target.value }))
                    }
                    className="rounded-xl border border-sand-200 bg-sand-50 px-3 py-2 font-mono text-sm tabular-nums text-gray-900 transition-colors focus:border-olive-400 focus:bg-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="text-[10px] text-gray-400">{f.hint}</span>
                </label>
              );
            })}
          </div>

          {msg && (
            <p
              className={`mt-3 rounded-xl px-3 py-2 text-[11px] ${
                msg.ok
                  ? "bg-olive-50 text-olive-800"
                  : "bg-status-warning-bg text-status-warning"
              }`}
            >
              {msg.text}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={locked}
              className="rounded-full border border-olive-300 bg-olive-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onTest}
              disabled={locked}
              className="rounded-full border border-sand-300 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "test" ? "Testing…" : "Test eject"}
            </button>
            <button
              type="button"
              onClick={onHome}
              disabled={locked}
              className="rounded-full border border-sand-300 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "home" ? "Homing…" : "Home"}
            </button>
            <button
              type="button"
              onClick={onResetDefaults}
              disabled={locked}
              className="ml-auto text-[11px] font-medium text-gray-500 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset to defaults
            </button>
          </div>
        </>
      )}
    </div>
  );
}
