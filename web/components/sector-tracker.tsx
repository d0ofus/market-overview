"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { CalendarDays, ChevronDown, List, Maximize2, Pencil, Trash2, X } from "lucide-react";
import {
  adminFetch,
  deleteSectorEntry,
  getEtfConstituents,
  getIndustryEtfs,
  getSectorCalendar,
  getSectorEntries,
  getSectorEtfs,
  getSectorSymbolOptions,
  updateSectorEntry,
} from "@/lib/api";
import { FloatingSectionNav } from "./floating-section-nav";
import { TickerCollectionModal, type TickerCollectionModalItem } from "./ticker-collection-modal";
import { TradingViewWidget } from "./tradingview-widget";

const formatLocalMonthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const formatLocalDateInputValue = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const US_MARKET_TIMEZONE = "America/New_York";
const US_MARKET_CLOSE_HOUR = 16;
const getZonedDateParts = (d: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    hour: Number(get("hour") || "0"),
    isoDate: `${get("year")}-${get("month")}-${get("day")}`,
  };
};
const previousWeekdayIso = (isoDate: string) => {
  const value = new Date(`${isoDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) {
    value.setUTCDate(value.getUTCDate() - 1);
  }
  return value.toISOString().slice(0, 10);
};
const getDefaultSectorEventDate = (now = new Date()) => {
  const ny = getZonedDateParts(now, US_MARKET_TIMEZONE);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(ny.weekday);
  if (!isWeekday) return previousWeekdayIso(ny.isoDate);
  return ny.hour >= US_MARKET_CLOSE_HOUR ? ny.isoDate : previousWeekdayIso(ny.isoDate);
};
const parseMonthKey = (value: string) => {
  const [year, month] = value.split("-").map(Number);
  return { year, month };
};
const getDaysInMonth = (value: string) => {
  const { year, month } = parseMonthKey(value);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};
const getMonthStartWeekday = (value: string) => {
  const { year, month } = parseMonthKey(value);
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
};
const pctCls = (n: number) => (n >= 0 ? "text-pos" : "text-neg");
const signedPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const deltaPillCls = (n: number) =>
  n >= 0
    ? "bg-emerald-500/12 text-pos ring-1 ring-emerald-400/20"
    : "bg-rose-500/12 text-neg ring-1 ring-rose-400/20";
const INPUT_CLASS =
  "w-full rounded-xl border border-borderSoft/70 bg-panel/75 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-accent/50 focus:ring-2 focus:ring-accent/15";
const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55";
const ICON_BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded-full border border-borderSoft/60 bg-panelSoft/35 text-slate-300 transition hover:bg-panelSoft/55";
const TICKER_CHIP_CLASS =
  "rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent transition hover:bg-accent/20";
const CHARTS_PER_PAGE = 20;
const CALENDAR_COLLAPSED_ITEM_COUNT = 3;
const HOVER_CHART_OPEN_DELAY_MS = 180;
const HOVER_CHART_CLOSE_DELAY_MS = 180;

type EntrySymbol = { ticker: string; name: string | null };
type SectorEntry = {
  id: string;
  sectorName: string;
  eventDate: string;
  trendScore: number;
  notes: string | null;
  symbols: EntrySymbol[];
};

type WatchlistEtf = {
  listType: "sector" | "industry";
  parentSector: string | null;
  industry: string | null;
  ticker: string;
  fundName: string;
  sortOrder: number;
  change1d: number;
  lastPrice: number;
};

type EtfConstituent = {
  ticker: string;
  name: string | null;
  weight: number | null;
  change1d?: number;
  lastPrice?: number;
};

type HoverChartTarget = {
  ticker: string;
  rect: DOMRect;
};

type HoverChartPreview = {
  ticker: string;
  style: CSSProperties;
};

const SECTION_NAV_ITEMS: Array<{ id: string; label: string }> = [
  { id: "key-movers-tracker", label: "Key Movers Tracker" },
  { id: "sector-etfs", label: "Sector ETFs" },
  { id: "industry-etfs", label: "Industry ETFs" },
];

const FALLBACK_SECTOR_ETFS: WatchlistEtf[] = [
  { listType: "sector", parentSector: "Materials", industry: "Sector ETF", ticker: "XLB", fundName: "Materials Select Sector SPDR Fund", sortOrder: 1, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Communication Services", industry: "Sector ETF", ticker: "XLC", fundName: "Communication Services Select Sector SPDR Fund", sortOrder: 2, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Financials", industry: "Sector ETF", ticker: "XLF", fundName: "Financial Select Sector SPDR Fund", sortOrder: 3, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Energy", industry: "Sector ETF", ticker: "XLE", fundName: "Energy Select Sector SPDR Fund", sortOrder: 4, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Industrials", industry: "Sector ETF", ticker: "XLI", fundName: "Industrial Select Sector SPDR Fund", sortOrder: 5, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Health Care", industry: "Sector ETF", ticker: "XLV", fundName: "Health Care Select Sector SPDR Fund", sortOrder: 6, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Information Technology", industry: "Sector ETF", ticker: "XLK", fundName: "Technology Select Sector SPDR Fund", sortOrder: 7, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Consumer Staples", industry: "Sector ETF", ticker: "XLP", fundName: "Consumer Staples Select Sector SPDR Fund", sortOrder: 8, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Real Estate", industry: "Sector ETF", ticker: "XLRE", fundName: "Real Estate Select Sector SPDR Fund", sortOrder: 9, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Consumer Discretionary", industry: "Sector ETF", ticker: "XLY", fundName: "Consumer Discretionary Select Sector SPDR Fund", sortOrder: 10, change1d: 0, lastPrice: 0 },
  { listType: "sector", parentSector: "Utilities", industry: "Sector ETF", ticker: "XLU", fundName: "Utilities Select Sector SPDR Fund", sortOrder: 11, change1d: 0, lastPrice: 0 },
];

const FALLBACK_INDUSTRY_ETFS: WatchlistEtf[] = [
  { listType: "industry", parentSector: "Information Technology", industry: "Semiconductors", ticker: "SMH", fundName: "VanEck Semiconductor ETF", sortOrder: 1, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Information Technology", industry: "Semiconductors", ticker: "SOXX", fundName: "iShares Semiconductor ETF", sortOrder: 2, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Information Technology", industry: "Software", ticker: "IGV", fundName: "iShares Expanded Tech-Software Sector ETF", sortOrder: 3, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Health Care", industry: "Biotech", ticker: "XBI", fundName: "SPDR S&P Biotech ETF", sortOrder: 4, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Health Care", industry: "Pharmaceuticals", ticker: "IHE", fundName: "iShares U.S. Pharmaceuticals ETF", sortOrder: 5, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Industrials", industry: "Aerospace & Defense", ticker: "ITA", fundName: "iShares U.S. Aerospace & Defense ETF", sortOrder: 6, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Energy", industry: "Oil & Gas", ticker: "XOP", fundName: "SPDR S&P Oil & Gas Exploration & Production ETF", sortOrder: 7, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Financials", industry: "Banks", ticker: "KRE", fundName: "SPDR S&P Regional Banking ETF", sortOrder: 8, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Consumer Discretionary", industry: "Homebuilders", ticker: "ITB", fundName: "iShares U.S. Home Construction ETF", sortOrder: 9, change1d: 0, lastPrice: 0 },
  { listType: "industry", parentSector: "Utilities", industry: "Broad Utilities", ticker: "XLU", fundName: "Utilities Select Sector SPDR Fund", sortOrder: 10, change1d: 0, lastPrice: 0 },
];

const FALLBACK_KEY_MOVERS: SectorEntry[] = [
  {
    id: "se-1",
    sectorName: "Semiconductors",
    eventDate: "2026-02-18",
    trendScore: 82,
    notes: "Earnings beats and AI capex guides accelerating.",
    symbols: [{ ticker: "SMH", name: "VanEck Semiconductor ETF" }, { ticker: "NVDA", name: "NVIDIA Corp" }, { ticker: "AMD", name: "Advanced Micro Devices Inc" }, { ticker: "AVGO", name: "Broadcom Inc" }],
  },
  {
    id: "se-2",
    sectorName: "Utilities",
    eventDate: "2026-02-21",
    trendScore: 68,
    notes: "Power demand upgrades from hyperscaler capex plans.",
    symbols: [{ ticker: "XLU", name: "Utilities Select Sector SPDR Fund" }, { ticker: "NEE", name: "NextEra Energy Inc" }, { ticker: "DUK", name: "Duke Energy Corp" }],
  },
  {
    id: "se-3",
    sectorName: "Homebuilders",
    eventDate: "2026-02-24",
    trendScore: 61,
    notes: "Mortgage rates eased, builders showing relative strength.",
    symbols: [{ ticker: "ITB", name: "iShares U.S. Home Construction ETF" }, { ticker: "XHB", name: "SPDR S&P Homebuilders ETF" }, { ticker: "LEN", name: "Lennar Corp" }],
  },
];

function segmentedButtonClass(active: boolean) {
  return active
    ? "bg-accent/16 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.28)]"
    : "text-slate-300 hover:bg-panelSoft/45";
}

function formatFundPrice(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function computeHoverPreviewStyle(anchorRect: DOMRect): CSSProperties {
  if (typeof window === "undefined") {
    return { top: 16, left: 16, width: 960 };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const gutter = 16;
  const previewGap = 14;
  const minWidth = 420;
  const maxWidth = Math.min(960, viewportWidth - gutter * 2);
  const availableRight = viewportWidth - anchorRect.right - previewGap - gutter;
  const availableLeft = anchorRect.left - previewGap - gutter;
  const preferredSide = availableRight >= availableLeft ? "right" : "left";
  const bestSideSpace = Math.max(availableRight, availableLeft);

  let width = maxWidth;
  let left = gutter;
  let top = anchorRect.top - 20;

  if (bestSideSpace >= minWidth) {
    width = Math.min(maxWidth, bestSideSpace);
    left = preferredSide === "right"
      ? anchorRect.right + previewGap
      : anchorRect.left - width - previewGap;
  } else {
    left = Math.min(
      Math.max(gutter, anchorRect.left + anchorRect.width / 2 - width / 2),
      viewportWidth - width - gutter,
    );
    top = anchorRect.bottom + previewGap;
  }

  const estimatedHeight = Math.min(viewportHeight - gutter * 2, Math.max(420, Math.round(width * 0.7)));

  if (top + estimatedHeight + gutter > viewportHeight) {
    top = anchorRect.top - estimatedHeight - previewGap;
  }

  top = Math.min(Math.max(gutter, top), viewportHeight - estimatedHeight - gutter);

  return {
    top,
    left,
    width,
  };
}

function CollapsibleSection({
  title,
  description,
  defaultOpen = true,
  children,
  rightSlot,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  rightSlot?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="card overflow-hidden">
      <Collapsible.Trigger className="flex w-full items-center justify-between gap-4 border-b border-borderSoft/70 bg-gradient-to-r from-panelSoft/55 to-panel/35 px-5 py-4 text-left transition hover:from-panelSoft/65 hover:to-panel/45">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Section</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="text-base font-semibold text-slate-100">{title}</span>
            {rightSlot}
          </div>
          {description ? <p className="mt-1 max-w-3xl text-sm text-slate-400">{description}</p> : null}
        </div>
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-borderSoft/60 bg-panelSoft/35">
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content className="bg-panel/25 p-4 md:p-5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function EtfTile({
  etf,
  eyebrow,
  onOpenEtf,
  onExpandChart,
}: {
  etf: WatchlistEtf;
  eyebrow?: string | null;
  onOpenEtf: () => void;
  onExpandChart: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4 px-1 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? (
            <span className="inline-flex rounded-full bg-panelSoft/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
              {eyebrow}
            </span>
          ) : null}
          <div className={`${eyebrow ? "mt-3" : ""} flex flex-wrap items-center gap-2`}>
            <button className="text-left text-lg font-semibold text-accent transition hover:underline" onClick={onOpenEtf}>
              {etf.ticker}
            </button>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${deltaPillCls(etf.change1d ?? 0)}`}>
              {signedPct(etf.change1d ?? 0)}
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-slate-400">{etf.fundName}</p>
        </div>
        <div className="bg-panelSoft/35 px-3 py-2 text-right">
          <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Last</div>
          <div className="mt-1 text-sm font-semibold text-slate-100">{formatFundPrice(etf.lastPrice ?? 0)}</div>
        </div>
      </div>
      <div className="bg-slate-950/20 p-2.5">
        <TradingViewWidget ticker={etf.ticker} size="small" chartOnly showStatusLine initialRange="3M" surface="plain" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">Click the ticker to open constituent detail.</p>
        <button className={SECONDARY_BUTTON_CLASS} onClick={onExpandChart}>
          <Maximize2 className="h-3.5 w-3.5" />
          Expand chart
        </button>
      </div>
    </div>
  );
}

export function SectorTracker() {
  const [view, setView] = useState<"list" | "calendar">("calendar");
  const [month, setMonth] = useState(formatLocalMonthKey());
  const [entries, setEntries] = useState<SectorEntry[]>([]);
  const [calendarRows, setCalendarRows] = useState<SectorEntry[]>([]);
  const [symbolOptions, setSymbolOptions] = useState<Array<{ ticker: string; name: string | null }>>([]);
  const [sectorEtfs, setSectorEtfs] = useState<WatchlistEtf[]>([]);
  const [industryEtfs, setIndustryEtfs] = useState<WatchlistEtf[]>([]);

  const [sectorNarrativeExisting, setSectorNarrativeExisting] = useState("");
  const [sectorNarrativeNew, setSectorNarrativeNew] = useState("");
  const [eventDate, setEventDate] = useState(() => getDefaultSectorEventDate());
  const [notes, setNotes] = useState("");
  const [tickerInput, setTickerInput] = useState("");
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const [activeEtf, setActiveEtf] = useState<{ ticker: string; fundName?: string | null } | null>(null);
  const [constituents, setConstituents] = useState<EtfConstituent[]>([]);
  const [constituentWarning, setConstituentWarning] = useState<string | null>(null);
  const [constituentLoading, setConstituentLoading] = useState(false);
  const [activeNarrativeEntry, setActiveNarrativeEntry] = useState<SectorEntry | null>(null);
  const [narrativePage, setNarrativePage] = useState(1);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const [hoverChartTarget, setHoverChartTarget] = useState<HoverChartTarget | null>(null);
  const [hoverChartPreview, setHoverChartPreview] = useState<HoverChartPreview | null>(null);
  const [isHoverPreviewHovered, setIsHoverPreviewHovered] = useState(false);
  const [supportsTickerHover, setSupportsTickerHover] = useState(false);
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [constituentSort, setConstituentSort] = useState<"weight" | "change1d">("change1d");
  const [constituentPage, setConstituentPage] = useState(1);
  const [editingEntry, setEditingEntry] = useState<SectorEntry | null>(null);
  const [editSectorName, setEditSectorName] = useState("");
  const [editEventDate, setEditEventDate] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editTickerInput, setEditTickerInput] = useState("");
  const [editTickers, setEditTickers] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [expandedCalendarDates, setExpandedCalendarDates] = useState<string[]>([]);
  const hoverOpenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    const [entriesRes, calRes, symbolRes, sectorEtfRes, industryEtfRes] = await Promise.allSettled([
      getSectorEntries(),
      getSectorCalendar(month),
      getSectorSymbolOptions(),
      getSectorEtfs(),
      getIndustryEtfs(),
    ]);

    const entriesRows = entriesRes.status === "fulfilled" ? entriesRes.value.rows ?? [] : [];
    const calRows = calRes.status === "fulfilled" ? calRes.value.rows ?? [] : [];
    const symbolRows = symbolRes.status === "fulfilled" ? symbolRes.value.rows ?? [] : [];
    const sectorRows = sectorEtfRes.status === "fulfilled" ? sectorEtfRes.value.rows ?? [] : [];
    const industryRows = industryEtfRes.status === "fulfilled" ? industryEtfRes.value.rows ?? [] : [];

    setEntries(entriesRows.length > 0 ? entriesRows : FALLBACK_KEY_MOVERS);
    setCalendarRows(calRows.length > 0 ? calRows : FALLBACK_KEY_MOVERS);
    setSymbolOptions(symbolRows);
    setSectorEtfs((sectorRows.length > 0 ? sectorRows : FALLBACK_SECTOR_ETFS) as WatchlistEtf[]);
    setIndustryEtfs((industryRows.length > 0 ? industryRows : FALLBACK_INDUSTRY_ETFS) as WatchlistEtf[]);
  };

  useEffect(() => {
    void load();
  }, [month]);

  useEffect(() => {
    setExpandedCalendarDates([]);
  }, [month]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const syncHoverSupport = () => setSupportsTickerHover(mediaQuery.matches);
    syncHoverSupport();
    mediaQuery.addEventListener?.("change", syncHoverSupport);
    return () => mediaQuery.removeEventListener?.("change", syncHoverSupport);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverOpenTimeoutRef.current) clearTimeout(hoverOpenTimeoutRef.current);
      if (hoverCloseTimeoutRef.current) clearTimeout(hoverCloseTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!supportsTickerHover || !hoverChartTarget || activeChartTicker) {
      if (hoverOpenTimeoutRef.current) {
        clearTimeout(hoverOpenTimeoutRef.current);
        hoverOpenTimeoutRef.current = null;
      }
      return;
    }
    if (hoverChartPreview?.ticker === hoverChartTarget.ticker) return;
    if (hoverOpenTimeoutRef.current) clearTimeout(hoverOpenTimeoutRef.current);
    hoverOpenTimeoutRef.current = setTimeout(() => {
      setHoverChartPreview({
        ticker: hoverChartTarget.ticker,
        style: computeHoverPreviewStyle(hoverChartTarget.rect),
      });
      hoverOpenTimeoutRef.current = null;
    }, HOVER_CHART_OPEN_DELAY_MS);
    return () => {
      if (hoverOpenTimeoutRef.current) {
        clearTimeout(hoverOpenTimeoutRef.current);
        hoverOpenTimeoutRef.current = null;
      }
    };
  }, [activeChartTicker, hoverChartPreview?.ticker, hoverChartTarget, supportsTickerHover]);

  useEffect(() => {
    if (!hoverChartPreview) {
      if (hoverCloseTimeoutRef.current) {
        clearTimeout(hoverCloseTimeoutRef.current);
        hoverCloseTimeoutRef.current = null;
      }
      return;
    }
    if (hoverChartTarget || isHoverPreviewHovered || activeChartTicker) {
      if (hoverCloseTimeoutRef.current) {
        clearTimeout(hoverCloseTimeoutRef.current);
        hoverCloseTimeoutRef.current = null;
      }
      return;
    }
    if (hoverCloseTimeoutRef.current) clearTimeout(hoverCloseTimeoutRef.current);
    hoverCloseTimeoutRef.current = setTimeout(() => {
      setHoverChartPreview(null);
      hoverCloseTimeoutRef.current = null;
    }, HOVER_CHART_CLOSE_DELAY_MS);
    return () => {
      if (hoverCloseTimeoutRef.current) {
        clearTimeout(hoverCloseTimeoutRef.current);
        hoverCloseTimeoutRef.current = null;
      }
    };
  }, [activeChartTicker, hoverChartPreview, hoverChartTarget, isHoverPreviewHovered]);

  useEffect(() => {
    if (!supportsTickerHover || !hoverChartTarget || !hoverChartPreview) return;
    if (hoverChartPreview.ticker !== hoverChartTarget.ticker) return;
    setHoverChartPreview((current) => {
      if (!current || current.ticker !== hoverChartTarget.ticker) return current;
      return {
        ticker: current.ticker,
        style: computeHoverPreviewStyle(hoverChartTarget.rect),
      };
    });
  }, [hoverChartPreview, hoverChartTarget, supportsTickerHover]);

  const openEtfPopup = async (ticker: string, fundName?: string | null) => {
    setActiveEtf({ ticker, fundName: fundName ?? null });
    setConstituentLoading(true);
    setConstituentWarning(null);
    setConstituents([]);
    setConstituentSort("change1d");
    setConstituentPage(1);
    try {
      const res = await getEtfConstituents(ticker);
      setConstituents((res.rows ?? []) as EtfConstituent[]);
      setConstituentWarning(res.warning ?? null);
    } catch (error) {
      setConstituentWarning(error instanceof Error ? error.message : "Failed to load ETF constituents.");
    } finally {
      setConstituentLoading(false);
    }
  };

  const openNarrativeEntry = (entry: SectorEntry) => {
    if (hoverOpenTimeoutRef.current) {
      clearTimeout(hoverOpenTimeoutRef.current);
      hoverOpenTimeoutRef.current = null;
    }
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
    setHoverChartTarget(null);
    setHoverChartPreview(null);
    setIsHoverPreviewHovered(false);
    setActiveNarrativeEntry(entry);
    setNarrativePage(1);
  };

  const handleNarrativeEntryKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, entry: SectorEntry) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openNarrativeEntry(entry);
  };

  const addTicker = (inputRaw: string) => {
    const parsed = inputRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .filter((s) => /^[A-Z.\-^]{1,20}$/.test(s));
    if (parsed.length === 0) return;
    setSelectedTickers((prev) => Array.from(new Set([...prev, ...parsed])));
  };

  const addEditTicker = (inputRaw: string) => {
    const parsed = inputRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .filter((s) => /^[A-Z.\-^]{1,20}$/.test(s));
    if (parsed.length === 0) return;
    setEditTickers((prev) => Array.from(new Set([...prev, ...parsed])));
  };

  const openEditEntry = (entry: SectorEntry) => {
    setEditingEntry(entry);
    setEditSectorName(entry.sectorName);
    setEditEventDate(entry.eventDate);
    setEditNotes(entry.notes ?? "");
    setEditTickers((entry.symbols ?? []).map((s) => s.ticker.toUpperCase()));
    setEditTickerInput("");
    setEditError(null);
  };

  const saveEntryEdit = async () => {
    if (!editingEntry) return;
    if (!editSectorName.trim() || !editEventDate) {
      setEditError("Sector/Narrative and date are required.");
      return;
    }
    try {
      await updateSectorEntry(editingEntry.id, {
        sectorName: editSectorName.trim(),
        eventDate: editEventDate,
        trendScore: editingEntry.trendScore ?? 0,
        notes: editNotes.trim() || null,
        symbols: editTickers,
      });
      setEditingEntry(null);
      setEditError(null);
      await load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update sector/narrative entry.");
    }
  };

  const removeEntry = async (entryId: string) => {
    if (!window.confirm("Delete this sector/narrative entry?")) return;
    try {
      await deleteSectorEntry(entryId);
      if (editingEntry?.id === entryId) setEditingEntry(null);
      if (activeNarrativeEntry?.id === entryId) setActiveNarrativeEntry(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to delete entry.");
    }
  };

  const daysInMonth = useMemo(() => getDaysInMonth(month), [month]);
  const monthStartWeekday = useMemo(() => getMonthStartWeekday(month), [month]);
  const todayDate = useMemo(() => formatLocalDateInputValue(), []);

  const calendarCells = useMemo(() => {
    const cells: Array<{ key: string; date: string | null; day: number | null }> = [];
    for (let i = 0; i < monthStartWeekday; i += 1) {
      cells.push({ key: `blank-start-${i}`, date: null, day: null });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      cells.push({ key: date, date, day });
    }
    const trailingCells = (7 - (cells.length % 7)) % 7;
    for (let i = 0; i < trailingCells; i += 1) {
      cells.push({ key: `blank-end-${i}`, date: null, day: null });
    }
    return cells;
  }, [daysInMonth, month, monthStartWeekday]);

  const calendarMap = useMemo(() => {
    const map = new Map<string, SectorEntry[]>();
    for (const row of calendarRows) {
      const arr = map.get(row.eventDate) ?? [];
      arr.push(row);
      map.set(row.eventDate, arr);
    }
    return map;
  }, [calendarRows]);

  const industryGroups = useMemo(() => {
    const groups = new Map<string, { rows: WatchlistEtf[]; maxChange: number }>();
    for (const row of industryEtfs) {
      const key = `${row.parentSector ?? "Other"} :: ${row.industry ?? "General"}`;
      const existing = groups.get(key) ?? { rows: [], maxChange: Number.NEGATIVE_INFINITY };
      existing.rows.push(row);
      existing.maxChange = Math.max(existing.maxChange, row.change1d ?? 0);
      groups.set(key, existing);
    }

    return [...groups.entries()]
      .map(([key, value]) => ({
        key,
        maxChange: value.maxChange === Number.NEGATIVE_INFINITY ? 0 : value.maxChange,
        rows: [...value.rows].sort((a, b) => b.change1d - a.change1d),
      }))
      .sort((a, b) => b.maxChange - a.maxChange);
  }, [industryEtfs]);

  const sortedConstituents = useMemo(() => {
    const rows = [...constituents];
    if (constituentSort === "change1d") {
      rows.sort((a, b) => (b.change1d ?? 0) - (a.change1d ?? 0));
      return rows;
    }
    rows.sort((a, b) => (b.weight ?? Number.NEGATIVE_INFINITY) - (a.weight ?? Number.NEGATIVE_INFINITY));
    return rows;
  }, [constituents, constituentSort]);

  const pagedConstituents = useMemo(
    () => sortedConstituents.slice((constituentPage - 1) * CHARTS_PER_PAGE, constituentPage * CHARTS_PER_PAGE),
    [constituentPage, sortedConstituents],
  );

  const pagedNarrativeSymbols = useMemo(
    () => (activeNarrativeEntry?.symbols ?? []).slice((narrativePage - 1) * CHARTS_PER_PAGE, narrativePage * CHARTS_PER_PAGE),
    [activeNarrativeEntry, narrativePage],
  );

  const etfModalItems = useMemo<TickerCollectionModalItem[]>(
    () =>
      pagedConstituents.map((row) => ({
        key: `${activeEtf?.ticker ?? "etf"}-${row.ticker}`,
        ticker: row.ticker,
        name: row.name ?? row.ticker,
        metricLabel: "Weight",
        metricValue: row.weight != null ? `${row.weight.toFixed(2)}%` : "-",
        badges: (
          <>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${deltaPillCls(row.change1d ?? 0)}`}>
              {signedPct(row.change1d ?? 0)}
            </span>
            <span className="text-slate-400">{formatFundPrice(row.lastPrice ?? 0)}</span>
          </>
        ),
      })),
    [activeEtf?.ticker, pagedConstituents],
  );

  const narrativeModalItems = useMemo<TickerCollectionModalItem[]>(
    () =>
      pagedNarrativeSymbols.map((symbol) => ({
        key: `${activeNarrativeEntry?.id ?? "entry"}-${symbol.ticker}`,
        ticker: symbol.ticker,
        name: symbol.name ?? symbol.ticker,
      })),
    [activeNarrativeEntry?.id, pagedNarrativeSymbols],
  );

  const sectorNarrativeOptions = useMemo(() => {
    const options = new Set<string>();
    for (const row of entries) {
      if (row.sectorName?.trim()) options.add(row.sectorName.trim());
    }
    for (const row of calendarRows) {
      if (row.sectorName?.trim()) options.add(row.sectorName.trim());
    }
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [entries, calendarRows]);

  const openExpandedChart = (ticker: string) => {
    if (hoverOpenTimeoutRef.current) {
      clearTimeout(hoverOpenTimeoutRef.current);
      hoverOpenTimeoutRef.current = null;
    }
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
    setHoverChartTarget(null);
    setHoverChartPreview(null);
    setIsHoverPreviewHovered(false);
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    if (hoverOpenTimeoutRef.current) {
      clearTimeout(hoverOpenTimeoutRef.current);
      hoverOpenTimeoutRef.current = null;
    }
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
    setHoverChartTarget(null);
    setHoverChartPreview(null);
    setIsHoverPreviewHovered(false);
    setActiveChartTicker(null);
  };

  const handleTickerChipMouseEnter = (ticker: string, event: MouseEvent<HTMLButtonElement>) => {
    if (!supportsTickerHover) return;
    setHoverChartTarget({ ticker, rect: event.currentTarget.getBoundingClientRect() });
  };

  const handleTickerChipMouseLeave = (ticker: string) => {
    if (!supportsTickerHover) return;
    setHoverChartTarget((current) => (current?.ticker === ticker ? null : current));
  };

  const toggleCalendarDateExpansion = (date: string) => {
    setExpandedCalendarDates((prev) => (prev.includes(date) ? prev.filter((value) => value !== date) : [...prev, date]));
  };

  useEffect(() => {
    setConstituentPage(1);
  }, [activeEtf?.ticker, constituentSort, sortedConstituents.length]);

  useEffect(() => {
    setNarrativePage(1);
  }, [activeNarrativeEntry?.id, activeNarrativeEntry?.symbols.length]);

  return (
    <div className="space-y-5">
      <FloatingSectionNav items={SECTION_NAV_ITEMS} />

      <datalist id="sector-symbol-options">
        {symbolOptions.map((s) => (
          <option key={`sector-symbol-option-global-${s.ticker}`} value={s.ticker}>
            {s.name ? `${s.ticker} - ${s.name}` : s.ticker}
          </option>
        ))}
      </datalist>

      <div id="key-movers-tracker" className="scroll-mt-28 md:scroll-mt-32">
        <CollapsibleSection
          title="Key Movers Tracker"
          description="Capture sector narratives, keep a running calendar, and jump straight into the tickers that matter."
          rightSlot={<span className="rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent">{entries.length} entries</span>}
        >
          <div className="space-y-4">
            <div className="bg-panelSoft/20 p-4">
              <div className="flex justify-end">
                <button className={SECONDARY_BUTTON_CLASS} onClick={() => setAddFormOpen((v) => !v)}>
                  <ChevronDown className={`h-4 w-4 transition-transform ${addFormOpen ? "rotate-180" : ""}`} />
                  {addFormOpen ? "Hide entry form" : "Add entry"}
                </button>
              </div>

              {addFormOpen ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
                    <label className="space-y-1 xl:col-span-2">
                      <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Existing Narrative</span>
                      <select className={INPUT_CLASS} value={sectorNarrativeExisting} onChange={(e) => setSectorNarrativeExisting(e.target.value)}>
                        <option value="">Select existing Sector/Narrative...</option>
                        {sectorNarrativeOptions.map((opt) => (
                          <option key={`sector-narrative-${opt}`} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 xl:col-span-2">
                      <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">New Narrative</span>
                      <input
                        className={INPUT_CLASS}
                        placeholder="Or add new Sector/Narrative"
                        value={sectorNarrativeNew}
                        onChange={(e) => setSectorNarrativeNew(e.target.value)}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Date</span>
                      <input type="date" className={INPUT_CLASS} value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
                    </label>
                    <label className="space-y-1 xl:col-span-2">
                      <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Tickers</span>
                      <input
                        className={INPUT_CLASS}
                        placeholder="Add tickers (comma-separated)"
                        value={tickerInput}
                        onChange={(e) => setTickerInput(e.target.value)}
                        list="sector-symbol-options"
                      />
                    </label>
                    <label className="space-y-1 xl:col-span-5">
                      <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Notes</span>
                      <textarea className={`${INPUT_CLASS} min-h-24 resize-y`} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </label>
                    <div className="flex items-end">
                      <button
                        className={`${SECONDARY_BUTTON_CLASS} w-full`}
                        onClick={() => {
                          addTicker(tickerInput);
                          setTickerInput("");
                        }}
                      >
                        Add tickers
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {selectedTickers.map((ticker) => (
                      <span key={ticker} className="inline-flex items-center gap-1 rounded-full bg-slate-800/70 px-3 py-1.5 text-xs text-slate-200">
                        {ticker}
                        <button
                          className="rounded-full p-0.5 text-slate-400 transition hover:bg-slate-700/70 hover:text-slate-100"
                          onClick={() => setSelectedTickers((prev) => prev.filter((t) => t !== ticker))}
                          aria-label={`Remove ${ticker}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {selectedTickers.length === 0 ? <p className="text-sm text-slate-500">No tickers attached yet.</p> : null}
                  </div>

                  {formError ? <p className="text-sm text-red-300">{formError}</p> : null}

                  <div className="flex justify-end">
                    <button
                      className="inline-flex items-center justify-center rounded-xl bg-accent/18 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/24"
                      onClick={async () => {
                        setFormError(null);
                        const sectorNarrative = (sectorNarrativeNew.trim() || sectorNarrativeExisting.trim()).trim();
                        if (!sectorNarrative || !eventDate) {
                          setFormError("Sector/Narrative and date are required.");
                          return;
                        }
                        try {
                          await adminFetch("/api/sectors/entries", {
                            method: "POST",
                            body: JSON.stringify({
                              sectorName: sectorNarrative.trim(),
                              eventDate,
                              trendScore: 0,
                              notes: notes.trim() || null,
                              symbols: selectedTickers,
                            }),
                          });
                          setSectorNarrativeExisting("");
                          setSectorNarrativeNew("");
                          setEventDate(getDefaultSectorEventDate());
                          setNotes("");
                          setSelectedTickers([]);
                          setTickerInput("");
                          await load();
                        } catch (err) {
                          setFormError(err instanceof Error ? err.message : "Failed to add sector/narrative entry.");
                        }
                      }}
                    >
                      Save entry
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="bg-panel/20 p-4 md:p-5">
              <div className="mb-4 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="space-y-1">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Data View</p>
                  <h3 className="text-base font-semibold text-slate-100">
                    {view === "list" ? "Narrative list" : "Sector / narrative calendar"}
                  </h3>
                  <p className="text-sm text-slate-400">
                    Switch between a compact table view and the monthly calendar without changing the underlying dataset.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex rounded-2xl border border-borderSoft/60 bg-panelSoft/35 p-1">
                    <button
                      className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition ${segmentedButtonClass(view === "list")}`}
                      onClick={() => setView("list")}
                    >
                      <List className="h-4 w-4" />
                      List
                    </button>
                    <button
                      className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition ${segmentedButtonClass(view === "calendar")}`}
                      onClick={() => setView("calendar")}
                    >
                      <CalendarDays className="h-4 w-4" />
                      Calendar
                    </button>
                  </div>
                  {view === "calendar" ? (
                    <label className="inline-flex items-center gap-2 rounded-2xl border border-borderSoft/60 bg-panelSoft/35 px-3 py-2 text-sm text-slate-300">
                      <CalendarDays className="h-4 w-4 text-slate-400" />
                      <span className="text-slate-400">Month</span>
                      <input type="month" className="bg-transparent text-slate-100 outline-none" value={month} onChange={(e) => setMonth(e.target.value)} />
                    </label>
                  ) : null}
                </div>
              </div>

              {view === "list" ? (
                <div className="overflow-hidden bg-panel/35">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-900/60">
                        <tr>
                          {["Date", "Sector/Narrative", "Tickers", "Notes", "Actions"].map((h) => (
                            <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((e) => (
                          <tr key={e.id} className="border-t border-borderSoft/60 align-top transition hover:bg-panelSoft/25">
                            <td className="whitespace-nowrap px-4 py-3 text-slate-300">{e.eventDate}</td>
                            <td className="px-4 py-3 font-medium text-slate-100">{e.sectorName}</td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1.5">
                                {(e.symbols ?? []).length === 0 ? <span className="text-slate-500">-</span> : null}
                                {(e.symbols ?? []).map((s) => (
                                  <button
                                    key={`${e.id}-${s.ticker}`}
                                    className={TICKER_CHIP_CLASS}
                                    onClick={() => openExpandedChart(s.ticker)}
                                    onMouseEnter={(event) => handleTickerChipMouseEnter(s.ticker, event)}
                                    onMouseLeave={() => handleTickerChipMouseLeave(s.ticker)}
                                    title={s.name ?? s.ticker}
                                  >
                                    {s.ticker}
                                  </button>
                                ))}
                              </div>
                            </td>
                            <td className="max-w-xl px-4 py-3 text-slate-300">{e.notes ?? "-"}</td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-2">
                                <button className={SECONDARY_BUTTON_CLASS} onClick={() => openEditEntry(e)}>
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </button>
                                <button
                                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/35 bg-red-500/8 px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/14"
                                  onClick={() => void removeEntry(e.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {entries.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                              No sector narratives available yet.
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-7 gap-2">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                      <div
                        key={d}
                        className="bg-panelSoft/25 px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400"
                      >
                        {d}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-2">
                    {calendarCells.map(({ key, date, day }) => {
                      if (!date || !day) {
                        return <div key={key} aria-hidden="true" className="min-h-[12rem] bg-transparent" />;
                      }

                      const items = calendarMap.get(date) ?? [];
                      const isToday = date === todayDate;
                      const isExpanded = expandedCalendarDates.includes(date);
                      const visibleItems = isExpanded ? items : items.slice(0, CALENDAR_COLLAPSED_ITEM_COUNT);
                      const hiddenItemCount = Math.max(0, items.length - CALENDAR_COLLAPSED_ITEM_COUNT);

                      return (
                        <div
                          key={date}
                          className={`min-h-[12rem] p-3 ${
                            isToday
                              ? "bg-accent/8 shadow-[0_0_0_1px_rgba(56,189,248,0.22)]"
                              : "bg-panelSoft/30"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className={`text-sm font-semibold ${isToday ? "text-accent" : "text-slate-300"}`}>{day}</div>
                            {isToday ? (
                              <span className="rounded-full bg-accent/14 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
                                Today
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-3 space-y-2">
                            {visibleItems.map((it) => (
                              <div
                                key={it.id}
                                className="rounded-2xl bg-panel/70 p-2.5 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.06)] transition hover:bg-panel/80 focus:outline-none focus:ring-2 focus:ring-accent/25"
                                role="button"
                                tabIndex={0}
                                onClick={() => openNarrativeEntry(it)}
                                onKeyDown={(event) => handleNarrativeEntryKeyDown(event, it)}
                                aria-label={`Open chart grid for ${it.sectorName} on ${it.eventDate}`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="text-xs font-semibold text-slate-100">{it.sectorName}</div>
                                  <div className="flex gap-1">
                                    <button
                                      className={ICON_BUTTON_CLASS}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openEditEntry(it);
                                      }}
                                      title="Edit entry"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-red-500/35 bg-red-500/8 text-red-300 transition hover:bg-red-500/14"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void removeEntry(it.id);
                                      }}
                                      title="Delete entry"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {(it.symbols ?? []).map((s) => (
                                    <button
                                      key={`${it.id}-${s.ticker}`}
                                      className={TICKER_CHIP_CLASS}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openExpandedChart(s.ticker);
                                      }}
                                      onMouseEnter={(event) => handleTickerChipMouseEnter(s.ticker, event)}
                                      onMouseLeave={() => handleTickerChipMouseLeave(s.ticker)}
                                      title={s.name ?? s.ticker}
                                    >
                                      {s.ticker}
                                    </button>
                                  ))}
                                </div>
                                {it.notes ? <p className="mt-2 text-xs leading-relaxed text-slate-400">{it.notes}</p> : null}
                              </div>
                            ))}
                            {hiddenItemCount > 0 ? (
                              <button
                                type="button"
                                className="w-full rounded-xl bg-panel/35 px-2.5 py-2 text-left text-xs text-slate-400 transition hover:bg-panel/55 hover:text-slate-200"
                                onClick={() => toggleCalendarDateExpansion(date)}
                                aria-expanded={isExpanded}
                              >
                                {isExpanded
                                  ? "Show fewer entries"
                                  : `+${hiddenItemCount} more entr${hiddenItemCount === 1 ? "y" : "ies"}`}
                              </button>
                            ) : isExpanded && items.length > CALENDAR_COLLAPSED_ITEM_COUNT ? (
                              <button
                                type="button"
                                className="w-full rounded-xl bg-panel/35 px-2.5 py-2 text-left text-xs text-slate-400 transition hover:bg-panel/55 hover:text-slate-200"
                                onClick={() => toggleCalendarDateExpansion(date)}
                                aria-expanded={isExpanded}
                              >
                                Show fewer entries
                              </button>
                            ) : null}
                            {items.length === 0 ? <p className="text-xs text-slate-500">No narratives scheduled.</p> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CollapsibleSection>
      </div>

      <div id="sector-etfs" className="scroll-mt-28 md:scroll-mt-32">
        <CollapsibleSection
          title="Sector ETFs"
          description="Primary sector funds with constituent drilldowns and faster chart scanning."
          rightSlot={<span className="rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent">{sectorEtfs.length} ETFs</span>}
        >
          <div className="grid gap-x-6 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
            {sectorEtfs.map((etf) => (
              <EtfTile
                key={etf.ticker}
                etf={etf}
                eyebrow={etf.parentSector}
                onOpenEtf={() => void openEtfPopup(etf.ticker, etf.fundName)}
                onExpandChart={() => openExpandedChart(etf.ticker)}
              />
            ))}
          </div>
        </CollapsibleSection>
      </div>

      <div id="industry-etfs" className="scroll-mt-28 md:scroll-mt-32">
        <CollapsibleSection
          title="Industry ETFs"
          description="Industry funds stay grouped by parent sector so the distinctions read clearly before you drill into charts."
          rightSlot={<span className="rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent">{industryEtfs.length} ETFs</span>}
        >
          <div className="space-y-4">
            {industryGroups.map(({ key, rows, maxChange }) => {
              const [parentSector, industry] = key.split(" :: ");

              return (
                <div key={key} className="space-y-5 px-1 py-2">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div className="space-y-1">
                      <div className="inline-flex rounded-full bg-panelSoft/65 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-400">
                        {parentSector}
                      </div>
                      <h4 className="text-lg font-semibold text-slate-100">{industry}</h4>
                      <p className="text-sm text-slate-400">{rows.length} related fund{rows.length === 1 ? "" : "s"} in this group.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${deltaPillCls(maxChange)}`}>
                        Top move {signedPct(maxChange)}
                      </span>
                    </div>
                  </div>

                  <div className="grid gap-x-6 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
                    {rows.map((etf) => (
                      <EtfTile
                        key={`${key}-${etf.ticker}`}
                        etf={etf}
                        onOpenEtf={() => void openEtfPopup(etf.ticker, etf.fundName)}
                        onExpandChart={() => openExpandedChart(etf.ticker)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      </div>
      {editingEntry ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setEditingEntry(null)}>
          <div
            className="w-full max-w-3xl overflow-hidden rounded-[28px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Edit Entry</p>
                <h4 className="mt-1 text-base font-semibold text-slate-100">Update sector / narrative details</h4>
              </div>
              <button className={SECONDARY_BUTTON_CLASS} onClick={() => setEditingEntry(null)}>
                Close
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid gap-3 md:grid-cols-6">
                <label className="space-y-1 md:col-span-2">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Narrative</span>
                  <input className={INPUT_CLASS} value={editSectorName} onChange={(e) => setEditSectorName(e.target.value)} placeholder="Sector/Narrative" />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Date</span>
                  <input type="date" className={INPUT_CLASS} value={editEventDate} onChange={(e) => setEditEventDate(e.target.value)} />
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Tickers</span>
                  <input
                    className={INPUT_CLASS}
                    placeholder="Add tickers (comma-separated)"
                    value={editTickerInput}
                    onChange={(e) => setEditTickerInput(e.target.value)}
                    list="sector-symbol-options"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    className={`${SECONDARY_BUTTON_CLASS} w-full`}
                    onClick={() => {
                      addEditTicker(editTickerInput);
                      setEditTickerInput("");
                    }}
                  >
                    Add tickers
                  </button>
                </div>
                <label className="space-y-1 md:col-span-6">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Notes</span>
                  <textarea className={`${INPUT_CLASS} min-h-28 resize-y`} placeholder="Notes" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                {editTickers.map((ticker) => (
                  <span key={`edit-${ticker}`} className="inline-flex items-center gap-1 rounded-full bg-slate-800/70 px-3 py-1.5 text-xs text-slate-200">
                    {ticker}
                    <button
                      className="rounded-full p-0.5 text-slate-400 transition hover:bg-slate-700/70 hover:text-slate-100"
                      onClick={() => setEditTickers((prev) => prev.filter((t) => t !== ticker))}
                      aria-label={`Remove ${ticker}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>

              {editError ? <p className="text-sm text-red-300">{editError}</p> : null}

              <div className="flex justify-end gap-2">
                <button className={SECONDARY_BUTTON_CLASS} onClick={() => setEditingEntry(null)}>
                  Cancel
                </button>
                <button
                  className="inline-flex items-center justify-center rounded-xl bg-accent/18 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/24"
                  onClick={() => void saveEntryEdit()}
                >
                  Save changes
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {activeEtf ? (
        <TickerCollectionModal
          eyebrow="ETF Drilldown"
          title={`${activeEtf.ticker} Constituents${activeEtf.fundName ? ` - ${activeEtf.fundName}` : ""}`}
          items={etfModalItems}
          totalItems={sortedConstituents.length}
          page={constituentPage}
          pageSize={CHARTS_PER_PAGE}
          itemLabel="tickers"
          controls={(
            <div className="flex flex-wrap items-center gap-2 rounded-[22px] border border-borderSoft/60 bg-panelSoft/30 px-3 py-3 text-sm text-slate-300">
              <span className="text-slate-400">Sort constituents by:</span>
              <button
                className={`rounded-xl px-3 py-2 text-sm transition ${segmentedButtonClass(constituentSort === "weight")}`}
                onClick={() => setConstituentSort("weight")}
              >
                Weight %
              </button>
              <button
                className={`rounded-xl px-3 py-2 text-sm transition ${segmentedButtonClass(constituentSort === "change1d")}`}
                onClick={() => setConstituentSort("change1d")}
              >
                1D %
              </button>
              <span className="ml-auto rounded-full bg-panel/55 px-3 py-1.5 text-xs text-slate-300">
                {sortedConstituents.length} ticker{sortedConstituents.length === 1 ? "" : "s"}
              </span>
            </div>
          )}
          warning={constituentWarning ? `Constituent sync warning: ${constituentWarning}` : null}
          loading={constituentLoading}
          loadingLabel="Loading constituents..."
          emptyMessage="No constituents available for this ETF."
          onPageChange={setConstituentPage}
          onClose={() => setActiveEtf(null)}
          onExpandChart={openExpandedChart}
        />
      ) : null}

      {activeNarrativeEntry ? (
        <TickerCollectionModal
          eyebrow="Sector / Narrative"
          title={activeNarrativeEntry.sectorName}
          description={
            <div className="space-y-1">
              <p>{activeNarrativeEntry.eventDate}</p>
              {activeNarrativeEntry.notes ? <p className="max-w-3xl leading-relaxed text-slate-400">{activeNarrativeEntry.notes}</p> : null}
            </div>
          }
          items={narrativeModalItems}
          totalItems={activeNarrativeEntry.symbols.length}
          page={narrativePage}
          pageSize={CHARTS_PER_PAGE}
          itemLabel="tickers"
          emptyMessage="No tickers are attached to this narrative entry yet."
          onPageChange={setNarrativePage}
          onClose={() => setActiveNarrativeEntry(null)}
          onExpandChart={openExpandedChart}
        />
      ) : null}

      {hoverChartPreview ? (
        <div
          className="fixed z-40 hidden max-h-[calc(100vh-2rem)] overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.48)] xl:block"
          style={hoverChartPreview.style}
          onMouseEnter={() => setIsHoverPreviewHovered(true)}
          onMouseLeave={() => setIsHoverPreviewHovered(false)}
        >
          <div className="flex items-center justify-between border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Hover Preview</p>
              <h4 className="mt-1 text-base font-semibold text-slate-100">TradingView: {hoverChartPreview.ticker}</h4>
            </div>
            <button className={SECONDARY_BUTTON_CLASS} onClick={() => openExpandedChart(hoverChartPreview.ticker)}>
              <Maximize2 className="h-3.5 w-3.5" />
              Pin chart
            </button>
          </div>
          <div className="p-4">
            <div className="rounded-[24px] bg-panelSoft/25 p-3">
              <TradingViewWidget ticker={hoverChartPreview.ticker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
            </div>
          </div>
        </div>
      ) : null}

      {activeChartTicker ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={closeExpandedChart}>
          <div className="w-full max-w-5xl overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                <h4 className="mt-1 text-base font-semibold text-slate-100">TradingView: {activeChartTicker}</h4>
              </div>
              <button data-modal-close="true" className={SECONDARY_BUTTON_CLASS} onClick={closeExpandedChart}>
                Close
              </button>
            </div>
            <div className="p-4">
              <div className="rounded-[24px] bg-panelSoft/25 p-3">
                <TradingViewWidget ticker={activeChartTicker} chartOnly showStatusLine fillContainer initialRange="3M" surface="plain" />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
