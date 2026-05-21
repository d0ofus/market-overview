"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { CalendarDays, Check, ChevronDown, List, Maximize2, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import {
  adminFetch,
  deleteSectorEntry,
  getEtfConstituents,
  getIndustryEtfs,
  getSectorCalendar,
  getSectorEntries,
  getSectorEtfs,
  getSectorFocusNarratives,
  getSectorSymbolOptions,
  getSectorTickerMetrics,
  updateSectorFocusNarratives,
  updateSectorEntry,
  type PeerMetricRow,
  type SectorFocusNarrative,
} from "@/lib/api";
import { FloatingSectionNav } from "./floating-section-nav";
import { ExpandedTradingViewChartModal, HoverChartPreviewPanel, useHoverChartPreview } from "./hover-chart-preview";
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

type EntrySymbol = { ticker: string; name: string | null };
type SectorEntry = {
  id: string;
  sectorName: string;
  eventDate: string;
  trendScore: number;
  notes: string | null;
  symbols: EntrySymbol[];
};

type NarrativeChartCollection = {
  id: string;
  sectorName: string;
  eventDate: string | null;
  notes: string | null;
  symbols: EntrySymbol[];
  mode: "entry" | "focus";
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

type NarrativeTickerSuggestion = {
  ticker: string;
  name: string | null;
};

type StaleCheck = () => boolean;

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

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatMetricPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function metricChangeClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-100";
  return value < 0 ? "text-neg" : "text-pos";
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
      <div className="flex items-center justify-end gap-3">
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
  const [focusNarratives, setFocusNarratives] = useState<SectorFocusNarrative[]>([]);
  const [focusNarrativeInput, setFocusNarrativeInput] = useState("");
  const [focusNarrativeSaving, setFocusNarrativeSaving] = useState(false);
  const [focusNarrativeError, setFocusNarrativeError] = useState<string | null>(null);

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
  const [activeNarrativeCollection, setActiveNarrativeCollection] = useState<NarrativeChartCollection | null>(null);
  const [narrativePage, setNarrativePage] = useState(1);
  const [narrativeMetrics, setNarrativeMetrics] = useState<Record<string, PeerMetricRow>>({});
  const [narrativeMetricsWarning, setNarrativeMetricsWarning] = useState<string | null>(null);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const hoverChart = useHoverChartPreview({ disabled: Boolean(activeChartTicker) });
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

  const loadKeyMoverData = useCallback(async (targetMonth: string, isStale: StaleCheck = () => false) => {
    const [entriesRes, calRes, symbolRes, focusRes] = await Promise.allSettled([
      getSectorEntries(),
      getSectorCalendar(targetMonth),
      getSectorSymbolOptions(),
      getSectorFocusNarratives(),
    ]);
    if (isStale()) return;

    const entriesRows = entriesRes.status === "fulfilled" ? entriesRes.value.rows ?? [] : [];
    const calRows = calRes.status === "fulfilled" ? calRes.value.rows ?? [] : [];
    const symbolRows = symbolRes.status === "fulfilled" ? symbolRes.value.rows ?? [] : [];
    const focusRows = focusRes.status === "fulfilled" ? focusRes.value.rows ?? [] : [];

    setEntries(entriesRows.length > 0 ? entriesRows : FALLBACK_KEY_MOVERS);
    setCalendarRows(calRows.length > 0 ? calRows : FALLBACK_KEY_MOVERS);
    setSymbolOptions(symbolRows);
    setFocusNarratives(focusRows);
  }, []);

  const loadEtfData = useCallback(async (isStale: StaleCheck = () => false) => {
    const [sectorEtfRes, industryEtfRes] = await Promise.allSettled([
      getSectorEtfs(),
      getIndustryEtfs(),
    ]);
    if (isStale()) return;

    const sectorRows = sectorEtfRes.status === "fulfilled" ? sectorEtfRes.value.rows ?? [] : [];
    const industryRows = industryEtfRes.status === "fulfilled" ? industryEtfRes.value.rows ?? [] : [];

    setSectorEtfs((sectorRows.length > 0 ? sectorRows : FALLBACK_SECTOR_ETFS) as WatchlistEtf[]);
    setIndustryEtfs((industryRows.length > 0 ? industryRows : FALLBACK_INDUSTRY_ETFS) as WatchlistEtf[]);
  }, []);

  useEffect(() => {
    let stale = false;
    void loadKeyMoverData(month, () => stale);
    return () => {
      stale = true;
    };
  }, [loadKeyMoverData, month]);

  useEffect(() => {
    let stale = false;
    void loadEtfData(() => stale);
    return () => {
      stale = true;
    };
  }, [loadEtfData]);

  useEffect(() => {
    setExpandedCalendarDates([]);
  }, [month]);

  const openEtfPopup = async (ticker: string, fundName?: string | null) => {
    hoverChart.clearPreview();
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
    hoverChart.clearPreview();
    setActiveNarrativeCollection({ ...entry, mode: "entry" });
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
      await loadKeyMoverData(month);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update sector/narrative entry.");
    }
  };

  const removeEntry = async (entryId: string) => {
    if (!window.confirm("Delete this sector/narrative entry?")) return;
    try {
      await deleteSectorEntry(entryId);
      if (editingEntry?.id === entryId) setEditingEntry(null);
      if (activeNarrativeCollection?.id === entryId) setActiveNarrativeCollection(null);
      await loadKeyMoverData(month);
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
    () => (activeNarrativeCollection?.symbols ?? []).slice((narrativePage - 1) * CHARTS_PER_PAGE, narrativePage * CHARTS_PER_PAGE),
    [activeNarrativeCollection, narrativePage],
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
        key: `${activeNarrativeCollection?.id ?? "entry"}-${symbol.ticker}`,
        ticker: symbol.ticker,
        name: null,
        stats: (() => {
          const metric = narrativeMetrics[symbol.ticker.toUpperCase()];
          const avgDollar = typeof metric?.price === "number" && typeof metric.avgVolume === "number"
            ? metric.price * metric.avgVolume
            : null;
          return (
            <>
              <span className="min-w-0 rounded-full border border-borderSoft/60 bg-panelSoft/30 px-2.5 py-1.5 text-center text-[11px] leading-none text-slate-200">
                <span className="mr-1 uppercase tracking-[0.08em] text-slate-500">Mkt Cap</span>
                <span className="font-semibold text-slate-100">{formatCompact(metric?.marketCap)}</span>
              </span>
              <span className="min-w-0 rounded-full border border-borderSoft/60 bg-panelSoft/30 px-2.5 py-1.5 text-center text-[11px] leading-none text-slate-200">
                <span className="mr-1 uppercase tracking-[0.08em] text-slate-500">Avg Vol</span>
                <span className="font-semibold text-slate-100">{formatCompact(metric?.avgVolume)}</span>
              </span>
              <span className="min-w-0 rounded-full border border-borderSoft/60 bg-panelSoft/30 px-2.5 py-1.5 text-center text-[11px] leading-none text-slate-200">
                <span className="mr-1 uppercase tracking-[0.08em] text-slate-500">Avg $</span>
                <span className="font-semibold text-slate-100">{formatCompact(avgDollar)}</span>
              </span>
              <span className="min-w-0 rounded-full border border-borderSoft/60 bg-panelSoft/30 px-2.5 py-1.5 text-center text-[11px] leading-none text-slate-200">
                <span className="mr-1 uppercase tracking-[0.08em] text-slate-500">1D %</span>
                <span className={`font-semibold ${metricChangeClass(metric?.change1d)}`}>{formatMetricPct(metric?.change1d)}</span>
              </span>
            </>
          );
        })(),
      })),
    [activeNarrativeCollection?.id, narrativeMetrics, pagedNarrativeSymbols],
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

  const narrativeTickerSuggestionsByName = useMemo(() => {
    const map = new Map<string, Map<string, NarrativeTickerSuggestion>>();
    for (const row of [...entries, ...calendarRows]) {
      const narrativeName = row.sectorName?.trim();
      if (!narrativeName) continue;
      const tickerMap = map.get(narrativeName) ?? new Map<string, NarrativeTickerSuggestion>();
      for (const symbol of row.symbols ?? []) {
        const ticker = symbol.ticker.trim().toUpperCase();
        if (!ticker) continue;
        const existing = tickerMap.get(ticker);
        tickerMap.set(ticker, {
          ticker,
          name: existing?.name ?? symbol.name ?? null,
        });
      }
      map.set(narrativeName, tickerMap);
    }

    return new Map(
      Array.from(map.entries()).map(([narrativeName, tickerMap]) => [
        narrativeName,
        Array.from(tickerMap.values()).sort((a, b) => a.ticker.localeCompare(b.ticker)),
      ]),
    );
  }, [entries, calendarRows]);

  const selectedTickerSet = useMemo(() => new Set(selectedTickers), [selectedTickers]);
  const suggestedNarrativeTickers = sectorNarrativeExisting
    ? narrativeTickerSuggestionsByName.get(sectorNarrativeExisting) ?? []
    : [];
  const suggestedNarrativeTickerSet = useMemo(
    () => new Set(suggestedNarrativeTickers.map((item) => item.ticker)),
    [suggestedNarrativeTickers],
  );
  const selectedSuggestedTickerCount = suggestedNarrativeTickers.filter((item) => selectedTickerSet.has(item.ticker)).length;
  const focusNarrativeRows = useMemo(
    () => focusNarratives.filter((row) => sectorNarrativeOptions.includes(row.sectorName)),
    [focusNarratives, sectorNarrativeOptions],
  );
  const focusNarrativeNames = useMemo(() => focusNarrativeRows.map((row) => row.sectorName), [focusNarrativeRows]);
  const availableFocusNarrativeOptions = useMemo(() => {
    const focused = new Set(focusNarrativeNames);
    return sectorNarrativeOptions.filter((name) => !focused.has(name));
  }, [focusNarrativeNames, sectorNarrativeOptions]);

  const persistFocusNarratives = async (sectorNames: string[]) => {
    setFocusNarrativeSaving(true);
    setFocusNarrativeError(null);
    try {
      const res = await updateSectorFocusNarratives(sectorNames);
      setFocusNarratives(res.rows ?? []);
      setFocusNarrativeInput("");
    } catch (err) {
      setFocusNarrativeError(err instanceof Error ? err.message : "Failed to update focus narratives.");
    } finally {
      setFocusNarrativeSaving(false);
    }
  };

  const addFocusNarrative = async () => {
    const sectorName = focusNarrativeInput.trim();
    if (!sectorName || focusNarrativeSaving) return;
    await persistFocusNarratives([...focusNarrativeNames, sectorName]);
  };

  const removeFocusNarrative = async (sectorName: string) => {
    if (focusNarrativeSaving) return;
    if (activeNarrativeCollection?.mode === "focus" && activeNarrativeCollection.sectorName === sectorName) {
      setActiveNarrativeCollection(null);
    }
    await persistFocusNarratives(focusNarrativeNames.filter((name) => name !== sectorName));
  };

  const openFocusNarrative = (sectorName: string) => {
    const symbols = narrativeTickerSuggestionsByName.get(sectorName) ?? [];
    hoverChart.clearPreview();
    setActiveNarrativeCollection({
      id: `focus-${sectorName}`,
      sectorName,
      eventDate: null,
      notes: null,
      symbols,
      mode: "focus",
    });
    setNarrativePage(1);
  };

  const toggleSuggestedTicker = (ticker: string) => {
    setSelectedTickers((prev) => {
      if (prev.includes(ticker)) return prev.filter((value) => value !== ticker);
      return [...prev, ticker];
    });
  };

  const selectAllSuggestedTickers = () => {
    setSelectedTickers((prev) => Array.from(new Set([...prev, ...suggestedNarrativeTickers.map((item) => item.ticker)])));
  };

  const clearSuggestedTickers = () => {
    setSelectedTickers((prev) => prev.filter((ticker) => !suggestedNarrativeTickerSet.has(ticker)));
  };

  const openExpandedChart = (ticker: string) => {
    hoverChart.clearPreview();
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    hoverChart.clearPreview();
    setActiveChartTicker(null);
  };

  const toggleCalendarDateExpansion = (date: string) => {
    setExpandedCalendarDates((prev) => (prev.includes(date) ? prev.filter((value) => value !== date) : [...prev, date]));
  };

  useEffect(() => {
    setConstituentPage(1);
  }, [activeEtf?.ticker, constituentSort, sortedConstituents.length]);

  useEffect(() => {
    setNarrativePage(1);
  }, [activeNarrativeCollection?.id, activeNarrativeCollection?.symbols.length]);

  useEffect(() => {
    if (!activeNarrativeCollection) {
      setNarrativeMetrics({});
      setNarrativeMetricsWarning(null);
      return;
    }

    const tickers = (activeNarrativeCollection.symbols ?? []).map((symbol) => symbol.ticker);
    if (tickers.length === 0) {
      setNarrativeMetrics({});
      setNarrativeMetricsWarning(null);
      return;
    }

    let cancelled = false;
    setNarrativeMetrics({});
    setNarrativeMetricsWarning(null);
    void getSectorTickerMetrics(tickers)
      .then((response) => {
        if (cancelled) return;
        setNarrativeMetrics(Object.fromEntries((response.rows ?? []).map((row) => [row.ticker.toUpperCase(), row])));
        setNarrativeMetricsWarning(response.error ?? null);
      })
      .catch((error) => {
        if (cancelled) return;
        setNarrativeMetrics({});
        setNarrativeMetricsWarning(error instanceof Error ? error.message : "Failed to load snapshot metrics.");
      });

    return () => {
      cancelled = true;
    };
  }, [activeNarrativeCollection]);

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
            <div className="rounded-[24px] border border-accent/25 bg-accent/8 p-4 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.08)]">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-accent/35 bg-accent/12 text-accent">
                      <Star className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.18em] text-accent/80">Focus Now</p>
                      <h3 className="text-base font-semibold text-slate-100">Narratives to keep on deck</h3>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {focusNarrativeRows.map((row) => {
                      const tickerCount = narrativeTickerSuggestionsByName.get(row.sectorName)?.length ?? 0;
                      return (
                        <div
                          key={`focus-narrative-${row.id}`}
                          className="inline-flex max-w-full overflow-hidden rounded-2xl border border-accent/30 bg-panel/70 text-sm shadow-[0_10px_30px_rgba(2,6,23,0.18)]"
                        >
                          <button
                            type="button"
                            className="min-w-0 px-3 py-2 text-left transition hover:bg-accent/10 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/30"
                            onClick={() => openFocusNarrative(row.sectorName)}
                            aria-label={`Open focus narrative charts for ${row.sectorName}`}
                          >
                            <span className="block truncate font-semibold text-slate-100">{row.sectorName}</span>
                            <span className="mt-0.5 block text-xs text-slate-400">
                              {tickerCount} ticker{tickerCount === 1 ? "" : "s"}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="flex w-9 shrink-0 items-center justify-center border-l border-borderSoft/60 text-slate-400 transition hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-red-400/30 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() => void removeFocusNarrative(row.sectorName)}
                            disabled={focusNarrativeSaving}
                            aria-label={`Remove ${row.sectorName} from focus narratives`}
                            title="Remove"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      );
                    })}
                    {focusNarrativeRows.length === 0 ? (
                      <p className="rounded-2xl border border-borderSoft/60 bg-panel/45 px-3 py-2 text-sm text-slate-400">
                        No focus narratives selected.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex w-full flex-col gap-2 xl:w-[24rem]">
                  <div className="flex gap-2">
                    <select
                      className={INPUT_CLASS}
                      value={focusNarrativeInput}
                      onChange={(e) => setFocusNarrativeInput(e.target.value)}
                      disabled={availableFocusNarrativeOptions.length === 0 || focusNarrativeSaving}
                    >
                      <option value="">
                        {availableFocusNarrativeOptions.length === 0 ? "No more narratives" : "Add existing narrative..."}
                      </option>
                      {availableFocusNarrativeOptions.map((name) => (
                        <option key={`focus-option-${name}`} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={`${SECONDARY_BUTTON_CLASS} shrink-0 disabled:cursor-not-allowed disabled:opacity-50`}
                      onClick={() => void addFocusNarrative()}
                      disabled={!focusNarrativeInput || focusNarrativeSaving}
                    >
                      <Plus className="h-4 w-4" />
                      {focusNarrativeSaving ? "Saving" : "Add"}
                    </button>
                  </div>
                  {focusNarrativeError ? <p className="text-sm text-red-300">{focusNarrativeError}</p> : null}
                </div>
              </div>
            </div>

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

                  {sectorNarrativeExisting ? (
                    <div className="rounded-2xl border border-borderSoft/60 bg-panel/35 p-3">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">Prior tickers</p>
                          <p className="mt-1 text-sm text-slate-400">
                            {suggestedNarrativeTickers.length > 0
                              ? `${selectedSuggestedTickerCount} of ${suggestedNarrativeTickers.length} selected from ${sectorNarrativeExisting}.`
                              : `No prior tickers found for ${sectorNarrativeExisting}.`}
                          </p>
                        </div>
                        {suggestedNarrativeTickers.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className={SECONDARY_BUTTON_CLASS}
                              onClick={selectAllSuggestedTickers}
                              disabled={selectedSuggestedTickerCount === suggestedNarrativeTickers.length}
                            >
                              Select all
                            </button>
                            <button
                              type="button"
                              className={SECONDARY_BUTTON_CLASS}
                              onClick={clearSuggestedTickers}
                              disabled={selectedSuggestedTickerCount === 0}
                            >
                              Clear suggested
                            </button>
                          </div>
                        ) : null}
                      </div>
                      {suggestedNarrativeTickers.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {suggestedNarrativeTickers.map((item) => {
                            const selected = selectedTickerSet.has(item.ticker);
                            return (
                              <button
                                key={`suggested-narrative-ticker-${sectorNarrativeExisting}-${item.ticker}`}
                                type="button"
                                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                                  selected
                                    ? "border-accent/45 bg-accent/14 text-accent"
                                    : "border-borderSoft/60 bg-panelSoft/35 text-slate-300 hover:bg-panelSoft/55"
                                }`}
                                onClick={() => toggleSuggestedTicker(item.ticker)}
                                aria-pressed={selected}
                                title={item.name ?? item.ticker}
                              >
                                <span
                                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${
                                    selected ? "border-accent bg-accent text-slate-950" : "border-slate-500/70"
                                  }`}
                                >
                                  {selected ? <Check className="h-3 w-3" /> : null}
                                </span>
                                {item.ticker}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

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
                          await loadKeyMoverData(month);
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
                      <input type="month" className="themed-date-input bg-transparent text-slate-100 outline-none" value={month} onChange={(e) => setMonth(e.target.value)} />
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
                          <tr
                            key={e.id}
                            className="cursor-pointer border-t border-borderSoft/60 align-top transition hover:bg-panelSoft/25 focus:bg-panelSoft/25 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/30"
                            role="button"
                            tabIndex={0}
                            onClick={() => openNarrativeEntry(e)}
                            onKeyDown={(event) => handleNarrativeEntryKeyDown(event, e)}
                            aria-label={`Open chart grid for ${e.sectorName} on ${e.eventDate}`}
                          >
                            <td className="whitespace-nowrap px-4 py-3 text-slate-300">{e.eventDate}</td>
                            <td className="px-4 py-3 font-medium text-slate-100">{e.sectorName}</td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1.5">
                                {(e.symbols ?? []).length === 0 ? <span className="text-slate-500">-</span> : null}
                                {(e.symbols ?? []).map((s) => (
                                  <button
                                    key={`${e.id}-${s.ticker}`}
                                    className={TICKER_CHIP_CLASS}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openExpandedChart(s.ticker);
                                    }}
                                    onMouseEnter={(event) => hoverChart.openPreview(s.ticker, event.currentTarget)}
                                    onMouseLeave={() => hoverChart.closePreviewForTicker(s.ticker)}
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
                                <button
                                  className={SECONDARY_BUTTON_CLASS}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openEditEntry(e);
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </button>
                                <button
                                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-500/35 bg-red-500/8 px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/14"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void removeEntry(e.id);
                                  }}
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
                                      onMouseEnter={(event) => hoverChart.openPreview(s.ticker, event.currentTarget)}
                                      onMouseLeave={() => hoverChart.closePreviewForTicker(s.ticker)}
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

      {activeNarrativeCollection ? (
        <TickerCollectionModal
          eyebrow={activeNarrativeCollection.mode === "focus" ? "Focus Narrative" : "Sector / Narrative"}
          title={activeNarrativeCollection.sectorName}
          description={
            <div className="space-y-1">
              {activeNarrativeCollection.mode === "focus" ? (
                <p>
                  {activeNarrativeCollection.symbols.length} prior ticker{activeNarrativeCollection.symbols.length === 1 ? "" : "s"}
                </p>
              ) : (
                <p>{activeNarrativeCollection.eventDate}</p>
              )}
              {activeNarrativeCollection.notes ? <p className="max-w-3xl leading-relaxed text-slate-400">{activeNarrativeCollection.notes}</p> : null}
            </div>
          }
          items={narrativeModalItems}
          totalItems={activeNarrativeCollection.symbols.length}
          page={narrativePage}
          pageSize={CHARTS_PER_PAGE}
          itemLabel="tickers"
          maxColumns={3}
          warning={narrativeMetricsWarning ? `Snapshot metrics warning: ${narrativeMetricsWarning}` : null}
          emptyMessage={activeNarrativeCollection.mode === "focus" ? "No prior tickers found for this narrative yet." : "No tickers are attached to this narrative entry yet."}
          onPageChange={setNarrativePage}
          onClose={() => setActiveNarrativeCollection(null)}
          onExpandChart={openExpandedChart}
        />
      ) : null}

      <HoverChartPreviewPanel
        preview={hoverChart.preview}
        onPreviewMouseEnter={hoverChart.handlePreviewMouseEnter}
        onPreviewMouseLeave={hoverChart.handlePreviewMouseLeave}
        onPinChart={openExpandedChart}
      />

      <ExpandedTradingViewChartModal ticker={activeChartTicker} onClose={closeExpandedChart} />
    </div>
  );
}
