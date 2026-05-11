"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  ChartCandlestick,
  FlaskConical,
  Landmark,
  ListChecks,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PieChart,
  Radio,
  ScanSearch,
  Settings,
  TrendingUp,
  Users,
  Home,
} from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

const SIDEBAR_STORAGE_KEY = "market_sidebar_collapsed";

const links: Array<{ href: string; label: string; Icon: LucideIcon }> = [
  { href: "/", label: "Overview", Icon: Home },
  { href: "/breadth", label: "Breadth", Icon: Activity },
  { href: "/thirteenf", label: "13F Tracker", Icon: Landmark },
  { href: "/sectors", label: "Sector Tracker", Icon: PieChart },
  { href: "/alerts", label: "Alerts", Icon: Bell },
  { href: "/social-alerts", label: "Social Alerts", Icon: Radio },
  { href: "/peer-groups", label: "Peer Groups", Icon: Users },
  { href: "/correlation", label: "Correlation", Icon: Network },
  { href: "/scans", label: "Scans", Icon: ScanSearch },
  { href: "/pattern-scanner", label: "Pattern Scanner", Icon: ChartCandlestick },
  { href: "/watchlist-compiler", label: "Watchlist Compiler", Icon: ListChecks },
  { href: "/research-lab", label: "Research Lab", Icon: FlaskConical },
  { href: "/gappers", label: "Gappers", Icon: TrendingUp },
  { href: "/admin", label: "Admin", Icon: Settings },
];

type SidebarTooltip = {
  label: string;
  left: number;
  top: number;
};

const SIDEBAR_TOOLTIP_ID = "sidebar-page-tooltip";

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [tooltip, setTooltip] = useState<SidebarTooltip | null>(null);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true");
    } catch {
      setCollapsed(false);
    }
  }, []);

  useEffect(() => {
    setTooltip(null);
  }, [collapsed, pathname]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage failures; the in-session state is still useful.
      }
      return next;
    });
  };

  const showTooltip = (label: string, target: HTMLElement) => {
    if (!collapsed) return;

    const rect = target.getBoundingClientRect();
    setTooltip({
      label,
      left: rect.right + 12,
      top: rect.top + rect.height / 2,
    });
  };

  const tooltipPortal =
    collapsed && tooltip && typeof document !== "undefined"
      ? createPortal(
          <div
            id={SIDEBAR_TOOLTIP_ID}
            role="tooltip"
            className="pointer-events-none fixed z-[2147483647] -translate-y-1/2 whitespace-nowrap rounded-lg border border-borderSoft/80 bg-panelSoft px-2.5 py-1.5 text-xs font-medium text-text shadow-lg"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            {tooltip.label}
          </div>,
          document.body,
        )
      : null;

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-borderSoft/70 bg-panel/90 p-4 backdrop-blur-xl transition-[width] duration-200 ease-out ${
        collapsed ? "w-20" : "w-64"
      }`}
    >
      <div className={`mb-5 flex ${collapsed ? "justify-center" : "justify-end"}`}>
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-borderSoft/80 bg-panelSoft/70 text-text/85 transition-colors hover:bg-panelSoft hover:text-text"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand navigation sidebar" : "Collapse navigation sidebar"}
          aria-expanded={!collapsed}
          aria-controls="primary-navigation"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>
      <nav id="primary-navigation" className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden">
        {links.map((link) => {
          const active = link.href === "/" ? pathname === link.href : pathname === link.href || pathname.startsWith(`${link.href}/`);
          const Icon = link.Icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`flex h-10 items-center rounded-xl text-sm transition-colors ${
                collapsed ? "justify-center px-0" : "gap-3 px-3"
              } ${active ? "bg-accent/20 text-accent" : "text-text/85 hover:bg-panelSoft/80"}`}
              aria-label={collapsed ? link.label : undefined}
              aria-describedby={collapsed && tooltip?.label === link.label ? SIDEBAR_TOOLTIP_ID : undefined}
              onMouseEnter={(event) => showTooltip(link.label, event.currentTarget)}
              onMouseLeave={() => setTooltip(null)}
              onFocus={(event) => showTooltip(link.label, event.currentTarget)}
              onBlur={() => setTooltip(null)}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{link.label}</span>}
            </Link>
          );
        })}
      </nav>
      <div
        className={`mt-6 ${
          collapsed
            ? "flex justify-center [&_button]:h-10 [&_button]:w-10 [&_button]:gap-0 [&_button]:overflow-hidden [&_button]:px-0 [&_button]:text-[0px] [&_svg]:shrink-0"
            : "space-y-3"
        }`}
      >
        <ThemeToggle />
      </div>
      {tooltipPortal}
    </aside>
  );
}
