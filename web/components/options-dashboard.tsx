"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PlayCircle, RefreshCw, Search, ShieldAlert, SlidersHorizontal, WifiOff } from "lucide-react";
import {
  getPeerDirectory,
  getOptionsCandidates,
  getOptionsChain,
  getOptionsStatus,
  getOptionsWatchlist,
  refreshOptionsWatchlist,
  type OptionCandidateRow,
  type OptionsCandidatesResponse,
  type OptionsChainResponse,
  type OptionsStatusResponse,
  type OptionsStrategy,
  type OptionsWatchlistResponse,
  type PeerDirectoryRow,
} from "@/lib/api";

type StrategyFilter = OptionsStrategy | "all";

type Props = {
  initialSetId?: string | null;
  initialRunId?: string | null;
};

const STRATEGY_LABELS: Record<OptionsStrategy, string> = {
  long_call: "Long Calls",
  long_put: "Long Puts",
  call_debit_spread: "Call Debit Spreads",
  put_debit_spread: "Put Debit Spreads",
};

const STRATEGIES: Array<StrategyFilter> = ["all", "long_call", "long_put", "call_debit_spread", "put_debit_spread"];

function fmtNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "-";
}

function fmtMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "-";
}

function fmtPct(value: number | null | undefined, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "-";
}

function fmtTime(value: string | null | undefined) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

function scoreClass(score: number | null | undefined) {
  if (score == null) return "text-slate-500";
  if (score >= 80) return "text-pos";
  if (score >= 60) return "text-yellow-200";
  return "text-neg";
}

function statusPill(ok: boolean, label: string, detail?: string | null, tone: "warning" | "danger" = "warning") {
  const blockedClass = tone === "danger"
    ? "border-neg/35 bg-neg/10 text-neg"
    : "border-yellow-400/40 bg-yellow-500/10 text-yellow-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
        ok ? "border-pos/30 bg-pos/10 text-pos" : blockedClass
      }`}
      title={detail ?? undefined}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function hasDataFarmWarning(warnings: string[]) {
  return warnings.some((warning) => /IBKR API 21(03|05|19)|data farm|HMDS/i.test(warning));
}

function strategyLabel(strategy: StrategyFilter) {
  return strategy === "all" ? "All Candidates" : STRATEGY_LABELS[strategy];
}

function rowStrategyLabel(row: OptionCandidateRow) {
  if (row.rowKind === "chain") return row.right === "put" ? "Chain Put" : "Chain Call";
  return STRATEGY_LABELS[row.strategy];
}

function dte(expiry: string | null | undefined) {
  if (!expiry) return null;
  const parsed = Date.parse(`${expiry}T21:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.ceil((parsed - Date.now()) / (24 * 60 * 60_000));
}

function basisLabel(value: string | null | undefined) {
  if (value === "historical_bid_ask") return "RTH BID/ASK";
  if (value === "partial_historical_bid_ask") return "Partial RTH";
  if (value === "live_quote") return "Live quote";
  return "Unavailable";
}

function rowQuality(row: OptionCandidateRow): { label: string; className: string; title: string } {
  const warnings = row.warnings.join(" ").toLowerCase();
  const hasRthSpread = ["historical_bid_ask", "partial_historical_bid_ask"].includes(row.spreadBasis)
    && row.rthMedianSpreadPct != null
    && (row.rthSampleCount ?? 0) > 0;
  const hasLiveSpread = row.spreadBasis === "live_quote" && row.rthMedianSpreadPct != null;
  const hasLiquidity = (row.openInterest ?? 0) >= 100 && (row.volume ?? 0) >= 10;
  const hasFarmIssue = /api 21(05|19)|data farm|hmds|no security definition/.test(warnings);
  const hasTopOfBookIssue = /top-of-book unavailable|no top-of-book/.test(warnings);

  if (hasRthSpread && hasLiquidity) {
    return {
      label: "Tradable data",
      className: "border-pos/30 bg-pos/10 text-pos",
      title: "RTH BID/ASK samples and liquidity fields are present.",
    };
  }
  if (hasRthSpread || hasLiveSpread) {
    return {
      label: "Spread OK",
      className: "border-yellow-400/35 bg-yellow-500/10 text-yellow-200",
      title: "Spread data is present, but liquidity fields are incomplete or below the default thresholds.",
    };
  }
  if (hasFarmIssue) {
    return {
      label: "Data blocked",
      className: "border-neg/30 bg-neg/10 text-neg",
      title: "IBKR market-data or historical-data farm was unavailable for this contract.",
    };
  }
  if (hasTopOfBookIssue) {
    return {
      label: "No quote",
      className: "border-yellow-400/35 bg-yellow-500/10 text-yellow-200",
      title: "The contract is listed, but no usable top-of-book or RTH spread data was returned.",
    };
  }
  if (row.rowKind === "chain") {
    return {
      label: "Listed only",
      className: "border-borderSoft bg-panelSoft/70 text-slate-300",
      title: "The contract was discovered in the option chain, but has not passed spread/liquidity checks.",
    };
  }
  return {
    label: "Unverified",
    className: "border-yellow-400/35 bg-yellow-500/10 text-yellow-200",
    title: "Missing RTH BID/ASK spread samples.",
  };
}

function QualityPill({ row }: { row: OptionCandidateRow }) {
  const quality = rowQuality(row);
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${quality.className}`} title={quality.title}>
      {quality.label}
    </span>
  );
}

function candidateMatches(row: OptionCandidateRow, filters: {
  minDte: number;
  maxDte: number;
  minOpenInterest: number;
  minVolume: number;
  maxSpreadPct: number;
  search: string;
}) {
  const rowDte = dte(row.expiry);
  if (rowDte != null && (rowDte < filters.minDte || rowDte > filters.maxDte)) return false;
  if ((row.openInterest ?? 0) < filters.minOpenInterest) return false;
  if ((row.volume ?? 0) < filters.minVolume) return false;
  if (row.rthMedianSpreadPct != null && row.rthMedianSpreadPct > filters.maxSpreadPct) return false;
  const query = filters.search.trim().toUpperCase();
  if (!query) return true;
  return row.ticker.includes(query) || (row.localSymbol ?? "").toUpperCase().includes(query);
}

function rthSampleCount(row: OptionCandidateRow) {
  return row.rthSampleCount ?? 0;
}

function prioritizeRthRows(rows: OptionCandidateRow[]) {
  return [...rows].sort((left, right) => {
    const sampleCompare = rthSampleCount(right) - rthSampleCount(left);
    if (sampleCompare !== 0) return sampleCompare;
    const spreadCompare = (left.rthMedianSpreadPct ?? Number.POSITIVE_INFINITY) - (right.rthMedianSpreadPct ?? Number.POSITIVE_INFINITY);
    if (Number.isFinite(spreadCompare) && spreadCompare !== 0) return spreadCompare;
    return (right.score ?? -1) - (left.score ?? -1);
  });
}

function WarningList({ warnings }: { warnings: string[] }) {
  const unique = Array.from(new Set(warnings.filter(Boolean)));
  if (unique.length === 0) return null;
  return (
    <div className="rounded border border-yellow-400/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-100">
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <ShieldAlert className="h-3.5 w-3.5" />
        Data warnings
      </div>
      <div className="space-y-1">
        {unique.slice(0, 6).map((warning) => <div key={warning}>{warning}</div>)}
      </div>
    </div>
  );
}

function CandidateTable({ rows, onSelectTicker }: { rows: OptionCandidateRow[]; onSelectTicker: (ticker: string, row: OptionCandidateRow) => void }) {
  if (rows.length === 0) {
    return <div className="rounded border border-borderSoft/60 bg-panelSoft/30 px-4 py-8 text-center text-sm text-slate-400">No candidates match the current filters.</div>;
  }
  return (
    <div className="max-h-[34rem] overflow-auto rounded border border-borderSoft/70">
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 z-10 bg-slate-950/95 text-slate-300">
          <tr>
            {["Quality", "Score", "Ticker", "Strategy", "Expiry", "DTE", "Strike", "Delta", "OI", "Vol", "Spread", "Samples", "Debit", "Width", "Breakeven", "Basis", "Warnings"].map((label) => (
              <th key={label} className="whitespace-nowrap px-2 py-2 text-left font-semibold">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-borderSoft/50 hover:bg-slate-900/40">
              <td className="px-2 py-2"><QualityPill row={row} /></td>
              <td className={`px-2 py-2 font-semibold ${scoreClass(row.score)}`}>{fmtNumber(row.score, 0)}</td>
              <td className="px-2 py-2">
                <button type="button" onClick={() => onSelectTicker(row.ticker, row)} className="font-semibold text-accent hover:underline">
                  {row.ticker}
                </button>
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-slate-200">{rowStrategyLabel(row)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-slate-300">{row.expiry ?? "-"}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(dte(row.expiry), 0)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(row.strike)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(row.delta, 2)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(row.openInterest, 0)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(row.volume, 0)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtPct(row.rthMedianSpreadPct)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(row.rthSampleCount, 0)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtMoney(row.debit ?? row.ask ?? row.mid)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtNumber(row.width)}</td>
              <td className="px-2 py-2 text-slate-300">{fmtMoney(row.breakeven)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-slate-300">{basisLabel(row.spreadBasis)}</td>
              <td className="max-w-72 px-2 py-2 text-yellow-200">
                <span title={row.warnings.join(" ")}>
                  {row.warnings.length ? row.warnings.slice(0, 2).join(" ") : "-"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OptionsDashboard({ initialSetId = null, initialRunId = null }: Props) {
  const [status, setStatus] = useState<OptionsStatusResponse | null>(null);
  const [watchlist, setWatchlist] = useState<OptionsWatchlistResponse | null>(null);
  const [candidates, setCandidates] = useState<OptionsCandidatesResponse | null>(null);
  const [chain, setChain] = useState<OptionsChainResponse | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [selectedTickerScope, setSelectedTickerScope] = useState<"watchlist" | "adhoc">("watchlist");
  const [strategy, setStrategy] = useState<StrategyFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [singleRefreshing, setSingleRefreshing] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [minDte, setMinDte] = useState(14);
  const [maxDte, setMaxDte] = useState(90);
  const [minOpenInterest, setMinOpenInterest] = useState(100);
  const [minVolume, setMinVolume] = useState(10);
  const [maxSpreadPct, setMaxSpreadPct] = useState(12);
  const [search, setSearch] = useState("");
  const [tickerQuery, setTickerQuery] = useState("");
  const [singleTicker, setSingleTicker] = useState("");
  const [tickerResults, setTickerResults] = useState<PeerDirectoryRow[]>([]);
  const [tickerTotal, setTickerTotal] = useState(0);
  const [tickerSearching, setTickerSearching] = useState(false);
  const [tickerSearchError, setTickerSearchError] = useState<string | null>(null);
  const [relaxedSinglePull, setRelaxedSinglePull] = useState(true);
  const tickerSearchRequestRef = useRef(0);

  const context = useMemo(() => ({ setId: initialSetId, runId: initialRunId }), [initialRunId, initialSetId]);
  const selectedChainContext = useMemo(
    () => selectedTickerScope === "adhoc" ? { setId: null, runId: null } : context,
    [context, selectedTickerScope],
  );

  const loadAll = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [nextStatus, nextWatchlist, nextCandidates] = await Promise.all([
        getOptionsStatus(),
        getOptionsWatchlist(context),
        getOptionsCandidates({ ...context, strategy, limit: 250 }),
      ]);
      setStatus(nextStatus);
      setWatchlist(nextWatchlist);
      setCandidates(nextCandidates);
      const firstTicker = selectedTicker ?? nextWatchlist.rows.find((row) => row.snapshot)?.ticker ?? nextWatchlist.rows[0]?.ticker ?? null;
      setSelectedTicker(firstTicker);
      setSelectedTickerScope("watchlist");
      if (firstTicker) {
        const nextChain = await getOptionsChain(firstTicker, context);
        setChain(nextChain);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load options workspace.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSetId, initialRunId]);

  useEffect(() => {
    if (!selectedTicker) return;
    setChainLoading(true);
    getOptionsChain(selectedTicker, selectedChainContext)
      .then(setChain)
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load option chain."))
      .finally(() => setChainLoading(false));
  }, [selectedChainContext, selectedTicker]);

  useEffect(() => {
    getOptionsCandidates({ ...context, strategy, limit: 250 })
      .then(setCandidates)
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load options candidates."));
  }, [context, strategy]);

  useEffect(() => {
    const query = tickerQuery.trim();
    const requestId = ++tickerSearchRequestRef.current;
    if (!query) {
      setTickerResults([]);
      setTickerTotal(0);
      setTickerSearchError(null);
      setTickerSearching(false);
      return;
    }
    setTickerSearching(true);
    setTickerSearchError(null);
    const timer = window.setTimeout(() => {
      getPeerDirectory({ q: query, limit: 12, offset: 0 })
        .then((result) => {
          if (requestId !== tickerSearchRequestRef.current) return;
          setTickerResults(result.rows);
          setTickerTotal(result.total);
        })
        .catch((error) => {
          if (requestId !== tickerSearchRequestRef.current) return;
          setTickerSearchError(error instanceof Error ? error.message : "Failed to search tickers.");
          setTickerResults([]);
          setTickerTotal(0);
        })
        .finally(() => {
          if (requestId === tickerSearchRequestRef.current) setTickerSearching(false);
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [tickerQuery]);

  const refresh = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      const result = await refreshOptionsWatchlist({
        ...context,
        minDte,
        maxDte,
        minOpenInterest,
        minVolume,
        includeHistoricalSpreads: true,
      });
      setMessage(result.ok
        ? `Refreshed ${result.refreshedTickers}/${result.requestedTickers} tickers and ranked ${result.candidates.length} candidates.`
        : result.warnings.join(" ") || "Options refresh did not run.");
      setSelectedTickerScope("watchlist");
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to refresh options.");
    } finally {
      setRefreshing(false);
    }
  };

  const selectTickerResult = (row: PeerDirectoryRow) => {
    const ticker = row.ticker.toUpperCase();
    setSingleTicker(ticker);
    setTickerQuery(ticker);
    setSelectedTicker(ticker);
    setSelectedTickerScope("adhoc");
  };

  const selectRowTicker = (ticker: string, row: OptionCandidateRow) => {
    setSelectedTicker(ticker);
    setSelectedTickerScope(row.rowKind === "chain" || (!row.watchlistSetId && !row.watchlistRunId) ? "adhoc" : "watchlist");
  };

  const refreshSingleTicker = async () => {
    const ticker = (singleTicker || tickerQuery).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,15}$/.test(ticker)) {
      setMessage("Enter a valid ticker from the symbol directory.");
      return;
    }
    const effectiveMinDte = relaxedSinglePull ? 1 : minDte;
    const effectiveMinOpenInterest = relaxedSinglePull ? 0 : minOpenInterest;
    const effectiveMinVolume = relaxedSinglePull ? 0 : minVolume;
    if (relaxedSinglePull) {
      setMinDte(1);
      setMinOpenInterest(0);
      setMinVolume(0);
      setMaxSpreadPct(100);
    }
    setSingleRefreshing(true);
    setMessage(null);
    try {
      const result = await refreshOptionsWatchlist({
        tickers: [ticker],
        minDte: effectiveMinDte,
        maxDte,
        minOpenInterest: effectiveMinOpenInterest,
        minVolume: effectiveMinVolume,
        maxContractsPerTicker: 300,
        includeHistoricalSpreads: true,
        persistChainRows: true,
      });
      const [nextStatus, nextChain, nextCandidates] = await Promise.all([
        getOptionsStatus(),
        getOptionsChain(ticker),
        getOptionsCandidates({ ...context, strategy, limit: 250 }),
      ]);
      setStatus(nextStatus);
      setChain(nextChain);
      setCandidates(nextCandidates);
      setSelectedTicker(ticker);
      setSelectedTickerScope("adhoc");
      const contractCount = result.snapshots[0]?.contractCount ?? 0;
      setMessage(result.ok
        ? `${ticker}: refreshed ${contractCount} contracts, ranked ${result.candidates.length} candidates, loaded ${nextChain.rows.length} drilldown rows.`
        : result.warnings.join(" ") || `${ticker}: options refresh did not run.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Failed to refresh ${ticker}.`);
    } finally {
      setSingleRefreshing(false);
    }
  };

  const filteredCandidates = useMemo(() => {
    const rows = candidates?.rows ?? [];
    const scopedRows = selectedTickerScope === "adhoc" && selectedTicker
      ? rows.filter((row) => row.ticker === selectedTicker)
      : rows;
    return scopedRows.filter((row) => candidateMatches(row, { minDte, maxDte, minOpenInterest, minVolume, maxSpreadPct, search }));
  }, [candidates, maxDte, maxSpreadPct, minDte, minOpenInterest, minVolume, search, selectedTicker, selectedTickerScope]);

  const filteredChainRows = useMemo(() => {
    const rows = chain?.rows ?? [];
    return prioritizeRthRows(rows.filter((row) => candidateMatches(row, { minDte, maxDte, minOpenInterest, minVolume, maxSpreadPct, search })));
  }, [chain, maxDte, maxSpreadPct, minDte, minOpenInterest, minVolume, search]);
  const chainRthRows = useMemo(
    () => (chain?.rows ?? []).filter((row) => rthSampleCount(row) > 0 && row.rthMedianSpreadPct != null).length,
    [chain],
  );

  const statusWarnings = [
    ...(status?.warnings ?? []),
    ...(selectedTickerScope === "adhoc" ? [] : (watchlist?.warnings ?? [])),
    ...(candidates?.warnings ?? []),
    ...(chain?.warnings ?? []),
  ];
  const dataFarmsBlocked = hasDataFarmWarning(statusWarnings);
  const filterControls: Array<{
    label: string;
    value: number;
    setter: (value: number) => void;
    min: number;
    max: number;
  }> = [
    { label: "Min DTE", value: minDte, setter: setMinDte, min: 0, max: 365 },
    { label: "Max DTE", value: maxDte, setter: setMaxDte, min: 1, max: 730 },
    { label: "Min OI", value: minOpenInterest, setter: setMinOpenInterest, min: 0, max: 10000 },
    { label: "Min Vol", value: minVolume, setter: setMinVolume, min: 0, max: 5000 },
    { label: "Max Spread %", value: maxSpreadPct, setter: setMaxSpreadPct, min: 1, max: 100 },
  ];

  return (
    <div className="space-y-4">
      <div className="card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {status ? (
              <>
                {statusPill(status.bridge.enabled, "Enabled")}
                {statusPill(status.bridge.reachable, "Bridge")}
                {statusPill(status.bridge.authenticated === true, "IBKR auth")}
                {statusPill(
                  status.bridge.marketDataEntitled === true,
                  status.bridge.marketDataEntitled == null ? "Entitlements unknown" : "Entitlements",
                  status.bridge.marketDataEntitled == null ? "The bridge has not confirmed market-data entitlement state yet." : null,
                )}
                {dataFarmsBlocked ? statusPill(false, "Data farms blocked", "IBKR returned market-data or historical-data farm errors for the selected probe.", "danger") : null}
                <span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-2 py-0.5 text-[11px] text-slate-300">
                  {status.bridge.quoteMode ?? "quote mode unknown"}
                </span>
                <span className="rounded-full border border-borderSoft/70 bg-panelSoft/50 px-2 py-0.5 text-[11px] text-slate-300">
                  RTH {status.marketSession.latestCompletedSessionDate}
                </span>
              </>
            ) : loading ? (
              <span className="inline-flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading bridge status</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent disabled:opacity-50 hover:bg-accent/15"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {refreshing ? "Refreshing..." : "Refresh Options"}
          </button>
        </div>
        {status ? (
          <div className="mt-3 grid gap-2 text-xs text-slate-400 md:grid-cols-2 xl:grid-cols-4">
            <div>Latest snapshot: <span className="text-slate-200">{fmtTime(status.latestSnapshot?.createdAt)}</span></div>
            <div>Latest candidate: <span className="text-slate-200">{fmtTime(status.latestCandidate?.createdAt)}</span></div>
            <div>Session: <span className="text-slate-200">{status.marketSession.label}</span></div>
            <div>Bridge version: <span className="text-slate-200">{status.bridge.version ?? "-"}</span></div>
          </div>
        ) : null}
      </div>

      {message ? <div className="rounded border border-borderSoft/70 bg-panelSoft/60 px-3 py-2 text-sm text-slate-300">{message}</div> : null}
      <WarningList warnings={statusWarnings} />

      <div className="card p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Single Ticker Probe</h3>
            <p className="text-xs text-slate-500">Peer Groups directory</p>
          </div>
          {tickerQuery.trim() ? (
            <span className="rounded-full border border-borderSoft/70 px-2 py-0.5 text-[11px] text-slate-400">
              {tickerSearching ? "Searching..." : `${tickerTotal.toLocaleString()} matches`}
            </span>
          ) : null}
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),auto,auto]">
          <label className="space-y-1 text-xs text-slate-400">
            <span>Ticker or company</span>
            <div className="flex items-center rounded border border-borderSoft bg-panelSoft px-2">
              <Search className="h-4 w-4 text-slate-500" />
              <input
                value={tickerQuery}
                onChange={(event) => {
                  const next = event.target.value;
                  setTickerQuery(next);
                  setSingleTicker(next.trim().toUpperCase());
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void refreshSingleTicker();
                }}
                className="w-full bg-transparent px-2 py-2 text-sm text-slate-200 outline-none"
                placeholder="AAPL or Apple"
              />
            </div>
          </label>
          <label className="flex items-end gap-2 pb-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={relaxedSinglePull}
              onChange={(event) => setRelaxedSinglePull(event.target.checked)}
              className="h-4 w-4 rounded border-borderSoft bg-panelSoft"
            />
            Relax floors
          </label>
          <button
            type="button"
            onClick={() => void refreshSingleTicker()}
            disabled={singleRefreshing || !(singleTicker || tickerQuery).trim()}
            className="inline-flex items-center justify-center gap-2 self-end rounded border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent disabled:opacity-50 hover:bg-accent/15"
          >
            {singleRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            {singleRefreshing ? "Generating..." : "Generate Chain"}
          </button>
        </div>
        {tickerSearchError ? <p className="mt-2 text-xs text-red-300">{tickerSearchError}</p> : null}
        {tickerResults.length > 0 ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {tickerResults.map((row) => (
              <button
                key={row.ticker}
                type="button"
                onClick={() => selectTickerResult(row)}
                className={`rounded border px-3 py-2 text-left text-xs transition ${
                  singleTicker === row.ticker
                    ? "border-accent/50 bg-accent/10"
                    : "border-borderSoft/70 bg-panelSoft/40 hover:bg-slate-900/50"
                }`}
              >
                <div className="font-semibold text-accent">{row.ticker}</div>
                <div className="mt-0.5 truncate text-slate-300">{row.name ?? "-"}</div>
                <div className="mt-1 truncate text-[11px] text-slate-500">{[row.sector, row.industry].filter(Boolean).join(" / ") || row.exchange || "-"}</div>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(22rem,0.85fr),minmax(0,1.7fr)]">
        <section className="card p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Watchlist Coverage</h3>
              <p className="text-xs text-slate-500">{watchlist?.set?.name ?? "Selected watchlist"} {watchlist?.runId ? `run ${watchlist.runId.slice(0, 8)}` : ""}</p>
            </div>
            <span className="rounded-full border border-borderSoft/70 px-2 py-0.5 text-[11px] text-slate-400">{watchlist?.rows.length ?? 0} tickers</span>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading watchlist...</div>
          ) : (
            <div className="max-h-[34rem] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-900/60 text-slate-300">
                  <tr>{["Ticker", "Options", "Candidates", "Score", "IV Rank", "Snapshot", "Basis"].map((label) => <th key={label} className="px-2 py-1.5 text-left">{label}</th>)}</tr>
                </thead>
                <tbody>
                  {(watchlist?.rows ?? []).map((row) => (
                    <tr key={row.ticker} className={`border-t border-borderSoft/50 hover:bg-slate-900/40 ${selectedTicker === row.ticker ? "bg-accent/5" : ""}`}>
                      <td className="px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTicker(row.ticker);
                            setSelectedTickerScope("watchlist");
                          }}
                          className="font-semibold text-accent hover:underline"
                        >
                          {row.ticker}
                        </button>
                        <div className="max-w-36 truncate text-[10px] text-slate-500">{row.companyName ?? ""}</div>
                      </td>
                      <td className="px-2 py-1.5">{row.snapshot?.optionsAvailable ? <span className="text-pos">listed</span> : row.snapshot ? <span className="text-neg">none</span> : <span className="text-slate-500">unknown</span>}</td>
                      <td className="px-2 py-1.5 text-slate-300">{row.candidateCount}</td>
                      <td className={`px-2 py-1.5 font-semibold ${scoreClass(row.topScore)}`}>{fmtNumber(row.topScore, 0)}</td>
                      <td className="px-2 py-1.5 text-slate-300">{fmtPct(row.snapshot?.ivRank52w, 0)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{fmtTime(row.snapshot?.createdAt)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-slate-400">{row.snapshot?.latestRthSessionDate ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div className="card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-accent" />
                <h3 className="text-sm font-semibold text-slate-200">Filters</h3>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-slate-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-52 rounded border border-borderSoft bg-panelSoft py-2 pl-7 pr-3 text-xs text-slate-200 outline-none focus:border-accent/60"
                  placeholder="Ticker or contract"
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {filterControls.map(({ label, value, setter, min, max }) => (
                <label key={label} className="space-y-1 text-xs text-slate-400">
                  <span>{label}</span>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={value}
                    onChange={(event) => setter(Number(event.target.value))}
                    className="w-full rounded border border-borderSoft bg-panelSoft px-2 py-2 text-sm text-slate-200 outline-none focus:border-accent/60"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">Ranked Candidates</h3>
                <p className="text-xs text-slate-500">Spread quality uses latest regular-session BID/ASK probes when available.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {STRATEGIES.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setStrategy(item)}
                    className={`rounded px-3 py-1.5 text-xs ${strategy === item ? "bg-accent/20 text-accent" : "bg-slate-800 text-slate-300 hover:bg-slate-700/70"}`}
                  >
                    {strategyLabel(item)}
                  </button>
                ))}
              </div>
            </div>
            <CandidateTable rows={filteredCandidates} onSelectTicker={selectRowTicker} />
          </div>

          <div className="card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">{selectedTicker ?? "Ticker"} Chain Drilldown</h3>
                <p className="text-xs text-slate-500">
                  {chain?.snapshot ? `${chain.snapshot.contractCount} contracts inspected; ${chain.snapshot.candidateCount} candidates persisted; ${chainRthRows} with RTH spread samples.` : "Run a refresh to populate this ticker."}
                </p>
              </div>
              {chainLoading ? <span className="inline-flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading</span> : null}
            </div>
            {chain?.snapshot ? (
              <div className="mb-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2 xl:grid-cols-4">
                <div>Underlying: <span className="text-slate-200">{fmtMoney(chain.snapshot.underlyingPrice)}</span></div>
                <div>IV rank: <span className="text-slate-200">{fmtPct(chain.snapshot.ivRank52w, 0)}</span></div>
                <div>Data mode: <span className="text-slate-200">{chain.snapshot.dataMode ?? "-"}</span></div>
                <div>Quote time: <span className="text-slate-200">{fmtTime(chain.snapshot.underlyingQuoteTime)}</span></div>
              </div>
            ) : null}
            {!chain?.snapshot && !chainLoading ? (
              <div className="flex items-center gap-2 rounded border border-borderSoft/60 bg-panelSoft/30 px-4 py-8 text-sm text-slate-400">
                <WifiOff className="h-4 w-4" />
                No stored chain view for this ticker yet.
              </div>
            ) : (
              <CandidateTable rows={filteredChainRows} onSelectTicker={selectRowTicker} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
