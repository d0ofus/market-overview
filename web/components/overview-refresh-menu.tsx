"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronDown, Clock3, Database } from "lucide-react";
import { ManualRefreshButton, type ManualRefreshPage } from "./manual-refresh-button";

export type OverviewRefreshStatus = {
  asOfDate: string | null;
  lastUpdated: string | null;
  timezone: string;
  autoRefreshLabel: string;
  providerLabel: string;
  expectedAsOfDate?: string | null;
  freshnessStatus?: "fresh" | "partial" | "stale";
  freshnessCoveragePct?: number | null;
  freshnessCurrentCount?: number | null;
  freshnessEligibleCount?: number | null;
  freshnessCriticalMissingTickers?: string[];
  freshnessMinBarDate?: string | null;
  freshnessMaxBarDate?: string | null;
  freshnessWarning?: string | null;
};

type Props = {
  status: OverviewRefreshStatus;
  refreshPage?: ManualRefreshPage;
  refreshIdleLabel?: string;
};

const TZ_OPTIONS = [
  { label: "Melbourne", value: "Australia/Melbourne" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "New York", value: "America/New_York" },
  { label: "Singapore", value: "Asia/Singapore" },
];

const TIMEZONE_STORAGE_KEY = "market_command_timezone";
const PANEL_GAP_PX = 8;
const PANEL_MARGIN_PX = 12;
const PANEL_MAX_WIDTH_PX = 448;

function formatInZone(value: string | null, zone: string): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: zone,
  }).format(date);
}

function asOfToIso(asOfDate: string | null): string | null {
  if (!asOfDate) return null;
  return `${asOfDate}T00:00:00Z`;
}

function freshnessClass(status: OverviewRefreshStatus["freshnessStatus"]): string {
  if (status === "fresh") return "border-success/30 bg-success/10 text-success";
  if (status === "partial") return "border-warning/30 bg-warning/10 text-warning";
  return "border-red-400/30 bg-red-500/10 text-red-300";
}

function freshnessLabel(status: OverviewRefreshStatus["freshnessStatus"]): string {
  if (status === "fresh") return "Fresh";
  if (status === "partial") return "Partial";
  return "Stale";
}

export function OverviewRefreshMenu({ status, refreshPage = "overview", refreshIdleLabel = "Update This Page" }: Props) {
  const [selectedTz, setSelectedTz] = useState("Australia/Melbourne");
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const open = hoverOpen || pinnedOpen;

  useEffect(() => {
    const persisted = window.localStorage.getItem(TIMEZONE_STORAGE_KEY);
    setSelectedTz(persisted || status.timezone || "Australia/Melbourne");
  }, [status.timezone]);

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = menuRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(window.innerWidth - PANEL_MARGIN_PX * 2, PANEL_MAX_WIDTH_PX);
      const left = Math.min(
        Math.max(PANEL_MARGIN_PX, rect.right - width),
        window.innerWidth - width - PANEL_MARGIN_PX,
      );
      setPanelStyle({
        left,
        top: Math.max(PANEL_MARGIN_PX, rect.bottom + PANEL_GAP_PX),
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!pinnedOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setPinnedOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setPinnedOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pinnedOpen]);

  const lastUpdatedLabel = useMemo(() => formatInZone(status.lastUpdated, selectedTz), [status.lastUpdated, selectedTz]);
  const asOfLabel = useMemo(() => formatInZone(asOfToIso(status.asOfDate), selectedTz), [status.asOfDate, selectedTz]);
  const freshnessStatus = status.freshnessStatus ?? "stale";
  const marketDataAsOf =
    status.freshnessMinBarDate && status.freshnessMaxBarDate
      ? status.freshnessMinBarDate === status.freshnessMaxBarDate
        ? status.freshnessMaxBarDate
        : `${status.freshnessMinBarDate} to ${status.freshnessMaxBarDate}`
      : status.freshnessMaxBarDate
        ? status.freshnessMaxBarDate
        : "Unknown";
  const freshnessCoveragePct = status.freshnessCoveragePct;
  const freshnessCurrentCount = status.freshnessCurrentCount;
  const freshnessEligibleCount = status.freshnessEligibleCount;
  const coverageLabel =
    typeof freshnessEligibleCount === "number"
    && freshnessEligibleCount > 0
    && typeof freshnessCurrentCount === "number"
    && typeof freshnessCoveragePct === "number"
      ? `${freshnessCoveragePct.toFixed(1)}% (${freshnessCurrentCount}/${freshnessEligibleCount})`
      : "Coverage unknown";

  return (
    <div
      ref={menuRef}
      className="relative z-[90]"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
      onFocusCapture={() => setHoverOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setPinnedOpen((current) => !current)}
        className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-xl border border-accent/35 bg-accent/10 px-3 text-sm font-medium text-slate-200 transition hover:border-accent/55 hover:bg-accent/15"
      >
        <Clock3 className="h-4 w-4 text-accent" />
        <span>Data Freshness</span>
        <ChevronDown className={`h-4 w-4 text-slate-500 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="dialog"
          style={panelStyle}
          className="fixed z-[120] rounded-2xl border border-borderSoft/80 bg-panel p-3 shadow-[0_22px_54px_rgba(2,6,23,0.42)] backdrop-blur-xl"
        >
          <div className="grid gap-2 text-sm">
            <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/45 px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Snapshot generated</div>
              <div className="mt-1 font-medium text-slate-100">{lastUpdatedLabel}</div>
            </div>
            <div className={`rounded-xl border px-3 py-2 ${freshnessClass(freshnessStatus)}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] opacity-75">Displayed data status</div>
                  <div className="mt-1 font-semibold">{freshnessLabel(freshnessStatus)}</div>
                </div>
                <div className="text-right text-xs">
                  <div>{coverageLabel}</div>
                  <div className="mt-1 opacity-75">Expected {status.expectedAsOfDate ?? "N/A"}</div>
                </div>
              </div>
              {status.freshnessWarning && <div className="mt-2 text-xs leading-5 opacity-90">{status.freshnessWarning}</div>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Snapshot as-of</div>
                <div className="mt-1 text-slate-200">{asOfLabel}</div>
              </div>
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Displayed data as-of</div>
                <div className="mt-1 break-words font-mono text-slate-200">{marketDataAsOf}</div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Auto-refresh</div>
                <div className="mt-1 text-slate-200">{status.autoRefreshLabel}</div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
              <label className="rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-slate-300">
                <span className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Timezone</span>
                <select
                  className="mt-1 block w-full bg-transparent text-slate-100 outline-none"
                  value={selectedTz}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSelectedTz(next);
                    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, next);
                  }}
                >
                  {TZ_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value} className="bg-slate-900">
                      {tz.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-accent">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em]">
                  <Database className="h-3.5 w-3.5" />
                  Source
                </div>
                <div className="mt-1 text-sm font-medium">{status.providerLabel}</div>
              </div>
            </div>
            <ManualRefreshButton page={refreshPage} idleLabel={refreshIdleLabel} />
          </div>
        </div>
      )}
    </div>
  );
}
