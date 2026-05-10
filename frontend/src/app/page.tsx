"use client";

import DispenserOverview from "@/components/DispenserOverview";
import IntakeLog from "@/components/IntakeLog";
import WhatHappenedLately from "@/components/WhatHappenedLately";
import FloorMap from "@/components/FloorMap";
import { useLogs, usePatients, useSlots } from "@/lib/swr";

export default function Home() {
  const { data: slots = [] } = useSlots();
  const { data: logs = [] } = useLogs();
  const { data: patients = [] } = usePatients();

  return (
    <div>
      <div className="animate-fade-up mb-8">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Good {getGreeting()}, Nurse/Pharmacist
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Here&apos;s your dispensing overview for today
        </p>
      </div>

      <div className="animate-fade-up stagger-1">
        <WhatHappenedLately />
      </div>

      <div className="animate-fade-up stagger-2 mb-8">
        <FloorMap />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[7fr_3fr]">
        <div className="animate-fade-up stagger-3">
          <DispenserOverview patients={patients} slots={slots} />
        </div>
        <div className="animate-fade-up stagger-4">
          <IntakeLog logs={logs} />
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
