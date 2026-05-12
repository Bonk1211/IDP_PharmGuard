"use client";

import Link from "next/link";
import dynamic from "next/dynamic";

const Model3D = dynamic(() => import("@/components/Model3D"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <div className="h-10 w-10 animate-pulse rounded-full bg-olive-200" />
    </div>
  ),
});

export default function Landing() {
  return (
    <div className="min-h-screen bg-sand-50 text-gray-900">
      <Header />
      <Hero />
      <CamerasSection />
      <OutcomesSection />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-sand-200 bg-sand-50/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1360px] items-center justify-between px-6">
        <div className="flex items-baseline gap-2">
          <span className="font-[family-name:var(--font-display)] text-xl text-olive-700">
            PharmGuard
          </span>
          <span className="text-xs text-gray-400">n. medication co-pilot</span>
        </div>
        <nav className="hidden items-center gap-7 text-sm text-gray-600 md:flex">
          <a href="#product" className="transition-colors hover:text-olive-700">
            Product
          </a>
          <a href="#how" className="transition-colors hover:text-olive-700">
            How it works
          </a>
          <a href="#outcomes" className="transition-colors hover:text-olive-700">
            Hospitals
          </a>
        </nav>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 rounded-full bg-olive-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-olive-800"
        >
          Open the Dashboard
          <Arrow />
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section
      id="product"
      className="relative overflow-hidden border-b border-sand-200"
    >
      <div className="mx-auto grid max-w-[1360px] grid-cols-1 gap-12 px-6 pb-20 pt-8 lg:grid-cols-[1.1fr_1fr] lg:pb-28 lg:pt-12">
        <div className="animate-fade-up flex flex-col justify-center">
          <span className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-olive-200 bg-olive-50 px-3 py-1 text-xs font-medium uppercase tracking-wider text-olive-700">
            <span className="h-1.5 w-1.5 rounded-full bg-olive-600" />
            V1 prototype · Singapore
          </span>
          <h1 className="font-[family-name:var(--font-display)] text-5xl leading-[1.05] tracking-tight text-gray-900 sm:text-6xl lg:text-7xl">
            <span className="text-olive-700">Right</span> patient.{" "}
            <span className="text-olive-700">Right</span> pill.{" "}
            <span className="text-olive-700">Verified</span> swallow.
            <br />
            <span className="text-gray-500">Zero nurse contact.</span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-relaxed text-gray-600 sm:text-lg">
            A bedside dispenser for TB, COVID and MDRO isolation rooms. Face ID
            unlocks the drawer, YOLO verifies the pill, a swallow-FSM confirms
            ingestion — and every cycle streams to the ward dashboard in real
            time.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-full bg-olive-700 px-6 py-3 text-sm font-medium text-white shadow-sm transition-all hover:bg-olive-800 hover:shadow"
            >
              Open the Dashboard
              <Arrow />
            </Link>
            <a
              href="#how"
              className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white px-6 py-3 text-sm font-medium text-gray-700 transition-all hover:border-olive-300 hover:text-olive-700"
            >
              See how it works
            </a>
          </div>
        </div>

        <div className="animate-fade-up stagger-2 relative">
          <div className="pointer-events-none absolute -inset-10 rounded-full bg-[radial-gradient(closest-side,rgba(173,184,136,0.28),transparent_70%)]" />
          <div className="relative aspect-square w-full">
            <Model3D className="h-full w-full" />

            {/* Top-right chip — Cam 1 */}
            <FeatureChip
              className="absolute right-0 top-8 sm:right-2"
              dotClass="bg-status-success"
              title="Face ID matched · Bed 4"
              body="Drawer unlocked · 0 nurse entry"
            />

            {/* Mid-left chip — Cam 2 */}
            <FeatureChip
              className="absolute left-0 top-1/2 -translate-y-1/2 sm:left-2"
              dotClass="bg-olive-600"
              title="YOLO 99.2% · slot 3"
              body="Pill verified · cycle 6.4 s"
            />

            {/* Bottom-right chip — Cam 3 */}
            <FeatureChip
              className="absolute bottom-10 right-2 sm:right-6"
              dotClass="bg-status-info"
              title="Swallow FSM 5/5"
              body="Tongue clear · logged 14:02"
            />

            {/* Bottom-left chip — Stream */}
            <FeatureChip
              className="absolute bottom-2 left-0 sm:left-4"
              dotClass="bg-status-warning"
              title="Ward dashboard · live"
              body="Cycle streamed in 280 ms"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function CamerasSection() {
  const steps = [
    {
      tag: "CAM 1 · Face",
      title: "Verify the patient",
      body: "Bed-facing camera runs AWS Rekognition face match against the assigned patient. Drawer stays locked on mismatch.",
    },
    {
      tag: "CAM 2 · Tray",
      title: "Verify the pill",
      body: "Down-facing camera runs on-device YOLO. Wrong shape, count, or color = abort + flag to dashboard.",
    },
    {
      tag: "CAM 3 · Swallow",
      title: "Verify ingestion",
      body: "MediaPipe FaceMesh + Hands runs a 5-step FSM: hand → tilt → level → mouth → tongue. Logged with timestamp.",
    },
  ];

  return (
    <section id="how" className="border-b border-sand-200 bg-white">
      <div className="mx-auto max-w-[1360px] px-6 py-20 lg:py-24">
        <div className="animate-fade-up mb-14 max-w-3xl">
          <span className="mb-4 inline-block text-xs font-medium uppercase tracking-[0.2em] text-olive-700">
            How it works
          </span>
          <h2 className="font-[family-name:var(--font-display)] text-4xl leading-tight tracking-tight text-gray-900 sm:text-5xl">
            Three cameras.{" "}
            <span className="text-olive-700">One</span> zero-touch loop.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-gray-600">
            PharmGuard sits at the bedside in an isolation room. Every scheduled
            dose runs the same closed loop — verify the patient, verify the
            pill, verify the swallow — and only escalates the moments that need
            a nurse to PPE in.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {steps.map((s, i) => (
            <div
              key={s.tag}
              className={`animate-fade-up stagger-${i + 1} group relative overflow-hidden rounded-2xl border border-sand-200 bg-sand-50/50 p-7 transition-all hover:border-olive-300 hover:bg-white hover:shadow-sm`}
            >
              <div className="mb-5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-olive-700">
                  {s.tag}
                </span>
                <span className="font-[family-name:var(--font-display)] text-3xl text-sand-300 transition-colors group-hover:text-olive-200">
                  0{i + 1}
                </span>
              </div>
              <h3 className="mb-3 font-[family-name:var(--font-display)] text-2xl text-gray-900">
                {s.title}
              </h3>
              <p className="text-sm leading-relaxed text-gray-600">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function OutcomesSection() {
  const metrics = [
    { value: "100%", label: "Wrong-pill catch on the 5-SKU bench set" },
    { value: "≤ 8s", label: "Face ID → drawer unlock, p95 on Pi 5" },
    { value: "0", label: "Nurse touches per verified dose" },
    { value: "5", label: "FSM steps to confirm a swallow" },
  ];

  return (
    <section
      id="outcomes"
      className="border-b border-sand-200 bg-olive-900 text-white"
    >
      <div className="mx-auto max-w-[1360px] px-6 py-20 lg:py-24">
        <div className="animate-fade-up mb-14 max-w-3xl">
          <span className="mb-4 inline-block text-xs font-medium uppercase tracking-[0.2em] text-olive-200">
            Outcomes
          </span>
          <h2 className="font-[family-name:var(--font-display)] text-4xl leading-tight tracking-tight sm:text-5xl">
            The numbers the{" "}
            <span className="text-olive-300">bench</span> has to clear.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-olive-100/80">
            Targets the V1 prototype must hit on a single-patient bench rig — a
            Pi 5, dual CSI cameras, NEMA 17 magazine, slider-crank ejector —
            before pilot. Operator-attested validations are in flight.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-olive-800/60 lg:grid-cols-4">
          {metrics.map((m, i) => (
            <div
              key={m.label}
              className={`animate-fade-up stagger-${i + 1} bg-olive-900 p-7 transition-colors hover:bg-olive-800`}
            >
              <div className="font-[family-name:var(--font-display)] text-5xl leading-none tracking-tight text-white">
                {m.value}
              </div>
              <div className="mt-4 text-sm leading-snug text-olive-200/90">
                {m.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-sand-50">
      <div className="mx-auto flex max-w-[1360px] flex-col items-start justify-between gap-4 px-6 py-10 sm:flex-row sm:items-center">
        <span className="font-[family-name:var(--font-display)] text-lg text-olive-700">
          PharmGuard
        </span>
        <span className="text-xs text-gray-400">© 2025 · Singapore</span>
      </div>
    </footer>
  );
}

function FeatureChip({
  className = "",
  dotClass,
  title,
  body,
}: {
  className?: string;
  dotClass: string;
  title: string;
  body: string;
}) {
  return (
    <div
      className={`pointer-events-none flex items-start gap-2.5 rounded-2xl border border-sand-200 bg-white/95 px-3.5 py-2.5 shadow-[0_8px_24px_-12px_rgba(45,55,30,0.18)] backdrop-blur-sm ${className}`}
    >
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <div className="leading-tight">
        <div className="text-[13px] font-semibold text-gray-900">{title}</div>
        <div className="mt-0.5 text-[11px] text-gray-500">{body}</div>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}
