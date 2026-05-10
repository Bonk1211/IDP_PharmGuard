"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import {
  fetchDeviceStatus,
  fetchPiLogs,
  fetchSchedules,
  fetchSnapshot,
  isDeviceConfigured,
  manualEject,
  resetDevice,
  setDrawer,
  setSlotSchedule,
  triggerDispense,
  type DeviceStatus,
  type LogRecord,
  type ScheduleRow,
} from "@/lib/device";
import { refreshBrief, triggerFlagDetection } from "@/lib/agent";
import { KEYS } from "@/lib/swr";

const SLOT_NUMBERS = Array.from({ length: 10 }, (_, i) => i);

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

export default function AdminPage() {
  const { mutate } = useSWRConfig();
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [snap, setSnap] = useState<{ cam: 0 | 1; url: string } | null>(null);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<number, string>>({});
  const prevSnapUrl = useRef<string | null>(null);
  const configured = isDeviceConfigured();

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    async function tick() {
      const s = await fetchDeviceStatus();
      if (alive) setStatus(s);
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [configured]);

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
    setMsg(r.ok ? "Dispense queued." : `Dispense failed: ${r.status}`);
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

  return (
    <div className="space-y-6">
      <div className="animate-fade-up">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Admin
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Hardware control, operations triggers, and live service logs.
        </p>
      </div>

      {!configured && (
        <div className="rounded-2xl border border-status-warning-bg bg-status-warning-bg p-4 text-sm text-status-warning">
          Set <code>NEXT_PUBLIC_DEVICE_URL</code> and{" "}
          <code>NEXT_PUBLIC_DEVICE_API_KEY</code> in{" "}
          <code>frontend/.env.local</code> to enable hardware control.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 rounded-2xl border border-sand-200 bg-white p-5 sm:grid-cols-5">
        <StatusTile
          label="Cycles"
          value={status ? String(status.cycle_n) : "—"}
        />
        <StatusTile
          label="Loop"
          value={status?.task_running ? "running" : "stopped"}
          tone={status?.task_running ? "good" : "bad"}
        />
        <StatusTile
          label="Hardware"
          value={status?.hardware_stubbed ? "stubbed" : "real"}
          tone={status?.hardware_stubbed ? "warn" : "good"}
        />
        <StatusTile
          label="Drawer"
          value={status?.is_unlocked ? "unlocked" : "locked"}
          tone={status?.is_unlocked ? "warn" : "good"}
        />
        <StatusTile
          label="Last cycle"
          value={
            status?.last_cycle
              ? `${status.last_cycle.pill_taken ? "pass" : "fail"} ${status.last_cycle.t_total_ms.toFixed(0)} ms`
              : "—"
          }
        />
      </div>

      {msg && (
        <div className="rounded-2xl border border-sand-200 bg-sand-50 px-4 py-2 text-sm text-gray-700">
          {msg}
        </div>
      )}

      <SectionCard title="System">
        <div className="flex flex-wrap gap-3">
          <ActionButton
            onClick={onReset}
            disabled={!configured || busy !== null}
            tone="danger"
          >
            {busy === "reset" ? "Resetting…" : "Reset loop"}
          </ActionButton>
          <ActionButton
            onClick={onDispense}
            disabled={!configured || busy !== null}
          >
            {busy === "dispense" ? "Dispensing…" : "Dispense now"}
          </ActionButton>
        </div>
      </SectionCard>

      <SectionCard title="Hardware">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium text-gray-500">
              Manual eject from slot
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SLOT_NUMBERS.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  onClick={() => onEject(slot)}
                  disabled={!configured || busy !== null}
                  className="h-9 w-9 rounded-lg border border-sand-200 bg-white text-sm font-semibold text-gray-700 transition-colors hover:border-olive-400 hover:bg-olive-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === `eject-${slot}` ? "…" : slot}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-gray-500">Drawer</p>
            <div className="flex items-center gap-3">
              <ActionButton
                onClick={() => onDrawer("unlock")}
                disabled={!configured || busy !== null}
              >
                {busy === "drawer-unlock" ? "Unlocking…" : "Unlock"}
              </ActionButton>
              <ActionButton
                onClick={() => onDrawer("lock")}
                disabled={!configured || busy !== null}
              >
                {busy === "drawer-lock" ? "Locking…" : "Lock"}
              </ActionButton>
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  status?.is_unlocked
                    ? "bg-status-warning-bg text-status-warning"
                    : "bg-olive-50 text-olive-700"
                }`}
              >
                {status?.is_unlocked ? "UNLOCKED" : "LOCKED"}
              </span>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-gray-500">Snapshots</p>
            <div className="flex flex-wrap items-start gap-3">
              <ActionButton
                onClick={() => onSnapshot(0)}
                disabled={!configured || busy !== null}
              >
                {busy === "snap-0" ? "Snapping…" : "Cam 0 (tray)"}
              </ActionButton>
              <ActionButton
                onClick={() => onSnapshot(1)}
                disabled={!configured || busy !== null}
              >
                {busy === "snap-1" ? "Snapping…" : "Cam 1 (intake)"}
              </ActionButton>
              {snap && (
                <div className="overflow-hidden rounded-lg border border-sand-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={snap.url}
                    alt={`Cam ${snap.cam} snapshot`}
                    className="h-32 w-auto object-contain"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Operations">
        <div className="flex flex-wrap gap-3">
          <ActionButton onClick={onBrief} disabled={busy !== null}>
            {busy === "brief" ? "Generating…" : "Generate brief now"}
          </ActionButton>
          <ActionButton onClick={onDetect} disabled={busy !== null}>
            {busy === "detect" ? "Running…" : "Run flag detection now"}
          </ActionButton>
          <ActionButton onClick={onRefreshCaches} disabled={busy !== null} tone="muted">
            Refresh inventory caches
          </ActionButton>
        </div>
      </SectionCard>

      <SectionCard title="Schedule (per-slot daily auto-dispense)">
        {schedules.length === 0 ? (
          <p className="py-2 text-sm text-gray-400">
            {configured ? "No medications loaded." : "Configure device to manage schedules."}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Set a daily HH:MM. The cycle will auto-dispense at that time
              within a 1-minute window. Leave blank for manual-only.
            </p>
            <div className="divide-y divide-sand-100 rounded-lg border border-sand-200">
              {schedules.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-olive-100 text-xs font-bold text-olive-700">
                    {s.slot}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-gray-800">
                    {s.name ?? <span className="text-gray-400">empty</span>}
                  </span>
                  <span className="text-[11px] text-gray-400">
                    qty {s.quantity}
                  </span>
                  <input
                    type="time"
                    value={scheduleDrafts[s.slot] ?? ""}
                    onChange={(e) =>
                      setScheduleDrafts((prev) => ({
                        ...prev,
                        [s.slot]: e.target.value,
                      }))
                    }
                    disabled={!configured || busy !== null}
                    className="rounded-lg border border-sand-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-olive-500"
                  />
                  <button
                    type="button"
                    onClick={() => onScheduleSave(s.slot)}
                    disabled={!configured || busy !== null}
                    className="rounded-full bg-olive-700 px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === `sched-${s.slot}` ? "Saving…" : "Save"}
                  </button>
                  {s.schedule_at && (
                    <button
                      type="button"
                      onClick={() => onScheduleClear(s.slot)}
                      disabled={!configured || busy !== null}
                      className="rounded-full border border-sand-200 bg-white px-3 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-sand-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Clear
                    </button>
                  )}
                  {s.schedule_at && (
                    <span className="rounded-full bg-olive-50 px-2 py-0.5 font-mono text-[10px] text-olive-700">
                      live: {s.schedule_at.slice(0, 5)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={`Service logs (${logs.length} records)`}>
        {logs.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">
            {configured ? "Waiting for log records…" : "Configure device to see logs."}
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border border-sand-100 bg-sand-50 font-mono text-[11px] leading-relaxed">
            {logs.map((r, i) => (
              <div
                key={`${r.ts}-${i}`}
                className="grid grid-cols-[64px_60px_140px_1fr] gap-2 border-b border-sand-100 px-3 py-1 last:border-b-0"
              >
                <span className="text-gray-400">{formatLogTime(r.ts)}</span>
                <span className={`font-semibold ${levelColor(r.level)}`}>
                  {r.level}
                </span>
                <span className="truncate text-gray-500" title={r.name}>
                  {r.name}
                </span>
                <span className="break-words text-gray-700">{r.message}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
      {children}
    </div>
  );
}

function StatusTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "warn";
}) {
  const colour =
    tone === "good"
      ? "text-status-success"
      : tone === "bad"
      ? "text-status-danger"
      : tone === "warn"
      ? "text-status-warning"
      : "text-gray-900";
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-lg font-semibold ${colour}`}>{value}</p>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
  tone,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  tone?: "danger" | "muted";
}) {
  const cls =
    tone === "danger"
      ? "border-status-danger bg-white text-status-danger hover:bg-status-danger-bg"
      : tone === "muted"
      ? "border-sand-200 bg-white text-gray-700 hover:bg-sand-50"
      : "border-olive-300 bg-olive-700 text-white hover:bg-olive-800";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}
