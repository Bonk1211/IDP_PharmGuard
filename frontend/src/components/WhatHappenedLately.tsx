"use client";

// Single rollup card the nurse opens to catch up on the last 48h.
// Buckets: Missed Doses · Successful Intakes · Inventory · Active Flags.
// Sources: useLogs (adherence_logs) · useSlots (medications) · useAlerts
// · useOpenFlags. Empty/clean states render as "all clear" copy.

import { useAlerts, useLogs, useOpenFlags, useSlots } from "@/lib/swr";
import type { Alert, IntakeRecord, SlotInfo } from "@/lib/api";
import type { AgentFlag } from "@/lib/agent";

const LOOKBACK_HOURS = 48;
const LOW_STOCK_THRESHOLD = 3;
const LOOKBACK_MS = LOOKBACK_HOURS * 60 * 60 * 1000;

type Bucket = {
  title: string;
  body: string;
};

function patientName(r: { patient?: { name?: string | null } | null; patient_id?: number }): string {
  return r.patient?.name ?? `Patient #${r.patient_id ?? "?"}`;
}

function recent(logs: IntakeRecord[]): IntakeRecord[] {
  const cutoff = Date.now() - LOOKBACK_MS;
  return logs.filter((l) => {
    const t = new Date(l.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

function pluralS(n: number): string {
  return n === 1 ? "" : "s";
}

function describeMissed(logs: IntakeRecord[]): string {
  const missed = recent(logs).filter((l) => !l.pill_taken);
  if (missed.length === 0) {
    return `No missed doses in the last ${LOOKBACK_HOURS}h. Adherence holding.`;
  }

  // logs are returned newest-first by fetchLogs.
  const byPatient = new Map<string, IntakeRecord[]>();
  for (const r of missed) {
    const key = patientName(r);
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key)!.push(r);
  }

  const lines: string[] = [];
  const top = [...byPatient.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);
  for (const [name, list] of top) {
    const newest = list[0];
    const when = formatShortTime(newest.timestamp);
    if (list.length > 1) {
      lines.push(`${name} skipped slot ${newest.slot} ${list.length}× (latest ${when}).`);
    } else {
      lines.push(`${name} skipped slot ${newest.slot} on ${when}.`);
    }
  }

  return `${missed.length} missed dose${pluralS(missed.length)} in the last ${LOOKBACK_HOURS}h. ${lines.join(" ")}`;
}

function describeIntakes(logs: IntakeRecord[]): string {
  const taken = recent(logs).filter((l) => l.pill_taken);
  if (taken.length === 0) {
    return `No confirmed intakes in the last ${LOOKBACK_HOURS}h.`;
  }
  const withConf = taken.filter((l) => l.confidence_score != null);
  const avgConf =
    withConf.length === 0
      ? null
      : withConf.reduce((acc, l) => acc + (l.confidence_score ?? 0), 0) / withConf.length;
  const distinctPatients = new Set(taken.map((l) => l.patient_id)).size;

  const newest = taken[0];
  const headline = newest
    ? `Latest: ${patientName(newest)} confirmed slot ${newest.slot} at ${formatShortTime(newest.timestamp)}.`
    : "";
  const confLine = avgConf !== null ? ` Avg confidence ${avgConf.toFixed(2)}.` : "";

  return `${taken.length} confirmed intake${pluralS(taken.length)} across ${distinctPatients} patient${pluralS(distinctPatients)}.${confLine} ${headline}`.trim();
}

function describeInventory(slots: SlotInfo[], alerts: Alert[]): string {
  const assigned = slots.filter((s) => s.name);
  const low = assigned.filter((s) => s.quantity > 0 && s.quantity <= LOW_STOCK_THRESHOLD);
  const empty = assigned.filter((s) => s.quantity === 0);
  const expiry = alerts.filter((a) => a.kind === "expiry");

  if (low.length === 0 && empty.length === 0 && expiry.length === 0) {
    return "Inventory healthy. No low-stock, empty, or expiring meds.";
  }

  const parts: string[] = [];
  if (low.length > 0) {
    const top = low
      .slice(0, 2)
      .map((s) => `${s.name} slot ${s.slot} (${s.quantity} left)`)
      .join(", ");
    parts.push(`${low.length} low: ${top}.`);
  }
  if (empty.length > 0) {
    const sample = empty
      .slice(0, 2)
      .map((s) => `slot ${s.slot} (${s.name})`)
      .join(", ");
    parts.push(`${empty.length} empty: ${sample}.`);
  }
  if (expiry.length > 0) {
    parts.push(`${expiry.length} expiry alert${pluralS(expiry.length)} pending review.`);
  }
  return parts.join(" ");
}

function describeFlags(flags: AgentFlag[]): string {
  if (flags.length === 0) {
    return "No open flags. Detection runs on the brief schedule.";
  }
  const top = flags.slice(0, 2).map((f) => f.title).join(" · ");
  return `${flags.length} open flag${pluralS(flags.length)}: ${top}.`;
}

function newestTimestamp(...lists: { timestamp?: string; created_at?: string }[][]): Date | null {
  let best = -Infinity;
  for (const list of lists) {
    for (const r of list) {
      const ts = r.timestamp ?? r.created_at;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (Number.isFinite(t) && t > best) best = t;
    }
  }
  return best === -Infinity ? null : new Date(best);
}

export default function WhatHappenedLately() {
  const { data: logs = [] } = useLogs();
  const { data: slots = [] } = useSlots();
  const { data: alerts = [] } = useAlerts();
  const { data: flags = [] } = useOpenFlags();

  const buckets: Bucket[] = [
    { title: "Missed Doses",       body: describeMissed(logs) },
    { title: "Successful Intakes", body: describeIntakes(logs) },
    { title: "Inventory",          body: describeInventory(slots, alerts) },
    { title: "Active Flags",       body: describeFlags(flags) },
  ];

  // Last sync = newest timestamped record across the time-bearing sources,
  // falls back to now. SlotInfo has no timestamp column, so we skip it.
  const newest = newestTimestamp(logs, alerts, flags) ?? new Date();

  return (
    <section className="mb-8">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-xl text-gray-900">
          What Happened Lately
        </h2>
        <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Last sync: {formatLastSync(newest)}
        </span>
        <div className="h-px flex-1 bg-sand-200" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {buckets.map((b) => (
          <article
            key={b.title}
            className="rounded-2xl border border-sand-200 bg-white p-5"
          >
            <h3 className="mb-2 text-base font-semibold text-olive-700">
              {b.title}
            </h3>
            <p className="text-sm leading-relaxed text-gray-700">{b.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatShortTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const day = d.getDate();
  const month = d.toLocaleString("en", { month: "short" });
  return `${month} ${day} ${hh}:${mm}`;
}

function formatLastSync(d: Date): string {
  const day = d.getDate();
  const month = d.toLocaleString("en", { month: "short" }).toUpperCase();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${month} · ${hh}:${mm}`;
}
