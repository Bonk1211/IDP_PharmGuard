"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  fetchDeviceStatus,
  isDeviceConfigured,
  streamUrl,
  triggerDispense,
  type DeviceStatus,
} from "@/lib/device";

export default function DispenserStreamPage() {
  const { id } = useParams<{ id: string }>();
  const dispenserId = String(id);

  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [dispensing, setDispensing] = useState(false);
  const [dispenseMsg, setDispenseMsg] = useState<string | null>(null);
  const [annotate, setAnnotate] = useState(false);

  // Re-key the <img> when the toggle flips so the browser tears down
  // the existing MJPEG connection and opens a fresh one with the new
  // URL. Without re-keying, browsers may keep the old stream alive.
  const cam0Url = streamUrl(0, { annotate });
  const cam1Url = streamUrl(1);
  const configured = isDeviceConfigured();

  // Poll /status every 3 s so cycle_n / last_cycle stay fresh.
  useEffect(() => {
    let alive = true;
    async function tick() {
      const s = await fetchDeviceStatus();
      if (!alive) return;
      if (s) {
        setStatus(s);
        setStatusError(null);
      } else {
        setStatusError("Device unreachable. Check NEXT_PUBLIC_DEVICE_URL.");
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function handleDispenseNow() {
    setDispensing(true);
    setDispenseMsg(null);
    const r = await triggerDispense();
    setDispensing(false);
    if (r.ok) {
      setDispenseMsg("Queued — Pi will run the next cycle now.");
    } else if (r.status === 0) {
      setDispenseMsg("Cannot reach device.");
    } else {
      setDispenseMsg(`Device returned ${r.status}.`);
    }
  }

  return (
    <div>
      <Link
        href="/"
        className="animate-fade-in mb-4 inline-flex items-center gap-1.5 text-sm text-gray-400 transition-colors hover:text-gray-600"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to Dashboard
      </Link>

      <div className="mb-6 flex items-end justify-between">
        <div>
          <p className="text-xs font-medium text-olive-500">Dispenser</p>
          <h1 className="font-[family-name:var(--font-display)] text-2xl text-gray-900">
            {dispenserId}
          </h1>
        </div>
        <button
          onClick={handleDispenseNow}
          disabled={!configured || dispensing}
          className="inline-flex items-center gap-1 rounded-full border border-olive-300 bg-olive-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-olive-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {dispensing ? "Dispensing..." : "Dispense Now"}
        </button>
      </div>

      {!configured && (
        <div className="mb-6 rounded-2xl border border-status-warning-bg bg-status-warning-bg p-4 text-sm text-status-warning">
          Set <code>NEXT_PUBLIC_DEVICE_URL</code> and{" "}
          <code>NEXT_PUBLIC_DEVICE_API_KEY</code> in <code>frontend/.env.local</code>{" "}
          to enable the live stream.
        </div>
      )}

      {statusError && configured && (
        <div className="mb-6 rounded-2xl border border-status-danger-bg bg-status-danger-bg p-4 text-sm text-status-danger">
          {statusError}
        </div>
      )}

      {dispenseMsg && (
        <div className="mb-6 rounded-2xl border border-sand-200 bg-sand-50 p-4 text-sm text-gray-700">
          {dispenseMsg}
        </div>
      )}

      {/* Status card */}
      {status && (
        <div className="mb-6 grid grid-cols-2 gap-4 rounded-2xl border border-sand-200 bg-white p-5 sm:grid-cols-4">
          <StatusTile label="Cycles" value={String(status.cycle_n)} />
          <StatusTile
            label="Loop"
            value={status.task_running ? "running" : "stopped"}
            tone={status.task_running ? "good" : "bad"}
          />
          <StatusTile
            label="Hardware"
            value={status.hardware_stubbed ? "stubbed" : "real"}
            tone={status.hardware_stubbed ? "warn" : "good"}
          />
          <StatusTile
            label="Last cycle"
            value={
              status.last_cycle
                ? `${status.last_cycle.pill_taken ? "✓" : "✗"} ${status.last_cycle.t_total_ms.toFixed(0)} ms`
                : "—"
            }
          />
        </div>
      )}

      {/* Annotation toggle — affects cam 0 only */}
      <div className="mb-3 flex items-center gap-2 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-sand-200 bg-white px-3 py-1.5">
          <input
            type="checkbox"
            checked={annotate}
            onChange={(e) => setAnnotate(e.target.checked)}
            className="h-3 w-3"
          />
          <span className="text-gray-700">Show YOLO spotter overlay (cam 0)</span>
        </label>
        {annotate && (
          <span className="text-gray-400">~5 fps · YOLO inference is CPU-heavy</span>
        )}
      </div>

      {/* Live streams */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CameraTile
          key={`cam0-${annotate ? "annot" : "raw"}`}
          label={`Cam 0 — tray (pill ID)${annotate ? " · annotated" : ""}`}
          url={cam0Url}
        />
        <CameraTile label="Cam 1 — patient-facing (intake)" url={cam1Url} />
      </div>

      <p className="mt-6 text-xs text-gray-400">
        Streams are MJPEG over the ngrok tunnel. If a frame freezes, the connection dropped — refresh the page to reconnect.
        The free-tier ngrok shows a one-time interstitial; if you see a warning page in place of the stream,{" "}
        open the ngrok URL directly in a new tab once to dismiss it, then reload here.
      </p>
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

function CameraTile({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-sand-200 bg-white">
      <div className="flex items-center justify-between border-b border-sand-200 px-4 py-2">
        <h2 className="text-sm font-medium text-gray-700">{label}</h2>
        {url && (
          <span className="rounded-full bg-olive-50 px-2 py-0.5 text-[10px] font-medium text-olive-700">
            LIVE
          </span>
        )}
      </div>
      <div className="bg-black aspect-video w-full">
        {url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url}
            alt={label}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-gray-400">
            Stream unavailable
          </div>
        )}
      </div>
    </div>
  );
}
