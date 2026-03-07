"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, RefreshCw } from "lucide-react";
import { refreshPageData } from "@/lib/api";
import { useState } from "react";

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
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshLabel, setRefreshLabel] = useState<string | null>(null);
  const refreshTarget = (() => {
    if (pathname.startsWith("/breadth")) return { page: "breadth" as const, ticker: null };
    if (pathname.startsWith("/sectors")) return { page: "sectors" as const, ticker: null };
    if (pathname.startsWith("/alerts")) return { page: "alerts" as const, ticker: null };
    if (pathname.startsWith("/thirteenf")) return { page: "thirteenf" as const, ticker: null };
    if (pathname.startsWith("/admin")) return { page: "admin" as const, ticker: null };
    if (pathname.startsWith("/tools")) return { page: "tools" as const, ticker: null };
    if (pathname.startsWith("/ticker/")) {
      const ticker = pathname.split("/").filter(Boolean)[1] ?? null;
      return { page: "ticker" as const, ticker };
    }
    return { page: "overview" as const, ticker: null };
  })();
  return (
    <aside className="sticky top-0 h-screen w-64 border-r border-borderSoft/70 bg-[#0a1119]/90 p-4 backdrop-blur-xl">
      <div className="mb-6 rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/20 to-sky-400/5 p-3">
        <div className="mb-2 inline-flex rounded-lg bg-accent/20 p-2 text-accent">
          <BarChart3 className="h-4 w-4" />
        </div>
        <h1 className="text-base font-semibold tracking-wide">Market Command Centre</h1>
        <p className="mt-1 text-xs text-slate-400">Swing Trading Research Dashboard</p>
      </div>
      <nav className="space-y-2">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`block rounded-xl px-3 py-2 text-sm transition-colors ${active ? "bg-accent/20 text-accent" : "text-slate-300 hover:bg-panelSoft/80"}`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6">
        <button
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent disabled:opacity-60"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              const res = await refreshPageData(refreshTarget.page, refreshTarget.ticker);
              setRefreshLabel(res.notes ?? `Updated ${res.refreshedTickers} ticker${res.refreshedTickers === 1 ? "" : "s"}`);
              router.refresh();
            } catch {
              setRefreshLabel("Refresh failed");
            } finally {
              setRefreshing(false);
              setTimeout(() => setRefreshLabel(null), 2500);
            }
          }}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Update Current Page"}
        </button>
        {refreshLabel && <p className="mt-2 text-center text-xs text-slate-400">{refreshLabel}</p>}
      </div>
      <p className="mt-8 text-xs text-slate-500">Research tool only. Not investment advice.</p>
    </aside>
  );
}
