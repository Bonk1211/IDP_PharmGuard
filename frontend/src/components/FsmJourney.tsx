// Horizontal swallow-FSM journey tracker — the judge-facing hero of the
// Verify step. Pure render of IntakeState (polled at 250 ms upstream):
// no state, no effects. Step names come from the backend (history rows +
// current step_name); never hardcoded here — the Pi's intake monitor
// (ml/swallow/main5.py spec) owns step naming and ordering.

import type { IntakeState } from "@/lib/device";

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R; // ≈ 138

// Display-only fallback labels, mirroring the documented step set on
// IntakeState.step_name in lib/device.ts ("READY | INSERT | SWALLOW |
// DONE"). Used ONLY when a done step's history row hasn't arrived yet
// (the 250 ms poll can deliver step_index ahead of history) — backend
// names always win once present.
const FALLBACK_STEP_NAMES = ["READY", "INSERT", "SWALLOW", "DONE"];

type StepView = {
  name: string;
  state: "done" | "active" | "failed" | "upcoming";
};

function deriveSteps(intake: IntakeState | null): StepView[] {
  const total = intake?.total_steps && intake.total_steps > 0 ? intake.total_steps : 5;
  const terminalFail =
    intake?.result === "timeout" || intake?.result === "missing_labels";
  const passed = intake?.result === "passed";

  return Array.from({ length: total }, (_, i) => {
    const fromHistory = intake?.history.find((h) => h.step_index === i);
    const name =
      fromHistory?.step_name ??
      (intake && i === intake.step_index
        ? intake.step_name
        : FALLBACK_STEP_NAMES[i] ?? `Step ${i + 1}`);

    let state: StepView["state"] = "upcoming";
    if (passed || (intake && i < intake.step_index) || fromHistory) {
      state = "done";
    } else if (intake?.running && i === intake.step_index) {
      state = "active";
    } else if (terminalFail && i === intake?.step_index) {
      state = "failed";
    }
    return { name, state };
  });
}

function StepCircle({
  step,
  holdProgress,
}: {
  step: StepView;
  holdProgress: number;
}) {
  if (step.state === "done") {
    return (
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-status-success-bg text-status-success">
        <svg width="16" height="16" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path
            className="check-draw"
            d="M2.5 6.5 L5 9 L9.5 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (step.state === "active") {
    const p = Math.min(1, Math.max(0, holdProgress));
    return (
      <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-olive-50 text-olive-700">
        <svg
          className="absolute inset-0 h-full w-full -rotate-90"
          viewBox="0 0 50 50"
          aria-hidden
        >
          <circle
            cx="25"
            cy="25"
            r={RING_R}
            fill="none"
            stroke="var(--color-olive-100)"
            strokeWidth="3"
          />
          <circle
            cx="25"
            cy="25"
            r={RING_R}
            fill="none"
            stroke="var(--color-olive-600)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - p)}
          />
        </svg>
        <span className="font-mono text-[10px] font-bold tabular-nums">
          {Math.round(p * 100)}%
        </span>
      </span>
    );
  }

  if (step.state === "failed") {
    return (
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-status-danger-bg text-base font-bold text-status-danger">
        ✗
      </span>
    );
  }

  return (
    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sand-100 text-sm font-semibold text-gray-400">
      ·
    </span>
  );
}

export default function FsmJourney({ intake }: { intake: IntakeState | null }) {
  const steps = deriveSteps(intake);
  const passed = intake?.result === "passed";
  const failed =
    intake?.result === "timeout" || intake?.result === "missing_labels";

  const headline = passed
    ? "Intake confirmed"
    : failed
    ? intake?.result === "timeout"
      ? "Intake timed out"
      : "Evidence missing"
    : intake?.running
    ? intake.step_label || "Following the patient"
    : "Waiting for the round to start";

  const instruction = passed
    ? `Swallow verified · ${Math.round((intake?.confidence ?? 0) * 100)}% confidence`
    : intake?.running
    ? intake.instruction
    : "Step circles light up as the AI tracks the patient on camera.";

  return (
    <div
      className={`rounded-2xl border bg-white p-4 ${
        passed
          ? "animate-sweep-success border-status-success"
          : failed
          ? "border-status-danger"
          : "border-sand-200"
      }`}
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          AI swallow verification · MediaPipe FSM
        </p>
        {intake?.running && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-status-success">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-success" />
            Live
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-x-1.5 gap-y-3">
        {steps.map((step, i) => (
          <div key={`${step.name}-${i}`} className="flex items-start gap-1.5">
            <div className="flex w-[68px] flex-col items-center gap-1.5">
              <StepCircle
                step={step}
                holdProgress={intake?.hold_progress ?? 0}
              />
              <span
                className={`max-w-full truncate text-center text-[10px] font-semibold uppercase tracking-wider ${
                  step.state === "done"
                    ? "text-status-success"
                    : step.state === "active"
                    ? "text-olive-700"
                    : step.state === "failed"
                    ? "text-status-danger"
                    : "text-gray-400"
                }`}
              >
                {step.name}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={`mt-5 h-px w-6 ${
                  step.state === "done"
                    ? "connector-fill bg-olive-400"
                    : "bg-sand-200"
                }`}
              />
            )}
          </div>
        ))}

        <div className="ml-auto min-w-[180px] flex-1 self-center text-right">
          <p
            className={`text-sm font-semibold ${
              passed
                ? "text-status-success"
                : failed
                ? "text-status-danger"
                : "text-gray-900"
            }`}
          >
            {headline}
          </p>
          <p className="mt-0.5 text-sm text-gray-600">{instruction}</p>
        </div>
      </div>
    </div>
  );
}
