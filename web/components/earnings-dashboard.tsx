"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Database, Loader2, Maximize2, RefreshCw, Search } from "lucide-react";
import {
  getEarningsGaps,
  getEarningsGapsStatus,
  getEarningsSurprises,
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

const INPUT_CLASS =
  "h-10 w-full rounded border border-borderSoft/80 bg-panelSoft/85 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";
const BUTTON_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded border border-borderSoft/80 bg-panelSoft/80 px-3 text-sm font-medium text-slate-100 transition hover:bg-panelSoft disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-10 items-center justify-center gap-2 rounded bg-accent px-3 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";
const SURPRISE_HISTORY_DAYS = 183;
const GAP_HISTORY_DAYS = 90;
const GAP_BACKFILL_BATCH_DAYS = 7;

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
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
    startDate: isoDateDaysAgo(SURPRISE_HISTORY_DAYS),
    endDate: todayIso(),
    minMarketCap: "",
    maxMarketCap: "",
    season: "",
    sector: "",
    industry: "",
    exchange: "",
    surpriseSide: "all",
    includeOtc: false,
    limit: "100",
  };
}

function defaultGapDraftFilters(): GapDraftFilters {
  return {
    q: "",
    startDate: isoDateDaysAgo(GAP_HISTORY_DAYS),
    endDate: todayIso(),
    minMarketCap: "",
    maxMarketCap: "",
    minAvgDollarVolume: "",
    minGapPct: "",
    season: "",
    sector: "",
    industry: "",
    exchange: "",
    includeOtc: false,
    limit: "100",
  };
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function draftToQuery(draft: DraftFilters, sort: SortKey, sortDir: "asc" | "desc", offset = 0): EarningsSurprisesQuery {
  const minMarketCap = toNumber(draft.minMarketCap);
  const maxMarketCap = toNumber(draft.maxMarketCap);
  return {
    limit: Math.max(25, Math.min(250, Number(draft.limit) || 100)),
    offset,
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
    sort,
    sortDir,
  };
}

function gapDraftToQuery(draft: GapDraftFilters, sort: GapSortKey, sortDir: "asc" | "desc", offset = 0): EarningsGapsQuery {
  const minMarketCap = toNumber(draft.minMarketCap);
  const maxMarketCap = toNumber(draft.maxMarketCap);
  const minAvgDollarVolume = toNumber(draft.minAvgDollarVolume);
  const minGapPct = toNumber(draft.minGapPct);
  return {
    limit: Math.max(25, Math.min(250, Number(draft.limit) || 100)),
    offset,
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
}: {
  ticker: string;
  hoverChart: HoverChartController;
  onPinChart: (ticker: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
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
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-borderSoft/60 bg-panelSoft/35 text-slate-400 opacity-75 transition hover:bg-panelSoft/55 hover:text-accent focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent/25"
        onClick={(event) => {
          event.stopPropagation();
          onPinChart(ticker);
        }}
        title={`Pin chart for ${ticker}`}
        aria-label={`Pin chart for ${ticker}`}
      >
        <Maximize2 className="h-3.5 w-3.5" />
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
  const [status, setStatus] = useState<EarningsSurprisesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<"incremental" | "backfill" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const hoverChart = useHoverChartPreview({ disabled: Boolean(activeChartTicker) });

  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const latestSync = status?.syncs[0] ?? null;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);

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

  const applyFilters = () => {
    setMessage(null);
    setQuery(draftToQuery(draft, sortKey, sortDir, 0));
  };

  const clearFilters = () => {
    const next = defaultDraftFilters();
    setDraft(next);
    setSortKey("epsSurprisePct");
    setSortDir("desc");
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
    setQuery((current) => ({ ...current, sort: key, sortDir: nextDir, offset: 0 }));
  };

  const sortButton = (key: SortKey, label: string, align: "left" | "right" = "left") => (
    <button
      type="button"
      className={`inline-flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 hover:text-slate-200 ${align === "right" ? "justify-end" : "justify-start"}`}
      onClick={() => changeSort(key)}
    >
      {label}
      {sortKey === key ? <span className="text-accent">{sortDir === "asc" ? "ASC" : "DESC"}</span> : null}
    </button>
  );

  const goPage = (direction: "prev" | "next") => {
    const nextOffset = direction === "prev"
      ? Math.max(0, offset - limit)
      : offset + limit;
    if (direction === "next" && nextOffset >= total) return;
    setQuery((current) => ({ ...current, offset: nextOffset }));
  };

  const openExpandedChart = (ticker: string) => {
    hoverChart.clearPreview();
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    hoverChart.clearPreview();
    setActiveChartTicker(null);
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
            <button type="button" className={BUTTON_CLASS} disabled={loading || Boolean(syncing)} onClick={() => void load()}>
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

      <div className="rounded border border-borderSoft/70 bg-panel/80">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderSoft/70 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Surprise Log</h3>
            <p className="text-xs text-slate-500">{data?.generatedAt ? `Generated ${formatDateTime(data.generatedAt)}` : "Waiting for data"}</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <button type="button" className={BUTTON_CLASS} disabled={offset <= 0 || loading} onClick={() => goPage("prev")} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-28 text-center">{pageStart}-{pageEnd} of {formatCompact(total)}</span>
            <button type="button" className={BUTTON_CLASS} disabled={offset + limit >= total || loading} onClick={() => goPage("next")} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[82rem] text-left text-sm">
            <thead className="border-b border-borderSoft/70 bg-panelSoft/35">
              <tr>
                <th className="px-3 py-3">{sortButton("reportDate", "Report")}</th>
                <th className="px-3 py-3">{sortButton("ticker", "Ticker")}</th>
                <th className="px-3 py-3">{sortButton("companyName", "Company")}</th>
                <th className="px-3 py-3">{sortButton("season", "Season")}</th>
                <th className="px-3 py-3 text-right">{sortButton("epsSurprisePct", "EPS %", "right")}</th>
                <th className="px-3 py-3 text-right">{sortButton("epsSurprise", "EPS Diff", "right")}</th>
                <th className="px-3 py-3 text-right">Actual</th>
                <th className="px-3 py-3 text-right">Estimate</th>
                <th className="px-3 py-3 text-right">{sortButton("revenueSurprisePct", "Rev %", "right")}</th>
                <th className="px-3 py-3 text-right">{sortButton("marketCap", "Market Cap", "right")}</th>
                <th className="px-3 py-3">{sortButton("sector", "Sector")}</th>
                <th className="px-3 py-3">{sortButton("industry", "Industry")}</th>
                <th className="px-3 py-3">{sortButton("exchange", "Exchange")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderSoft/60">
              {loading ? (
                <tr>
                  <td colSpan={13} className="px-4 py-10 text-center text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading earnings surprises...</span>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-4 py-10 text-center text-sm text-slate-400">No earnings surprise rows match the current filters.</td>
                </tr>
              ) : rows.map((row: EarningsSurpriseRow) => (
                <tr key={row.id} className="hover:bg-panelSoft/35">
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-300">{row.reportDate}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <TickerHoverCell ticker={row.ticker} hoverChart={hoverChart} onPinChart={openExpandedChart} />
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-3 text-slate-200" title={row.companyName ?? undefined}>{row.companyName ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-300">{row.season}</td>
                  <td className={`whitespace-nowrap px-3 py-3 text-right font-mono font-semibold ${pctClass(row.epsSurprisePct)}`}>{formatPct(row.epsSurprisePct)}</td>
                  <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${pctClass(row.epsSurprise)}`}>{formatNumber(row.epsSurprise, 3)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatNumber(row.epsActual, 3)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatNumber(row.epsEstimate, 3)}</td>
                  <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${pctClass(row.revenueSurprisePct)}`}>{formatPct(row.revenueSurprisePct)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatCompact(row.marketCap)}</td>
                  <td className="max-w-[12rem] truncate px-3 py-3 text-slate-300" title={row.sector ?? undefined}>{row.sector ?? "-"}</td>
                  <td className="max-w-[14rem] truncate px-3 py-3 text-slate-300" title={row.industry ?? undefined}>{row.industry ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-400">{row.exchange ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
  const [status, setStatus] = useState<EarningsGapsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<"incremental" | "backfill" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeChartTicker, setActiveChartTicker] = useState<string | null>(null);
  const hoverChart = useHoverChartPreview({ disabled: Boolean(activeChartTicker) });

  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const latestSync = status?.syncs[0] ?? null;
  const latestScheduledSync = status?.syncs.find((row) => row.scheduledLocalDate) ?? null;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + rows.length, total);

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

  const applyFilters = () => {
    setMessage(null);
    setQuery(gapDraftToQuery(draft, sortKey, sortDir, 0));
  };

  const clearFilters = () => {
    const next = defaultGapDraftFilters();
    setDraft(next);
    setSortKey("qualifyingGapPct");
    setSortDir("desc");
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
    setQuery((current) => ({ ...current, sort: key, sortDir: nextDir, offset: 0 }));
  };

  const sortButton = (key: GapSortKey, label: string, align: "left" | "right" = "left") => (
    <button
      type="button"
      className={`inline-flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 hover:text-slate-200 ${align === "right" ? "justify-end" : "justify-start"}`}
      onClick={() => changeSort(key)}
    >
      {label}
      {sortKey === key ? <span className="text-accent">{sortDir === "asc" ? "ASC" : "DESC"}</span> : null}
    </button>
  );

  const goPage = (direction: "prev" | "next") => {
    const nextOffset = direction === "prev"
      ? Math.max(0, offset - limit)
      : offset + limit;
    if (direction === "next" && nextOffset >= total) return;
    setQuery((current) => ({ ...current, offset: nextOffset }));
  };

  const openExpandedChart = (ticker: string) => {
    hoverChart.clearPreview();
    setActiveChartTicker(ticker);
  };

  const closeExpandedChart = () => {
    hoverChart.clearPreview();
    setActiveChartTicker(null);
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
            <button type="button" className={BUTTON_CLASS} disabled={loading || Boolean(syncing)} onClick={() => void load()}>
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

      <div className="rounded border border-borderSoft/70 bg-panel/80">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-borderSoft/70 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Release Gap-Ups</h3>
            <p className="text-xs text-slate-500">{data?.generatedAt ? `Generated ${formatDateTime(data.generatedAt)}` : "Waiting for data"}</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <button type="button" className={BUTTON_CLASS} disabled={offset <= 0 || loading} onClick={() => goPage("prev")} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-28 text-center">{pageStart}-{pageEnd} of {formatCompact(total)}</span>
            <button type="button" className={BUTTON_CLASS} disabled={offset + limit >= total || loading} onClick={() => goPage("next")} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[96rem] text-left text-sm">
            <thead className="border-b border-borderSoft/70 bg-panelSoft/35">
              <tr>
                <th className="px-3 py-3">{sortButton("reportDate", "Report")}</th>
                <th className="px-3 py-3">{sortButton("ticker", "Ticker")}</th>
                <th className="px-3 py-3">{sortButton("companyName", "Company")}</th>
                <th className="px-3 py-3">{sortButton("season", "Season")}</th>
                <th className="px-3 py-3">{sortButton("gapSource", "Source")}</th>
                <th className="px-3 py-3 text-right">{sortButton("qualifyingGapPct", "Best Gap", "right")}</th>
                <th className="px-3 py-3 text-right">{sortButton("postmarketGapPct", "Post %", "right")}</th>
                <th className="px-3 py-3 text-right">Post Price</th>
                <th className="px-3 py-3 text-right">Post Vol</th>
                <th className="px-3 py-3 text-right">{sortButton("regularOpenGapPct", "Open %", "right")}</th>
                <th className="px-3 py-3 text-right">Reaction Open</th>
                <th className="px-3 py-3 text-right">{sortButton("avgDollarVolume30d", "$ Volume", "right")}</th>
                <th className="px-3 py-3 text-right">{sortButton("marketCap", "Market Cap", "right")}</th>
                <th className="px-3 py-3">{sortButton("sector", "Sector")}</th>
                <th className="px-3 py-3">{sortButton("industry", "Industry")}</th>
                <th className="px-3 py-3">{sortButton("exchange", "Exchange")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-borderSoft/60">
              {loading ? (
                <tr>
                  <td colSpan={16} className="px-4 py-10 text-center text-sm text-slate-400">
                    <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading earnings gap-ups...</span>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={16} className="px-4 py-10 text-center text-sm text-slate-400">No earnings gap-up rows match the current filters.</td>
                </tr>
              ) : rows.map((row: EarningsGapRow) => (
                <tr key={row.id} className="hover:bg-panelSoft/35">
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-300">{row.reportDate}</td>
                  <td className="whitespace-nowrap px-3 py-3">
                    <TickerHoverCell ticker={row.ticker} hoverChart={hoverChart} onPinChart={openExpandedChart} />
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-3 text-slate-200" title={row.companyName ?? undefined}>{row.companyName ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-300">{row.season}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-300">{gapSourceLabel(row.gapSource)}</td>
                  <td className={`whitespace-nowrap px-3 py-3 text-right font-mono font-semibold ${pctClass(row.qualifyingGapPct)}`}>{formatPct(row.qualifyingGapPct)}</td>
                  <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${pctClass(row.postmarketGapPct)}`}>{formatPct(row.postmarketGapPct)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatNumber(row.postmarketPrice, 2)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatCompact(row.postmarketVolume)}</td>
                  <td className={`whitespace-nowrap px-3 py-3 text-right font-mono ${pctClass(row.regularOpenGapPct)}`}>{formatPct(row.regularOpenGapPct)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{row.reactionDate ? `${row.reactionDate} @ ${formatNumber(row.reactionOpen, 2)}` : "-"}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatCompact(row.avgDollarVolume30d)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-300">{formatCompact(row.marketCap)}</td>
                  <td className="max-w-[12rem] truncate px-3 py-3 text-slate-300" title={row.sector ?? undefined}>{row.sector ?? "-"}</td>
                  <td className="max-w-[14rem] truncate px-3 py-3 text-slate-300" title={row.industry ?? undefined}>{row.industry ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-400">{row.exchange ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
