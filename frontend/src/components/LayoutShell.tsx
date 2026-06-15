"use client";

import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";

export default function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === "/";
  // The guided dispenser flow is a control-room view — give it the full screen
  // so each step can lay its components out side by side.
  const isWide = pathname?.startsWith("/dispensers/") ?? false;

  if (isLanding) {
    return <>{children}</>;
  }

  return (
    <>
      <Navbar />
      <main
        className={`mx-auto px-4 pb-12 pt-6 sm:px-6 ${
          isWide ? "max-w-[1900px]" : "max-w-[1360px]"
        }`}
      >
        {children}
      </main>
    </>
  );
}
