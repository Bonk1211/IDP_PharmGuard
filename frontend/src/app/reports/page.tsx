"use client";

export default function ReportsPage() {
  return (
    <div>
      <div className="animate-fade-up mb-8">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gray-900">
          Reports
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Adherence analytics and dispensing reports
        </p>
      </div>

      <div className="animate-fade-up stagger-1 flex flex-col items-center justify-center rounded-2xl border border-dashed border-sand-300 bg-white py-20 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-olive-50">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4a6741" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-gray-700">Coming Soon</h2>
        <p className="mt-1 max-w-sm text-sm text-gray-400">
          Adherence trend charts, dispensing frequency reports, and patient compliance analytics will be available here.
        </p>
      </div>
    </div>
  );
}
