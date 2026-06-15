// Dependency-free SVG trend chart for composite intake confidence over time.
// Points are oldest → newest. Dots are coloured by confidence band.

export type TrendPoint = { t: string; value: number; taken: boolean };

const DOT_HEX = {
  ok: "#46a758",
  warn: "#d9930b",
  fail: "#e5484d",
} as const;

export default function ConfidenceTrendChart({
  points,
}: {
  points: TrendPoint[];
}) {
  const W = 640;
  const H = 200;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const n = points.length;
  const x = (i: number) =>
    padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

  const linePath = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`,
    )
    .join(" ");
  const areaPath =
    n > 0
      ? `${linePath} L ${x(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${x(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
      : "";

  const gridY = [1, 0.85, 0.65, 0.5, 0];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Intake confidence over time"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="confArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6b8e4e" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#6b8e4e" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {gridY.map((g) => (
          <g key={g}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(g)}
              y2={y(g)}
              stroke={g === 0.85 || g === 0.65 ? "#d9930b" : "#e9e4d8"}
              strokeWidth="1"
              strokeDasharray={g === 0.85 || g === 0.65 ? "3 3" : undefined}
              opacity={g === 0.85 || g === 0.65 ? 0.5 : 1}
            />
            <text
              x={padL - 6}
              y={y(g) + 3}
              textAnchor="end"
              className="fill-gray-400"
              style={{ fontSize: 9 }}
            >
              {Math.round(g * 100)}
            </text>
          </g>
        ))}

        {n > 1 && <path d={areaPath} fill="url(#confArea)" />}
        {n > 1 && (
          <path
            d={linePath}
            fill="none"
            stroke="#4a6741"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {points.map((p, i) => {
          const tone = !p.taken
            ? "fail"
            : p.value >= 0.85
            ? "ok"
            : p.value >= 0.65
            ? "warn"
            : "fail";
          return (
            <circle
              key={i}
              cx={x(i)}
              cy={y(p.value)}
              r={n > 30 ? 2.5 : 4}
              fill={DOT_HEX[tone]}
              stroke="#fff"
              strokeWidth="1.5"
            >
              <title>
                {`${new Date(p.t).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })} · ${Math.round(p.value * 100)}%${p.taken ? "" : " · missed"}`}
              </title>
            </circle>
          );
        })}
      </svg>

      {n > 0 && (
        <div className="mt-1 flex justify-between px-[34px] text-[10px] text-gray-400">
          <span>
            {new Date(points[0].t).toLocaleDateString([], {
              month: "short",
              day: "numeric",
            })}
          </span>
          <span>
            {new Date(points[n - 1].t).toLocaleDateString([], {
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-gray-500">
        <Legend hex={DOT_HEX.ok} label="High ≥85%" />
        <Legend hex={DOT_HEX.warn} label="Moderate 65–85%" />
        <Legend hex={DOT_HEX.fail} label="Low / missed" />
      </div>
    </div>
  );
}

function Legend({ hex, label }: { hex: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: hex }}
      />
      {label}
    </span>
  );
}
