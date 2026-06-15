"use client";

// Live cognitive-behaviour reasoning feed for the intake (Verify) step.
//
// Streams reasoning in real time off the polled intake state — no network
// round-trip, so it updates the instant a label lands or the FSM advances:
//   1) gather   — every label the camera reports, gate objects highlighted
//   2) score    — swallow / object / gaze → one composite confidence
//   3) critique — does NOT blindly trust MediaPipe: cross-checks the motion
//                 verdict against corroborating evidence, then recommends
//                 what would make the verification stronger.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IntakeState } from "@/lib/device";
import {
  compositeConfidence,
  confidenceBand,
  signalsFromLive,
  SIGNAL_META,
  type IntakeSignals,
} from "@/lib/intakeConfidence";

type Cat = "gather" | "score" | "critique" | "recommend";
type Tone = "info" | "ok" | "warn" | "alert";
type Obs = { id: string; cat: Cat; tone: Tone; text: string };

const CAT_META: Record<Cat, { label: string; chip: string }> = {
  gather: { label: "Gather", chip: "bg-sand-100 text-gray-600" },
  score: { label: "Score", chip: "bg-olive-50 text-olive-700" },
  critique: { label: "Critique", chip: "bg-indigo-50 text-indigo-700" },
  recommend: { label: "Improve", chip: "bg-amber-50 text-amber-700" },
};

const TONE_DOT: Record<Tone, string> = {
  info: "bg-gray-300",
  ok: "bg-status-success",
  warn: "bg-status-warning",
  alert: "bg-status-danger",
};

function buildObservations(
  intake: IntakeState | null,
  signals: IntakeSignals,
  composite: number,
): Obs[] {
  if (!intake) return [];
  const obs: Obs[] = [];
  const req = intake.labels_required ?? [];
  const seenAt = intake.labels_seen_at ?? {};
  const seen = intake.labels_seen ?? [];
  const matched = req.filter((r) => r in seenAt);
  const mpDone = intake.mediapipe_complete;
  const sat = intake.labels_satisfied;
  const started = intake.running || seen.length > 0 || mpDone || !!intake.result;
  if (!started) return [];

  // 1) GATHER
  obs.push({
    id: "g_start",
    cat: "gather",
    tone: "info",
    text: "Watching the patient — gathering camera evidence in real time.",
  });
  for (const lbl of seen) {
    const gate = req.includes(lbl.toLowerCase());
    obs.push({
      id: `g_${lbl}`,
      cat: "gather",
      tone: gate ? "ok" : "info",
      text: gate
        ? `Gate object detected: ${lbl} — this is what an intake should show.`
        : `Context label seen: ${lbl}.`,
    });
  }

  // 2) SCORE
  if (signals.swallow > 0) {
    obs.push({
      id: "s_swallow",
      cat: "score",
      tone: "info",
      text: `Swallow-motion signal ${Math.round(signals.swallow * 100)}% — ${SIGNAL_META.swallow.note}`,
    });
  }
  obs.push({
    id: "s_object",
    cat: "score",
    tone: sat ? "ok" : "warn",
    text: `Object evidence ${Math.round(signals.objectEvidence * 100)}% — ${matched.length}/${req.length} gate labels confirmed.`,
  });
  obs.push({
    id: "s_gaze",
    cat: "score",
    tone: "info",
    text: `Gaze fixation ${Math.round(signals.gaze * 100)}% — attention/intent proxy (eye–mind hypothesis).`,
  });
  const band = confidenceBand(composite);
  obs.push({
    id: "s_composite",
    cat: "score",
    tone: band.tone === "fail" ? "alert" : band.tone === "warn" ? "warn" : "ok",
    text: `Composite intake confidence ${Math.round(composite * 100)}% — ${band.label}.`,
  });

  // 3) CRITIQUE — never trust MediaPipe motion on its own
  if (mpDone && !sat) {
    obs.push({
      id: "c_mp_only",
      cat: "critique",
      tone: "alert",
      text:
        "MediaPipe reports the swallow finished, but no cup/pill object is " +
        "confirmed. Motion alone can be mimicked — chewing, talking, or a dry " +
        "swallow all look similar. Holding this as UNVERIFIED until an object corroborates.",
    });
  }
  if (mpDone && sat && composite >= 0.85) {
    obs.push({
      id: "c_agree",
      cat: "critique",
      tone: "ok",
      text:
        "MediaPipe motion and object evidence agree — two independent channels " +
        "corroborate the same event. Safe to auto-confirm.",
    });
  }
  if (composite < 0.65 && started) {
    obs.push({
      id: "c_low",
      cat: "critique",
      tone: "warn",
      text:
        "Composite is below the trust threshold — recommend a human check " +
        "before logging this dose as taken.",
    });
  }
  if (intake.result === "timeout") {
    obs.push({
      id: "c_timeout",
      cat: "critique",
      tone: "alert",
      text:
        "The FSM timed out before completing — re-prompt the patient and retry; " +
        "do not assume the pill was taken.",
    });
  }

  // RECOMMENDATIONS — what would make the verdict stronger
  if (req.length > 0 && matched.length < req.length && started) {
    obs.push({
      id: "r_angle",
      cat: "recommend",
      tone: "info",
      text: `Only ${matched.length}/${req.length} gate objects seen — a clearer top-down angle on the cup/pill would lift object evidence.`,
    });
  }
  if (mpDone && !sat) {
    obs.push({
      id: "r_corro",
      cat: "recommend",
      tone: "info",
      text: "Require at least one object label before accepting a MediaPipe swallow, so motion can never auto-confirm on its own.",
    });
  }
  obs.push({
    id: "r_gaze",
    cat: "recommend",
    tone: "info",
    text: "A dedicated gaze tracker would confirm the patient watched the pill to their mouth — attention is far harder to fake than motion.",
  });

  return obs;
}

export default function IntakeReasoningStream({
  intake,
}: {
  intake: IntakeState | null;
}) {
  const signals = useMemo(() => signalsFromLive(intake), [intake]);
  const composite = useMemo(() => compositeConfidence(signals), [signals]);
  const obs = useMemo(
    () => buildObservations(intake, signals, composite),
    [intake, signals, composite],
  );
  const byId = useMemo(() => {
    const m = new Map<string, Obs>();
    for (const o of obs) m.set(o.id, o);
    return m;
  }, [obs]);

  const [shownIds, setShownIds] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const startedAt = intake?.started_at ?? null;
  const prevStart = useRef<number | null>(null);

  // Reset the feed when a new intake run begins.
  useEffect(() => {
    if (startedAt !== prevStart.current) {
      prevStart.current = startedAt;
      setShownIds([]);
      queueRef.current = [];
    }
  }, [startedAt]);

  // Enqueue any newly-applicable observation ids.
  useEffect(() => {
    const have = new Set(shownIds);
    const queued = new Set(queueRef.current);
    for (const o of obs) {
      if (!have.has(o.id) && !queued.has(o.id)) queueRef.current.push(o.id);
    }
  }, [obs, shownIds]);

  // Drain the queue one item at a time so the feed "streams" even when several
  // observations become true on the same poll.
  useEffect(() => {
    const t = setInterval(() => {
      if (queueRef.current.length === 0) return;
      const next = queueRef.current.shift()!;
      setShownIds((prev) => (prev.includes(next) ? prev : [...prev, next]));
    }, 550);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [shownIds]);

  const band = confidenceBand(composite);
  const pct = Math.round(composite * 100);
  const barTone =
    band.tone === "ok"
      ? "bg-status-success"
      : band.tone === "warn"
      ? "bg-status-warning"
      : "bg-status-danger";
  const pending = queueRef.current.length > 0 || (intake?.running ?? false);

  if (obs.length === 0) {
    return (
      <div className="rounded-2xl border border-sand-200 bg-white p-4 text-xs text-gray-500">
        <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Reasoning
        </p>
        Waiting for the intake to start — reasoning will stream here live.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Live reasoning{" "}
          {pending && <span className="text-olive-500">• streaming</span>}
        </p>
        <span className="text-[10px] text-gray-400">swallow · object · gaze</span>
      </div>

      {/* Live composite confidence */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between">
          <span
            className={`font-[family-name:var(--font-display)] text-2xl ${
              band.tone === "ok"
                ? "text-status-success"
                : band.tone === "warn"
                ? "text-status-warning"
                : "text-status-danger"
            }`}
          >
            {pct}%
          </span>
          <span className="text-[11px] text-gray-500">{band.label}</span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-sand-100">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barTone}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Streaming reasoning feed */}
      <div
        ref={feedRef}
        className="max-h-56 space-y-1.5 overflow-y-auto pr-1"
        aria-live="polite"
      >
        {shownIds.map((id) => {
          const o = byId.get(id);
          if (!o) return null;
          const cm = CAT_META[o.cat];
          return (
            <div
              key={id}
              className="flex items-start gap-2 text-[11px] leading-snug"
            >
              <span
                className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[o.tone]}`}
                aria-hidden
              />
              <span
                className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${cm.chip}`}
              >
                {cm.label}
              </span>
              <span
                className={
                  o.tone === "alert"
                    ? "text-status-danger"
                    : o.tone === "warn"
                    ? "text-status-warning"
                    : "text-gray-700"
                }
              >
                {o.text}
              </span>
            </div>
          );
        })}
        {pending && queueRef.current.length > 0 && (
          <div className="flex items-center gap-1.5 pl-1 text-[11px] text-gray-400">
            <span className="inline-block animate-spin text-olive-400">◐</span>
            analyzing…
          </div>
        )}
      </div>
    </div>
  );
}
