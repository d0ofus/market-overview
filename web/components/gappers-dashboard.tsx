"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, Maximize2 } from "lucide-react";
import {
  getGappersWithConfig,
  getTickerNews,
  type AlertNewsRow,
  type GapperRow,
  type GappersLlmConfig,
  type GappersScanFilters,
  type GappersSnapshot,
  type LlmProvider,
} from "@/lib/api";
import { ChartGridPager } from "./chart-grid-pager";
import { TradingViewWidget } from "./tradingview-widget";

type SortKey =
  | "ticker"
  | "name"
  | "sector"
  | "industry"
  | "marketCap"
  | "price"
  | "prevClose"
  | "premarketPrice"
  | "gapPct"
  | "premarketVolume"
  | "compositeScore";

type ViewMode = "table" | "grid";

type DraftLlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
};

type DraftScanFilters = {
  limit: string;
  minMarketCap: string;
  maxMarketCap: string;
  industries: string;
  minPrice: string;
  maxPrice: string;
  minGapPct: string;
  maxGapPct: string;
};

const POLL_MS = 45_000;
const STORAGE_KEY = "gappers-llm-config";
const FILTERS_STORAGE_KEY = "gappers-scan-filters";
const CHARTS_PER_PAGE = 20;
const FILTER_INPUT_CLASS =
  "w-full rounded border border-borderSoft/80 bg-panelSoft/85 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20";
const DETAIL_PANEL_CLASS = "rounded border border-borderSoft/70 bg-panelSoft/70 p-3";

function fmtNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function fmtDateTime(value: string | null | undefined): string {
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

function normalizeDraftConfig(config: DraftLlmConfig): GappersLlmConfig | null {
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  if (!apiKey || !model) return null;
  return {
    provider: config.provider,
    apiKey,
    model,
    baseUrl: config.baseUrl.trim() || null,
  };
}

function readStoredFilters(): DraftScanFilters {
  const fallback: DraftScanFilters = {
    limit: "50",
    minMarketCap: "",
    maxMarketCap: "",
    industries: "",
    minPrice: "",
    maxPrice: "",
    minGapPct: "",
    maxGapPct: "",
  };
  if (typeof window === "undefined") return fallback;
  const normalizeLegacyMarketCap = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed) return "";
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return trimmed;
    return parsed >= 1_000_000 ? String(parsed / 1_000_000) : trimmed;
  };
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DraftScanFilters>;
    return {
      limit: typeof parsed.limit === "string" && parsed.limit.trim() ? parsed.limit : fallback.limit,
      minMarketCap: normalizeLegacyMarketCap(parsed.minMarketCap),
      maxMarketCap: normalizeLegacyMarketCap(parsed.maxMarketCap),
      industries: typeof parsed.industries === "string" ? parsed.industries : "",
      minPrice: typeof parsed.minPrice === "string" ? parsed.minPrice : "",
      maxPrice: typeof parsed.maxPrice === "string" ? parsed.maxPrice : "",
      minGapPct: typeof parsed.minGapPct === "string" ? parsed.minGapPct : "",
      maxGapPct: typeof parsed.maxGapPct === "string" ? parsed.maxGapPct : "",
    };
  } catch {
    return fallback;
  }
}

function normalizeDraftFilters(filters: DraftScanFilters): GappersScanFilters {
  const toNumber = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const minMarketCapMillions = toNumber(filters.minMarketCap);
  const maxMarketCapMillions = toNumber(filters.maxMarketCap);
  return {
    limit: Math.max(1, Math.min(100, Number(filters.limit) || 50)),
    minMarketCap: minMarketCapMillions == null ? null : minMarketCapMillions * 1_000_000,
    maxMarketCap: maxMarketCapMillions == null ? null : maxMarketCapMillions * 1_000_000,
    industries: filters.industries.split(",").map((value) => value.trim()).filter(Boolean),
    minPrice: toNumber(filters.minPrice),
    maxPrice: toNumber(filters.maxPrice),
    minGapPct: toNumber(filters.minGapPct),
    maxGapPct: toNumber(filters.maxGapPct),
  };
}

function defaultModelFor(provider: LlmProvider): string {
  return provider === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4.1-mini";
}

function readStoredConfig(): DraftLlmConfig {
  if (typeof window === "undefined") {
    return { provider: "openai", apiKey: "", model: defaultModelFor("openai"), baseUrl: "" };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { provider: "openai", apiKey: "", model: defaultModelFor("openai"), baseUrl: "" };
    }
    const parsed = JSON.parse(raw) as Partial<DraftLlmConfig>;
    const provider = parsed.provider === "anthropic" ? "anthropic" : "openai";
    return {
      provider,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : defaultModelFor(provider),
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
    };
  } catch {
    return { provider: "openai", apiKey: "", model: defaultModelFor("openai"), baseUrl: "" };
  }
}

function cellClass(n: number): string {
  return n >= 0 ? "text-pos" : "text-neg";
}

function GapperNewsList({
  ticker,
  news,
  isLoading,
}: {
  ticker: string;
  news: AlertNewsRow[];
  isLoading: boolean;
}) {
  return (
    <div className="space-y-2">
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading news...
        </div>
      ) : null}
      {news.map((item, idx) => (
        <article key={`${ticker}-${idx}`} className="rounded border border-borderSoft/60 bg-panel/70 p-2">
          <a href={item.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-accent hover:underline">
            {item.headline}
          </a>
          <div className="mt-1 text-[11px] text-slate-400">
            {item.source} {item.publishedAt ? `• ${fmtDateTime(item.publishedAt)}` : ""}
          </div>
          {item.snippet ? <div className="mt-1 text-xs text-slate-300">{item.snippet}</div> : null}
        </article>
      ))}
      {!isLoading && news.length === 0 ? <p className="text-xs text-slate-400">No news found for this ticker.</p> : null}
    </div>
  );
}

export function GappersDashboard() {
  const [snapshot, setSnapshot] = useState<GappersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [expandedGridNews, setExpandedGridNews] = useState<Set<string>>(new Set());
  const [newsByTicker, setNewsByTicker] = useState<Record<string, AlertNewsRow[]>>({});
  const [newsLoadingTicker, setNewsLoadingTicker] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("gapPct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [chartPage, setChartPage] = useState(1);
  const [activeChartRow, setActiveChartRow] = useState<GapperRow | null>(null);
  const [draftConfig, setDraftConfig] = useState<DraftLlmConfig>(() => readStoredConfig());
  const [activeConfig, setActiveConfig] = useState<DraftLlmConfig>(() => readStoredConfig());
  const [draftFilters, setDraftFilters] = useState<DraftScanFilters>(() => readStoredFilters());
  const [activeFilters, setActiveFilters] = useState<DraftScanFilters>(() => readStoredFilters());

  const activeModelLabel = snapshot?.rows.find((row) => row.analysis?.model)?.analysis?.model ?? "rules";

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draftConfig));
  }, [draftConfig]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(draftFilters));
  }, [draftFilters]);

  useEffect(() => {
    let cancelled = false;

    const load = async (force = false) => {
      try {
        setRefreshing(true);
        const next = await getGappersWithConfig(
          normalizeDraftFilters(force ? draftFilters : activeFilters).limit,
          force,
          normalizeDraftConfig(force ? draftConfig : activeConfig),
          normalizeDraftFilters(force ? draftFilters : activeFilters),
        );
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
        if (force) {
          setActiveConfig(draftConfig);
          setActiveFilters(draftFilters);
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load gappers.");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load(false);
    };

    void load(false);
    const interval = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeConfig, activeFilters, draftConfig, draftFilters]);

  const rows = snapshot?.rows ?? [];
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const valueFor = (row: GapperRow, key: SortKey): number | string => {
      if (key === "ticker") return row.ticker;
      if (key === "name") return row.name ?? row.ticker;
      if (key === "sector") return row.sector ?? "";
      if (key === "industry") return row.industry ?? "";
      if (key === "marketCap") return row.marketCap ?? Number.NEGATIVE_INFINITY;
      if (key === "price") return row.price ?? Number.NEGATIVE_INFINITY;
      if (key === "prevClose") return row.prevClose ?? Number.NEGATIVE_INFINITY;
      if (key === "premarketPrice") return row.premarketPrice ?? Number.NEGATIVE_INFINITY;
      if (key === "gapPct") return row.gapPct ?? Number.NEGATIVE_INFINITY;
      if (key === "premarketVolume") return row.premarketVolume ?? Number.NEGATIVE_INFINITY;
      return row.compositeScore ?? Number.NEGATIVE_INFINITY;
    };
    copy.sort((a, b) => {
      const av = valueFor(a, sortKey);
      const bv = valueFor(b, sortKey);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const cmp = av - bv;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortDir, sortKey]);

  const totalGridPages = Math.max(1, Math.ceil(sortedRows.length / CHARTS_PER_PAGE));
  const pagedRows = useMemo(
    () => sortedRows.slice((chartPage - 1) * CHARTS_PER_PAGE, chartPage * CHARTS_PER_PAGE),
    [chartPage, sortedRows],
  );

  useEffect(() => {
    if (chartPage <= totalGridPages) return;
    setChartPage(totalGridPages);
  }, [chartPage, totalGridPages]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "ticker" || key === "name" || key === "sector" || key === "industry" ? "asc" : "desc");
    setChartPage(1);
  };

  const applySettings = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const next = await getGappersWithConfig(
        normalizeDraftFilters(draftFilters).limit,
        true,
        normalizeDraftConfig(draftConfig),
        normalizeDraftFilters(draftFilters),
      );
      setSnapshot(next);
      setActiveConfig(draftConfig);
      setActiveFilters(draftFilters);
      setChartPage(1);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to refresh gappers.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadTickerNews = async (ticker: string) => {
    if (newsByTicker[ticker]) return;
    setNewsLoadingTicker(ticker);
    try {
      const payload = await getTickerNews(ticker, null, 5);
      setNewsByTicker((current) => ({ ...current, [ticker]: payload.rows ?? [] }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load ticker news.");
    } finally {
      setNewsLoadingTicker((current) => (current === ticker ? null : current));
    }
  };

  const toggleExpandedTicker = (ticker: string) => {
    setExpandedTicker((current) => {
      const next = current === ticker ? null : ticker;
      if (next) void loadTickerNews(next);
      return next;
    });
  };

  const toggleGridNews = (ticker: string) => {
    setExpandedGridNews((current) => {
      const next = new Set(current);
      if (next.has(ticker)) {
        next.delete(ticker);
      } else {
        next.add(ticker);
        void loadTickerNews(ticker);
      }
      return next;
    });
  };

  if (loading && !snapshot) {
    return (
      <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading gappers...
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="card p-3 text-sm">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr),auto]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-xl bg-slate-800/70 px-2 py-1">
                  Last updated: <b>{fmtDateTime(snapshot?.generatedAt)}</b>
                </span>
                <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Session: {snapshot?.marketSession ?? "premarket"}</span>
                <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Tracked: {snapshot?.rowCount ?? 0}</span>
                <span className="rounded-xl bg-accent/15 px-2 py-1 text-accent">Source: {snapshot?.providerLabel ?? "-"}</span>
                <span className="rounded-xl bg-slate-800/50 px-2 py-1 text-slate-300">Analysis: {activeModelLabel}</span>
                <span className={`rounded-xl px-2 py-1 ${snapshot?.status === "error" ? "bg-red-500/15 text-red-300" : snapshot?.status === "warning" ? "bg-yellow-500/15 text-yellow-200" : "bg-slate-800/50 text-slate-300"}`}>
                  Status: {snapshot?.status ?? "-"}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Limit</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="numeric"
                    value={draftFilters.limit}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, limit: event.target.value }))}
                    placeholder="50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Industries</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    value={draftFilters.industries}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, industries: event.target.value }))}
                    placeholder="Semiconductors, Biotechnology"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Min Market Cap (USD MM)</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="decimal"
                    value={draftFilters.minMarketCap}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, minMarketCap: event.target.value }))}
                    placeholder="1000"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Max Market Cap (USD MM)</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="decimal"
                    value={draftFilters.maxMarketCap}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, maxMarketCap: event.target.value }))}
                    placeholder="100000"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Min Price</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="decimal"
                    value={draftFilters.minPrice}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, minPrice: event.target.value }))}
                    placeholder="1"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Max Price</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="decimal"
                    value={draftFilters.maxPrice}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, maxPrice: event.target.value }))}
                    placeholder="50"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Min Gap %</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="decimal"
                    value={draftFilters.minGapPct}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, minGapPct: event.target.value }))}
                    placeholder="5"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Max Gap %</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    inputMode="decimal"
                    value={draftFilters.maxGapPct}
                    onChange={(event) => setDraftFilters((current) => ({ ...current, maxGapPct: event.target.value }))}
                    placeholder="40"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">LLM Provider</span>
                  <select
                    className={FILTER_INPUT_CLASS}
                    value={draftConfig.provider}
                    onChange={(event) => {
                      const provider = event.target.value === "anthropic" ? "anthropic" : "openai";
                      setDraftConfig((current) => ({
                        ...current,
                        provider,
                        model: current.model.trim() === "" || current.model === defaultModelFor(current.provider)
                          ? defaultModelFor(provider)
                          : current.model,
                      }));
                    }}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Model</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    value={draftConfig.model}
                    onChange={(event) => setDraftConfig((current) => ({ ...current, model: event.target.value }))}
                    placeholder={defaultModelFor(draftConfig.provider)}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">API Key</span>
                  <input
                    type="password"
                    className={FILTER_INPUT_CLASS}
                    value={draftConfig.apiKey}
                    onChange={(event) => setDraftConfig((current) => ({ ...current, apiKey: event.target.value }))}
                    placeholder={draftConfig.provider === "anthropic" ? "sk-ant-..." : "sk-..."}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Base URL</span>
                  <input
                    className={FILTER_INPUT_CLASS}
                    value={draftConfig.baseUrl}
                    onChange={(event) => setDraftConfig((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder={draftConfig.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
                  />
                </label>
              </div>
            </div>
            <div className="flex flex-col items-stretch justify-end gap-2">
              <div className="rounded border border-borderSoft/70 bg-panelSoft/35 p-1">
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    className={`rounded px-3 py-2 text-sm font-medium transition ${viewMode === "table" ? "bg-accent/20 text-accent" : "text-slate-300 hover:bg-panelSoft/50"}`}
                    onClick={() => setViewMode("table")}
                  >
                    Table View
                  </button>
                  <button
                    type="button"
                    className={`rounded px-3 py-2 text-sm font-medium transition ${viewMode === "grid" ? "bg-accent/20 text-accent" : "text-slate-300 hover:bg-panelSoft/50"}`}
                    onClick={() => setViewMode("grid")}
                  >
                    Multi-Chart
                  </button>
                </div>
              </div>
              <button
                className="inline-flex items-center justify-center gap-2 rounded border border-accent/50 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void applySettings()}
                disabled={refreshing}
              >
                {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Apply And Refresh
              </button>
            </div>
          </div>
          {snapshot?.warning ? <p className="mt-2 text-xs text-yellow-200">{snapshot.warning}</p> : null}
          {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
        </div>

        {viewMode === "table" ? (
          <div className="card overflow-hidden shadow-[0_6px_30px_rgba(15,23,42,0.3)]">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/60">
                  <tr>
                    {[
                      ["ticker", "Ticker"],
                      ["name", "Company"],
                      ["sector", "Sector"],
                      ["industry", "Industry"],
                      ["marketCap", "Market Cap"],
                      ["price", "Price"],
                      ["prevClose", "Prev Close"],
                      ["premarketPrice", "Pre Price"],
                      ["gapPct", "Gap %"],
                      ["premarketVolume", "Pre Vol"],
                      ["compositeScore", "Score"],
                    ].map(([key, label]) => (
                      <th key={key} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                        <button className="inline-flex items-center gap-1 text-left hover:text-slate-100" onClick={() => onSort(key as SortKey)}>
                          {label}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const isOpen = expandedTicker === row.ticker;
                    const news = newsByTicker[row.ticker] ?? [];
                    return (
                      <Fragment key={row.ticker}>
                        <tr
                          className="cursor-pointer border-t border-borderSoft/80 transition-colors hover:bg-slate-900/30"
                          onClick={() => toggleExpandedTicker(row.ticker)}
                        >
                          <td className="px-3 py-2 font-semibold text-accent">{row.ticker}</td>
                          <td className="max-w-48 truncate px-3 py-2 text-slate-300">{row.name ?? row.ticker}</td>
                          <td className="px-3 py-2 text-slate-300">{row.sector ?? "-"}</td>
                          <td className="px-3 py-2 text-slate-300">{row.industry ?? "-"}</td>
                          <td className="px-3 py-2 text-slate-300">{fmtCompact(row.marketCap)}</td>
                          <td className="px-3 py-2 text-slate-300">{fmtNumber(row.price)}</td>
                          <td className="px-3 py-2 text-slate-300">{fmtNumber(row.prevClose)}</td>
                          <td className="px-3 py-2 text-slate-300">{fmtNumber(row.premarketPrice)}</td>
                          <td className={`px-3 py-2 ${cellClass(row.gapPct)}`}>{fmtPct(row.gapPct)}</td>
                          <td className="px-3 py-2 text-slate-300">{fmtCompact(row.premarketVolume)}</td>
                          <td className="px-3 py-2 text-slate-300">{fmtNumber(row.compositeScore, 0)}</td>
                        </tr>
                        {isOpen ? (
                          <tr className="border-t border-borderSoft/60 bg-panel/50">
                            <td colSpan={11} className="px-3 py-3">
                              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr),minmax(24rem,1fr)]">
                                <div className="space-y-3">
                                  <div className={DETAIL_PANEL_CLASS}>
                                    <h4 className="mb-2 text-sm font-semibold text-slate-100">Latest News</h4>
                                    <GapperNewsList
                                      ticker={row.ticker}
                                      news={news}
                                      isLoading={newsLoadingTicker === row.ticker}
                                    />
                                  </div>
                                  <div className={DETAIL_PANEL_CLASS}>
                                    <h4 className="mb-2 text-sm font-semibold text-slate-100">Analysis</h4>
                                    {row.analysis ? (
                                      <div className="space-y-2 text-sm">
                                        <p className="text-slate-200">{row.analysis.summary}</p>
                                        <div className="flex flex-wrap gap-2 text-xs">
                                          <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Freshness: {row.analysis.freshnessLabel} ({fmtNumber(row.analysis.freshnessScore, 0)})</span>
                                          <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Impact: {row.analysis.impactLabel} ({fmtNumber(row.analysis.impactScore, 0)})</span>
                                          <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Liquidity risk: {row.analysis.liquidityRiskLabel} ({fmtNumber(row.analysis.liquidityRiskScore, 0)})</span>
                                          <span className="rounded bg-accent/15 px-2 py-1 text-accent">Composite: {fmtNumber(row.analysis.compositeScore, 0)}</span>
                                          <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">Model: {row.analysis.model}</span>
                                        </div>
                                        <ul className="list-disc pl-4 text-xs text-slate-300">
                                          {row.analysis.reasoningBullets.map((item, idx) => (
                                            <li key={`${row.ticker}-reason-${idx}`}>{item}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    ) : (
                                      <p className="text-xs text-slate-400">No analysis available.</p>
                                    )}
                                  </div>
                                </div>
                                <div className={DETAIL_PANEL_CLASS}>
                                  <h4 className="mb-2 text-sm font-semibold text-slate-100">Chart</h4>
                                  <TradingViewWidget ticker={row.ticker} compact chartOnly showStatusLine showCorporateEvents initialRange="3M" />
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {sortedRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-3 py-6 text-center text-sm text-slate-400">
                        No valid premarket gappers are available right now.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="card p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-slate-300">
                  Multi-Chart Grid ({sortedRows.length} ticker{sortedRows.length === 1 ? "" : "s"})
                </div>
                <ChartGridPager
                  totalItems={sortedRows.length}
                  page={chartPage}
                  pageSize={CHARTS_PER_PAGE}
                  itemLabel="tickers"
                  onPageChange={setChartPage}
                />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {pagedRows.map((row) => {
                const gridNewsOpen = expandedGridNews.has(row.ticker);
                const news = newsByTicker[row.ticker] ?? [];
                return (
                  <div
                    key={row.ticker}
                    className="rounded-[24px] border border-borderSoft/60 bg-gradient-to-b from-panelSoft/45 to-panel/40 p-4"
                  >
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-lg font-semibold text-accent">{row.ticker}</div>
                        {row.name && row.name !== row.ticker ? (
                          <p className="mt-1 line-clamp-1 text-sm text-slate-400">{row.name}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <span className="rounded-full border border-borderSoft/60 bg-panelSoft/30 px-3 py-1.5 text-xs text-slate-200">
                          <span className="mr-1 uppercase tracking-[0.12em] text-slate-500">Mkt Cap</span>
                          <span className="font-semibold text-slate-100">{fmtCompact(row.marketCap)}</span>
                        </span>
                        <span className="rounded-full border border-borderSoft/60 bg-panelSoft/30 px-3 py-1.5 text-xs text-slate-200">
                          <span className="mr-1 uppercase tracking-[0.12em] text-slate-500">Gap %</span>
                          <span className={`font-semibold ${cellClass(row.gapPct)}`}>{fmtPct(row.gapPct)}</span>
                        </span>
                        <span className="rounded-full border border-borderSoft/60 bg-panelSoft/30 px-3 py-1.5 text-xs text-slate-200">
                          <span className="mr-1 uppercase tracking-[0.12em] text-slate-500">Pre Vol</span>
                          <span className="font-semibold text-slate-100">{fmtCompact(row.premarketVolume)}</span>
                        </span>
                      </div>
                    </div>
                    <div className="rounded-[22px] bg-panelSoft/25 p-2.5">
                      <TradingViewWidget
                        ticker={row.ticker}
                        chartOnly
                        showStatusLine
                        showCorporateEvents
                        fillContainer
                        initialRange="3M"
                        surface="plain"
                      />
                    </div>
                    <div className="mt-4 flex flex-wrap justify-between gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                        onClick={() => toggleGridNews(row.ticker)}
                      >
                        {gridNewsOpen ? "Hide latest news" : "Show latest news"}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                        onClick={() => setActiveChartRow(row)}
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                        Expand chart
                      </button>
                    </div>
                    {gridNewsOpen ? (
                      <div className="mt-4 rounded-[18px] border border-borderSoft/60 bg-panelSoft/25 p-3">
                        <h4 className="mb-2 text-sm font-semibold text-slate-100">Latest News</h4>
                        <GapperNewsList
                          ticker={row.ticker}
                          news={news}
                          isLoading={newsLoadingTicker === row.ticker}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {pagedRows.length === 0 ? (
                <div className="card p-4 text-sm text-slate-300">No valid premarket gappers are available right now.</div>
              ) : null}
            </div>
            <div className="flex justify-end px-1">
              <ChartGridPager
                totalItems={sortedRows.length}
                page={chartPage}
                pageSize={CHARTS_PER_PAGE}
                itemLabel="tickers"
                onPageChange={setChartPage}
              />
            </div>
          </div>
        )}
      </div>

      {activeChartRow ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4" onClick={() => setActiveChartRow(null)}>
          <div
            className="flex h-[calc(100vh-2rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-[30px] border border-borderSoft/75 bg-panel/95 shadow-[0_24px_80px_rgba(2,6,23,0.55)] 2xl:max-w-[140rem]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-borderSoft/60 bg-panelSoft/35 px-5 py-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Expanded Chart</p>
                <h4 className="mt-1 text-base font-semibold text-slate-100">{activeChartRow.ticker}</h4>
                {activeChartRow.name ? <div className="mt-2 text-sm text-slate-400">{activeChartRow.name}</div> : null}
              </div>
              <button
                type="button"
                data-modal-close="true"
                className="inline-flex items-center justify-center rounded-xl border border-borderSoft/70 bg-panelSoft/35 px-3 py-2 text-sm text-slate-200 transition hover:bg-panelSoft/55"
                onClick={() => setActiveChartRow(null)}
              >
                Close
              </button>
            </div>
            <div className="border-b border-borderSoft/50 px-5 py-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Mkt Cap</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">{fmtCompact(activeChartRow.marketCap)}</div>
                </div>
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Gap %</div>
                  <div className={`mt-1 text-sm font-semibold ${cellClass(activeChartRow.gapPct)}`}>{fmtPct(activeChartRow.gapPct)}</div>
                </div>
                <div className="rounded-[18px] border border-borderSoft/60 bg-panelSoft/30 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500">Pre Vol</div>
                  <div className="mt-1 text-sm font-semibold text-slate-100">{fmtCompact(activeChartRow.premarketVolume)}</div>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <div className="rounded-[24px] bg-panelSoft/25 p-3">
                <TradingViewWidget
                  ticker={activeChartRow.ticker}
                  chartOnly
                  showStatusLine
                  showCorporateEvents
                  fillContainer
                  initialRange="3M"
                  surface="plain"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
