"use client";

import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { usePathname } from "next/navigation";
import { BarChart3 } from "lucide-react";

const links = [
  { href: "/", label: "Overview" },
  { href: "/breadth", label: "Breadth" },
  { href: "/thirteenf", label: "13F Tracker" },
  { href: "/sectors", label: "Sector Tracker" },
  { href: "/alerts", label: "Alerts" },
  { href: "/tools", label: "Tools" },
  { href: "/admin", label: "Admin" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 h-screen w-64 border-r border-borderSoft/70 bg-panel/90 p-4 backdrop-blur-xl">
      <div className="mb-6 rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/20 to-sky-400/5 p-3">
        <div className="mb-2 inline-flex rounded-lg bg-accent/20 p-2 text-accent">
          <BarChart3 className="h-4 w-4" />
        </div>
        <h1 className="text-base font-semibold tracking-wide text-text">Market Command Centre</h1>
        <p className="mt-1 text-xs text-slate-400">Swing Trading Research Dashboard</p>
      </div>
      <nav className="space-y-2">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`block rounded-xl px-3 py-2 text-sm transition-colors ${active ? "bg-accent/20 text-accent" : "text-text/85 hover:bg-panelSoft/80"}`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6 space-y-3">
        <ThemeToggle />
      </div>
    </aside>
  );
}
