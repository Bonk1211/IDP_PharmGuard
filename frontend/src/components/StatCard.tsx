"use client";

import { type ReactNode } from "react";

interface Props {
  icon: ReactNode;
  label: string;
  value: string;
  trend?: { value: string; direction: "up" | "down" };
  subtitle?: string;
  alert?: boolean;
}

export default function StatCard({ icon, label, value, trend, subtitle, alert }: Props) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border bg-white p-5 transition-all duration-300 hover:shadow-md ${
        alert ? "border-status-danger/20" : "border-sand-200"
      }`}
    >
      {/* Subtle corner accent */}
      <div
        className={`absolute -right-6 -top-6 h-16 w-16 rounded-full opacity-[0.07] transition-transform duration-300 group-hover:scale-150 ${
          alert ? "bg-status-danger" : "bg-olive-600"
        }`}
      />

      <div className="relative">
        <div className="mb-3 flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              alert
                ? "bg-status-danger-bg text-status-danger"
                : "bg-olive-50 text-olive-600"
            }`}
          >
            {icon}
          </div>
          <span className="text-sm font-medium text-gray-400">{label}</span>
        </div>

        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold tracking-tight text-gray-900">
            {value}
          </span>
          {trend && (
            <span
              className={`flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                trend.direction === "up"
                  ? "bg-status-success-bg text-status-success"
                  : "bg-status-danger-bg text-status-danger"
              }`}
            >
              {trend.direction === "up" ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 9V3M6 3L3 6M6 3L9 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 3V9M6 9L3 6M6 9L9 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {trend.value}
            </span>
          )}
        </div>

        {subtitle && (
          <p className="mt-1 text-xs text-gray-400">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
