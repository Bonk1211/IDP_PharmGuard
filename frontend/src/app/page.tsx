"use client";

import { useMemo } from "react";
import StatCard from "@/components/StatCard";
import DispenserOverview from "@/components/DispenserOverview";
import IntakeLog from "@/components/IntakeLog";
import NeedsAttention from "@/components/NeedsAttention";
import ActivePatients from "@/components/ActivePatients";
import AlertsPanel from "@/components/AlertsPanel";
import BriefCard from "@/components/BriefCard";
import FlagsPanel from "@/components/FlagsPanel";
import { useLogs, usePatients, useSlots } from "@/lib/swr";

export default function Home() {
  const { data: slots = [] } = useSlots();
  const { data: logs = [] } = useLogs();
  const { data: patients = [] } = usePatients();

  const stats = useMemo(() => {
    const today = new Date().toDateString();
    let dispensedToday = 0;
    let missedToday = 0;
    let takenLogs = 0;
    for (const l of logs) {
      if (l.pill_taken) takenLogs++;
      const isToday = new Date(l.timestamp).toDateString() === today;
      if (isToday) {
        if (l.pill_taken) dispensedToday++;
        else missedToday++;
      }
    }
    const adherenceRate = logs.length > 0
      ? Math.round((takenLogs / logs.length) * 100)
      : 0;
    return { dispensedToday, missedToday, adherenceRate };
  }, [logs]);

  const { dispensedToday, missedToday, adherenceRate } = stats;

  return (
    <div>
      {/* Greeting */}
      <div className="animate-fade-up mb-8">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Good {getGreeting()}, Nurse
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Here&apos;s your dispensing overview for today
        </p>
      </div>

      {/* Stat Cards */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="animate-fade-up stagger-1">
          <StatCard
            icon={<IconPatients />}
            label="Active Patients"
            value={String(patients.length)}
            trend={{ value: `${patients.length}`, direction: "up" }}
            subtitle="enrolled in system"
          />
        </div>
        <div className="animate-fade-up stagger-2">
          <StatCard
            icon={<IconPill />}
            label="Dispensed Today"
            value={String(dispensedToday)}
            trend={{ value: `${dispensedToday}`, direction: "up" }}
            subtitle="doses administered"
          />
        </div>
        <div className="animate-fade-up stagger-3">
          <StatCard
            icon={<IconCheck />}
            label="Adherence Rate"
            value={`${adherenceRate}%`}
            trend={{
              value: adherenceRate >= 80 ? "+2%" : "-3%",
              direction: adherenceRate >= 80 ? "up" : "down",
            }}
            subtitle="vs. last 7 days"
          />
        </div>
        <div className="animate-fade-up stagger-4">
          <StatCard
            icon={<IconAlert />}
            label="Alerts"
            value={String(missedToday)}
            trend={
              missedToday > 0
                ? { value: String(missedToday), direction: "down" }
                : undefined
            }
            subtitle="require attention"
            alert={missedToday > 0}
          />
        </div>
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column: Dispensers + Intake Log */}
        <div className="space-y-6 lg:col-span-2">
          <div className="animate-fade-up stagger-3">
            <DispenserOverview patients={patients} slots={slots} />
          </div>
          <div className="animate-fade-up stagger-4">
            <IntakeLog logs={logs} />
          </div>
        </div>

        {/* Right column: Brief + Flags + Alerts + Needs Attention + Active Patients */}
        <div className="space-y-6">
          <div className="animate-slide-in-right stagger-1">
            <BriefCard />
          </div>
          <div className="animate-slide-in-right stagger-2">
            <FlagsPanel />
          </div>
          <div className="animate-slide-in-right stagger-3">
            <AlertsPanel />
          </div>
          <div className="animate-slide-in-right stagger-4">
            <NeedsAttention logs={logs} slots={slots} />
          </div>
          <div className="animate-slide-in-right stagger-5">
            <ActivePatients />
          </div>
        </div>
      </div>
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

function IconPatients() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconPill() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m10.5 1.5 3 3L3 15l-1.5-1.5a4.24 4.24 0 0 1 0-6L7.5 1.5a4.24 4.24 0 0 1 6 0z" transform="translate(3, 3) scale(0.85)" />
      <path d="M9 6l6 6" transform="translate(3, 3) scale(0.85)" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
