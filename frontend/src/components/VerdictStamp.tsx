// Animated verdict banner for the three AI verification moments (face,
// pill, intake). Pure presentational — replay the pop animation by
// remounting (pass a changing `key` from the caller); no internal state.

type VerdictTone = "ok" | "fail" | "warn";

const TONE = {
  ok: {
    ring: "border-status-success bg-status-success-bg text-status-success",
    headline: "text-status-success",
  },
  fail: {
    ring: "border-status-danger bg-status-danger-bg text-status-danger",
    headline: "text-status-danger",
  },
  warn: {
    ring: "border-status-warning bg-status-warning-bg text-status-warning",
    headline: "text-status-warning",
  },
} as const;

function VerdictIcon({ tone }: { tone: VerdictTone }) {
  if (tone === "ok") {
    return (
      <svg width="26" height="26" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          className="check-draw"
          d="M2.5 6.5 L5 9 L9.5 3.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tone === "fail") {
    return (
      <svg width="24" height="24" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          className="cross-draw"
          d="M3 3 L9 9 M9 3 L3 9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return <span className="text-2xl font-bold leading-none">!</span>;
}

export default function VerdictStamp({
  tone,
  headline,
  sub,
  size = "md",
  className = "",
}: {
  tone: VerdictTone;
  headline: string;
  sub?: string;
  size?: "md" | "lg";
  className?: string;
}) {
  const t = TONE[tone];

  const banner = (
    <div
      className={`animate-verdict-pop flex items-center gap-4 rounded-2xl border-2 bg-white/95 px-6 py-4 shadow-[0_12px_32px_-12px_rgba(45,55,30,0.35)] ${t.ring} ${
        size === "lg" ? "" : className
      }`}
      role="status"
    >
      <span
        className={`flex shrink-0 items-center justify-center rounded-full border-2 bg-white ${t.ring} ${
          size === "lg" ? "h-14 w-14" : "h-11 w-11"
        }`}
        aria-hidden
      >
        <VerdictIcon tone={tone} />
      </span>
      <div className="min-w-0">
        <p
          className={`font-[family-name:var(--font-display)] uppercase tracking-[0.12em] ${t.headline} ${
            size === "lg" ? "text-2xl" : "text-lg"
          }`}
        >
          {headline}
        </p>
        {sub && (
          <p className="mt-0.5 truncate text-sm font-medium text-gray-700">
            {sub}
          </p>
        )}
      </div>
    </div>
  );

  if (size === "lg") {
    // Anchored to the bottom edge with a bottom-up gradient scrim so the
    // evidence above (bbox / annotated detections) stays visible — the
    // Rekognition face box is almost always frame-centered.
    return (
      <div
        className={`pointer-events-none absolute inset-0 z-10 flex items-end justify-center bg-gradient-to-t from-white/85 via-white/20 to-transparent p-4 ${className}`}
      >
        {banner}
      </div>
    );
  }

  return banner;
}
