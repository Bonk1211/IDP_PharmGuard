import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";

export const metadata: Metadata = {
  title: "PharmGuard Dashboard",
  description: "Medical IoT medication dispensing & adherence tracking",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <main className="mx-auto max-w-[1360px] px-6 pb-12 pt-6">
          {children}
        </main>
      </body>
    </html>
  );
}
