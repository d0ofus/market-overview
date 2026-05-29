"use client";

import { useRouter } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, BarChart3, ExternalLink, Info, Loader2, Plus, Search, ShieldCheck, Sparkles } from "lucide-react";
import {
  addAdminPeerGroupMember,
  createAdminPeerGroup,
  createPerplexityBrowserbaseVerificationSession,
  getFundamentalsTrends,
  getPerplexityFinancePeers,
  getPeerDirectory,
  getPeerGroups,
  getPeerTickerDetail,
  getPeerTickerMetrics,
  type FundamentalTrendRow,
  type PerplexityFinancePeerLookup,
  type PeerDirectoryRow,
  type PeerGroupRow,
  type PeerGroupType,
  type PeerMetricRow,
  type PeerTickerDetail,
} from "@/lib/api";
import { FundamentalsModal } from "./fundamentals-modal";
import { FundamentalsTrendStrip } from "./fundamentals-trend-strip";
import { PerplexityComparisonChart } from "./perplexity-comparison-chart";
import { TickerMultiGrid } from "./ticker-multi-grid";
import type { TradingViewComparePosition } from "./tradingview-widget";

type PeerMemberSortKey = "ticker" | "name" | "price" | "marketCap" | "avgVolume";
type MultiChartSortKey = "change1d" | "marketCap";
type LoadTickerOptions = {
  scrollToCharts?: boolean;
  selectGroupId?: string | null;
};
type PerplexityLookupOptions = {
  refresh?: boolean;
};
type PerplexityGroupDraft = {
  name: string;
  slug: string;
  groupType: PeerGroupType;
  description: string;
  priority: string;
  isActive: boolean;
};
type PerplexityPeerStatus = "saved" | "perplexity";
type PerplexityCompareScaleOption = {
  key: TradingViewComparePosition;
  label: string;
};
const MULTI_CHART_SORT_OPTIONS: { key: MultiChartSortKey; label: string }[] = [
  { key: "change1d", label: "1D % Change" },
  { key: "marketCap", label: "Market Capitalization" },
];
const PERPLEXITY_COMPARE_DEFAULT_COUNT = 5;
const PERPLEXITY_COMPARE_SCALE_OPTIONS: PerplexityCompareScaleOption[] = [
  { key: "SameScale", label: "Same % scale" },
  { key: "NewPriceScale", label: "New price scale" },
  { key: "NewPane", label: "New pane" },
];
const PERPLEXITY_COMPARE_BASE_COLOR = "#f97316";
const PERPLEXITY_COMPARE_PALETTE = [
  "#38bdf8",
  "#22c55e",
  "#facc15",
  "#fb7185",
  "#a78bfa",
  "#2dd4bf",
  "#a3e635",
  "#f472b6",
  "#60a5fa",
  "#ef4444",
  "#818cf8",
  "#f59e0b",
  "#10b981",
];
const CORRELATION_DEFAULT_LOOKBACK = "252D";
const CORRELATION_DEFAULT_ROLLING_WINDOW = "60D";
const CORRELATION_LAUNCH_MAX_TICKERS = 10;
const PERPLEXITY_GROUP_DEFAULT_PRIORITY = "100";

function fmtCompact(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function fmtPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function fmtPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function segmentedButtonClass(active: boolean): string {
  return active
    ? "bg-accent/20 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.28)]"
    : "text-slate-300 hover:bg-panelSoft/70 hover:text-slate-100";
}

function perplexityStatusLabel(status: PerplexityFinancePeerLookup["status"]): string | null {
  if (!status) return null;
  if (status === "ready") return "Ready";
  if (status === "partial") return "Partial";
  if (status === "pending_timeout") return "Still generating";
  if (status === "blocked") return "Blocked";
  if (status === "not_found") return "Not found";
  return "Parse error";
}

function perplexityEmptyPeerMessage(lookup: PerplexityFinancePeerLookup): string {
  if (lookup.peersStatus === "pending_timeout") {
    return "Perplexity was still generating the peer list. Refresh can retry without using the cached response.";
  }
  if (lookup.peersStatus === "blocked") {
    return "Perplexity blocked the browser session before peer rows could be read.";
  }
  if (lookup.peersStatus === "not_found") {
    return "Perplexity did not return a peers page for this ticker.";
  }
  return "No Perplexity peer rows were parsed for this ticker.";
}

function formatPerplexityAge(ageSeconds: number | null | undefined): string {
  if (typeof ageSeconds !== "number" || !Number.isFinite(ageSeconds)) return "unknown age";
  if (ageSeconds < 60) return "just now";
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function perplexityCacheLabel(lookup: PerplexityFinancePeerLookup): string {
  if (lookup.cache?.mode === "stale_on_error") return "Showing cached result; refresh failed";
  if (lookup.cache?.mode === "hit") return `Cached ${formatPerplexityAge(lookup.cache.ageSeconds)}`;
  if (lookup.cache?.mode === "refresh") return "Refreshed just now";
  if (lookup.cache?.mode === "miss") return "Live result";
  return "Live result";
}

function buildPerplexityGroupDraft(lookup: PerplexityFinancePeerLookup | null): PerplexityGroupDraft {
  const ticker = lookup?.ticker?.trim().toUpperCase() || "Ticker";
  return {
    name: `${ticker} Perplexity Peers`,
    slug: "",
    groupType: "fundamental",
    description: `Perplexity Finance peer group for ${ticker}.`,
    priority: PERPLEXITY_GROUP_DEFAULT_PRIORITY,
    isActive: true,
  };
}

function buildDefaultPerplexityCompareTickers(lookup: PerplexityFinancePeerLookup | null): string[] {
  if (!lookup) return [];
  return normalizeCorrelationTickers(
    lookup.peers.slice(0, PERPLEXITY_COMPARE_DEFAULT_COUNT).map((peer) => peer.ticker),
  );
}

function parsePriority(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function FieldTooltip({ label, children }: { label: string; children: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-borderSoft/70 text-slate-400 transition hover:border-accent/40 hover:text-accent focus:outline-none focus:ring-1 focus:ring-accent/50"
        aria-label={label}
      >
        <Info className="h-3 w-3" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded border border-borderSoft bg-slate-950 px-3 py-2 text-[11px] leading-5 text-slate-300 opacity-0 shadow-xl transition group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}

function MultiChartPager({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span>Page {page} of {totalPages}</span>
      <button
        className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page === 1}
        type="button"
      >
        Previous
      </button>
      <button
        className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        type="button"
      >
        Next
      </button>
    </div>
  );
}

function normalizeCorrelationTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)));
}

function buildCorrelationLaunchHref(tickers: string[], groupId: string, groupName: string): string {
  const params = new URLSearchParams();
  params.set("tickers", tickers.join(","));
  params.set("lookback", CORRELATION_DEFAULT_LOOKBACK);
  params.set("rollingWindow", CORRELATION_DEFAULT_ROLLING_WINDOW);
  params.set("source", "peer-group");
  params.set("peerGroupId", groupId);
  params.set("peerGroupName", groupName);
  return `/correlation?${params.toString()}`;
}

export function PeerGroupsDashboard() {
  const router = useRouter();
  const searchPanelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const multiChartSectionRef = useRef<HTMLDivElement | null>(null);
  const [groups, setGroups] = useState<PeerGroupRow[]>([]);
  const [directory, setDirectory] = useState<PeerDirectoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState("");
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [detail, setDetail] = useState<PeerTickerDetail | null>(null);
  const [metrics, setMetrics] = useState<PeerMetricRow[]>([]);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [perplexityLookup, setPerplexityLookup] = useState<PerplexityFinancePeerLookup | null>(null);
  const [loadingPerplexity, setLoadingPerplexity] = useState(false);
  const [perplexityError, setPerplexityError] = useState<string | null>(null);
  const [loadingPerplexityVerification, setLoadingPerplexityVerification] = useState(false);
  const [perplexityVerificationError, setPerplexityVerificationError] = useState<string | null>(null);
  const [perplexityVerificationUrl, setPerplexityVerificationUrl] = useState<string | null>(null);
  const [perplexityGroupOpen, setPerplexityGroupOpen] = useState(false);
  const [perplexityGroupDraft, setPerplexityGroupDraft] = useState<PerplexityGroupDraft>(() => buildPerplexityGroupDraft(null));
  const [perplexityGroupSelectedTickers, setPerplexityGroupSelectedTickers] = useState<string[]>([]);
  const [perplexityCompareSelectedTickers, setPerplexityCompareSelectedTickers] = useState<string[]>([]);
  const [perplexityComparePosition, setPerplexityComparePosition] = useState<TradingViewComparePosition>("SameScale");
  const [savingPerplexityGroup, setSavingPerplexityGroup] = useState(false);
  const [perplexityGroupError, setPerplexityGroupError] = useState<string | null>(null);
  const [perplexityGroupMessage, setPerplexityGroupMessage] = useState<string | null>(null);
  const [perplexityGroupCreatedId, setPerplexityGroupCreatedId] = useState<string | null>(null);
  const [activeFundamentalsTicker, setActiveFundamentalsTicker] = useState<string | null>(null);
  const [trendRows, setTrendRows] = useState<FundamentalTrendRow[]>([]);
  const [loadingTrends, setLoadingTrends] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [pendingChartScrollTicker, setPendingChartScrollTicker] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [chartSortKey, setChartSortKey] = useState<MultiChartSortKey>("change1d");
  const [chartsPerPage, setChartsPerPage] = useState(12);
  const [chartPage, setChartPage] = useState(1);
  const [memberSortKey, setMemberSortKey] = useState<PeerMemberSortKey>("ticker");
  const [memberSortDir, setMemberSortDir] = useState<"asc" | "desc">("asc");
  const [correlationPickerState, setCorrelationPickerState] = useState<{
    groupId: string;
    groupName: string;
    tickers: string[];
  } | null>(null);
  const [correlationSelection, setCorrelationSelection] = useState<string[]>([]);
  const [correlationSelectionError, setCorrelationSelectionError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const pageSize = 12;
  const perplexityRequestIdRef = useRef(0);

  useEffect(() => {
    getPeerGroups()
      .then((res) => setGroups(res.rows ?? []))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    setLoadingDirectory(true);
    setDirectoryError(null);
    getPeerDirectory({
      q: deferredQuery,
      groupId: groupFilter || undefined,
      limit: pageSize,
      offset,
    })
      .then((res) => {
        setDirectory(res.rows ?? []);
        setTotal(res.total ?? 0);
      })
      .catch((error) => {
        setDirectory([]);
        setTotal(0);
        setDirectoryError(error instanceof Error ? error.message : "Failed to load peer directory.");
      })
      .finally(() => setLoadingDirectory(false));
  }, [deferredQuery, groupFilter, offset]);

  const loadTicker = async (tickerInput: string, options: LoadTickerOptions = {}) => {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    setSelectedTicker(ticker);
    setPerplexityError(null);
    setPerplexityVerificationError(null);
    setPerplexityLookup((current) => current?.ticker === ticker ? current : null);
    setPendingChartScrollTicker(options.scrollToCharts ? ticker : null);
    setLoadingDetail(true);
    setLoadingMetrics(true);
    setDetailError(null);
    setMetricsError(null);

    const [detailRes, metricsRes] = await Promise.allSettled([
      getPeerTickerDetail(ticker),
      getPeerTickerMetrics(ticker),
    ]);

    if (detailRes.status === "fulfilled") {
      setDetail(detailRes.value);
      setSelectedGroupId((current) => {
        if (options.selectGroupId && detailRes.value.groups.some((group) => group.id === options.selectGroupId)) {
          return options.selectGroupId;
        }
        return current && detailRes.value.groups.some((group) => group.id === current)
          ? current
          : detailRes.value.groups[0]?.id ?? null;
      });
    } else {
      setDetail(null);
      setSelectedGroupId(null);
      setPendingChartScrollTicker(null);
      setDetailError(detailRes.reason instanceof Error ? detailRes.reason.message : "Failed to load peer detail.");
    }

    if (metricsRes.status === "fulfilled") {
      setMetrics(metricsRes.value.rows ?? []);
      setMetricsError(metricsRes.value.error ?? null);
    } else {
      setMetrics([]);
      setMetricsError(metricsRes.reason instanceof Error ? metricsRes.reason.message : "Failed to load runtime metrics.");
    }

    setLoadingDetail(false);
    setLoadingMetrics(false);
  };

  const loadPerplexityLookup = async (tickerInput?: string | null, options: PerplexityLookupOptions = {}) => {
    const ticker = (tickerInput || selectedTicker || query).trim().toUpperCase();
    if (!ticker) return;
    const requestId = perplexityRequestIdRef.current + 1;
    perplexityRequestIdRef.current = requestId;
    setSelectedTicker(ticker);
    setLoadingPerplexity(true);
    setPerplexityError(null);
    setPerplexityVerificationError(null);
    setPerplexityVerificationUrl(null);
    setPerplexityLookup(null);
    try {
      const result = await getPerplexityFinancePeers(ticker, { refresh: options.refresh });
      if (perplexityRequestIdRef.current !== requestId) return;
      setPerplexityLookup(result);
    } catch (error) {
      if (perplexityRequestIdRef.current !== requestId) return;
      setPerplexityError(error instanceof Error ? error.message : "Failed to load Perplexity Finance peers.");
    } finally {
      if (perplexityRequestIdRef.current === requestId) setLoadingPerplexity(false);
    }
  };

  const openPerplexityVerification = async () => {
    setLoadingPerplexityVerification(true);
    setPerplexityVerificationError(null);
    try {
      const session = await createPerplexityBrowserbaseVerificationSession();
      const url = session.debuggerFullscreenUrl || session.debuggerUrl;
      setPerplexityVerificationUrl(url);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setPerplexityVerificationError(error instanceof Error ? error.message : "Failed to create Browserbase verification session.");
    } finally {
      setLoadingPerplexityVerification(false);
    }
  };

  const prefersReducedMotion = useCallback(() => (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ), []);

  const scrollBackToSearch = useCallback(() => {
    searchPanelRef.current?.scrollIntoView({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    window.setTimeout(() => searchInputRef.current?.focus(), prefersReducedMotion() ? 0 : 240);
  }, [prefersReducedMotion]);

  const activeGroup = useMemo(
    () => detail?.groups.find((group) => group.id === selectedGroupId) ?? detail?.groups[0] ?? null,
    [detail, selectedGroupId],
  );
  const metricsByTicker = useMemo(() => new Map(metrics.map((row) => [row.ticker.toUpperCase(), row])), [metrics]);
  const sortedMemberRows = useMemo(() => {
    if (!detail || !activeGroup) return [];
    const rows = Array.from(new Set([detail.symbol.ticker, ...activeGroup.members.map((member) => member.ticker)])).map((ticker) => {
      const member = activeGroup.members.find((row) => row.ticker === ticker);
      const metric = metricsByTicker.get(ticker);
      return {
        ticker,
        name: member?.name ?? (ticker === detail.symbol.ticker ? detail.symbol.name : null),
        metric,
      };
    });
    rows.sort((a, b) => {
      const getValue = (row: typeof rows[number]) => {
        if (memberSortKey === "ticker") return row.ticker;
        if (memberSortKey === "name") return row.name ?? row.ticker;
        if (memberSortKey === "price") return row.metric?.price ?? Number.NEGATIVE_INFINITY;
        if (memberSortKey === "marketCap") return row.metric?.marketCap ?? Number.NEGATIVE_INFINITY;
        return row.metric?.avgVolume ?? Number.NEGATIVE_INFINITY;
      };
      const left = getValue(a);
      const right = getValue(b);
      if (typeof left === "string" || typeof right === "string") {
        const comparison = String(left).localeCompare(String(right));
        return memberSortDir === "asc" ? comparison : -comparison;
      }
      const comparison = left - right;
      return memberSortDir === "asc" ? comparison : -comparison;
    });
    return rows;
  }, [activeGroup, detail, memberSortDir, memberSortKey, metricsByTicker]);
  const savedGroupTickerSet = useMemo(
    () => new Set(sortedMemberRows.map((row) => row.ticker.toUpperCase())),
    [sortedMemberRows],
  );
  const perplexityPeerRows = useMemo(() => {
    if (!perplexityLookup) return [];
    return perplexityLookup.peers.map((peer) => ({
      ...peer,
      status: (savedGroupTickerSet.has(peer.ticker.toUpperCase()) ? "saved" : "perplexity") as PerplexityPeerStatus,
    }));
  }, [perplexityLookup, savedGroupTickerSet]);
  const perplexityPeerTickerKey = useMemo(
    () => perplexityLookup?.peers.map((peer) => peer.ticker.toUpperCase()).join(",") ?? "",
    [perplexityLookup],
  );
  const perplexityGroupSelectedTickerSet = useMemo(
    () => new Set(perplexityGroupSelectedTickers),
    [perplexityGroupSelectedTickers],
  );
  const perplexityCompareSelectedTickerSet = useMemo(
    () => new Set(perplexityCompareSelectedTickers),
    [perplexityCompareSelectedTickers],
  );
  const defaultPerplexityCompareTickers = useMemo(
    () => buildDefaultPerplexityCompareTickers(perplexityLookup),
    [perplexityLookup, perplexityPeerTickerKey],
  );
  const validPerplexityCompareTickers = useMemo(() => {
    const availableTickers = new Set(perplexityPeerRows.map((peer) => peer.ticker.toUpperCase()));
    return perplexityCompareSelectedTickers.filter((ticker) => availableTickers.has(ticker));
  }, [perplexityCompareSelectedTickers, perplexityPeerRows]);
  const perplexityCompareColorByTicker = useMemo(() => {
    const colors = new Map<string, string>();
    perplexityPeerRows.forEach((peer, index) => {
      colors.set(peer.ticker.toUpperCase(), PERPLEXITY_COMPARE_PALETTE[index % PERPLEXITY_COMPARE_PALETTE.length]);
    });
    return colors;
  }, [perplexityPeerRows]);
  const perplexityCompareLegendItems = useMemo(
    () => [
      ...(perplexityLookup ? [{
        ticker: perplexityLookup.ticker.toUpperCase(),
        label: "Base",
        color: PERPLEXITY_COMPARE_BASE_COLOR,
      }] : []),
      ...validPerplexityCompareTickers.map((ticker) => ({
        ticker,
        label: "Peer",
        color: perplexityCompareColorByTicker.get(ticker) ?? PERPLEXITY_COMPARE_PALETTE[0],
      })),
    ],
    [perplexityCompareColorByTicker, perplexityLookup, validPerplexityCompareTickers],
  );
  const savedOnlyPeerRows = useMemo(() => {
    if (!perplexityLookup || !detail || !activeGroup) return [];
    const perplexityTickers = new Set(perplexityLookup.peers.map((peer) => peer.ticker.toUpperCase()));
    return sortedMemberRows.filter((row) => (
      row.ticker.toUpperCase() !== detail.symbol.ticker.toUpperCase()
      && !perplexityTickers.has(row.ticker.toUpperCase())
    ));
  }, [activeGroup, detail, perplexityLookup, sortedMemberRows]);
  const canOpenPerplexityVerification = Boolean(
    perplexityLookup?.browserbaseConfigured
    && (perplexityLookup.status === "blocked" || perplexityLookup.profileStatus === "blocked" || perplexityLookup.peersStatus === "blocked"),
  );
  const allPerplexityPeersSelected = perplexityPeerRows.length > 0
    && perplexityPeerRows.every((peer) => perplexityGroupSelectedTickerSet.has(peer.ticker.toUpperCase()));
  const allPerplexityCompareTickersSelected = perplexityPeerRows.length > 0
    && perplexityPeerRows.every((peer) => perplexityCompareSelectedTickerSet.has(peer.ticker.toUpperCase()));
  const chartMemberRows = useMemo(() => {
    if (!detail || !activeGroup) return [];
    const ordered = [...sortedMemberRows].sort((a, b) => {
      const left = chartSortKey === "change1d"
        ? a.metric?.change1d ?? Number.NEGATIVE_INFINITY
        : a.metric?.marketCap ?? Number.NEGATIVE_INFINITY;
      const right = chartSortKey === "change1d"
        ? b.metric?.change1d ?? Number.NEGATIVE_INFINITY
        : b.metric?.marketCap ?? Number.NEGATIVE_INFINITY;
      if (right !== left) return right - left;
      return a.ticker.localeCompare(b.ticker);
    });
    const startIndex = (chartPage - 1) * chartsPerPage;
    return ordered.slice(startIndex, startIndex + chartsPerPage);
  }, [activeGroup, chartPage, chartSortKey, chartsPerPage, detail, sortedMemberRows]);
  const visibleChartTickerKey = useMemo(() => (
    chartMemberRows.map((row) => row.ticker).join(",")
  ), [chartMemberRows]);
  const trendRowsByTicker = useMemo(
    () => new Map(trendRows.map((row) => [row.ticker.toUpperCase(), row])),
    [trendRows],
  );
  const chartItems = useMemo(() => {
    return chartMemberRows.map(({ ticker, name, metric }) => {
      const change1d = metric?.change1d ?? null;
      const trendRow = trendRowsByTicker.get(ticker.toUpperCase());
      return {
        key: ticker,
        ticker,
        title: ticker,
        subtitle: name,
        headerAction: (
          <button
            type="button"
            aria-label={`Open fundamentals for ${ticker}`}
            title={`Open fundamentals for ${ticker}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-borderSoft/70 bg-panelSoft/35 text-slate-300 transition hover:border-accent/40 hover:bg-accent/10 hover:text-accent"
            onClick={(event) => {
              event.stopPropagation();
              setActiveFundamentalsTicker(ticker);
            }}
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </button>
        ),
        headerDetail: (
          <div className="grid min-w-0 grid-cols-3 gap-x-2 text-right">
            <div className="min-w-0">
              <div className="whitespace-nowrap text-xs text-slate-400">1D</div>
              <div className={`mt-0.5 truncate text-sm font-semibold ${change1d != null && change1d < 0 ? "text-neg" : "text-pos"}`}>
                {fmtPct(change1d)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="whitespace-nowrap text-xs text-slate-400">Mkt Cap</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-slate-200">{fmtCompact(metric?.marketCap)}</div>
            </div>
            <div className="min-w-0">
              <div className="whitespace-nowrap text-xs text-slate-400">Avg Vol</div>
              <div className="mt-0.5 truncate text-sm font-semibold text-slate-200">{fmtCompact(metric?.avgVolume)}</div>
            </div>
          </div>
        ),
        detail: (
          <FundamentalsTrendStrip
            row={trendRow}
            loading={loadingTrends}
            error={trendError}
          />
        ),
      };
    });
  }, [chartMemberRows, loadingTrends, trendError, trendRowsByTicker]);
  const totalChartPages = useMemo(
    () => Math.max(1, Math.ceil(sortedMemberRows.length / chartsPerPage)),
    [chartsPerPage, sortedMemberRows.length],
  );
  const correlationLaunchTickers = useMemo(
    () => normalizeCorrelationTickers(sortedMemberRows.map((row) => row.ticker)),
    [sortedMemberRows],
  );
  const recommendedCorrelationTickers = useMemo(
    () => correlationLaunchTickers.slice(0, CORRELATION_LAUNCH_MAX_TICKERS),
    [correlationLaunchTickers],
  );
  const canLaunchCorrelation = !!activeGroup && correlationLaunchTickers.length >= 2;

  useEffect(() => {
    const tickers = visibleChartTickerKey ? visibleChartTickerKey.split(",").filter(Boolean) : [];
    if (!detail || tickers.length === 0) {
      setTrendRows([]);
      setTrendError(null);
      setLoadingTrends(false);
      return;
    }

    let cancelled = false;
    setLoadingTrends(true);
    setTrendError(null);
    getFundamentalsTrends(tickers, 8)
      .then((response) => {
        if (cancelled) return;
        setTrendRows(response.rows ?? []);
        setTrendError(response.warning ?? (!response.schemaReady ? "Fundamentals cache is not ready." : null));
      })
      .catch((error) => {
        if (cancelled) return;
        setTrendRows([]);
        setTrendError(error instanceof Error ? error.message : "Failed to load fundamentals trends.");
      })
      .finally(() => {
        if (!cancelled) setLoadingTrends(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeGroup?.id, detail, visibleChartTickerKey]);

  useEffect(() => {
    setChartPage(1);
  }, [activeGroup?.id, chartSortKey, chartsPerPage]);

  useEffect(() => {
    if (chartPage <= totalChartPages) return;
    setChartPage(totalChartPages);
  }, [chartPage, totalChartPages]);

  useEffect(() => {
    setCorrelationPickerState(null);
    setCorrelationSelection([]);
    setCorrelationSelectionError(null);
  }, [activeGroup?.id, detail?.symbol.ticker]);

  useEffect(() => {
    if (!perplexityLookup) {
      setPerplexityGroupOpen(false);
      setPerplexityGroupDraft(buildPerplexityGroupDraft(null));
      setPerplexityGroupSelectedTickers([]);
      setPerplexityCompareSelectedTickers([]);
      setPerplexityGroupError(null);
      setPerplexityGroupMessage(null);
      setPerplexityGroupCreatedId(null);
      return;
    }

    setPerplexityGroupDraft(buildPerplexityGroupDraft(perplexityLookup));
    setPerplexityGroupSelectedTickers(normalizeCorrelationTickers(
      perplexityLookup.peers.map((peer) => peer.ticker),
    ));
    setPerplexityCompareSelectedTickers(buildDefaultPerplexityCompareTickers(perplexityLookup));
    setPerplexityGroupError(null);
    setPerplexityGroupMessage(null);
    setPerplexityGroupCreatedId(null);
  }, [perplexityLookup, perplexityPeerTickerKey]);

  useEffect(() => {
    if (!pendingChartScrollTicker || loadingDetail || !detail) return;
    if (detail.symbol.ticker !== pendingChartScrollTicker) return;
    const target = multiChartSectionRef.current;
    if (!target) return;
    const animationFrame = window.requestAnimationFrame(() => {
      target.scrollIntoView({
        block: "start",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      setPendingChartScrollTicker(null);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [detail, loadingDetail, pendingChartScrollTicker, prefersReducedMotion]);

  const onMemberSort = (key: PeerMemberSortKey) => {
    if (memberSortKey === key) {
      setMemberSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setMemberSortKey(key);
    setMemberSortDir(key === "ticker" || key === "name" ? "asc" : "desc");
  };

  const launchCorrelation = (tickers: string[], groupId: string, groupName: string) => {
    const normalizedTickers = normalizeCorrelationTickers(tickers);
    if (normalizedTickers.length < 2) return;
    router.push(buildCorrelationLaunchHref(normalizedTickers, groupId, groupName));
  };

  const openCorrelationPicker = () => {
    if (!activeGroup) return;
    if (correlationLaunchTickers.length <= CORRELATION_LAUNCH_MAX_TICKERS) {
      launchCorrelation(correlationLaunchTickers, activeGroup.id, activeGroup.name);
      return;
    }
    setCorrelationPickerState({
      groupId: activeGroup.id,
      groupName: activeGroup.name,
      tickers: correlationLaunchTickers,
    });
    setCorrelationSelection(recommendedCorrelationTickers);
    setCorrelationSelectionError(null);
  };

  const toggleCorrelationSelection = (ticker: string) => {
    setCorrelationSelectionError(null);
    setCorrelationSelection((current) => {
      if (current.includes(ticker)) {
        return current.filter((value) => value !== ticker);
      }
      if (current.length >= CORRELATION_LAUNCH_MAX_TICKERS) {
        setCorrelationSelectionError(`Select up to ${CORRELATION_LAUNCH_MAX_TICKERS} tickers for a correlation run.`);
        return current;
      }
      return [...current, ticker];
    });
  };

  const submitCorrelationPicker = () => {
    if (!correlationPickerState) return;
    const normalizedSelection = correlationPickerState.tickers.filter((ticker) => correlationSelection.includes(ticker));
    if (normalizedSelection.length < 2) {
      setCorrelationSelectionError("Select at least 2 tickers to run correlation.");
      return;
    }
    launchCorrelation(normalizedSelection, correlationPickerState.groupId, correlationPickerState.groupName);
  };

  const togglePerplexityGroupTicker = (ticker: string) => {
    const normalized = ticker.trim().toUpperCase();
    if (!normalized || savingPerplexityGroup) return;
    setPerplexityGroupSelectedTickers((current) => (
      current.includes(normalized)
        ? current.filter((value) => value !== normalized)
        : [...current, normalized]
    ));
    setPerplexityGroupError(null);
    setPerplexityGroupMessage(null);
  };

  const selectAllPerplexityGroupTickers = () => {
    setPerplexityGroupSelectedTickers(normalizeCorrelationTickers(perplexityPeerRows.map((peer) => peer.ticker)));
    setPerplexityGroupError(null);
    setPerplexityGroupMessage(null);
  };

  const clearPerplexityGroupTickers = () => {
    setPerplexityGroupSelectedTickers([]);
    setPerplexityGroupError(null);
    setPerplexityGroupMessage(null);
  };

  const togglePerplexityCompareTicker = (ticker: string) => {
    const normalized = ticker.trim().toUpperCase();
    if (!normalized) return;
    setPerplexityCompareSelectedTickers((current) => (
      current.includes(normalized)
        ? current.filter((value) => value !== normalized)
        : [...current, normalized]
    ));
  };

  const selectAllPerplexityCompareTickers = () => {
    setPerplexityCompareSelectedTickers(normalizeCorrelationTickers(perplexityPeerRows.map((peer) => peer.ticker)));
  };

  const clearPerplexityCompareTickers = () => {
    setPerplexityCompareSelectedTickers([]);
  };

  const resetPerplexityCompareTickers = () => {
    setPerplexityCompareSelectedTickers(defaultPerplexityCompareTickers);
  };

  const savePerplexityGroup = async () => {
    if (!perplexityLookup || savingPerplexityGroup) return;
    const name = perplexityGroupDraft.name.trim();
    if (!name) {
      setPerplexityGroupError("Group name is required.");
      return;
    }

    const rootTicker = perplexityLookup.ticker.trim().toUpperCase();
    const selectedPeers = normalizeCorrelationTickers(perplexityGroupSelectedTickers)
      .filter((ticker) => ticker !== rootTicker);
    const tickersToAdd = normalizeCorrelationTickers([rootTicker, ...selectedPeers]);

    setSavingPerplexityGroup(true);
    setPerplexityGroupError(null);
    setPerplexityGroupMessage(null);
    try {
      let groupId = perplexityGroupCreatedId;
      if (!groupId) {
        const created = await createAdminPeerGroup({
          name,
          slug: perplexityGroupDraft.slug.trim() || null,
          groupType: perplexityGroupDraft.groupType,
          description: perplexityGroupDraft.description.trim() || null,
          priority: parsePriority(perplexityGroupDraft.priority),
          isActive: perplexityGroupDraft.isActive,
        });
        groupId = created.id;
        setPerplexityGroupCreatedId(created.id);
      }

      const addedTickers: string[] = [];
      const failedTickers: string[] = [];
      for (const ticker of tickersToAdd) {
        try {
          await addAdminPeerGroupMember(groupId, { ticker, source: "manual", confidence: 1 });
          addedTickers.push(ticker);
        } catch {
          failedTickers.push(ticker);
        }
      }

      const nextGroups = await getPeerGroups();
      setGroups(nextGroups.rows ?? []);
      if (rootTicker) {
        await loadTicker(rootTicker, { selectGroupId: groupId });
      }

      const failedPeers = failedTickers.filter((ticker) => ticker !== rootTicker);
      setPerplexityGroupSelectedTickers(failedPeers);
      setPerplexityGroupMessage([
        `Created ${name}`,
        `added ${addedTickers.length} ticker${addedTickers.length === 1 ? "" : "s"}`,
        failedTickers.length ? `${failedTickers.length} failed` : null,
      ].filter(Boolean).join("; ") + ".");
      if (failedTickers.length === 0) {
        setPerplexityGroupOpen(false);
        setPerplexityGroupCreatedId(null);
      }
    } catch (error) {
      setPerplexityGroupError(error instanceof Error ? error.message : "Failed to create Perplexity peer group.");
    } finally {
      setSavingPerplexityGroup(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="card scroll-mt-4 p-3" ref={searchPanelRef}>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),14rem,auto]">
          <label className="text-xs text-slate-300">
            Search ticker or company
            <div className="mt-1 flex items-center rounded border border-borderSoft bg-panelSoft px-2">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                ref={searchInputRef}
                className="w-full bg-transparent px-2 py-2 text-sm outline-none"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadTicker(query);
                }}
                placeholder="AAPL or Apple"
              />
            </div>
          </label>
          <label className="text-xs text-slate-300">
            Filter by peer group
            <select
              className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm"
              value={groupFilter}
              onChange={(event) => {
                setGroupFilter(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All Groups</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <button
              className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent"
              onClick={() => void loadTicker(query)}
              disabled={!query.trim()}
              type="button"
            >
              Analyze
            </button>
            <button
              className="inline-flex items-center gap-2 rounded border border-violet-300/40 bg-violet-400/10 px-3 py-2 text-sm font-medium text-violet-200 transition hover:bg-violet-400/15 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void loadPerplexityLookup(query || selectedTicker)}
              disabled={loadingPerplexity || !(query.trim() || selectedTicker)}
              type="button"
            >
              {loadingPerplexity ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Perplexity
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">
          {loadingDirectory ? "Loading directory..." : `${directory.length} rows shown of ${total} matching tickers`}
        </div>
        {directoryError && <p className="mt-2 text-sm text-red-300">{directoryError}</p>}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(28rem,36rem),minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-900/60">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                    Ticker Search Results
                  </th>
                </tr>
              </thead>
              <tbody>
                {directory.map((row) => (
                  <tr
                    key={row.ticker}
                    className={`cursor-pointer border-t border-borderSoft/60 ${selectedTicker === row.ticker ? "bg-accent/10" : "hover:bg-slate-900/30"}`}
                    onClick={() => void loadTicker(row.ticker, { scrollToCharts: true })}
                  >
                    <td className="px-3 py-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-accent">{row.ticker}</div>
                        <div className="mt-0.5 truncate text-xs text-slate-300">{row.name ?? "-"}</div>
                        <div className="mt-1 truncate text-[11px] text-slate-500">
                          {[row.sector, row.industry].filter(Boolean).join(" / ") || "Sector unavailable"}
                        </div>
                        <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                          {row.groups.length > 0 ? row.groups.slice(0, 3).map((group) => (
                            <span
                              key={`${row.ticker}-${group.id}`}
                              className="max-w-full truncate rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300"
                              title={group.name}
                            >
                              {group.name}
                            </span>
                          )) : <span className="text-[11px] text-slate-500">No groups</span>}
                          {row.groups.length > 3 ? (
                            <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-400">
                              +{row.groups.length - 3}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loadingDirectory && directory.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-sm text-slate-400">
                      No peer-group tickers matched the current search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-borderSoft/60 px-3 py-2 text-xs text-slate-400">
            <span>Page {(offset / pageSize) + 1}</span>
            <div className="flex gap-2">
              <button
                className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
                onClick={() => setOffset((current) => Math.max(0, current - pageSize))}
                disabled={offset === 0}
              >
                Previous
              </button>
              <button
                className="rounded border border-borderSoft px-2 py-1 disabled:opacity-40"
                onClick={() => setOffset((current) => current + pageSize)}
                disabled={offset + pageSize >= total}
              >
                Next
              </button>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="card p-3">
            {loadingDetail ? (
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading peer detail...
              </div>
            ) : detail ? (
              <div className="space-y-3">
                <div>
                  <div className="text-lg font-semibold text-accent">{detail.symbol.ticker}</div>
                  <div className="text-sm text-slate-300">{detail.symbol.name ?? "-"}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {detail.symbol.exchange ?? "-"} • {detail.symbol.sector ?? "-"} • {detail.symbol.industry ?? "-"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.groups.map((group) => (
                    <button
                      key={group.id}
                      className={`rounded px-3 py-1.5 text-xs ${activeGroup?.id === group.id ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300"}`}
                      onClick={() => setSelectedGroupId(group.id)}
                    >
                      {group.name}
                    </button>
                  ))}
                  {detail.groups.length === 0 && <span className="text-xs text-slate-500">Ticker is not assigned to any peer group.</span>}
                </div>
                {detailError && <p className="text-sm text-red-300">{detailError}</p>}
              </div>
            ) : (
              <p className="text-sm text-slate-400">Search or select a ticker to load peer analysis.</p>
            )}
          </div>

          {(loadingPerplexity || perplexityLookup || perplexityError) && (
            <div className="card p-3">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                    <Sparkles className="h-4 w-4 text-accent" />
                    Perplexity Finance
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    Dashboard lookup results stay unchanged until you save a new group.
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {perplexityLookup && perplexityPeerRows.length > 0 ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-2 py-1 text-xs text-accent transition hover:bg-accent/25 disabled:opacity-50"
                      onClick={() => {
                        setPerplexityGroupOpen((current) => !current);
                        setPerplexityGroupError(null);
                      }}
                      disabled={savingPerplexityGroup}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create Group
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800/60 disabled:opacity-50"
                    onClick={() => void loadPerplexityLookup(perplexityLookup?.ticker || selectedTicker || query, { refresh: true })}
                    disabled={loadingPerplexity || !(perplexityLookup?.ticker || selectedTicker || query.trim())}
                  >
                    Refresh live
                  </button>
                </div>
              </div>

              {loadingPerplexity ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading Perplexity Finance dashboard...
                </div>
              ) : null}

              {perplexityError ? <p className="text-sm text-red-300">{perplexityError}</p> : null}

              {perplexityLookup ? (
                <div className="space-y-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-semibold text-accent">{perplexityLookup.ticker}</span>
                      {perplexityLookup.company.name ? (
                        <span className="text-sm text-slate-300">{perplexityLookup.company.name}</span>
                      ) : null}
                      {perplexityStatusLabel(perplexityLookup.status) ? (
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                          {perplexityStatusLabel(perplexityLookup.status)}
                        </span>
                      ) : null}
                      <span className={`rounded px-2 py-0.5 text-[11px] ${
                        perplexityLookup.cache?.mode === "stale_on_error"
                          ? "bg-yellow-300/10 text-yellow-100"
                          : perplexityLookup.cache?.mode === "hit"
                            ? "bg-emerald-400/10 text-emerald-200"
                            : "bg-sky-400/10 text-sky-200"
                      }`}
                      >
                        {perplexityCacheLabel(perplexityLookup)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      {[
                        perplexityLookup.company.exchange,
                        perplexityLookup.company.sector,
                        perplexityLookup.company.industry,
                      ].filter(Boolean).join(" / ") || "Company metadata unavailable"}
                    </div>
                  </div>

                  {perplexityLookup.company.description ? (
                    <p className="max-h-56 overflow-auto rounded border border-borderSoft/70 bg-panelSoft/35 p-3 text-sm leading-6 text-slate-300">
                      {perplexityLookup.company.description}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-2 text-xs">
                    <a
                      href={perplexityLookup.peersUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-slate-300 transition hover:border-accent/40 hover:text-accent"
                    >
                      Peers page <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href={perplexityLookup.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-slate-300 transition hover:border-accent/40 hover:text-accent"
                    >
                      Profile page <ExternalLink className="h-3 w-3" />
                    </a>
                    {perplexityLookup.provider ? (
                      <span className="inline-flex items-center rounded border border-borderSoft px-2 py-1 text-slate-400">
                        {perplexityLookup.provider === "browserbase" ? "Browserbase" : "Local Chromium"}
                      </span>
                    ) : null}
                  </div>

                  {canOpenPerplexityVerification ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-2 py-1 text-accent transition hover:bg-accent/25 disabled:opacity-50"
                        onClick={() => void openPerplexityVerification()}
                        disabled={loadingPerplexityVerification}
                      >
                        {loadingPerplexityVerification ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        )}
                        Verify session
                      </button>
                      {perplexityVerificationUrl ? (
                        <a
                          href={perplexityVerificationUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-slate-300 transition hover:border-accent/40 hover:text-accent"
                        >
                          Live View <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  {perplexityVerificationError ? (
                    <p className="text-xs text-red-300">{perplexityVerificationError}</p>
                  ) : null}

                  {perplexityLookup.warning ? (
                    <p className="rounded border border-yellow-300/20 bg-yellow-300/10 px-3 py-2 text-xs text-yellow-100">
                      {perplexityLookup.warning}
                    </p>
                  ) : null}

                  {perplexityGroupMessage ? (
                    <p className="rounded border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-100">
                      {perplexityGroupMessage}
                    </p>
                  ) : null}

                  {perplexityPeerRows.length > 0 ? (
                    <div className="rounded border border-borderSoft/70 bg-panelSoft/20 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-100">Chart Comparison</h3>
                          <p className="mt-1 text-xs text-slate-400">
                            Base {perplexityLookup.ticker}; comparing {validPerplexityCompareTickers.length} peer{validPerplexityCompareTickers.length === 1 ? "" : "s"}.
                          </p>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            className="rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800/60 disabled:opacity-50"
                            onClick={selectAllPerplexityCompareTickers}
                            disabled={allPerplexityCompareTickersSelected}
                          >
                            Select All
                          </button>
                          <button
                            type="button"
                            className="rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800/60 disabled:opacity-50"
                            onClick={resetPerplexityCompareTickers}
                            disabled={defaultPerplexityCompareTickers.length === validPerplexityCompareTickers.length
                              && defaultPerplexityCompareTickers.every((ticker) => perplexityCompareSelectedTickerSet.has(ticker))}
                          >
                            Reset
                          </button>
                          <button
                            type="button"
                            className="rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800/60 disabled:opacity-50"
                            onClick={clearPerplexityCompareTickers}
                            disabled={validPerplexityCompareTickers.length === 0}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                        <span className="text-slate-400">Scale</span>
                        <div className="inline-flex rounded border border-borderSoft bg-slate-950/35 p-0.5" role="group" aria-label="Perplexity comparison scale">
                          {PERPLEXITY_COMPARE_SCALE_OPTIONS.map((option) => (
                            <button
                              key={option.key}
                              type="button"
                              aria-pressed={perplexityComparePosition === option.key}
                              className={`rounded px-2.5 py-1 transition ${segmentedButtonClass(perplexityComparePosition === option.key)}`}
                              onClick={() => setPerplexityComparePosition(option.key)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2" aria-label="Chart comparison colors">
                        {perplexityCompareLegendItems.map((item) => (
                          <span
                            key={`perplexity-compare-legend-${item.ticker}`}
                            className="inline-flex max-w-[10rem] items-center gap-1.5 rounded border border-borderSoft/70 bg-slate-950/35 px-2 py-1 text-[11px] text-slate-300"
                            title={`${item.ticker} ${item.label}`}
                          >
                            <span
                              aria-hidden="true"
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: item.color, boxShadow: `0 0 0 1px ${item.color}66` }}
                            />
                            <span className="truncate font-semibold text-slate-100">{item.ticker}</span>
                            <span className="text-slate-500">{item.label}</span>
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 h-[28rem] min-h-[22rem] overflow-hidden rounded border border-borderSoft/70 bg-slate-950/20">
                        <PerplexityComparisonChart
                          items={perplexityCompareLegendItems}
                          mode={perplexityComparePosition}
                        />
                      </div>
                    </div>
                  ) : null}

                  {perplexityGroupOpen ? (
                    <div className="space-y-3 rounded border border-accent/25 bg-slate-950/35 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-100">Create Peer Group</h3>
                          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-slate-300">
                            <span className="rounded border border-accent/30 bg-accent/10 px-2 py-1 font-semibold text-accent">
                              {perplexityLookup.ticker} included
                            </span>
                            <span className="rounded border border-borderSoft/70 bg-panelSoft/50 px-2 py-1">
                              {perplexityGroupSelectedTickers.length} peer{perplexityGroupSelectedTickers.length === 1 ? "" : "s"} selected
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800/60"
                          onClick={() => setPerplexityGroupOpen(false)}
                          disabled={savingPerplexityGroup}
                        >
                          Close
                        </button>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="block text-xs text-slate-300">
                          <span>Name</span>
                          <input
                            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                            value={perplexityGroupDraft.name}
                            onChange={(event) => setPerplexityGroupDraft((current) => ({ ...current, name: event.target.value }))}
                          />
                        </label>
                        <label className="block text-xs text-slate-300">
                          <span className="inline-flex items-center gap-1">
                            Slug
                            <FieldTooltip label="What peer group slug means">
                              Slug is the unique durable identifier for this group. Leave it blank to generate one from the name.
                            </FieldTooltip>
                          </span>
                          <input
                            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                            value={perplexityGroupDraft.slug}
                            onChange={(event) => setPerplexityGroupDraft((current) => ({ ...current, slug: event.target.value }))}
                            placeholder="auto from name"
                          />
                        </label>
                        <label className="block text-xs text-slate-300">
                          <span>Group Type</span>
                          <select
                            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                            value={perplexityGroupDraft.groupType}
                            onChange={(event) => setPerplexityGroupDraft((current) => ({ ...current, groupType: event.target.value as PeerGroupType }))}
                          >
                            <option value="fundamental">fundamental</option>
                            <option value="technical">technical</option>
                            <option value="custom">custom</option>
                          </select>
                        </label>
                        <label className="block text-xs text-slate-300">
                          <span>Priority</span>
                          <input
                            className="mt-1 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                            value={perplexityGroupDraft.priority}
                            onChange={(event) => setPerplexityGroupDraft((current) => ({ ...current, priority: event.target.value }))}
                            inputMode="numeric"
                          />
                        </label>
                        <label className="block text-xs text-slate-300 md:col-span-2">
                          <span>Description</span>
                          <textarea
                            className="mt-1 min-h-16 w-full rounded border border-borderSoft bg-panelSoft px-2 py-1.5 text-sm"
                            value={perplexityGroupDraft.description}
                            onChange={(event) => setPerplexityGroupDraft((current) => ({ ...current, description: event.target.value }))}
                          />
                        </label>
                        <div className="text-xs text-slate-300">
                          <span className="inline-flex items-center gap-1">
                            Active
                            <FieldTooltip label="What active peer group means">
                              Active groups appear in normal peer-group lists. Inactive groups stay saved for admin use but are hidden from the default group list.
                            </FieldTooltip>
                          </span>
                          <label className="mt-2 inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-borderSoft bg-panelSoft"
                              checked={perplexityGroupDraft.isActive}
                              onChange={(event) => setPerplexityGroupDraft((current) => ({ ...current, isActive: event.target.checked }))}
                            />
                            Enabled
                          </label>
                        </div>
                      </div>

                      <div className="rounded border border-borderSoft/70 bg-panelSoft/20">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-borderSoft/70 px-3 py-2">
                          <div className="text-xs font-semibold text-slate-200">Perplexity Peer Selection</div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800/60 disabled:opacity-50"
                              onClick={selectAllPerplexityGroupTickers}
                              disabled={allPerplexityPeersSelected || savingPerplexityGroup}
                            >
                              Select All
                            </button>
                            <button
                              type="button"
                              className="rounded border border-borderSoft px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800/60 disabled:opacity-50"
                              onClick={clearPerplexityGroupTickers}
                              disabled={perplexityGroupSelectedTickers.length === 0 || savingPerplexityGroup}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div className="max-h-56 overflow-auto">
                          <table className="min-w-full text-xs">
                            <thead className="bg-slate-900/60">
                              <tr>
                                <th className="px-2 py-1.5 text-left text-slate-300">Use</th>
                                <th className="px-2 py-1.5 text-left text-slate-300">Ticker</th>
                                <th className="px-2 py-1.5 text-left text-slate-300">Company</th>
                                <th className="px-2 py-1.5 text-left text-slate-300">Overlap</th>
                              </tr>
                            </thead>
                            <tbody>
                              {perplexityPeerRows.map((peer) => {
                                const ticker = peer.ticker.toUpperCase();
                                const checked = perplexityGroupSelectedTickerSet.has(ticker);
                                return (
                                  <tr key={`perplexity-create-${ticker}`} className="border-t border-borderSoft/60">
                                    <td className="px-2 py-1.5">
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-borderSoft bg-panelSoft"
                                        checked={checked}
                                        disabled={savingPerplexityGroup}
                                        onChange={() => togglePerplexityGroupTicker(ticker)}
                                      />
                                    </td>
                                    <td className="px-2 py-1.5 font-semibold text-accent">{ticker}</td>
                                    <td className="px-2 py-1.5 text-slate-300">{peer.name ?? peer.exchange ?? "-"}</td>
                                    <td className="px-2 py-1.5">
                                      <span className={`rounded px-2 py-0.5 ${peer.status === "saved" ? "bg-emerald-400/10 text-emerald-200" : "bg-slate-800 text-slate-300"}`}>
                                        {peer.status === "saved" ? "Already saved" : "Perplexity only"}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {perplexityGroupError ? (
                        <p className="text-xs text-red-300">{perplexityGroupError}</p>
                      ) : null}

                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          className="rounded border border-borderSoft px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800/60"
                          onClick={() => setPerplexityGroupOpen(false)}
                          disabled={savingPerplexityGroup}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => void savePerplexityGroup()}
                          disabled={savingPerplexityGroup || !perplexityGroupDraft.name.trim()}
                        >
                          {savingPerplexityGroup ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                          Save Group
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-slate-200">Perplexity Peers</h3>
                      <span className="text-xs text-slate-400">{perplexityPeerRows.length} parsed</span>
                    </div>
                    {perplexityPeerRows.length > 0 ? (
                      <div className="max-h-72 overflow-auto rounded border border-borderSoft/70">
                        <table className="min-w-full text-xs">
                          <thead className="bg-slate-900/60">
                            <tr>
                              <th className="px-2 py-1.5 text-left text-slate-300">Compare</th>
                              <th className="px-2 py-1.5 text-left text-slate-300">Ticker</th>
                              <th className="px-2 py-1.5 text-left text-slate-300">Company</th>
                              <th className="px-2 py-1.5 text-left text-slate-300">Overlap</th>
                            </tr>
                          </thead>
                          <tbody>
                            {perplexityPeerRows.map((peer) => {
                              const ticker = peer.ticker.toUpperCase();
                              const color = perplexityCompareColorByTicker.get(ticker) ?? PERPLEXITY_COMPARE_PALETTE[0];
                              return (
                                <tr key={`perplexity-${peer.ticker}`} className="border-t border-borderSoft/60">
                                  <td className="px-2 py-1.5">
                                    <input
                                      type="checkbox"
                                      aria-label={`Compare ${ticker}`}
                                      className="h-4 w-4 rounded border-borderSoft bg-panelSoft"
                                      checked={perplexityCompareSelectedTickerSet.has(ticker)}
                                      onChange={() => togglePerplexityCompareTicker(ticker)}
                                    />
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <span className="inline-flex items-center gap-2">
                                      <span
                                        aria-hidden="true"
                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: color, boxShadow: `0 0 0 1px ${color}66` }}
                                      />
                                      <button
                                        type="button"
                                        className="font-semibold text-accent hover:text-sky-200"
                                        onClick={() => {
                                          setQuery(peer.ticker);
                                          void loadTicker(peer.ticker, { scrollToCharts: true });
                                        }}
                                      >
                                        {ticker}
                                      </button>
                                    </span>
                                  </td>
                                  <td className="px-2 py-1.5 text-slate-300">{peer.name ?? peer.exchange ?? "-"}</td>
                                  <td className="px-2 py-1.5">
                                    <span className={`rounded px-2 py-0.5 ${peer.status === "saved" ? "bg-emerald-400/10 text-emerald-200" : "bg-slate-800 text-slate-300"}`}>
                                      {peer.status === "saved" ? "Already in current group" : "Only in Perplexity"}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="rounded border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-xs text-slate-400">
                        {perplexityEmptyPeerMessage(perplexityLookup)}
                      </p>
                    )}
                  </div>

                  {activeGroup && savedOnlyPeerRows.length > 0 ? (
                    <div>
                      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Only in saved group</div>
                      <div className="flex flex-wrap gap-1.5">
                        {savedOnlyPeerRows.map((row) => (
                          <span key={`saved-only-${row.ticker}`} className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                            {row.ticker}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {detail && activeGroup && (
            <div className="card p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-200">{activeGroup.name}</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {correlationLaunchTickers.length} ticker{correlationLaunchTickers.length === 1 ? "" : "s"} ready for correlation launch.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{activeGroup.members.length} members</span>
                  <button
                    type="button"
                    className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={openCorrelationPicker}
                    disabled={!canLaunchCorrelation}
                  >
                    {correlationLaunchTickers.length > CORRELATION_LAUNCH_MAX_TICKERS ? "Choose Tickers For Correlation" : "Run Correlation"}
                  </button>
                </div>
              </div>
              {loadingMetrics ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading Alpaca metrics...
                </div>
              ) : (
                <div className="space-y-2">
                  {metricsError && <p className="text-xs text-yellow-200">{metricsError}</p>}
                  <div className="max-h-72 overflow-auto">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-900/60">
                        <tr>
                          {[
                            ["ticker", "Ticker"],
                            ["name", "Company"],
                            ["price", "Price"],
                            ["marketCap", "Mkt Cap"],
                            ["avgVolume", "Avg Vol"],
                          ].map(([key, label]) => (
                            <th key={key} className="px-2 py-1.5 text-left text-slate-300">
                              <button className="hover:text-slate-100" onClick={() => onMemberSort(key as PeerMemberSortKey)}>
                                {label}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedMemberRows.map(({ ticker, metric, name }) => {
                          return (
                            <tr key={`${activeGroup.id}-${ticker}`} className="border-t border-borderSoft/60">
                              <td className="px-2 py-1.5 font-semibold text-accent">{ticker}</td>
                              <td className="px-2 py-1.5 text-slate-300">{name ?? "-"}</td>
                              <td className="px-2 py-1.5 text-slate-300">{fmtPrice(metric?.price)}</td>
                              <td className="px-2 py-1.5 text-slate-300">{fmtCompact(metric?.marketCap)}</td>
                              <td className="px-2 py-1.5 text-slate-300">{fmtCompact(metric?.avgVolume)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {detail && (
        <div className="scroll-mt-4 space-y-3" ref={multiChartSectionRef}>
          <div className="card p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
                <div className="flex flex-wrap items-center gap-2">
                  <span>Sort multi-chart by</span>
                  <div className="inline-flex rounded border border-borderSoft bg-panelSoft p-0.5" role="group" aria-label="Sort multi-chart by">
                    {MULTI_CHART_SORT_OPTIONS.map((option) => (
                      <button
                        key={option.key}
                        aria-pressed={chartSortKey === option.key}
                        className={`rounded px-2.5 py-1 text-sm transition ${segmentedButtonClass(chartSortKey === option.key)}`}
                        onClick={() => setChartSortKey(option.key)}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2">
                  <span>Charts per page</span>
                  <input
                    type="number"
                    min={1}
                    max={48}
                    className="w-20 rounded border border-borderSoft bg-panelSoft px-2 py-1 text-sm"
                    value={chartsPerPage}
                    onChange={(event) => setChartsPerPage(Math.max(1, Math.min(48, Number(event.target.value) || 12)))}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800/60 hover:text-slate-100"
                  onClick={scrollBackToSearch}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                  Back to Search
                </button>
                <MultiChartPager page={chartPage} totalPages={totalChartPages} onPageChange={setChartPage} />
              </div>
            </div>
          </div>
          <TickerMultiGrid
            title={activeGroup ? `${activeGroup.name} Multi-Chart` : "Peer Group Multi-Chart"}
            items={chartItems}
            selectedKey={selectedTicker}
            onSelect={(ticker) => void loadTicker(ticker)}
            emptyMessage="No peer charts available for the current selection."
            showChartStatusLine
          />
          <div className="flex justify-end px-1">
            <MultiChartPager page={chartPage} totalPages={totalChartPages} onPageChange={setChartPage} />
          </div>
        </div>
      )}

      {activeFundamentalsTicker ? (
        <FundamentalsModal ticker={activeFundamentalsTicker} onClose={() => setActiveFundamentalsTicker(null)} />
      ) : null}

      {correlationPickerState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4" onClick={() => setCorrelationPickerState(null)}>
          <div
            className="w-full max-w-2xl rounded-2xl border border-borderSoft/80 bg-panel p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Peer Group Launch</div>
                <h3 className="mt-1 text-lg font-semibold text-slate-100">{correlationPickerState.groupName}</h3>
                <p className="mt-1 text-sm text-slate-400">
                  Select 2 to {CORRELATION_LAUNCH_MAX_TICKERS} tickers to run in correlation. Recommended selections follow the current peer-group sort order.
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300"
                onClick={() => setCorrelationPickerState(null)}
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-sm text-slate-300">
              <div>
                Selected <span className="font-semibold text-slate-100">{correlationSelection.length}</span> of {correlationPickerState.tickers.length}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
                  onClick={() => {
                    setCorrelationSelection(recommendedCorrelationTickers);
                    setCorrelationSelectionError(null);
                  }}
                >
                  Select Recommended 10
                </button>
                <button
                  type="button"
                  className="rounded border border-borderSoft px-2 py-1 text-xs text-slate-300 hover:bg-slate-800/60"
                  onClick={() => {
                    setCorrelationSelection([]);
                    setCorrelationSelectionError(null);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="mt-4 max-h-[26rem] overflow-auto rounded-xl border border-borderSoft/70">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/60">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Use</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Ticker</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Company</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Price</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">Mkt Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMemberRows.map(({ ticker, name, metric }) => {
                    const checked = correlationSelection.includes(ticker);
                    const disableUnchecked = !checked && correlationSelection.length >= CORRELATION_LAUNCH_MAX_TICKERS;
                    return (
                      <tr key={`correlation-launch-${ticker}`} className="border-t border-borderSoft/60">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-borderSoft bg-panelSoft"
                            checked={checked}
                            disabled={disableUnchecked}
                            onChange={() => toggleCorrelationSelection(ticker)}
                          />
                        </td>
                        <td className="px-3 py-2 font-semibold text-accent">{ticker}</td>
                        <td className="px-3 py-2 text-slate-300">{name ?? "-"}</td>
                        <td className="px-3 py-2 text-slate-300">{fmtPrice(metric?.price)}</td>
                        <td className="px-3 py-2 text-slate-300">{fmtCompact(metric?.marketCap)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {correlationSelectionError && <p className="mt-3 text-sm text-rose-300">{correlationSelectionError}</p>}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-borderSoft px-3 py-2 text-sm text-slate-300 hover:bg-slate-800/60"
                onClick={() => setCorrelationPickerState(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={submitCorrelationPicker}
                disabled={correlationSelection.length < 2 || correlationSelection.length > CORRELATION_LAUNCH_MAX_TICKERS}
              >
                Run Correlation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

