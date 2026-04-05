"use client";

import { useEffect, useState } from "react";
import PillStatus from "@/components/PillStatus";
import AdherenceChart from "@/components/AdherenceChart";
import { fetchSlots, type SlotInfo } from "@/lib/api";

export default function Home() {
  const [slots, setSlots] = useState<SlotInfo[]>([]);

  useEffect(() => {
    fetchSlots().then(setSlots);
  }, []);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="mb-8 text-3xl font-bold">PharmGuard Dashboard</h1>

      <section className="mb-10">
        <h2 className="mb-4 text-xl font-semibold">Magazine Status</h2>
        <PillStatus slots={slots} />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">Adherence Log</h2>
        <AdherenceChart />
      </section>
    </main>
  );
}
