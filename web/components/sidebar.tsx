"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Macro + Equities" },
  { href: "/breadth", label: "Breadth" },
  { href: "/tools", label: "Tools" },
  { href: "/admin", label: "Admin" },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 h-screen w-64 border-r border-borderSoft bg-panel/90 p-4">
      <div className="mb-6">
        <p className="text-xs uppercase tracking-[0.2em] text-accent">Market Command Centre</p>
        <h1 className="mt-1 text-lg font-semibold">EOD Swing Dashboard</h1>
      </div>
      <nav className="space-y-2">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`block rounded-lg px-3 py-2 text-sm ${active ? "bg-accent/15 text-accent" : "text-slate-300 hover:bg-panelSoft"}`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <p className="mt-8 text-xs text-slate-500">Research tool only. Not investment advice.</p>
    </aside>
  );
}
