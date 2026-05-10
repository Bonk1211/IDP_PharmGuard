"use client";

// Single-viewport control panel — fills the area below the Navbar with no
// outer scroll. Status + cams + intake stay always-visible; controls and
// data tables tab inside a fixed-height right pane.
// NOTE: lib/device.ts is single-target. The route's [id] is informational
// until multi-tenant lands.

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";

import {
  fetchDeviceStatus,
  fetchIntakeState,
  fetchPiLogs,
  fetchSchedules,
  fetchSnapshot,
  isDeviceConfigured,
  manualEject,
  resetDevice,
  setDrawer,
  setSlotSchedule,
  streamUrl,
  triggerDispense,
  type DeviceStatus,
  type IntakeState,
  type LogRecord,
  type ScheduleRow,
} from "@/lib/device";
import { refreshBrief, triggerFlagDetection } from "@/lib/agent";
import { KEYS } from "@/lib/swr";

const SLOT_NUMBERS = Array.from({ length: 10 }, (_, i) => i);

type Tab = "control" | "schedule" | "logs";

function formatLogTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function levelColor(level: string): string {
  switch (level) {
    case "ERROR":
    case "CRITICAL":
      return "text-status-danger";
    case "WARNING":
      return "text-status-warning";
    case "INFO":
      return "text-olive-700";
    default:
      return "text-gray-500";
  }
}

export default function DispenserStreamPage() {
  const { id } = useParams<{ id: string }>();
  const dispenserId = String(id);
  const { mutate } = useSWRConfig();

  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [snap, setSnap] = useState<{ cam: 0 | 1; url: string } | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<number, string>>({});
  const [annotate, setAnnotate] = useState(false);
  const [tab, setTab] = useState<Tab>("control");
  const prevSnapUrl = useRef<string | null>(null);

  const configured = isDeviceConfigured();
  const cam0Url = streamUrl(0, { annotate });
  const cam1Url = streamUrl(1, { annotate });

  // Status poll — 3 s.
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

  // Intake state — 4 Hz so the progress reads live.
  useEffect(() => {
    let alive = true;
    async function tick() {
      const s = await fetchIntakeState();
      if (!alive) return;
      setIntake(s);
    }
    tick();
    const id = setInterval(tick, 250);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Log tail — 0.5 Hz.
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    async function tick() {
      const r = await fetchPiLogs(200);
      if (alive) setLogs(r);
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [configured]);

  // Schedules — 30 s so external changes (refill workflow, manual SQL) surface.
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    async function load() {
      const rows = await fetchSchedules();
      if (alive) {
        setSchedules(rows);
        setScheduleDrafts((prev) => {
          const next = { ...prev };
          for (const r of rows) {
            if (next[r.slot] === undefined) {
              next[r.slot] = r.schedule_at ? r.schedule_at.slice(0, 5) : "";
            }
          }
          return next;
        });
      }
    }
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [configured]);

  useEffect(() => {
    return () => {
      if (prevSnapUrl.current) URL.revokeObjectURL(prevSnapUrl.current);
    };
  }, []);

  async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    setBusy(label);
    setMsg(null);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }

  async function onReset() {
    if (!confirm("Reset the hardware loop? This stops + restarts the dispense cycle.")) return;
    const r = await withBusy("reset", resetDevice);
    setMsg(r.ok ? "Loop reset." : `Reset failed: ${r.status}`);
  }

  async function onDispense() {
    const r = await withBusy("dispense", triggerDispense);
    if (r.ok) setMsg("Queued — Pi will run the next cycle now.");
    else if (r.status === 0) setMsg("Cannot reach device.");
    else setMsg(`Device returned ${r.status}.`);
  }

  async function onEject(slot: number) {
    const r = await withBusy(`eject-${slot}`, () => manualEject(slot));
    setMsg(
      r.ok
        ? `Slot ${slot} ejected (${r.latency_ms} ms).`
        : `Eject failed: ${r.error ?? r.status}`,
    );
  }

  async function onDrawer(action: "lock" | "unlock") {
    const r = await withBusy(`drawer-${action}`, () => setDrawer(action));
    setMsg(
      r.ok
        ? `Drawer ${action}ed.`
        : `Drawer ${action} failed: ${r.error ?? r.status}`,
    );
  }

  async function onSnapshot(cam: 0 | 1) {
    if (prevSnapUrl.current) URL.revokeObjectURL(prevSnapUrl.current);
    const url = await withBusy(`snap-${cam}`, () => fetchSnapshot(cam));
    if (url) {
      prevSnapUrl.current = url;
      setSnap({ cam, url });
    } else {
      setMsg("Snapshot failed.");
    }
  }

  async function onBrief() {
    setMsg(null);
    setBusy("brief");
    try {
      await refreshBrief("on_demand");
      await mutate(KEYS.brief);
      setMsg("Brief generated.");
    } catch (e) {
      setMsg(e instanceof Error ? `Brief failed: ${e.message}` : "Brief failed.");
    } finally {
      setBusy(null);
    }
  }

  async function onDetect() {
    const r = await withBusy("detect", triggerFlagDetection);
    if (r) {
      await mutate(KEYS.flags);
      setMsg(`Detection: ${r.new_count} new flag(s).`);
    } else {
      setMsg("Detection failed.");
    }
  }

  function onRefreshCaches() {
    mutate(KEYS.slots);
    mutate(KEYS.logs);
    mutate(KEYS.patients);
    setMsg("Inventory caches refreshed.");
  }

  async function onScheduleSave(slot: number) {
    const draft = (scheduleDrafts[slot] ?? "").trim();
    const value = draft === "" ? null : draft;
    const r = await withBusy(`sched-${slot}`, () => setSlotSchedule(slot, value));
    if (r.ok) {
      setMsg(
        value === null
          ? `Slot ${slot} schedule cleared.`
          : `Slot ${slot} scheduled at ${value}.`,
      );
      const rows = await fetchSchedules();
      setSchedules(rows);
    } else {
      setMsg(`Schedule failed: ${r.error ?? r.status}`);
    }
  }

  async function onScheduleClear(slot: number) {
    setScheduleDrafts((prev) => ({ ...prev, [slot]: "" }));
    const r = await withBusy(`sched-${slot}`, () => setSlotSchedule(slot, null));
    if (r.ok) {
      setMsg(`Slot ${slot} schedule cleared.`);
      const rows = await fetchSchedules();
      setSchedules(rows);
    } else {
      setMsg(`Clear failed: ${r.error ?? r.status}`);
    }
  }

  // The Navbar is sticky h-16; the layout adds pt-6 + pb-12. Reserve them
  // so the panel exactly fills the rest of the viewport without scroll.
  return (
    <div className="flex h-[calc(100vh-8.5rem)] min-h-[600px] flex-col gap-2 -mt-2">
      {/* ── Header bar ─────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wider text-olive-500">Dispenser</p>
          <h1 className="font-[family-name:var(--font-display)] text-xl text-gray-900 truncate">
            {dispenserId}
          </h1>
        </div>

        <StatusPills status={status} />

        <div className="ml-auto flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-sand-200 bg-white px-2.5 py-1 text-[11px] text-gray-700">
            <input
              type="checkbox"
              checked={annotate}
              onChange={(e) => setAnnotate(e.target.checked)}
              className="h-3 w-3"
            />
            Overlay
          </label>
          <ActionButton onClick={onDispense} disabled={!configured || busy !== null}>
            {busy === "dispense" ? "Dispensing…" : "Dispense Now"}
          </ActionButton>
          <ActionButton onClick={onReset} disabled={!configured || busy !== null} tone="danger">
            {busy === "reset" ? "Resetting…" : "Reset"}
          </ActionButton>
        </div>
      </div>

      {/* ── Inline banner row (warnings + status msgs) ─────── */}
      {(!configured || statusError || msg) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {!configured && (
            <span className="rounded-full border border-status-warning-bg bg-status-warning-bg px-2.5 py-1 text-status-warning">
              Set NEXT_PUBLIC_DEVICE_URL + NEXT_PUBLIC_DEVICE_API_KEY in frontend/.env.local
            </span>
          )}
          {statusError && configured && (
            <span className="rounded-full border border-status-danger-bg bg-status-danger-bg px-2.5 py-1 text-status-danger">
              {statusError}
            </span>
          )}
          {msg && (
            <span className="rounded-full border border-sand-200 bg-sand-50 px-2.5 py-1 text-gray-700">
              {msg}
            </span>
          )}
        </div>
      )}

      {/* ── Slim intake strip ─────────────────────────────── */}
      <IntakeStrip state={intake} />

      {/* ── Main 12-col grid: cams (8) | control tabs (4) ─── */}
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-3">
        <div className="col-span-12 grid min-h-0 grid-cols-2 gap-3 lg:col-span-8">
          <CameraTile
            key={`cam0-${annotate ? "annot" : "raw"}`}
            label={`Cam 0 — tray${annotate ? " · pill_detector" : ""}`}
            url={cam0Url}
          />
          <CameraTile
            key={`cam1-${annotate ? "annot" : "raw"}`}
            label={`Cam 1 — patient${annotate ? " · MediaPipe" : ""}`}
            url={cam1Url}
          />
        </div>

        <div className="col-span-12 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-sand-200 bg-white lg:col-span-4">
          {/* Tab strip */}
          <div className="flex border-b border-sand-200">
            <TabButton active={tab === "control"} onClick={() => setTab("control")}>Control</TabButton>
            <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")}>
              Schedule {schedules.length > 0 && (
                <span className="ml-1 text-[10px] text-gray-400">({schedules.filter((s) => s.schedule_at).length}/{schedules.length})</span>
              )}
            </TabButton>
            <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
              Logs <span className="ml-1 text-[10px] text-gray-400">({logs.length})</span>
            </TabButton>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "control" && (
              <ControlTab
                configured={configured}
                busy={busy}
                drawerUnlocked={!!status?.is_unlocked}
                snap={snap}
                onEject={onEject}
                onDrawer={onDrawer}
                onSnapshot={onSnapshot}
                onBrief={onBrief}
                onDetect={onDetect}
                onRefreshCaches={onRefreshCaches}
              />
            )}
            {tab === "schedule" && (
              <ScheduleTab
                configured={configured}
                busy={busy}
                schedules={schedules}
                drafts={scheduleDrafts}
                setDrafts={setScheduleDrafts}
                onSave={onScheduleSave}
                onClear={onScheduleClear}
              />
            )}
            {tab === "logs" && <LogsTab logs={logs} configured={configured} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────── header bits ────────────────────────────

function StatusPills({ status }: { status: DeviceStatus | null }) {
  return (
    <div className="hidden flex-wrap gap-1.5 text-[11px] md:flex">
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
      <Pill
        label="Last"
        value={
          status?.last_cycle
            ? `${status.last_cycle.pill_taken ? "✓" : "✗"} ${status.last_cycle.t_total_ms.toFixed(0)}ms`
            : "—"
        }
      />
    </div>
  );
}

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

function IntakeStrip({ state }: { state: IntakeState | null }) {
  const stepLabels: Record<string, string> = {
    READY: "Take the pill",
    SWALLOW: "Swallow",
    DONE: "Show empty mouth",
  };

  if (!state) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-sand-200 bg-sand-50 px-3 py-1.5 text-[11px] text-gray-500">
        <span className="font-semibold">Intake</span>
        <span>—</span>
      </div>
    );
  }

  const tone =
    state.result === "passed"
      ? "border-status-success-bg bg-status-success-bg text-status-success"
      : state.result === "timeout"
      ? "border-status-danger-bg bg-status-danger-bg text-status-danger"
      : state.running
      ? "border-olive-300 bg-olive-50 text-olive-700"
      : "border-sand-200 bg-sand-50 text-gray-500";

  const headline =
    state.result === "passed"
      ? "✓ Intake confirmed"
      : state.result === "timeout"
      ? "✗ Timed out"
      : state.running
      ? state.instruction
      : "Intake idle — trigger Dispense Now";

  const stepName = state.step_name;
  const niceLabel = stepLabels[stepName] ?? stepName;

  return (
    <div className={`flex items-center gap-3 rounded-xl border px-3 py-1.5 text-[11px] ${tone}`}>
      <span className="font-semibold">Intake</span>
      <span className="font-mono">
        Step {state.step_index + 1}/{state.total_steps} · {niceLabel}
      </span>
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-white/60">
        <div
          className="h-full bg-current transition-[width] duration-100"
          style={{ width: `${Math.round((state.hold_progress ?? 0) * 100)}%` }}
        />
      </div>
      <span className="tabular-nums opacity-70">
        conf {Math.round((state.confidence ?? 0) * 100)}%
      </span>
      <span className="ml-auto truncate">{headline}</span>
    </div>
  );
}

// ──────────────────────────── tabs ────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-b-2 border-olive-700 text-olive-700"
          : "text-gray-500 hover:bg-sand-50"
      }`}
    >
      {children}
    </button>
  );
}

function ControlTab({
  configured,
  busy,
  drawerUnlocked,
  snap,
  onEject,
  onDrawer,
  onSnapshot,
  onBrief,
  onDetect,
  onRefreshCaches,
}: {
  configured: boolean;
  busy: string | null;
  drawerUnlocked: boolean;
  snap: { cam: 0 | 1; url: string } | null;
  onEject: (slot: number) => void;
  onDrawer: (action: "lock" | "unlock") => void;
  onSnapshot: (cam: 0 | 1) => void;
  onBrief: () => void;
  onDetect: () => void;
  onRefreshCaches: () => void;
}) {
  return (
    <div className="space-y-4 text-xs">
      <Section label="Eject slot">
        <div className="grid grid-cols-5 gap-1.5">
          {SLOT_NUMBERS.map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => onEject(slot)}
              disabled={!configured || busy !== null}
              className="h-9 rounded-lg border border-sand-200 bg-white text-sm font-semibold text-gray-700 transition-colors hover:border-olive-400 hover:bg-olive-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === `eject-${slot}` ? "…" : slot}
            </button>
          ))}
        </div>
      </Section>

      <Section
        label="Drawer"
        right={
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              drawerUnlocked
                ? "bg-status-warning-bg text-status-warning"
                : "bg-olive-50 text-olive-700"
            }`}
          >
            {drawerUnlocked ? "UNLOCKED" : "LOCKED"}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          <ActionButton onClick={() => onDrawer("unlock")} disabled={!configured || busy !== null} fullWidth>
            {busy === "drawer-unlock" ? "…" : "Unlock"}
          </ActionButton>
          <ActionButton onClick={() => onDrawer("lock")} disabled={!configured || busy !== null} fullWidth>
            {busy === "drawer-lock" ? "…" : "Lock"}
          </ActionButton>
        </div>
      </Section>

      <Section label="Snapshot">
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <ActionButton onClick={() => onSnapshot(0)} disabled={!configured || busy !== null} fullWidth>
              {busy === "snap-0" ? "…" : "Cam 0"}
            </ActionButton>
            <ActionButton onClick={() => onSnapshot(1)} disabled={!configured || busy !== null} fullWidth>
              {busy === "snap-1" ? "…" : "Cam 1"}
            </ActionButton>
          </div>
          {snap && (
            <div className="overflow-hidden rounded-lg border border-sand-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={snap.url}
                alt={`Cam ${snap.cam}`}
                className="h-16 w-full object-contain"
              />
            </div>
          )}
        </div>
      </Section>

      <Section label="Operations">
        <div className="grid grid-cols-3 gap-1.5">
          <ActionButton onClick={onBrief} disabled={busy !== null} fullWidth>
            {busy === "brief" ? "…" : "Brief"}
          </ActionButton>
          <ActionButton onClick={onDetect} disabled={busy !== null} fullWidth>
            {busy === "detect" ? "…" : "Flags"}
          </ActionButton>
          <ActionButton onClick={onRefreshCaches} disabled={busy !== null} tone="muted" fullWidth>
            Refresh
          </ActionButton>
        </div>
      </Section>
    </div>
  );
}

function ScheduleTab({
  configured,
  busy,
  schedules,
  drafts,
  setDrafts,
  onSave,
  onClear,
}: {
  configured: boolean;
  busy: string | null;
  schedules: ScheduleRow[];
  drafts: Record<number, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  onSave: (slot: number) => void;
  onClear: (slot: number) => void;
}) {
  if (schedules.length === 0) {
    return (
      <p className="py-2 text-xs text-gray-400">
        {configured ? "No medications loaded." : "Configure device to manage schedules."}
      </p>
    );
  }
  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-[11px] text-gray-500">
        Daily HH:MM auto-dispense. Blank = manual-only.
      </p>
      <div className="divide-y divide-sand-100 rounded-lg border border-sand-200">
        {schedules.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center gap-2 px-2 py-1.5"
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-olive-100 text-[10px] font-bold text-olive-700">
              {s.slot}
            </span>
            <span className="min-w-0 flex-1 truncate text-gray-800">
              {s.name ?? <span className="text-gray-400">empty</span>}
            </span>
            <span className="text-[10px] text-gray-400">qty {s.quantity}</span>
            <input
              type="time"
              value={drafts[s.slot] ?? ""}
              onChange={(e) =>
                setDrafts((prev) => ({ ...prev, [s.slot]: e.target.value }))
              }
              disabled={!configured || busy !== null}
              className="rounded-md border border-sand-200 bg-white px-1.5 py-0.5 text-[11px] text-gray-800 outline-none focus:border-olive-500"
            />
            <button
              type="button"
              onClick={() => onSave(s.slot)}
              disabled={!configured || busy !== null}
              className="rounded-full bg-olive-700 px-2.5 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === `sched-${s.slot}` ? "…" : "Save"}
            </button>
            {s.schedule_at && (
              <button
                type="button"
                onClick={() => onClear(s.slot)}
                disabled={!configured || busy !== null}
                className="rounded-full border border-sand-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LogsTab({ logs, configured }: { logs: LogRecord[]; configured: boolean }) {
  if (logs.length === 0) {
    return (
      <p className="py-2 text-center text-xs text-gray-400">
        {configured ? "Waiting for log records…" : "Configure device to see logs."}
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-sand-100 bg-sand-50 font-mono text-[10px] leading-relaxed">
      {logs.map((r, i) => (
        <div
          key={`${r.ts}-${i}`}
          className="grid grid-cols-[52px_46px_1fr] gap-1.5 border-b border-sand-100 px-2 py-0.5 last:border-b-0"
        >
          <span className="text-gray-400">{formatLogTime(r.ts)}</span>
          <span className={`font-semibold ${levelColor(r.level)}`}>{r.level}</span>
          <span className="break-words text-gray-700" title={r.name}>
            {r.message}
          </span>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────── shared bits ────────────────────────────

function Section({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
          {label}
        </p>
        {right}
      </div>
      {children}
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
  tone,
  fullWidth,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  tone?: "danger" | "muted";
  fullWidth?: boolean;
}) {
  const cls =
    tone === "danger"
      ? "border-status-danger bg-white text-status-danger hover:bg-status-danger-bg"
      : tone === "muted"
      ? "border-sand-200 bg-white text-gray-700 hover:bg-sand-50"
      : "border-olive-300 bg-olive-700 text-white hover:bg-olive-800";
  // fullWidth → fill parent (used inside grid cells); default → pill that hugs content.
  const layout = fullWidth
    ? "flex w-full items-center justify-center"
    : "inline-flex items-center gap-1";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${layout} rounded-full border px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}

function CameraTile({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-sand-200 bg-white">
      <div className="flex items-center justify-between border-b border-sand-200 px-3 py-1.5">
        <h2 className="text-xs font-medium text-gray-700 truncate">{label}</h2>
        {url && (
          <span className="rounded-full bg-olive-50 px-2 py-0.5 text-[10px] font-medium text-olive-700">
            LIVE
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        {url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url}
            alt={label}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="text-xs text-gray-400">Stream unavailable</div>
        )}
      </div>
    </div>
  );
}
