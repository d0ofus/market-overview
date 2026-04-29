"use client";

import { AlertTriangle, CalendarDays, Database, ListChecks, Play, RefreshCw, Search, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  buildAdminFundamentalsSeedQueue,
  getAdminEarningsStatus,
  getAdminFundamentalsSeedErrors,
  getAdminFundamentalsSeedStatus,
  getTickerFundamentals,
  processAdminEarningsRefresh,
  processAdminFundamentalsSeedQueue,
  refreshTickerFundamentals,
  syncAdminEarningsCalendar,
  type AdminEarningsStatus,
  type AdminFundamentalsSeedErrorsResponse,
  type AdminFundamentalsSeedProcessResponse,
  type AdminFundamentalsSeedQueueRow,
  type AdminFundamentalsSeedStatus,
  type FundamentalsResponse,
} from "@/lib/api";
import { FundamentalsChartPanel, formatFundamentalDate } from "@/components/fundamentals-chart-panel";
import { AdminCard } from "./admin-card";
import { AdminPageHeader } from "./admin-page-header";
import { AdminStatCard } from "./admin-stat-card";
import { EmptyState } from "./empty-state";
import { InlineAlert } from "./inline-alert";

type Message = {
  tone: "success" | "danger" | "info" | "warning";
  text: string;
};

const numberFormatter = new Intl.NumberFormat("en-US");
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCount(value: number | null | undefined): string {
  return numberFormatter.format(Number(value ?? 0));
}

function formatMarketCap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `$${compactFormatter.format(value)}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function countFor(counts: Record<string, number> | undefined, status: string): number {
  return Number(counts?.[status] ?? 0);
}

function normalizeTickerInput(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
}

function ActionButton({
  busy,
  disabled,
  icon: Icon,
  label,
  onClick,
  tone = "default",
}: {
  busy?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: "default" | "primary";
}) {
  return (
    <button
      className={
        tone === "primary"
          ? "inline-flex h-10 items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
          : "inline-flex h-10 items-center justify-center gap-2 rounded-2xl border border-borderSoft/80 bg-panelSoft/70 px-4 text-sm text-slate-200 transition hover:bg-panelSoft disabled:opacity-60"
      }
      disabled={disabled || busy}
      onClick={onClick}
      type="button"
    >
      <Icon className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      {busy ? "Working..." : label}
    </button>
  );
}

function StatusCountGrid({ counts }: { counts: Record<string, number> }) {
  const entries = [
    ["scheduled", "Scheduled"],
    ["reported_pending_sec", "Pending SEC"],
    ["sec_ready", "SEC Ready"],
    ["fundamentals_refreshed", "Refreshed"],
    ["refresh_error", "Errors"],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {entries.map(([key, label]) => (
        <div key={key} className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">{label}</div>
          <div className="mt-2 text-xl font-semibold text-text">{formatCount(countFor(counts, key))}</div>
        </div>
      ))}
    </div>
  );
}

export function FundamentalsAdminPanel() {
  const [earningsStatus, setEarningsStatus] = useState<AdminEarningsStatus | null>(null);
  const [seedStatus, setSeedStatus] = useState<AdminFundamentalsSeedStatus | null>(null);
  const [seedErrors, setSeedErrors] = useState<AdminFundamentalsSeedErrorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [lookupInput, setLookupInput] = useState("");
  const [lookupTicker, setLookupTicker] = useState<string | null>(null);
  const [lookupData, setLookupData] = useState<FundamentalsResponse | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupRefreshing, setLookupRefreshing] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [earnings, seed, errors] = await Promise.all([
        getAdminEarningsStatus(),
        getAdminFundamentalsSeedStatus(),
        getAdminFundamentalsSeedErrors(50),
      ]);
      setEarningsStatus(earnings);
      setSeedStatus(seed);
      setSeedErrors(errors);
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Failed to load fundamentals admin status." });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const seedCounts = seedStatus?.counts ?? {};
  const seedCompleted = countFor(seedCounts, "ok") + countFor(seedCounts, "no_supported_rows") + countFor(seedCounts, "skipped");
  const seedStats = useMemo(() => ({
    queued: countFor(seedCounts, "queued"),
    running: countFor(seedCounts, "running"),
    ok: countFor(seedCounts, "ok"),
    error: countFor(seedCounts, "error"),
    unsupported: countFor(seedCounts, "no_supported_rows"),
  }), [seedCounts]);
  const lookupQueueContext = useMemo<AdminFundamentalsSeedQueueRow | null>(() => {
    if (!lookupTicker) return null;
    const ticker = lookupTicker.toUpperCase();
    return (
      seedStatus?.queue.nextTickers.find((row) => row.ticker.toUpperCase() === ticker)
      ?? seedErrors?.rows.find((row) => row.ticker.toUpperCase() === ticker)
      ?? null
    );
  }, [lookupTicker, seedErrors?.rows, seedStatus?.queue.nextTickers]);

  const runAction = async (key: string, action: () => Promise<string>, tone: Message["tone"] = "success") => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await action();
      setMessage({ tone, text });
      await load();
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Action failed." });
    } finally {
      setBusy(null);
    }
  };

  const loadLookupTicker = async (tickerInput = lookupInput) => {
    const ticker = normalizeTickerInput(tickerInput);
    if (!ticker) {
      setLookupError("Enter a ticker symbol to inspect cached fundamentals.");
      return;
    }
    setLookupTicker(ticker);
    setLookupInput(ticker);
    setLookupLoading(true);
    setLookupError(null);
    try {
      const response = await getTickerFundamentals(ticker, 16);
      setLookupData(response);
    } catch (error) {
      setLookupData(null);
      setLookupError(error instanceof Error ? error.message : "Failed to load cached fundamentals.");
    } finally {
      setLookupLoading(false);
    }
  };

  const refreshLookupTicker = async () => {
    const ticker = normalizeTickerInput(lookupInput) || lookupTicker;
    if (!ticker) {
      setLookupError("Enter a ticker symbol to refresh SEC fundamentals.");
      return;
    }
    setLookupTicker(ticker);
    setLookupInput(ticker);
    setLookupRefreshing(true);
    setLookupError(null);
    try {
      await refreshTickerFundamentals(ticker);
      const response = await getTickerFundamentals(ticker, 16);
      setLookupData(response);
      setMessage({ tone: "success", text: `Refreshed SEC fundamentals for ${ticker}.` });
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : "Failed to refresh SEC fundamentals.");
    } finally {
      setLookupRefreshing(false);
    }
  };

  const processSeedBatches = async (target: number): Promise<string> => {
    let remaining = target;
    let attempted = 0;
    let ok = 0;
    let errors = 0;
    let unsupported = 0;
    const batches: AdminFundamentalsSeedProcessResponse[] = [];
    while (remaining > 0) {
      const limit = Math.min(10, remaining);
      const result = await processAdminFundamentalsSeedQueue(limit);
      batches.push(result);
      attempted += result.attempted;
      ok += result.rows.filter((row) => row.status === "ok").length;
      errors += result.rows.filter((row) => row.status === "error").length;
      unsupported += result.rows.filter((row) => row.status === "no_supported_rows").length;
      if (result.attempted < limit) break;
      remaining -= limit;
    }
    const last = batches.at(-1);
    if (!last || attempted === 0) return "No due seed tickers were available to process.";
    return `Processed ${attempted} seed ticker${attempted === 1 ? "" : "s"}: ${ok} ok, ${unsupported} unsupported, ${errors} error${errors === 1 ? "" : "s"}.`;
  };

  return (
    <section className="space-y-6">
      <AdminPageHeader
        eyebrow="Fundamentals"
        title="SEC Fundamentals Control"
        description="Track earnings-driven refreshes, seed cached SEC fundamentals, and monitor queue health from one admin surface."
        actions={
          <ActionButton
            busy={busy === "reload"}
            disabled={Boolean(busy)}
            icon={RefreshCw}
            label="Reload"
            onClick={() => void runAction("reload", async () => {
              await load();
              return "Fundamentals admin status reloaded.";
            }, "info")}
          />
        }
      />

      {message ? <InlineAlert tone={message.tone}>{message.text}</InlineAlert> : null}
      {earningsStatus?.warning ? <InlineAlert tone="warning">{earningsStatus.warning}</InlineAlert> : null}
      {seedStatus?.warning ? <InlineAlert tone="warning">{seedStatus.warning}</InlineAlert> : null}

      {loading ? (
        <div className="grid gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="admin-surface h-28 animate-pulse rounded-3xl bg-panelSoft/60" />
          ))}
        </div>
      ) : null}

      {!loading && earningsStatus && seedStatus ? (
        <>
          <div className="grid gap-4 xl:grid-cols-4">
            <AdminStatCard label="Seed Queue" value={formatCount(seedStatus.queue.total)} helper={`${seedStatus.queue.progressPct}% complete`} tone={seedStats.error > 0 ? "warning" : "default"} />
            <AdminStatCard label="Seeded Tickers" value={formatCount(seedStatus.cached.tickerWithQuarterCount)} helper={`${formatCount(seedStatus.cached.quarterRowCount)} cached quarter rows`} tone="success" />
            <AdminStatCard label="Earnings Due" value={formatCount(earningsStatus.dueCount)} helper="Events ready for SEC checks." tone={earningsStatus.dueCount > 0 ? "info" : "default"} />
            <AdminStatCard label="Storage Estimate" value={seedStatus.storageEstimate.label} helper={seedStatus.storageEstimate.note} />
          </div>

          <AdminCard
            title="Ticker Lookup"
            description="Inspect cached SEC fundamentals from the linked D1 fundamentals database."
          >
            <div className="space-y-5">
              <form
                className="grid gap-3 lg:grid-cols-[minmax(12rem,18rem),auto,auto,minmax(0,1fr)]"
                onSubmit={(event) => {
                  event.preventDefault();
                  void loadLookupTicker();
                }}
              >
                <label className="text-xs text-slate-300">
                  Ticker
                  <input
                    className="mt-2 h-10 w-full rounded-2xl border border-borderSoft/80 bg-panel px-3 font-mono text-sm uppercase text-text"
                    placeholder="AAPL"
                    value={lookupInput}
                    onChange={(event) => setLookupInput(event.target.value.toUpperCase())}
                  />
                </label>
                <div className="flex items-end">
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-sm font-medium text-slate-950 transition hover:brightness-110 disabled:opacity-60"
                    disabled={lookupLoading || lookupRefreshing}
                    type="submit"
                  >
                    <Search className="h-4 w-4" />
                    {lookupLoading ? "Loading..." : "Load"}
                  </button>
                </div>
                <div className="flex items-end">
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-2xl border border-accent/40 bg-accent/15 px-4 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:opacity-60"
                    disabled={lookupLoading || lookupRefreshing || (!lookupTicker && !lookupInput.trim())}
                    onClick={() => void refreshLookupTicker()}
                    type="button"
                  >
                    <RefreshCw className={lookupRefreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {lookupRefreshing ? "Refreshing..." : "Refresh SEC"}
                  </button>
                </div>
                <div className="flex items-end text-xs text-slate-500">
                  {lookupTicker ? `Showing D1 cache for ${lookupTicker}` : "Lookup reads fundamental_issuers and fundamental_quarters."}
                </div>
              </form>

              {lookupQueueContext ? (
                <div className="grid gap-3 rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4 text-sm text-slate-300 md:grid-cols-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Seed Status</p>
                    <p className="mt-1 text-text">{lookupQueueContext.status}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Rank</p>
                    <p className="mt-1 text-text">#{lookupQueueContext.priorityRank}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Attempts</p>
                    <p className="mt-1 text-text">{formatCount(lookupQueueContext.attempts)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Last Error</p>
                    <p className="mt-1 truncate text-rose-200" title={lookupQueueContext.lastError ?? undefined}>{lookupQueueContext.lastError ?? "-"}</p>
                  </div>
                </div>
              ) : null}

              {lookupData?.issuer ? (
                <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/35 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{lookupData.issuer.ticker}</p>
                      <h3 className="mt-1 text-base font-semibold text-text">{lookupData.issuer.companyName}</h3>
                    </div>
                    <div className="text-right text-xs text-slate-400">
                      <div>Status: <span className="text-slate-200">{lookupData.issuer.status ?? "-"}</span></div>
                      <div>Last refreshed: <span className="text-slate-200">{formatFundamentalDate(lookupData.issuer.lastRefreshedAt?.slice(0, 10))}</span></div>
                    </div>
                  </div>
                  {lookupData.issuer.lastError ? <p className="mt-3 text-xs text-rose-200">{lookupData.issuer.lastError}</p> : null}
                </div>
              ) : null}

              {lookupTicker || lookupLoading || lookupError ? (
                <FundamentalsChartPanel
                  data={lookupData}
                  loading={lookupLoading}
                  refreshing={lookupRefreshing}
                  error={lookupError}
                  onRefresh={refreshLookupTicker}
                  showVerificationTable
                />
              ) : (
                <EmptyState
                  title="No ticker loaded"
                  description="Enter a ticker to inspect the fundamentals cache populated by the SEC seed queue."
                />
              )}
            </div>
          </AdminCard>

          <AdminCard
            title="Earnings Calendar"
            description="Provider sync status and event-driven SEC refresh controls."
            actions={
              <>
                <ActionButton
                  busy={busy === "earnings-sync"}
                  disabled={Boolean(busy)}
                  icon={CalendarDays}
                  label="Sync Earnings Calendar"
                  onClick={() => void runAction("earnings-sync", async () => {
                    const result = await syncAdminEarningsCalendar();
                    return `Synced earnings calendar: ${result.rowsUpserted} event${result.rowsUpserted === 1 ? "" : "s"} upserted.`;
                  })}
                  tone="primary"
                />
                <ActionButton
                  busy={busy === "earnings-process"}
                  disabled={Boolean(busy)}
                  icon={Play}
                  label="Process Due Events"
                  onClick={() => void runAction("earnings-process", async () => {
                    const result = await processAdminEarningsRefresh(5);
                    const refreshed = result.rows.filter((row) => row.status === "fundamentals_refreshed").length;
                    return `Processed ${result.attempted} due event${result.attempted === 1 ? "" : "s"}; ${refreshed} refreshed.`;
                  })}
                />
              </>
            }
          >
            <div className="space-y-5">
              <StatusCountGrid counts={earningsStatus.counts} />
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
                <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Provider Syncs</p>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-left text-sm">
                      <thead className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        <tr>
                          <th className="py-2 pr-3">Provider</th>
                          <th className="py-2 pr-3">Status</th>
                          <th className="py-2 pr-3">Rows</th>
                          <th className="py-2 pr-3">Last Success</th>
                          <th className="py-2">Error</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-borderSoft/60 text-slate-300">
                        {earningsStatus.syncs.map((sync) => (
                          <tr key={sync.provider}>
                            <td className="py-2 pr-3 font-mono text-xs text-text">{sync.provider}</td>
                            <td className="py-2 pr-3">{sync.status}</td>
                            <td className="py-2 pr-3">{formatCount(sync.rowsUpserted)} / {formatCount(sync.rowsSeen)}</td>
                            <td className="py-2 pr-3">{formatDateTime(sync.lastSuccessAt)}</td>
                            <td className="py-2 text-xs text-rose-200">{sync.lastError ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Upcoming Events</p>
                  <div className="mt-3 grid gap-2">
                    {earningsStatus.upcoming.slice(0, 8).map((event) => (
                      <div key={`${event.ticker}-${event.scheduledDate}-${event.fiscalPeriod}`} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-borderSoft/60 bg-panel/45 px-3 py-2 text-sm">
                        <div>
                          <span className="font-mono text-text">{event.ticker}</span>
                          <span className="ml-2 text-slate-400">{event.scheduledDate}</span>
                        </div>
                        <span className="text-xs text-slate-500">{event.status}</span>
                      </div>
                    ))}
                    {earningsStatus.upcoming.length === 0 ? <p className="text-sm text-slate-400">No upcoming earnings events are cached.</p> : null}
                  </div>
                </div>
              </div>
            </div>
          </AdminCard>

          <AdminCard
            title="Initial Fundamentals Seed"
            description="Build and advance the market-cap-prioritized SEC fundamentals queue."
            actions={
              <>
                <ActionButton
                  busy={busy === "seed-build-500"}
                  disabled={Boolean(busy)}
                  icon={Database}
                  label="Build Top 500 Queue"
                  onClick={() => void runAction("seed-build-500", async () => {
                    const result = await buildAdminFundamentalsSeedQueue(500);
                    return `Built top ${result.requestedLimit} seed queue: ${result.queuedRows} eligible tickers queued.`;
                  })}
                  tone="primary"
                />
                <ActionButton
                  busy={busy === "seed-build-1500"}
                  disabled={Boolean(busy)}
                  icon={Database}
                  label="Build Top 1500 Queue"
                  onClick={() => void runAction("seed-build-1500", async () => {
                    const result = await buildAdminFundamentalsSeedQueue(1500);
                    return `Built top ${result.requestedLimit} seed queue: ${result.queuedRows} eligible tickers queued.`;
                  })}
                />
                <ActionButton
                  busy={busy === "seed-process-10"}
                  disabled={Boolean(busy)}
                  icon={Play}
                  label="Process 10"
                  onClick={() => void runAction("seed-process-10", () => processSeedBatches(10))}
                />
                <ActionButton
                  busy={busy === "seed-process-50"}
                  disabled={Boolean(busy)}
                  icon={ListChecks}
                  label="Process 50"
                  onClick={() => void runAction("seed-process-50", () => processSeedBatches(50))}
                />
              </>
            }
          >
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <AdminStatCard label="Queued" value={formatCount(seedStats.queued)} />
                <AdminStatCard label="Running" value={formatCount(seedStats.running)} tone={seedStats.running > 0 ? "info" : "default"} />
                <AdminStatCard label="OK" value={formatCount(seedStats.ok)} tone="success" />
                <AdminStatCard label="Unsupported" value={formatCount(seedStats.unsupported)} tone={seedStats.unsupported > 0 ? "warning" : "default"} />
                <AdminStatCard label="Errors" value={formatCount(seedStats.error)} tone={seedStats.error > 0 ? "danger" : "default"} />
              </div>
              <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Progress</p>
                    <p className="mt-2 text-sm text-slate-300">{formatCount(seedCompleted)} of {formatCount(seedStatus.queue.total)} terminal seed rows.</p>
                  </div>
                  <span className="rounded-full border border-borderSoft/70 bg-panel px-3 py-1 text-xs text-slate-300">{seedStatus.queue.progressPct}%</span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-panel">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, seedStatus.queue.progressPct))}%` }} />
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
                <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Next Queue Slice</p>
                  <div className="mt-3 grid gap-2">
                    {seedStatus.queue.nextTickers.slice(0, 10).map((row) => (
                      <div key={row.ticker} className="grid grid-cols-[4.5rem,minmax(0,1fr),5rem] items-center gap-2 rounded-2xl border border-borderSoft/60 bg-panel/45 px-3 py-2 text-sm">
                        <span className="font-mono text-text">{row.ticker}</span>
                        <span className="truncate text-slate-400">{row.companyName ?? row.exchange ?? "-"}</span>
                        <span className="text-right text-xs text-slate-500">#{row.priorityRank}</span>
                      </div>
                    ))}
                    {seedStatus.queue.nextTickers.length === 0 ? <p className="text-sm text-slate-400">No due seed tickers are waiting.</p> : null}
                  </div>
                </div>
                <div className="rounded-2xl border border-borderSoft/70 bg-panelSoft/45 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Recent Runs</p>
                  <div className="mt-3 grid gap-2">
                    {seedStatus.recentRuns.slice(0, 6).map((run) => (
                      <div key={run.id} className="rounded-2xl border border-borderSoft/60 bg-panel/45 px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-text">{run.runType}</span>
                          <span className="text-xs text-slate-500">{formatDateTime(run.completedAt ?? run.startedAt)}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">
                          queued {formatCount(run.queuedRows)}, processed {formatCount(run.processedRows)}, ok {formatCount(run.okRows)}, errors {formatCount(run.errorRows)}
                        </p>
                        {run.error ? <p className="mt-1 text-xs text-rose-200">{run.error}</p> : null}
                      </div>
                    ))}
                    {seedStatus.recentRuns.length === 0 ? <p className="text-sm text-slate-400">No seed runs have been recorded.</p> : null}
                  </div>
                </div>
              </div>
            </div>
          </AdminCard>

          <AdminCard
            title="Seed Exceptions"
            description="Recent failed, unsupported, or skipped fundamentals seed rows."
            actions={<span className="inline-flex items-center gap-2 rounded-full border border-borderSoft/70 bg-panelSoft/50 px-3 py-1 text-xs text-slate-300"><AlertTriangle className="h-3.5 w-3.5" /> {formatCount(seedErrors?.rows.length)} rows</span>}
          >
            {seedErrors?.rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.18em] text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Ticker</th>
                      <th className="py-2 pr-3">Rank</th>
                      <th className="py-2 pr-3">Market Cap</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Attempts</th>
                      <th className="py-2">Last Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-borderSoft/60 text-slate-300">
                    {seedErrors.rows.map((row) => (
                      <tr key={`${row.ticker}-${row.updatedAt ?? ""}`}>
                        <td className="py-2 pr-3 font-mono text-text">{row.ticker}</td>
                        <td className="py-2 pr-3">#{row.priorityRank}</td>
                        <td className="py-2 pr-3">{formatMarketCap(row.marketCap)}</td>
                        <td className="py-2 pr-3">{row.status}</td>
                        <td className="py-2 pr-3">{formatCount(row.attempts)}</td>
                        <td className="py-2 text-xs text-rose-200">{row.lastError ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No seed exceptions" description="The fundamentals seed queue has no recent errors or unsupported rows." />
            )}
          </AdminCard>
        </>
      ) : null}
    </section>
  );
}
