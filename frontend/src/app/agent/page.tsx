"use client";

import AgentChat from "@/components/AgentChat";
import ShiftBrief from "@/components/ShiftBrief";

export default function AgentPage() {
  return (
    <div className="space-y-6">
      <div className="animate-fade-up">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Clinician assistant
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Read-only Gemini agent. Asks Supabase for adherence, alerts, inventory,
          and patient data — never writes.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="animate-fade-up stagger-2 lg:col-span-2">
          <AgentChat />
        </div>
        <div className="animate-slide-in-right stagger-3">
          <ShiftBrief />
        </div>
      </div>
    </div>
  );
}
