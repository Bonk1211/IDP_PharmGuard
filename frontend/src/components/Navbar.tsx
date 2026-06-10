"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Single-tenant default — the "Dispenser" tab links to a fixed id mirrored
// from the backend DEFAULT_DISPENSER_ID. Multi-tenant routing isn't wired
// yet; visiting any other id leaves the tab un-highlighted but the page
// still renders normally.
const DEFAULT_DISPENSER_ID =
  process.env.NEXT_PUBLIC_DEFAULT_DISPENSER_ID ?? "dispenser-001";

const NAV_ITEMS = [
  { label: "Dashboard",    href: "/" },
  { label: "Assistant",    href: "/agent" },
  { label: "Inventory",    href: "/inventory" },
  { label: "Dispenser",    href: `/dispensers/${DEFAULT_DISPENSER_ID}` },
  { label: "Patient List", href: "/patients" },
];

function isActiveTab(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export default function Navbar() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile panel whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-50 border-b border-sand-200 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1360px] items-center justify-between px-4 sm:px-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-olive-600">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20M2 12h20" />
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </div>
          <span className="text-lg font-semibold tracking-tight">
            Pharm<span className="text-olive-600">Guard</span>
          </span>
        </Link>

        {/* Nav tabs */}
        <nav className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => {
            const isActive = isActiveTab(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-olive-700 text-white shadow-sm"
                    : "text-gray-500 hover:bg-sand-100 hover:text-gray-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {/* Notification bell */}
          <button className="relative rounded-full p-2 text-gray-400 transition-colors hover:bg-sand-100 hover:text-gray-600">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-status-danger" style={{ animation: "pulse-dot 2s ease-in-out infinite" }} />
          </button>

          {/* Settings */}
          <button className="hidden rounded-full p-2 text-gray-400 transition-colors hover:bg-sand-100 hover:text-gray-600 sm:block">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </button>

          {/* Avatar */}
          <div className="h-9 w-9 overflow-hidden rounded-full bg-olive-100 ring-2 ring-olive-200/50">
            <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-olive-700">
              NS
            </div>
          </div>

          {/* Hamburger (mobile only) */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            className="rounded-full p-2 text-gray-500 transition-colors hover:bg-sand-100 hover:text-gray-900 md:hidden"
          >
            {menuOpen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile dropdown panel */}
      {menuOpen && (
        <nav className="border-t border-sand-100 px-4 pb-4 pt-2 md:hidden">
          {NAV_ITEMS.map((item) => {
            const isActive = isActiveTab(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-olive-700 text-white shadow-sm"
                    : "text-gray-500 hover:bg-sand-100 hover:text-gray-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
