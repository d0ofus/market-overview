"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Search, ShieldAlert, SlidersHorizontal, WifiOff } from "lucide-react";
import {
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

function statusPill(ok: boolean, label: string, detail?: string | null) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
        ok ? "border-pos/30 bg-pos/10 text-pos" : "border-yellow-400/40 bg-yellow-500/10 text-yellow-200"
      }`}
      title={detail ?? undefined}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function strategyLabel(strategy: StrategyFilter) {
  return strategy === "all" ? "All Candidates" : STRATEGY_LABELS[strategy];
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

function CandidateTable({ rows, onSelectTicker }: { rows: OptionCandidateRow[]; onSelectTicker: (ticker: string) => void }) {
  if (rows.length === 0) {
    return <div className="rounded border border-borderSoft/60 bg-panelSoft/30 px-4 py-8 text-center text-sm text-slate-400">No candidates match the current filters.</div>;
  }
  return (
    <div className="max-h-[34rem] overflow-auto rounded border border-borderSoft/70">
      <table className="min-w-full text-xs">
        <thead className="sticky top-0 z-10 bg-slate-950/95 text-slate-300">
          <tr>
            {["Score", "Ticker", "Strategy", "Expiry", "DTE", "Strike", "Delta", "OI", "Vol", "Spread", "Samples", "Debit", "Width", "Breakeven", "Basis", "Warnings"].map((label) => (
              <th key={label} className="whitespace-nowrap px-2 py-2 text-left font-semibold">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-borderSoft/50 hover:bg-slate-900/40">
              <td className={`px-2 py-2 font-semibold ${scoreClass(row.score)}`}>{fmtNumber(row.score, 0)}</td>
              <td className="px-2 py-2">
                <button type="button" onClick={() => onSelectTicker(row.ticker)} className="font-semibold text-accent hover:underline">
                  {row.ticker}
                </button>
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-slate-200">{STRATEGY_LABELS[row.strategy]}</td>
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
  const [strategy, setStrategy] = useState<StrategyFilter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [minDte, setMinDte] = useState(14);
  const [maxDte, setMaxDte] = useState(90);
  const [minOpenInterest, setMinOpenInterest] = useState(100);
  const [minVolume, setMinVolume] = useState(10);
  const [maxSpreadPct, setMaxSpreadPct] = useState(12);
  const [search, setSearch] = useState("");

  const context = useMemo(() => ({ setId: initialSetId, runId: initialRunId }), [initialRunId, initialSetId]);

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
    getOptionsChain(selectedTicker, context)
      .then(setChain)
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load option chain."))
      .finally(() => setChainLoading(false));
  }, [context, selectedTicker]);

  useEffect(() => {
    getOptionsCandidates({ ...context, strategy, limit: 250 })
      .then(setCandidates)
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load options candidates."));
  }, [context, strategy]);

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
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to refresh options.");
    } finally {
      setRefreshing(false);
    }
  };

  const filteredCandidates = useMemo(() => {
    const rows = candidates?.rows ?? [];
    return rows.filter((row) => candidateMatches(row, { minDte, maxDte, minOpenInterest, minVolume, maxSpreadPct, search }));
  }, [candidates, maxDte, maxSpreadPct, minDte, minOpenInterest, minVolume, search]);

  const filteredChainRows = useMemo(() => {
    const rows = chain?.rows ?? [];
    return rows.filter((row) => candidateMatches(row, { minDte, maxDte, minOpenInterest, minVolume, maxSpreadPct, search }));
  }, [chain, maxDte, maxSpreadPct, minDte, minOpenInterest, minVolume, search]);

  const statusWarnings = [
    ...(status?.warnings ?? []),
    ...(watchlist?.warnings ?? []),
    ...(candidates?.warnings ?? []),
    ...(chain?.warnings ?? []),
  ];
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
                {statusPill(status.bridge.marketDataEntitled !== false, "Entitlements")}
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
                        <button type="button" onClick={() => setSelectedTicker(row.ticker)} className="font-semibold text-accent hover:underline">{row.ticker}</button>
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
            <CandidateTable rows={filteredCandidates} onSelectTicker={setSelectedTicker} />
          </div>

          <div className="card p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">{selectedTicker ?? "Ticker"} Chain Drilldown</h3>
                <p className="text-xs text-slate-500">
                  {chain?.snapshot ? `${chain.snapshot.contractCount} contracts inspected; ${chain.snapshot.candidateCount} candidates persisted.` : "Run a refresh to populate this ticker."}
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
              <CandidateTable rows={filteredChainRows} onSelectTicker={setSelectedTicker} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
