"use client";

// Count-up confidence/similarity gauge: big animated numeral + thick bar
// with an optional threshold tick. Used by the face-verify and pill-verify
// verdict surfaces on the guided dispense page.

import { useEffect, useState } from "react";

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export default function ConfidenceGauge({
  value,
  threshold,
  label,
  tone,
}: {
  value: number;
  threshold?: number;
  label: string;
  // "neutral" = detection without a pass/fail verdict (e.g. no expected
  // medication to match against) — olive, neither success nor danger.
  tone: "ok" | "fail" | "neutral";
}) {
  const target = clamp(value);
  const tick = threshold != null ? clamp(threshold) : null;
  const [shown, setShown] = useState(0);

  // rAF count-up 0 → target over ~800 ms with cubic ease-out. Re-runs when
  // the target changes (re-verify), cancels on unmount.
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const duration = 800;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(target * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const toneText =
    tone === "ok"
      ? "text-status-success"
      : tone === "fail"
      ? "text-status-danger"
      : "text-gray-900";
  const toneFill =
    tone === "ok"
      ? "bg-status-success"
      : tone === "fail"
      ? "bg-status-danger"
      : "bg-olive-400";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          {label}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span
            className={`font-[family-name:var(--font-display)] text-3xl tabular-nums leading-none ${toneText}`}
          >
            {shown.toFixed(1)}%
          </span>
          {tick != null && (
            <span className="text-[11px] text-gray-400">
              / {tick}% required
            </span>
          )}
        </span>
      </div>
      <div className="relative mt-2 h-2.5 overflow-hidden rounded-full bg-sand-100">
        <div
          className={`animate-bar-grow h-full rounded-full transition-[width] duration-700 ease-out ${toneFill}`}
          style={{ width: `${target}%` }}
        />
        {tick != null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-gray-700"
            style={{ left: `${tick}%` }}
            title={`threshold ${tick}%`}
          />
        )}
      </div>
    </div>
  );
}
