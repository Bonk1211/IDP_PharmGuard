"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { IntakeRecord, Patient, SlotInfo } from "@/lib/api";
import { formatRelative } from "@/lib/date";
import { useLogs, usePatients, useSlots } from "@/lib/swr";

type Room = "common" | "icu";

type BedSlot = {
  key: string;
  room: Room;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

const BEDS: BedSlot[] = [
  { key: "dispenser-001", room: "common", label: "Bed 1", x: 60, y: 70, w: 100, h: 70 },
  { key: "dispenser-002", room: "common", label: "Bed 2", x: 180, y: 70, w: 100, h: 70 },
  { key: "dispenser-003", room: "common", label: "Bed 3", x: 300, y: 70, w: 100, h: 70 },
  { key: "dispenser-004", room: "common", label: "Bed 4", x: 60, y: 200, w: 100, h: 70 },
  { key: "dispenser-005", room: "common", label: "Bed 5", x: 180, y: 200, w: 100, h: 70 },
  { key: "dispenser-006", room: "common", label: "Bed 6", x: 300, y: 200, w: 100, h: 70 },
  { key: "dispenser-007", room: "icu", label: "Isolation", x: 540, y: 130, w: 200, h: 100 },
];

const ROOM_RECTS = {
  common: { x: 30, y: 40, w: 400, h: 290, label: "Common Room" },
  icu: { x: 480, y: 40, w: 290, h: 290, label: "ICU · Isolation" },
} as const;

const SVG_VIEW_W = 800;
const SVG_VIEW_H = 380;

type BedView = {
  slot: BedSlot;
  patient: Patient | null;
  adherenceToday: { taken: number; total: number; pct: number | null };
  lastIntake: IntakeRecord | null;
  nextMed: SlotInfo | null;
};

function getInitials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase();
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

type AvatarPalette = { fill: string; stroke: string; ring: string };

function avatarPalette(v: BedView): AvatarPalette {
  if (!v.patient) {
    return { fill: "#f3f4f6", stroke: "#d1d5db", ring: "#e5e7eb" };
  }
  const pct = v.adherenceToday.pct;
  if (pct === null) {
    return { fill: "#f5f5f4", stroke: "#a8a29e", ring: "#d6d3d1" };
  }
  if (pct >= 90) return { fill: "#ecf3e3", stroke: "#4a6741", ring: "#4a6741" };
  if (pct >= 60) return { fill: "#fef3c7", stroke: "#b45309", ring: "#b45309" };
  return { fill: "#fee2e2", stroke: "#b91c1c", ring: "#b91c1c" };
}

export default function FloorMap() {
  const { data: patients = [] } = usePatients();
  const { data: logs = [] } = useLogs();
  const { data: slots = [] } = useSlots();
  const router = useRouter();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const bedViews: BedView[] = useMemo(() => {
    const today = new Date().toDateString();
    const byKey = new Map<string, Patient>();
    for (const p of patients) {
      const k = norm(p.dispenser_id);
      if (k) byKey.set(k, p);
    }
    return BEDS.map((slot) => {
      const patient = byKey.get(slot.key) ?? null;
      let taken = 0;
      let total = 0;
      let lastIntake: IntakeRecord | null = null;
      if (patient) {
        for (const l of logs) {
          if (l.patient_id !== patient.id) continue;
          const d = new Date(l.timestamp);
          if (d.toDateString() === today) {
            total++;
            if (l.pill_taken) taken++;
          }
          if (
            !lastIntake ||
            d.getTime() > new Date(lastIntake.timestamp).getTime()
          ) {
            lastIntake = l;
          }
        }
      }
      const pct = total > 0 ? Math.round((taken / total) * 100) : null;
      const nextMed = patient
        ? slots
            .filter((s) => s.patient_id === patient.id && s.quantity > 0)
            .sort((a, b) => a.slot - b.slot)[0] ?? null
        : null;
      return {
        slot,
        patient,
        adherenceToday: { taken, total, pct },
        lastIntake,
        nextMed,
      };
    });
  }, [patients, logs, slots]);

  const KNOWN_KEYS = useMemo(() => new Set(BEDS.map((b) => b.key)), []);
  const unassigned = useMemo(
    () =>
      patients.filter(
        (p) => p.dispenser_id && !KNOWN_KEYS.has(norm(p.dispenser_id)),
      ),
    [patients, KNOWN_KEYS],
  );

  const occupiedCount = bedViews.filter((v) => v.patient).length;
  const hover = bedViews.find((v) => v.slot.key === hoverKey) ?? null;

  const popover = useMemo(() => {
    if (!hover || !hover.patient || !wrapperRef.current) return null;
    const wrapW = wrapperRef.current.clientWidth;
    const scale = wrapW / SVG_VIEW_W;
    const popW = 240;
    const popH = 130;
    let left =
      hover.slot.x * scale + (hover.slot.w * scale) / 2 - popW / 2;
    let top = hover.slot.y * scale - popH - 8;
    left = Math.max(8, Math.min(left, wrapW - popW - 8));
    if (top < 0) top = (hover.slot.y + hover.slot.h) * scale + 8;
    return { left, top };
  }, [hover]);

  useEffect(() => {
    if (!hoverKey) return;
    function onDocClick(ev: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(ev.target as Node)) {
        setHoverKey(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [hoverKey]);

  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#4a6741"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
          </svg>
          <h2 className="text-base font-semibold text-gray-900">Floor map</h2>
        </div>
        <span className="text-xs text-gray-400">
          {BEDS.length} beds · {occupiedCount} occupied
        </span>
      </div>

      <div ref={wrapperRef} className="relative">
        <svg
          viewBox={`0 0 ${SVG_VIEW_W} ${SVG_VIEW_H}`}
          className="w-full"
          role="img"
          aria-label="Hospital floor map"
        >
          <rect
            x={ROOM_RECTS.common.x}
            y={ROOM_RECTS.common.y}
            width={ROOM_RECTS.common.w}
            height={ROOM_RECTS.common.h}
            rx="14"
            fill="#fafaf6"
            stroke="#d8d3c4"
            strokeWidth="1.5"
          />
          <text
            x={ROOM_RECTS.common.x + 14}
            y={ROOM_RECTS.common.y + 22}
            fontSize="12"
            fontWeight="500"
            fill="#6b7280"
          >
            {ROOM_RECTS.common.label}
          </text>

          <rect
            x={ROOM_RECTS.icu.x}
            y={ROOM_RECTS.icu.y}
            width={ROOM_RECTS.icu.w}
            height={ROOM_RECTS.icu.h}
            rx="14"
            fill="#f0eee6"
            stroke="#bcb59f"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <text
            x={ROOM_RECTS.icu.x + 14}
            y={ROOM_RECTS.icu.y + 22}
            fontSize="12"
            fontWeight="500"
            fill="#6b7280"
          >
            {ROOM_RECTS.icu.label}
          </text>

          {bedViews.map((v) => {
            const W = v.slot.w;
            const H = v.slot.h;
            const palette = avatarPalette(v);
            const pct = v.adherenceToday.pct;
            const isHovered = hoverKey === v.slot.key;
            const r = Math.min(W, H) * 0.22;
            const cx = W / 2;
            const cy = H / 2 + H * 0.05;
            const C = 2 * Math.PI * r;
            const arcLen = pct !== null ? (pct / 100) * C : 0;
            const pillowW = W * 0.35;
            const pillowH = H * 0.16;
            const isCritical = v.patient && pct !== null && pct < 60;
            return (
              <g
                key={v.slot.key}
                transform={`translate(${v.slot.x}, ${v.slot.y})`}
                onMouseEnter={() => setHoverKey(v.slot.key)}
                onMouseLeave={() =>
                  setHoverKey((h) => (h === v.slot.key ? null : h))
                }
                onClick={() => {
                  if (!v.patient) return;
                  if (hoverKey === v.slot.key) {
                    router.push(`/patients/${v.patient.id}`);
                  } else {
                    setHoverKey(v.slot.key);
                  }
                }}
                style={{ cursor: v.patient ? "pointer" : "default" }}
              >
                {/* Bed frame */}
                <rect
                  width={W}
                  height={H}
                  rx={12}
                  fill="#faf7f0"
                  stroke={isHovered ? "#a8a290" : "#dcd6c4"}
                  strokeWidth={isHovered ? 2 : 1.4}
                />
                {/* Mattress */}
                <rect
                  x={4}
                  y={4}
                  width={W - 8}
                  height={H - 8}
                  rx={9}
                  fill="#ffffff"
                  stroke="#ece6d3"
                  strokeWidth={1}
                />
                {/* Pillow */}
                <rect
                  x={W / 2 - pillowW / 2}
                  y={6}
                  width={pillowW}
                  height={pillowH}
                  rx={4}
                  fill="#f3ecd6"
                  stroke="#e0d6b3"
                  strokeWidth={1}
                />
                {/* Isolation marker (ICU only) */}
                {v.slot.room === "icu" && (
                  <rect
                    x={6}
                    y={6}
                    width={W - 12}
                    height={H - 12}
                    rx={7}
                    fill="none"
                    stroke="#bcb59f"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                )}
                {/* Adherence ring background */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={r + 3}
                  fill="none"
                  stroke={palette.ring}
                  strokeWidth={2}
                  opacity={0.18}
                />
                {/* Adherence ring foreground arc */}
                {v.patient && pct !== null && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r + 3}
                    fill="none"
                    stroke={palette.ring}
                    strokeWidth={isCritical ? 2.5 : 2}
                    strokeLinecap="round"
                    strokeDasharray={`${arcLen} ${C}`}
                    transform={`rotate(-90 ${cx} ${cy})`}
                  >
                    {isCritical && (
                      <animate
                        attributeName="stroke-width"
                        values="2;4;2"
                        dur="1.6s"
                        repeatCount="indefinite"
                      />
                    )}
                  </circle>
                )}
                {/* Avatar fill */}
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={palette.fill}
                  stroke={palette.stroke}
                  strokeWidth={1.5}
                />
                {/* Initials or dash */}
                <text
                  x={cx}
                  y={cy + r * 0.32}
                  textAnchor="middle"
                  fontSize={r * 0.85}
                  fontWeight="700"
                  fill={v.patient ? palette.stroke : "#9ca3af"}
                >
                  {v.patient ? getInitials(v.patient.name) : "—"}
                </text>
                {/* Bed label below */}
                <text
                  x={cx}
                  y={H + 12}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight={isHovered ? "600" : "500"}
                  fill={isHovered ? "#374151" : "#6b7280"}
                >
                  {v.slot.label}
                </text>
              </g>
            );
          })}
        </svg>

        {popover && hover?.patient && (
          <div
            className="pointer-events-none absolute z-10 w-60 rounded-xl border border-sand-200 bg-white p-3 shadow-lg"
            style={{ left: popover.left, top: popover.top }}
          >
            <p className="text-sm font-semibold text-gray-900">
              {hover.patient.name}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-400">
              {hover.slot.label} ·{" "}
              {hover.slot.room === "icu" ? "ICU" : "Common"}
            </p>
            <hr className="my-2 border-sand-100" />
            <p className="text-xs text-gray-700">
              Today:{" "}
              <span className="font-medium text-gray-900">
                {hover.adherenceToday.taken}/{hover.adherenceToday.total}
              </span>
              {hover.adherenceToday.pct !== null && (
                <span className="ml-1 text-gray-400">
                  ({hover.adherenceToday.pct}%)
                </span>
              )}
            </p>
            <p className="text-xs text-gray-700">
              Last:{" "}
              {hover.lastIntake
                ? `${formatRelative(hover.lastIntake.timestamp)} · ${
                    hover.lastIntake.pill_taken ? "taken" : "missed"
                  }`
                : "—"}
            </p>
            <p className="text-xs text-gray-700">
              Next:{" "}
              <span className="font-medium">
                {hover.nextMed?.name ?? "—"}
              </span>
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-sand-100 pt-3 text-[11px] text-gray-500">
        <span className="font-medium text-gray-600">Adherence today:</span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "#4a6741" }}
            aria-hidden
          />
          ≥ 90%
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "#b45309" }}
            aria-hidden
          />
          60–89%
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: "#b91c1c" }}
            aria-hidden
          />
          &lt; 60%
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full border border-gray-300 bg-white"
            aria-hidden
          />
          no data
        </span>
      </div>

      {unassigned.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
          <span className="font-medium text-gray-600">Unassigned:</span>
          {unassigned.map((p) => (
            <Link
              key={p.id}
              href={`/patients/${p.id}`}
              className="rounded-full bg-sand-100 px-2 py-0.5 hover:bg-sand-200"
            >
              {p.name}{" "}
              <span className="font-mono text-gray-400">
                ({p.dispenser_id})
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
