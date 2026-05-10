"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  fetchDeviceStatus,
  fetchIntakeState,
  isDeviceConfigured,
  streamUrl,
  triggerDispense,
  type DeviceStatus,
  type IntakeState,
} from "@/lib/device";

export default function DispenserStreamPage() {
  const { id } = useParams<{ id: string }>();
  const dispenserId = String(id);

  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [dispensing, setDispensing] = useState(false);
  const [dispenseMsg, setDispenseMsg] = useState<string | null>(null);
  const [annotate, setAnnotate] = useState(false);
  const [intake, setIntake] = useState<IntakeState | null>(null);

  // Re-key the <img> when the toggle flips so the browser tears down
  // the existing MJPEG connection and opens a fresh one with the new
  // URL. Without re-keying, browsers may keep the old stream alive.
  const cam0Url = streamUrl(0, { annotate });
  const cam1Url = streamUrl(1, { annotate });
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
        setStatusError(
          "Device unreachable — open browser DevTools → Console for the exact reason (env not loaded, ngrok warning, 401, network).",
        );
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Poll intake game state at 4 Hz so the progress bar feels live.
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

      {/* Intake game panel */}
      {intake && <IntakeGamePanel state={intake} />}

      {/* Annotation toggle — overlays model output on BOTH cams */}
      <div className="mb-3 flex items-center gap-2 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-sand-200 bg-white px-3 py-1.5">
          <input
            type="checkbox"
            checked={annotate}
            onChange={(e) => setAnnotate(e.target.checked)}
            className="h-3 w-3"
          />
          <span className="text-gray-700">
            Show model overlay (cam 0 = pill_detector boxes · cam 1 = MediaPipe landmarks)
          </span>
        </label>
        {annotate && (
          <span className="text-gray-400">cam 0 ~5 fps · cam 1 ~10 fps · CPU-heavy</span>
        )}
      </div>

      {/* Live streams */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CameraTile
          key={`cam0-${annotate ? "annot" : "raw"}`}
          label={`Cam 0 — tray${annotate ? " · pill_detector" : ""}`}
          url={cam0Url}
        />
        <CameraTile
          key={`cam1-${annotate ? "annot" : "raw"}`}
          label={`Cam 1 — patient${annotate ? " · MediaPipe FaceMesh + Hands" : ""}`}
          url={cam1Url}
        />
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

function IntakeGamePanel({ state }: { state: IntakeState }) {
  const stepCount = state.total_steps;
  const stepLabels: Record<string, string> = {
    READY: "Take the pill",
    SWALLOW: "Swallow",
    DONE: "Show empty mouth",
  };
  const stepEmojis: Record<string, string> = {
    READY: "✋",
    SWALLOW: "👄",
    DONE: "👅",
  };
  const stepNames = ["READY", "SWALLOW", "DONE"];
  const passedNames = new Set(state.history.map((h) => h.step_name));

  // Banner colour shifts on terminal state.
  const banner =
    state.result === "passed"
      ? "border-status-success-bg bg-status-success-bg text-status-success"
      : state.result === "timeout"
      ? "border-status-danger-bg bg-status-danger-bg text-status-danger"
      : state.running
      ? "border-olive-300 bg-olive-50 text-olive-700"
      : "border-sand-200 bg-sand-50 text-gray-500";

  const headline =
    state.result === "passed"
      ? "✓  Intake confirmed"
      : state.result === "timeout"
      ? "✗  Timed out — try again"
      : state.running
      ? state.instruction
      : "Intake game idle — trigger Dispense Now to start";

  const sub =
    state.running && state.face_visible === false
      ? "Face not detected — sit in front of cam 1"
      : state.running
      ? `face=${state.face_visible ? 1 : 0} hands=${state.hands_count}`
      : null;

  return (
    <div className={`mb-6 overflow-hidden rounded-2xl border ${banner}`}>
      <div className="px-5 py-4">
        <p className="text-xs font-medium uppercase tracking-wider opacity-75">
          Intake verification
        </p>
        <h2 className="font-[family-name:var(--font-display)] text-xl">
          {headline}
        </h2>
        {sub && <p className="mt-1 text-xs opacity-75">{sub}</p>}
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-current border-opacity-20 bg-white p-4">
        {stepNames.map((name, idx) => {
          const isCurrent = idx === state.step_index && state.running && !state.result;
          const isPassed = passedNames.has(name) || (state.result === "passed");
          const dim = state.running ? !isCurrent && !isPassed : !isPassed;
          return (
            <StepCircle
              key={name}
              n={idx + 1}
              total={stepCount}
              emoji={stepEmojis[name]}
              label={stepLabels[name]}
              isCurrent={isCurrent}
              isPassed={isPassed}
              dim={dim}
              progress={isCurrent ? state.hold_progress : isPassed ? 1 : 0}
              confidence={isCurrent ? state.confidence : 0}
            />
          );
        })}
      </div>
    </div>
  );
}

function StepCircle({
  n,
  total: _total,
  emoji,
  label,
  isCurrent,
  isPassed,
  dim,
  progress,
  confidence,
}: {
  n: number;
  total: number;
  emoji: string;
  label: string;
  isCurrent: boolean;
  isPassed: boolean;
  dim: boolean;
  progress: number;
  confidence: number;
}) {
  const tone = isPassed
    ? "bg-status-success-bg text-status-success"
    : isCurrent
    ? "bg-olive-100 text-olive-800 ring-2 ring-olive-400"
    : "bg-sand-50 text-gray-400";
  return (
    <div className={`rounded-2xl p-4 ${dim ? "opacity-50" : ""} ${tone}`}>
      <div className="flex items-center gap-3">
        <span className="text-3xl leading-none">{isPassed ? "✓" : emoji}</span>
        <div className="flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wider opacity-70">
            Step {n}
          </p>
          <p className="text-sm font-semibold">{label}</p>
        </div>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/50">
        <div
          className={`h-full transition-[width] duration-100 ${
            isPassed ? "bg-status-success" : "bg-olive-500"
          }`}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      {isCurrent && (
        <p className="mt-1 text-[10px] tabular-nums opacity-70">
          conf {Math.round(confidence * 100)}% · hold {Math.round(progress * 100)}%
        </p>
      )}
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
