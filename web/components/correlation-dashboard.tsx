"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { CorrelationPairDrilldown } from "./correlation-pair-drilldown";
import {
  getCorrelationMatrix,
  getCorrelationPair,
  type CorrelationLookback,
  type CorrelationMatrixResponse,
  type CorrelationPairResponse,
  type CorrelationRollingWindow,
} from "@/lib/api";

const LOOKBACK_OPTIONS: CorrelationLookback[] = ["60D", "120D", "252D", "2Y", "5Y"];
const ROLLING_WINDOW_OPTIONS: CorrelationRollingWindow[] = ["20D", "60D", "120D"];
const MAX_TICKERS = 10;

type PairSelection = { left: string; right: string };
type DrilldownTab = "overview" | "spread" | "dynamics";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function parseTickerInput(value: string): { tickers: string[]; invalid: string[] } {
  const tokens = value
    .split(/[,\s;\n\r\t]+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
  const unique = Array.from(new Set(tokens));
  const invalid = unique.filter((ticker) => !/^[A-Z.\-^]{1,20}$/.test(ticker));
  return {
    tickers: unique.filter((ticker) => /^[A-Z.\-^]{1,20}$/.test(ticker)).slice(0, MAX_TICKERS),
    invalid,
  };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return dateFmt.format(parsed);
}

function formatCorrelation(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function buildSearchQuery(tickers: string, lookback: CorrelationLookback, rollingWindow: CorrelationRollingWindow): string {
  const params = new URLSearchParams();
  params.set("tickers", tickers);
  params.set("lookback", lookback);
  params.set("rollingWindow", rollingWindow);
  return params.toString();
}

function pickAllowedOption<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  if (value && allowed.includes(value as T)) return value as T;
  return fallback;
}

function matrixCellStyle(value: number | null, diagonal = false): CSSProperties {
  if (diagonal) {
    return {
      backgroundColor: "rgba(56, 189, 248, 0.18)",
      color: "#e0f2fe",
    };
  }
  if (value == null || !Number.isFinite(value)) {
    return {
      backgroundColor: "rgba(51, 65, 85, 0.35)",
      color: "#cbd5e1",
    };
  }
  const intensity = 0.14 + Math.min(Math.abs(value), 1) * 0.46;
  if (value >= 0) {
    return {
      backgroundColor: `rgba(34, 197, 94, ${intensity})`,
      color: Math.abs(value) >= 0.6 ? "#052e16" : "#f8fafc",
    };
  }
  return {
    backgroundColor: `rgba(248, 113, 113, ${intensity})`,
    color: Math.abs(value) >= 0.6 ? "#450a0a" : "#f8fafc",
  };
}

function WarningList({ title, warnings }: { title: string; warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="rounded-xl border border-yellow-700/40 bg-yellow-900/15 p-3 text-sm text-yellow-100">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-yellow-200">{title}</div>
      <ul className="space-y-1">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function EmptyShell() {
  return (
    <div className="card p-6">
      <h3 className="text-lg font-semibold">Start A Correlation Run</h3>
      <p className="mt-2 max-w-3xl text-sm text-slate-400">
        Enter 2 to 10 tickers to build a correlation matrix first, then drill into one selected pair with normalized price comparison,
        regression, spread and z-score, rolling correlation, and lead-lag analysis.
      </p>
    </div>
  );
}

export function CorrelationDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isRouting, startTransition] = useTransition();
  const queryTickers = searchParams.get("tickers") ?? "";
  const queryLookback = pickAllowedOption(searchParams.get("lookback"), LOOKBACK_OPTIONS, "252D");
  const queryRollingWindow = pickAllowedOption(searchParams.get("rollingWindow"), ROLLING_WINDOW_OPTIONS, "60D");

  const [tickerInput, setTickerInput] = useState(queryTickers);
  const [lookback, setLookback] = useState<CorrelationLookback>(queryLookback);
  const [rollingWindow, setRollingWindow] = useState<CorrelationRollingWindow>(queryRollingWindow);
  const [formError, setFormError] = useState<string | null>(null);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [matrixData, setMatrixData] = useState<CorrelationMatrixResponse | null>(null);
  const [pairData, setPairData] = useState<CorrelationPairResponse | null>(null);
  const [selectedPair, setSelectedPair] = useState<PairSelection | null>(null);
  const [activeTab, setActiveTab] = useState<DrilldownTab>("overview");
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [pairLoading, setPairLoading] = useState(false);
  const autoRunKeyRef = useRef<string | null>(null);
  const matrixRequestRef = useRef(0);
  const pairRequestRef = useRef(0);

  useEffect(() => {
    setTickerInput(queryTickers);
    setLookback(queryLookback);
    setRollingWindow(queryRollingWindow);
  }, [queryLookback, queryRollingWindow, queryTickers]);

  const runPairAnalysis = async (nextPair: PairSelection, nextLookback: CorrelationLookback, nextRollingWindow: CorrelationRollingWindow) => {
    setSelectedPair(nextPair);
    setPairLoading(true);
    setPairError(null);
    const requestId = pairRequestRef.current + 1;
    pairRequestRef.current = requestId;
    try {
      const response = await getCorrelationPair({
        left: nextPair.left,
        right: nextPair.right,
        lookback: nextLookback,
        rollingWindow: nextRollingWindow,
      });
      if (pairRequestRef.current !== requestId) return;
      setPairData(response);
    } catch (error) {
      if (pairRequestRef.current !== requestId) return;
      setPairData(null);
      setPairError(error instanceof Error ? error.message : "Failed to load pair analysis.");
    } finally {
      if (pairRequestRef.current === requestId) setPairLoading(false);
    }
  };

  const runMatrixAnalysis = async (tickersCsv: string, nextLookback: CorrelationLookback, nextRollingWindow: CorrelationRollingWindow) => {
    setMatrixLoading(true);
    setPairLoading(false);
    setMatrixError(null);
    setPairError(null);
    setMatrixData(null);
    setPairData(null);
    setSelectedPair(null);
    const requestId = matrixRequestRef.current + 1;
    matrixRequestRef.current = requestId;
    pairRequestRef.current += 1;
    try {
      const response = await getCorrelationMatrix({
        tickers: tickersCsv,
        lookback: nextLookback,
      });
      if (matrixRequestRef.current !== requestId) return;
      setMatrixData(response);
      if (response.defaultPair) {
        void runPairAnalysis(response.defaultPair, nextLookback, nextRollingWindow);
      }
    } catch (error) {
      if (matrixRequestRef.current !== requestId) return;
      setMatrixError(error instanceof Error ? error.message : "Failed to build correlation matrix.");
    } finally {
      if (matrixRequestRef.current === requestId) setMatrixLoading(false);
    }
  };

  useEffect(() => {
    if (!queryTickers) {
      autoRunKeyRef.current = null;
      return;
    }
    const autoRunKey = `${queryTickers}|${queryLookback}|${queryRollingWindow}`;
    if (autoRunKeyRef.current === autoRunKey) return;
    autoRunKeyRef.current = autoRunKey;
    void runMatrixAnalysis(queryTickers, queryLookback, queryRollingWindow);
  }, [queryLookback, queryRollingWindow, queryTickers]);

  const handleAnalyze = () => {
    setFormError(null);
    const parsed = parseTickerInput(tickerInput);
    if (parsed.invalid.length > 0) {
      setFormError(`Unsupported ticker format: ${parsed.invalid[0]}`);
      return;
    }
    if (parsed.tickers.length < 2) {
      setFormError("Enter at least 2 valid tickers.");
      return;
    }
    const nextTickers = parsed.tickers.join(",");
    const nextQuery = buildSearchQuery(nextTickers, lookback, rollingWindow);
    const currentQuery = searchParams.toString();
    if (nextQuery === currentQuery) {
      autoRunKeyRef.current = null;
      void runMatrixAnalysis(nextTickers, lookback, rollingWindow);
      return;
    }
    startTransition(() => {
      router.replace(`/correlation?${nextQuery}`);
    });
  };

  const selectedPairKey = selectedPair ? `${selectedPair.left}:${selectedPair.right}` : null;
  const matrixSummary = useMemo(() => {
    if (!matrixData) return null;
    return {
      strongestPair: matrixData.defaultPair ? `${matrixData.defaultPair.left} / ${matrixData.defaultPair.right}` : "No valid pair",
      resolvedCount: matrixData.resolvedTickers.length,
      unresolvedCount: matrixData.unresolvedTickers.length,
    };
  }, [matrixData]);

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_180px_180px_auto]">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Tickers</label>
            <textarea
              className="min-h-24 w-full rounded-xl border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-accent/60"
              placeholder="AAPL, MSFT, NVDA, AMD"
              value={tickerInput}
              onChange={(event) => setTickerInput(event.target.value)}
            />
            <p className="mt-2 text-xs text-slate-400">Comma-separated input, auto de-duped, capped at 10 tickers.</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Lookback</label>
            <select
              className="w-full rounded-xl border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-sm text-slate-100 outline-none"
              value={lookback}
              onChange={(event) => setLookback(event.target.value as CorrelationLookback)}
            >
              {LOOKBACK_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Rolling Window</label>
            <select
              className="w-full rounded-xl border border-borderSoft/70 bg-panelSoft/30 px-3 py-2 text-sm text-slate-100 outline-none"
              value={rollingWindow}
              onChange={(event) => setRollingWindow(event.target.value as CorrelationRollingWindow)}
            >
              {ROLLING_WINDOW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              className="inline-flex w-full items-center justify-center rounded-xl bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleAnalyze}
              disabled={matrixLoading || isRouting}
            >
              {(matrixLoading || isRouting) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Analyze
            </button>
          </div>
        </div>
        {formError && <p className="mt-3 text-sm text-rose-300">{formError}</p>}
      </div>

      {!queryTickers && !matrixLoading && !matrixData && <EmptyShell />}

      {matrixError && <div className="card p-4 text-sm text-rose-300">{matrixError}</div>}

      {matrixData ? (
        <div className="space-y-4">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,2.2fr)_minmax(320px,1fr)]">
            <div className="card overflow-hidden">
              <div className="border-b border-borderSoft/70 px-4 py-3">
                <h3 className="text-lg font-semibold">Correlation Matrix</h3>
                <p className="mt-1 text-sm text-slate-400">
                  Pearson correlation on aligned daily returns using complete pairwise observations only.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/60">
                    <tr>
                      <th className="sticky left-0 z-10 bg-slate-900/60 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                        Ticker
                      </th>
                      {matrixData.resolvedTickers.map((ticker) => (
                        <th key={`head-${ticker.ticker}`} className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300">
                          {ticker.ticker}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrixData.resolvedTickers.map((rowTicker, rowIndex) => (
                      <tr key={`row-${rowTicker.ticker}`} className="border-t border-borderSoft/70">
                        <th className="sticky left-0 z-10 bg-panel px-3 py-3 text-left text-sm font-semibold text-slate-200">
                          <div>{rowTicker.ticker}</div>
                          <div className="text-xs font-normal text-slate-400">{rowTicker.displayName ?? rowTicker.ticker}</div>
                        </th>
                        {matrixData.resolvedTickers.map((columnTicker, columnIndex) => {
                          const value = matrixData.matrix[rowIndex]?.[columnIndex] ?? null;
                          const overlap = matrixData.overlapCounts[rowIndex]?.[columnIndex] ?? 0;
                          const diagonal = rowIndex === columnIndex;
                          const active = selectedPairKey != null && `${rowTicker.ticker}:${columnTicker.ticker}` === selectedPairKey;
                          const reverseActive = selectedPairKey != null && `${columnTicker.ticker}:${rowTicker.ticker}` === selectedPairKey;
                          return (
                            <td key={`${rowTicker.ticker}-${columnTicker.ticker}`} className="px-2 py-2">
                              <button
                                className={`flex min-h-20 w-28 flex-col justify-between rounded-lg border px-2 py-2 text-left transition-transform ${diagonal ? "cursor-default border-transparent" : "border-transparent hover:-translate-y-0.5 hover:border-accent/40"} ${active || reverseActive ? "!border-accent/70 ring-1 ring-accent/50" : ""}`}
                                style={matrixCellStyle(value, diagonal)}
                                disabled={diagonal || value == null || matrixLoading}
                                onClick={() => {
                                  const nextPair = { left: rowTicker.ticker, right: columnTicker.ticker };
                                  setActiveTab("overview");
                                  void runPairAnalysis(nextPair, matrixData.lookback, rollingWindow);
                                }}
                              >
                                <span className="text-base font-semibold">{formatCorrelation(value)}</span>
                                <span className="text-[11px] opacity-80">n={overlap}</span>
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-3">
              <div className="card p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Run Summary</div>
                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                  <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                    <div className="text-xs uppercase tracking-[0.08em] text-slate-400">Strongest Pair</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{matrixSummary?.strongestPair ?? "-"}</div>
                  </div>
                  <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                    <div className="text-xs uppercase tracking-[0.08em] text-slate-400">Resolved / Missing</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">
                      {matrixSummary?.resolvedCount ?? 0} / {matrixSummary?.unresolvedCount ?? 0}
                    </div>
                  </div>
                  <div className="rounded-xl border border-borderSoft/70 bg-panelSoft/30 p-3">
                    <div className="text-xs uppercase tracking-[0.08em] text-slate-400">Latest Available Date</div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">{formatDate(matrixData.latestAvailableDate)}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {matrixData.unresolvedTickers.length > 0 && (
            <div className="card p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Unresolved Tickers</div>
              <div className="flex flex-wrap gap-2">
                {matrixData.unresolvedTickers.map((ticker) => (
                  <span key={`${ticker.ticker}-${ticker.reason}`} className="rounded-full border border-borderSoft/70 bg-panelSoft/30 px-3 py-1 text-xs text-slate-300">
                    {ticker.ticker} - {ticker.reason === "unknown_ticker" ? "unknown ticker" : "missing history"}
                  </span>
                ))}
              </div>
            </div>
          )}

          <WarningList title="Data Warnings" warnings={matrixData.warnings} />

          <CorrelationPairDrilldown
            pairData={pairData}
            pairLoading={pairLoading}
            pairError={pairError}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selectedLabel={selectedPair ? `${selectedPair.left} vs ${selectedPair.right}` : null}
          />
        </div>
      ) : matrixLoading ? (
        <div className="card flex items-center gap-2 p-4 text-sm text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building correlation matrix...
        </div>
      ) : null}
    </div>
  );
}
