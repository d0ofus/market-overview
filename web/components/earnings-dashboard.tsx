"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Database, Download, GripVertical, LayoutGrid, Loader2, Maximize2, Minus, Plus, RefreshCw, RotateCcw, Search, Table2 } from "lucide-react";
import {
  getEarningsGaps,
  getEarningsGapsExportUrl,
  getEarningsGapsStatus,
  getEarningsSurprises,
  getEarningsSurprisesExportUrl,
  getEarningsSurprisesStatus,
  syncAdminEarningsGaps,
  syncAdminEarningsSurprises,
  type EarningsGapRow,
  type EarningsGapsQuery,
  type EarningsGapsResponse,
  type EarningsGapsStatus,
  type EarningsSurpriseFacet,
  type EarningsSurpriseRow,
  type EarningsSurprisesQuery,
  type EarningsSurprisesResponse,
  type EarningsSurprisesStatus,
} from "@/lib/api";
import {
  GAP_COLUMN_WIDTH_SPECS,
  GAP_FONT_SIZE_DEFAULT_PX,
  GAP_FONT_SIZE_MAX_PX,
  GAP_FONT_SIZE_MIN_PX,
  adjustGapFontSize,
  defaultColumnWidths,
  gapHeaderFontSize,
  normalizeColumnWidths,
  normalizeGapFontSize,
  resizeAdjacentColumnWidths,
  type ColumnWidthMap,
  type ColumnWidthSpec,
  type GapColumnWidthKey,
} from "@/lib/earnings-column-widths";
import {
  buildEarningsGridQuery,
  gapRowToGridCard,
  normalizeEarningsResultView,
  surpriseRowToGridCard,
  type EarningsResultView,
} from "@/lib/earnings-multi-chart";
import { EarningsMultiChartGrid } from "./earnings-multi-chart-grid";
import { ExpandedTradingViewChartModal, HoverChartPreviewPanel, useHoverChartPreview } from "./hover-chart-preview";

type SortKey =
  | "reportDate"
  | "ticker"
  | "companyName"
  | "season"
  | "epsSurprisePct"
  | "epsSurprise"
  | "revenueSurprisePct"
  | "marketCap"
  | "sector"
  | "industry"
  | "exchange";

type EarningsView = "surprises" | "gaps";

type GapSortKey =
  | "reportDate"
  | "ticker"
  | "companyName"
  | "season"
  | "epsSurprisePct"
  | "epsSurprise"
  | "qualifyingGapPct"
  | "postmarketGapPct"
  | "regularOpenGapPct"
  | "avgDollarVolume30d"
  | "marketCap"
  | "gapSource"
  | "sector"
  | "industry"
  | "exchange";

type DraftFilters = {
  q: string;
  startDate: string;
  endDate: string;
  minMarketCap: string;
  maxMarketCap: string;
  minEpsSurprisePct: string;
  season: string;
  sector: string;
  industry: string;
  exchange: string;
  surpriseSide: "all" | "positive" | "negative";
  includeOtc: boolean;
  limit: string;
};

type GapDraftFilters = {
  q: string;
  startDate: string;
  endDate: string;
  minMarketCap: string;
  maxMarketCap: string;
  minAvgDollarVolume: string;
  minGapPct: string;
  season: string;
  sector: string;
  industry: string;
  exchange: string;
  includeOtc: boolean;
  limit: string;
};

type ColumnAlign = "left" | "right";

type EarningsTableColumn<Key extends string, Row, Sort extends string> = {
  key: Key;
  label: string;
  sortKey?: Sort;
  align?: ColumnAlign;
  cellClassName: string;
  title?: (row: Row) => string | undefined;
  render: (row: Row) => ReactNode;
};

type SurpriseColumnKey =
  | "reportDate"
  | "ticker"
  | "companyName"
  | "season"
  | "epsSurprisePct"
  | "epsSurprise"
  | "epsActual"
  | "epsEstimate"
  | "revenueSurprisePct"
  | "marketCap"
  | "sector"
  | "industry"
  | "exchange";

type GapColumnKey = GapColumnWidthKey;

const INPUT_CLASS =
  "h-10 w-full rounded border border-borderSoft/80 bg-panelSoft/85 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";
const BUTTON_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded border border-borderSoft/80 bg-panelSoft/80 px-3 text-sm font-medium text-slate-100 transition hover:bg-panelSoft disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded bg-accent px-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";
const EARNINGS_HISTORY_MONTHS = 3;
const GAP_BACKFILL_BATCH_DAYS = 7;
const DEFAULT_RESULTS_LIMIT = 200;
const EXPORT_LIMIT_DEFAULT = 100;
const EXPORT_LIMIT_MAX = 1000;
const SURPRISE_COLUMNS_STORAGE_KEY = "earnings-surprises-column-order-v1";
const GAP_COLUMNS_STORAGE_KEY = "earnings-gaps-column-order-v1";
const GAP_COLUMN_WIDTHS_STORAGE_KEY = "earnings-gaps-column-widths-v1";
const GAP_FONT_SIZE_STORAGE_KEY = "earnings-gaps-font-size-v1";
const SURPRISE_RESULT_VIEW_STORAGE_KEY = "earnings-surprises-result-view-v1";
const GAP_RESULT_VIEW_STORAGE_KEY = "earnings-gaps-result-view-v1";
const DEFAULT_CHARTS_PER_PAGE = 12;
const DEFAULT_SURPRISE_COLUMN_ORDER: SurpriseColumnKey[] = [
  "reportDate",
  "ticker",
  "companyName",
  "season",
  "epsSurprisePct",
  "epsSurprise",
  "epsActual",
  "epsEstimate",
  "revenueSurprisePct",
  "marketCap",
  "sector",
  "industry",
  "exchange",
];
const DEFAULT_GAP_COLUMN_ORDER: GapColumnKey[] = [
  "reportDate",
  "ticker",
  "companyName",
  "season",
  "epsSurprisePct",
  "epsSurprise",
  "epsActual",
  "epsEstimate",
  "gapSource",
  "qualifyingGapPct",
  "postmarketGapPct",
  "postmarketPrice",
  "postmarketVolume",
  "regularOpenGapPct",
  "reactionOpen",
  "avgDollarVolume30d",
  "marketCap",
  "sector",
  "industry",
  "exchange",
];
const GAP_CELL_CLASS = "whitespace-normal px-1.5 py-2 align-top leading-tight [overflow-wrap:anywhere]";

function isoDateMonthsAgo(months: number): string {
  const now = new Date();
  const day = now.getUTCDate();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const lastDayOfTargetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return date.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function estimateBackfillBatchCount(startDate: string, endDate: string): number {
  const days = inclusiveDayCount(startDate, endDate);
  return Math.max(1, Math.ceil(days / GAP_BACKFILL_BATCH_DAYS));
}

function defaultDraftFilters(): DraftFilters {
  return {
    q: "",
    startDate: isoDateMonthsAgo(EARNINGS_HISTORY_MONTHS),
    endDate: todayIso(),
    minMarketCap: "300",
    maxMarketCap: "",
    minEpsSurprisePct: "",
    season: "",
    sector: "",
    industry: "",
    exchange: "",
    surpriseSide: "positive",
    includeOtc: false,
    limit: String(DEFAULT_RESULTS_LIMIT),
  };
}

function defaultGapDraftFilters(): GapDraftFilters {
  return {
    q: "",
    startDate: isoDateMonthsAgo(EARNINGS_HISTORY_MONTHS),
    endDate: todayIso(),
    minMarketCap: "300",
    maxMarketCap: "",
    minAvgDollarVolume: "5",
    minGapPct: "3",
    season: "",
    sector: "",
    industry: "",
    exchange: "",
    includeOtc: false,
    limit: String(DEFAULT_RESULTS_LIMIT),
  };
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function draftLimitToQuery(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_RESULTS_LIMIT;
  if (trimmed === "0") return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULTS_LIMIT;
  return Math.max(25, Math.min(250, Math.floor(parsed)));
}

function draftToQuery(draft: DraftFilters, sort: SortKey, sortDir: "asc" | "desc", offset = 0): EarningsSurprisesQuery {
  const minMarketCap = toNumber(draft.minMarketCap);
  const maxMarketCap = toNumber(draft.maxMarketCap);
  const minEpsSurprisePct = toNumber(draft.minEpsSurprisePct);
  const limit = draftLimitToQuery(draft.limit);
  return {
    limit,
    offset: limit === 0 ? 0 : offset,
    q: draft.q.trim() || null,
    startDate: draft.startDate || null,
    endDate: draft.endDate || null,
    season: draft.season || null,
    sector: draft.sector || null,
    industry: draft.industry || null,
    exchange: draft.exchange || null,
    includeOtc: draft.includeOtc,
    surpriseSide: draft.surpriseSide,
    minMarketCap: minMarketCap == null ? null : minMarketCap * 1_000_000,
    maxMarketCap: maxMarketCap == null ? null : maxMarketCap * 1_000_000,
    minEpsSurprisePct,
    sort,
    sortDir,
  };
}

function gapDraftToQuery(draft: GapDraftFilters, sort: GapSortKey, sortDir: "asc" | "desc", offset = 0): EarningsGapsQuery {
  const minMarketCap = toNumber(draft.minMarketCap);
  const maxMarketCap = toNumber(draft.maxMarketCap);
  const minAvgDollarVolume = toNumber(draft.minAvgDollarVolume);
  const minGapPct = toNumber(draft.minGapPct);
  const limit = draftLimitToQuery(draft.limit);
  return {
    limit,
    offset: limit === 0 ? 0 : offset,
    q: draft.q.trim() || null,
    startDate: draft.startDate || null,
    endDate: draft.endDate || null,
    season: draft.season || null,
    sector: draft.sector || null,
    industry: draft.industry || null,
    exchange: draft.exchange || null,
    includeOtc: draft.includeOtc,
    minMarketCap: minMarketCap == null ? null : minMarketCap * 1_000_000,
    maxMarketCap: maxMarketCap == null ? null : maxMarketCap * 1_000_000,
    minAvgDollarVolume: minAvgDollarVolume == null ? null : minAvgDollarVolume * 1_000_000,
    minGapPct,
    sort,
    sortDir,
  };
}

function formatCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${formatNumber(value, 2)}%`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function pctClass(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "text-slate-300";
  return value >= 0 ? "text-pos" : "text-neg";
}

function facetOptions(rows: EarningsSurpriseFacet[], selected: string): EarningsSurpriseFacet[] {
  if (!selected || rows.some((row) => row.value === selected)) return rows;
  return [{ value: selected, count: 0 }, ...rows];
}

function clampExportLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return EXPORT_LIMIT_DEFAULT;
  return Math.max(1, Math.min(EXPORT_LIMIT_MAX, Math.floor(parsed)));
}

function exportDateSuffix(): string {
  const date = new Date();
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}_${month}`;
}

function normalizeColumnOrder<Key extends string>(stored: unknown, defaults: Key[]): Key[] {
  if (!Array.isArray(stored)) return defaults;
  const defaultSet = new Set(defaults);
  const seen = new Set<Key>();
  const ordered = stored.filter((item): item is Key => {
    if (typeof item !== "string" || !defaultSet.has(item as Key) || seen.has(item as Key)) return false;
    seen.add(item as Key);
    return true;
  });
  return ordered.length > 0 ? [...ordered, ...defaults.filter((key) => !seen.has(key))] : defaults;
}

function moveColumn<Key extends string>(columns: Key[], draggedKey: Key, targetKey: Key): Key[] {
  if (draggedKey === targetKey) return columns;
  const next = columns.filter((key) => key !== draggedKey);
  const targetIndex = next.indexOf(targetKey);
  if (targetIndex < 0) return columns;
  next.splice(targetIndex, 0, draggedKey);
  return next;
}

function usePersistedColumnOrder<Key extends string>(storageKey: string, defaults: Key[]) {
  const [order, setOrder] = useState<Key[]>(defaults);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return;
    try {
      setOrder(normalizeColumnOrder(JSON.parse(stored), defaults));
    } catch {
      setOrder(defaults);
    }
  }, [defaults, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, JSON.stringify(order));
  }, [order, storageKey]);

  return [order, setOrder] as const;
}

function usePersistedColumnWidths<Key extends string>(
  storageKey: string,
  specs: Record<Key, ColumnWidthSpec>,
) {
  const defaults = useMemo(() => defaultColumnWidths(specs), [specs]);
  const [widths, setWidths] = useState<ColumnWidthMap<Key>>(defaults);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      setWidths(normalizeColumnWidths(stored ? JSON.parse(stored) : null, specs));
    } catch {
      setWidths(defaults);
    }
  }, [defaults, specs, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timeout = window.setTimeout(() => {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [storageKey, widths]);

  const reset = useCallback(() => setWidths(defaults), [defaults]);
  return [widths, setWidths, reset] as const;
}

function usePersistedGapFontSize(storageKey: string) {
  const [fontSize, setFontSize] = useState(GAP_FONT_SIZE_DEFAULT_PX);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      setFontSize(normalizeGapFontSize(stored ? JSON.parse(stored) : null));
    } catch {
      setFontSize(GAP_FONT_SIZE_DEFAULT_PX);
    }
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timeout = window.setTimeout(() => {
      window.localStorage.setItem(storageKey, JSON.stringify(fontSize));
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [fontSize, storageKey]);

  return [fontSize, setFontSize] as const;
}

function usePersistedResultView(storageKey: string) {
  const [view, setView] = useState<EarningsResultView>("table");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setView(normalizeEarningsResultView(window.localStorage.getItem(storageKey)));
    } catch {
      setView("table");
    } finally {
      setHydrated(true);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, view);
    } catch {
      // Browser storage can be unavailable in private or locked-down profiles.
    }
  }, [hydrated, storageKey, view]);

  return [view, setView] as const;
}

function ResultViewToggle({ view, onChange }: { view: EarningsResultView; onChange: (view: EarningsResultView) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-borderSoft/70 bg-panel/80 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">Results View</h3>
        <p className="text-xs text-slate-500">Table and chart pages are tracked independently.</p>
      </div>
      <div role="group" aria-label="Earnings results view" className="inline-flex overflow-hidden rounded border border-borderSoft/80 bg-panelSoft/80">
        <button
          type="button"
          className={`inline-flex h-9 items-center gap-2 px-3 text-sm transition ${view === "table" ? "bg-accent text-slate-950" : "text-slate-200 hover:bg-panelSoft"}`}
          aria-pressed={view === "table"}
          onClick={() => onChange("table")}
        >
          <Table2 className="h-4 w-4" /> Table
        </button>
        <button
          type="button"
          className={`inline-flex h-9 items-center gap-2 border-l border-borderSoft/80 px-3 text-sm transition ${view === "grid" ? "bg-accent text-slate-950" : "text-slate-200 hover:bg-panelSoft"}`}
          aria-pressed={view === "grid"}
          onClick={() => onChange("grid")}
        >
          <LayoutGrid className="h-4 w-4" /> Multi Grid
        </button>
      </div>
    </div>
  );
}

function ResultsPager({
  loading,
  limit,
  offset,
  total,
  pageStart,
  pageEnd,
  onPage,
}: {
  loading: boolean;
  limit: number;
  offset: number;
  total: number;
  pageStart: number;
  pageEnd: number;
  onPage: (offset: number) => void;
}) {
  const allMatches = limit === 0;
  const totalPages = total > 0 ? (allMatches ? 1 : Math.ceil(total / limit)) : 0;
  const currentPage = total > 0 ? (allMatches ? 1 : Math.floor(offset / limit) + 1) : 0;
  const lastOffset = total > 0 && !allMatches ? Math.floor((total - 1) / limit) * limit : 0;
  const canGoBack = !allMatches && offset > 0 && !loading;
  const canGoForward = !allMatches && offset + limit < total && !loading;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
      <button type="button" className={BUTTON_CLASS} disabled={!canGoBack} onClick={() => onPage(0)} aria-label="First page">
        <ChevronsLeft className="h-4 w-4" />
      </button>
      <button type="button" className={BUTTON_CLASS} disabled={!canGoBack} onClick={() => onPage(Math.max(0, offset - limit))} aria-label="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-24 text-center">Page {currentPage} / {totalPages}</span>
      <span className="min-w-28 text-center">{pageStart}-{pageEnd} of {formatCompact(total)}</span>
      <button type="button" className={BUTTON_CLASS} disabled={!canGoForward} onClick={() => onPage(offset + limit)} aria-label="Next page">
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" className={BUTTON_CLASS} disabled={!canGoForward} onClick={() => onPage(lastOffset)} aria-label="Last page">
        <ChevronsRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function ExportTickersControl({
  href,
  value,
  onChange,
}: {
  href: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-slate-400">
        Export top
        <input
          className={`${INPUT_CLASS} mt-1 h-9 w-24`}
          value={value}
          inputMode="numeric"
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <a className={`${BUTTON_CLASS} h-9`} href={href} target="_blank" rel="noreferrer">
        <Download className="h-4 w-4" />
        Export TXT
      </a>
    </div>
  );
}

function DraggableColumnHeader<Key extends string, Row, Sort extends string>({
  column,
  sortKey,
  sortDir,
  draggedKey,
  compact = false,
  canResize = false,
  widthPct,
  onSort,
  onDragStart,
  onDrop,
  onDragEnd,
  onResizeStart,
  onResizeBy,
}: {
  column: EarningsTableColumn<Key, Row, Sort>;
  sortKey: Sort;
  sortDir: "asc" | "desc";
  draggedKey: Key | null;
  compact?: boolean;
  canResize?: boolean;
  widthPct?: number;
  onSort: (key: Sort) => void;
  onDragStart: (key: Key) => void;
  onDrop: (key: Key) => void;
  onDragEnd: () => void;
  onResizeStart?: (key: Key, clientX: number) => void;
  onResizeBy?: (key: Key, deltaPct: number) => void;
}) {
  const align = column.align ?? "left";
  const isDragging = draggedKey === column.key;
  return (
    <th
      className={`${compact ? "relative px-1.5 py-2 align-bottom" : "px-3 py-3"} ${align === "right" ? "text-right" : "text-left"} ${isDragging ? "bg-accent/10" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={() => onDrop(column.key)}
    >
      <div className={`${compact ? "flex min-w-0 flex-wrap items-start gap-0.5" : "flex items-center gap-1.5"} ${align === "right" ? "justify-end" : "justify-start"}`}>
        <button
          type="button"
          draggable
          className={`inline-flex shrink-0 cursor-grab items-center justify-center rounded text-slate-500 transition hover:bg-panelSoft hover:text-slate-200 active:cursor-grabbing ${compact ? "h-4 w-4" : "h-6 w-5"}`}
          title={`Drag ${column.label} column`}
          aria-label={`Drag ${column.label} column`}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", column.key);
            onDragStart(column.key);
          }}
          onDragEnd={onDragEnd}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        {column.sortKey ? (
          <button
            type="button"
            className={`${compact ? "inline-flex min-w-0 max-w-full flex-1 flex-wrap items-start gap-x-0.5 whitespace-normal break-words leading-tight tracking-[0.07em] [overflow-wrap:anywhere]" : "inline-flex min-w-max items-center gap-1 text-xs tracking-[0.12em]"} font-semibold uppercase text-slate-500 hover:text-slate-200 ${align === "right" ? "justify-end" : "justify-start"}`}
            onClick={() => onSort(column.sortKey as Sort)}
          >
            {column.label}
            {sortKey === column.sortKey ? <span className="text-accent">{sortDir === "asc" ? "ASC" : "DESC"}</span> : null}
          </button>
        ) : (
          <span className={`${compact ? "min-w-0 flex-1 whitespace-normal break-words leading-tight tracking-[0.07em] [overflow-wrap:anywhere]" : "text-xs tracking-[0.12em]"} font-semibold uppercase text-slate-500`}>{column.label}</span>
        )}
      </div>
      {compact && canResize && onResizeStart && onResizeBy ? (
        <span
          role="separator"
          aria-label={`Resize ${column.label} column`}
          aria-orientation="vertical"
          aria-valuenow={Math.round(widthPct ?? 0)}
          tabIndex={0}
          className="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none outline-none"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onResizeStart(column.key, event.clientX);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            const step = event.shiftKey ? 2 : 0.5;
            onResizeBy(column.key, event.key === "ArrowRight" ? step : -step);
          }}
        >
          <span className="absolute left-1/2 top-1 h-[calc(100%-0.5rem)] w-px -translate-x-1/2 bg-borderSoft/80 transition group-hover:bg-accent group-focus:bg-accent" />
        </span>
      ) : null}
    </th>
  );
}

function StatCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded border border-borderSoft/70 bg-panelSoft/60 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-100">{value}</div>
      <div className="mt-1 text-xs text-slate-400">{helper}</div>
    </div>
  );
}

type HoverChartController = ReturnType<typeof useHoverChartPreview>;

function TickerHoverCell({
  ticker,
  hoverChart,
  onPinChart,
  compact = false,
}: {
  ticker: string;
  hoverChart: HoverChartController;
  onPinChart: (ticker: string) => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "flex min-w-0 flex-wrap items-center gap-1" : "flex items-center gap-2"}>
      <Link
        href={`/ticker/${encodeURIComponent(ticker)}`}
        className="font-mono font-semibold text-accent hover:underline"
        onMouseEnter={(event) => hoverChart.openPreview(ticker, event.currentTarget)}
        onMouseLeave={() => hoverChart.closePreviewForTicker(ticker)}
      >
        {ticker}
      </Link>
      <button
        type="button"
        className={`inline-flex shrink-0 items-center justify-center rounded-full border border-borderSoft/60 bg-panelSoft/35 text-slate-400 opacity-75 transition hover:bg-panelSoft/55 hover:text-accent focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent/25 ${compact ? "h-5 w-5" : "h-6 w-6"}`}
        onClick={(event) => {
          event.stopPropagation();
          onPinChart(ticker);
        }}
        title={`Pin chart for ${ticker}`}
        aria-label={`Pin chart for ${ticker}`}
      >
        <Maximize2 className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      </button>
    </div>
  );
}

function ViewTabs({ view, onChange }: { view: EarningsView; onChange: (view: EarningsView) => void }) {
  const buttonClass = (key: EarningsView) =>
    `h-10 rounded border px-3 text-sm font-medium transition ${
      view === key
        ? "border-accent/50 bg-accent/15 text-accent"
        : "border-borderSoft/80 bg-panelSoft/60 text-slate-300 hover:bg-panelSoft"
    }`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-borderSoft/70 bg-panel/80 p-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass("surprises")} onClick={() => onChange("surprises")}>Surprises</button>
        <button type="button" className={buttonClass("gaps")} onClick={() => onChange("gaps")}>Release Gap-Ups</button>
      </div>
      <div className="text-xs text-slate-500">Worker heartbeat: every 15 minutes. Gap scan: daily after 8:00pm ET.</div>
    </div>
  );
}

export function EarningsDashboard() {
  const [view, setView] = useState<EarningsView>("surprises");
  return (
    <div className="space-y-5">
      <ViewTabs view={view} onChange={setView} />
      {view === "surprises" ? <EarningsSurprisesPanel /> : <EarningsGapsPanel />}
    </div>
  );
}

function EarningsSurprisesPanel() {
  const [draft, setDraft] = useState<DraftFilters>(() => defaultDraftFilters());
  const [sortKey, setSortKey] = useState<SortKey>("epsSurprisePct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState<EarningsSurprisesQuery>(() => draftToQuery(defaultDraftFilters(), "epsSurprisePct", "desc"));
  const [data, setData] = useState<EarningsSurprisesResponse | null>(null);
  const [resultView, setResultView] = usePersistedResultView(SURPRISE_RESULT_VIEW_STORAGE_KEY);
  const [gridPage, setGridPage] = useState(1);
  const [chartsPerPage, setChartsPerPage] = useState(DEFAULT_CHARTS_PER_PAGE);
  const [gridData, setGridData] = useState<EarningsSurprisesResponse | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridReloadToken, setGridReloadToken] = useState(0);
  const [status, setStatus] = useState<EarningsSurprisesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<"incremental" | "backfill" | null>(null);
  const [exportLimit, setExportLimit] = useState(String(EXPORT_LIMIT_DEFAULT));
  const [columnOrder, setColumnOrder] = usePersistedColumnOrder(SURPRISE_COLUMNS_STORAGE_KEY, DEFAULT_SURPRISE_COLUMN_ORDER);
  const [draggedColumn, setDraggedColumn] = useState<SurpriseColumnKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const hoverChart = useHoverChartPreview({ disabled: Boolean(activeChartTicker) });

  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const gridQuery = useMemo(() => buildEarningsGridQuery(query, gridPage, chartsPerPage), [chartsPerPage, gridPage, queryKey]);
  const gridQueryKey = useMemo(() => JSON.stringify(gridQuery), [gridQuery]);
  const gridCards = useMemo(() => (gridData?.rows ?? []).map(surpriseRowToGridCard), [gridData]);
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const latestSync = status?.syncs[0] ?? null;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const exportUrl = useMemo(
    () => getEarningsSurprisesExportUrl({ ...query, limit: clampExportLimit(exportLimit), offset: 0 }, exportDateSuffix()),
    [exportLimit, queryKey],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextData, nextStatus] = await Promise.all([
        getEarningsSurprises(query),
        getEarningsSurprisesStatus(),
      ]);
      setData(nextData);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load earnings surprises.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([getEarningsSurprises(query), getEarningsSurprisesStatus()])
      .then(([nextData, nextStatus]) => {
        if (!active) return;
        setData(nextData);
        setStatus(nextStatus);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load earnings surprises.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [queryKey]);

  useEffect(() => {
    if (resultView !== "grid") return;
    let active = true;
    setGridLoading(true);
    setGridError(null);
    getEarningsSurprises(gridQuery)
      .then((nextData) => {
        if (active) setGridData(nextData);
      })
      .catch((err) => {
        if (active) setGridError(err instanceof Error ? err.message : "Failed to load earnings surprise charts.");
      })
      .finally(() => {
        if (active) setGridLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gridQueryKey, gridReloadToken, resultView]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil((gridData?.total ?? 0) / chartsPerPage));
    if (gridPage > totalPages) setGridPage(totalPages);
  }, [chartsPerPage, gridData?.total, gridPage]);

  const applyFilters = () => {
    setMessage(null);
    setGridPage(1);
    setQuery(draftToQuery(draft, sortKey, sortDir, 0));
  };

  const clearFilters = () => {
    const next = defaultDraftFilters();
    setDraft(next);
    setSortKey("epsSurprisePct");
    setSortDir("desc");
    setGridPage(1);
    setQuery(draftToQuery(next, "epsSurprisePct", "desc", 0));
  };

  const runSync = async (mode: "incremental" | "backfill") => {
    setSyncing(mode);
    setMessage(null);
    setError(null);
    try {
      const result = await syncAdminEarningsSurprises(mode);
      setMessage(`${mode === "backfill" ? "Backfill" : "Sync"} complete: ${result.rowsUpserted} row${result.rowsUpserted === 1 ? "" : "s"} upserted.`);
      await load();
      setGridReloadToken((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync earnings surprises.");
    } finally {
      setSyncing(null);
    }
  };

  const changeSort = (key: SortKey) => {
    const nextDir = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : key === "ticker" || key === "companyName" || key === "season" || key === "sector" || key === "industry" || key === "exchange" ? "asc" : "desc";
    setSortKey(key);
    setSortDir(nextDir);
    setGridPage(1);
    setQuery((current) => ({ ...current, sort: key, sortDir: nextDir, offset: 0 }));
  };

  const goPage = (nextOffset: number) => {
    setQuery((current) => ({ ...current, offset: Math.max(0, nextOffset) }));
  };

  const openExpandedChart = (ticker: string) => {
    hoverChart.clearPreview();
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    hoverChart.clearPreview();
    setActiveChartTicker(null);
  };

  const surpriseColumns: Array<EarningsTableColumn<SurpriseColumnKey, EarningsSurpriseRow, SortKey>> = [
    {
      key: "reportDate",
      label: "Report",
      sortKey: "reportDate",
      cellClassName: "whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-300",
      render: (row) => row.reportDate,
    },
    {
      key: "ticker",
      label: "Ticker",
      sortKey: "ticker",
      cellClassName: "whitespace-nowrap px-3 py-3",
      render: (row) => <TickerHoverCell ticker={row.ticker} hoverChart={hoverChart} onPinChart={openExpandedChart} />,
    },
    {
      key: "companyName",
      label: "Company",
      sortKey: "companyName",
      cellClassName: "max-w-[16rem] truncate px-3 py-3 text-slate-200",
      title: (row) => row.companyName ?? undefined,
      render: (row) => row.companyName ?? "-",
    },
    {
      key: "season",
      label: "Season",
      sortKey: "season",
      cellClassName: "whitespace-nowrap px-3 py-3 text-slate-300",
      render: (row) => row.season,
    },
    {
      key: "epsSurprisePct",
      label: "EPS %",
      sortKey: "epsSurprisePct",
      align: "right",
      cellClassName: "whitespace-nowrap px-3 py-3 text-right font-mono font-semibold",
      render: (row) => <span className={pctClass(row.epsSurprisePct)}>{formatPct(row.epsSurprisePct)}</span>,
    },
    {
      key: "epsSurprise",
      label: "EPS Diff",
      sortKey: "epsSurprise",
      align: "right",
      cellClassName: "whitespace-nowrap px-3 py-3 text-right font-mono",
      render: (row) => <span className={pctClass(row.epsSurprise)}>{formatNumber(row.epsSurprise, 3)}</span>,
    },
    {
      key: "epsActual",
      label: "Actual",
      align: "right",
      cellClassName: "whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300",
      render: (row) => formatNumber(row.epsActual, 3),
    },
    {
      key: "epsEstimate",
      label: "Estimate",
      align: "right",
      cellClassName: "whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300",
      render: (row) => formatNumber(row.epsEstimate, 3),
    },
    {
      key: "revenueSurprisePct",
      label: "Rev %",
      sortKey: "revenueSurprisePct",
      align: "right",
      cellClassName: "whitespace-nowrap px-3 py-3 text-right font-mono",
      render: (row) => <span className={pctClass(row.revenueSurprisePct)}>{formatPct(row.revenueSurprisePct)}</span>,
    },
    {
      key: "marketCap",
      label: "Market Cap",
      sortKey: "marketCap",
      align: "right",
      cellClassName: "whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300",
      render: (row) => formatCompact(row.marketCap),
    },
    {
      key: "sector",
      label: "Sector",
      sortKey: "sector",
      cellClassName: "max-w-[12rem] truncate px-3 py-3 text-slate-300",
      title: (row) => row.sector ?? undefined,
      render: (row) => row.sector ?? "-",
    },
    {
      key: "industry",
      label: "Industry",
      sortKey: "industry",
      cellClassName: "max-w-[14rem] truncate px-3 py-3 text-slate-300",
      title: (row) => row.industry ?? undefined,
      render: (row) => row.industry ?? "-",
    },
    {
      key: "exchange",
      label: "Exchange",
      sortKey: "exchange",
      cellClassName: "whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-400",
      render: (row) => row.exchange ?? "-",
    },
  ];
  const surpriseColumnsByKey = new Map(surpriseColumns.map((column) => [column.key, column]));
  const orderedColumns = columnOrder.map((key) => surpriseColumnsByKey.get(key)).filter((column): column is EarningsTableColumn<SurpriseColumnKey, EarningsSurpriseRow, SortKey> => Boolean(column));
  const dropColumn = (targetKey: SurpriseColumnKey) => {
    if (!draggedColumn) return;
    setColumnOrder((current) => moveColumn(current, draggedColumn, targetKey));
    setDraggedColumn(null);
  };

  return (
    <>
      <section className="space-y-5">
      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div>
      ) : null}
      {message ? (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">{message}</div>
      ) : null}
      {data?.warning || status?.warning ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{data?.warning ?? status?.warning}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Rows Stored" value={formatCompact(status?.counts.total ?? total)} helper={`${formatCompact(status?.counts.positive ?? 0)} positive / ${formatCompact(status?.counts.negative ?? 0)} negative`} />
        <StatCard label="Latest Report" value={status?.counts.latestReportDate ?? "-"} helper={`Earliest stored: ${status?.counts.earliestReportDate ?? "-"}`} />
        <StatCard label="Current View" value={formatCompact(total)} helper={data ? `Showing ${pageStart}-${pageEnd}` : "Loading rows"} />
        <StatCard label="Last Sync" value={latestSync?.status ?? "-"} helper={latestSync?.lastSuccessAt ? formatDateTime(latestSync.lastSuccessAt) : "No successful sync yet"} />
      </div>

      <div className="rounded border border-borderSoft/70 bg-panel/80 p-4">
        <div className="grid gap-3 lg:grid-cols-6">
          <label className="text-xs text-slate-400 lg:col-span-2">
            Ticker or company
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                className={`${INPUT_CLASS} pl-9`}
                value={draft.q}
                placeholder="AAPL"
                onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
              />
            </div>
          </label>
          <label className="text-xs text-slate-400">
            Start date
            <input className={`${INPUT_CLASS} mt-1`} type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            End date
            <input className={`${INPUT_CLASS} mt-1`} type="date" value={draft.endDate} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Surprise
            <select className={`${INPUT_CLASS} mt-1`} value={draft.surpriseSide} onChange={(event) => setDraft((current) => ({ ...current, surpriseSide: event.target.value as DraftFilters["surpriseSide"] }))}>
              <option value="all">All non-zero</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Limit
            <input className={`${INPUT_CLASS} mt-1`} value={draft.limit} inputMode="numeric" onChange={(event) => setDraft((current) => ({ ...current, limit: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Min EPS %
            <input className={`${INPUT_CLASS} mt-1`} value={draft.minEpsSurprisePct} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, minEpsSurprisePct: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Season
            <select className={`${INPUT_CLASS} mt-1`} value={draft.season} onChange={(event) => setDraft((current) => ({ ...current, season: event.target.value }))}>
              <option value="">All seasons</option>
              {facetOptions(data?.facets.seasons ?? [], draft.season).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Sector
            <select className={`${INPUT_CLASS} mt-1`} value={draft.sector} onChange={(event) => setDraft((current) => ({ ...current, sector: event.target.value }))}>
              <option value="">All sectors</option>
              {facetOptions(data?.facets.sectors ?? [], draft.sector).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Industry
            <select className={`${INPUT_CLASS} mt-1`} value={draft.industry} onChange={(event) => setDraft((current) => ({ ...current, industry: event.target.value }))}>
              <option value="">All industries</option>
              {facetOptions(data?.facets.industries ?? [], draft.industry).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Exchange
            <select className={`${INPUT_CLASS} mt-1`} value={draft.exchange} onChange={(event) => setDraft((current) => ({ ...current, exchange: event.target.value }))}>
              <option value="">Major US default</option>
              {facetOptions(data?.facets.exchanges ?? [], draft.exchange).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Min cap, $M
            <input className={`${INPUT_CLASS} mt-1`} value={draft.minMarketCap} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, minMarketCap: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Max cap, $M
            <input className={`${INPUT_CLASS} mt-1`} value={draft.maxMarketCap} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, maxMarketCap: event.target.value }))} />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex h-10 items-center gap-2 rounded border border-borderSoft/70 bg-panelSoft/50 px-3 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-cyan-400"
              checked={draft.includeOtc}
              onChange={(event) => setDraft((current) => ({ ...current, includeOtc: event.target.checked }))}
            />
            Include OTC/other exchanges
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={clearFilters}>Clear</button>
            <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={applyFilters}>
              <Search className="h-4 w-4" />
              Apply
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={loading || gridLoading || Boolean(syncing)}
              onClick={() => {
                void load();
                setGridReloadToken((current) => current + 1);
              }}
            >
              <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Reload
            </button>
            <button type="button" className={BUTTON_CLASS} disabled={Boolean(syncing)} onClick={() => void runSync("incremental")}>
              {syncing === "incremental" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync
            </button>
            <button type="button" className={BUTTON_CLASS} disabled={Boolean(syncing)} onClick={() => void runSync("backfill")}>
              {syncing === "backfill" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              Backfill
            </button>
          </div>
        </div>
      </div>

      <ResultViewToggle view={resultView} onChange={setResultView} />

      {resultView === "table" ? (
      <div className="rounded border border-borderSoft/70 bg-panel/80">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderSoft/70 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Surprise Log</h3>
            <p className="text-xs text-slate-500">{data?.generatedAt ? `Generated ${formatDateTime(data.generatedAt)}` : "Waiting for data"}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <ExportTickersControl href={exportUrl} value={exportLimit} onChange={setExportLimit} />
            <ResultsPager loading={loading} limit={limit} offset={offset} total={total} pageStart={pageStart} pageEnd={pageEnd} onPage={goPage} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[82rem] text-left text-sm">
            <thead className="border-b border-borderSoft/70 bg-panelSoft/35">
              <tr>
                {orderedColumns.map((column) => (
                  <DraggableColumnHeader
                    key={column.key}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    draggedKey={draggedColumn}
                    onSort={changeSort}
                    onDragStart={setDraggedColumn}
                    onDrop={dropColumn}
                    onDragEnd={() => setDraggedColumn(null)}
                  />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-borderSoft/60">
              {loading ? (
                <tr>
                  <td colSpan={orderedColumns.length} className="px-4 py-10 text-center text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading earnings surprises...</span>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={orderedColumns.length} className="px-4 py-10 text-center text-sm text-slate-400">No earnings surprise rows match the current filters.</td>
                </tr>
              ) : rows.map((row: EarningsSurpriseRow) => (
                <tr key={row.id} className="hover:bg-panelSoft/35">
                  {orderedColumns.map((column) => (
                    <td key={column.key} className={column.cellClassName} title={column.title?.(row)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      ) : (
        <EarningsMultiChartGrid
          cards={gridCards}
          total={gridData?.total ?? 0}
          page={gridPage}
          pageSize={chartsPerPage}
          loading={gridLoading}
          error={gridError}
          onPageChange={setGridPage}
          onPageSizeChange={(nextPageSize) => {
            setChartsPerPage(nextPageSize);
            setGridPage(1);
          }}
        />
      )}
      </section>
      <HoverChartPreviewPanel
        preview={hoverChart.preview}
        onPreviewMouseEnter={hoverChart.handlePreviewMouseEnter}
        onPreviewMouseLeave={hoverChart.handlePreviewMouseLeave}
        onPinChart={openExpandedChart}
      />
      <ExpandedTradingViewChartModal ticker={activeChartTicker} onClose={closeExpandedChart} />
    </>
  );
}

function gapSourceLabel(value: string | null | undefined): string {
  if (value === "postmarket") return "Postmarket";
  if (value === "regular_open") return "Regular open";
  if (value === "both") return "Both";
  return "-";
}

function EarningsGapsPanel() {
  const [draft, setDraft] = useState<GapDraftFilters>(() => defaultGapDraftFilters());
  const [sortKey, setSortKey] = useState<GapSortKey>("qualifyingGapPct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState<EarningsGapsQuery>(() => gapDraftToQuery(defaultGapDraftFilters(), "qualifyingGapPct", "desc"));
  const [data, setData] = useState<EarningsGapsResponse | null>(null);
  const [resultView, setResultView] = usePersistedResultView(GAP_RESULT_VIEW_STORAGE_KEY);
  const [gridPage, setGridPage] = useState(1);
  const [chartsPerPage, setChartsPerPage] = useState(DEFAULT_CHARTS_PER_PAGE);
  const [gridData, setGridData] = useState<EarningsGapsResponse | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridReloadToken, setGridReloadToken] = useState(0);
  const [status, setStatus] = useState<EarningsGapsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<"incremental" | "backfill" | null>(null);
  const [exportLimit, setExportLimit] = useState(String(EXPORT_LIMIT_DEFAULT));
  const [columnOrder, setColumnOrder] = usePersistedColumnOrder(GAP_COLUMNS_STORAGE_KEY, DEFAULT_GAP_COLUMN_ORDER);
  const [columnWidths, setColumnWidths, resetColumnWidths] = usePersistedColumnWidths(
    GAP_COLUMN_WIDTHS_STORAGE_KEY,
    GAP_COLUMN_WIDTH_SPECS,
  );
  const [gapFontSize, setGapFontSize] = usePersistedGapFontSize(GAP_FONT_SIZE_STORAGE_KEY);
  const [draggedColumn, setDraggedColumn] = useState<GapColumnKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const gapTableRef = useRef<HTMLTableElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const hoverChart = useHoverChartPreview({ disabled: Boolean(activeChartTicker) });

  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const gridQuery = useMemo(() => buildEarningsGridQuery(query, gridPage, chartsPerPage), [chartsPerPage, gridPage, queryKey]);
  const gridQueryKey = useMemo(() => JSON.stringify(gridQuery), [gridQuery]);
  const gridCards = useMemo(() => (gridData?.rows ?? []).map(gapRowToGridCard), [gridData]);
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const latestSync = status?.syncs[0] ?? null;
  const latestScheduledSync = status?.syncs.find((row) => row.scheduledLocalDate) ?? null;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);
  const exportUrl = useMemo(
    () => getEarningsGapsExportUrl({ ...query, limit: clampExportLimit(exportLimit), offset: 0 }, exportDateSuffix()),
    [exportLimit, queryKey],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextData, nextStatus] = await Promise.all([
        getEarningsGaps(query),
        getEarningsGapsStatus(),
      ]);
      setData(nextData);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load earnings gap-ups.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([getEarningsGaps(query), getEarningsGapsStatus()])
      .then(([nextData, nextStatus]) => {
        if (!active) return;
        setData(nextData);
        setStatus(nextStatus);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load earnings gap-ups.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [queryKey]);

  useEffect(() => {
    if (resultView !== "grid") return;
    let active = true;
    setGridLoading(true);
    setGridError(null);
    getEarningsGaps(gridQuery)
      .then((nextData) => {
        if (active) setGridData(nextData);
      })
      .catch((err) => {
        if (active) setGridError(err instanceof Error ? err.message : "Failed to load earnings gap-up charts.");
      })
      .finally(() => {
        if (active) setGridLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gridQueryKey, gridReloadToken, resultView]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil((gridData?.total ?? 0) / chartsPerPage));
    if (gridPage > totalPages) setGridPage(totalPages);
  }, [chartsPerPage, gridData?.total, gridPage]);

  const applyFilters = () => {
    setMessage(null);
    setGridPage(1);
    setQuery(gapDraftToQuery(draft, sortKey, sortDir, 0));
  };

  const clearFilters = () => {
    const next = defaultGapDraftFilters();
    setDraft(next);
    setSortKey("qualifyingGapPct");
    setSortDir("desc");
    setGridPage(1);
    setQuery(gapDraftToQuery(next, "qualifyingGapPct", "desc", 0));
  };

  const runSync = async (mode: "incremental" | "backfill") => {
    setSyncing(mode);
    setMessage(null);
    setError(null);
    let retryCursor: string | null = null;
    let failedSlice = mode === "backfill" ? "the first batch" : "";
    try {
      if (mode === "incremental") {
        const result = await syncAdminEarningsGaps(mode);
        setMessage(`Gap sync complete: ${result.rowsUpserted} qualifying row${result.rowsUpserted === 1 ? "" : "s"} upserted from ${result.rowsSeen} release row${result.rowsSeen === 1 ? "" : "s"}.`);
        await load();
        setGridReloadToken((current) => current + 1);
        return;
      }

      let cursor: string | null = null;
      let totalWindowStart: string | null = null;
      let totalWindowEnd: string | null = null;
      let batchCount = 0;
      let totalRowsSeen = 0;
      let totalRowsUpserted = 0;
      setMessage("Starting 90-day gap backfill...");

      while (true) {
        if (cursor && totalWindowEnd) {
          const estimatedEnd = addDaysIso(cursor, GAP_BACKFILL_BATCH_DAYS - 1);
          const batchEnd = estimatedEnd <= totalWindowEnd ? estimatedEnd : totalWindowEnd;
          const totalBatches = totalWindowStart ? estimateBackfillBatchCount(totalWindowStart, totalWindowEnd) : null;
          failedSlice = `${cursor} to ${batchEnd}`;
          retryCursor = cursor;
          setMessage(`Backfilling ${failedSlice}... batch ${batchCount + 1}${totalBatches ? `/${totalBatches}` : ""}.`);
        } else {
          failedSlice = "the first batch";
          retryCursor = null;
        }

        const result = await syncAdminEarningsGaps("backfill", {
          cursor,
          windowStart: totalWindowStart,
          windowEnd: totalWindowEnd,
        });
        batchCount += 1;
        totalWindowStart = result.totalWindowStart;
        totalWindowEnd = result.totalWindowEnd;
        totalRowsSeen += result.rowsSeen;
        totalRowsUpserted += result.rowsUpserted;
        failedSlice = `${result.batchWindowStart} to ${result.batchWindowEnd}`;
        const totalBatches = estimateBackfillBatchCount(result.totalWindowStart, result.totalWindowEnd);

        if (result.done) {
          setMessage(`Gap backfill complete: ${totalRowsUpserted} qualifying row${totalRowsUpserted === 1 ? "" : "s"} upserted from ${totalRowsSeen} release row${totalRowsSeen === 1 ? "" : "s"} across ${batchCount}/${totalBatches} batch${totalBatches === 1 ? "" : "es"}.`);
          break;
        }

        const previousCursor: string | null = cursor;
        cursor = result.nextCursor;
        if (!cursor || cursor === previousCursor) {
          throw new Error("Gap backfill did not return a valid next cursor.");
        }
        setMessage(`Backfilled ${failedSlice}; continuing... batch ${batchCount}/${totalBatches}.`);
      }
      await load();
      setGridReloadToken((current) => current + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync earnings gap-ups.";
      const retry = mode === "backfill" ? ` Failed batch: ${failedSlice}. Retry cursor: ${retryCursor ?? "start"}.` : "";
      setError(`${message}${retry}`);
    } finally {
      setSyncing(null);
    }
  };

  const changeSort = (key: GapSortKey) => {
    const nextDir = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : key === "ticker" || key === "companyName" || key === "season" || key === "gapSource" || key === "sector" || key === "industry" || key === "exchange" ? "asc" : "desc";
    setSortKey(key);
    setSortDir(nextDir);
    setGridPage(1);
    setQuery((current) => ({ ...current, sort: key, sortDir: nextDir, offset: 0 }));
  };

  const goPage = (nextOffset: number) => {
    setQuery((current) => ({ ...current, offset: Math.max(0, nextOffset) }));
  };

  const changeGapFontSize = (delta: number) => {
    setGapFontSize((current) => adjustGapFontSize(current, delta));
  };

  const openExpandedChart = (ticker: string) => {
    hoverChart.clearPreview();
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    hoverChart.clearPreview();
    setActiveChartTicker(null);
  };

  const gapColumns: Array<EarningsTableColumn<GapColumnKey, EarningsGapRow, GapSortKey>> = [
    {
      key: "reportDate",
      label: "Report",
      sortKey: "reportDate",
      cellClassName: `${GAP_CELL_CLASS} font-mono text-slate-300`,
      render: (row) => row.reportDate,
    },
    {
      key: "ticker",
      label: "Ticker",
      sortKey: "ticker",
      cellClassName: GAP_CELL_CLASS,
      render: (row) => <TickerHoverCell ticker={row.ticker} hoverChart={hoverChart} onPinChart={openExpandedChart} compact />,
    },
    {
      key: "companyName",
      label: "Company",
      sortKey: "companyName",
      cellClassName: `${GAP_CELL_CLASS} text-slate-200`,
      title: (row) => row.companyName ?? undefined,
      render: (row) => row.companyName ?? "-",
    },
    {
      key: "season",
      label: "Season",
      sortKey: "season",
      cellClassName: `${GAP_CELL_CLASS} text-slate-300`,
      render: (row) => row.season,
    },
    {
      key: "epsSurprisePct",
      label: "EPS %",
      sortKey: "epsSurprisePct",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono font-semibold`,
      render: (row) => <span className={pctClass(row.epsSurprisePct)}>{formatPct(row.epsSurprisePct)}</span>,
    },
    {
      key: "epsSurprise",
      label: "EPS Diff",
      sortKey: "epsSurprise",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono`,
      render: (row) => <span className={pctClass(row.epsSurprise)}>{formatNumber(row.epsSurprise, 3)}</span>,
    },
    {
      key: "epsActual",
      label: "Actual",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => formatNumber(row.epsActual, 3),
    },
    {
      key: "epsEstimate",
      label: "Estimate",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => formatNumber(row.epsEstimate, 3),
    },
    {
      key: "gapSource",
      label: "Source",
      sortKey: "gapSource",
      cellClassName: `${GAP_CELL_CLASS} text-slate-300`,
      render: (row) => gapSourceLabel(row.gapSource),
    },
    {
      key: "qualifyingGapPct",
      label: "Best Gap",
      sortKey: "qualifyingGapPct",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono font-semibold`,
      render: (row) => <span className={pctClass(row.qualifyingGapPct)}>{formatPct(row.qualifyingGapPct)}</span>,
    },
    {
      key: "postmarketGapPct",
      label: "Post %",
      sortKey: "postmarketGapPct",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono`,
      render: (row) => <span className={pctClass(row.postmarketGapPct)}>{formatPct(row.postmarketGapPct)}</span>,
    },
    {
      key: "postmarketPrice",
      label: "Post Price",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => formatNumber(row.postmarketPrice, 2),
    },
    {
      key: "postmarketVolume",
      label: "Post Vol",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => formatCompact(row.postmarketVolume),
    },
    {
      key: "regularOpenGapPct",
      label: "Open %",
      sortKey: "regularOpenGapPct",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono`,
      render: (row) => <span className={pctClass(row.regularOpenGapPct)}>{formatPct(row.regularOpenGapPct)}</span>,
    },
    {
      key: "reactionOpen",
      label: "Reaction Open",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => row.reactionDate ? `${row.reactionDate} @ ${formatNumber(row.reactionOpen, 2)}` : "-",
    },
    {
      key: "avgDollarVolume30d",
      label: "$ Volume",
      sortKey: "avgDollarVolume30d",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => formatCompact(row.avgDollarVolume30d),
    },
    {
      key: "marketCap",
      label: "Market Cap",
      sortKey: "marketCap",
      align: "right",
      cellClassName: `${GAP_CELL_CLASS} text-right font-mono text-slate-300`,
      render: (row) => formatCompact(row.marketCap),
    },
    {
      key: "sector",
      label: "Sector",
      sortKey: "sector",
      cellClassName: `${GAP_CELL_CLASS} text-slate-300`,
      title: (row) => row.sector ?? undefined,
      render: (row) => row.sector ?? "-",
    },
    {
      key: "industry",
      label: "Industry",
      sortKey: "industry",
      cellClassName: `${GAP_CELL_CLASS} text-slate-300`,
      title: (row) => row.industry ?? undefined,
      render: (row) => row.industry ?? "-",
    },
    {
      key: "exchange",
      label: "Exchange",
      sortKey: "exchange",
      cellClassName: `${GAP_CELL_CLASS} font-mono text-slate-400`,
      render: (row) => row.exchange ?? "-",
    },
  ];
  const gapColumnsByKey = new Map(gapColumns.map((column) => [column.key, column]));
  const orderedColumns = columnOrder.map((key) => gapColumnsByKey.get(key)).filter((column): column is EarningsTableColumn<GapColumnKey, EarningsGapRow, GapSortKey> => Boolean(column));
  const resizeGapColumnBy = useCallback((key: GapColumnKey, deltaPct: number) => {
    setColumnWidths((current) => resizeAdjacentColumnWidths(
      current,
      columnOrder,
      key,
      deltaPct,
      GAP_COLUMN_WIDTH_SPECS,
    ));
  }, [columnOrder, setColumnWidths]);

  const startGapColumnResize = useCallback((key: GapColumnKey, startClientX: number) => {
    resizeCleanupRef.current?.();
    const tableWidth = gapTableRef.current?.getBoundingClientRect().width ?? 0;
    if (tableWidth <= 0) return;

    const startWidths = columnWidths;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMove = (event: PointerEvent) => {
      const deltaPct = ((event.clientX - startClientX) / tableWidth) * 100;
      setColumnWidths(resizeAdjacentColumnWidths(
        startWidths,
        columnOrder,
        key,
        deltaPct,
        GAP_COLUMN_WIDTH_SPECS,
      ));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = null;
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    resizeCleanupRef.current = cleanup;
  }, [columnOrder, columnWidths, setColumnWidths]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const dropColumn = (targetKey: GapColumnKey) => {
    if (!draggedColumn) return;
    setColumnOrder((current) => moveColumn(current, draggedColumn, targetKey));
    setDraggedColumn(null);
  };

  return (
    <>
      <section className="min-w-0 space-y-5">
      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div>
      ) : null}
      {message ? (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">{message}</div>
      ) : null}
      {data?.warning || status?.warning ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{data?.warning ?? status?.warning}</div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Gap Rows" value={formatCompact(status?.counts.total ?? total)} helper={`${formatCompact(status?.counts.postmarket ?? 0)} postmarket / ${formatCompact(status?.counts.regularOpen ?? 0)} regular open`} />
        <StatCard label="Latest Report" value={status?.counts.latestReportDate ?? "-"} helper={`Earliest stored: ${status?.counts.earliestReportDate ?? "-"}`} />
        <StatCard label="Current View" value={formatCompact(total)} helper={data ? `Showing ${pageStart}-${pageEnd}` : "Loading rows"} />
        <StatCard label="Daily Gap Scan" value={latestScheduledSync?.status ?? latestSync?.status ?? "-"} helper={latestScheduledSync?.scheduledLocalDate ? `${latestScheduledSync.scheduledLocalDate} after 8:00pm ET` : "Runs daily after 8:00pm ET"} />
      </div>

      <div className="rounded border border-borderSoft/70 bg-panel/80 p-4">
        <div className="grid gap-3 lg:grid-cols-6">
          <label className="text-xs text-slate-400 lg:col-span-2">
            Ticker or company
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                className={`${INPUT_CLASS} pl-9`}
                value={draft.q}
                placeholder="AAPL"
                onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
              />
            </div>
          </label>
          <label className="text-xs text-slate-400">
            Start date
            <input className={`${INPUT_CLASS} mt-1`} type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            End date
            <input className={`${INPUT_CLASS} mt-1`} type="date" value={draft.endDate} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Min gap %
            <input className={`${INPUT_CLASS} mt-1`} value={draft.minGapPct} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, minGapPct: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Min $ volume, $M
            <input className={`${INPUT_CLASS} mt-1`} value={draft.minAvgDollarVolume} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, minAvgDollarVolume: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Season
            <select className={`${INPUT_CLASS} mt-1`} value={draft.season} onChange={(event) => setDraft((current) => ({ ...current, season: event.target.value }))}>
              <option value="">All seasons</option>
              {facetOptions(data?.facets.seasons ?? [], draft.season).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Sector
            <select className={`${INPUT_CLASS} mt-1`} value={draft.sector} onChange={(event) => setDraft((current) => ({ ...current, sector: event.target.value }))}>
              <option value="">All sectors</option>
              {facetOptions(data?.facets.sectors ?? [], draft.sector).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Industry
            <select className={`${INPUT_CLASS} mt-1`} value={draft.industry} onChange={(event) => setDraft((current) => ({ ...current, industry: event.target.value }))}>
              <option value="">All industries</option>
              {facetOptions(data?.facets.industries ?? [], draft.industry).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Exchange
            <select className={`${INPUT_CLASS} mt-1`} value={draft.exchange} onChange={(event) => setDraft((current) => ({ ...current, exchange: event.target.value }))}>
              <option value="">Major US default</option>
              {facetOptions(data?.facets.exchanges ?? [], draft.exchange).map((item) => (
                <option key={item.value} value={item.value}>{item.value} ({item.count})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-400">
            Min cap, $M
            <input className={`${INPUT_CLASS} mt-1`} value={draft.minMarketCap} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, minMarketCap: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Max cap, $M
            <input className={`${INPUT_CLASS} mt-1`} value={draft.maxMarketCap} inputMode="decimal" onChange={(event) => setDraft((current) => ({ ...current, maxMarketCap: event.target.value }))} />
          </label>
          <label className="text-xs text-slate-400">
            Limit
            <input className={`${INPUT_CLASS} mt-1`} value={draft.limit} inputMode="numeric" onChange={(event) => setDraft((current) => ({ ...current, limit: event.target.value }))} />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex h-10 items-center gap-2 rounded border border-borderSoft/70 bg-panelSoft/50 px-3 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-cyan-400"
              checked={draft.includeOtc}
              onChange={(event) => setDraft((current) => ({ ...current, includeOtc: event.target.checked }))}
            />
            Include OTC/other exchanges
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={clearFilters}>Clear</button>
            <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={applyFilters}>
              <Search className="h-4 w-4" />
              Apply
            </button>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={loading || gridLoading || Boolean(syncing)}
              onClick={() => {
                void load();
                setGridReloadToken((current) => current + 1);
              }}
            >
              <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Reload
            </button>
            <button type="button" className={BUTTON_CLASS} disabled={Boolean(syncing)} onClick={() => void runSync("incremental")}>
              {syncing === "incremental" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync Gaps
            </button>
            <button type="button" className={BUTTON_CLASS} disabled={Boolean(syncing)} onClick={() => void runSync("backfill")}>
              {syncing === "backfill" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              Backfill Gaps
            </button>
          </div>
        </div>
      </div>

      <ResultViewToggle view={resultView} onChange={setResultView} />

      {resultView === "table" ? (
      <div className="min-w-0 max-w-full rounded border border-borderSoft/70 bg-panel/80">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderSoft/70 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Release Gap-Ups</h3>
            <p className="text-xs text-slate-500">{data?.generatedAt ? `Generated ${formatDateTime(data.generatedAt)}` : "Waiting for data"}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div
              role="group"
              aria-label="Release Gap-Ups font size"
              className="inline-flex h-10 items-stretch overflow-hidden rounded border border-borderSoft/80 bg-panelSoft/80 text-slate-100"
            >
              <span aria-live="polite" className="inline-flex min-w-[4.5rem] items-center justify-center px-2 text-xs font-medium text-slate-300">
                Text {gapFontSize}px
              </span>
              <button
                type="button"
                className="inline-flex w-8 items-center justify-center border-l border-borderSoft/80 transition hover:bg-panelSoft disabled:cursor-not-allowed disabled:opacity-40"
                disabled={gapFontSize <= GAP_FONT_SIZE_MIN_PX}
                onClick={() => changeGapFontSize(-1)}
                title="Decrease Release Gap-Ups font size"
                aria-label="Decrease Release Gap-Ups font size"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="inline-flex w-8 items-center justify-center border-l border-borderSoft/80 transition hover:bg-panelSoft disabled:cursor-not-allowed disabled:opacity-40"
                disabled={gapFontSize >= GAP_FONT_SIZE_MAX_PX}
                onClick={() => changeGapFontSize(1)}
                title="Increase Release Gap-Ups font size"
                aria-label="Increase Release Gap-Ups font size"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={resetColumnWidths}
              title="Restore the default Release Gap-Ups column widths"
            >
              <RotateCcw className="h-4 w-4" />
              Reset widths
            </button>
            <ExportTickersControl href={exportUrl} value={exportLimit} onChange={setExportLimit} />
            <ResultsPager loading={loading} limit={limit} offset={offset} total={total} pageStart={pageStart} pageEnd={pageEnd} onPage={goPage} />
          </div>
        </div>
        <div className="max-w-full overflow-x-auto min-[1440px]:overflow-x-hidden">
          <table
            ref={gapTableRef}
            className="w-full min-w-[70rem] table-fixed text-left min-[1440px]:min-w-0"
            style={{ fontSize: `${gapFontSize}px` }}
          >
            <colgroup>
              {orderedColumns.map((column) => (
                <col key={column.key} style={{ width: `${columnWidths[column.key]}%` }} />
              ))}
            </colgroup>
            <thead className="border-b border-borderSoft/70 bg-panelSoft/35" style={{ fontSize: `${gapHeaderFontSize(gapFontSize)}px` }}>
              <tr>
                {orderedColumns.map((column, index) => (
                  <DraggableColumnHeader
                    key={column.key}
                    column={column}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    draggedKey={draggedColumn}
                    compact
                    canResize={index < orderedColumns.length - 1}
                    widthPct={columnWidths[column.key]}
                    onSort={changeSort}
                    onDragStart={setDraggedColumn}
                    onDrop={dropColumn}
                    onDragEnd={() => setDraggedColumn(null)}
                    onResizeStart={startGapColumnResize}
                    onResizeBy={resizeGapColumnBy}
                  />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-borderSoft/60">
              {loading ? (
                <tr>
                  <td colSpan={orderedColumns.length} className="px-4 py-10 text-center text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading earnings gap-ups...</span>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={orderedColumns.length} className="px-4 py-10 text-center text-sm text-slate-400">No earnings gap-up rows match the current filters.</td>
                </tr>
              ) : rows.map((row: EarningsGapRow) => (
                <tr key={row.id} className="hover:bg-panelSoft/35">
                  {orderedColumns.map((column) => (
                    <td key={column.key} className={column.cellClassName} title={column.title?.(row)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      ) : (
        <EarningsMultiChartGrid
          cards={gridCards}
          total={gridData?.total ?? 0}
          page={gridPage}
          pageSize={chartsPerPage}
          loading={gridLoading}
          error={gridError}
          onPageChange={setGridPage}
          onPageSizeChange={(nextPageSize) => {
            setChartsPerPage(nextPageSize);
            setGridPage(1);
          }}
        />
      )}
      </section>
      <HoverChartPreviewPanel
        preview={hoverChart.preview}
        onPreviewMouseEnter={hoverChart.handlePreviewMouseEnter}
        onPreviewMouseLeave={hoverChart.handlePreviewMouseLeave}
        onPinChart={openExpandedChart}
      />
      <ExpandedTradingViewChartModal ticker={activeChartTicker} onClose={closeExpandedChart} />
    </>
  );
}
